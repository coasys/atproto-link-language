/**
 * Ledger lock edge cases. Round 4 (Lal r3) replaced the round-3 pins: no
 * lock is ever taken over by age, an unreadable lock is held, and release
 * removes only our own lock.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LedgerLock, type LockFiles } from "../src/mount/ledger-lock.js";

function memFiles(onRead?: (name: string, files: Map<string, string>) => void): LockFiles & { files: Map<string, string> } {
    const files = new Map<string, string>();
    return {
        files,
        read(name) {
            onRead?.(name, files);
            return files.get(name) ?? null;
        },
        writeAtomic(name, content) {
            files.set(name, content);
        },
        createExclusive(name, content) {
            if (files.has(name)) {
                const e = new Error(`${name} exists`);
                e.name = "AlreadyExists";
                throw e;
            }
            files.set(name, content);
        },
        remove(name) {
            if (!files.delete(name)) {
                const e = new Error(`${name} missing`);
                e.name = "NotFound";
                throw e;
            }
        },
    };
}

describe("ledger lock edge cases", () => {
    const NOW = 10_000_000;

    // Round 4 #2 (Lal r3): no age-based stealing at all. This replaces
    // Data's pin on the takeover re-check — there is no takeover any more.
    it("an old lock is never taken over: a second writer is refused, the lock untouched", () => {
        const fs = memFiles();
        const old = JSON.stringify({ owner: "dead-writer", at: NOW - 365 * 24 * 3_600_000 });
        fs.files.set("L", old);
        const lock = new LedgerLock(fs, "L", "me", () => NOW);
        assert.equal(lock.tryAcquire(), false);
        assert.equal(fs.files.get("L"), old);
        assert.equal([...fs.files.keys()].some((k) => k !== "L"), false, "no takeover file");
    });

    it("release removes only a lock whose holder id is ours", () => {
        const fs = memFiles();
        const lock = new LedgerLock(fs, "L", "me", () => NOW);
        assert.equal(lock.tryAcquire(), true);
        // after a manual recovery another writer holds L
        fs.files.set("L", JSON.stringify({ owner: "other", at: NOW }));
        lock.release();
        assert.equal(JSON.parse(fs.files.get("L")!).owner, "other", "another holder's lock is kept");
        fs.files.delete("L");
        assert.equal(lock.tryAcquire(), true);
        lock.release();
        assert.equal(fs.files.has("L"), false, "our own lock is released");
    });

    // Round 4 #1 (Lal r3): this pin asserted the unsafe behaviour. A lock file
    // that cannot be read may be one another process is still creating; it
    // is held, never stale — and never removed.
    it("an unreadable or partial lock file is HELD: not taken over, not removed", () => {
        for (const content of ["\u0000not json", "", '{"owner":"a', "{}"]) {
            const fs = memFiles();
            fs.files.set("L", content);
            const lock = new LedgerLock(fs, "L", "me", () => NOW);
            assert.equal(lock.tryAcquire(), false, JSON.stringify(content));
            assert.equal(fs.files.get("L"), content, "untouched");
            lock.release();
            assert.equal(fs.files.get("L"), content, "release leaves it alone");
        }
    });
});
