/**
 * openclaw-devin-cli — registers Cognition's Devin CLI (`devin -p`) as an
 * OpenClaw CLI backend. Model refs look like `devin-cli/opus`.
 *
 * Devin CLI prints plain text and owns local login + session state, so a
 * bundled bridge script (bin/devin-openclaw-bridge.mjs) performs the actual
 * spawn: it wraps the reply in the JSON record OpenClaw parses and recovers
 * the Devin session id so `-r <sessionId>` resume works across turns.
 */
import { fileURLToPath } from "node:url";
import {
  definePluginEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  CLI_FRESH_WATCHDOG_DEFAULTS,
  CLI_RESUME_WATCHDOG_DEFAULTS,
  type CliBackendConfig,
  type CliBackendNormalizeConfigContext,
  type CliBackendResolveExecutionArgsContext,
} from "openclaw/plugin-sdk/cli-backend";
import { resolveExecModePolicy } from "openclaw/plugin-sdk/exec-approvals-runtime";
import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-scope-runtime";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";

// The real `CliBackendPlugin` type is only re-exported from plugin-entry under
// a minified alias; deriving it from the typed API signature is more stable.
type CliBackendPlugin = Parameters<OpenClawPluginApi["registerCliBackend"]>[0];

const BACKEND_ID = "devin-cli";
const PERMISSION_MODE_ARG = "--permission-mode";
const BRIDGE_PATH = fileURLToPath(
  new URL("../bin/devin-openclaw-bridge.mjs", import.meta.url),
);

type DevinCliPluginConfig = {
  /** devin binary name or absolute path (default "devin" on PATH). */
  command?: string;
  /** Devin CLI --permission-mode override. */
  permissionMode?: "auto" | "accept-edits" | "smart" | "dangerous";
  /** Extra/override OpenClaw model ids -> `devin --model` ids. */
  modelAliases?: Record<string, string>;
};

function pluginConfig(context?: CliBackendNormalizeConfigContext): DevinCliPluginConfig {
  const raw = resolvePluginConfigObject(context?.config, BACKEND_ID);
  return (raw ?? {}) as DevinCliPluginConfig;
}

/** Mirror the bundled claude-cli adapter: full-exec OpenClaw runs get the CLI's
 * own "approve everything" mode; other runs get a mid-level default so edits
 * inside the agent workspace still work without interactive approval. */
function resolvePermissionMode(context?: CliBackendNormalizeConfigContext): string {
  const agentExec = context?.agentId
    ? resolveAgentConfig(context?.config ?? {}, context.agentId)?.tools?.exec
    : undefined;
  const exec = agentExec ?? context?.config?.tools?.exec;
  const execFull =
    resolveExecModePolicy({
      mode: exec?.mode,
      security: exec?.security ?? "full",
      ask: exec?.ask ?? "off",
    }).mode === "full";
  return pluginConfig(context).permissionMode ?? (execFull ? "dangerous" : "accept-edits");
}

function withPermissionMode(args: string[] | undefined, mode: string): string[] {
  const next = [...(args ?? [])];
  const index = next.indexOf(PERMISSION_MODE_ARG);
  if (index >= 0 && index + 1 < next.length) {
    next[index + 1] = mode;
  } else {
    next.push(PERMISSION_MODE_ARG, mode);
  }
  return next;
}

function normalizeDevinBackendConfig(
  config: CliBackendConfig,
  context?: CliBackendNormalizeConfigContext,
): CliBackendConfig {
  const command = pluginConfig(context).command;
  const modelAliases = pluginConfig(context).modelAliases;
  return {
    ...config,
    args: withPermissionMode(config.args, resolvePermissionMode(context)),
    resumeArgs: withPermissionMode(config.resumeArgs, resolvePermissionMode(context)),
    ...(command
      ? { env: { ...(config.env ?? {}), DEVIN_OPENCLAW_COMMAND: command } }
      : {}),
    ...(modelAliases
      ? { modelAliases: { ...(config.modelAliases ?? {}), ...modelAliases } }
      : {}),
  };
}

/** Side-question (/btw) turns should not mutate the workspace: pin the CLI to
 * its read-mostly "auto" permission mode for that execution mode only. */
function resolveDevinExecutionArgs(
  ctx: CliBackendResolveExecutionArgsContext,
): readonly string[] | undefined {
  if (ctx.executionMode !== "side-question") {
    return undefined;
  }
  return withPermissionMode([...ctx.baseArgs], "auto");
}

const DEVIN_MODEL_ALIASES: Record<string, string> = {
  // Short OpenClaw ids -> `devin --model` ids confirmed in `devin --help`.
  sonnet: "claude-sonnet-4",
  "opus-4.6": "claude-opus-4.6",
  // "opus" and "codex" are already valid native ids and pass through as-is.
};

function buildDevinCliBackend(): CliBackendPlugin {
  return {
    id: BACKEND_ID,
    liveTest: {
      defaultModelRef: "devin-cli/opus",
      defaultImageProbe: false,
      defaultMcpProbe: false,
    },
    // Devin's native tool set is always available; there is no flag to turn it
    // off, so exact tool-availability runs correctly fail closed for now.
    nativeToolMode: "always-on",
    normalizeConfig: normalizeDevinBackendConfig,
    resolveExecutionArgs: resolveDevinExecutionArgs,
    config: {
      // Spawn the bridge with the same runtime that loaded this plugin (node or bun).
      command: process.execPath,
      args: [BRIDGE_PATH, "--oc-prompt", "{prompt}", "-p"],
      resumeArgs: [BRIDGE_PATH, "-r", "{sessionId}", "--oc-prompt", "{prompt}", "-p"],
      output: "json",
      resumeOutput: "json",
      input: "arg",
      modelArg: "--model",
      modelAliases: DEVIN_MODEL_ALIASES,
      // OpenClaw's system prompt rides into the prompt body via a bridge flag:
      // `devin -p` has no native system-prompt argument.
      systemPromptArg: "--oc-system",
      systemPromptWhen: "first",
      systemPromptMode: "append",
      sessionMode: "existing",
      sessionIdFields: ["session_id"],
      reliability: {
        watchdog: {
          fresh: { ...CLI_FRESH_WATCHDOG_DEFAULTS },
          resume: { ...CLI_RESUME_WATCHDOG_DEFAULTS },
        },
      },
      serialize: true,
    },
  };
}

export default definePluginEntry({
  id: BACKEND_ID,
  name: "Devin CLI",
  description: "Run Cognition's Devin CLI through OpenClaw",
  register(api) {
    api.registerCliBackend(buildDevinCliBackend());
  },
});
