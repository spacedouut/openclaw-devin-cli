import { acpText, DevinAcpProcess, pickPermissionOption } from "./devin-acp.js";
import { writeOpenClawOnlyDevinConfig } from "./devin-config.js";
import { usageFrom } from "./turn-projector.js";
export async function runDevinIsolatedCompletion(params, deps) {
    const assertCurrent = () => {
        params.assertCurrent?.();
        params.abortSignal?.throwIfAborted();
    };
    assertCurrent();
    const configPath = writeOpenClawOnlyDevinConfig({ stateDir: deps.stateDir });
    let sessionId;
    let text = "";
    let violation;
    assertCurrent();
    const acp = new DevinAcpProcess(deps.command, { cwd: params.workspaceDir, model: deps.model, configPath }, {
        onUpdate: (id, update) => {
            if (id !== sessionId)
                return;
            if (update.sessionUpdate === "agent_message_chunk") {
                text += acpText(update.content);
            }
            else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
                violation ??= "Devin attempted a tool call during an isolated completion";
                acp.cancel(id);
            }
        },
        onPermission: async (request) => {
            violation ??= "Devin requested a tool permission during an isolated completion";
            const option = pickPermissionOption(request.options, false);
            return option
                ? { outcome: { outcome: "selected", optionId: option.optionId } }
                : { outcome: { outcome: "cancelled" } };
        },
    });
    let timedOut = false;
    const cancel = () => {
        if (sessionId)
            acp.cancel(sessionId);
    };
    const timer = setTimeout(() => {
        timedOut = true;
        cancel();
    }, params.timeoutMs);
    timer.unref();
    params.abortSignal?.addEventListener("abort", cancel, { once: true });
    try {
        await acp.initialize();
        assertCurrent();
        sessionId = await acp.newSession(params.workspaceDir, []);
        assertCurrent();
        await acp.setMode(sessionId, "ask");
        assertCurrent();
        const prompt = [params.systemPrompt.trim(), params.prompt].filter(Boolean).join("\n\n");
        const result = await acp.prompt(sessionId, prompt);
        assertCurrent();
        if (violation)
            throw new Error(`devin-cli: ${violation}`);
        if (timedOut)
            throw new Error(`devin-cli: isolated completion timed out after ${params.timeoutMs}ms`);
        const stopReason = result?.stopReason ?? "end_turn";
        if (stopReason !== "end_turn" && stopReason !== "max_tokens") {
            throw new Error(`devin-cli: isolated completion ended with ${stopReason}`);
        }
        const visible = text.trim();
        return {
            assistant: {
                role: "assistant",
                content: visible ? [{ type: "text", text: visible }] : [],
                api: deps.api ?? "openai-responses",
                provider: params.provider,
                model: deps.model,
                usage: usageFrom(result?.usage),
                stopReason: stopReason === "max_tokens" ? "length" : "stop",
                timestamp: Date.now(),
            },
        };
    }
    finally {
        clearTimeout(timer);
        params.abortSignal?.removeEventListener("abort", cancel);
        await acp.close(sessionId).catch(() => undefined);
    }
}
