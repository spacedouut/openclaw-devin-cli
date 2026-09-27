/**
 * Devin CLI agent harness: claims `devin-cli/<model>` routes and runs each
 * turn natively through `devin acp`, owning the OpenClaw transcript mirror.
 */
import type {
  AgentHarnessResetParams,
  AgentHarnessSessionDeletionParams,
  AgentHarnessSessionDeletionMutation,
  AgentHarnessV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { runDevinAttempt, type DevinAttemptDeps, type DevinToolSurface } from "./harness-attempt.js";
import { DevinSessionBindings } from "./session-bindings.js";

export const HARNESS_ID = "devin-cli";

export function createDevinHarness(params: {
  providerId: string;
  stateDir: () => string;
  command: () => string;
  resolveModel: DevinAttemptDeps["resolveModel"];
  resolvePermissionMode: DevinAttemptDeps["resolvePermissionMode"];
  resolveToolSurface: (input: Parameters<DevinAttemptDeps["resolveModel"]>[0]) => DevinToolSurface;
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
    runAttempt: (input) =>
      runDevinAttempt(input, {
        harnessId: HARNESS_ID,
        command: params.command(),
        stateDir: params.stateDir(),
        toolSurface: params.resolveToolSurface(input),
        bindings: store(),
        generationSignal: generation.signal,
        resolveModel: params.resolveModel,
        resolvePermissionMode: params.resolvePermissionMode,
        logger: params.logger,
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
    dispose: () => {
      generation.abort();
    },
  };
}
