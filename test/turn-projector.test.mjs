import assert from "node:assert/strict";
import { test } from "node:test";
import { DevinTurnProjector, usageFrom } from "../dist/turn-projector.js";

const modelRef = { provider: "devin-cli", model: "kimi-k3", api: "openai-responses" };
const projector = () => new DevinTurnProjector({ modelRef, keyPrefix: "req", now: () => 1 });
const shape = (message) =>
  message.role === "toolResult"
    ? `result:${message.toolCallId}:${message.content[0].text}`
    : message.content.map((block) => (block.type === "text" ? `text:${block.text}` : `call:${block.id}`)).join("+");

test("keeps text -> tool -> result -> text order across cycles", () => {
  const p = projector();
  const writes = [];
  p.text("Checking ");
  p.text("kernel.");
  p.toolStart({ id: "t1", name: "exec", args: { command: "uname -r" } });
  p.toolEnd({ id: "t1", name: "exec", output: "7.0", isError: false });
  writes.push(...p.takeReadyGroups().flat());
  p.text("Now hostname.");
  p.toolStart({ id: "t2", name: "exec", args: { command: "hostname" } });
  p.toolEnd({ id: "t2", name: "exec", output: "obs", isError: false });
  writes.push(...p.takeReadyGroups().flat());
  p.text("Done.");
  const done = p.finish({ stopReason: "stop", usage: usageFrom({ inputTokens: 3, outputTokens: 2 }) });
  writes.push(...done.groups.flat(), done.final);
  assert.deepEqual(writes.map((w) => shape(w.message)), [
    "text:Checking kernel.+call:t1",
    "result:t1:7.0",
    "text:Now hostname.+call:t2",
    "result:t2:obs",
    "text:Done.",
  ]);
  assert.deepEqual(writes.map((w) => w.key), [
    "req:devin:group:1:assistant",
    "req:devin:tool:t1",
    "req:devin:group:2:assistant",
    "req:devin:tool:t2",
    "req:devin:final",
  ]);
  assert.equal(writes[0].message.stopReason, "toolUse");
  assert.equal(done.final.message.usage.totalTokens, 5);
});

test("parallel tools stay in one assistant message until every result arrives", () => {
  const p = projector();
  p.toolStart({ id: "a", name: "read", args: {} });
  p.toolStart({ id: "b", name: "read", args: {} });
  p.toolEnd({ id: "a", name: "read", output: "A", isError: false });
  assert.equal(p.takeReadyGroups().length, 0);
  p.text("between");
  p.toolEnd({ id: "b", name: "read", output: "B", isError: true });
  const [group] = p.takeReadyGroups();
  assert.deepEqual(group.map((w) => shape(w.message)), ["call:a+call:b", "result:a:A", "result:b:B"]);
  assert.equal(group[2].message.isError, true);
  const done = p.finish({ stopReason: "stop", usage: usageFrom() });
  assert.equal(done.finalText, "between");
});

test("tool-only turns get a non-empty fallback and unresolved tools are closed", () => {
  const p = projector();
  p.toolStart({ id: "x", name: "exec", args: { command: "true" } });
  const done = p.finish({ stopReason: "stop", usage: usageFrom(), fallbackText: () => "summary" });
  assert.deepEqual(done.groups.flat().map((w) => shape(w.message)), [
    "call:x",
    "result:x:tool did not report a result",
  ]);
  assert.equal(done.finalText, "summary");
  assert.equal(done.final.message.content[0].text, "summary");
});
