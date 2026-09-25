/**
 * Type shims for openclaw Plugin SDK subpaths that ship JavaScript without
 * declaration files in the published package (verified against openclaw
 * 2026.9.6 source contracts). `CliBackendPlugin` itself is not shimmed — it is
 * re-exported, fully typed, from `openclaw/plugin-sdk/plugin-entry`.
 */
declare module "openclaw/plugin-sdk/cli-backend" {
  type OpenClawConfig = import("openclaw/plugin-sdk/plugin-entry").OpenClawConfig;

  export type CliBackendConfig = {
    command: string;
    args?: string[];
    resumeArgs?: string[];
    output?: "json" | "text" | "jsonl";
    resumeOutput?: "json" | "text" | "jsonl";
    jsonlDialect?: "claude-stream-json" | "gemini-stream-json";
    liveSession?: "claude-stdio";
    input?: "arg" | "stdin";
    maxPromptArgChars?: number;
    env?: Record<string, string>;
    clearEnv?: string[];
    modelArg?: string;
    modelAliases?: Record<string, string>;
    sessionArgs?: string[];
    forkArg?: string;
    resumeAtArg?: string;
    sessionMode?: "always" | "existing" | "none";
    sessionIdFields?: string[];
    systemPromptArg?: string;
    systemPromptFileArg?: string;
    systemPromptFileConfigArg?: string;
    systemPromptFileConfigKey?: string;
    systemPromptMode?: "append" | "replace";
    systemPromptWhen?: "first" | "always" | "never";
    imageArg?: string;
    imageMode?: "repeat" | "list";
    imagePathScope?: "temp" | "workspace";
    serialize?: boolean;
    reseedFromRawTranscriptWhenUncompacted?: boolean;
    freshSessionRecovery?: "replace-binding" | "invalidated-only";
    reliability?: {
      watchdog?: {
        fresh?: { noOutputTimeoutRatio?: number; minMs?: number; maxMs?: number };
        resume?: { noOutputTimeoutRatio?: number; minMs?: number; maxMs?: number };
      };
    };
  };

  export type CliBackendThinkingLevel =
    | "off"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "adaptive"
    | "max";

  export type CliBackendExecutionMode = "agent" | "side-question";

  export type CliBackendNormalizeConfigContext = {
    config?: OpenClawConfig;
    backendId: string;
    agentId?: string;
  };

  export type CliBackendResolveExecutionArgsContext = {
    config?: OpenClawConfig;
    workspaceDir: string;
    provider: string;
    modelId: string;
    authProfileId?: string;
    thinkingLevel?: CliBackendThinkingLevel;
    fastMode?: boolean;
    executionMode?: CliBackendExecutionMode;
    toolAvailability?: { native: readonly string[]; openClaw: readonly string[] };
    useResume: boolean;
    baseArgs: readonly string[];
  };

  export const CLI_FRESH_WATCHDOG_DEFAULTS: {
    noOutputTimeoutRatio?: number;
    minMs?: number;
    maxMs?: number;
  };
  export const CLI_RESUME_WATCHDOG_DEFAULTS: {
    noOutputTimeoutRatio?: number;
    minMs?: number;
    maxMs?: number;
  };
}

declare module "openclaw/plugin-sdk/exec-approvals-runtime" {
  export function resolveExecModePolicy(params: {
    mode?: string;
    security?: string;
    ask?: string;
  }): { mode: string; security?: string; ask?: string; autoReview?: boolean };
  export function loadExecApprovals(...args: unknown[]): unknown;
  export function readExecApprovalsSnapshot(...args: unknown[]): unknown;
  export function resolveExecApprovalsDisplayPath(...args: unknown[]): unknown;
  export function resolveExecApprovalsFromFile(...args: unknown[]): unknown;
}
