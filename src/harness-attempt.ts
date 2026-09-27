/**
 * One OpenClaw agent turn executed natively by `devin acp`.
 *
 * The harness owns the transcript: every Devin text run, tool call and tool
 * result is appended as its own typed message while the turn streams, and the
 * matching live `item`/`tool` events are emitted with paired tool-call ids.
 */
import {
  clearActiveEmbeddedRun,
  emitAgentEvent,
  extractMessagingToolSend,
  getPluginToolSideEffectOwnerKey,
  isMessagingToolSendAction,
  projectAgentToolActivity,
  runAgentHarnessAfterCompactionHook,
  runAgentHarnessAfterToolCallHook,
  runAgentHarnessBeforeCompactionHook,
  sanitizeToolResult,
  resolveAgentHarnessBeforePromptBuildResult,
  resolveBootstrapContextForRun,
  setActiveEmbeddedRun,
  type AgentHarnessAttemptParamsV2,
  type AgentHarnessAttemptResult,
  type AgentMessage,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import {
  appendSessionTranscriptMessageByIdentityStrict,
  appendSessionTranscriptMessagesByIdentity,
  publishSessionTranscriptUpdateByIdentity,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { randomUUID } from "node:crypto";
import {
  ACP_MODES,
  acpText,
  DevinAcpProcess,
  pickPermissionOption,
  type AcpMcpServer,
  type AcpPromptResult,
  type AcpSessionUpdate,
} from "./devin-acp.js";
import { writeOpenClawOnlyDevinConfig } from "./devin-config.js";
import { DevinUsageTracker, type DevinUsageRecord } from "./devin-usage.js";
import { resolveDevinTool, type DevinToolIdentity } from "./devin-tool-names.js";
import {
  OPENCLAW_MCP_SERVER_NAME,
  startOpenClawMcpBridge,
  type OpenClawMcpBridge,
  type OpenClawToolCompletion,
} from "./openclaw-mcp-server.js";
import { buildOpenClawTools, DEVIN_OVERLAPPING_TOOLS } from "./openclaw-tools.js";
import type { DevinSessionBindings } from "./session-bindings.js";
import {
  DevinTurnProjector,
  type AssistantMessage,
  type TranscriptWrite,
} from "./turn-projector.js";

/**
 * Which tools a Devin turn gets:
 * - `openclaw`: OpenClaw's tools over MCP; Devin's built-in tools are disabled.
 * - `both`: Devin's built-in tools plus OpenClaw tools that don't duplicate them.
 * - `devin`: Devin's built-in tools only.
 */
export type DevinToolSurface = "openclaw" | "both" | "devin";

export type DevinAttemptDeps = {
  harnessId: string;
  command: string;
  stateDir: string;
  toolSurface: DevinToolSurface;
  bindings: DevinSessionBindings;
  generationSignal: AbortSignal;
  /** Resolves the `devin --model` id for the requested OpenClaw model + thinking level. */
  resolveModel: (input: AgentHarnessAttemptParamsV2) => string | undefined;
  /** Devin CLI permission mode (`smart`, `dangerous`, `accept-edits`, `auto`). */
  resolvePermissionMode: (input: AgentHarnessAttemptParamsV2) => string;
  logger?: { warn?: (message: string) => void };
};

type ToolState = {
  id: string;
  name: string;
  title?: string;
  kind?: string;
  args: Record<string, unknown>;
  status?: string;
  output: string;
  started: boolean;
  finished: boolean;
  denied: boolean;
  /** Served by the OpenClaw MCP bridge; OpenClaw policy governs it. */
  openclaw: boolean;
  /** Devin's own discovery call against the OpenClaw MCP server. */
  hidden: boolean;
  startedAt: number;
};

const TERMINAL_TOOL_STATUS = new Set(["completed", "failed"]);

type QueueMessageOptions = Parameters<Parameters<typeof setActiveEmbeddedRun>[1]["queueMessage"]>[1];

/** Devin interleaves subagent updates on the root stream; only root-agent output belongs to the turn. */
function isRootUpdate(update: AcpSessionUpdate): boolean {
  const parent = asRecord(update._meta?.["cognition.ai/subagent_context"]).parentAgentId;
  return typeof parent !== "string" || parent === "root";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toolNameFor(resolved: Partial<DevinToolIdentity>, update: AcpSessionUpdate, previous?: ToolState): string {
  if (previous?.started) return previous.name;
  if (resolved.openclaw && resolved.name) return resolved.name;
  return previous?.name ?? resolved.name ?? update.kind ?? "tool";
}

function isOpenClawDiscovery(name: string, args: Record<string, unknown>): boolean {
  return (
    (name === "mcp_list_tools" || name === "mcp_read_resource") &&
    args.server_name === OPENCLAW_MCP_SERVER_NAME
  );
}

function openClawToolsNote(surface: DevinToolSurface, toolNames: string[]): string {
  const lines = [
    `OpenClaw tools are served by the \`${OPENCLAW_MCP_SERVER_NAME}\` MCP server: ${toolNames.join(", ")}.`,
    `Load them once with mcp_list_tools (server_name "${OPENCLAW_MCP_SERVER_NAME}"), then call them directly.`,
  ];
  if (surface === "openclaw") {
    lines.push("Devin's built-in shell, file and web tools are disabled in this runtime; use the OpenClaw tools instead.");
  }
  return lines.join("\n");
}

function summarizeTools(tools: Iterable<ToolState>): string {
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

function renderHistory(messages: AgentMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const content = message.content;
    const text =
      typeof content === "string"
        ? content
        : content
            .map((block) => (block.type === "text" ? block.text : ""))
            .filter(Boolean)
            .join("\n");
    if (text.trim()) lines.push(`${message.role}: ${text.trim()}`);
  }
  return lines.join("\n\n");
}

export async function runDevinAttempt(
  input: AgentHarnessAttemptParamsV2,
  deps: DevinAttemptDeps,
): Promise<AgentHarnessAttemptResult> {
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

  let acp: DevinAcpProcess | undefined;
  let devinSessionId: string | undefined;
  let started = false;
  let settled = false;
  let timedOut = false;
  let cancelled = false;
  let failure: unknown;
  let messages: AgentMessage[] = [];
  let finalAssistant: AssistantMessage | undefined;
  let finalKey: string | undefined;
  let terminalAnchor: Record<string, unknown> | undefined;
  let assistantTexts: string[] = [];
  const tools = new Map<string, ToolState>();
  const toolMetas: AgentHarnessAttemptResult["toolMetas"] = [];
  let bridge: OpenClawMcpBridge | undefined;
  const openClawCallIds = new Map<string, string[]>();
  const messagingSentTexts: string[] = [];
  const messagingSentMediaUrls: string[] = [];
  const messagingSentTargets: NonNullable<AgentHarnessAttemptResult["messagingToolSentTargets"]> = [];

  let usage: DevinUsageTracker | undefined;
  let compacting = false;
  // Devin accepts `session/prompt` while a prompt is running and folds it into the active turn.
  let steerable = false;
  const steeringPrompts: Promise<AcpPromptResult>[] = [];
  const canSteer = () => steerable && !settled && !signal.aborted;

  const queueMessage = async (text: string, options?: QueueMessageOptions) => {
    let acceptanceReported = false;
    const reportAcceptance = (accepted: boolean) => {
      if (acceptanceReported) return;
      acceptanceReported = true;
      options?.onQueueAccepted?.(accepted);
    };
    try {
      if (!canSteer() || !acp || !devinSessionId) {
        throw new Error("Devin steering is unavailable outside an active prompt");
      }
      options?.abortSignal?.throwIfAborted();
      const steerRecorder = options?.userTurnTranscriptRecorder;
      if (steerRecorder) {
        await steerRecorder.persistApproved({ expectedSessionId: input.sessionId });
        if (steerRecorder.isBlocked() || !steerRecorder.hasPersisted()) {
          throw new Error("Devin steering input was not admitted to its transcript");
        }
      }
      if (!canSteer()) {
        throw new Error("Devin steering is unavailable after the active prompt ended");
      }
      steerRecorder?.markSentToProvider?.();
      const prompt = acp.prompt(
        devinSessionId,
        text,
        (options?.images ?? []).map((image) => ({ data: image.data, mimeType: image.mimeType })),
      );
      prompt.catch(() => undefined);
      steeringPrompts.push(prompt);
      reportAcceptance(true);
    } catch (error) {
      reportAcceptance(false);
      throw error;
    }
  };

  const activeRun = {
    kind: "embedded" as const,
    runId: input.runId,
    toolAuthorityFingerprint: input.toolAuthorityFingerprint,
    supportsQueueMessageImages: true,
    supportsTranscriptCommitWait: true,
    messageInjection: { isAvailable: canSteer, queueMessage },
    queueMessage,
    isStreaming: () => started && !settled,
    isAborted: () => signal.aborted,
    isCompacting: () => compacting,
    cancel: () => controller.abort(),
    abort: () => controller.abort(),
    sourceReplyDeliveryMode: input.sourceReplyDeliveryMode,
  };
  let activeRegistered = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // Serialize every live event and transcript write so they keep ACP order.
  let chain: Promise<void> = Promise.resolve();
  let chainError: unknown;
  const enqueue = (work: () => Promise<void> | void) => {
    chain = chain.then(async () => {
      if (chainError) return;
      try {
        await work();
      } catch (error) {
        chainError ??= error;
        controller.abort();
      }
    });
  };

  const emit = async (stream: string, data: Record<string, unknown>) => {
    emitAgentEvent({ runId: input.runId, sessionKey, sessionId: input.sessionId, stream, data });
    await input.onAgentEvent?.({ stream, data });
  };

  let projector: DevinTurnProjector | undefined;
  let liveText = "";
  let liveSegmentOpen = false;
  let liveSegment = 0;
  const liveItemId = () => `${input.runId}:devin-text:${liveSegment}`;

  const closeLiveSegment = async () => {
    if (!liveSegmentOpen) return;
    liveSegmentOpen = false;
    const progressText = liveText.replace(/\s+/gu, " ").trim();
    if (!progressText) return;
    await emit("item", {
      itemId: liveItemId(),
      kind: "preamble",
      title: "Preamble",
      phase: "end",
      progressText,
      source: "devin-cli",
    });
  };

  let reasoningText = "";
  const endReasoning = async () => {
    if (!reasoningText) return;
    reasoningText = "";
    await input.onReasoningEnd?.();
  };

  const onThinking = (delta: string) => {
    if (!delta) return;
    enqueue(async () => {
      reasoningText += delta;
      projector?.thinking(delta);
      await emit("thinking", { text: reasoningText, delta });
      assertActive();
      await input.onReasoningStream?.({ text: reasoningText, isReasoningSnapshot: true });
    });
  };

  const onCompacted = async (compacted: NonNullable<DevinUsageRecord["compacted"]>) => {
    compacting = true;
    const itemId = `${input.runId}:devin-compaction:${usage?.compactions ?? 0}`;
    const hookCtx = { runId: input.runId, agentId, sessionId: input.sessionId, sessionKey, config: input.config };
    try {
      await runAgentHarnessBeforeCompactionHook({ sessionFile: input.sessionFile, messages, ctx: hookCtx });
      await emit("compaction", { phase: "start", backend: "devin-cli", itemId });
      await runAgentHarnessAfterCompactionHook({
        sessionFile: input.sessionFile,
        messages,
        compactedCount: -1,
        ctx: hookCtx,
      });
      await emit("compaction", {
        phase: "end",
        backend: "devin-cli",
        itemId,
        completed: true,
        willRetry: false,
        tokensBefore: compacted.tokensBefore,
        tokensAfter: compacted.tokensAfter,
      });
    } finally {
      compacting = false;
    }
  };

  const onUsage = (update: AcpSessionUpdate) => {
    const recorded = usage?.record(update);
    if (!recorded) return;
    enqueue(async () => {
      if (recorded.compacted) await onCompacted(recorded.compacted);
      await emit("usage", recorded.snapshot);
      if (recorded.outputTokens > 0) input.hostCapabilities.reportOutputTokens?.(recorded.outputTokens);
    });
  };

  const writeGroups = async (groups: TranscriptWrite[][]) => {
    for (const group of groups) {
      assertActive();
      await appendSessionTranscriptMessagesByIdentity({
        ...transcript,
        config: input.config,
        cwd: input.workspaceDir,
        messages: group.map((write) => ({
          message: { ...write.message, idempotencyKey: write.key },
          idempotencyLookup: "scan" as const,
          beforeFreshMessageCommit: () => input.hostCapabilities.assertActive(),
        })),
      });
      await publishSessionTranscriptUpdateByIdentity(transcript).catch(() => undefined);
    }
  };

  const onText = (delta: string) => {
    enqueue(async () => {
      await endReasoning();
      if (!liveSegmentOpen) {
        liveSegmentOpen = true;
        liveSegment += 1;
        liveText = "";
        await input.onAssistantMessageStart?.();
        assertActive();
      }
      liveText += delta;
      projector?.text(delta, liveItemId());
      await emit("assistant", { itemId: liveItemId(), text: liveText, delta });
      assertActive();
      await input.onPartialReply?.({ text: liveText });
    });
  };

  const onToolUpdate = (update: AcpSessionUpdate) => {
    const id = update.toolCallId;
    if (!id) return;
    const previous = tools.get(id);
    const output = update.sessionUpdate === "tool_call_update" ? acpText(update.content) : "";
    const resolved = resolveDevinTool(update);
    const name = toolNameFor(resolved, update, previous);
    const openclaw = previous?.openclaw || (!previous?.started && Boolean(resolved.openclaw));
    const args = resolved.args ?? previous?.args ?? {};
    if (openclaw && !previous?.openclaw) {
      openClawCallIds.set(name, [...(openClawCallIds.get(name) ?? []), id]);
    }
    const next: ToolState = {
      id,
      name,
      title: openclaw ? undefined : (resolved.title ?? previous?.title),
      kind: update.kind ?? previous?.kind,
      args,
      status: update.status ?? previous?.status,
      output: output || previous?.output || "",
      started: previous?.started ?? false,
      finished: previous?.finished ?? false,
      denied: previous?.denied ?? false,
      openclaw,
      hidden: previous?.hidden || (!previous?.started && isOpenClawDiscovery(name, args)),
      startedAt: previous?.startedAt ?? Date.now(),
    };
    tools.set(id, next);
    if (next.hidden) return;
    const ready =
      Boolean(update.status) ||
      (update.sessionUpdate === "tool_call" && Object.keys(next.args).length > 0);
    if (!next.started && ready) {
      next.started = true;
      const args = { ...(next.title ? { title: next.title } : {}), ...next.args };
      enqueue(async () => {
        await endReasoning();
        await closeLiveSegment();
        projector?.toolStart({ id, name: next.name, args });
        const toolData = { phase: "start" as const, name: next.name, toolCallId: id, args };
        await emit("item", projectAgentToolActivity(toolData) as Record<string, unknown>);
        await emit("tool", toolData);
      });
    }
    if (next.started && !next.finished && next.status && TERMINAL_TOOL_STATUS.has(next.status)) {
      finishTool(next);
    }
  };

  const finishTool = (tool: ToolState) => {
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
        phase: "result" as const,
        name: tool.name,
        toolCallId: tool.id,
        args,
        isError,
        result: { content: [{ type: "text", text: output }] },
      };
      await emit("tool", toolData);
      await emit(
        "item",
        projectAgentToolActivity({
          ...toolData,
          status: isError ? "failed" : "completed",
        }) as Record<string, unknown>,
      );
      await input.onToolResult?.({ text: output });
      await writeGroups(projector?.takeReadyGroups() ?? []);
    });
  };

  const claimToolCallId = (toolName: string) => {
    const queued = openClawCallIds.get(toolName);
    return queued?.shift() ?? `${input.runId}:openclaw-tool:${randomUUID()}`;
  };

  const onOpenClawToolCompleted = async (completion: OpenClawToolCompletion) => {
    const { tool, toolCallId, args, isError, error } = completion;
    const ownerKey = getPluginToolSideEffectOwnerKey(tool);
    input.observeToolTerminal?.({
      toolCallId,
      toolName: tool.name,
      result: completion.result ?? error,
      arguments: args,
      executionStarted: true,
      outcome: isError ? "failure" : "success",
      ...(isError ? { failure: { error: error ?? "tool returned an error" } } : {}),
      ...(ownerKey ? { ownerMutation: { ownerKey } } : {}),
    });
    try {
      input.onAgentToolResult?.({
        toolName: tool.name,
        result: sanitizeToolResult(completion.result ?? { content: [{ type: "text", text: error ?? "" }] }),
        isError,
      });
    } catch (callbackError) {
      deps.logger?.warn?.(`devin-cli: onAgentToolResult failed (${String(callbackError)})`);
    }
    if (!isError && isMessagingToolSendAction(tool.name, args)) {
      const send = extractMessagingToolSend(tool.name, args, {
        config: input.config,
        currentChannelId: input.currentChannelId,
        currentMessagingTarget: input.currentMessagingTarget,
        currentThreadId: input.currentThreadTs,
        currentMessageId: input.currentMessageId,
        replyToMode: input.replyToMode,
        hasRepliedRef: input.hasRepliedRef,
      });
      if (send) {
        if (send.text) messagingSentTexts.push(send.text);
        if (send.mediaUrls) messagingSentMediaUrls.push(...send.mediaUrls);
        messagingSentTargets.push(send);
      }
    }
    await runAgentHarnessAfterToolCallHook({
      toolName: tool.name,
      toolCallId,
      runId: input.runId,
      agentId,
      sessionId: input.sessionId,
      sessionKey,
      startArgs: args,
      ...(completion.result !== undefined ? { result: completion.result } : {}),
      ...(error ? { error } : {}),
      startedAt: completion.startedAt,
    }).catch((hookError: unknown) => {
      deps.logger?.warn?.(`devin-cli: after_tool_call hook failed (${String(hookError)})`);
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

    const stored = deps.bindings.get(input.sessionId);
    const binding = stored?.cwd === input.workspaceDir ? stored : undefined;
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
    projector = new DevinTurnProjector({ modelRef, keyPrefix: requestId, runId: input.runId });

    const cwd = input.workspaceDir;
    const mcpServers: AcpMcpServer[] = [];
    if (deps.toolSurface !== "devin") {
      const openClawTools = buildOpenClawTools(input, {
        agentId,
        ...(deps.toolSurface === "both" ? { exclude: DEVIN_OVERLAPPING_TOOLS } : {}),
      });
      if (openClawTools.length > 0) {
        bridge = await startOpenClawMcpBridge({
          tools: openClawTools,
          signal,
          claimToolCallId,
          onCompleted: onOpenClawToolCompleted,
        });
        mcpServers.push(bridge.server);
      }
      assertActive();
    }
    const configPath =
      deps.toolSurface === "openclaw" ? writeOpenClawOnlyDevinConfig({ stateDir: deps.stateDir }) : undefined;
    acp = new DevinAcpProcess(
      deps.command,
      { cwd, model, configPath },
      {
        onUpdate: (sessionId, update) => {
          if (!started || sessionId !== devinSessionId || signal.aborted) return;
          switch (update.sessionUpdate) {
            case "agent_message_chunk":
              if (isRootUpdate(update)) onText(acpText(update.content));
              break;
            case "agent_thought_chunk":
              if (isRootUpdate(update)) onThinking(acpText(update.content));
              break;
            case "usage_update":
              if (isRootUpdate(update)) onUsage(update);
              break;
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
          if (id && tools.get(id)?.openclaw) {
            const option = pickPermissionOption(request.options, true);
            if (option) return { outcome: { outcome: "selected", optionId: option.optionId } };
          }
          if (id && !allowPermissions) {
            const tool = tools.get(id);
            if (tool) tool.denied = true;
          }
          const option = pickPermissionOption(request.options, allowPermissions);
          return option
            ? { outcome: { outcome: "selected", optionId: option.optionId } }
            : { outcome: { outcome: "cancelled" } };
        },
      },
    );
    const onAbort = () => {
      if (devinSessionId) acp?.cancel(devinSessionId);
    };
    signal.addEventListener("abort", onAbort, { once: true });

    await acp.initialize();
    assertActive();
    let resumed = false;
    if (binding) {
      try {
        await acp.loadSession(binding.devinSessionId, cwd, mcpServers);
        devinSessionId = binding.devinSessionId;
        resumed = true;
        if (model) await acp.setModel(devinSessionId, model).catch(() => undefined);
      } catch (error) {
        deps.logger?.warn?.(
          `devin-cli: could not resume Devin session ${binding.devinSessionId}; starting fresh (${String(error)})`,
        );
      }
    }
    if (!devinSessionId) {
      devinSessionId = await acp.newSession(cwd, mcpServers);
    }
    assertActive();
    usage = new DevinUsageTracker(resumed ? binding?.contextTokens : undefined);
    deps.bindings.set(input.sessionId, {
      devinSessionId,
      cwd,
      sessionKey,
      ...(resumed && binding?.contextTokens !== undefined ? { contextTokens: binding.contextTokens } : {}),
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
        bridge ? openClawToolsNote(deps.toolSurface, bridge.toolNames) : undefined,
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
    steerable = true;
    let result: AcpPromptResult;
    try {
      result = await acp.prompt(
        devinSessionId,
        promptText,
        (input.images ?? []).map((image) => ({ data: image.data, mimeType: image.mimeType })),
      );
    } finally {
      steerable = false;
    }
    for (let index = 0; index < steeringPrompts.length; index += 1) {
      const steered = await steeringPrompts[index]!.catch(() => undefined);
      if (steered?.stopReason) result = steered;
    }
    for (const tool of tools.values()) {
      if (tool.started && !tool.finished) finishTool(tool);
    }
    await chain;
    if (chainError) throw chainError;
    await endReasoning();
    assertActive();

    const stopReason = result?.stopReason ?? "end_turn";
    cancelled = stopReason === "cancelled";
    const denied = [...tools.values()].some((tool) => tool.denied);
    const finished = projector.finish({
      stopReason: cancelled ? "aborted" : stopReason === "refusal" ? "error" : "stop",
      usage: usage.turnUsage(result?.usage),
      fallbackText: () => {
        if (denied) return "Devin could not complete this turn because permission was not granted.";
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
        content: finished.final.message.content.map((block) =>
          block.type === "text" ? { ...block, text } : block,
        ),
      } as AssistantMessage;
      if (!liveSegmentOpen || text !== liveText) {
        // Tool-only turns and appended notes were never streamed.
        if (!liveSegmentOpen) liveSegment += 1;
        await input.onAssistantMessageStart?.();
        await emit("assistant", { itemId: liveItemId(), text, delta: liveSegmentOpen ? "" : text });
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
      finalAssistant = written.result.message as AssistantMessage;
      finalKey = finished.final.key;
      terminalAnchor = written.result.anchor;
    }
    assistantTexts = finished.finalText ? [finalAssistantText(finalAssistant) ?? finished.finalText] : [];
    messages = (
      await SessionManager.openModelContextAsync(transcript, {
        cwd: input.workspaceDir,
        ...(terminalAnchor ? { through: terminalAnchor } : {}),
      })
    ).buildSessionContext().messages;
    if (usage.contextTokens !== undefined) {
      deps.bindings.set(input.sessionId, {
        devinSessionId,
        cwd,
        sessionKey,
        contextTokens: usage.contextTokens,
        updatedAt: Date.now(),
      });
    }
    if (stopReason === "refusal") {
      failure = new Error(finished.finalText || "Devin refused this request.");
    }
  } catch (error) {
    failure = acp?.stderrErrors()
      ? new Error(`${error instanceof Error ? error.message : String(error)}\n${acp.stderrErrors()}`)
      : error;
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      failure = new Error(
        `devin CLI binary '${deps.command}' not found. Install with: curl -fsSL https://cli.devin.ai/install.sh | bash && devin auth login`,
      );
    }
    messages = await SessionManager.openModelContextAsync(transcript, { cwd: input.workspaceDir })
      .then((context) => context.buildSessionContext().messages)
      .catch(() => messages);
  } finally {
    settled = true;
    steerable = false;
    compacting = false;
    clearTimeout(timer);
    await acp?.close(devinSessionId).catch(() => undefined);
    await bridge?.close().catch(() => undefined);
    if (activeRegistered) {
      clearActiveEmbeddedRun(input.sessionId, activeRun, sessionKey, input.sessionFile);
    }
  }

  const toolCount = toolMetas.length;
  const turnUsage = finalAssistant?.usage as ReturnType<DevinUsageTracker["turnUsage"]> | undefined;
  const attemptUsage = turnUsage
    ? {
        input: turnUsage.input,
        output: turnUsage.output,
        cacheRead: turnUsage.cacheRead,
        cacheWrite: turnUsage.cacheWrite,
        total: turnUsage.totalTokens,
        ...(turnUsage.contextUsage
          ? {
              contextUsage:
                signal.aborted || cancelled ? ({ state: "unavailable" } as const) : turnUsage.contextUsage,
            }
          : {}),
      }
    : undefined;
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
    didSendViaMessagingTool: messagingSentTargets.length > 0,
    messagingToolSentTexts: messagingSentTexts,
    messagingToolSentMediaUrls: messagingSentMediaUrls,
    messagingToolSentTargets: messagingSentTargets,
    cloudCodeAssistFormatError: false,
    ...(attemptUsage ? { attemptUsage } : {}),
    ...(usage?.contextWindow ? { contextTokens: usage.contextWindow, contextTokensSource: "runtime" } : {}),
    ...(usage && usage.compactions > 0 ? { compactionCount: usage.compactions } : {}),
    replayMetadata: { hadPotentialSideEffects: toolCount > 0, replaySafe: !started },
    itemLifecycle: {
      startedCount: toolCount,
      completedCount: toolCount,
      activeCount: 0,
    },
  } as AgentHarnessAttemptResult;
}

function finalAssistantText(message: AssistantMessage | undefined): string | undefined {
  if (!message) return undefined;
  const content = message.content;
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}
