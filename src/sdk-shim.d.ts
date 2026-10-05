/**
 * Type shims for openclaw Plugin SDK subpaths that ship JavaScript without
 * declaration files in the published package (verified against openclaw
 * 2026.9.6 source contracts).
 */
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

declare module "openclaw/plugin-sdk/session-transcript-runtime" {
  type OpenClawConfig = import("openclaw/plugin-sdk/plugin-entry").OpenClawConfig;

  export type SessionTranscriptTarget = {
    agentId: string;
    sessionId: string;
    sessionKey?: string;
    storePath?: string;
  };

  export type TranscriptEntryAnchor = Record<string, unknown>;

  export type TranscriptMessageAppendResult<TMessage> = {
    appended: boolean;
    message: TMessage;
    messageId: string;
    anchor?: TranscriptEntryAnchor;
  };

  export type TranscriptMessageAppend<TMessage> = {
    message: TMessage;
    eventId?: string;
    idempotencyLookup?: "scan" | "scan-assistant" | "caller-checked";
    now?: number;
    beforeFreshMessageCommit?: () => void;
  };

  export function appendSessionTranscriptMessageByIdentityStrict<TMessage>(
    params: SessionTranscriptTarget &
      TranscriptMessageAppend<TMessage> & {
        config?: OpenClawConfig;
        cwd?: string;
        runId?: string;
        updateMode?: "none" | "inline" | "file-only";
        prepareMessageAfterIdempotencyCheck?: (message: TMessage) => TMessage | undefined;
      },
  ): Promise<
    | { kind: "result"; result: TranscriptMessageAppendResult<TMessage> }
    | { kind: "suppressed" }
    | { kind: "rejected"; reason: "session-rebound" }
  >;

  export function appendSessionTranscriptMessagesByIdentity<TMessage>(
    params: SessionTranscriptTarget & {
      config?: OpenClawConfig;
      cwd?: string;
      messages: readonly TranscriptMessageAppend<TMessage>[];
    },
  ): Promise<TranscriptMessageAppendResult<TMessage>[]>;

  export function publishSessionTranscriptUpdateByIdentity(
    params: SessionTranscriptTarget & { update?: Record<string, unknown> },
  ): Promise<void>;
}

declare module "openclaw/plugin-sdk/agent-sessions" {
  type AgentMessage = import("openclaw/plugin-sdk/agent-harness-runtime").AgentMessage;

  export type SessionTranscriptEntry = {
    id: string;
    type: string;
    parentId?: string | null;
    message?: AgentMessage & { idempotencyKey?: string };
  };

  export class SessionManager {
    static openModelContextAsync(
      target: { agentId: string; sessionId: string; sessionKey?: string; storePath?: string },
      options?: { cwd?: string; signal?: AbortSignal; through?: Record<string, unknown> },
    ): Promise<SessionManager>;
    getBranch(): SessionTranscriptEntry[];
    buildSessionContext(): { messages: AgentMessage[] };
  }
}
