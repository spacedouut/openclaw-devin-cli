/**
 * Plugin-owned map from OpenClaw session ids to native Devin ACP sessions.
 */
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type DevinSessionBinding = {
  devinSessionId: string;
  cwd: string;
  sessionKey?: string;
  updatedAt: number;
};

type BindingFile = { version: 1; sessions: Record<string, DevinSessionBinding> };

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

export class DevinSessionBindings {
  private readonly file: string;
  private readonly lock: string;

  constructor(stateDir: string) {
    this.file = join(stateDir, "plugins", "devin-cli", "sessions.json");
    this.lock = `${this.file}.lock`;
  }

  private read(): BindingFile {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, sessions: {} };
      throw error;
    }
    const parsed = JSON.parse(raw) as BindingFile;
    if (parsed?.version !== 1 || !parsed.sessions || typeof parsed.sessions !== "object") {
      throw new Error(`Unsupported Devin session binding file: ${this.file}`);
    }
    return parsed;
  }

  private write(data: BindingFile): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  private update<T>(mutate: (data: BindingFile) => { result: T; changed: boolean }): T {
    mkdirSync(dirname(this.file), { recursive: true });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        closeSync(openSync(this.lock, "wx", 0o600));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          if (Date.now() - statSync(this.lock).mtimeMs > LOCK_STALE_MS) rmSync(this.lock, { force: true });
        } catch {
          // lock released between attempts
        }
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${this.lock}`);
        Atomics.wait(sleeper, 0, 0, 25);
      }
    }
    try {
      const data = this.read();
      const { result, changed } = mutate(data);
      if (changed) this.write(data);
      return result;
    } finally {
      rmSync(this.lock, { force: true });
    }
  }

  get(sessionId: string): DevinSessionBinding | undefined {
    return this.read().sessions[sessionId];
  }

  set(sessionId: string, binding: DevinSessionBinding): void {
    this.update((data) => {
      data.sessions[sessionId] = binding;
      return { result: undefined, changed: true };
    });
  }

  delete(sessionId: string): DevinSessionBinding | undefined {
    return this.update((data) => {
      const previous = data.sessions[sessionId];
      if (previous) delete data.sessions[sessionId];
      return { result: previous, changed: previous !== undefined };
    });
  }
}
