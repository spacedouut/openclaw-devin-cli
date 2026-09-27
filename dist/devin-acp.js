/**
 * Minimal Agent Client Protocol client for `devin acp` (JSON-RPC over stdio).
 *
 * Mirrors what `devin -p` negotiates with its own ACP child so Devin builds the
 * same CLI system prompt: `devin-cli` client identity, the cognition.ai client
 * capabilities, and shell-first guidance via DEVIN_PREFER_EXEC_TOOL.
 */
import { spawn } from "node:child_process";
export const DEVIN_CLIENT_VERSION = "0.6.0";
const STDERR_TAIL = 16_000;
const DEVIN_CLIENT_META = {
    "cognition.ai/messageGrouping": true,
    "cognition.ai/groupedSessionConfigOptions": true,
    "cognition.ai/clientProvidedModels": true,
    "cognition.ai/stopOnReject": true,
    "cognition.ai/subagentControl": true,
    "cognition.ai/subagentSupport": true,
    "cognition.ai/windsurfConfigBridge": true,
    "cognition.ai/workspaceDirCommands": true,
    "cognition.ai/permissionPrompts": true,
};
/** Devin CLI `--permission-mode` values -> ACP session mode ids. */
export const ACP_MODES = {
    dangerous: "bypass",
    smart: "smart",
    "accept-edits": "accept-edits",
    auto: "ask",
};
export class AcpRequestError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.code = code;
    }
}
export function acpText(content) {
    if (!content)
        return "";
    if (Array.isArray(content))
        return content.map(acpText).join("");
    if (content.type === "text")
        return content.text ?? "";
    if (content.type === "content")
        return acpText(content.content);
    return "";
}
export function pickPermissionOption(options, allow) {
    const prefer = allow ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
    for (const kind of prefer) {
        const hit = options?.find((option) => option.kind === kind);
        if (hit)
            return hit;
    }
    return undefined;
}
export class DevinAcpProcess {
    command;
    handlers;
    child;
    pending = new Map();
    nextId = 0;
    buffer = "";
    stderr = "";
    closed = false;
    exited;
    constructor(command, params, handlers) {
        this.command = command;
        this.handlers = handlers;
        const args = [
            ...(params.configPath ? ["--config", params.configPath] : []),
            "acp",
            ...(params.model ? ["--model", params.model] : []),
        ];
        this.child = spawn(command, args, {
            cwd: params.cwd,
            stdio: ["pipe", "pipe", "pipe"],
            env: {
                ...(params.env ?? process.env),
                DEVIN_PREFER_EXEC_TOOL: "true",
                NO_COLOR: "1",
                TERM: "dumb",
            },
        });
        this.child.stderr.setEncoding("utf8").on("data", (chunk) => {
            this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL);
        });
        this.child.stdout.setEncoding("utf8").on("data", (chunk) => this.onData(chunk));
        this.exited = new Promise((resolve) => {
            this.child.on("error", (error) => resolve({ code: null, signal: null, error }));
            this.child.on("close", (code, signal) => resolve({ code, signal }));
        });
        void this.exited.then((outcome) => {
            this.closed = true;
            const error = outcome.error ??
                new Error(`devin acp exited (${outcome.signal ?? `code ${String(outcome.code)}`})`);
            for (const { reject } of this.pending.values())
                reject(error);
            this.pending.clear();
        });
    }
    stderrErrors() {
        return this.stderr
            .split("\n")
            .filter((line) => /\b(ERROR|WARN|error|Error)\b/.test(line))
            .join("\n")
            .slice(-4000);
    }
    send(message) {
        if (this.closed)
            return;
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    }
    onData(chunk) {
        this.buffer += chunk;
        let newline;
        while ((newline = this.buffer.indexOf("\n")) >= 0) {
            const line = this.buffer.slice(0, newline).trim();
            this.buffer = this.buffer.slice(newline + 1);
            if (!line)
                continue;
            let message;
            try {
                message = JSON.parse(line);
            }
            catch {
                continue;
            }
            this.dispatch(message);
        }
    }
    dispatch(message) {
        if (message.method && message.id != null) {
            const id = message.id;
            this.onRequest(message.method, message.params).then((result) => this.send({ id, result }), (error) => this.send({
                id,
                error: {
                    code: error instanceof AcpRequestError ? (error.code ?? -32603) : -32603,
                    message: error instanceof Error ? error.message : String(error),
                },
            }));
            return;
        }
        if (message.method) {
            if (message.method === "session/update") {
                const params = message.params;
                if (params?.update && params.sessionId) {
                    this.handlers.onUpdate(params.sessionId, params.update);
                }
            }
            return;
        }
        if (typeof message.id === "number") {
            const waiter = this.pending.get(message.id);
            if (!waiter)
                return;
            this.pending.delete(message.id);
            if (message.error) {
                waiter.reject(new AcpRequestError(message.error.message ?? "ACP error", message.error.code));
            }
            else {
                waiter.resolve(message.result);
            }
        }
    }
    async onRequest(method, params) {
        if (method === "session/request_permission") {
            return await this.handlers.onPermission(params);
        }
        throw new AcpRequestError(`Method not supported by OpenClaw Devin harness: ${method}`, -32601);
    }
    request(method, params) {
        if (this.closed) {
            return Promise.reject(new Error("devin acp is not running"));
        }
        return new Promise((resolve, reject) => {
            const id = ++this.nextId;
            this.pending.set(id, { resolve: (value) => resolve(value), reject });
            this.send({ id, method, params });
        });
    }
    notify(method, params) {
        this.send({ method, params });
    }
    async initialize() {
        await this.request("initialize", {
            protocolVersion: 1,
            clientCapabilities: {
                fs: { readTextFile: false, writeTextFile: false },
                terminal: false,
                auth: { terminal: false },
                _meta: DEVIN_CLIENT_META,
            },
            clientInfo: { name: "devin-cli", version: DEVIN_CLIENT_VERSION },
        });
    }
    async newSession(cwd, mcpServers = []) {
        const created = await this.request("session/new", {
            cwd,
            mcpServers,
            _meta: { "cognition.ai/promptForEdits": true },
        });
        if (!created?.sessionId) {
            throw new Error("devin acp did not return a session id");
        }
        return created.sessionId;
    }
    async loadSession(sessionId, cwd, mcpServers = []) {
        await this.request("session/load", { sessionId, cwd, mcpServers });
    }
    async setModel(sessionId, model) {
        await this.request("session/set_config_option", { sessionId, configId: "model", value: model });
    }
    async setMode(sessionId, modeId) {
        await this.request("session/set_mode", { sessionId, modeId });
    }
    async prompt(sessionId, text, images = []) {
        return await this.request("session/prompt", {
            sessionId,
            prompt: [
                { type: "text", text },
                ...images.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType })),
            ],
        });
    }
    cancel(sessionId) {
        this.notify("session/cancel", { sessionId });
    }
    async close(sessionId) {
        if (sessionId && !this.closed) {
            await Promise.race([
                this.request("_cognition.ai/session/end", { sessionId, reason: "other", reloading: false }).catch(() => undefined),
                new Promise((resolve) => setTimeout(resolve, 2000).unref()),
            ]);
        }
        try {
            this.child.stdin.end();
        }
        catch {
            // already closed
        }
        const timer = setTimeout(() => this.child.kill("SIGTERM"), 3000);
        timer.unref();
        await Promise.race([this.exited, new Promise((resolve) => setTimeout(resolve, 3500).unref())]);
        clearTimeout(timer);
        if (!this.closed)
            this.child.kill("SIGKILL");
    }
}
