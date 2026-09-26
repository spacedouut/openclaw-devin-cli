/**
 * Plugin-owned map from OpenClaw session ids to native Devin ACP sessions.
 */
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

export type DevinSessionBinding = {
  devinSessionId: string;
  cwd: string;
  sessionKey?: string;
  updatedAt: number;
};

type BindingFile = { version: 1; sessions: Record<string, DevinSessionBinding> };

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 2_000;
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

  private readLockOwner(path: string): { token: string; pid: number } | undefined {
    try {
      const [token, pid] = readFileSync(path, "utf8").split(" ");
      return token ? { token, pid: Number(pid) } : undefined;
    } catch {
      return undefined;
    }
  }

  private isAbandoned(owner: { pid: number } | undefined, mtimeMs: number): boolean {
    if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0) {
      return Date.now() - mtimeMs > LOCK_STALE_MS;
    }
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  }

  private reclaim(observedToken: string | undefined): void {
    const guard = `${this.lock}.reclaim`;
    try {
      const fd = openSync(guard, "wx", 0o600);
      try {
        writeSync(fd, `${randomUUID()} ${process.pid}`);
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (this.isAbandoned(this.readLockOwner(guard), statSync(guard).mtimeMs)) rmSync(guard, { force: true });
      } catch {
        // guard released between attempts
      }
      return;
    }
    try {
      const current = this.readLockOwner(this.lock);
      if (current?.token !== observedToken) return;
      let mtimeMs: number;
      try {
        mtimeMs = statSync(this.lock).mtimeMs;
      } catch {
        return;
      }
      if (this.isAbandoned(current, mtimeMs)) rmSync(this.lock, { force: true });
    } finally {
      rmSync(guard, { force: true });
    }
  }

  private acquire(): string {
    const token = randomUUID();
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const fd = openSync(this.lock, "wx", 0o600);
        try {
          writeSync(fd, `${token} ${process.pid}`);
        } finally {
          closeSync(fd);
        }
        return token;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const owner = this.readLockOwner(this.lock);
      let mtimeMs: number | undefined;
      try {
        mtimeMs = statSync(this.lock).mtimeMs;
      } catch {
        continue;
      }
      if (this.isAbandoned(owner, mtimeMs)) {
        this.reclaim(owner?.token);
        continue;
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${this.lock}`);
      Atomics.wait(sleeper, 0, 0, 5);
    }
  }

  private release(token: string): void {
    if (this.readLockOwner(this.lock)?.token === token) rmSync(this.lock, { force: true });
  }

  private update<T>(mutate: (data: BindingFile) => { result: T; changed: boolean }): T {
    mkdirSync(dirname(this.file), { recursive: true });
    const token = this.acquire();
    try {
      const data = this.read();
      const { result, changed } = mutate(data);
      if (changed) this.write(data);
      return result;
    } finally {
      this.release(token);
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
