/**
 * Plugin-owned map from OpenClaw session ids to native Devin ACP sessions.
 */
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type DevinSessionBinding = {
  devinSessionId: string;
  cwd: string;
  sessionKey?: string;
  updatedAt: number;
};

type BindingFile = { version: 1; sessions: Record<string, DevinSessionBinding> };

const LOCK_TIMEOUT_MS = 5_000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

export class DevinSessionBindings {
  private readonly file: string;
  private readonly lockDir: string;

  constructor(stateDir: string) {
    this.file = join(stateDir, "plugins", "devin-cli", "sessions.json");
    this.lockDir = `${this.file}.lock.d`;
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

  private isDead(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  }

  private generation(n: number): string {
    return join(this.lockDir, `g${n}`);
  }

  private generations(): number[] {
    return readdirSync(this.lockDir).flatMap((name) => {
      const match = /^g(\d+)$/.exec(name);
      return match ? [Number(match[1])] : [];
    });
  }

  /**
   * Generation n is held until g<n>.released exists or its owner is confirmed dead. A new owner takes
   * generation n+1 by linking a pre-written owner file there, so every claim is a single atomic create
   * and no process ever deletes a lock another process may hold.
   */
  private isFree(n: number): boolean {
    if (n === 0 || existsSync(`${this.generation(n)}.released`)) return true;
    const owner = this.readLockOwner(this.generation(n));
    return !owner || this.isDead(owner.pid);
  }

  private prune(held: number): void {
    for (const name of readdirSync(this.lockDir)) {
      const gen = /^g(\d+)(\.released)?$/.exec(name);
      const stale = gen
        ? Number(gen[1]) < held
        : name.endsWith(".tmp") && this.isDead(this.readLockOwner(join(this.lockDir, name))?.pid ?? 0);
      if (stale) rmSync(join(this.lockDir, name), { force: true });
    }
  }

  private acquire(): number {
    mkdirSync(this.lockDir, { recursive: true });
    const token = randomUUID();
    const claim = join(this.lockDir, `${token}.tmp`);
    writeFileSync(claim, `${token} ${process.pid}`, { mode: 0o600 });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    try {
      for (;;) {
        const current = Math.max(0, ...this.generations());
        if (this.isFree(current)) {
          const next = current + 1;
          try {
            linkSync(claim, this.generation(next));
            if (Math.max(...this.generations()) === next) {
              this.prune(next);
              return next;
            }
            this.release(next);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          }
        }
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${this.lockDir}`);
        Atomics.wait(sleeper, 0, 0, 5);
      }
    } finally {
      rmSync(claim, { force: true });
    }
  }

  private release(generation: number): void {
    try {
      writeFileSync(`${this.generation(generation)}.released`, "", { flag: "wx", mode: 0o600 });
    } catch {
      // already released
    }
  }

  private update<T>(mutate: (data: BindingFile) => { result: T; changed: boolean }): T {
    mkdirSync(dirname(this.file), { recursive: true });
    const generation = this.acquire();
    try {
      const data = this.read();
      const { result, changed } = mutate(data);
      if (changed) this.write(data);
      return result;
    } finally {
      this.release(generation);
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
