import { OPENCLAW_MCP_SERVER_NAME, OPENCLAW_MCP_TOOL_PREFIX } from "./openclaw-mcp-server.js";
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}
export function devinToolName(update) {
    const named = update._meta?.["cognition.ai/toolName"] ?? update._meta?.["cognition.ai/inferenceToolName"];
    return typeof named === "string" ? named : undefined;
}
/**
 * Presents OpenClaw tools reached through Devin's MCP client as the OpenClaw tool itself:
 * `mcp__openclaw__read` and `mcp_call_tool {server_name: "openclaw", tool_name: "read"}` both become `read`.
 */
export function resolveDevinTool(update) {
    const named = devinToolName(update);
    const raw = update.rawInput && typeof update.rawInput === "object" ? asRecord(update.rawInput) : undefined;
    if (named?.startsWith(OPENCLAW_MCP_TOOL_PREFIX)) {
        return { name: named.slice(OPENCLAW_MCP_TOOL_PREFIX.length), args: raw, openclaw: true };
    }
    if (named === "mcp_call_tool" &&
        raw?.server_name === OPENCLAW_MCP_SERVER_NAME &&
        typeof raw.tool_name === "string" &&
        raw.tool_name) {
        return { name: raw.tool_name, args: asRecord(raw.arguments), openclaw: true };
    }
    return { name: named ?? update.kind, args: raw, title: update.title, openclaw: false };
}
