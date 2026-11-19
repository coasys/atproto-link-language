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
import { TimeoutError, withDeadline } from "./dpop.js";
import { TidClock, randomB64u } from "./bytes.js";
import { LedgerBusy, LedgerLock } from "./ledger-lock.js";
import { postEntry, type MountEntry } from "./mapping.js";
import { OAuthClient, OAuthError, serverError } from "./oauth.js";
import { POST_NSID, isTid, readAccount, resolveDid, type AccountRead, type ReaderConfig } from "./reader.js";
import type { StorageLike } from "./vault.js";

export class PublishError extends Error {
    constructor(message: string, readonly uncertain = false, readonly code = "INVALID_REQUEST") {
        super(message);
    }
}

/** The fixed sentence for every failure that crosses the publication
 *  boundary (round 3 #1). The message is `publication <key>: <CODE>:
 *  <sentence>`, plus at most a detail built here from local facts or an
 *  allowlisted protocol identifier — never a server's text, a URL or an
 *  inner error's message. */
const SENTENCES = {
    LEDGER_UNREADABLE: "the ledger entry is unreadable; nothing was sent",
    NO_ATOMIC_WRITE: "this executor has no atomic durable storage write (host writeStorageFileAtomic): publishing is disabled; nothing was sent",
    LEDGER_WRITE_FAILED: "the ledger write failed; nothing was sent after it",
    LEDGER_BUSY: "another writer holds this ledger; nothing was sent — retry later",
    OUTCOME_NOT_RECORDED: "the post was created but the ledger could not record it — retry with the same publicationKey; it reads the account's posts first",
    NOT_AUTHORIZED: "the account is not authorized for this executor user: run authorize (again); nothing was sent",
    AUTH_FAILED: "the account's authorization could not be used; nothing was sent",
    ACCOUNT_UNRESOLVED: "the account's DID could not be resolved to a PDS; nothing was sent",
    ACCOUNT_MOVED: "the account's DID names another PDS than the authorized one: authorize again; nothing was sent",
    CREATE_UNCERTAIN: "outcome uncertain: createRecord may have been applied; nothing is sent again before the account's posts are read — retry with the same publicationKey",
    CREATE_REFUSED: "createRecord was refused; nothing is sent again before the account's posts are read — retry with the same publicationKey",
    RECONCILE_READ_FAILED: "outcome still uncertain — the account's posts could not be read completely; nothing was sent",
    RECONCILE_ACCOUNT_INACTIVE: "outcome still uncertain — the account is not active, so nothing can be confirmed; nothing was sent",
    RECONCILE_CONFLICT: "the record at this publication's rkey is not this publication; not crediting it and not resending",
} as const;
export type PublishCode = keyof typeof SENTENCES;

function fail(key: string, code: PublishCode, opts: { uncertain?: boolean; detail?: string } = {}): PublishError {
    return new PublishError(`publication ${key}: ${code}: ${SENTENCES[code]}${opts.detail ? ` (${opts.detail})` : ""}`, !!opts.uncertain, code);
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
    /** the atomic write AND the lock primitives (exclusive create, remove) exist */
    atomic(): boolean;
    read(name: string): string | null;
    writeAtomic(name: string, content: string): void;
    /** O_EXCL create; throws an error named AlreadyExists (host createStorageFileExclusive) */
    createExclusive(name: string, content: string): void;
    /** throws an error named NotFound (host removeStorageFile) */
    remove(name: string): void;
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
    /** a ledger lock older than this belongs to a dead writer (default 5 min) */
    lockStaleMs?: number;
    /** how long to wait for another writer's lock (default 30 s) */
    lockWaitMs?: number;
}

const KEY = /^[A-Za-z0-9._:~-]{8,128}$/;
const DID = /^did:(plc:[a-z2-7]{24}|web:[a-zA-Z0-9.%-]+)$/;
const MAX_GRAPHEMES = 300;
const MAX_BYTES = 3000;

export const ledgerFiles = {
    entry: (agent: string, key: string) => `publish-ledger.${agent}.${key}.json`,
    index: (agent: string) => `publish-ledger.${agent}.index.json`,
    lock: (agent: string) => `publish-ledger.${agent}.lock`,
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
    /** rkeys: monotonic per process, seeded from the ledger on first use */
    private tids: TidClock | null = null;
    /** one publication at a time in this process; the file lock across processes */
    private queue: Promise<unknown> = Promise.resolve();
    private lockHandle: LedgerLock | null = null;
    private readonly owner: string;
    /** read-back states not yet written (a failed ledger write keeps them here) */
    private readonly readBackMem = new Map<string, "confirmed" | "deleted">();
    private readonly now: () => Date;

    constructor(private readonly opts: PublisherOptions) {
        this.now = opts.now ?? (() => new Date());
        this.owner = randomB64u(opts.crypto, 12);
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
            } catch {
                throw fail(key, "LEDGER_UNREADABLE");
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
            throw fail(key, "LEDGER_UNREADABLE");
        }
        return e as LedgerEntry;
    }

    /** Write `e` durably and atomically, or throw: nothing may be sent on
     *  the strength of an unacknowledged write. */
    private save(e: LedgerEntry): void {
        const files = this.files();
        if (!files) throw fail(e.key, "NO_ATOMIC_WRITE");
        const agent = this.opts.agentDid();
        try {
            const keys = this.indexKeys();
            // index first: a key listed without an entry file is ignored
            if (!keys.includes(e.key)) files.writeAtomic(ledgerFiles.index(agent), JSON.stringify([...keys, e.key]));
            files.writeAtomic(ledgerFiles.entry(agent, e.key), JSON.stringify(e));
        } catch {
            throw fail(e.key, "LEDGER_WRITE_FAILED");
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
            // a writer that lost the lock records nothing; the next one reads the PDS
            if (!this.lock().owned()) throw new Error("lock lost");
            this.save(e);
        } catch (err) {
            throw fail(e.key, "OUTCOME_NOT_RECORDED", { uncertain: true });
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
    /** Called under the ledger lock: above every rkey in the ledger as it
     *  is now (another process may have added some since the last call). */
    private nextRkey(now: Date): string {
        if (!this.tids) this.tids = new TidClock(this.opts.crypto.getRandomValues(new Uint16Array(1))[0] & 1023);
        for (const k of this.indexKeys()) {
            try {
                const e = this.ledgerEntry(k);
                if (e) this.tids.observe(e.rkey);
            } catch {
                // unreadable entries are refused when used
            }
        }
        return this.tids.next(now.getTime());
    }

    private lock(): LedgerLock {
        if (!this.lockHandle) {
            this.lockHandle = new LedgerLock(this.opts.files!, ledgerFiles.lock(this.opts.agentDid()), this.owner,
                () => Date.now(), this.opts.lockStaleMs ?? 300_000, this.opts.lockWaitMs ?? 30_000);
        }
        return this.lockHandle;
    }

    private readBackOf(e: LedgerEntry): LedgerEntry["readBack"] {
        return this.readBackMem.get(e.key) ?? e.readBack;
    }

    /** Persist a read-back state if the ledger lock is free right now (a
     *  refresh never waits for a publication); otherwise, or on a failed
     *  write, keep it in memory — the next accepted read sets it again. */
    private markReadBack(e: LedgerEntry, state: "confirmed" | "deleted"): void {
        this.readBackMem.set(e.key, state);
        if (!this.files()) return;
        const lock = this.lock();
        let held = false;
        try {
            held = lock.tryAcquire();
            if (!held) return;
            const now = this.ledgerEntry(e.key);
            if (now) this.save({ ...now, readBack: state });
            this.readBackMem.delete(e.key);
        } catch {
            // memory only
        } finally {
            if (held) lock.release();
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
            } catch {
                return `cannot check the omitted publication ${uri}`;
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
    /** One publication at a time: in this process through a queue, across
     *  processes sharing the storage dir through the ledger lock file. A
     *  published key answers from the ledger without the lock. */
    publish(params: PublishParams): Promise<CallDelta> {
        const { text, atAuthor, publicationKey } = this.validate(params);
        const run = this.queue.catch(() => undefined).then(async () => {
            const e = this.ledgerEntry(publicationKey);
            if (e?.state === "published" && e.account === atAuthor && e.text === text) return this.deltaOf(e);
            if (!this.files()) throw fail(publicationKey, "NO_ATOMIC_WRITE");
            const lock = this.lock();
            try {
                await lock.acquire();
            } catch (err) {
                if (err instanceof LedgerBusy) throw fail(publicationKey, "LEDGER_BUSY");
                throw fail(publicationKey, "LEDGER_WRITE_FAILED");
            }
            try {
                return await this.publishLocked(text, atAuthor, publicationKey);
            } finally {
                lock.release();
            }
        });
        this.queue = run;
        return run;
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
        if (!this.files()) throw fail(key, "NO_ATOMIC_WRITE");
        if (!this.opts.oauth.hasSession(account)) {
            throw fail(key, "NOT_AUTHORIZED");
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
        } catch (err) {
            throw fail(key, err instanceof OAuthError && err.code === "NOT_AUTHORIZED" ? "NOT_AUTHORIZED" : "AUTH_FAILED");
        }
        try {
            // account check: the DID still points at the PDS the session is for
            pds = (await resolveDid(account, this.opts.transport, this.opts)).pds;
        } catch {
            throw fail(key, "ACCOUNT_UNRESOLVED");
        }
        if (new URL(pds).origin !== new URL(access.session.pds).origin) throw fail(key, "ACCOUNT_MOVED");

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
        this.lock().touch();
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
                reason = `HTTP ${r.status} without the expected uri/cid`;
            } else {
                reason = `HTTP ${serverError(r)}`;
                // a 4xx was refused by the PDS; a 5xx may have committed
                uncertain = r.status >= 500;
            }
        } catch (err) {
            // never the transport's message: it may name a server-derived URL
            reason = err instanceof TimeoutError ? "timed out" : "transport error";
        }
        try {
            this.save({ ...e, lastError: reason });
        } catch {
            // the attempt is already on record; the diagnostic is optional
        }
        throw fail(key, uncertain ? "CREATE_UNCERTAIN" : "CREATE_REFUSED", { uncertain, detail: reason });
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
        } catch {
            // never the reader's message: it may quote a body or a server field
            throw fail(e.key, "RECONCILE_READ_FAILED", { uncertain: true });
        }
        if (!read.active || read.rev === undefined) throw fail(e.key, "RECONCILE_ACCOUNT_INACTIVE", { uncertain: true });
        const hit = read.records.find((r) => r.uri === uri);
        if (!hit) return null;
        if (!sameRecord(hit.value, { $type: POST_NSID, text: e.text, createdAt: e.createdAt })) {
            throw fail(e.key, "RECONCILE_CONFLICT");
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

