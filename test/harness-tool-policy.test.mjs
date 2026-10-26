import assert from "node:assert/strict";
import test from "node:test";
import { assertToolPolicyEnforceable, createDevinHarness } from "../dist/harness.js";

const harness = (tools) =>
  createDevinHarness({
    providerId: "devin-cli",
    stateDir: () => "/tmp",
    command: () => "devin",
    resolveModel: () => "swe-2",
    resolvePermissionMode: () => "smart",
    resolveToolSurface: () => tools,
    resolveIsolatedModel: () => "swe-2",
  });

test("harness certifies exact conversation tool policy", () => {
  assert.equal(harness("openclaw").conversationToolPolicySupport, "exact");
});

test("restricted runs pass in openclaw tool mode", () => {
  assert.doesNotThrow(() => assertToolPolicyEnforceable({ pluginHarnessToolPolicyRestricted: true }, "openclaw"));
  assert.doesNotThrow(() => assertToolPolicyEnforceable({ disableTools: true }, "openclaw"));
});

test("unrestricted runs pass in every tool mode", () => {
  for (const mode of ["openclaw", "both", "devin"]) {
    assert.doesNotThrow(() => assertToolPolicyEnforceable({}, mode));
  }
});

test("restricted runs fail closed when Devin keeps its own tools", async () => {
  for (const mode of ["both", "devin"]) {
    assert.throws(
      () => assertToolPolicyEnforceable({ pluginHarnessToolPolicyRestricted: true }, mode),
      (error) => error.name === "AgentHarnessPreflightError" && error.message.includes(`"${mode}"`),
    );
    assert.throws(() => harness(mode).runAttempt({ disableTools: true }), { name: "AgentHarnessPreflightError" });
  }
});
