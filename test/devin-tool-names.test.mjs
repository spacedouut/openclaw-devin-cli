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
