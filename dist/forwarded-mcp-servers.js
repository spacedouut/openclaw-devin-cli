/**
 * Hands OpenClaw's configured MCP servers to `devin acp` as their own ACP MCP
 * servers, next to the `openclaw` bridge that serves OpenClaw's native tools.
 */
import { assignMcpCatalogSafeServerNames, loadCodexBundleMcpThreadConfig, } from "openclaw/plugin-sdk/agent-harness-runtime";
import { OPENCLAW_MCP_SERVER_NAME } from "./openclaw-mcp-server.js";
function stringRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return {};
    return Object.fromEntries(Object.entries(value).filter((entry) => typeof entry[1] === "string"));
}
function pairs(record) {
    return Object.entries(record).map(([name, value]) => ({ name, value }));
}
function unsupported(server, env) {
    if (Array.isArray(server.enabled_tools) || Array.isArray(server.disabled_tools)) {
        return "per-tool filters (toolFilter or session denials) can't be enforced by devin acp";
    }
    const approval = server.default_tools_approval_mode;
    if (approval === "prompt" || approval === "approve") {
        return `tool approval mode "${approval}" can't be enforced by devin acp`;
    }
    if (typeof server.command === "string" && typeof server.cwd === "string") {
        return "stdio cwd is not supported by devin acp";
    }
    const missing = [
        ...Object.values(stringRecord(server.env_http_headers)),
        ...(typeof server.bearer_token_env_var === "string" ? [server.bearer_token_env_var] : []),
    ].find((name) => !env[name]);
    if (missing)
        return `header env var ${missing} is not set`;
    return undefined;
}
/** Maps OpenClaw's projected MCP server config onto ACP `McpServer` entries. */
export function toAcpMcpServers(params) {
    const configNames = Object.keys(params.projected);
    const safeNames = assignMcpCatalogSafeServerNames([OPENCLAW_MCP_SERVER_NAME, ...configNames]);
    const result = { servers: [], skipped: [] };
    for (const configName of configNames) {
        const server = params.projected[configName] ?? {};
        const name = safeNames.get(configName) ?? configName;
        const configured = params.configured?.[configName];
        const reason = configured?.auth === "oauth"
            ? "OpenClaw-managed OAuth credentials can't be handed to devin acp"
            : unsupported(server, params.env);
        if (reason) {
            result.skipped.push({ configName, reason });
            continue;
        }
        if (typeof server.command === "string") {
            const args = Array.isArray(server.args) ? server.args.filter((a) => typeof a === "string") : [];
            result.servers.push({
                configName,
                server: { name, command: server.command, args, env: pairs(stringRecord(server.env)) },
            });
            continue;
        }
        if (typeof server.url === "string") {
            const headers = stringRecord(server.http_headers);
            for (const [header, envVar] of Object.entries(stringRecord(server.env_http_headers))) {
                headers[header] = params.env[envVar] ?? "";
            }
            if (typeof server.bearer_token_env_var === "string") {
                headers.Authorization = `Bearer ${params.env[server.bearer_token_env_var] ?? ""}`;
            }
            const type = configured?.transport === "sse" ? "sse" : "http";
            result.servers.push({ configName, server: { type, name, url: server.url, headers: pairs(headers) } });
            continue;
        }
        result.skipped.push({ configName, reason: "no command or url" });
    }
    return result;
}
function scalarRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const entries = Object.entries(value).flatMap(([key, entry]) => typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean"
        ? [[key, String(entry)]]
        : []);
    return entries.length ? Object.fromEntries(entries) : undefined;
}
function stringList(value) {
    return Array.isArray(value) ? value.filter((entry) => typeof entry === "string" && entry.trim() !== "") : [];
}
/** Projects an owner `mcp.servers` entry into the same shape OpenClaw uses for bundle servers. */
export function projectConfiguredMcpServer(raw, deniedTools = []) {
    const next = {};
    for (const field of ["command", "cwd", "url"]) {
        if (typeof raw[field] === "string")
            next[field] = raw[field];
    }
    const args = stringList(raw.args);
    if (args.length)
        next.args = args;
    const env = scalarRecord(raw.env);
    if (env)
        next.env = env;
    const headers = scalarRecord(raw.headers);
    if (headers) {
        const staticHeaders = {};
        const envHeaders = {};
        for (const [header, value] of Object.entries(headers)) {
            const placeholder = /^(Bearer )?\$\{([A-Z0-9_]+)\}$/.exec(value);
            if (!placeholder?.[2])
                staticHeaders[header] = value;
            else if (placeholder[1] && header.toLowerCase() === "authorization")
                next.bearer_token_env_var = placeholder[2];
            else
                envHeaders[header] = placeholder[2];
        }
        if (Object.keys(staticHeaders).length)
            next.http_headers = staticHeaders;
        if (Object.keys(envHeaders).length)
            next.env_http_headers = envHeaders;
    }
    const filter = raw.toolFilter && typeof raw.toolFilter === "object" ? raw.toolFilter : {};
    const include = stringList(filter.include);
    const exclude = [...new Set([...stringList(filter.exclude), ...deniedTools])];
    if (include.length)
        next.enabled_tools = include;
    if (exclude.length)
        next.disabled_tools = exclude;
    return next;
}
function configuredServers(input) {
    const servers = input.config?.mcp?.servers ?? {};
    return Object.fromEntries(Object.entries(servers).map(([name, server]) => [name, { transport: server?.transport, auth: server?.auth }]));
}
/** Resolves the static MCP servers OpenClaw would give this turn, honouring session overrides. */
export async function resolveForwardedMcpServers(input, agentId) {
    const loaded = await loadCodexBundleMcpThreadConfig({
        workspaceDir: input.workspaceDir,
        agentId,
        cfg: input.config,
        disableTools: input.disableTools,
        toolsAllow: input.toolsAllow,
        toolOverrides: input.toolOverrides,
    });
    const owner = input.config?.mcp?.servers ?? {};
    const denials = input.toolOverrides?.mcpToolsDeny ?? {};
    const projected = { ...(loaded.configPatch?.mcp_servers ?? {}) };
    for (const name of loaded.userStaticServerNames) {
        const raw = owner[name];
        if (raw)
            projected[name] = projectConfiguredMcpServer(raw, Object.hasOwn(denials, name) ? (denials[name] ?? []) : []);
    }
    const mapped = toAcpMcpServers({ projected, configured: configuredServers(input), env: process.env });
    for (const diagnostic of loaded.diagnostics) {
        mapped.skipped.push({ configName: diagnostic.pluginId, reason: diagnostic.message });
    }
    return mapped;
}
