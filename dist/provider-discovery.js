/**
 * Provider-catalog entry for `devin-cli` (manifest `providerCatalogEntry`).
 *
 * CLI backends have no model-catalog hook, so OpenClaw's model pickers get
 * their `devin-cli/...` list from this ProviderPlugin-shaped module instead:
 *
 * - `staticCatalog` returns a small offline seed so the provider is always
 *   visible in pickers.
 * - `catalog` (the live hook) shells out to `devin models list --format json`
 *   and maps families/variants into catalog models, falling back to the
 *   static seed when the CLI is missing, unauthenticated, or slow.
 */
import { execFile } from "node:child_process";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
const BACKEND_ID = "devin-cli";
/** Offline seed so `devin-cli` is visible in model pickers before auth.
 * Every id is a value `devin --model` accepts natively. */
const STATIC_MODELS = [
    { id: "adaptive", name: "Adaptive", input: ["text"] },
    { id: "swe-2", name: "SWE-2", input: ["text"] },
    { id: "swe-2-high", name: "SWE-2 High", input: ["text"], reasoning: true },
    { id: "swe-2-medium", name: "SWE-2 Medium", input: ["text"] },
    { id: "swe-2-max", name: "SWE-2 Max", input: ["text"], reasoning: true },
    { id: "claude-sonnet-4", name: "Claude Sonnet 4", input: ["text"], reasoning: true },
    { id: "claude-opus-4.6", name: "Claude Opus 4.6", input: ["text"], reasoning: true },
    { id: "opus", name: "Claude Opus (alias)", input: ["text"], reasoning: true },
    { id: "codex", name: "Codex", input: ["text"] },
];
function staticProvider() {
    return { defaultModel: "adaptive", models: STATIC_MODELS };
}
function devinCommand(ctx) {
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
            ? { id: family.slug, name: family.family_label ?? family.slug, input: ["text"] }
            : undefined);
        for (const alias of family.aliases ?? []) {
            push({ id: alias, name: family.family_label ?? alias, input: ["text"] });
        }
        for (const variant of family.variants ?? []) {
            if (!variant.model_uid)
                continue;
            push({
                id: variant.model_uid,
                name: variant.label ?? variant.model_uid,
                input: ["text"],
                ...(variant.max_context_tokens
                    ? { contextWindow: variant.max_context_tokens }
                    : {}),
                ...(variant.max_output_tokens ? { maxTokens: variant.max_output_tokens } : {}),
                ...(variant.is_beta ? { status: "preview" } : {}),
            });
        }
    }
    return models;
}
async function listDevinModels(ctx) {
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
        run: async (ctx) => {
            try {
                const models = await listDevinModels(ctx);
                if (models.length > 0) {
                    return { providers: { [BACKEND_ID]: { defaultModel: "adaptive", models } } };
                }
            }
            catch {
                // devin missing/unauthenticated/slow — static seed keeps the provider visible.
            }
            return { providers: { [BACKEND_ID]: staticProvider() } };
        },
    },
};
export default devinCliProviderDiscovery;
