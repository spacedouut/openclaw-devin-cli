import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { compactDevinSession } from "../dist/compaction.js";
import { DevinSessionBindings } from "../dist/session-bindings.js";

function fakeDevin(behavior) {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-devin-compact-"));
  const file = path.join(dir, "devin");
  const log = path.join(dir, "log.json");
  writeFileSync(
    file,
    `#!/usr/bin/env node
const fs = require("node:fs");
const behavior = ${JSON.stringify(behavior)};
const log = ${JSON.stringify(log)};
const record = (entry) => {
  const all = fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, "utf8")) : [];
  all.push(entry);
  fs.writeFileSync(log, JSON.stringify(all));
};
record({ pid: process.pid });
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const update = (u) => send({ method: "session/update", params: { sessionId: "d1", update: u } });
let nextId = 1000;
const replies = new Map();
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.method) record({ method: m.method, params: m.params });
    if (m.id != null && !m.method && replies.has(m.id)) { replies.get(m.id)(m); continue; }
    if (m.method === "session/load") {
      if (behavior === "load-fail") send({ id: m.id, error: { code: -32000, message: "no such session" } });
      else send({ id: m.id, result: {} });
    } else if (m.method === "session/prompt") {
      if (behavior === "hang") { globalThis.hung = m.id; continue; }
      if (behavior === "refuse") {
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Nothing to compact" } });
        send({ id: m.id, result: { stopReason: "end_turn" } });
        continue;
      }
      const reqId = ++nextId;
      replies.set(reqId, (reply) => {
        record({ compactionReply: reply });
        if (reply.error) { send({ id: m.id, result: { stopReason: "end_turn" } }); return; }
        setTimeout(() => {
          send({ method: "_cognition.ai/compaction", params: { sessionId: "d1", status: "completed", summary: "short summary" } });
          update({ sessionUpdate: "usage_update", used: 1200, size: 200000 });
          update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Context compacted" } });
        }, 100);
      });
      update({ sessionUpdate: "usage_update", used: 90000, size: 200000 });
      send({ id: m.id, result: { stopReason: "end_turn" } });
      setTimeout(() => send({ id: reqId, method: "_cognition.ai/compaction", params: { sessionId: "d1", status: "started" } }), 50);
    } else if (m.method === "session/cancel") {
      if (globalThis.hung != null) send({ id: globalThis.hung, result: { stopReason: "cancelled" } });
    } else if (m.id != null) send({ id: m.id, result: {} });
  }
});
process.stdin.on("end", () => process.exit(0));
`,
  );
  chmodSync(file, 0o755);
  const stateDir = path.join(dir, "state");
  const bindings = new DevinSessionBindings(stateDir);
  return {
    deps: { command: file, stateDir, bindings },
    bindings,
    log: () => (existsSync(log) ? JSON.parse(readFileSync(log, "utf8")) : []),
  };
}

const workspaceDir = "/tmp";
const params = (extra = {}) => ({ sessionId: "oc1", sessionFile: "/tmp/oc1.jsonl", workspaceDir, ...extra });
const bind = (bindings, cwd = workspaceDir) =>
  bindings.set("oc1", { devinSessionId: "d1", cwd, contextTokens: 90000, updatedAt: 1 });

function assertExited(log) {
  for (const { pid } of log.filter((entry) => entry.pid)) {
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  }
}

test("no binding does not start Devin", async () => {
  const fake = fakeDevin("ok");
  const result = await compactDevinSession(params(), fake.deps);
  assert.equal(result.ok, true);
  assert.equal(result.compacted, false);
  assert.deepEqual(fake.log(), []);
});

test("binding from another workspace is refused", async () => {
  const fake = fakeDevin("ok");
  bind(fake.bindings, "/somewhere/else");
  const result = await compactDevinSession(params(), fake.deps);
  assert.equal(result.ok, false);
  assert.equal(result.failure.code, "workspace_mismatch");
  assert.deepEqual(fake.log(), []);
});

test("runs Devin's /compact on the bound session and reports token counts", async () => {
  const fake = fakeDevin("ok");
  bind(fake.bindings);
  const result = await compactDevinSession(params({ customInstructions: " keep the facts " }), fake.deps);
  assert.equal(result.ok, true);
  assert.equal(result.compacted, true);
  assert.equal(result.compactionKind, "native-harness");
  assert.equal(result.result.tokensBefore, 90000);
  assert.equal(result.result.tokensAfter, 1200);
  assert.equal(result.result.summary, "short summary");
  const log = fake.log();
  assert.deepEqual(log.find((e) => e.method === "session/load").params.sessionId, "d1");
  assert.equal(log.find((e) => e.method === "session/prompt").params.prompt[0].text, "/compact keep the facts");
  assert.deepEqual(log.find((e) => e.compactionReply).compactionReply.result, {});
  assert.equal(fake.bindings.get("oc1").contextTokens, 1200);
  assertExited(log);
});

test("Devin declining to compact is a failure", async () => {
  const fake = fakeDevin("refuse");
  bind(fake.bindings);
  const result = await compactDevinSession(params(), { ...fake.deps, startGraceMs: 200 });
  assert.equal(result.ok, false);
  assert.equal(result.compacted, false);
  assert.match(result.reason, /Nothing to compact/);
  assert.equal(fake.bindings.get("oc1").contextTokens, 90000);
  assertExited(fake.log());
});

test("unresumable Devin session fails and closes the process", async () => {
  const fake = fakeDevin("load-fail");
  bind(fake.bindings);
  const result = await compactDevinSession(params(), fake.deps);
  assert.equal(result.failure.code, "resume_failed");
  assertExited(fake.log());
});

test("abort cancels the Devin prompt and closes the process", async () => {
  const fake = fakeDevin("hang");
  bind(fake.bindings);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const result = await compactDevinSession(params({ abortSignal: controller.signal }), fake.deps);
  assert.equal(result.failure.code, "aborted");
  assert.ok(fake.log().some((e) => e.method === "session/cancel"));
  assertExited(fake.log());
});

test("timeout cancels the Devin prompt", async () => {
  const fake = fakeDevin("hang");
  bind(fake.bindings);
  const result = await compactDevinSession(params(), { ...fake.deps, timeoutMs: 200 });
  assert.equal(result.failure.code, "timeout");
  assertExited(fake.log());
});
