import assert from "node:assert/strict";
import { test } from "node:test";
import { projectConfiguredMcpServer, toAcpMcpServers } from "../dist/forwarded-mcp-servers.js";

test("gives each configured server to Devin under its own name", () => {
  const { servers, skipped } = toAcpMcpServers({
    projected: {
      "cua-driver": { command: "/bin/cua-driver", args: ["mcp"], env: { DISPLAY: ":0" } },
      docs: { url: "https://docs.example/mcp", http_headers: { "X-Team": "a" } },
      events: { url: "https://events.example/sse" },
    },
    configured: { events: { transport: "sse" } },
    env: {},
  });
  assert.deepEqual(skipped, []);
  assert.deepEqual(
    servers.map((s) => s.server),
    [
      { name: "cua-driver", command: "/bin/cua-driver", args: ["mcp"], env: [{ name: "DISPLAY", value: ":0" }] },
      { type: "http", name: "docs", url: "https://docs.example/mcp", headers: [{ name: "X-Team", value: "a" }] },
      { type: "sse", name: "events", url: "https://events.example/sse", headers: [] },
    ],
  );
});

test("keeps the openclaw name for the native bridge and sanitizes others", () => {
  const { servers } = toAcpMcpServers({
    projected: { openclaw: { command: "x" }, "my server": { command: "y" } },
    env: {},
  });
  assert.deepEqual(
    servers.map((s) => [s.configName, s.server.name]),
    [
      ["openclaw", "openclaw-2"],
      ["my server", "my-server"],
    ],
  );
});

test("resolves header env placeholders without putting them in config", () => {
  const { servers } = toAcpMcpServers({
    projected: {
      api: { url: "https://api.example/mcp", env_http_headers: { "X-Key": "API_KEY" }, bearer_token_env_var: "API_TOKEN" },
    },
    env: { API_KEY: "k", API_TOKEN: "t" },
  });
  assert.deepEqual(servers[0].server.headers, [
    { name: "X-Key", value: "k" },
    { name: "Authorization", value: "Bearer t" },
  ]);
});

test("skips servers whose OpenClaw policy or credentials Devin can't honour", () => {
  const { servers, skipped } = toAcpMcpServers({
    projected: {
      filtered: { command: "a", disabled_tools: ["rm"] },
      prompted: { command: "b", default_tools_approval_mode: "prompt" },
      oauth: { url: "https://o.example/mcp" },
      nokey: { url: "https://n.example/mcp", bearer_token_env_var: "MISSING" },
      rooted: { command: "c", cwd: "/srv" },
    },
    configured: { oauth: { auth: "oauth" } },
    env: {},
  });
  assert.deepEqual(servers, []);
  assert.deepEqual(
    skipped.map((s) => s.configName),
    ["filtered", "prompted", "oauth", "nokey", "rooted"],
  );
});

test("projects owner mcp.servers entries, keeping secrets as env placeholders", () => {
  assert.deepEqual(
    projectConfiguredMcpServer(
      {
        url: "https://api.example/mcp",
        transport: "streamable-http",
        headers: { Authorization: "Bearer ${API_TOKEN}", "X-Key": "${API_KEY}", "X-Team": "a" },
        toolFilter: { exclude: ["drop"] },
      },
      ["delete"],
    ),
    {
      url: "https://api.example/mcp",
      bearer_token_env_var: "API_TOKEN",
      env_http_headers: { "X-Key": "API_KEY" },
      http_headers: { "X-Team": "a" },
      disabled_tools: ["drop", "delete"],
    },
  );
  assert.deepEqual(projectConfiguredMcpServer({ command: "node", args: ["s.mjs"], env: { PORT: 3 } }), {
    command: "node",
    args: ["s.mjs"],
    env: { PORT: "3" },
  });
});
