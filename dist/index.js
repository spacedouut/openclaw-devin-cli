/**
 * openclaw-devin-cli — runs Cognition's Devin CLI as a native OpenClaw agent
 * harness. Model refs look like `devin-cli/claude-opus-5-5`.
 *
 * The `devin-cli` provider owns model refs, catalog and auth status; the
 * `devin-cli` harness claims those routes and drives `devin acp` directly,
 * mirroring each text run, tool call and tool result into the transcript.
 */
import { execFile } from "node:child_process";
import { definePluginEntry, } from "openclaw/plugin-sdk/plugin-entry";
import { resolveExecModePolicy } from "openclaw/plugin-sdk/exec-approvals-runtime";
import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-scope-runtime";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { createDevinHarness } from "./harness.js";
import { devinCliCatalog, devinCommand, reasoningFamiliesFor, staticProvider, } from "./provider-discovery.js";
import { familyDefaultLevel, familyLevels, findReasoningFamily, loadDevinCatalogSync, resolveFamilyVariant, } from "./reasoning-families.js";
const PROVIDER_ID = "devin-cli";
function pluginConfig(config) {
    return (resolvePluginConfigObject(config, PROVIDER_ID) ?? {});
}
/** Full-exec OpenClaw runs get Devin's "approve everything" mode; other runs
 * default to `smart`, which auto-runs actions a fast model judges safe. */
function resolvePermissionMode(config, agentId) {
    const agentExec = agentId ? resolveAgentConfig(config ?? {}, agentId)?.tools?.exec : undefined;
    const exec = agentExec ?? config?.tools?.exec;
    const execFull = resolveExecModePolicy({
        mode: exec?.mode,
        security: exec?.security ?? "full",
        ask: exec?.ask ?? "off",
    }).mode === "full";
    return pluginConfig(config).permissionMode ?? (execFull ? "dangerous" : "smart");
}
function findFamily(config, modelId) {
    const catalog = loadDevinCatalogSync(devinCommand({ config }));
    return findReasoningFamily(reasoningFamiliesFor(config, catalog).families, modelId);
}
/** OpenClaw model id + thinking level (and fast mode) -> `devin --model` id. */
function resolveDevinModel(input) {
    const alias = pluginConfig(input.config).modelAliases?.[input.modelId];
    if (alias)
        return alias;
    const match = findFamily(input.config, input.modelId);
    const variant = match
        ? resolveFamilyVariant(match.family, input.thinkLevel, input.fastMode === true)
        : undefined;
    return variant ?? input.modelId;
}
/**
 * Runtime provider registration. The CLI backend contract only describes how
 * to spawn `devin`; resolving `devin-cli/<model>` refs and feeding the model
 * pickers happen through this ProviderPlugin (same split as Google's
 * `google-gemini-cli`): `staticCatalog`/`catalog` fill `models list`, and
 * `resolveDynamicModel` resolves any model id — Devin CLI owns id validation
 * and accepts arbitrary `--model` values, so resolution passes ids through.
 */
function buildDevinCliProvider(config) {
    return {
        id: PROVIDER_ID,
        label: "Devin CLI",
        docsPath: "/providers/models",
        envVars: [],
        auth: [],
        staticCatalog: {
            order: "simple",
            run: async () => ({ providers: { [PROVIDER_ID]: staticProvider() } }),
        },
        catalog: {
            order: "simple",
            run: devinCliCatalog,
        },
        // Devin CLI owns its own login (devin auth login); surface it as the
        // provider's credential so runs don't demand a models.providers API key.
        prepareSyntheticAuth: async ({ provider, env = process.env, signal }) => {
            if (provider?.toLowerCase() !== PROVIDER_ID) {
                return undefined;
            }
            signal?.throwIfAborted();
            const stdout = await new Promise((resolve, reject) => {
                execFile(devinCommand({ env }), ["auth", "status"], { timeout: 15_000, env: { ...env, CI: "1", NO_COLOR: "1" }, signal }, (error, out) => (error ? reject(error) : resolve(out)));
            }).catch(() => "");
            signal?.throwIfAborted();
            return stdout.includes("Logged in")
                ? { apiKey: "openclaw:devin-cli-native-auth", source: "Devin CLI native auth", mode: "oauth" }
                : undefined;
        },
        resolveThinkingProfile: ({ modelId }) => {
            const match = findFamily(config, modelId);
            if (!match) {
                return undefined;
            }
            return {
                levels: familyLevels(match.family).map((id) => ({ id })),
                defaultLevel: familyDefaultLevel(match.family) ?? null,
                preserveWhenCatalogReasoningFalse: true,
            };
        },
        resolveFastModeSupport: ({ modelId }) => {
            const match = findFamily(config, modelId);
            return match ? Boolean(match.family.fastLevels) : undefined;
        },
        resolveDynamicModel: (ctx) => {
            const modelId = ctx.modelId.trim();
            if (!modelId) {
                return undefined;
            }
            const match = findFamily(config, modelId);
            return {
                id: modelId,
                name: modelId,
                provider: PROVIDER_ID,
                // api/baseUrl are inert: the devin-cli harness executes these models
                // natively through `devin acp`, never over HTTP transport.
                api: "openai-responses",
                baseUrl: "",
                reasoning: Boolean(match),
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: match?.family.contextWindow ?? 262_000,
                maxTokens: match?.family.maxTokens ?? 128_000,
            };
        },
    };
}
export default definePluginEntry({
    id: PROVIDER_ID,
    name: "Devin CLI",
    description: "Run Cognition's Devin CLI as a native OpenClaw agent runtime",
    register(api) {
        api.registerProvider(buildDevinCliProvider(api.config));
        api.registerAgentHarness(createDevinHarness({
            providerId: PROVIDER_ID,
            stateDir: () => api.runtime.state.resolveStateDir(),
            command: () => devinCommand({ config: api.config }),
            resolveModel: resolveDevinModel,
            resolvePermissionMode: (input) => resolvePermissionMode(input.config, input.agentId),
            resolveToolSurface: (input) => pluginConfig(input.config).tools ?? "openclaw",
            resolveIsolatedModel: (input) => resolveDevinModel({ config: input.config, modelId: input.modelId, thinkLevel: input.thinkLevel }),
            logger: api.logger,
        }));
    },
});
