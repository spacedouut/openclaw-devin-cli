import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runDevinIsolatedCompletion } from "../dist/isolated-completion.js";

function fakeDevin(behavior) {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-devin-"));
  const file = path.join(dir, "devin");
  writeFileSync(
    file,
    `#!/usr/bin/env node
const behavior = ${JSON.stringify(behavior)};
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const update = (u) => send({ method: "session/update", params: { sessionId: "s1", update: u } });
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.method === "session/new") send({ id: m.id, result: { sessionId: "s1" } });
    else if (m.method === "session/prompt") {
      if (behavior === "tool") update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "read" });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Disk cleanup " } });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "on homelab" } });
      send({ id: m.id, result: { stopReason: "end_turn" } });
    } else if (m.id != null) send({ id: m.id, result: {} });
  }
});
process.stdin.on("end", () => process.exit(0));
`,
  );
  chmodSync(file, 0o755);
  return { command: file, stateDir: path.join(dir, "state") };
}

const params = {
  provider: "devin-cli",
  modelId: "swe-2",
  config: {},
  agentId: "main",
  agentDir: tmpdir(),
  workspaceDir: tmpdir(),
  systemPrompt: "Title this.",
  prompt: "check disk usage",
  timeoutMs: 10_000,
  authorization: { owner: "host" },
};

test("returns Devin's text as a single stop completion", async () => {
  const result = await runDevinIsolatedCompletion(params, { ...fakeDevin("text"), model: "swe-2" });
  assert.deepEqual(result.assistant.content, [{ type: "text", text: "Disk cleanup on homelab" }]);
  assert.equal(result.assistant.stopReason, "stop");
  assert.equal(result.assistant.provider, "devin-cli");
});

test("fails closed when Devin attempts a tool call", async () => {
  await assert.rejects(
    runDevinIsolatedCompletion(params, { ...fakeDevin("tool"), model: "swe-2" }),
    /tool call during an isolated completion/,
  );
});
