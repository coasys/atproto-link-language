/**
 * Explicit publication of a plain-text `app.bsky.feed.post` (slice 2).
 *
 * Only the ATPost constructor (`<lang>://class/ATPost` `publish`) calls
 * `publish`. Nothing else in the language writes to a PDS: refresh,
 * snapshot, status and every record address are read-only.
 *
 * Durable publication key. Each request carries `publicationKey`; the
 * ledger in host storage (`publish/v1/<agent>/<key>`) records the account,
 * the text, an rkey (a TID chosen BEFORE the first send), and the outcome.
 *  - published: the same key answers from the ledger, with no request;
 *  - the same key with another account or text is refused;
 *  - pending (a send whose outcome is not a parsed success — timeout,
 *    transport error, 5xx, any refusal, a crash mid-flight): the next
 *    request with that key LISTS the account's posts first. Found -> it is
 *    published (URI/CID from the listing); absent -> it is sent again with
 *    the same rkey. A failed or incomplete listing sends nothing.
 * Because the rkey is fixed, even a create that is still in flight when the
 * listing misses it cannot become a second record: the PDS refuses a
 * second record at that path.
 *
 * The one immediate resend is a DPoP nonce challenge (dpop.ts), which the
 * server refuses before its handler runs.
 *
 * Ledger entries hold public data only (the post text is published);
 * credentials stay in the vault.
 */

import type { WebCrypto } from "./webcrypto.js";

import type { Transport } from "../adapters.js";
import { withDeadline } from "./dpop.js";
import { TidClock } from "./bytes.js";
import { postEntry, type MountEntry } from "./mapping.js";
import { OAuthClient, serverError } from "./oauth.js";
import { POST_NSID, isTid, readAccount, resolveDid, type AccountRead, type ReaderConfig } from "./reader.js";
import type { StorageLike } from "./vault.js";

export class PublishError extends Error {
    constructor(message: string, readonly uncertain = false) {
        super(message);
    }
}

export interface PublishParams {
    text?: unknown;
    atAuthor?: unknown;
    publicationKey?: unknown;
}

export interface LedgerEntry {
    v: 1;
    key: string;
    account: string;
    text: string;
    createdAt: string;
    rkey: string;
    state: "pending" | "published";
    /** sends made so far; > 0 means the next request lists first */
    attempts: number;
    uri?: string;
    cid?: string;
    /** a repo revision at or after the record's commit */
    commitRev?: string;
    /** read-back: "confirmed" once a stable complete inventory held the
     *  post; "deleted" once the PDS confirmed it gone. Until either, the
     *  snapshot serves the post from the ledger (round 2 #4). */
    readBack?: "confirmed" | "deleted";
    lastError?: string;
}

/** What a `call` returns (acorn a2 MountDelta): the created address and
 *  its entry; addresses carry no `<lang>://` prefix. */
export interface CallDelta {
    address: string;
    changed: MountEntry[];
    removed: string[];
}

/** The language's storage directory through the host's file I/O. The
 *  ledger lives only here, never in the best-effort KV (round 2, item 2):
 *  `writeAtomic` is the host's `writeStorageFileAtomic` (temp file, fsync,
 *  rename, directory fsync; throws on any failure). `read` returns null
 *  only for a missing file and throws on any other failure. */
export interface DurableFiles {
    atomic(): boolean;
    read(name: string): string | null;
    writeAtomic(name: string, content: string): void;
}

export interface PublisherOptions extends ReaderConfig {
    transport: Transport;
    /** the KV: read only, to adopt round-1 ledger entries */
    storage: StorageLike;
    files?: DurableFiles;
    oauth: OAuthClient;
    /** the executor agent the language runs as (ledger namespace) */
    agentDid: () => string;
    crypto: WebCrypto;
    /** the mount's account allowlist: publishing is only as one of them */
    accounts: string[];
    writeTimeoutMs?: number;
    now?: () => Date;
}

const KEY = /^[A-Za-z0-9._:~-]{8,128}$/;
const NO_ATOMIC = "this executor has no atomic durable storage write (host writeStorageFileAtomic): publishing is disabled; nothing was sent";
const DID = /^did:(plc:[a-z2-7]{24}|web:[a-zA-Z0-9.%-]+)$/;
const MAX_GRAPHEMES = 300;
const MAX_BYTES = 3000;

export const ledgerFiles = {
    entry: (agent: string, key: string) => `publish-ledger.${agent}.${key}.json`,
    index: (agent: string) => `publish-ledger.${agent}.index.json`,
};

export const ledgerKeys = {
    entry: (agent: string, key: string) => `publish/v1/${agent}/${key}`,
    index: (agent: string) => `publish/v1/index/${agent}`,
};

function graphemes(s: string): number {
    const Seg = (Intl as any).Segmenter;
    if (typeof Seg === "function") return [...new Seg(undefined, { granularity: "grapheme" }).segment(s)].length;
    return [...s].length;
}

export class Publisher {
    private readonly locks = new Map<string, Promise<unknown>>();
    /** rkeys: monotonic per process, seeded from the ledger on first use */
    private tids: TidClock | null = null;
    /** read-back states not yet written (a failed ledger write keeps them here) */
    private readonly readBackMem = new Map<string, "confirmed" | "deleted">();
    private readonly now: () => Date;

    constructor(private readonly opts: PublisherOptions) {
        this.now = opts.now ?? (() => new Date());
    }

    // ---- ledger (durable files) ----

    private files(): DurableFiles | null {
        return this.opts.files && this.opts.files.atomic() ? this.opts.files : null;
    }

    /** The ledger entry for `key`: null when there is none. Throws when one
     *  exists but cannot be read — never treated as absent, which would
     *  mint a second rkey. A round-1 entry in the KV is returned for
     *  adoption (the next save moves it to the file ledger). */
    ledgerEntry(key: string): LedgerEntry | null {
        if (typeof key !== "string" || !KEY.test(key)) return null;
        const agent = this.opts.agentDid();
        let raw: string | null = null;
        if (this.opts.files) {
            try {
                raw = this.opts.files.read(ledgerFiles.entry(agent, key));
            } catch (err) {
                throw new PublishError(`publication ${key}: the ledger entry is unreadable (${(err as Error).message}); nothing was sent`);
            }
        }
        if (raw === null) raw = this.opts.storage.get(ledgerKeys.entry(agent, key)) ?? null;
        if (raw === null) return null;
        let e: any;
        try {
            e = JSON.parse(raw);
        } catch {
            e = null;
        }
        if (!e || e.v !== 1 || e.key !== key || typeof e.rkey !== "string" || !isTid(e.rkey) || (e.state !== "pending" && e.state !== "published")) {
            throw new PublishError(`publication ${key}: the ledger entry is unreadable; nothing was sent`);
        }
        return e as LedgerEntry;
    }

    /** Write `e` durably and atomically, or throw: nothing may be sent on
     *  the strength of an unacknowledged write. */
    private save(e: LedgerEntry): void {
        const files = this.files();
        if (!files) throw new PublishError(`publication ${e.key}: ${NO_ATOMIC}`);
        const agent = this.opts.agentDid();
        try {
            const keys = this.indexKeys();
            // index first: a key listed without an entry file is ignored
            if (!keys.includes(e.key)) files.writeAtomic(ledgerFiles.index(agent), JSON.stringify([...keys, e.key]));
            files.writeAtomic(ledgerFiles.entry(agent, e.key), JSON.stringify(e));
        } catch (err) {
            throw new PublishError(`publication ${e.key}: ledger write failed (${(err as Error).message}); nothing was sent after it`);
        }
        try {
            this.opts.storage.delete(ledgerKeys.entry(agent, e.key)); // adopted round-1 entry, if any
        } catch {
            // the file entry takes precedence
        }
    }

    /** Record a known outcome. If that write fails the record exists on
     *  the PDS but the ledger still says pending: the next request lists
     *  and finds it, so this is "uncertain", never a reason to resend. */
    private saveOutcome(e: LedgerEntry): void {
        try {
            this.save(e);
        } catch (err) {
            throw new PublishError(`publication ${e.key}: published as ${e.uri}, but ${(err as Error).message.replace(/^publication \S+: /, "")} — retry with the same publicationKey; it lists first`, true);
        }
    }

    private indexKeys(): string[] {
        const raw = this.opts.files?.read(ledgerFiles.index(this.opts.agentDid())) ?? null;
        let v: unknown = [];
        try {
            v = raw === null ? [] : JSON.parse(raw);
        } catch {
            v = [];
        }
        const legacy = (() => {
            try {
                const l = JSON.parse(this.opts.storage.get(ledgerKeys.index(this.opts.agentDid())) ?? "[]");
                return Array.isArray(l) ? l : [];
            } catch {
                return [];
            }
        })();
        return [...new Set([...(Array.isArray(v) ? v : []), ...legacy])].filter((k): k is string => typeof k === "string" && KEY.test(k));
    }

    /** Published ledger entries of the current executor user. */
    published(): LedgerEntry[] {
        return this.indexKeys().map((k) => {
            try {
                return this.ledgerEntry(k);
            } catch {
                return null; // unreadable: not served; publish refuses it
            }
        }).filter((e): e is LedgerEntry => e?.state === "published");
    }

    entryOf(e: LedgerEntry): MountEntry {
        const value = { $type: POST_NSID, text: e.text, createdAt: e.createdAt };
        const entry = postEntry({ uri: e.uri!, cid: e.cid!, collection: POST_NSID, rkey: e.rkey, value }, e.account, null, this.now());
        entry.data.publicationKey = e.key;
        return entry;
    }

    private deltaOf(e: LedgerEntry): CallDelta {
        const entry = this.entryOf(e);
        return { address: entry.address, changed: [entry], removed: [] };
    }

    /** A fresh rkey: above every rkey this user's ledger already holds, and
     *  above every one allocated in this process. Synchronous, so
     *  concurrent publications cannot share one. */
    private nextRkey(now: Date): string {
        if (!this.tids) {
            const clock = new TidClock(this.opts.crypto.getRandomValues(new Uint16Array(1))[0] & 1023);
            for (const k of this.indexKeys()) {
                try {
                    const e = this.ledgerEntry(k);
                    if (e) clock.observe(e.rkey);
                } catch {
                    // unreadable entries are refused when used
                }
            }
            this.tids = clock;
        }
        return this.tids.next(now.getTime());
    }

    private readBackOf(e: LedgerEntry): LedgerEntry["readBack"] {
        return this.readBackMem.get(e.key) ?? e.readBack;
    }

    private markReadBack(e: LedgerEntry, state: "confirmed" | "deleted"): void {
        this.readBackMem.set(e.key, state);
        try {
            this.save({ ...e, readBack: state });
            this.readBackMem.delete(e.key);
        } catch {
            // kept in memory for this run; the next accepted read sets it again
        }
    }

    /** The reader's entries with the ledger applied: a published post
     *  carries its `publicationKey`, and a publication not (yet) in the
     *  served inventory is served from the ledger — unless the PDS
     *  confirmed it deleted, or its account is inactive (hidden with the
     *  account's other records). No revision arithmetic: an unconfirmed
     *  publication stays until a read includes it (see `vetRead`). */
    decorate(entries: MountEntry[], inactive: (did: string) => boolean): MountEntry[] {
        const pubs = this.published().filter((e) => this.opts.accounts.includes(e.account));
        if (!pubs.length) return entries;
        const byAddress = new Map(pubs.map((e) => [`${e.account}/${POST_NSID}/${e.rkey}`, e]));
        const seen = new Set<string>();
        const out = entries.map((entry) => {
            seen.add(entry.address);
            const e = byAddress.get(entry.address);
            if (!e || entry.class !== "ATPost") return entry;
            return { ...entry, data: { ...entry.data, publicationKey: e.key } };
        });
        for (const [address, e] of byAddress) {
            if (seen.has(address) || this.readBackOf(e) === "deleted" || inactive(e.account)) continue;
            out.push(this.entryOf(e));
        }
        out.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
        return out;
    }

    /** The reader's hook on a stable, uncontradicted read of `did`, before
     *  it is accepted. For each publication of that account:
     *   - in the inventory -> read-back confirmed;
     *   - confirmed earlier, now omitted -> deleted (a complete accepted
     *     read is authoritative for a record it has seen before);
     *   - never confirmed, omitted by a read older than its commit -> wait;
     *   - never confirmed, omitted at or after its commit (or with no known
     *     commit) -> ask the PDS for the record: gone -> deleted; present ->
     *     this inventory is short, so the read is refused and never becomes
     *     the baseline. A failed check refuses the read too. */
    async vetRead(did: string, read: AccountRead): Promise<string | null> {
        if (!read.active || read.rev === undefined) return null;
        const uris = new Set(read.records.map((r) => r.uri));
        for (const e of this.published()) {
            if (e.account !== did || this.readBackOf(e) === "deleted") continue;
            const uri = `at://${did}/${POST_NSID}/${e.rkey}`;
            if (uris.has(uri)) {
                if (this.readBackOf(e) !== "confirmed") this.markReadBack(e, "confirmed");
                continue;
            }
            if (this.readBackOf(e) === "confirmed") {
                this.markReadBack(e, "deleted");
                continue;
            }
            if (e.commitRev !== undefined && read.rev < e.commitRev) continue;
            let exists: boolean;
            try {
                exists = await this.recordExists(read.pds, e);
            } catch (err) {
                return `cannot check the omitted publication ${uri} (${(err as Error).message})`;
            }
            if (exists) return `the inventory at ${read.rev} omits the existing publication ${uri} — short listing`;
            this.markReadBack(e, "deleted");
        }
        return null;
    }

    /** `com.atproto.repo.getRecord`: true when present, false on
     *  RecordNotFound, throws on anything else. */
    private async recordExists(pds: string, e: LedgerEntry): Promise<boolean> {
        const q = new URLSearchParams({ repo: e.account, collection: POST_NSID, rkey: e.rkey });
        const r = await withDeadline(this.opts.transport.fetch(`${pds}/xrpc/com.atproto.repo.getRecord?${q}`, "GET", { accept: "application/json" }, ""),
            this.opts.timeoutMs ?? 15_000, "getRecord");
        let j: any = null;
        try {
            j = JSON.parse(String(r.body));
        } catch {
            // handled below
        }
        if (r.status === 200 && j?.uri === `at://${e.account}/${POST_NSID}/${e.rkey}`) return true;
        if (r.status === 400 && j?.error === "RecordNotFound") return false;
        throw new Error(`getRecord answered ${r.status}`);
    }

    // ---- publish ----

    /** One publication per key; concurrent calls with one key share it. */
    publish(params: PublishParams): Promise<CallDelta> {
        const { text, atAuthor, publicationKey } = this.validate(params);
        const prev = this.locks.get(publicationKey) ?? Promise.resolve();
        const run = prev.catch(() => undefined).then(() => this.publishLocked(text, atAuthor, publicationKey));
        this.locks.set(publicationKey, run);
        return run.finally(() => {
            if (this.locks.get(publicationKey) === run) this.locks.delete(publicationKey);
        });
    }

    private validate(p: PublishParams): { text: string; atAuthor: string; publicationKey: string } {
        const { text, atAuthor, publicationKey } = p ?? {};
        if (typeof publicationKey !== "string" || !KEY.test(publicationKey)) {
            throw new PublishError("publicationKey is required: 8-128 characters of A-Z a-z 0-9 . _ : ~ -");
        }
        if (typeof text !== "string") throw new PublishError("text must be a string");
        if (!text.trim()) throw new PublishError("text is empty");
        if (graphemes(text) > MAX_GRAPHEMES || new TextEncoder().encode(text).length > MAX_BYTES) {
            throw new PublishError(`text is longer than ${MAX_GRAPHEMES} graphemes / ${MAX_BYTES} bytes`);
        }
        if (typeof atAuthor !== "string" || !DID.test(atAuthor)) throw new PublishError("atAuthor must be the publishing account's DID");
        if (!this.opts.accounts.includes(atAuthor)) throw new PublishError(`atAuthor ${atAuthor} is not in this mount's allowlist`);
        return { text, atAuthor, publicationKey };
    }

    private async publishLocked(text: string, account: string, key: string): Promise<CallDelta> {
        let e = this.ledgerEntry(key);
        if (e && (e.account !== account || e.text !== text)) {
            throw new PublishError(`publicationKey ${key} is already used for a different post`);
        }
        if (e?.state === "published") return this.deltaOf(e);
        if (!this.files()) throw new PublishError(`publication ${key}: ${NO_ATOMIC}`);
        if (!this.opts.oauth.hasSession(account)) {
            throw new PublishError(`${account} is not authorized for this executor user: run authorize first`);
        }
        if (!e) {
            const now = this.now();
            e = { v: 1, key, account, text, createdAt: now.toISOString(), rkey: this.nextRkey(now), state: "pending", attempts: 0 };
            this.save(e);
        }
        let access;
        let pds: string;
        try {
            access = await this.opts.oauth.access(account);
            // account check: the DID still points at the PDS the session is for
            pds = (await resolveDid(account, this.opts.transport, this.opts)).pds;
        } catch (err) {
            throw new PublishError(`publication ${key}: ${(err as Error).message}`);
        }
        if (new URL(pds).origin !== new URL(access.session.pds).origin) {
            throw new PublishError(`publication ${key}: ${account} moved from ${access.session.pds} to ${pds}: authorize again`);
        }

        if (e.attempts > 0) {
            // An earlier send's outcome is unknown: list before any resend.
            const found = await this.findByListing(e);
            if (found) {
                e = { ...e, state: "published", uri: found.uri, cid: found.cid, commitRev: found.rev };
                delete e.lastError;
                this.saveOutcome(e);
                return this.deltaOf(e);
            }
        }

        e = { ...e, attempts: e.attempts + 1 };
        this.save(e); // the attempt is on record before anything is sent
        const uri = `at://${account}/${POST_NSID}/${e.rkey}`;
        const body = JSON.stringify({
            repo: account,
            collection: POST_NSID,
            rkey: e.rkey,
            record: { $type: POST_NSID, text: e.text, createdAt: e.createdAt },
        });
        let reason: string;
        let uncertain = true;
        try {
            const r = await this.opts.oauth.resourceRequest(access, `${pds}/xrpc/com.atproto.repo.createRecord`, "POST", body,
                this.opts.writeTimeoutMs ?? 10_000, "createRecord");
            if (r.status >= 200 && r.status <= 299) {
                let out: any = null;
                try {
                    out = JSON.parse(r.body);
                } catch {
                    // handled below
                }
                if (out?.uri === uri && typeof out?.cid === "string") {
                    e = { ...e, state: "published", uri, cid: out.cid, ...(isTid(out?.commit?.rev) ? { commitRev: out.commit.rev } : {}) };
                    delete e.lastError;
                    this.saveOutcome(e);
                    return this.deltaOf(e);
                }
                reason = `createRecord answered ${r.status} without the expected uri/cid`;
            } else {
                reason = `createRecord answered ${serverError(r)}`;
                // a 4xx was refused by the PDS; a 5xx may have committed
                uncertain = r.status >= 500;
            }
        } catch (err) {
            reason = (err as Error).message;
        }
        try {
            this.save({ ...e, lastError: reason });
        } catch {
            // the attempt is already on record; the diagnostic is optional
        }
        throw new PublishError(
            `publication ${key}: ${uncertain ? "outcome uncertain" : "refused"} (${reason}); ` +
            `nothing is sent again before the account's posts are listed — retry with the same publicationKey`,
            uncertain,
        );
    }

    /** The ledger entry's record in a complete, revision-stable inventory
     *  of the account's posts (slice 1's strict `readAccount`: every page
     *  validated, cursors checked, head bracketed), or null when that
     *  inventory does not hold it. Anything less — a malformed page, a moved
     *  head, an inactive account, any failure — throws, so nothing is sent.
     *  A record at our rkey must be exactly the record we sent. */
    private async findByListing(e: LedgerEntry): Promise<{ uri: string; cid: string; rev: string } | null> {
        const uri = `at://${e.account}/${POST_NSID}/${e.rkey}`;
        let read: AccountRead;
        try {
            read = await readAccount(e.account, this.opts.transport, { ...this.opts, collections: [POST_NSID] });
        } catch (err) {
            throw new PublishError(
                `publication ${e.key}: outcome still uncertain — the account's posts could not be read completely (${(err as Error).message}); nothing was sent`,
                true,
            );
        }
        if (!read.active || read.rev === undefined) {
            throw new PublishError(`publication ${e.key}: outcome still uncertain — ${e.account} is not active, so nothing can be confirmed; nothing was sent`, true);
        }
        const hit = read.records.find((r) => r.uri === uri);
        if (!hit) return null;
        if (!sameRecord(hit.value, { $type: POST_NSID, text: e.text, createdAt: e.createdAt })) {
            throw new PublishError(`publication ${e.key}: ${uri} holds a record that is not this publication; not crediting it and not resending`);
        }
        return { uri, cid: hit.cid, rev: read.rev };
    }
}

/** Exactly these keys with exactly these string values. */
function sameRecord(value: unknown, want: Record<string, string>): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const v = value as Record<string, unknown>;
    const keys = Object.keys(v);
    return keys.length === Object.keys(want).length && keys.every((k) => Object.prototype.hasOwnProperty.call(want, k) && v[k] === want[k]);
}

