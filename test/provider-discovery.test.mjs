import assert from "node:assert/strict";
import test from "node:test";

import { devinCliCatalog, staticProvider } from "../dist/provider-discovery.js";

test("static seed carries no invented context window", () => {
  for (const model of staticProvider().models) {
    assert.equal(model.contextWindow, undefined, model.id);
    assert.equal(model.maxTokens, 128_000);
  }
});

test("catalog falls back to the seed without a context window when devin is unavailable", async () => {
  const result = await devinCliCatalog({
    config: { plugins: { entries: { "devin-cli": { config: { command: "/nonexistent/devin-cli-test" } } } } },
    env: {},
    resolveProviderApiKey: () => ({ apiKey: undefined }),
  });
  const models = result.providers["devin-cli"].models;
  assert.ok(models.some((m) => m.id === "claude-opus-5-5"));
  assert.ok(models.every((m) => m.contextWindow === undefined));
});

test("live catalog forwards reported windows and omits missing ones", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const stub = new URL("./fixtures/devin-stub.sh", import.meta.url).pathname;
  const script = `
    const { devinCliCatalog } = await import(${JSON.stringify(new URL("../dist/provider-discovery.js", import.meta.url).href)});
    const result = await devinCliCatalog({
      config: { plugins: { entries: { "devin-cli": { config: { command: ${JSON.stringify(stub)} } } } } },
      env: process.env,
      resolveProviderApiKey: () => ({ apiKey: undefined }),
    });
    console.log(JSON.stringify(result.providers["devin-cli"].models.map((m) => [m.id, m.contextWindow ?? null, m.maxTokens])));
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, XDG_CACHE_HOME: mkdtempSync(join(tmpdir(), "devin-cli-test-")) },
  });
  const rows = new Map(JSON.parse(out).map(([id, ctx, max]) => [id, { ctx, max }]));
  assert.deepEqual(rows.get("claude-opus-5-5"), { ctx: 1000000, max: 128000 });
  assert.deepEqual(rows.get("mystery"), { ctx: null, max: 128000 });
});
