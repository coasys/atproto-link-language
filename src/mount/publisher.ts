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
import { newTid } from "./bytes.js";
import { withDeadline } from "./dpop.js";
import { parseLossless } from "./lossless-json.js";
import { postEntry, type MountEntry } from "./mapping.js";
import { OAuthClient, serverError } from "./oauth.js";
import { POST_NSID, isTid, resolveDid, type ReaderConfig } from "./reader.js";
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
    lastError?: string;
}

/** What a `call` returns (acorn a2 MountDelta): the created address and
 *  its entry; addresses carry no `<lang>://` prefix. */
export interface CallDelta {
    address: string;
    changed: MountEntry[];
    removed: string[];
}

export interface PublisherOptions extends ReaderConfig {
    transport: Transport;
    storage: StorageLike;
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
const DID = /^did:(plc:[a-z2-7]{24}|web:[a-zA-Z0-9.%-]+)$/;
const MAX_GRAPHEMES = 300;
const MAX_BYTES = 3000;

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
    private readonly now: () => Date;

    constructor(private readonly opts: PublisherOptions) {
        this.now = opts.now ?? (() => new Date());
    }

    // ---- ledger ----

    ledgerEntry(key: string): LedgerEntry | null {
        if (typeof key !== "string" || !KEY.test(key)) return null;
        const raw = this.opts.storage.get(ledgerKeys.entry(this.opts.agentDid(), key));
        if (!raw) return null;
        try {
            const e = JSON.parse(raw);
            return e && e.v === 1 && e.key === key ? (e as LedgerEntry) : null;
        } catch {
            return null;
        }
    }

    private save(e: LedgerEntry): void {
        const agent = this.opts.agentDid();
        this.opts.storage.put(ledgerKeys.entry(agent, e.key), JSON.stringify(e));
        const keys = this.indexKeys();
        if (!keys.includes(e.key)) this.opts.storage.put(ledgerKeys.index(agent), JSON.stringify([...keys, e.key]));
    }

    private indexKeys(): string[] {
        try {
            const v = JSON.parse(this.opts.storage.get(ledgerKeys.index(this.opts.agentDid())) ?? "[]");
            return Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : [];
        } catch {
            return [];
        }
    }

    /** Published ledger entries of the current executor user. */
    published(): LedgerEntry[] {
        return this.indexKeys().map((k) => this.ledgerEntry(k)).filter((e): e is LedgerEntry => e?.state === "published");
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

    /** The reader's entries with the ledger applied: a published post
     *  carries its `publicationKey`, and a post published here but not yet
     *  in an accepted read at or after its commit is served from the ledger
     *  (so the executor's sweep does not remove it in between). */
    decorate(entries: MountEntry[], acceptedRev: (did: string) => string | undefined): MountEntry[] {
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
            if (seen.has(address)) continue;
            const acc = acceptedRev(e.account);
            if (e.commitRev !== undefined && (acc === undefined || acc < e.commitRev)) out.push(this.entryOf(e));
        }
        out.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
        return out;
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
        if (!this.opts.oauth.hasSession(account)) {
            throw new PublishError(`${account} is not authorized for this executor user: run authorize first`);
        }
        if (!e) {
            const now = this.now();
            const clock = this.opts.crypto.getRandomValues(new Uint16Array(1))[0] & 1023;
            e = { v: 1, key, account, text, createdAt: now.toISOString(), rkey: newTid(now.getTime(), clock), state: "pending", attempts: 0 };
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
            const found = await this.findByListing(pds, e);
            if (found) {
                e = { ...e, state: "published", uri: found.uri, cid: found.cid, commitRev: found.rev };
                delete e.lastError;
                this.save(e);
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
                    this.save(e);
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
        e = { ...e, lastError: reason };
        this.save(e);
        throw new PublishError(
            `publication ${key}: ${uncertain ? "outcome uncertain" : "refused"} (${reason}); ` +
            `nothing is sent again before the account's posts are listed — retry with the same publicationKey`,
            uncertain,
        );
    }

    private async getJson(url: string, what: string): Promise<any> {
        const r = await withDeadline(this.opts.transport.fetch(url, "GET", { accept: "application/json" }, ""), this.opts.timeoutMs ?? 15_000, what);
        if (r.status < 200 || r.status > 299) throw new Error(`${what} -> ${r.status}`);
        return parseLossless(String(r.body));
    }

    /** The ledger entry's record in the account's complete post listing,
     *  or null when a complete listing does not hold it. Anything less than
     *  a complete listing throws (and so sends nothing). */
    private async findByListing(pds: string, e: LedgerEntry): Promise<{ uri: string; cid: string; rev?: string } | null> {
        const uri = `at://${e.account}/${POST_NSID}/${e.rkey}`;
        const maxPages = this.opts.maxPages ?? 50;
        let cursor: string | undefined;
        const seen = new Set<string>();
        let hit: { uri: string; cid: string } | null = null;
        try {
            for (let page = 0; ; page++) {
                if (page >= maxPages) throw new Error(`more than ${maxPages} pages`);
                const q = new URLSearchParams({ repo: e.account, collection: POST_NSID, limit: String(this.opts.pageLimit ?? 100) });
                if (cursor) q.set("cursor", cursor);
                const j = await this.getJson(`${pds}/xrpc/com.atproto.repo.listRecords?${q}`, "listRecords");
                for (const rec of Array.isArray(j?.records) ? j.records : []) {
                    if (rec?.uri !== uri) continue;
                    if (rec?.value?.text !== e.text || typeof rec?.cid !== "string") {
                        throw new PublishError(`publication ${e.key}: ${uri} holds a different record; not marking it published`);
                    }
                    hit = { uri, cid: rec.cid };
                }
                if (hit) break;
                const next = typeof j?.cursor === "string" && j.cursor ? j.cursor : undefined;
                if (!next) break;
                if (seen.has(next)) throw new Error("listRecords repeated a cursor");
                seen.add(next);
                cursor = next;
            }
        } catch (err) {
            if (err instanceof PublishError) throw err;
            throw new PublishError(
                `publication ${e.key}: outcome still uncertain — the account's posts could not be listed (${(err as Error).message}); nothing was sent`,
                true,
            );
        }
        if (!hit) return null;
        // a head at or after the record's commit, for the snapshot overlay
        let rev: string | undefined;
        try {
            const head = await this.getJson(`${pds}/xrpc/com.atproto.sync.getLatestCommit?did=${encodeURIComponent(e.account)}`, "getLatestCommit");
            if (isTid(head?.rev)) rev = head.rev;
        } catch {
            // no overlay then; the next read shows it
        }
        return { ...hit, ...(rev ? { rev } : {}) };
    }
}
