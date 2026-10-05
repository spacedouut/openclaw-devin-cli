/**
 * Projects one Devin ACP turn into OpenClaw transcript messages.
 *
 * Each text run and the tool calls that follow it become one assistant
 * message (`stopReason: "toolUse"`), followed by one `toolResult` message per
 * call, so the persisted transcript keeps Devin's real order:
 * text -> tool call -> tool result -> text. Groups are released only once all
 * of their results arrived, so every persisted tool call has its result.
 */
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";

export type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
export type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;
export type TranscriptWrite = { key: string; message: AssistantMessage | ToolResultMessage };

export type ModelRef = { provider: string; model: string; api: string };

type ToolCall = { id: string; name: string; args: Record<string, unknown> };
type Segment = {
  thinking: string;
  text: string;
  itemId?: string;
  startedAt?: number;
  tools: ToolCall[];
  results: Map<string, ToolResultMessage>;
};

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export type TurnUsage = typeof ZERO_USAGE & {
  contextUsage?: { state: "available"; promptTokens: number; totalTokens: number } | { state: "unavailable" };
};

/** Devin's `inputTokens` include cached input; OpenClaw counts uncached input separately. */
export function usageFrom(usage?: {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  totalTokens?: number;
}): TurnUsage {
  const promptTokens = usage?.inputTokens ?? 0;
  const output = usage?.outputTokens ?? 0;
  const cacheRead = usage?.cachedReadTokens ?? 0;
  const cacheWrite = usage?.cachedWriteTokens ?? 0;
  return {
    ...ZERO_USAGE,
    input: Math.max(0, promptTokens - cacheRead - cacheWrite),
    output,
    cacheRead,
    cacheWrite,
    totalTokens: usage?.totalTokens ?? promptTokens + output,
    cost: { ...ZERO_USAGE.cost },
  };
}

export class DevinTurnProjector {
  private current: Segment = newSegment();
  private deferredThinking = "";
  private deferredText = "";
  private deferredItemId: string | undefined;
  private deferredStartedAt: number | undefined;
  private readonly ready: TranscriptWrite[][] = [];
  private groupSeq = 0;
  private readonly segmentTexts: string[] = [];

  constructor(
    private readonly params: {
      modelRef: ModelRef;
      keyPrefix: string;
      runId?: string;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.params.now?.() ?? Date.now();
  }

  /**
   * Appends streamed assistant text to the open segment. `itemId` is the live
   * item the text was streamed under, so history can replace that live item.
   */
  text(delta: string, itemId?: string): void {
    if (!delta) return;
    if (this.current.tools.length > 0) {
      this.deferredText += delta;
      this.deferredItemId ??= itemId;
      this.deferredStartedAt ??= this.now();
    } else {
      this.current.text += delta;
      this.current.itemId ??= itemId;
      this.current.startedAt ??= this.now();
    }
  }

  /** Appends Devin reasoning to the segment that its following text/tools belong to. */
  thinking(delta: string): void {
    if (!delta) return;
    if (this.current.tools.length > 0) {
      this.deferredThinking += delta;
      this.deferredStartedAt ??= this.now();
    } else {
      this.current.thinking += delta;
      this.current.startedAt ??= this.now();
    }
  }

  private withRun<T extends AssistantMessage | ToolResultMessage>(message: T): T {
    const { runId } = this.params;
    return (runId ? { ...message, __openclaw: { runId } } : message) as T;
  }

  toolStart(call: ToolCall): void {
    if (this.current.tools.some((tool) => tool.id === call.id)) return;
    this.current.startedAt ??= this.now();
    this.current.tools.push(call);
  }

  toolEnd(result: { id: string; name: string; output: string; isError: boolean }): void {
    if (!this.current.tools.some((tool) => tool.id === result.id)) return;
    this.current.results.set(result.id, {
      role: "toolResult",
      toolCallId: result.id,
      toolName: result.name,
      content: [{ type: "text", text: result.output }],
      isError: result.isError,
      timestamp: this.now(),
    } as ToolResultMessage);
    if (this.current.tools.every((tool) => this.current.results.has(tool.id))) {
      this.flushGroup();
    }
  }

  private flushGroup(): void {
    const segment = this.current;
    const seq = ++this.groupSeq;
    const { modelRef, keyPrefix } = this.params;
    const content: AssistantMessage["content"] = [];
    if (segment.thinking) content.push({ type: "thinking", thinking: segment.thinking });
    if (segment.text) {
      content.push({
        type: "text",
        text: segment.text,
        ...(segment.itemId
          ? { textSignature: JSON.stringify({ v: 1, id: segment.itemId, phase: "commentary" }) }
          : {}),
      });
      this.segmentTexts.push(segment.text);
    }
    for (const tool of segment.tools) {
      content.push({ type: "toolCall", id: tool.id, name: tool.name, arguments: tool.args });
    }
    const assistant = {
      role: "assistant",
      provider: modelRef.provider,
      model: modelRef.model,
      api: modelRef.api,
      content,
      stopReason: "toolUse",
      timestamp: segment.startedAt ?? this.now(),
      usage: usageFrom(),
    } as AssistantMessage;
    this.ready.push([
      { key: `${keyPrefix}:devin:group:${seq}:assistant`, message: this.withRun(assistant) },
      ...segment.tools.map((tool) => ({
        key: `${keyPrefix}:devin:tool:${tool.id}`,
        message: this.withRun(segment.results.get(tool.id)!),
      })),
    ]);
    this.current = newSegment(
      this.deferredText,
      this.deferredItemId,
      this.deferredStartedAt,
      this.deferredThinking,
    );
    this.deferredThinking = "";
    this.deferredText = "";
    this.deferredItemId = undefined;
    this.deferredStartedAt = undefined;
  }

  /** Completed assistant/tool-result groups not yet handed to the writer. */
  takeReadyGroups(): TranscriptWrite[][] {
    return this.ready.splice(0, this.ready.length);
  }

  /** Tool calls still waiting for a result. */
  pendingTools(): ToolCall[] {
    return this.current.tools.filter((tool) => !this.current.results.has(tool.id));
  }

  /**
   * Closes the turn: unresolved tools get synthetic failed results, and the
   * trailing text becomes the final assistant message.
   */
  finish(params: {
    stopReason: "stop" | "aborted" | "error";
    usage: TurnUsage;
    fallbackText?: (tools: { unresolved: number }) => string | undefined;
  }): { groups: TranscriptWrite[][]; final: TranscriptWrite | undefined; finalText: string } {
    for (const tool of this.pendingTools()) {
      this.toolEnd({ id: tool.id, name: tool.name, output: "tool did not report a result", isError: true });
    }
    let text = this.current.text + this.deferredText;
    const thinking = this.current.thinking + this.deferredThinking;
    if (!text.trim()) {
      text = params.fallbackText?.({ unresolved: 0 }) ?? "";
    }
    const groups = this.takeReadyGroups();
    if (!text) {
      return { groups, final: undefined, finalText: "" };
    }
    this.segmentTexts.push(text);
    const { modelRef, keyPrefix } = this.params;
    const message = {
      role: "assistant",
      provider: modelRef.provider,
      model: modelRef.model,
      api: modelRef.api,
      content: [...(thinking ? [{ type: "thinking", thinking }] : []), { type: "text", text }],
      stopReason: params.stopReason,
      timestamp: this.now(),
      usage: params.usage,
    } as AssistantMessage;
    return { groups, final: { key: `${keyPrefix}:devin:final`, message }, finalText: text };
  }

  texts(): string[] {
    return [...this.segmentTexts];
  }
}

function newSegment(text = "", itemId?: string, startedAt?: number, thinking = ""): Segment {
  return {
    thinking,
    text,
    ...(itemId ? { itemId } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    tools: [],
    results: new Map(),
  };
}
