const ZERO_USAGE = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
export function usageFrom(usage) {
    const input = usage?.inputTokens ?? 0;
    const output = usage?.outputTokens ?? 0;
    const cacheRead = usage?.cachedReadTokens ?? 0;
    const cacheWrite = usage?.cachedWriteTokens ?? 0;
    return {
        ...ZERO_USAGE,
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens: usage?.totalTokens ?? input + output + cacheRead + cacheWrite,
        cost: { ...ZERO_USAGE.cost },
    };
}
export class DevinTurnProjector {
    params;
    current = newSegment();
    deferredText = "";
    deferredItemId;
    deferredStartedAt;
    ready = [];
    groupSeq = 0;
    segmentTexts = [];
    constructor(params) {
        this.params = params;
    }
    now() {
        return this.params.now?.() ?? Date.now();
    }
    /**
     * Appends streamed assistant text to the open segment. `itemId` is the live
     * item the text was streamed under, so history can replace that live item.
     */
    text(delta, itemId) {
        if (!delta)
            return;
        if (this.current.tools.length > 0) {
            this.deferredText += delta;
            this.deferredItemId ??= itemId;
            this.deferredStartedAt ??= this.now();
        }
        else {
            this.current.text += delta;
            this.current.itemId ??= itemId;
            this.current.startedAt ??= this.now();
        }
    }
    withRun(message) {
        const { runId } = this.params;
        return (runId ? { ...message, __openclaw: { runId } } : message);
    }
    toolStart(call) {
        if (this.current.tools.some((tool) => tool.id === call.id))
            return;
        this.current.startedAt ??= this.now();
        this.current.tools.push(call);
    }
    toolEnd(result) {
        if (!this.current.tools.some((tool) => tool.id === result.id))
            return;
        this.current.results.set(result.id, {
            role: "toolResult",
            toolCallId: result.id,
            toolName: result.name,
            content: [{ type: "text", text: result.output }],
            isError: result.isError,
            timestamp: this.now(),
        });
        if (this.current.tools.every((tool) => this.current.results.has(tool.id))) {
            this.flushGroup();
        }
    }
    flushGroup() {
        const segment = this.current;
        const seq = ++this.groupSeq;
        const { modelRef, keyPrefix } = this.params;
        const content = [];
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
        };
        this.ready.push([
            { key: `${keyPrefix}:devin:group:${seq}:assistant`, message: this.withRun(assistant) },
            ...segment.tools.map((tool) => ({
                key: `${keyPrefix}:devin:tool:${tool.id}`,
                message: this.withRun(segment.results.get(tool.id)),
            })),
        ]);
        this.current = newSegment(this.deferredText, this.deferredItemId, this.deferredStartedAt);
        this.deferredText = "";
        this.deferredItemId = undefined;
        this.deferredStartedAt = undefined;
    }
    /** Completed assistant/tool-result groups not yet handed to the writer. */
    takeReadyGroups() {
        return this.ready.splice(0, this.ready.length);
    }
    /** Tool calls still waiting for a result. */
    pendingTools() {
        return this.current.tools.filter((tool) => !this.current.results.has(tool.id));
    }
    /**
     * Closes the turn: unresolved tools get synthetic failed results, and the
     * trailing text becomes the final assistant message.
     */
    finish(params) {
        for (const tool of this.pendingTools()) {
            this.toolEnd({ id: tool.id, name: tool.name, output: "tool did not report a result", isError: true });
        }
        let text = this.current.text + this.deferredText;
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
            content: [{ type: "text", text }],
            stopReason: params.stopReason,
            timestamp: this.now(),
            usage: params.usage,
        };
        return { groups, final: { key: `${keyPrefix}:devin:final`, message }, finalText: text };
    }
    texts() {
        return [...this.segmentTexts];
    }
}
function newSegment(text = "", itemId, startedAt) {
    return {
        text,
        ...(itemId ? { itemId } : {}),
        ...(startedAt !== undefined ? { startedAt } : {}),
        tools: [],
        results: new Map(),
    };
}
