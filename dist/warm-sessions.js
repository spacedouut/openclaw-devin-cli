export async function closeWarmSession(entry) {
    await entry.acp.close(entry.devinSessionId).catch(() => undefined);
    await entry.bridge?.close().catch(() => undefined);
}
export class WarmDevinSessions {
    idleMs;
    entries = new Map();
    constructor(idleMs) {
        this.idleMs = idleMs;
    }
    /** Removes and returns the warm process for `sessionId`, if it is still running. */
    take(sessionId) {
        const held = this.entries.get(sessionId);
        if (!held)
            return undefined;
        this.entries.delete(sessionId);
        clearTimeout(held.timer);
        if (held.entry.acp.running)
            return held.entry;
        void closeWarmSession(held.entry);
        return undefined;
    }
    /** Keeps `entry` for the next turn, or closes it when keep-alive is off. */
    async put(sessionId, entry) {
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
    async evict(sessionId) {
        const entry = this.take(sessionId);
        if (entry)
            await closeWarmSession(entry);
    }
    async closeAll() {
        await Promise.all([...this.entries.keys()].map((sessionId) => this.evict(sessionId)));
    }
}
