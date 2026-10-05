import { usageFrom } from "./turn-projector.js";
const COMPACTION_MIN_DROP_TOKENS = 4_000;
const COMPACTION_MIN_DROP_RATIO = 0.4;
function count(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}
export class DevinUsageTracker {
    calls = [];
    lastSignature;
    used;
    size;
    promptTokens;
    compactions = 0;
    constructor(previousContextTokens) {
        this.used = previousContextTokens;
    }
    get contextWindow() {
        return this.size;
    }
    get contextTokens() {
        return this.used;
    }
    record(update) {
        const used = count(update.used);
        if (used === undefined)
            return undefined;
        const meta = update._meta ?? {};
        const call = {
            inputTokens: count(meta["cognition.ai/inputTokens"]),
            outputTokens: count(meta["cognition.ai/outputTokens"]),
            cachedReadTokens: count(meta["cognition.ai/cachedReadTokens"]),
            cachedWriteTokens: count(meta["cognition.ai/cachedWriteTokens"]),
        };
        const size = count(update.size);
        // Devin repeats a call's usage once per agent scope; count each call once.
        const signature = JSON.stringify([used, size, call]);
        if (signature === this.lastSignature)
            return undefined;
        this.lastSignature = signature;
        const before = this.used;
        const compacted = before !== undefined &&
            before - used >= COMPACTION_MIN_DROP_TOKENS &&
            used <= before * (1 - COMPACTION_MIN_DROP_RATIO)
            ? { tokensBefore: before, tokensAfter: used }
            : undefined;
        if (compacted)
            this.compactions += 1;
        this.used = used;
        if (size && size > 0)
            this.size = size;
        if (call.inputTokens !== undefined)
            this.promptTokens = call.inputTokens;
        this.calls.push(call);
        return {
            snapshot: {
                activeContextTokens: used,
                ...(this.size ? { modelContextWindow: this.size } : {}),
                ...(call.inputTokens !== undefined ? { inputTokens: call.inputTokens, promptTokens: call.inputTokens } : {}),
                ...(call.cachedReadTokens !== undefined ? { cachedInputTokens: call.cachedReadTokens } : {}),
                ...(call.outputTokens !== undefined ? { outputTokens: call.outputTokens } : {}),
            },
            outputTokens: call.outputTokens ?? 0,
            compacted,
        };
    }
    /** Billing usage summed over the turn's model calls, with the latest context snapshot. */
    turnUsage(result) {
        const calls = this.calls.length > 0 ? this.calls : result ? [result] : [];
        const sum = (key) => calls.reduce((total, call) => total + (call[key] ?? 0), 0);
        const usage = usageFrom({
            inputTokens: sum("inputTokens"),
            outputTokens: sum("outputTokens"),
            cachedReadTokens: sum("cachedReadTokens"),
            cachedWriteTokens: sum("cachedWriteTokens"),
        });
        const promptTokens = this.calls.length > 0 ? this.promptTokens : result?.inputTokens;
        const totalTokens = this.calls.length > 0 ? this.used : result?.totalTokens;
        return {
            ...usage,
            contextUsage: promptTokens !== undefined && totalTokens !== undefined
                ? { state: "available", promptTokens, totalTokens }
                : { state: "unavailable" },
        };
    }
}
