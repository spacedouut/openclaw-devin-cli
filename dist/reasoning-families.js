/**
 * Collapses Devin's per-effort model variants (`claude-opus-5-5-medium`,
 * `-high`, `-max`, ...) into one OpenClaw model per family, so OpenClaw's
 * thinking-level control picks the variant instead of the model list.
 *
 * Families come from `devin models list --format json` (auto-derived from
 * variant suffixes) and/or the plugin's `reasoningFamilies` config.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
export const REASONING_LEVELS = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
];
const LEVEL_RANK = {
    off: 0,
    minimal: 1,
    low: 2,
    medium: 3,
    high: 4,
    xhigh: 5,
    max: 6,
};
/** Devin variant suffix -> OpenClaw thinking level. */
const SUFFIX_LEVEL = {
    none: "off",
    minimal: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
};
const VARIANT_SUFFIX = /^(none|minimal|low|medium|high|xhigh|max)(?:-(fast|priority))?$/;
export function isReasoningLevel(value) {
    return typeof value === "string" && REASONING_LEVELS.includes(value);
}
function familyKey(family) {
    const raw = family.family_uid ?? family.slug;
    return raw ? raw.toLowerCase().replace(/\./g, "-") : undefined;
}
/** Split Devin's catalog into reasoning families plus variants that don't fit
 * the `<family>-<effort>[-fast|-priority]` naming (listed individually). */
export function deriveReasoningFamilies(families) {
    const derived = {};
    const standalone = [];
    for (const family of families) {
        const key = familyKey(family);
        const variants = (family.variants ?? []).filter((v) => v.model_uid);
        if (!key) {
            standalone.push(...variants);
            continue;
        }
        const entry = { label: family.family_label, levels: {}, fastLevels: {} };
        const rest = [];
        for (const variant of variants) {
            const uid = variant.model_uid;
            const lower = uid.toLowerCase();
            const match = lower.startsWith(`${key}-`)
                ? VARIANT_SUFFIX.exec(lower.slice(key.length + 1))
                : null;
            if (lower === key) {
                entry.base = uid;
            }
            else if (match) {
                const level = SUFFIX_LEVEL[match[1]];
                const target = match[2] ? entry.fastLevels : entry.levels;
                target[level] ??= uid;
            }
            else {
                rest.push(variant);
                continue;
            }
            entry.contextWindow ??= variant.max_context_tokens;
            entry.maxTokens ??= variant.max_output_tokens;
        }
        if (Object.keys(entry.levels).length === 0) {
            standalone.push(...variants);
            continue;
        }
        if (Object.keys(entry.fastLevels).length === 0)
            delete entry.fastLevels;
        const aliases = new Set([family.family_uid, family.slug, ...(family.aliases ?? [])]
            .filter((a) => Boolean(a))
            .map((a) => a.toLowerCase())
            .filter((a) => a !== key));
        if (aliases.size > 0)
            entry.aliases = [...aliases];
        derived[key] = entry;
        standalone.push(...rest);
    }
    return { families: derived, standalone };
}
function levelMapFromConfig(raw) {
    const map = {};
    for (const [level, uid] of Object.entries(raw ?? {})) {
        const normalized = level.toLowerCase() === "none" ? "off" : level.toLowerCase();
        if (isReasoningLevel(normalized) && typeof uid === "string" && uid.trim()) {
            map[normalized] = uid.trim();
        }
    }
    return map;
}
/** Configured families replace auto-derived ones with the same id. */
export function mergeConfiguredFamilies(auto, configured) {
    const merged = { ...auto };
    for (const [id, raw] of Object.entries(configured ?? {})) {
        const levels = levelMapFromConfig(raw.levels);
        if (Object.keys(levels).length === 0 && !raw.base)
            continue;
        const fastLevels = levelMapFromConfig(raw.fastLevels);
        const key = id.toLowerCase();
        merged[key] = {
            label: raw.label ?? auto[key]?.label ?? id,
            levels,
            ...(Object.keys(fastLevels).length > 0 ? { fastLevels } : {}),
            ...(raw.base ? { base: raw.base } : {}),
            ...(isReasoningLevel(raw.defaultLevel) ? { defaultLevel: raw.defaultLevel } : {}),
            ...(raw.aliases ? { aliases: raw.aliases.map((a) => a.toLowerCase()) } : {}),
            contextWindow: auto[key]?.contextWindow,
            maxTokens: auto[key]?.maxTokens,
        };
    }
    return merged;
}
export function findReasoningFamily(families, modelId) {
    const key = modelId.trim().toLowerCase();
    if (families[key])
        return { id: key, family: families[key] };
    for (const [id, family] of Object.entries(families)) {
        if (family.aliases?.includes(key))
            return { id, family };
    }
    return undefined;
}
export function familyLevels(family) {
    return REASONING_LEVELS.filter((level) => family.levels[level]);
}
export function familyDefaultLevel(family) {
    const levels = familyLevels(family);
    if (family.defaultLevel && levels.includes(family.defaultLevel))
        return family.defaultLevel;
    return ["medium", "high"].find((l) => levels.includes(l)) ?? levels[0];
}
/** Pick the `devin --model` id for a family at a thinking level. Unmapped
 * levels use the family's base model, else the nearest lower tier, else the
 * nearest higher one. Fast mode only swaps in an exact-level fast variant. */
export function resolveFamilyVariant(family, level, fast = false) {
    const requested = isReasoningLevel(level) ? level : familyDefaultLevel(family);
    if (!isReasoningLevel(level) && family.base)
        return family.base;
    if (!requested)
        return family.base;
    const pick = (map) => {
        if (map[requested])
            return map[requested];
        if (family.base)
            return undefined;
        const available = REASONING_LEVELS.filter((l) => map[l]);
        const lower = available.filter((l) => LEVEL_RANK[l] <= LEVEL_RANK[requested]).at(-1);
        return map[lower ?? available[0]];
    };
    return (fast ? family.fastLevels?.[requested] : undefined) ?? pick(family.levels) ?? family.base;
}
const CACHE_PATH = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "openclaw-devin-cli", "models.json");
let memoryCatalog;
export function rememberDevinCatalog(families) {
    memoryCatalog = families;
    try {
        mkdirSync(dirname(CACHE_PATH), { recursive: true });
        writeFileSync(CACHE_PATH, JSON.stringify({ families }));
    }
    catch {
        // cache is best-effort
    }
}
export function parseDevinCatalog(output) {
    const parsed = JSON.parse(output);
    return parsed.families ?? [];
}
/** Synchronous catalog lookup for per-run hooks: memory, disk cache, then a
 * one-off `devin models list`. */
export function loadDevinCatalogSync(command) {
    if (memoryCatalog)
        return memoryCatalog;
    try {
        memoryCatalog = parseDevinCatalog(readFileSync(CACHE_PATH, "utf8"));
        return memoryCatalog;
    }
    catch {
        // fall through to a live lookup
    }
    try {
        const output = execFileSync(command, ["models", "list", "--format", "json"], {
            timeout: 20_000,
            maxBuffer: 8 * 1024 * 1024,
            env: { ...process.env, CI: "1", NO_COLOR: "1" },
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        });
        const families = parseDevinCatalog(output);
        rememberDevinCatalog(families);
        return families;
    }
    catch {
        memoryCatalog = [];
        return memoryCatalog;
    }
}
