#!/usr/bin/env node
/**
 * devin-openclaw-bridge — adapts Cognition's Devin CLI to the JSON record
 * contract an OpenClaw CLI backend expects.
 *
 * Why this exists: `devin -p` prints plain text and stores sessions locally
 * per working directory, so it can't emit the `{session_id, result}` JSON
 * OpenClaw parses. This bridge:
 *
 *   1. Receives the full Devin argv from OpenClaw, minus two bridge-private
 *      flags: `--oc-prompt <text>` (the user turn) and `--oc-system <text>`
 *      (OpenClaw's system prompt, prepended to the first turn's prompt body).
 *   2. Snapshots `devin list --format json` before/after the run to discover
 *      the session Devin created (or confirms the `-r <id>` it resumed).
 *   3. Emits ONE JSON object on stdout:
 *        ok    -> {"type":"result","session_id":"...","result":"..."}
 *        error -> {"type":"result","status":"error","session_id":"...","result":"...","errors":["..."]}
 *
 * The child devin process inherits this process's stdin so a future
 * `input: "stdin"` prompt transport keeps working.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEVIN_COMMAND = process.env.DEVIN_OPENCLAW_COMMAND || "devin";
const LIST_TIMEOUT_MS = 15_000;

/** Strip ANSI control sequences so terminal styling never enters the JSON payload. */
function stripAnsi(text) {
  return text
    .replace(/\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\][^]*(?:|\\)/g, "")
    .replace(/[()][0-9A-B]/g, "")
    .replace(/\r/g, "");
}

function takeFlag(argv, flag) {
  const values = [];
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === flag && i + 1 < argv.length) {
      values.push(argv[i + 1]);
      i += 1;
    } else {
      rest.push(argv[i]);
    }
  }
  return { value: values.at(-1), rest };
}

function sessionIdOf(entry) {
  if (!entry || typeof entry !== "object") return undefined;
  const id = entry.id ?? entry.session_id ?? entry.sessionId;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function sessionTimestampOf(entry) {
  if (!entry || typeof entry !== "object") return 0;
  const raw =
    entry.updated_at ?? entry.updatedAt ?? entry.last_activity ?? entry.created_at ??
    entry.createdAt ?? entry.timestamp ?? entry.mtime;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    const ms = Date.parse(raw);
    return Number.isNaN(ms) ? 0 : ms;
  }
  return 0;
}

async function listSessionIds() {
  try {
    const { stdout } = await execFileAsync(DEVIN_COMMAND, ["list", "--format", "json"], {
      timeout: LIST_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, CI: "1", NO_COLOR: "1", TERM: "dumb" },
    });
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function emit(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

async function main() {
  const argv = process.argv.slice(2);
  const prompt = takeFlag(argv, "--oc-prompt");
  const sys = takeFlag(prompt.rest, "--oc-system");
  const devinArgs = [...sys.rest];

  const resumeMatch = devinArgs.findIndex((a) => a === "-r" || a === "--resume");
  const resumeId =
    resumeMatch >= 0 && typeof devinArgs[resumeMatch + 1] === "string"
      ? devinArgs[resumeMatch + 1]
      : undefined;

  const promptText = [sys.value, prompt.value].filter((s) => typeof s === "string" && s.length > 0).join("\n\n");

  const before = new Set((await listSessionIds()).map(sessionIdOf).filter(Boolean));

  const child = spawn(
    DEVIN_COMMAND,
    [...devinArgs, ...(promptText ? ["--", promptText] : [])],
    {
      stdio: ["inherit", "pipe", "pipe"],
      env: { ...process.env, CI: "1", NO_COLOR: "1", TERM: "dumb" },
    },
  );

  const killChild = (signal) => {
    try {
      if (child.exitCode === null && !child.killed) child.kill(signal);
    } catch {
      /* already gone */
    }
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => killChild(signal));
  }

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
  child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));

  const outcome = await new Promise((resolve) => {
    child.on("error", (err) => resolve({ error: err }));
    child.on("close", (code, signal) => resolve({ code, signal }));
  });

  const after = await listSessionIds();
  const fresh = after
    .filter((e) => {
      const id = sessionIdOf(e);
      return id && !before.has(id);
    })
    .sort((a, b) => sessionTimestampOf(b) - sessionTimestampOf(a));
  const sessionId = sessionIdOf(fresh[0]) ?? resumeId;

  if (outcome.error) {
    const notFound = outcome.error.code === "ENOENT";
    emit({
      type: "result",
      status: "error",
      ...(sessionId ? { session_id: sessionId } : {}),
      result: notFound
        ? `devin CLI binary '${DEVIN_COMMAND}' not found on PATH. Install with: curl -fsSL https://cli.devin.ai/install.sh | bash && devin auth login`
        : `devin bridge spawn failed: ${outcome.error.message}`,
      errors: [notFound ? "devin CLI not installed" : String(outcome.error.message)],
    });
    return;
  }

  const text = stripAnsi(stdout).trim();
  const errText = stripAnsi(stderr).trim();

  if (outcome.code === 0 && !outcome.signal) {
    emit({
      type: "result",
      ...(sessionId ? { session_id: sessionId } : {}),
      result: text,
    });
    return;
  }

  const reason = outcome.signal
    ? `devin exited on signal ${outcome.signal}`
    : `devin exited with code ${outcome.code}`;
  const detail = (errText || text).slice(-4000);
  emit({
    type: "result",
    status: "error",
    ...(sessionId ? { session_id: sessionId } : {}),
    result: detail ? `${reason}\n\n${detail}` : reason,
    errors: [reason, ...(detail ? [detail] : [])],
  });
}

main().catch((err) => {
  emit({
    type: "result",
    status: "error",
    result: `devin-openclaw-bridge internal failure: ${err?.message ?? err}`,
    errors: [String(err?.message ?? err)],
  });
});
