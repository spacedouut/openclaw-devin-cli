/**
 * Plugin-owned map from OpenClaw session ids to native Devin ACP sessions.
 */
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
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
    update(mutate) {
        mkdirSync(dirname(this.file), { recursive: true });
        const deadline = Date.now() + LOCK_TIMEOUT_MS;
        for (;;) {
            try {
                closeSync(openSync(this.lock, "wx", 0o600));
                break;
            }
            catch (error) {
                if (error.code !== "EEXIST")
                    throw error;
                try {
                    if (Date.now() - statSync(this.lock).mtimeMs > LOCK_STALE_MS)
                        rmSync(this.lock, { force: true });
                }
                catch {
                    // lock released between attempts
                }
                if (Date.now() > deadline)
                    throw new Error(`Timed out waiting for ${this.lock}`);
                Atomics.wait(sleeper, 0, 0, 25);
            }
        }
        try {
            const data = this.read();
            const { result, changed } = mutate(data);
            if (changed)
                this.write(data);
            return result;
        }
        finally {
            rmSync(this.lock, { force: true });
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
