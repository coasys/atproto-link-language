/**
 * One writer at a time per publication ledger, across processes (round 3
 * #2). Two executors (or isolates) sharing a language storage directory
 * would otherwise both read a publicationKey as absent, choose rkeys from
 * independent clocks and post twice: an atomic rename is not a
 * compare-and-set.
 *
 * The lock is a file created with the host's createStorageFileExclusive
 * (O_EXCL): `{owner, at}`. It covers the whole critical section of a
 * publication — ledger read, rkey allocation, the pre-send save, the send
 * and the outcome save. The holder refreshes `at` (atomic overwrite) before
 * the network send and checks it still owns the lock before recording an
 * outcome.
 *
 * A lock older than `staleMs` belongs to a writer that died (a publication
 * takes well under it: every request has a deadline). It is broken under a
 * second exclusive lock (`<lock>.takeover`), so two processes cannot both
 * break it and both win; a takeover lock older than TAKEOVER_STALE_MS is
 * itself removed. Residual window (documented): a holder that stalls longer
 * than `staleMs` can lose the lock between its ownership check and its next
 * write.
 */

export interface LockFiles {
    read(name: string): string | null;
    writeAtomic(name: string, content: string): void;
    createExclusive(name: string, content: string): void;
    remove(name: string): void;
}

const TAKEOVER_STALE_MS = 30_000;

export class LedgerBusy extends Error {}

const isName = (e: unknown, name: string) => (e as Error)?.name === name || new RegExp(name).test(String((e as Error)?.message));

export class LedgerLock {
    constructor(
        private readonly files: LockFiles,
        private readonly name: string,
        private readonly owner: string,
        private readonly now: () => number,
        private readonly staleMs = 300_000,
        private readonly waitMs = 30_000,
        private readonly pollMs = 50,
    ) {}

    private content(): string {
        return JSON.stringify({ owner: this.owner, at: this.now() });
    }

    private state(name: string): { owner: string; at: number } | null {
        const raw = this.files.read(name);
        if (raw === null) return null;
        try {
            const j = JSON.parse(raw);
            if (typeof j?.owner === "string" && typeof j?.at === "number") return j;
        } catch {
            // unreadable: as old as can be
        }
        return { owner: "", at: 0 };
    }

    private tryCreate(name: string): boolean {
        try {
            this.files.createExclusive(name, this.content());
            return true;
        } catch (e) {
            if (isName(e, "AlreadyExists")) return false;
            throw e;
        }
    }

    /** Break a stale lock, holding the takeover lock while doing it. */
    private breakStale(): void {
        const takeover = `${this.name}.takeover`;
        if (!this.tryCreate(takeover)) {
            const t = this.state(takeover);
            if (t && this.now() - t.at > TAKEOVER_STALE_MS) {
                try {
                    this.files.remove(takeover);
                } catch {
                    // someone else did
                }
            }
            return;
        }
        try {
            const s = this.state(this.name);
            if (s && this.now() - s.at > this.staleMs) {
                try {
                    this.files.remove(this.name);
                } catch {
                    // already gone
                }
            }
        } finally {
            try {
                this.files.remove(takeover);
            } catch {
                // already gone
            }
        }
    }

    /** One attempt: take the lock, breaking it first if it is stale. */
    tryAcquire(): boolean {
        if (this.tryCreate(this.name)) return true;
        const s = this.state(this.name);
        if (s && s.owner !== this.owner && this.now() - s.at > this.staleMs) {
            this.breakStale();
            return this.tryCreate(this.name);
        }
        return false;
    }

    /** Take the lock, waiting up to `waitMs` for another writer. */
    async acquire(): Promise<void> {
        const until = Date.now() + this.waitMs;
        for (;;) {
            if (this.tryAcquire()) return;
            if (Date.now() >= until) throw new LedgerBusy("ledger lock held by another writer");
            await new Promise((r) => setTimeout(r, this.pollMs));
        }
    }

    owned(): boolean {
        return this.state(this.name)?.owner === this.owner;
    }

    /** Refresh `at` while holding the lock. */
    touch(): void {
        if (this.owned()) this.files.writeAtomic(this.name, this.content());
    }

    release(): void {
        if (!this.owned()) return;
        try {
            this.files.remove(this.name);
        } catch {
            // already gone
        }
    }
}
