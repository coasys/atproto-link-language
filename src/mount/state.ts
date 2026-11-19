/**
 * Mounted reader state: the last complete inventory per allowlisted
 * account, and the snapshot the mount serves.
 *
 * `refresh()` reads every account. A complete read replaces that
 * account's entries (records it no longer lists are gone — a confirmed
 * deletion); a failed or incomplete read (DID lookup, 429, timeout, moved
 * head, bad page …) keeps the account's previous entries untouched and is
 * reported. The executor's snapshot sweep removes whatever `snapshot()`
 * omits, so this is the one place that decides "deleted".
 *
 * Complete inventories are persisted through the injected StorageAdapter
 * (public record data only — the reader holds no credentials), so an
 * executor restart while a PDS is down serves the last complete snapshot
 * instead of an empty one.
 */

import type { StorageAdapter, Transport } from "../adapters.js";
import { entriesFor, type MountEntry } from "./mapping.js";
import { fetchLabels, readAccount, POST_NSID, ReadError, type AccountRead, type ReaderConfig } from "./reader.js";

export interface MountedReaderOptions extends ReaderConfig {
    /** allowlisted account DIDs; nothing else is ever read or mounted */
    accounts: string[];
    transport: Transport;
    storage?: Pick<StorageAdapter, "get" | "put" | "delete">;
    now?: () => Date;
}

export interface AccountReport {
    did: string;
    ok: boolean;
    error?: string;
    active?: boolean;
    status?: string;
    rev?: string;
    records?: number;
    moderation?: "available" | "unavailable";
}

export interface MountDelta {
    changed: MountEntry[];
    removed: string[];
}

export interface RefreshReport {
    at: string;
    accounts: AccountReport[];
    delta: MountDelta;
}

const storageKey = (did: string) => `mount/account/${did}`;
const acceptedKey = (did: string) => `mount/accepted/${did}`;

/** What the last accepted complete read of an active repo saw: its
 *  revision, commit CID and record URI -> CID inventory. A later read is
 *  checked against it before it may replace the account's entries. */
export interface Accepted {
    rev: string;
    commitCid: string;
    inventory: Record<string, string>;
}

/** Why `read` must not replace the accepted state, or null when it may.
 *  Head stability within one read proves nothing about completeness: a 200
 *  page without a cursor can still be short. So (a) a revision older than
 *  the accepted one is a regression (a stale or rolled-back PDS — revisions
 *  only increase, across migrations too); (b) the same revision with another
 *  commit CID, or (c) the same commit with another inventory, contradicts
 *  what was already accepted. A NEWER revision is accepted whatever its size
 *  — a cursor-less short page on a new commit remains a transport-trust
 *  assumption (see REPORT, Limits). */
export function contradiction(prev: Accepted | undefined, read: AccountRead): string | null {
    if (!prev || !read.active || read.rev === undefined || read.commitCid === undefined) return null;
    if (read.rev < prev.rev) return `repo revision regressed from ${prev.rev} to ${read.rev} — stale or rolled-back PDS`;
    if (read.rev > prev.rev) return null;
    if (read.commitCid !== prev.commitCid) return `revision ${read.rev} now has commit ${read.commitCid}, accepted ${prev.commitCid}`;
    const inv = inventoryOf(read);
    const a = Object.keys(prev.inventory), b = Object.keys(inv);
    if (a.length !== b.length || a.some((u) => prev.inventory[u] !== inv[u])) {
        return `inventory at unchanged commit ${read.commitCid} differs from the accepted one (${a.length} vs ${b.length} records) — partial listing`;
    }
    return null;
}

function inventoryOf(read: AccountRead): Record<string, string> {
    const inv: Record<string, string> = Object.create(null);
    for (const r of read.records) inv[r.uri] = r.cid;
    return inv;
}

export class MountedReader {
    readonly accounts: string[];
    lastReport: RefreshReport | null = null;
    private readonly opts: MountedReaderOptions;
    private readonly perAccount = new Map<string, MountEntry[]>();
    private readonly accepted = new Map<string, Accepted>();
    private inflight: Promise<RefreshReport> | null = null;

    constructor(opts: MountedReaderOptions) {
        this.opts = opts;
        this.accounts = [...new Set(opts.accounts.map((a) => a.trim()).filter(Boolean))];
        for (const did of this.accounts) {
            const raw = opts.storage?.get(storageKey(did));
            if (!raw) continue;
            try {
                const entries = JSON.parse(raw);
                if (Array.isArray(entries)) this.perAccount.set(did, entries);
            } catch {
                // a corrupt cache is ignored; the next complete read replaces it
            }
            const acc = opts.storage?.get(acceptedKey(did));
            if (!acc) continue;
            try {
                const a = JSON.parse(acc);
                if (typeof a?.rev === "string" && typeof a?.commitCid === "string" && a.inventory && typeof a.inventory === "object") {
                    this.accepted.set(did, { rev: a.rev, commitCid: a.commitCid, inventory: Object.assign(Object.create(null), a.inventory) });
                }
            } catch {
                // as above
            }
        }
    }

    /** Whether any account has a complete inventory (this run or persisted). */
    hasSnapshot(): boolean {
        return this.perAccount.size > 0;
    }

    snapshot(): { entries: MountEntry[] } {
        const entries = this.accounts.flatMap((did) => this.perAccount.get(did) ?? []);
        entries.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
        return { entries };
    }

    /** Read every account once; concurrent callers share one pass. */
    refresh(): Promise<RefreshReport> {
        if (!this.inflight) {
            this.inflight = this.refreshOnce().finally(() => {
                this.inflight = null;
            });
        }
        return this.inflight;
    }

    private async refreshOnce(): Promise<RefreshReport> {
        const now = (this.opts.now ?? (() => new Date()))();
        const before = this.snapshot().entries;
        const accounts: AccountReport[] = [];
        for (const did of this.accounts) {
            try {
                const read = await readAccount(did, this.opts.transport, this.opts);
                const bad = contradiction(this.accepted.get(did), read);
                if (bad) throw new ReadError(`${did}: ${bad}`);
                const postUris = read.records.filter((r) => r.collection === POST_NSID).map((r) => r.uri);
                const labels = read.active && postUris.length ? await fetchLabels(postUris, this.opts.transport, this.opts) : null;
                const entries = entriesFor(read, labels, now);
                this.perAccount.set(did, entries);
                this.opts.storage?.put(storageKey(did), JSON.stringify(entries));
                // An inactive read hides records but keeps the accepted
                // head, so a regression is still caught on reactivation.
                if (read.active && read.rev !== undefined && read.commitCid !== undefined) {
                    const acc: Accepted = { rev: read.rev, commitCid: read.commitCid, inventory: inventoryOf(read) };
                    this.accepted.set(did, acc);
                    this.opts.storage?.put(acceptedKey(did), JSON.stringify(acc));
                }
                accounts.push({
                    did, ok: true, active: read.active, status: read.active ? "active" : read.status,
                    rev: read.rev, records: read.records.length,
                    moderation: labels ? "available" : "unavailable",
                });
            } catch (e) {
                accounts.push({ did, ok: false, error: (e as Error).message ?? String(e) });
            }
        }
        const report: RefreshReport = { at: now.toISOString(), accounts, delta: diff(before, this.snapshot().entries) };
        this.lastReport = report;
        return report;
    }
}

export function diff(before: MountEntry[], after: MountEntry[]): MountDelta {
    const old = new Map(before.map((e) => [e.address, JSON.stringify(e)]));
    const now = new Set(after.map((e) => e.address));
    return {
        changed: after.filter((e) => old.get(e.address) !== JSON.stringify(e)),
        removed: before.map((e) => e.address).filter((a) => !now.has(a)),
    };
}
