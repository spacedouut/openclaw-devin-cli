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

export const HARNESS_ID = "devin-cli";

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
  logger?: DevinAttemptDeps["logger"];
}): AgentHarnessV2 {
  const generation = new AbortController();
  let bindings: DevinSessionBindings | undefined;
  const store = () => (bindings ??= new DevinSessionBindings(params.stateDir()));

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
    compact: (input) =>
      compactDevinSession(input, {
        command: params.command(),
        stateDir: params.stateDir(),
        bindings: store(),
      }),
    reset: (input: AgentHarnessResetParams) => {
      if (input.sessionId) store().delete(input.sessionId);
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
        },
        rollback: () => {
          if (previous) store().set(input.sessionId, previous);
        },
      });
    },
    // Same quota as the provider hook (which stays authoritative), for usage
    // lookups that resolve through the runtime instead of the provider.
    fetchUsageSnapshot: fetchDevinUsageForContext,
    dispose: () => {
      generation.abort();
    },
  };
}
