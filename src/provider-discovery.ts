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
import {
  deriveReasoningFamilies,
  mergeConfiguredFamilies,
  parseDevinCatalog,
  rememberDevinCatalog,
  type DevinModelFamily,
  type ReasoningFamilies,
  type ReasoningFamilyConfig,
} from "./reasoning-families.js";

const BACKEND_ID = "devin-cli";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const DEFAULT_MAX_TOKENS = 128_000;
const DEFAULT_CONTEXT_WINDOW = 262_000;

/** Shape the runtime expects inside ProviderCatalogResult.providers[*].models —
 * ModelDefinitionConfig: id plus required reasoning/input/cost/maxTokens. */
export type CatalogModel = {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image" | "video" | "audio")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  maxTokens: number;
};

export type CatalogProvider = {
  baseUrl: string;
  defaultModel?: string;
  models: CatalogModel[];
};

export type ProviderCatalogContext = {
  config?: unknown;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
};

/** Offline seed so `devin-cli` is visible in model pickers before auth.
 * Every id is a value `devin --model` accepts natively. */
const STATIC_MODELS: CatalogModel[] = [
  { id: "adaptive", name: "Adaptive", reasoning: false, input: ["text"], cost: ZERO_COST, maxTokens: DEFAULT_MAX_TOKENS },
  ...["swe-2", "claude-sonnet-5", "claude-opus-5-5", "gpt-6-astra", "kimi-k3", "deepseek-v4-1-flash"].map(
    (id): CatalogModel => ({
      id,
      name: id,
      reasoning: false,
      input: ["text"],
      cost: ZERO_COST,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
    }),
  ),
];

export function staticProvider(): CatalogProvider {
  return { baseUrl: "", defaultModel: "adaptive", models: STATIC_MODELS };
}

type ReasoningPluginConfig = {
  command?: unknown;
  autoReasoningFamilies?: unknown;
  reasoningFamilies?: Record<string, ReasoningFamilyConfig>;
};

function rawPluginConfig(config: unknown): ReasoningPluginConfig {
  return (resolvePluginConfigObject(config as never, BACKEND_ID) ?? {}) as ReasoningPluginConfig;
}

export function devinCommand(ctx: ProviderCatalogContext): string {
  const command = rawPluginConfig(ctx.config).command;
  if (typeof command === "string" && command.trim()) return command.trim();
  return (ctx.env ?? process.env).DEVIN_OPENCLAW_COMMAND?.trim() || "devin";
}

/** Reasoning families in effect: auto-derived from Devin's catalog (unless
 * `autoReasoningFamilies: false`) with configured `reasoningFamilies` on top. */
export function reasoningFamiliesFor(
  config: unknown,
  catalog: DevinModelFamily[],
): { families: ReasoningFamilies; standalone: string[] } {
  const raw = rawPluginConfig(config);
  const derived = deriveReasoningFamilies(catalog);
  const auto = raw.autoReasoningFamilies === false ? {} : derived.families;
  const families = mergeConfiguredFamilies(auto, raw.reasoningFamilies);
  const claimed = new Set<string>();
  for (const family of Object.values(families)) {
    for (const uid of [
      ...Object.values(family.levels),
      ...Object.values(family.fastLevels ?? {}),
      family.base,
    ]) {
      if (uid) claimed.add(uid.toLowerCase());
    }
  }
  const standalone = catalog
    .flatMap((f) => f.variants ?? [])
    .map((v) => v.model_uid)
    .filter((uid): uid is string => Boolean(uid) && !claimed.has((uid as string).toLowerCase()));
  return { families, standalone };
}

/** One catalog row per reasoning family (effort picked by OpenClaw's thinking
 * level) plus one row per Devin variant that isn't part of a family. */
function modelsFromCatalog(config: unknown, catalog: DevinModelFamily[]): CatalogModel[] {
  const { families, standalone } = reasoningFamiliesFor(config, catalog);
  const variants = new Map(
    catalog.flatMap((f) => f.variants ?? []).map((v) => [v.model_uid, v] as const),
  );
  const models: CatalogModel[] = Object.entries(families).map(([id, family]) => ({
    id,
    name: family.label ?? id,
    reasoning: true,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: family.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: family.maxTokens ?? DEFAULT_MAX_TOKENS,
  }));
  const seen = new Set(models.map((m) => m.id));
  for (const uid of standalone) {
    if (seen.has(uid)) continue;
    seen.add(uid);
    const variant = variants.get(uid);
    models.push({
      id: uid,
      name: variant?.label ?? uid,
      reasoning: false,
      input: ["text"],
      cost: ZERO_COST,
      contextWindow: variant?.max_context_tokens ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: variant?.max_output_tokens ?? DEFAULT_MAX_TOKENS,
    });
  }
  return models;
}

export async function listDevinModels(ctx: ProviderCatalogContext): Promise<CatalogModel[]> {
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      devinCommand(ctx),
      ["models", "list", "--format", "json"],
      {
        timeout: 20_000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...(ctx.env ?? process.env), CI: "1", NO_COLOR: "1" },
        signal: ctx.signal,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
  const catalog = parseDevinCatalog(output);
  rememberDevinCatalog(catalog);
  return modelsFromCatalog(ctx.config, catalog);
}

/** Shared catalog hook body: live `devin models list`, static seed fallback. */
export async function devinCliCatalog(ctx: ProviderCatalogContext): Promise<{
  providers: Record<string, CatalogProvider>;
}> {
  try {
    const models = await listDevinModels(ctx);
    if (models.length > 0) {
      return {
        providers: {
          [BACKEND_ID]: { baseUrl: "", defaultModel: "adaptive", models },
        },
      };
    }
  } catch {
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
    order: "simple" as const,
    run: async () => ({ providers: { [BACKEND_ID]: staticProvider() } }),
  },
  catalog: {
    order: "simple" as const,
    run: devinCliCatalog,
  },
};

export default devinCliProviderDiscovery;
