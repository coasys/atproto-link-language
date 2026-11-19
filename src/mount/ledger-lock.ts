/**
 * One writer at a time per publication ledger, across processes (round 3
 * #2, simplified in round 4 after Lal's r3 review). Two executors (or
 * isolates) sharing a language storage directory would otherwise both read
 * a publicationKey as absent and post twice: an atomic rename is not a
 * compare-and-set.
 *
 * The lock is a file `{owner, at}` created with the host's
 * createStorageFileExclusive, which publishes it atomically (temp file
 * written and fsynced, then hard-linked; fails if the lock exists), so a
 * lock is never seen half-written. It covers the whole critical section of
 * a publication — ledger read, rkey allocation, the pre-send save, the send
 * and the outcome save.
 *
 * There is NO age-based stealing, lease, takeover or refresh (round 4 #2):
 * while a lock file exists, every other writer is refused at once with
 * LedgerBusy and sends nothing. Only its holder removes it, and only when
 * the file still names the holder. Content that cannot be read is held by
 * someone else. Because no process ever removes a lock it does not hold,
 * the holder's check-then-remove cannot race another writer.
 *
 * Manual recovery of a lock left by a writer that died (the process was
 * killed or crashed while publishing):
 *   1. stop every executor that uses this data directory and make sure none
 *      is running (e.g. `pgrep -af "ad4m-executor run -a <data dir>"`
 *      prints nothing);
 *   2. delete `<data dir>/ad4m/languages/<language address>/
 *      publish-ledger.<agent did>.lock` (the `.lock` file only — never a
 *      `publish-ledger.*.json` file);
 *   3. start the executor again. A publication the dead writer left pending
 *      is resolved by its next request with the same publicationKey, which
 *      reads the account's posts before any resend.
 */

export interface LockFiles {
    read(name: string): string | null;
    createExclusive(name: string, content: string): void;
    remove(name: string): void;
}

export class LedgerBusy extends Error {}

const isName = (e: unknown, name: string) => (e as Error)?.name === name || new RegExp(name).test(String((e as Error)?.message));

export class LedgerLock {
    constructor(
        private readonly files: LockFiles,
        private readonly name: string,
        private readonly owner: string,
        private readonly now: () => number,
    ) {}

    /** The holder named by the lock file: null when there is none, "" when
     *  it cannot be read (held by someone else). */
    private holder(): string | null {
        const raw = this.files.read(this.name);
        if (raw === null) return null;
        try {
            const j = JSON.parse(raw);
            if (typeof j?.owner === "string" && j.owner && typeof j?.at === "number") return j.owner;
        } catch {
            // unreadable
        }
        return "";
    }

    /** Take the lock if nobody holds it; never waits, never steals. */
    tryAcquire(): boolean {
        try {
            this.files.createExclusive(this.name, JSON.stringify({ owner: this.owner, at: this.now() }));
            return true;
        } catch (e) {
            if (isName(e, "AlreadyExists")) return false;
            throw e;
        }
    }

    /** Take the lock or throw LedgerBusy. */
    acquire(): void {
        if (!this.tryAcquire()) throw new LedgerBusy("ledger lock held by another writer");
    }

    owned(): boolean {
        return this.holder() === this.owner;
    }

    /** Remove the lock only if it names us. */
    release(): void {
        if (!this.owned()) return;
        try {
            this.files.remove(this.name);
        } catch {
            // already gone
        }
    }
}
