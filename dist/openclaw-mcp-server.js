/**
 * Loopback MCP server (streamable HTTP, stateless) exposing one turn's bound
 * OpenClaw tools to `devin acp`. Guarded by a per-turn bearer token and torn
 * down with the turn.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { extractToolErrorMessage, isToolResultError, sanitizeToolResult, } from "openclaw/plugin-sdk/agent-harness-runtime";
import { DEVIN_CLIENT_VERSION } from "./devin-acp.js";
export const OPENCLAW_MCP_SERVER_NAME = "openclaw";
/** Devin names MCP tools `mcp__<server>__<tool>`. */
export const OPENCLAW_MCP_TOOL_PREFIX = `mcp__${OPENCLAW_MCP_SERVER_NAME}__`;
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}
function inputSchemaFor(tool) {
    const schema = asRecord(tool.parameters);
    return { ...schema, type: "object" };
}
/** Maps an OpenClaw `AgentToolResult` onto MCP content blocks. */
export function toMcpContent(result) {
    const content = asRecord(result).content;
    const blocks = [];
    if (Array.isArray(content)) {
        for (const item of content) {
            const block = asRecord(item);
            if (block.type === "text" && typeof block.text === "string") {
                blocks.push({ type: "text", text: block.text });
            }
            else if (block.type === "image" &&
                typeof block.data === "string" &&
                typeof block.mimeType === "string") {
                blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
            }
        }
    }
    if (blocks.length > 0)
        return blocks;
    if (typeof result === "string")
        return [{ type: "text", text: result }];
    const details = asRecord(result).details;
    const fallback = details ?? result;
    return [{ type: "text", text: fallback === undefined ? "" : JSON.stringify(fallback) }];
}
function tokenMatches(header, expected) {
    if (!header?.startsWith("Bearer "))
        return false;
    const given = Buffer.from(header.slice("Bearer ".length));
    return given.length === expected.length && timingSafeEqual(given, expected);
}
export async function startOpenClawMcpBridge(params) {
    const byName = new Map(params.tools.map((tool) => [tool.name, tool]));
    const listed = params.tools.map((tool) => ({
        name: tool.name,
        ...(tool.label && tool.label !== tool.name ? { title: tool.label } : {}),
        description: tool.description ?? "",
        inputSchema: inputSchemaFor(tool),
    }));
    let barrier = Promise.resolve();
    const pending = new Set();
    const schedule = (mode, run) => {
        const gate = barrier;
        const task = mode === "sequential"
            ? gate.then(() => Promise.allSettled([...pending])).then(run)
            : gate.then(run);
        if (mode === "sequential")
            barrier = task.catch(() => undefined);
        pending.add(task);
        void task.finally(() => pending.delete(task)).catch(() => undefined);
        return task;
    };
    const callTool = async (name, rawArgs) => {
        const tool = byName.get(name);
        if (!tool) {
            return { isError: true, content: [{ type: "text", text: `Unknown OpenClaw tool: ${name}` }] };
        }
        const toolCallId = params.claimToolCallId(name);
        const args = asRecord(rawArgs);
        return await schedule(tool.executionMode, async () => {
            const startedAt = Date.now();
            params.signal.throwIfAborted();
            try {
                const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
                const raw = await tool.execute(toolCallId, prepared, params.signal);
                const result = sanitizeToolResult(raw);
                const isError = isToolResultError(result);
                await params.onCompleted?.({ tool, toolCallId, args, result: raw, isError, startedAt });
                return { content: toMcpContent(result), ...(isError ? { isError: true } : {}) };
            }
            catch (error) {
                const message = extractToolErrorMessage(error) ?? (error instanceof Error ? error.message : String(error));
                await params.onCompleted?.({ tool, toolCallId, args, error: message, isError: true, startedAt });
                return { isError: true, content: [{ type: "text", text: message }] };
            }
        });
    };
    const buildServer = () => {
        const server = new Server({ name: OPENCLAW_MCP_SERVER_NAME, version: DEVIN_CLIENT_VERSION }, { capabilities: { tools: {} } });
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listed }));
        server.setRequestHandler(CallToolRequestSchema, async (request) => callTool(request.params.name, request.params.arguments));
        return server;
    };
    const token = randomBytes(32).toString("base64url");
    const expected = Buffer.from(token);
    const handle = async (req, res) => {
        if (!tokenMatches(req.headers.authorization, expected)) {
            res.writeHead(401).end();
            return;
        }
        if (new URL(req.url ?? "/", "http://127.0.0.1").pathname !== "/mcp") {
            res.writeHead(404).end();
            return;
        }
        const server = buildServer();
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
        });
        res.on("close", () => {
            void transport.close();
            void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res);
    };
    const http = createServer((req, res) => {
        handle(req, res).catch(() => {
            if (!res.headersSent)
                res.writeHead(500);
            res.end();
        });
    });
    await new Promise((resolve, reject) => {
        http.once("error", reject);
        http.listen(0, "127.0.0.1", () => {
            http.off("error", reject);
            resolve();
        });
    });
    const { port } = http.address();
    let closed;
    return {
        server: {
            type: "http",
            name: OPENCLAW_MCP_SERVER_NAME,
            url: `http://127.0.0.1:${port}/mcp`,
            headers: [{ name: "Authorization", value: `Bearer ${token}` }],
        },
        toolNames: params.tools.map((tool) => tool.name),
        close: () => (closed ??= new Promise((resolve) => {
            http.close(() => resolve());
            http.closeAllConnections();
        })),
    };
}
