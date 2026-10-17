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
