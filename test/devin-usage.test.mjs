import assert from "node:assert/strict";
import { test } from "node:test";
import { DevinUsageTracker } from "../dist/devin-usage.js";

const update = (used, meta, size = 262000, extra = {}) => ({
  sessionUpdate: "usage_update",
  used,
  size,
  _meta: {
    "cognition.ai/inputTokens": meta[0],
    "cognition.ai/outputTokens": meta[1],
    "cognition.ai/cachedReadTokens": meta[2],
    ...extra,
  },
});

test("maps usage_update onto a context snapshot and uncached input", () => {
  const tracker = new DevinUsageTracker();
  const recorded = tracker.record(update(17228, [17194, 34, 17023]));
  assert.deepEqual(recorded.snapshot, {
    activeContextTokens: 17228,
    modelContextWindow: 262000,
    inputTokens: 17194,
    promptTokens: 17194,
    cachedInputTokens: 17023,
    outputTokens: 34,
  });
  assert.equal(recorded.outputTokens, 34);
  assert.equal(recorded.compacted, undefined);
  const usage = tracker.turnUsage();
  assert.equal(usage.input, 171);
  assert.equal(usage.cacheRead, 17023);
  assert.equal(usage.output, 34);
  assert.equal(usage.totalTokens, 17228);
  assert.deepEqual(usage.contextUsage, { state: "available", promptTokens: 17194, totalTokens: 17228 });
  assert.equal(tracker.contextWindow, 262000);
});

test("sums billing across calls, keeps the latest context, and ignores repeated scopes", () => {
  const tracker = new DevinUsageTracker();
  tracker.record(update(1000, [990, 10, 0]));
  assert.equal(tracker.record(update(1000, [990, 10, 0])), undefined);
  tracker.record(update(1500, [1480, 20, 900]));
  const usage = tracker.turnUsage({ inputTokens: 1480, outputTokens: 20, totalTokens: 1500 });
  assert.equal(usage.output, 30);
  assert.equal(usage.cacheRead, 900);
  assert.equal(usage.input, 990 + 1480 - 900);
  assert.deepEqual(usage.contextUsage, { state: "available", promptTokens: 1480, totalTokens: 1500 });
});

test("falls back to the prompt result when no usage_update arrived", () => {
  const usage = new DevinUsageTracker().turnUsage({
    inputTokens: 100,
    outputTokens: 5,
    cachedReadTokens: 40,
    totalTokens: 105,
  });
  assert.equal(usage.input, 60);
  assert.equal(usage.totalTokens, 105);
  assert.deepEqual(usage.contextUsage, { state: "available", promptTokens: 100, totalTokens: 105 });
  assert.deepEqual(new DevinUsageTracker().turnUsage().contextUsage, { state: "unavailable" });
});

test("infers compaction from a sharp context drop, including across resumed turns", () => {
  const resumed = new DevinUsageTracker(180000);
  const recorded = resumed.record(update(30000, [29900, 100, 0]));
  assert.deepEqual(recorded.compacted, { tokensBefore: 180000, tokensAfter: 30000 });
  assert.equal(resumed.compactions, 1);
  assert.equal(resumed.contextTokens, 30000);

  const growing = new DevinUsageTracker(20000);
  assert.equal(growing.record(update(21000, [20900, 100, 0])).compacted, undefined);
  assert.equal(growing.record(update(18000, [17900, 100, 0])).compacted, undefined);
  assert.equal(growing.compactions, 0);
});

test("ignores updates without a context size", () => {
  assert.equal(new DevinUsageTracker().record({ sessionUpdate: "usage_update" }), undefined);
});
