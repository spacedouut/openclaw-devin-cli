import { runDevinAttempt } from "./harness-attempt.js";
import { DevinSessionBindings } from "./session-bindings.js";
export const HARNESS_ID = "devin-cli";
export function createDevinHarness(params) {
    const generation = new AbortController();
    let bindings;
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
            return { supported: true, priority: 100 };
        },
        runAttempt: (input) => runDevinAttempt(input, {
            harnessId: HARNESS_ID,
            command: params.command(),
            bindings: store(),
            generationSignal: generation.signal,
            resolveModel: params.resolveModel,
            resolvePermissionMode: params.resolvePermissionMode,
            logger: params.logger,
        }),
        reset: (input) => {
            if (input.sessionId)
                store().delete(input.sessionId);
        },
        withSessionDeletion: async (input, run) => {
            input.assertCurrent();
            const previous = store().get(input.sessionId);
            return await run({
                commit: () => {
                    store().delete(input.sessionId);
                },
                rollback: () => {
                    if (previous)
                        store().set(input.sessionId, previous);
                },
            });
        },
        dispose: () => {
            generation.abort();
        },
    };
}
