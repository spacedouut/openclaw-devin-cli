/**
 * Devin CLI agent harness: claims `devin-cli/<model>` routes and runs each
 * turn natively through `devin acp`, owning the OpenClaw transcript mirror.
 */
import {
  AgentHarnessPreflightError,
  type AgentHarnessAttemptParamsV2,
  type AgentHarnessResetParams,
  type AgentHarnessSessionDeletionParams,
  type AgentHarnessSessionDeletionMutation,
  type AgentHarnessV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { compactDevinSession } from "./compaction.js";
import { fetchDevinUsageForContext } from "./devin-quota.js";
import { runDevinAttempt, type DevinAttemptDeps, type DevinToolSurface } from "./harness-attempt.js";
import { runDevinIsolatedCompletion, type IsolatedCompletionParams } from "./isolated-completion.js";
import { DevinSessionBindings } from "./session-bindings.js";
import { WarmDevinSessions } from "./warm-sessions.js";

export const HARNESS_ID = "devin-cli";
const DEFAULT_KEEP_ALIVE_MS = 120_000;

/**
 * Exact tool policy holds only in `openclaw` tool mode: Devin's built-in tools
 * are off and every tool comes from OpenClaw's own policy-filtered surface.
 */
export function assertToolPolicyEnforceable(input: AgentHarnessAttemptParamsV2, toolSurface: DevinToolSurface): void {
  if (toolSurface === "openclaw") return;
  if (!input.pluginHarnessToolPolicyRestricted && !input.disableTools) return;
  const message =
    `Devin CLI keeps its own tools in tools: "${toolSurface}" mode and cannot enforce this chat's tool restrictions. ` +
    `Set the devin-cli plugin's tools option to "openclaw" or update the tool settings.`;
  throw new AgentHarnessPreflightError(message, { scope: "harness", userMessage: message });
}

export function createDevinHarness(params: {
  providerId: string;
  stateDir: () => string;
  command: () => string;
  resolveModel: DevinAttemptDeps["resolveModel"];
  resolvePermissionMode: DevinAttemptDeps["resolvePermissionMode"];
  resolveToolSurface: (input: Parameters<DevinAttemptDeps["resolveModel"]>[0]) => DevinToolSurface;
  resolveIsolatedModel: (input: IsolatedCompletionParams) => string;
  /** How long a finished turn's `devin acp` stays up for the next turn (ms, 0 = off). */
  keepAliveMs?: () => number | undefined;
  logger?: DevinAttemptDeps["logger"];
}): AgentHarnessV2 {
  const generation = new AbortController();
  let bindings: DevinSessionBindings | undefined;
  const store = () => (bindings ??= new DevinSessionBindings(params.stateDir()));
  const warm = new WarmDevinSessions(() => params.keepAliveMs?.() ?? DEFAULT_KEEP_ALIVE_MS);

  return {
    id: HARNESS_ID,
    label: "Devin CLI",
    autoSelection: { providerIds: [params.providerId] },
    authBootstrap: "harness",
    executionEnvironment: "host-only",
    conversationToolPolicySupport: "exact",
    supports: ({ provider, requestedRuntime, modelProvider }) => {
      if (requestedRuntime !== HARNESS_ID && requestedRuntime !== "auto") {
        return { supported: false, reason: "Devin CLI runs only on its own runtime" };
      }
      if (provider.toLowerCase() !== params.providerId) {
        return { supported: false, reason: "Devin CLI only serves devin-cli models" };
      }
      if (modelProvider?.runtimePolicy && !modelProvider.runtimePolicy.compatibleIds.includes(HARNESS_ID)) {
        return { supported: false, reason: "provider route is not compatible with Devin CLI" };
      }
      if (modelProvider?.requestTransportOverrides === "present") {
        return {
          supported: false,
          reason: "devin acp cannot apply authored provider headers, params or transport overrides",
        };
      }
      return { supported: true, priority: 100 };
    },
    runAttempt: (input) => {
      const toolSurface = params.resolveToolSurface(input);
      assertToolPolicyEnforceable(input, toolSurface);
      return runDevinAttempt(input, {
        harnessId: HARNESS_ID,
        command: params.command(),
        stateDir: params.stateDir(),
        toolSurface,
        bindings: store(),
        warm,
        generationSignal: generation.signal,
        resolveModel: params.resolveModel,
        resolvePermissionMode: params.resolvePermissionMode,
        logger: params.logger,
      });
    },
    runIsolatedCompletionV2: (input) =>
      runDevinIsolatedCompletion(input, {
        command: params.command(),
        stateDir: params.stateDir(),
        model: params.resolveIsolatedModel(input),
      }),
    compact: async (input) => {
      await warm.evict(input.sessionId);
      return await compactDevinSession(input, {
        command: params.command(),
        stateDir: params.stateDir(),
        bindings: store(),
      });
    },
    reset: async (input: AgentHarnessResetParams) => {
      if (!input.sessionId) return;
      store().delete(input.sessionId);
      await warm.evict(input.sessionId);
    },
    withSessionDeletion: async <T>(
      input: AgentHarnessSessionDeletionParams,
      run: (mutation: AgentHarnessSessionDeletionMutation) => Promise<T>,
    ): Promise<T> => {
      input.assertCurrent();
      const previous = store().get(input.sessionId);
      return await run({
        commit: () => {
          store().delete(input.sessionId);
          void warm.evict(input.sessionId);
        },
        rollback: () => {
          if (previous) store().set(input.sessionId, previous);
        },
      });
    },
    // Same quota as the provider hook (which stays authoritative), for usage
    // lookups that resolve through the runtime instead of the provider.
    fetchUsageSnapshot: fetchDevinUsageForContext,
    dispose: async () => {
      generation.abort();
      await warm.closeAll();
    },
  };
}
