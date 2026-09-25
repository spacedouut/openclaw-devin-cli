/**
 * openclaw-devin-cli — registers Cognition's Devin CLI as an OpenClaw CLI
 * backend. Model refs look like `devin-cli/opus`.
 *
 * A bundled bridge (bin/devin-openclaw-bridge.mjs) drives `devin acp` over the
 * Agent Client Protocol and wraps the turn in the JSON record OpenClaw parses,
 * carrying Devin's native session id so `-r <sessionId>` resume works.
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  definePluginEntry,
  type OpenClawPluginApi,
  type ProviderRuntimeModel,
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
import {
  devinCliCatalog,
  devinCommand,
  staticProvider,
} from "./provider-discovery.js";

// The real `CliBackendPlugin` type is only re-exported from plugin-entry under
// a minified alias; deriving it from the typed API signature is more stable.
type CliBackendPlugin = Parameters<OpenClawPluginApi["registerCliBackend"]>[0];
type ProviderPlugin = Parameters<OpenClawPluginApi["registerProvider"]>[0];

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

/** Mirror the bundled claude-cli adapter: full-exec OpenClaw runs get Devin's
 * "approve everything" mode; other runs default to `smart`, which auto-runs
 * actions a fast model judges safe. The bridge maps these onto ACP session
 * modes and answers any remaining ACP permission requests itself. */
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
  return pluginConfig(context).permissionMode ?? (execFull ? "dangerous" : "smart");
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
      args: [BRIDGE_PATH, "--oc-prompt", "{prompt}"],
      resumeArgs: [BRIDGE_PATH, "-r", "{sessionId}", "--oc-prompt", "{prompt}"],
      output: "json",
      resumeOutput: "json",
      input: "arg",
      modelArg: "--model",
      modelAliases: DEVIN_MODEL_ALIASES,
      // OpenClaw's system prompt rides into the prompt body via a bridge flag:
      // Devin ACP sessions have no system-prompt field.
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

/**
 * Runtime provider registration. The CLI backend contract only describes how
 * to spawn `devin`; resolving `devin-cli/<model>` refs and feeding the model
 * pickers happen through this ProviderPlugin (same split as Google's
 * `google-gemini-cli`): `staticCatalog`/`catalog` fill `models list`, and
 * `resolveDynamicModel` resolves any model id — Devin CLI owns id validation
 * and accepts arbitrary `--model` values, so resolution passes ids through.
 */
function buildDevinCliProvider(): ProviderPlugin {
  return {
    id: BACKEND_ID,
    label: "Devin CLI",
    docsPath: "/providers/models",
    envVars: [],
    auth: [],
    staticCatalog: {
      order: "simple",
      run: async () => ({ providers: { [BACKEND_ID]: staticProvider() } }),
    },
    catalog: {
      order: "simple",
      run: devinCliCatalog,
    },
    // Devin CLI owns its own login (devin auth login); surface it as the
    // provider's credential so runs don't demand a models.providers API key.
    prepareSyntheticAuth: async ({ provider, env = process.env, signal }) => {
      if (provider?.toLowerCase() !== BACKEND_ID) {
        return undefined;
      }
      signal?.throwIfAborted();
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(
          devinCommand({ env }),
          ["auth", "status"],
          { timeout: 15_000, env: { ...env, CI: "1", NO_COLOR: "1" }, signal },
          (error, out) => (error ? reject(error) : resolve(out)),
        );
      }).catch(() => "");
      signal?.throwIfAborted();
      return stdout.includes("Logged in")
        ? { apiKey: "openclaw:devin-cli-native-auth", source: "Devin CLI native auth", mode: "oauth" as const }
        : undefined;
    },
    resolveDynamicModel: (ctx): ProviderRuntimeModel | undefined => {
      const modelId = ctx.modelId.trim();
      if (!modelId) {
        return undefined;
      }
      return {
        id: modelId,
        name: modelId,
        provider: BACKEND_ID,
        // api/baseUrl are inert for CLI providers: execution routes through the
        // registered devin-cli backend, not HTTP transport. Same default shape
        // bundled claude-cli catalog rows resolve to.
        api: "openai-responses",
        baseUrl: "",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262_000,
        maxTokens: 128_000,
      };
    },
  };
}

export default definePluginEntry({
  id: BACKEND_ID,
  name: "Devin CLI",
  description: "Run Cognition's Devin CLI through OpenClaw",
  register(api) {
    api.registerCliBackend(buildDevinCliBackend());
    api.registerProvider(buildDevinCliProvider());
  },
});
