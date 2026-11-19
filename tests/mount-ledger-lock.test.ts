/**
 * Ledger lock edge cases (gate pins on round 3): a lock refreshed by its
 * owner between the stale check and the takeover stays; an unreadable lock
 * file counts as stale, so it can never block publication for good.
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

    it("a lock its owner refreshes between the stale check and the takeover is not broken", () => {
        let reads = 0;
        const fs = memFiles((name, files) => {
            // The second read of the lock happens under the takeover lock: by then
            // its owner has touched it.
            if (name === "L" && ++reads === 2) files.set("L", JSON.stringify({ owner: "live-writer", at: NOW }));
        });
        fs.files.set("L", JSON.stringify({ owner: "live-writer", at: NOW - 3_600_000 }));
        const lock = new LedgerLock(fs, "L", "me", () => NOW);
        assert.equal(lock.tryAcquire(), false);
        assert.equal(JSON.parse(fs.files.get("L")!).owner, "live-writer", "the refreshed lock is kept");
        assert.equal(fs.files.has("L.takeover"), false, "the takeover lock is released");
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
