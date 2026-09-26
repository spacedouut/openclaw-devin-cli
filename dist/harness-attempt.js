/**
 * One OpenClaw agent turn executed natively by `devin acp`.
 *
 * The harness owns the transcript: every Devin text run, tool call and tool
 * result is appended as its own typed message while the turn streams, and the
 * matching live `item`/`tool` events are emitted with paired tool-call ids.
 */
import { clearActiveEmbeddedRun, emitAgentEvent, projectAgentToolActivity, resolveAgentHarnessBeforePromptBuildResult, resolveBootstrapContextForRun, setActiveEmbeddedRun, } from "openclaw/plugin-sdk/agent-harness-runtime";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentityStrict, appendSessionTranscriptMessagesByIdentity, publishSessionTranscriptUpdateByIdentity, } from "openclaw/plugin-sdk/session-transcript-runtime";
import { randomUUID } from "node:crypto";
import { ACP_MODES, acpText, DevinAcpProcess, pickPermissionOption, } from "./devin-acp.js";
import { DevinTurnProjector, usageFrom, } from "./turn-projector.js";
const TERMINAL_TOOL_STATUS = new Set(["completed", "failed"]);
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}
function toolNameFor(update, previous) {
    const inferred = update._meta?.["cognition.ai/inferenceToolName"];
    return previous?.name ?? (typeof inferred === "string" ? inferred : undefined) ?? update.kind ?? "tool";
}
function summarizeTools(tools) {
    return [...tools]
        .map((tool) => {
        const status = tool.denied ? "permission denied" : (tool.status ?? "pending");
        const tail = tool.output.trim()
            ? `\n    ${tool.output.trim().split("\n").slice(-5).join("\n    ")}`
            : "";
        return `- ${tool.title || tool.name} (${status})${tail}`;
    })
        .join("\n");
}
function renderHistory(messages) {
    const lines = [];
    for (const message of messages) {
        if (message.role !== "user" && message.role !== "assistant")
            continue;
        const content = message.content;
        const text = typeof content === "string"
            ? content
            : content
                .map((block) => (block.type === "text" ? block.text : ""))
                .filter(Boolean)
                .join("\n");
        if (text.trim())
            lines.push(`${message.role}: ${text.trim()}`);
    }
    return lines.join("\n\n");
}
export async function runDevinAttempt(input, deps) {
    const agentId = input.agentId;
    const sessionKey = input.sessionKey;
    if (!agentId || !sessionKey) {
        throw new Error("Devin harness requires an agent id and session key");
    }
    const recorder = input.userTurnTranscriptRecorder;
    if (!recorder) {
        throw new Error("Devin harness requires its admitted transcript recorder");
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([
        controller.signal,
        deps.generationSignal,
        ...(input.abortSignal ? [input.abortSignal] : []),
    ]);
    const assertActive = () => {
        signal.throwIfAborted();
        input.hostCapabilities.assertActive();
    };
    const transcript = {
        agentId,
        sessionKey,
        sessionId: input.sessionId,
        storePath: resolveStorePath(input.config?.session?.store, { agentId }),
    };
    const modelRef = { provider: input.provider, model: input.modelId, api: input.model.api };
    let acp;
    let devinSessionId;
    let started = false;
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let failure;
    let messages = [];
    let finalAssistant;
    let finalKey;
    let terminalAnchor;
    let assistantTexts = [];
    const tools = new Map();
    const toolMetas = [];
    const activeRun = {
        kind: "embedded",
        runId: input.runId,
        toolAuthorityFingerprint: input.toolAuthorityFingerprint,
        queueMessage: async () => {
            throw new Error("Devin CLI does not support live message injection");
        },
        isStreaming: () => started && !settled,
        isAborted: () => signal.aborted,
        isCompacting: () => false,
        cancel: () => controller.abort(),
        abort: () => controller.abort(),
        sourceReplyDeliveryMode: input.sourceReplyDeliveryMode,
    };
    let activeRegistered = false;
    let timer;
    // Serialize every live event and transcript write so they keep ACP order.
    let chain = Promise.resolve();
    let chainError;
    const enqueue = (work) => {
        chain = chain.then(async () => {
            if (chainError)
                return;
            try {
                await work();
            }
            catch (error) {
                chainError ??= error;
                controller.abort();
            }
        });
    };
    const emit = async (stream, data) => {
        emitAgentEvent({ runId: input.runId, sessionKey, sessionId: input.sessionId, stream, data });
        await input.onAgentEvent?.({ stream, data });
    };
    let projector;
    let liveText = "";
    let liveSegmentOpen = false;
    const writeGroups = async (groups) => {
        for (const group of groups) {
            assertActive();
            await appendSessionTranscriptMessagesByIdentity({
                ...transcript,
                config: input.config,
                cwd: input.workspaceDir,
                messages: group.map((write) => ({
                    message: { ...write.message, idempotencyKey: write.key },
                    idempotencyLookup: "scan",
                    beforeFreshMessageCommit: () => input.hostCapabilities.assertActive(),
                })),
            });
            await publishSessionTranscriptUpdateByIdentity(transcript).catch(() => undefined);
        }
    };
    const onText = (delta) => {
        enqueue(async () => {
            if (!liveSegmentOpen) {
                liveSegmentOpen = true;
                liveText = "";
                await input.onAssistantMessageStart?.();
                assertActive();
            }
            liveText += delta;
            projector?.text(delta);
            await emit("assistant", { text: liveText, delta });
            assertActive();
            await input.onPartialReply?.({ text: liveText });
        });
    };
    const onToolUpdate = (update) => {
        const id = update.toolCallId;
        if (!id)
            return;
        const previous = tools.get(id);
        const output = update.sessionUpdate === "tool_call_update" ? acpText(update.content) : "";
        const next = {
            id,
            name: toolNameFor(update, previous),
            title: update.title ?? previous?.title,
            kind: update.kind ?? previous?.kind,
            args: update.rawInput && typeof update.rawInput === "object" ? asRecord(update.rawInput) : (previous?.args ?? {}),
            status: update.status ?? previous?.status,
            output: output || previous?.output || "",
            started: previous?.started ?? false,
            finished: previous?.finished ?? false,
            denied: previous?.denied ?? false,
            startedAt: previous?.startedAt ?? Date.now(),
        };
        tools.set(id, next);
        const ready = Boolean(update.status) ||
            (update.sessionUpdate === "tool_call" && Object.keys(next.args).length > 0);
        if (!next.started && ready) {
            next.started = true;
            const args = { ...(next.title ? { title: next.title } : {}), ...next.args };
            enqueue(async () => {
                liveSegmentOpen = false;
                projector?.toolStart({ id, name: next.name, args });
                const toolData = { phase: "start", name: next.name, toolCallId: id, args };
                await emit("item", projectAgentToolActivity(toolData));
                await emit("tool", toolData);
            });
        }
        if (next.started && !next.finished && next.status && TERMINAL_TOOL_STATUS.has(next.status)) {
            finishTool(next);
        }
    };
    const finishTool = (tool) => {
        tool.finished = true;
        const isError = tool.denied || tool.status !== "completed";
        const output = tool.denied
            ? "permission denied"
            : tool.output || (isError ? `tool ${tool.status ?? "incomplete"}` : "");
        const meta = tool.title ?? tool.name;
        toolMetas.push({ toolName: tool.name, toolCallId: tool.id, meta, isError });
        enqueue(async () => {
            projector?.toolEnd({ id: tool.id, name: tool.name, output, isError });
            const args = { ...(tool.title ? { title: tool.title } : {}), ...tool.args };
            const toolData = {
                phase: "result",
                name: tool.name,
                toolCallId: tool.id,
                args,
                isError,
                result: { content: [{ type: "text", text: output }] },
            };
            await emit("tool", toolData);
            await emit("item", projectAgentToolActivity({
                ...toolData,
                status: isError ? "failed" : "completed",
            }));
            await input.onToolResult?.({ text: output });
            await writeGroups(projector?.takeReadyGroups() ?? []);
        });
    };
    assertActive();
    try {
        setActiveEmbeddedRun(input.sessionId, activeRun, sessionKey, input.sessionFile, agentId);
        activeRegistered = true;
        input.replyOperation?.attachBackend(activeRun);
        timer = setTimeout(() => {
            timedOut = true;
            input.onAttemptTimeout?.(new Error("Devin turn timed out"));
            controller.abort();
        }, input.timeoutMs);
        timer.unref();
        const sessionContext = await SessionManager.openModelContextAsync(transcript, {
            cwd: input.workspaceDir,
            signal,
        });
        messages = sessionContext.buildSessionContext().messages;
        assertActive();
        const binding = deps.bindings.get(input.sessionId);
        const model = deps.resolveModel(input);
        const permissionMode = deps.resolvePermissionMode(input);
        const acpMode = ACP_MODES[permissionMode] ?? permissionMode;
        const allowPermissions = acpMode !== "ask";
        await recorder.persistApproved({ expectedSessionId: input.sessionId });
        assertActive();
        const admission = recorder.getAdmissionReceipt();
        if (recorder.isBlocked() || !recorder.hasPersisted() || !admission) {
            throw new Error("Devin input was not admitted to its transcript");
        }
        const requestId = `${admission.entryId}:devin:${randomUUID()}`;
        projector = new DevinTurnProjector({ modelRef, keyPrefix: requestId });
        const cwd = binding?.cwd ?? input.workspaceDir;
        acp = new DevinAcpProcess(deps.command, { cwd, model }, {
            onUpdate: (sessionId, update) => {
                if (!started || sessionId !== devinSessionId || signal.aborted)
                    return;
                switch (update.sessionUpdate) {
                    case "agent_message_chunk": {
                        const context = asRecord(update._meta?.["cognition.ai/subagent_context"]);
                        const parent = context.parentAgentId;
                        if (typeof parent === "string" && parent !== "root")
                            break;
                        onText(acpText(update.content));
                        break;
                    }
                    case "tool_call":
                    case "tool_call_update":
                        onToolUpdate(update);
                        break;
                    default:
                        break;
                }
            },
            onPermission: async (request) => {
                input.hostCapabilities.assertActive();
                const id = request.toolCall?.toolCallId;
                if (id && !allowPermissions) {
                    const tool = tools.get(id);
                    if (tool)
                        tool.denied = true;
                }
                const option = pickPermissionOption(request.options, allowPermissions);
                return option
                    ? { outcome: { outcome: "selected", optionId: option.optionId } }
                    : { outcome: { outcome: "cancelled" } };
            },
        });
        const onAbort = () => {
            if (devinSessionId)
                acp?.cancel(devinSessionId);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        await acp.initialize();
        assertActive();
        let resumed = false;
        if (binding) {
            try {
                await acp.loadSession(binding.devinSessionId, cwd);
                devinSessionId = binding.devinSessionId;
                resumed = true;
                if (model)
                    await acp.setModel(devinSessionId, model).catch(() => undefined);
            }
            catch (error) {
                deps.logger?.warn?.(`devin-cli: could not resume Devin session ${binding.devinSessionId}; starting fresh (${String(error)})`);
            }
        }
        if (!devinSessionId) {
            devinSessionId = await acp.newSession(cwd);
        }
        assertActive();
        deps.bindings.set(input.sessionId, {
            devinSessionId,
            cwd,
            sessionKey,
            updatedAt: Date.now(),
        });
        await acp.setMode(devinSessionId, acpMode).catch(() => undefined);
        assertActive();
        const bootstrap = !resumed
            ? await resolveBootstrapContextForRun({
                workspaceDir: input.workspaceDir,
                config: input.config,
                sessionKey,
                sessionId: input.sessionId,
                agentId,
                chatType: input.chatType,
                contextMode: input.bootstrapContextMode,
                runKind: input.bootstrapContextRunKind,
            })
            : undefined;
        assertActive();
        const built = await resolveAgentHarnessBeforePromptBuildResult({
            prompt: input.prompt,
            currentInboundContext: input.currentInboundContext,
            messages,
            developerInstructions: [
                ...(bootstrap?.contextFiles.map((file) => `${file.path}\n${file.content}`) ?? []),
                input.extraSystemPrompt,
            ]
                .filter(Boolean)
                .join("\n\n"),
            ctx: {
                runId: input.runId,
                agentId,
                sessionId: input.sessionId,
                sessionKey,
                workspaceDir: input.workspaceDir,
                config: input.config,
                trigger: input.trigger,
                modelProviderId: input.provider,
                modelId: input.modelId,
            },
            bootstrapContextRunKind: input.bootstrapContextRunKind,
        });
        assertActive();
        const history = !resumed
            ? renderHistory(messages.filter((_, index) => index < messages.length - 1))
            : "";
        const promptText = [
            !resumed ? built.developerInstructions : undefined,
            history ? `Conversation so far (from OpenClaw):\n${history}` : undefined,
            built.prompt,
        ]
            .filter(Boolean)
            .join("\n\n");
        started = true;
        recorder.markSentToProvider?.();
        input.onExecutionStarted?.();
        const result = await acp.prompt(devinSessionId, promptText, (input.images ?? []).map((image) => ({ data: image.data, mimeType: image.mimeType })));
        for (const tool of tools.values()) {
            if (tool.started && !tool.finished)
                finishTool(tool);
        }
        await chain;
        if (chainError)
            throw chainError;
        assertActive();
        const stopReason = result?.stopReason ?? "end_turn";
        cancelled = stopReason === "cancelled";
        const denied = [...tools.values()].some((tool) => tool.denied);
        const finished = projector.finish({
            stopReason: cancelled ? "aborted" : stopReason === "refusal" ? "error" : "stop",
            usage: usageFrom(result?.usage),
            fallbackText: () => {
                if (denied)
                    return "Devin could not complete this turn because permission was not granted.";
                const summary = summarizeTools(tools.values());
                return summary
                    ? `Devin ended the turn (${stopReason}) without a text reply. Tool activity:\n${summary}`
                    : `Devin ended the turn (${stopReason}) without a text reply.`;
            },
        });
        await writeGroups(finished.groups);
        if (finished.final) {
            let text = finished.finalText;
            if (stopReason === "max_tokens" || stopReason === "max_turn_requests") {
                text = `${text}\n\n[Devin stopped early: ${stopReason}]`;
            }
            const message = {
                ...finished.final.message,
                content: [{ type: "text", text }],
            };
            if (!liveSegmentOpen || text !== liveText) {
                // Tool-only turns and appended notes were never streamed.
                await input.onAssistantMessageStart?.();
                await emit("assistant", { text, delta: text });
            }
            assertActive();
            const written = await appendSessionTranscriptMessageByIdentityStrict({
                ...transcript,
                config: input.config,
                runId: input.runId,
                updateMode: "inline",
                message: { ...message, idempotencyKey: finished.final.key },
                prepareMessageAfterIdempotencyCheck: (candidate) => {
                    input.hostCapabilities.assertActive();
                    return candidate;
                },
            });
            if (written.kind !== "result") {
                throw new Error("Devin assistant transcript was not committed");
            }
            finalAssistant = written.result.message;
            finalKey = finished.final.key;
            terminalAnchor = written.result.anchor;
        }
        assistantTexts = finished.finalText ? [finalAssistantText(finalAssistant) ?? finished.finalText] : [];
        messages = (await SessionManager.openModelContextAsync(transcript, {
            cwd: input.workspaceDir,
            ...(terminalAnchor ? { through: terminalAnchor } : {}),
        })).buildSessionContext().messages;
        if (stopReason === "refusal") {
            failure = new Error(finished.finalText || "Devin refused this request.");
        }
    }
    catch (error) {
        failure = acp?.stderrErrors()
            ? new Error(`${error instanceof Error ? error.message : String(error)}\n${acp.stderrErrors()}`)
            : error;
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            failure = new Error(`devin CLI binary '${deps.command}' not found. Install with: curl -fsSL https://cli.devin.ai/install.sh | bash && devin auth login`);
        }
        messages = await SessionManager.openModelContextAsync(transcript, { cwd: input.workspaceDir })
            .then((context) => context.buildSessionContext().messages)
            .catch(() => messages);
    }
    finally {
        settled = true;
        clearTimeout(timer);
        await acp?.close(devinSessionId).catch(() => undefined);
        if (activeRegistered) {
            clearActiveEmbeddedRun(input.sessionId, activeRun, sessionKey, input.sessionFile);
        }
    }
    const toolCount = toolMetas.length;
    return {
        terminal: timedOut
            ? { kind: "timeout", phase: "prompt", source: "runtime", aborted: true }
            : chainError
                ? { kind: "failed", source: "prompt", error: failure ?? chainError }
                : signal.aborted || cancelled
                    ? { kind: "aborted", source: "external" }
                    : failure
                        ? { kind: "failed", source: "prompt", error: failure }
                        : { kind: "ok" },
        sessionIdUsed: input.sessionId,
        sessionFileUsed: input.sessionFile,
        agentHarnessId: deps.harnessId,
        runtimeModelSelection: { provider: input.provider, model: input.modelId },
        messagesSnapshot: messages,
        assistantTexts,
        lastAssistant: finalAssistant,
        currentAttemptAssistant: finalAssistant,
        ...(finalKey
            ? {
                assistantTranscriptOwned: true,
                assistantTranscriptIdempotencyKey: finalKey,
            }
            : {}),
        toolMetas,
        didSendViaMessagingTool: false,
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [],
        cloudCodeAssistFormatError: false,
        replayMetadata: { hadPotentialSideEffects: toolCount > 0, replaySafe: !started },
        itemLifecycle: {
            startedCount: toolCount,
            completedCount: toolCount,
            activeCount: 0,
        },
    };
}
function finalAssistantText(message) {
    if (!message)
        return undefined;
    const content = message.content;
    if (typeof content === "string")
        return content;
    return content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
}
