#!/usr/bin/env node
/**
 * devin-openclaw-bridge — drives Devin CLI over ACP (`devin acp`, JSON-RPC on
 * stdio) and emits the single JSON record an OpenClaw CLI backend expects.
 *
 * `devin -p` only prints the final assistant text, so a turn that ends after a
 * tool call (or a headless permission rejection) looks like an empty success.
 * ACP gives us the structure instead: native session ids, streamed message
 * chunks, tool-call lifecycle, permission requests, stop reasons and usage.
 *
 * argv (from OpenClaw): --oc-prompt <text> [--oc-system <text>] [-r <sessionId>]
 *                       [--model <id>] [--permission-mode <mode>] [-p]
 * stdout: ONE JSON object
 *   ok    -> {"type":"result","session_id":"...","result":"...","usage":{...}}
 *   error -> {"type":"result","status":"error","session_id":"...","result":"...","errors":[...]}
 */
import { spawn } from "node:child_process";

const DEVIN_COMMAND = process.env.DEVIN_OPENCLAW_COMMAND || "devin";
const STDERR_TAIL = 4000;

/** Devin CLI `--permission-mode` values -> ACP session mode ids. */
const ACP_MODES = { dangerous: "bypass", smart: "smart", "accept-edits": "accept-edits", auto: "ask" };

function parseArgs(argv) {
  const opts = { resume: undefined, model: undefined, mode: undefined, prompt: "", system: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--oc-prompt") opts.prompt = next() ?? "";
    else if (a === "--oc-system") opts.system = next() ?? "";
    else if (a === "-r" || a === "--resume") opts.resume = next();
    else if (a === "--model" || a === "-m") opts.model = next();
    else if (a === "--permission-mode") opts.mode = next();
  }
  return opts;
}

function emit(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function emitError(message, sessionId, extra = []) {
  emit({
    type: "result",
    status: "error",
    ...(sessionId ? { session_id: sessionId } : {}),
    result: message,
    errors: [message, ...extra],
  });
}

function createAcpClient(child, { onNotification, onRequest }) {
  let nextId = 0;
  let buffer = "";
  const pending = new Map();
  const send = (msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);

  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.method && msg.id != null) {
        Promise.resolve(onRequest(msg.method, msg.params))
          .then((result) => send({ id: msg.id, result }))
          .catch((err) =>
            send({ id: msg.id, error: { code: err?.code ?? -32603, message: String(err?.message ?? err) } }),
          );
      } else if (msg.method) {
        onNotification(msg.method, msg.params);
      } else if (msg.id != null && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(Object.assign(new Error(msg.error.message ?? "ACP error"), { acp: msg.error }));
        else resolve(msg.result);
      }
    }
  });

  const failAll = (err) => {
    for (const { reject } of pending.values()) reject(err);
    pending.clear();
  };

  return {
    request(method, params) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        send({ id, method, params });
      });
    },
    notify(method, params) {
      send({ method, params });
    },
    failAll,
  };
}

function pickPermissionOption(options, allow) {
  const prefer = allow ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of prefer) {
    const hit = options?.find((o) => o.kind === kind);
    if (hit) return hit;
  }
  return undefined;
}

function textOf(content) {
  if (!content) return "";
  if (Array.isArray(content)) return content.map(textOf).join("");
  if (content.type === "text") return content.text ?? "";
  if (content.type === "content") return textOf(content.content);
  return "";
}

function summarizeTools(tools) {
  return [...tools.values()]
    .map((t) => {
      const status = t.denied ? "permission denied" : t.status ?? "pending";
      const output = t.output ? `\n    ${t.output.trim().split("\n").slice(-5).join("\n    ")}` : "";
      return `- ${t.title || t.kind || "tool call"} (${status})${output}`;
    })
    .join("\n");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const acpMode = opts.mode ? ACP_MODES[opts.mode] ?? opts.mode : undefined;
  const allowPermissions = acpMode !== "ask";
  const promptText = [opts.system, opts.prompt].filter(Boolean).join("\n\n");

  const child = spawn(DEVIN_COMMAND, ["acp", ...(opts.model ? ["--model", opts.model] : [])], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
  });

  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (d) => {
    stderr = (stderr + d).slice(-STDERR_TAIL * 4);
  });

  let sessionId = opts.resume;
  let collecting = false;
  let reply = "";
  let breakBeforeNextChunk = false;
  const tools = new Map();
  let usageMeta;

  const client = createAcpClient(child, {
    onNotification(method, params) {
      if (method !== "session/update" || !collecting) return;
      const u = params?.update;
      if (!u) return;
      switch (u.sessionUpdate) {
        case "agent_message_chunk": {
          const chunk = textOf(u.content);
          if (chunk && breakBeforeNextChunk && reply && !reply.endsWith("\n")) reply += "\n\n";
          breakBeforeNextChunk = false;
          reply += chunk;
          break;
        }
        case "tool_call":
        case "tool_call_update": {
          breakBeforeNextChunk = true;
          const prev = tools.get(u.toolCallId) ?? {};
          const output = textOf(u.content);
          tools.set(u.toolCallId, {
            ...prev,
            ...(u.title ? { title: u.title } : {}),
            ...(u.kind ? { kind: u.kind } : {}),
            ...(u.status ? { status: u.status } : {}),
            ...(output && u.sessionUpdate === "tool_call_update" ? { output } : {}),
          });
          break;
        }
        case "usage_update":
          usageMeta = u._meta ?? usageMeta;
          break;
        default:
          break;
      }
    },
    async onRequest(method, params) {
      if (method === "session/request_permission") {
        const option = pickPermissionOption(params?.options, allowPermissions);
        const id = params?.toolCall?.toolCallId;
        if (id && !allowPermissions) tools.set(id, { ...(tools.get(id) ?? {}), denied: true });
        return option
          ? { outcome: { outcome: "selected", optionId: option.optionId } }
          : { outcome: { outcome: "cancelled" } };
      }
      throw Object.assign(new Error(`Method not supported by OpenClaw bridge: ${method}`), { code: -32601 });
    },
  });

  const exited = new Promise((resolve) => {
    child.on("error", (error) => resolve({ error }));
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  exited.then((outcome) =>
    client.failAll(
      outcome.error ??
        new Error(`devin acp exited early (${outcome.signal ?? `code ${outcome.code}`})`),
    ),
  );

  let cancelled = false;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      cancelled = true;
      if (sessionId) client.notify("session/cancel", { sessionId });
      setTimeout(() => child.kill("SIGTERM"), 2000).unref();
    });
  }

  const finish = () => {
    try {
      child.stdin.end();
    } catch {
      /* already closed */
    }
    setTimeout(() => child.kill("SIGTERM"), 3000).unref();
  };

  try {
    await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "openclaw-devin-cli", version: "0.3.0" },
    });

    const cwd = process.cwd();
    if (opts.resume) {
      await client.request("session/load", { sessionId: opts.resume, cwd, mcpServers: [] });
      if (opts.model) {
        await client
          .request("session/set_config_option", { sessionId, configId: "model", value: opts.model })
          .catch(() => undefined);
      }
    } else {
      const created = await client.request("session/new", { cwd, mcpServers: [] });
      sessionId = created?.sessionId;
    }
    if (acpMode) {
      await client.request("session/set_mode", { sessionId, modeId: acpMode }).catch(() => undefined);
    }

    collecting = true;
    const result = await client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: promptText }],
    });
    collecting = false;

    const u = result?.usage ?? {};
    const usage = {
      input_tokens: u.inputTokens ?? usageMeta?.["cognition.ai/inputTokens"],
      output_tokens: u.outputTokens ?? usageMeta?.["cognition.ai/outputTokens"],
      cache_read_input_tokens: u.cachedReadTokens ?? usageMeta?.["cognition.ai/cachedReadTokens"],
    };
    const stopReason = result?.stopReason ?? "end_turn";
    let text = reply.trim();

    if (stopReason === "cancelled" || cancelled) {
      emitError("Devin turn was cancelled.", sessionId);
    } else if (stopReason === "refusal") {
      emitError(text || "Devin refused this request.", sessionId);
    } else {
      if (!text) {
        const toolSummary = summarizeTools(tools);
        text = toolSummary
          ? `Devin ended the turn (${stopReason}) without a text reply. Tool activity:\n${toolSummary}`
          : `Devin ended the turn (${stopReason}) without a text reply.`;
      } else if (stopReason === "max_tokens" || stopReason === "max_turn_requests") {
        text += `\n\n[Devin stopped early: ${stopReason}]`;
      }
      emit({ type: "result", ...(sessionId ? { session_id: sessionId } : {}), result: text, usage });
    }
  } catch (err) {
    const outcome = await Promise.race([exited, new Promise((r) => setTimeout(() => r(undefined), 200))]);
    if (outcome?.error?.code === "ENOENT") {
      emitError(
        `devin CLI binary '${DEVIN_COMMAND}' not found on PATH. Install with: curl -fsSL https://cli.devin.ai/install.sh | bash && devin auth login`,
        sessionId,
      );
    } else {
      const tail = stderr
        .split("\n")
        .filter((l) => /\b(ERROR|WARN|error|Error)\b/.test(l))
        .join("\n")
        .slice(-STDERR_TAIL);
      emitError(`devin acp failed: ${err?.acp?.message ?? err?.message ?? err}`, sessionId, tail ? [tail] : []);
    }
  } finally {
    finish();
  }
}

main().catch((err) => {
  emitError(`devin-openclaw-bridge internal failure: ${err?.message ?? err}`);
});
