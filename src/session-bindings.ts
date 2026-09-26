/**
 * Plugin-owned map from OpenClaw session ids to native Devin ACP sessions.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type DevinSessionBinding = {
  devinSessionId: string;
  cwd: string;
  sessionKey?: string;
  updatedAt: number;
};

type BindingFile = { version: 1; sessions: Record<string, DevinSessionBinding> };

export class DevinSessionBindings {
  private readonly file: string;

  constructor(stateDir: string) {
    this.file = join(stateDir, "plugins", "devin-cli", "sessions.json");
  }

  private read(): BindingFile {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as BindingFile;
      if (parsed?.version === 1 && parsed.sessions && typeof parsed.sessions === "object") {
        return parsed;
      }
    } catch {
      // missing or unreadable: start empty
    }
    return { version: 1, sessions: {} };
  }

  private write(data: BindingFile): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  get(sessionId: string): DevinSessionBinding | undefined {
    return this.read().sessions[sessionId];
  }

  set(sessionId: string, binding: DevinSessionBinding): void {
    const data = this.read();
    data.sessions[sessionId] = binding;
    this.write(data);
  }

  delete(sessionId: string): DevinSessionBinding | undefined {
    const data = this.read();
    const previous = data.sessions[sessionId];
    if (previous) {
      delete data.sessions[sessionId];
      this.write(data);
    }
    return previous;
  }
}
