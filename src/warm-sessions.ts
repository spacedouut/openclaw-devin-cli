/**
 * Keeps a finished turn's `devin acp` process (and its MCP bridge) alive so the
 * next turn of the same OpenClaw session skips spawn, initialize and
 * `session/load`. Idle entries close after `idleMs`.
 */
import type { AcpModelState, DevinAcpProcess } from "./devin-acp.js";
import type { OpenClawMcpBridge } from "./openclaw-mcp-server.js";

export type WarmDevinSession = {
  acp: DevinAcpProcess;
  bridge: OpenClawMcpBridge | undefined;
  devinSessionId: string;
  /** cwd, Devin config and MCP server set the process was loaded with. */
  shape: string;
  model: AcpModelState;
};

export async function closeWarmSession(entry: WarmDevinSession): Promise<void> {
  await entry.acp.close(entry.devinSessionId).catch(() => undefined);
  await entry.bridge?.close().catch(() => undefined);
}

export class WarmDevinSessions {
  private readonly entries = new Map<string, { entry: WarmDevinSession; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly idleMs: () => number) {}

  /** Removes and returns the warm process for `sessionId`, if it is still running. */
  take(sessionId: string): WarmDevinSession | undefined {
    const held = this.entries.get(sessionId);
    if (!held) return undefined;
    this.entries.delete(sessionId);
    clearTimeout(held.timer);
    if (held.entry.acp.running) return held.entry;
    void closeWarmSession(held.entry);
    return undefined;
  }

  /** Keeps `entry` for the next turn, or closes it when keep-alive is off. */
  async put(sessionId: string, entry: WarmDevinSession): Promise<void> {
    const idleMs = this.idleMs();
    await this.evict(sessionId);
    if (idleMs <= 0 || !entry.acp.running) {
      await closeWarmSession(entry);
      return;
    }
    const timer = setTimeout(() => void this.evict(sessionId), idleMs);
    timer.unref();
    this.entries.set(sessionId, { entry, timer });
  }

  async evict(sessionId: string): Promise<void> {
    const entry = this.take(sessionId);
    if (entry) await closeWarmSession(entry);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((sessionId) => this.evict(sessionId)));
  }
}
