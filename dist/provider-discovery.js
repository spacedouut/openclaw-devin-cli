/**
 * Shared model-catalog helpers for `devin-cli`.
 *
 * Used by both the manifest `providerCatalogEntry` module and the runtime
 * `api.registerProvider` registration:
 *
 * - `staticProvider` returns an offline seed so the provider is always
 *   visible in pickers.
 * - `listDevinModels` shells out to `devin models list --format json`
 *   and maps families/variants into catalog models.
 */
import { execFile } from "node:child_process";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
const BACKEND_ID = "devin-cli";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const DEFAULT_MAX_TOKENS = 128_000;
const DEFAULT_CONTEXT_WINDOW = 262_000;
/** Offline seed so `devin-cli` is visible in model pickers before auth.
 * Every id is a value `devin --model` accepts natively. */
const STATIC_MODELS = [
    { id: "adaptive", name: "Adaptive", reasoning: false, input: ["text"], cost: ZERO_COST, maxTokens: DEFAULT_MAX_TOKENS },
    { id: "swe-2", name: "SWE-2", reasoning: false, input: ["text"], cost: ZERO_COST, maxTokens: DEFAULT_MAX_TOKENS },
    {
        id: "swe-2-high",
        name: "SWE-2 High",
        reasoning: true,
        input: ["text"],
        cost: ZERO_COST,
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        maxTokens: DEFAULT_MAX_TOKENS,
    },
    {
        id: "swe-2-medium",
        name: "SWE-2 Medium",
        reasoning: false,
        input: ["text"],
        cost: ZERO_COST,
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        maxTokens: DEFAULT_MAX_TOKENS,
    },
    {
        id: "swe-2-max",
        name: "SWE-2 Max",
        reasoning: true,
        input: ["text"],
        cost: ZERO_COST,
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        maxTokens: DEFAULT_MAX_TOKENS,
    },
    {
        id: "claude-sonnet-4",
        name: "Claude Sonnet 4",
        reasoning: true,
        input: ["text"],
        cost: ZERO_COST,
        maxTokens: DEFAULT_MAX_TOKENS,
    },
    {
        id: "claude-opus-4.6",
        name: "Claude Opus 4.6",
        reasoning: true,
        input: ["text"],
        cost: ZERO_COST,
        maxTokens: DEFAULT_MAX_TOKENS,
    },
    { id: "opus", name: "Claude Opus (alias)", reasoning: true, input: ["text"], cost: ZERO_COST, maxTokens: DEFAULT_MAX_TOKENS },
    { id: "codex", name: "Codex", reasoning: false, input: ["text"], cost: ZERO_COST, maxTokens: DEFAULT_MAX_TOKENS },
];
export function staticProvider() {
    return { baseUrl: "", defaultModel: "adaptive", models: STATIC_MODELS };
}
export function devinCommand(ctx) {
    const raw = resolvePluginConfigObject(ctx.config, BACKEND_ID);
    const command = raw?.command;
    return typeof command === "string" && command.trim() ? command.trim() : "devin";
}
/** Flatten `devin models list --format json` families into catalog models:
 * one entry per family slug + family alias + variant model_uid. */
function modelsFromFamilies(families) {
    const seen = new Set();
    const models = [];
    const push = (model) => {
        if (model?.id && !seen.has(model.id)) {
            seen.add(model.id);
            models.push(model);
        }
    };
    for (const family of families) {
        push(family.slug
            ? {
                id: family.slug,
                name: family.family_label ?? family.slug,
                reasoning: false,
                input: ["text"],
                cost: ZERO_COST,
                maxTokens: DEFAULT_MAX_TOKENS,
            }
            : undefined);
        for (const alias of family.aliases ?? []) {
            push({
                id: alias,
                name: family.family_label ?? alias,
                reasoning: false,
                input: ["text"],
                cost: ZERO_COST,
                maxTokens: DEFAULT_MAX_TOKENS,
            });
        }
        for (const variant of family.variants ?? []) {
            if (!variant.model_uid)
                continue;
            push({
                id: variant.model_uid,
                name: variant.label ?? variant.model_uid,
                reasoning: false,
                input: ["text"],
                cost: ZERO_COST,
                contextWindow: variant.max_context_tokens ?? DEFAULT_CONTEXT_WINDOW,
                maxTokens: variant.max_output_tokens ?? DEFAULT_MAX_TOKENS,
            });
        }
    }
    return models;
}
export async function listDevinModels(ctx) {
    const output = await new Promise((resolve, reject) => {
        execFile(devinCommand(ctx), ["models", "list", "--format", "json"], {
            timeout: 20_000,
            maxBuffer: 8 * 1024 * 1024,
            env: { ...(ctx.env ?? process.env), CI: "1", NO_COLOR: "1" },
            signal: ctx.signal,
        }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    });
    const parsed = JSON.parse(output);
    return modelsFromFamilies(parsed.families ?? []);
}
/** Shared catalog hook body: live `devin models list`, static seed fallback. */
export async function devinCliCatalog(ctx) {
    try {
        const models = await listDevinModels(ctx);
        if (models.length > 0) {
            return {
                providers: {
                    [BACKEND_ID]: { baseUrl: "", defaultModel: "adaptive", models },
                },
            };
        }
    }
    catch {
        // devin missing/unauthenticated/slow — static seed keeps the provider visible.
    }
    return { providers: { [BACKEND_ID]: staticProvider() } };
}
const devinCliProviderDiscovery = {
    id: BACKEND_ID,
    label: "Devin CLI",
    docsPath: "https://github.com/spacedouut/openclaw-devin-cli",
    auth: [],
    staticCatalog: {
        order: "simple",
        run: async () => ({ providers: { [BACKEND_ID]: staticProvider() } }),
    },
    catalog: {
        order: "simple",
        run: devinCliCatalog,
    },
};
export default devinCliProviderDiscovery;
