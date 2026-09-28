import type { AcpSessionUpdate } from "./devin-acp.js";
import { OPENCLAW_MCP_SERVER_NAME, OPENCLAW_MCP_TOOL_PREFIX } from "./openclaw-mcp-server.js";

export type DevinToolIdentity = {
  name: string;
  args: Record<string, unknown>;
  title?: string;
  openclaw: boolean;
  /** Forwarded OpenClaw-configured MCP server that serves the tool. */
  mcpServer?: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function devinToolName(update: AcpSessionUpdate): string | undefined {
  const named = update._meta?.["cognition.ai/toolName"] ?? update._meta?.["cognition.ai/inferenceToolName"];
  return typeof named === "string" ? named : undefined;
}

/** OpenClaw's model-facing name for a configured MCP server's tool. */
export function forwardedMcpToolName(server: string, tool: string): string {
  return `${server}__${tool}`;
}

/**
 * Presents OpenClaw tools reached through Devin's MCP client as the OpenClaw tool itself:
 * `mcp__openclaw__read` and `mcp_call_tool {server_name: "openclaw", tool_name: "read"}` both become `read`.
 */
export function resolveDevinTool(
  update: AcpSessionUpdate,
  forwardedServers: ReadonlySet<string> = new Set(),
): Partial<DevinToolIdentity> {
  const named = devinToolName(update);
  const raw = update.rawInput && typeof update.rawInput === "object" ? asRecord(update.rawInput) : undefined;
  if (named?.startsWith(OPENCLAW_MCP_TOOL_PREFIX)) {
    return { name: named.slice(OPENCLAW_MCP_TOOL_PREFIX.length), args: raw, openclaw: true };
  }
  if (
    named === "mcp_call_tool" &&
    raw?.server_name === OPENCLAW_MCP_SERVER_NAME &&
    typeof raw.tool_name === "string" &&
    raw.tool_name
  ) {
    return { name: raw.tool_name, args: asRecord(raw.arguments), openclaw: true };
  }
  if (named?.startsWith("mcp__")) {
    const server = [...forwardedServers]
      .filter((candidate) => named.startsWith(`mcp__${candidate}__`) && named.length > candidate.length + 7)
      .sort((a, b) => b.length - a.length)[0];
    if (server) {
      const tool = named.slice(server.length + 7);
      return { name: forwardedMcpToolName(server, tool), args: raw, openclaw: false, mcpServer: server };
    }
  }
  if (
    named === "mcp_call_tool" &&
    typeof raw?.server_name === "string" &&
    forwardedServers.has(raw.server_name) &&
    typeof raw.tool_name === "string" &&
    raw.tool_name
  ) {
    return {
      name: forwardedMcpToolName(raw.server_name, raw.tool_name),
      args: asRecord(raw.arguments),
      openclaw: false,
      mcpServer: raw.server_name,
    };
  }
  return { name: named ?? update.kind, args: raw, title: update.title, openclaw: false };
}
