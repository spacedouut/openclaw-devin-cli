import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveDevinTool } from "../dist/devin-tool-names.js";

test("reports Devin's MCP-tagged OpenClaw call as the OpenClaw tool", () => {
  const resolved = resolveDevinTool({
    sessionUpdate: "tool_call",
    toolCallId: "t1",
    title: "Calling read from openclaw",
    rawInput: { path: "/etc/hostname" },
    _meta: { "cognition.ai/toolName": "mcp__openclaw__read", "cognition.ai/inferenceToolName": "mcp_call_tool" },
  });
  assert.deepEqual(resolved, { name: "read", args: { path: "/etc/hostname" }, openclaw: true });
});

test("unwraps a generic mcp_call_tool call on the OpenClaw server", () => {
  const resolved = resolveDevinTool({
    sessionUpdate: "tool_call",
    toolCallId: "t1",
    title: "Calling MCP tool",
    rawInput: { server_name: "openclaw", tool_name: "exec", arguments: { command: "uname -r" } },
    _meta: { "cognition.ai/inferenceToolName": "mcp_call_tool" },
  });
  assert.deepEqual(resolved, { name: "exec", args: { command: "uname -r" }, openclaw: true });
});

test("leaves other MCP servers and native Devin tools unchanged", () => {
  const other = resolveDevinTool({
    sessionUpdate: "tool_call",
    toolCallId: "t1",
    title: "Calling list_events from google-calendar",
    rawInput: { server_name: "google-calendar", tool_name: "list_events", arguments: {} },
    _meta: { "cognition.ai/inferenceToolName": "mcp_call_tool" },
  });
  assert.equal(other.name, "mcp_call_tool");
  assert.equal(other.openclaw, false);
  assert.equal(other.title, "Calling list_events from google-calendar");

  const native = resolveDevinTool({
    sessionUpdate: "tool_call",
    toolCallId: "t2",
    kind: "execute",
    title: "uname -r",
    rawInput: { command: "uname -r" },
    _meta: { "cognition.ai/toolName": "exec" },
  });
  assert.deepEqual(native, { name: "exec", args: { command: "uname -r" }, title: "uname -r", openclaw: false });
});

test("names forwarded MCP server tools the way OpenClaw does, keeping their server", () => {
  const servers = new Set(["cua-driver", "cua"]);
  const tagged = resolveDevinTool(
    {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Calling screenshot from cua-driver",
      rawInput: { window: 1 },
      _meta: { "cognition.ai/toolName": "mcp__cua-driver__screenshot" },
    },
    servers,
  );
  assert.deepEqual(tagged, {
    name: "cua-driver__screenshot",
    args: { window: 1 },
    openclaw: false,
    mcpServer: "cua-driver",
  });

  const generic = resolveDevinTool(
    {
      sessionUpdate: "tool_call",
      toolCallId: "t2",
      rawInput: { server_name: "cua", tool_name: "click", arguments: { x: 1 } },
      _meta: { "cognition.ai/inferenceToolName": "mcp_call_tool" },
    },
    servers,
  );
  assert.deepEqual(generic, { name: "cua__click", args: { x: 1 }, openclaw: false, mcpServer: "cua" });
});

test("OpenClaw calls still translate when servers are forwarded; unknown servers stay raw", () => {
  const servers = new Set(["cua-driver"]);
  const native = resolveDevinTool(
    {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      rawInput: { path: "/etc/hostname" },
      _meta: { "cognition.ai/toolName": "mcp__openclaw__read" },
    },
    servers,
  );
  assert.deepEqual(native, { name: "read", args: { path: "/etc/hostname" }, openclaw: true });

  const unknown = resolveDevinTool(
    {
      sessionUpdate: "tool_call",
      toolCallId: "t2",
      title: "Calling list_events from google-calendar",
      rawInput: { server_name: "google-calendar", tool_name: "list_events", arguments: {} },
      _meta: { "cognition.ai/inferenceToolName": "mcp_call_tool" },
    },
    servers,
  );
  assert.equal(unknown.name, "mcp_call_tool");
  assert.equal(unknown.mcpServer, undefined);
});
