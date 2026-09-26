/**
 * Plugin-owned map from OpenClaw session ids to native Devin ACP sessions.
 */
import { randomUUID } from "node:crypto";
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 2_000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
export class DevinSessionBindings {
    file;
    lock;
    constructor(stateDir) {
        this.file = join(stateDir, "plugins", "devin-cli", "sessions.json");
        this.lock = `${this.file}.lock`;
    }
    read() {
        let raw;
        try {
            raw = readFileSync(this.file, "utf8");
        }
        catch (error) {
            if (error.code === "ENOENT")
                return { version: 1, sessions: {} };
            throw error;
        }
        const parsed = JSON.parse(raw);
        if (parsed?.version !== 1 || !parsed.sessions || typeof parsed.sessions !== "object") {
            throw new Error(`Unsupported Devin session binding file: ${this.file}`);
        }
        return parsed;
    }
    write(data) {
        const tmp = `${this.file}.${process.pid}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
        renameSync(tmp, this.file);
    }
    readLockOwner(path) {
        try {
            const [token, pid] = readFileSync(path, "utf8").split(" ");
            return token ? { token, pid: Number(pid) } : undefined;
        }
        catch {
            return undefined;
        }
    }
    isAbandoned(owner, mtimeMs) {
        if (Date.now() - mtimeMs > LOCK_STALE_MS)
            return true;
        if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0)
            return false;
        try {
            process.kill(owner.pid, 0);
            return false;
        }
        catch (error) {
            return error.code === "ESRCH";
        }
    }
    reclaim(observedToken) {
        const claimed = `${this.lock}.${randomUUID()}.stale`;
        try {
            renameSync(this.lock, claimed);
        }
        catch {
            return;
        }
        if (this.readLockOwner(claimed)?.token !== observedToken) {
            try {
                linkSync(claimed, this.lock);
            }
            catch {
                // a new owner already holds the lock
            }
        }
        rmSync(claimed, { force: true });
    }
    acquire() {
        const token = randomUUID();
        const deadline = Date.now() + LOCK_TIMEOUT_MS;
        for (;;) {
            try {
                const fd = openSync(this.lock, "wx", 0o600);
                try {
                    writeSync(fd, `${token} ${process.pid}`);
                }
                finally {
                    closeSync(fd);
                }
                return token;
            }
            catch (error) {
                if (error.code !== "EEXIST")
                    throw error;
            }
            const owner = this.readLockOwner(this.lock);
            let mtimeMs;
            try {
                mtimeMs = statSync(this.lock).mtimeMs;
            }
            catch {
                continue;
            }
            if (this.isAbandoned(owner, mtimeMs)) {
                this.reclaim(owner?.token);
                continue;
            }
            if (Date.now() > deadline)
                throw new Error(`Timed out waiting for ${this.lock}`);
            Atomics.wait(sleeper, 0, 0, 5);
        }
    }
    release(token) {
        if (this.readLockOwner(this.lock)?.token === token)
            rmSync(this.lock, { force: true });
    }
    update(mutate) {
        mkdirSync(dirname(this.file), { recursive: true });
        const token = this.acquire();
        try {
            const data = this.read();
            const { result, changed } = mutate(data);
            if (changed)
                this.write(data);
            return result;
        }
        finally {
            this.release(token);
        }
    }
    get(sessionId) {
        return this.read().sessions[sessionId];
    }
    set(sessionId, binding) {
        this.update((data) => {
            data.sessions[sessionId] = binding;
            return { result: undefined, changed: true };
        });
    }
    delete(sessionId) {
        return this.update((data) => {
            const previous = data.sessions[sessionId];
            if (previous)
                delete data.sessions[sessionId];
            return { result: previous, changed: previous !== undefined };
        });
    }
}
