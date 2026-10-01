/**
 * Builds the OpenClaw tool surface for one Devin turn through the host's
 * admitted-run capability, so each tool keeps OpenClaw policy, approvals,
 * sandbox and before-tool hooks when Devin calls it over MCP.
 */
import { applyEmbeddedAttemptToolsAllow, buildEmbeddedAttemptToolRunContext, getPluginToolMeta, isSubagentSessionKey, resolveEmbeddedAttemptToolConstructionPlan, resolveModelAuthMode, } from "openclaw/plugin-sdk/agent-harness-runtime";
/** OpenClaw tools with a Devin-native equivalent, hidden when Devin keeps its own tools. */
export const DEVIN_OVERLAPPING_TOOLS = new Set([
    "read",
    "write",
    "edit",
    "apply_patch",
    "exec",
    "process",
    "web_search",
    "web_fetch",
]);
function isRawModelRun(input) {
    return input.modelRun === true || input.promptMode === "none";
}
export function buildOpenClawTools(input, options) {
    const createToolSurface = input.hostCapabilities.createToolSurface;
    if (!createToolSurface) {
        throw new Error("OpenClaw host did not provide a tool surface for the Devin harness");
    }
    const runContext = buildEmbeddedAttemptToolRunContext(input);
    const plan = resolveEmbeddedAttemptToolConstructionPlan({
        disableTools: input.disableTools,
        forceMessageTool: input.forceMessageTool,
        isRawModelRun: isRawModelRun(input),
        toolsAllow: runContext.runtimeToolAllowlist,
    });
    if (!plan.constructTools)
        return [];
    const sandboxSessionKey = input.sandboxSessionKey?.trim() || input.sessionKey?.trim() || input.sessionId;
    const liveSessionKey = input.sessionKey;
    const workspaceDir = input.workspaceDir;
    const cwd = input.cwd ?? workspaceDir;
    const model = input.model;
    const surfaceOptions = {
        agentId: options.agentId,
        policyAgentId: input.sandboxAgentId ?? options.agentId,
        ...runContext,
        exec: { ...input.execOverrides, elevated: input.bashElevated },
        messageProvider: input.messageProvider ?? input.messageChannel,
        messageChannel: input.messageChannel,
        ...(input.onToolResult
            ? {
                questionPrompt: {
                    send: input.onToolResult,
                    ...(input.messageChannel ? { messageChannel: input.messageChannel } : {}),
                },
            }
            : {}),
        allowGatewaySubagentBinding: input.allowGatewaySubagentBinding,
        sessionKey: sandboxSessionKey,
        runSessionKey: liveSessionKey && liveSessionKey !== sandboxSessionKey ? liveSessionKey : undefined,
        sessionId: input.sessionId,
        runId: input.runId,
        agentDir: input.agentDir,
        preparedModelRuntime: input.preparedModelRuntime,
        workspaceDir,
        cwd,
        sandbox: input.sandbox ?? undefined,
        config: input.config,
        skillsSnapshot: input.skillsSnapshot,
        abortSignal: input.abortSignal,
        modelProvider: input.provider,
        modelId: input.modelId,
        includeCoreTools: plan.includeCoreTools,
        runtimeToolAllowlist: plan.runtimeToolAllowlist,
        toolConstructionPlan: plan.codingToolConstructionPlan,
        modelApi: model?.api,
        modelContextWindowTokens: input.contextTokenBudget ?? model?.contextWindow,
        delegationCapability: input.delegationCapability,
        modelAuthMode: resolveModelAuthMode(input.provider, input.config, undefined, { workspaceDir }),
        modelHasVision: Array.isArray(model?.input) && model.input.includes("image"),
        requireExplicitMessageTarget: input.requireExplicitMessageTarget ?? isSubagentSessionKey(liveSessionKey),
        disableMessageTool: input.disableMessageTool,
        forceMessageTool: input.forceMessageTool,
        enableHeartbeatTool: input.enableHeartbeatTool,
        forceHeartbeatTool: input.forceHeartbeatTool,
        authProfileStore: input.toolAuthProfileStore ?? input.authProfileStore,
        onToolOutcome: input.onToolOutcome,
        isTurnTainted: input.isTurnTainted,
    };
    const tools = createToolSurface(surfaceOptions, cwd ? { cwd } : undefined);
    const allowed = applyEmbeddedAttemptToolsAllow(tools, plan.runtimeToolAllowlist, {
        toolMeta: getPluginToolMeta,
    });
    const seen = new Set();
    return allowed.filter((tool) => {
        if (options.exclude?.has(tool.name) || seen.has(tool.name))
            return false;
        seen.add(tool.name);
        return true;
    });
}
