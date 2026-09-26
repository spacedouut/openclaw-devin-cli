/**
 * Plugin-owned map from OpenClaw session ids to native Devin ACP sessions.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
export class DevinSessionBindings {
    file;
    constructor(stateDir) {
        this.file = join(stateDir, "plugins", "devin-cli", "sessions.json");
    }
    read() {
        try {
            const parsed = JSON.parse(readFileSync(this.file, "utf8"));
            if (parsed?.version === 1 && parsed.sessions && typeof parsed.sessions === "object") {
                return parsed;
            }
        }
        catch {
            // missing or unreadable: start empty
        }
        return { version: 1, sessions: {} };
    }
    write(data) {
        mkdirSync(dirname(this.file), { recursive: true });
        const tmp = `${this.file}.${process.pid}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
        renameSync(tmp, this.file);
    }
    get(sessionId) {
        return this.read().sessions[sessionId];
    }
    set(sessionId, binding) {
        const data = this.read();
        data.sessions[sessionId] = binding;
        this.write(data);
    }
    delete(sessionId) {
        const data = this.read();
        const previous = data.sessions[sessionId];
        if (previous) {
            delete data.sessions[sessionId];
            this.write(data);
        }
        return previous;
    }
}
