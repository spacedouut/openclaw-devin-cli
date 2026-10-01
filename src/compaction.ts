/**
 * OpenClaw `/compact` for Devin sessions: resumes the bound `devin acp`
 * session and runs Devin's own `/compact`, which reports its lifecycle over
 * `_cognition.ai/compaction`.
 */
import type {
  AgentHarnessCompactParams,
  AgentHarnessCompactResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { acpText, DevinAcpProcess, pickPermissionOption, type AcpCompactionEvent } from "./devin-acp.js";
import { writeOpenClawOnlyDevinConfig } from "./devin-config.js";
import type { DevinSessionBindings } from "./session-bindings.js";

const DEFAULT_COMPACTION_TIMEOUT_MS = 10 * 60_000;
/** Devin's `/compact` ends its prompt turn first and compacts afterwards. */
const DEFAULT_START_GRACE_MS = 10_000;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "canceled"]);

export type DevinCompactionDeps = {
  command: string;
  stateDir: string;
  bindings: DevinSessionBindings;
  timeoutMs?: number;
  startGraceMs?: number;
};

function failed(reason: string, code: string, rawError?: string): AgentHarnessCompactResult {
  return {
    ok: false,
    compacted: false,
    reason,
    failure: { reason: code, code, ...(rawError ? { rawError } : {}) },
  };
}

export async function compactDevinSession(
  params: AgentHarnessCompactParams,
  deps: DevinCompactionDeps,
): Promise<AgentHarnessCompactResult> {
  const binding = deps.bindings.get(params.sessionId);
  if (!binding) {
    return { ok: true, compacted: false, reason: "No Devin session is bound to this OpenClaw session yet." };
  }
  if (binding.cwd !== params.workspaceDir) {
    return failed(
      "The bound Devin session belongs to a different workspace.",
      "workspace_mismatch",
    );
  }
  if (params.abortSignal?.aborted) return failed("Compaction was aborted.", "aborted");

  const devinSessionId = binding.devinSessionId;
  let status: string | undefined;
  let summary: string | undefined;
  let error: string | undefined;
  let tokensAfter: number | undefined;
  let text = "";
  let loaded = false;
  let stopped = false;
  const waiters = new Set<() => void>();
  const wake = () => {
    for (const waiter of waiters) waiter();
  };
  const waitUntil = (done: () => boolean, ms?: number) =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (!stopped && !done()) return;
        waiters.delete(check);
        clearTimeout(timer);
        resolve();
      };
      const timer = ms === undefined ? undefined : setTimeout(() => {
        waiters.delete(check);
        resolve();
      }, ms);
      timer?.unref();
      waiters.add(check);
      check();
    });
  const acp = new DevinAcpProcess(
    deps.command,
    { cwd: binding.cwd, configPath: writeOpenClawOnlyDevinConfig({ stateDir: deps.stateDir }) },
    {
      onUpdate: (sessionId, update) => {
        if (!loaded || sessionId !== devinSessionId) return;
        if (update.sessionUpdate === "agent_message_chunk") {
          text += acpText(update.content);
        } else if (update.sessionUpdate === "usage_update" &&
          status !== undefined &&
          typeof update.used === "number") {
          tokensAfter = update.used;
        }
      },
      onPermission: async (request) => {
        const option = pickPermissionOption(request.options, false);
        return option
          ? { outcome: { outcome: "selected", optionId: option.optionId } }
          : { outcome: { outcome: "cancelled" } };
      },
      onCompaction: (event: AcpCompactionEvent) => {
        if (event.sessionId && event.sessionId !== devinSessionId) return;
        status = event.status ?? status;
        summary = event.summary ?? summary;
        error = event.error ?? error;
        wake();
      },
    },
  );
  let timedOut = false;
  const cancel = () => {
    if (loaded) acp.cancel(devinSessionId);
    stopped = true;
    wake();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    cancel();
  }, deps.timeoutMs ?? DEFAULT_COMPACTION_TIMEOUT_MS);
  timer.unref();
  params.abortSignal?.addEventListener("abort", cancel, { once: true });
  let exited = false;
  void acp.exited.then(() => {
    exited = true;
    stopped = true;
    wake();
  });
  try {
    await acp.initialize();
    try {
      await acp.loadSession(devinSessionId, binding.cwd, []);
    } catch (loadError) {
      return failed("Could not resume the bound Devin session.", "resume_failed", String(loadError));
    }
    loaded = true;
    if (params.abortSignal?.aborted) return failed("Compaction was aborted.", "aborted");
    const instructions = params.customInstructions?.trim();
    const result = await acp.prompt(devinSessionId, instructions ? `/compact ${instructions}` : "/compact");
    await waitUntil(() => status !== undefined, deps.startGraceMs ?? DEFAULT_START_GRACE_MS);
    await waitUntil(() => status === undefined || TERMINAL_STATUSES.has(status));
    if (params.abortSignal?.aborted) return failed("Compaction was aborted.", "aborted");
    if (timedOut) return failed("Devin compaction timed out.", "timeout");
    if (exited && status !== "completed") return failed("devin acp exited during compaction.", "devin_exited");
    if (status !== "completed") {
      const detail = error ?? text.trim();
      return failed(
        detail ? `Devin did not compact: ${detail}` : "Devin did not compact the session.",
        status ? `devin_compaction_${status}` : "devin_compaction_not_started",
        result?.stopReason ? `stopReason=${result.stopReason}` : undefined,
      );
    }
    const tokensBefore = binding.contextTokens ?? params.currentTokenCount ?? 0;
    deps.bindings.set(params.sessionId, {
      ...binding,
      ...(tokensAfter !== undefined ? { contextTokens: tokensAfter } : {}),
      updatedAt: Date.now(),
    });
    return {
      ok: true,
      compacted: true,
      compactionKind: "native-harness",
      result: {
        tokensBefore,
        ...(tokensAfter !== undefined ? { tokensAfter } : {}),
        ...(summary ? { summary } : {}),
        details: { devinSessionId },
        sessionId: params.sessionId,
        sessionFile: params.sessionFile,
      },
    };
  } catch (caught) {
    if (params.abortSignal?.aborted) return failed("Compaction was aborted.", "aborted");
    return failed("Devin compaction failed.", "devin_compaction_error", String(caught));
  } finally {
    clearTimeout(timer);
    params.abortSignal?.removeEventListener("abort", cancel);
    await acp.close(loaded ? devinSessionId : undefined).catch(() => undefined);
  }
}
