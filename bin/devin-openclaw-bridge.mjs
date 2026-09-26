#!/usr/bin/env node
/**
 * devin-openclaw-bridge — drives Devin CLI over ACP (`devin acp`, JSON-RPC on
 * stdio) and streams the turn to OpenClaw as Claude stream-json JSONL.
 *
 * `devin -p` only prints the final assistant text, so a turn that ends after a
 * tool call (or a headless permission rejection) looks like an empty success.
 * ACP gives us the structure instead: native session ids, streamed message
 * chunks, tool-call lifecycle, permission requests, stop reasons and usage.
 *
 * argv (from OpenClaw): --oc-prompt <text> [--oc-system <text>] [-r <sessionId>]
 *                       [--model <id>] [--permission-mode <mode>] [-p]
 * stdout: JSONL
 *   {"type":"init","session_id":"..."}
 *   {"type":"message","role":"assistant","content":"<delta>","delta":true}
 *   {"type":"tool_use","tool_id":"...","tool_name":"exec","parameters":{...}}
 *   {"type":"tool_result","tool_id":"...","status":"success","output":"..."}
 *   {"type":"result","status":"success","session_id":"...","usage":{...}}
 *   error -> {"type":"result","status":"error","session_id":"...","result":"...","errors":[...]}
 */
import { spawn } from "node:child_process";

const DEVIN_COMMAND = process.env.DEVIN_OPENCLAW_COMMAND || "devin";
const STDERR_TAIL = 4000;

/** Devin CLI `--permission-mode` values -> ACP session mode ids. */
// Capabilities `devin -p` advertises to its own `devin acp` child, minus UI-only ones
// (partial tool-input streaming, browser preview, clipboard, chains).
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

// Devin tailors its system prompt to the ACP client identity; present as its own CLI client.
const DEVIN_CLIENT_VERSION = "0.5.0";

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
    else if (a === "--oc-model") opts.modelOverride = next();
    else if (a === "--permission-mode") opts.mode = next();
  }
  if (opts.modelOverride) opts.model = opts.modelOverride;
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


function toolName(u, prev) {
  return prev.name ?? u._meta?.["cognition.ai/inferenceToolName"] ?? u.kind ?? "tool";
}

const TERMINAL_TOOL_STATUS = new Set(["completed", "failed"]);

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const acpMode = opts.mode ? ACP_MODES[opts.mode] ?? opts.mode : undefined;
  const allowPermissions = acpMode !== "ask";
  const promptText = [opts.system, opts.prompt].filter(Boolean).join("\n\n");

  const child = spawn(DEVIN_COMMAND, ["acp", ...(opts.model ? ["--model", opts.model] : [])], {
    stdio: ["pipe", "pipe", "pipe"],
    // `devin -p` enables shell-first file-op guidance; ACP only honours it via env.
    env: { ...process.env, DEVIN_PREFER_EXEC_TOOL: "true", NO_COLOR: "1", TERM: "dumb" },
  });

  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (d) => {
    stderr = (stderr + d).slice(-STDERR_TAIL * 4);
  });

  let sessionId = opts.resume;
  let collecting = false;
  let reply = "";
  const tools = new Map();
  let usageMeta;

  // Turns are re-emitted as Claude stream-json: each ACP text run and the tool
  // calls that follow it form one assistant message, and tool results arrive
  // as user messages. OpenClaw then treats pre-tool text as commentary and
  // keeps text and tool calls interleaved in the transcript.
  let messageSeq = 0;
  let messageOpen = false;
  let blockIndex = -1;
  let textBlockOpen = false;
  let segment = "";
  const streamEvent = (event) => emit({ type: "stream_event", event, ...(sessionId ? { session_id: sessionId } : {}) });
  const openMessage = () => {
    if (messageOpen) return;
    messageOpen = true;
    blockIndex = -1;
    streamEvent({ type: "message_start", message: { id: `devin_msg_${++messageSeq}`, role: "assistant", content: [] } });
  };
  const closeTextBlock = () => {
    if (!textBlockOpen) return;
    textBlockOpen = false;
    streamEvent({ type: "content_block_stop", index: blockIndex });
  };
  const closeMessage = () => {
    if (!messageOpen) return;
    closeTextBlock();
    messageOpen = false;
    streamEvent({ type: "message_stop" });
  };
  const emitText = (delta) => {
    if (!delta) return;
    openMessage();
    if (!textBlockOpen) {
      textBlockOpen = true;
      streamEvent({ type: "content_block_start", index: ++blockIndex, content_block: { type: "text", text: "" } });
    }
    reply += delta;
    segment += delta;
    streamEvent({ type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text: delta } });
  };

  const trackTool = (u) => {
    const prev = tools.get(u.toolCallId) ?? {};
    const output = u.sessionUpdate === "tool_call_update" ? textOf(u.content) : "";
    const next = {
      ...prev,
      name: toolName(u, prev),
      ...(u.title ? { title: u.title } : {}),
      ...(u.kind ? { kind: u.kind } : {}),
      ...(u.rawInput ? { input: u.rawInput } : {}),
      ...(u.status ? { status: u.status } : {}),
      ...(output ? { output } : {}),
    };
    tools.set(u.toolCallId, next);
    const ready =
      Boolean(u.status) || (u.sessionUpdate === "tool_call" && next.input && typeof next.input === "object");
    if (!prev.started && ready) {
      next.started = true;
      openMessage();
      closeTextBlock();
      segment = "";
      const index = ++blockIndex;
      const input = { ...(next.title ? { title: next.title } : {}), ...(next.input ?? {}) };
      streamEvent({
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: u.toolCallId, name: next.name, input },
      });
      streamEvent({ type: "content_block_stop", index });
    }
    if (next.started && !prev.finished && TERMINAL_TOOL_STATUS.has(next.status)) {
      next.finished = true;
      emitToolResult(u.toolCallId, next);
    }
  };
  const emitToolResult = (id, t) => {
    closeMessage();
    const failed = t.denied || t.status !== "completed";
    const message = t.denied ? "permission denied" : t.output ?? "";
    emit({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: id,
            content: message || (failed ? `tool ${t.status ?? "incomplete"}` : ""),
            is_error: Boolean(failed),
          },
        ],
      },
      ...(sessionId ? { session_id: sessionId } : {}),
    });
  };

  const client = createAcpClient(child, {
    onNotification(method, params) {
      if (method !== "session/update" || !collecting) return;
      const u = params?.update;
      if (!u) return;
      switch (u.sessionUpdate) {
        case "agent_message_chunk": {
          const parent = u._meta?.["cognition.ai/subagent_context"]?.parentAgentId;
          if (parent && parent !== "root") break;
          const chunk = textOf(u.content);
          if (!chunk) break;
          emitText(chunk);
          break;
        }
        case "tool_call":
        case "tool_call_update":
          trackTool(u);
          break;
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
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        auth: { terminal: false },
        _meta: DEVIN_CLIENT_META,
      },
      clientInfo: { name: "devin-cli", version: DEVIN_CLIENT_VERSION },
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
      const created = await client.request("session/new", {
        cwd,
        mcpServers: [],
        _meta: { "cognition.ai/promptForEdits": true },
      });
      sessionId = created?.sessionId;
    }
    if (sessionId) emit({ type: "system", subtype: "session", session_id: sessionId, model: opts.model });
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
    for (const [id, t] of tools) {
      if (t.started && !t.finished) {
        t.finished = true;
        emitToolResult(id, t);
      }
    }

    if (stopReason === "cancelled" || cancelled) {
      emitError("Devin turn was cancelled.", sessionId);
    } else if (stopReason === "refusal") {
      emitError(reply.trim() || "Devin refused this request.", sessionId);
    } else {
      if (!reply.trim()) {
        const toolSummary = summarizeTools(tools);
        emitText(
          toolSummary
            ? `Devin ended the turn (${stopReason}) without a text reply. Tool activity:\n${toolSummary}`
            : `Devin ended the turn (${stopReason}) without a text reply.`,
        );
      } else if (stopReason === "max_tokens" || stopReason === "max_turn_requests") {
        emitText(`\n\n[Devin stopped early: ${stopReason}]`);
      }
      closeMessage();
      emit({
        type: "result",
        subtype: "success",
        is_error: false,
        result: segment.trim(),
        ...(sessionId ? { session_id: sessionId } : {}),
        usage,
      });
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
    if (sessionId) {
      await Promise.race([
        client
          .request("_cognition.ai/session/end", { sessionId, reason: "other", reloading: false })
          .catch(() => undefined),
        new Promise((r) => setTimeout(r, 2000).unref()),
      ]);
    }
    finish();
  }
}

main().catch((err) => {
  emitError(`devin-openclaw-bridge internal failure: ${err?.message ?? err}`);
});
