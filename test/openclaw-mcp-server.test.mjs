import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startOpenClawMcpBridge, toMcpContent } from "../dist/openclaw-mcp-server.js";
import { DEVIN_NATIVE_TOOLS, openClawOnlyDevinConfig } from "../dist/devin-config.js";

const echoTool = (calls) => ({
  name: "echo",
  label: "Echo",
  description: "Echo text",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  execute: async (toolCallId, args) => {
    calls.push({ toolCallId, args });
    return { content: [{ type: "text", text: `echo:${args.text}` }], details: {} };
  },
});

const failTool = {
  name: "boom",
  label: "Boom",
  description: "Always throws",
  parameters: { type: "object", properties: {} },
  execute: async () => {
    throw new Error("kaboom");
  },
};

async function connect(bridge) {
  const headers = Object.fromEntries(bridge.server.headers.map((h) => [h.name, h.value]));
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(bridge.server.url), { requestInit: { headers } }));
  return client;
}

test("lists and executes bound OpenClaw tools with claimed call ids", async () => {
  const calls = [];
  const completed = [];
  const bridge = await startOpenClawMcpBridge({
    tools: [echoTool(calls), failTool],
    signal: new AbortController().signal,
    claimToolCallId: (name) => `acp-${name}`,
    onCompleted: (c) => completed.push({ name: c.tool.name, id: c.toolCallId, isError: c.isError, error: c.error }),
  });
  try {
    assert.equal(bridge.server.type, "http");
    assert.match(bridge.server.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const client = await connect(bridge);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((t) => t.name), ["echo", "boom"]);
    assert.equal(listed.tools[0].inputSchema.type, "object");

    const ok = await client.callTool({ name: "echo", arguments: { text: "hi" } });
    assert.deepEqual(ok.content, [{ type: "text", text: "echo:hi" }]);
    assert.ok(!ok.isError);
    assert.deepEqual(calls, [{ toolCallId: "acp-echo", args: { text: "hi" } }]);

    const bad = await client.callTool({ name: "boom", arguments: {} });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /kaboom/);

    const unknown = await client.callTool({ name: "nope", arguments: {} });
    assert.equal(unknown.isError, true);

    assert.deepEqual(completed, [
      { name: "echo", id: "acp-echo", isError: false, error: undefined },
      { name: "boom", id: "acp-boom", isError: true, error: "kaboom" },
    ]);
    await client.close();
  } finally {
    await bridge.close();
  }
});

test("rejects requests without the per-turn bearer token", async () => {
  const bridge = await startOpenClawMcpBridge({
    tools: [echoTool([])],
    signal: new AbortController().signal,
    claimToolCallId: () => "id",
  });
  try {
    const res = await fetch(bridge.server.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(res.status, 401);
  } finally {
    await bridge.close();
  }
});

test("maps OpenClaw results onto MCP content", () => {
  assert.deepEqual(
    toMcpContent({ content: [{ type: "text", text: "a" }, { type: "image", data: "AA==", mimeType: "image/png" }] }),
    [{ type: "text", text: "a" }, { type: "image", data: "AA==", mimeType: "image/png" }],
  );
  assert.deepEqual(toMcpContent({ content: [], details: { ok: 1 } }), [{ type: "text", text: '{"ok":1}' }]);
});

test("OpenClaw-only Devin config keeps user settings and disables native tools", () => {
  const config = openClawOnlyDevinConfig({ theme_mode: "dark", disabled_tools: ["custom"] });
  assert.equal(config.theme_mode, "dark");
  assert.equal(config.subagents_enabled, false);
  assert.ok(config.disabled_tools.includes("custom"));
  for (const name of DEVIN_NATIVE_TOOLS) assert.ok(config.disabled_tools.includes(name));
  assert.ok(!config.disabled_tools.some((name) => name.startsWith("mcp_")));
});
