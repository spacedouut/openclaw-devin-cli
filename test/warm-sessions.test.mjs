import assert from "node:assert/strict";
import { test } from "node:test";
import { WarmDevinSessions } from "../dist/warm-sessions.js";

const entry = (running = true) => {
  const closed = [];
  return {
    closed,
    entry: {
      acp: { running, close: async (id) => void closed.push(`acp:${id}`) },
      bridge: { close: async () => void closed.push("bridge") },
      devinSessionId: "d1",
      shape: "s",
      model: { options: [] },
    },
  };
};

test("take returns a parked process once", async () => {
  const warm = new WarmDevinSessions(() => 60_000);
  const { entry: e, closed } = entry();
  await warm.put("s1", e);
  assert.equal(warm.take("s1"), e);
  assert.equal(warm.take("s1"), undefined);
  assert.deepEqual(closed, []);
});

test("keep-alive 0 closes instead of parking", async () => {
  const warm = new WarmDevinSessions(() => 0);
  const { entry: e, closed } = entry();
  await warm.put("s1", e);
  assert.equal(warm.take("s1"), undefined);
  assert.deepEqual(closed, ["acp:d1", "bridge"]);
});

test("idle timeout, eviction and dead processes close the entry", async () => {
  const warm = new WarmDevinSessions(() => 20);
  const idle = entry();
  await warm.put("s1", idle.entry);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(idle.closed, ["acp:d1", "bridge"]);

  const evicted = entry();
  const pool = new WarmDevinSessions(() => 60_000);
  await pool.put("s2", evicted.entry);
  await pool.evict("s2");
  assert.deepEqual(evicted.closed, ["acp:d1", "bridge"]);

  const dead = entry(false);
  await pool.put("s3", dead.entry);
  assert.deepEqual(dead.closed, ["acp:d1", "bridge"]);
});
