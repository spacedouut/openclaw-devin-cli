import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deriveReasoningFamilies,
  familyDefaultLevel,
  familyLevels,
  findReasoningFamily,
  mergeConfiguredFamilies,
  resolveFamilyVariant,
} from "../dist/reasoning-families.js";

const catalog = [
  { family_uid: "Adaptive", variants: [{ model_uid: "adaptive" }] },
  {
    family_uid: "claude-opus-5-5",
    family_label: "Claude Opus 5.5",
    variants: [
      { model_uid: "claude-opus-5-5-medium", max_context_tokens: 1000000 },
      { model_uid: "claude-opus-5-5-low" },
      { model_uid: "claude-opus-5-5-high" },
      { model_uid: "claude-opus-5-5-max" },
      { model_uid: "claude-opus-5-5-max-fast" },
    ],
  },
  {
    family_uid: "claude-opus-4.7",
    aliases: ["opus"],
    variants: [{ model_uid: "claude-opus-4-7-high" }, { model_uid: "claude-opus-4-7-max" }],
  },
  {
    family_uid: "glm-5.2",
    variants: [
      { model_uid: "glm-5-2" },
      { model_uid: "glm-5-2-max" },
      { model_uid: "glm-5-2-none" },
      { model_uid: "glm-5-2-1m" },
    ],
  },
  { family_uid: "fusion", variants: [{ model_uid: "fusion-a-sidekick-b" }] },
];

const { families, standalone } = deriveReasoningFamilies(catalog);

test("collapses effort variants into families and keeps the rest standalone", () => {
  assert.deepEqual(Object.keys(families).sort(), ["claude-opus-4-7", "claude-opus-5-5", "glm-5-2"]);
  assert.deepEqual(
    standalone.map((v) => v.model_uid),
    ["adaptive", "glm-5-2-1m", "fusion-a-sidekick-b"],
  );
  assert.equal(families["claude-opus-5-5"].contextWindow, 1000000);
});

test("maps thinking levels to variants", () => {
  const opus = families["claude-opus-5-5"];
  assert.deepEqual(familyLevels(opus), ["low", "medium", "high", "max"]);
  assert.equal(resolveFamilyVariant(opus, "medium"), "claude-opus-5-5-medium");
  assert.equal(resolveFamilyVariant(opus, "max"), "claude-opus-5-5-max");
  assert.equal(resolveFamilyVariant(opus, "xhigh"), "claude-opus-5-5-high");
  assert.equal(resolveFamilyVariant(opus, "off"), "claude-opus-5-5-low");
  assert.equal(resolveFamilyVariant(opus, undefined), "claude-opus-5-5-medium");
  assert.equal(resolveFamilyVariant(opus, "adaptive"), "claude-opus-5-5-medium");
});

test("fast mode prefers fast variants and falls back to normal tiers", () => {
  const opus = families["claude-opus-5-5"];
  assert.equal(resolveFamilyVariant(opus, "max", true), "claude-opus-5-5-max-fast");
  assert.equal(resolveFamilyVariant(opus, "low", true), "claude-opus-5-5-low");
  assert.equal(resolveFamilyVariant({ ...opus, fastLevels: undefined }, "low", true), "claude-opus-5-5-low");
});

test("none maps to off and base variant covers unmapped levels", () => {
  const glm = families["glm-5-2"];
  assert.deepEqual(familyLevels(glm), ["off", "max"]);
  assert.equal(resolveFamilyVariant(glm, "off"), "glm-5-2-none");
  assert.equal(resolveFamilyVariant(glm, "medium"), "glm-5-2");
  assert.equal(resolveFamilyVariant(glm, undefined), "glm-5-2");
});

test("resolves Devin family uids and aliases", () => {
  assert.equal(findReasoningFamily(families, "opus")?.id, "claude-opus-4-7");
  assert.equal(findReasoningFamily(families, "claude-opus-4.7")?.id, "claude-opus-4-7");
  assert.equal(findReasoningFamily(families, "Claude-Opus-5-5")?.id, "claude-opus-5-5");
  assert.equal(findReasoningFamily(families, "claude-opus-5-5-max"), undefined);
});

test("configured families override auto-derived ones", () => {
  const merged = mergeConfiguredFamilies(families, {
    "claude-opus-5-5": {
      levels: { medium: "claude-opus-5-5-medium", max: "claude-opus-5-5-max" },
      defaultLevel: "max",
    },
    "my-sonnet": { levels: { None: "claude-sonnet-5-low", high: "claude-sonnet-5-high" } },
    empty: { levels: {} },
  });
  const opus = merged["claude-opus-5-5"];
  assert.deepEqual(familyLevels(opus), ["medium", "max"]);
  assert.equal(familyDefaultLevel(opus), "max");
  assert.equal(resolveFamilyVariant(opus, "high"), "claude-opus-5-5-medium");
  assert.equal(resolveFamilyVariant(opus, undefined), "claude-opus-5-5-max");
  assert.equal(opus.fastLevels, undefined);
  assert.deepEqual(familyLevels(merged["my-sonnet"]), ["off", "high"]);
  assert.equal(merged.empty, undefined);
});
