/**
 * Read side of the mounted ATProto reader: DID resolution, a complete
 * revision-pinned inventory of one account's selected collections, and
 * AppView label lookup. Public, unauthenticated reads only — no session,
 * no app password, no OAuth. All HTTP goes through the injectable
 * `Transport` (src/adapters.ts).
 *
 * An inventory is all-or-nothing: any non-2xx (429 included), timeout,
 * malformed body, foreign record, endless cursor, page-limit overrun or a
 * repo head that moved while the pages were read rejects it. The caller
 * then keeps its last complete inventory (state.ts) — omission from a
 * failed read never counts as deletion.
 */

import type { Transport } from "../adapters.js";
import { parseLossless, stringifyLossless } from "./lossless-json.js";

export const POST_NSID = "app.bsky.feed.post";
export const FOLLOW_NSID = "app.bsky.graph.follow";
export const DEFAULT_COLLECTIONS = [POST_NSID, FOLLOW_NSID];

export interface ReaderConfig {
    /** PLC directory base URL, e.g. https://plc.directory */
    plcUrl: string;
    /** AppView base URL for labels; empty = moderation unavailable */
    appviewUrl?: string;
    /** per-request timeout */
    timeoutMs?: number;
    /** listRecords page size (max 100) */
    pageLimit?: number;
    /** pages per collection before the read counts as incomplete */
    maxPages?: number;
    collections?: string[];
}

export interface ResolvedAccount {
    did: string;
    handle?: string;
    pds: string;
}

export interface RawRecord {
    uri: string;
    cid: string;
    collection: string;
    rkey: string;
    /** lossless parse of the record value */
    value: unknown;
}

export interface AccountRead extends ResolvedAccount {
    active: boolean;
    status?: string;
    rev?: string;
    commitCid?: string;
    records: RawRecord[];
}

export interface Label {
    src: string;
    uri: string;
    cid?: string;
    val: string;
    neg?: boolean;
    cts: string;
    exp?: string;
    [k: string]: unknown;
}

export class ReadError extends Error {}

const DID_PLC = /^did:plc:[a-z2-7]{24}$/;
const DID_WEB = /^did:web:([a-zA-Z0-9.-]+(?:%3[aA]\d+)?)$/;
const NSID = /^[a-zA-Z][a-zA-Z0-9-]*(\.[a-zA-Z0-9-]+){2,}$/;
const RKEY = /^[A-Za-z0-9._:~-]{1,512}$/;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const t = new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new ReadError(`${what} timed out after ${ms} ms`)), ms);
    });
    return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

async function getText(transport: Transport, url: string, cfg: ReaderConfig): Promise<string> {
    const what = "GET " + url.split("?")[0];
    const res = await withTimeout(
        transport.fetch(url, "GET", { accept: "application/json" }, ""),
        cfg.timeoutMs ?? 15000,
        what,
    );
    if (res.status < 200 || res.status > 299) {
        throw new ReadError(`${what} -> ${res.status}${res.status === 429 ? " (rate limited)" : ""}: ${String(res.body).slice(0, 200)}`);
    }
    return res.body;
}

async function getJson(transport: Transport, url: string, cfg: ReaderConfig): Promise<any> {
    const body = await getText(transport, url, cfg);
    try {
        return parseLossless(body);
    } catch (e) {
        throw new ReadError(`GET ${url.split("?")[0]}: invalid JSON (${(e as Error).message})`);
    }
}

function httpBase(endpoint: unknown): string {
    if (typeof endpoint !== "string") throw new ReadError("PDS endpoint is not a string");
    let u: URL;
    try {
        u = new URL(endpoint);
    } catch {
        throw new ReadError(`PDS endpoint is not a URL: ${endpoint}`);
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new ReadError(`PDS endpoint must be http(s): ${endpoint}`);
    if (u.username || u.password || u.search || u.hash) throw new ReadError(`PDS endpoint must be a bare origin: ${endpoint}`);
    return u.origin + u.pathname.replace(/\/+$/, "");
}

/** Resolve an account DID to its PDS through its DID document. did:plc via
 *  the configured PLC directory; did:web (hostname form only) via
 *  https://<host>/.well-known/did.json. The document's `id` must be the
 *  requested DID; no fallback PDS, handle lookup or default is ever used. */
export async function resolveDid(did: string, transport: Transport, cfg: ReaderConfig): Promise<ResolvedAccount> {
    if (typeof did !== "string" || !did.startsWith("did:")) throw new ReadError(`not a DID: ${did}`);
    let url: string;
    if (did.startsWith("did:plc:")) {
        if (!DID_PLC.test(did)) throw new ReadError(`malformed did:plc: ${did}`);
        url = `${cfg.plcUrl.replace(/\/+$/, "")}/${did}`;
    } else if (did.startsWith("did:web:")) {
        const m = DID_WEB.exec(did);
        if (!m) throw new ReadError(`did:web must be a bare hostname (no path): ${did}`);
        url = `https://${decodeURIComponent(m[1])}/.well-known/did.json`;
    } else {
        throw new ReadError(`unsupported DID method for an ATProto account: ${did}`);
    }
    let doc: any;
    try {
        doc = await getJson(transport, url, cfg);
    } catch (e) {
        throw new ReadError(`cannot resolve ${did}: ${(e as Error).message}`);
    }
    if (!doc || doc.id !== did) throw new ReadError(`cannot resolve ${did}: DID document id is ${JSON.stringify(doc?.id)}`);
    const services = Array.isArray(doc.service) ? doc.service : [];
    const svc = services.find((s: any) =>
        (s?.id === "#atproto_pds" || s?.id === `${did}#atproto_pds`) && s?.type === "AtprotoPersonalDataServer");
    if (!svc) throw new ReadError(`cannot resolve ${did}: no #atproto_pds service`);
    const pds = httpBase(svc.serviceEndpoint);
    const aka = Array.isArray(doc.alsoKnownAs) ? doc.alsoKnownAs : [];
    const handleUri = aka.find((a: unknown) => typeof a === "string" && a.startsWith("at://"));
    // The handle is display metadata only: identity is the DID. It is not
    // bidirectionally verified here (next slice).
    return { did, ...(handleUri ? { handle: handleUri.slice("at://".length) } : {}), pds };
}

function q(params: Record<string, string | undefined>): string {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.append(k, v);
    return u.toString();
}

/** One complete, revision-pinned inventory of `did`'s collections. */
export async function readAccount(did: string, transport: Transport, cfg: ReaderConfig): Promise<AccountRead> {
    const acct = await resolveDid(did, transport, cfg);
    const xrpc = (m: string, params: Record<string, string | undefined>) => `${acct.pds}/xrpc/${m}?${q(params)}`;

    const status = await getJson(transport, xrpc("com.atproto.sync.getRepoStatus", { did }), cfg);
    if (status?.did !== did || typeof status?.active !== "boolean") throw new ReadError(`getRepoStatus for ${did}: malformed answer`);
    if (!status.active) {
        // Deactivated / taken down / suspended: a complete answer — the
        // account has no visible records right now.
        // (Status first: a PDS refuses describeRepo for an inactive repo.)
        return { ...acct, active: false, status: typeof status.status === "string" ? status.status : "inactive", records: [] };
    }

    const desc = await getJson(transport, xrpc("com.atproto.repo.describeRepo", { repo: did }), cfg);
    if (desc?.did !== did) throw new ReadError(`describeRepo on ${acct.pds} answered for ${JSON.stringify(desc?.did)}, not ${did}`);

    const head = async () => {
        const c = await getJson(transport, xrpc("com.atproto.sync.getLatestCommit", { did }), cfg);
        if (typeof c?.rev !== "string" || typeof c?.cid !== "string") throw new ReadError(`getLatestCommit for ${did}: malformed answer`);
        return { rev: c.rev as string, cid: c.cid as string };
    };
    const start = await head();

    const records: RawRecord[] = [];
    const pageLimit = Math.min(Math.max(cfg.pageLimit ?? 100, 1), 100);
    const maxPages = cfg.maxPages ?? 50;
    for (const collection of cfg.collections ?? DEFAULT_COLLECTIONS) {
        if (!NSID.test(collection)) throw new ReadError(`bad collection NSID ${collection}`);
        let cursor: string | undefined;
        const seen = new Set<string>();
        for (let page = 0; ; page++) {
            if (page >= maxPages) throw new ReadError(`${did} ${collection}: more than ${maxPages} pages — inventory incomplete`);
            const res = await getJson(transport, xrpc("com.atproto.repo.listRecords", { repo: did, collection, limit: String(pageLimit), cursor }), cfg);
            if (!res || !Array.isArray(res.records)) throw new ReadError(`listRecords ${did} ${collection}: malformed page`);
            for (const r of res.records) {
                const uri = r?.uri;
                const m = typeof uri === "string" ? /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri) : null;
                if (!m) throw new ReadError(`listRecords ${did}: malformed record URI ${JSON.stringify(uri)}`);
                if (m[1] !== did) throw new ReadError(`listRecords ${did}: record ${uri} names another repo`);
                if (m[2] !== collection) throw new ReadError(`listRecords ${did}: record ${uri} is outside ${collection}`);
                if (!RKEY.test(m[3]) || m[3] === "." || m[3] === "..") throw new ReadError(`listRecords ${did}: bad record key in ${uri}`);
                if (typeof r.cid !== "string" || !r.cid) throw new ReadError(`listRecords ${did}: record ${uri} has no CID`);
                if (!r.value || typeof r.value !== "object" || Array.isArray(r.value)) throw new ReadError(`listRecords ${did}: record ${uri} has no object value`);
                records.push({ uri, cid: r.cid, collection, rkey: m[3], value: r.value });
            }
            if (res.cursor === undefined || res.cursor === null || res.cursor === "") break;
            if (typeof res.cursor !== "string") throw new ReadError(`listRecords ${did}: malformed cursor`);
            if (seen.has(res.cursor) || res.records.length === 0) throw new ReadError(`listRecords ${did} ${collection}: cursor ${res.cursor} repeats — inventory incomplete`);
            seen.add(res.cursor);
            cursor = res.cursor;
        }
    }

    const end = await head();
    if (end.rev !== start.rev || end.cid !== start.cid) {
        throw new ReadError(`${did}: repo revision moved from ${start.rev} to ${end.rev} during the read — inventory not stable`);
    }
    const uris = new Set<string>();
    for (const r of records) {
        if (uris.has(r.uri)) throw new ReadError(`${did}: record ${r.uri} listed twice`);
        uris.add(r.uri);
    }
    return { ...acct, active: true, rev: start.rev, commitCid: start.cid, records };
}

/** AppView labels for post URIs: uri -> labels, or `null` when moderation
 *  data is unavailable (no AppView configured, or any request failed). */
export async function fetchLabels(uris: string[], transport: Transport, cfg: ReaderConfig): Promise<Map<string, Label[]> | null> {
    if (!cfg.appviewUrl) return null;
    const base = cfg.appviewUrl.replace(/\/+$/, "");
    const out = new Map<string, Label[]>();
    try {
        for (let i = 0; i < uris.length; i += 25) {
            const batch = uris.slice(i, i + 25);
            const res = await getJson(transport, `${base}/xrpc/app.bsky.feed.getPosts?${q({})}${batch.map((u) => "uris=" + encodeURIComponent(u)).join("&")}`, cfg);
            if (!res || !Array.isArray(res.posts)) return null;
            for (const p of res.posts) {
                if (typeof p?.uri !== "string") continue;
                const labels = Array.isArray(p.labels) ? p.labels : [];
                out.set(p.uri, labels.filter((l: any) => l && typeof l.val === "string" && typeof l.src === "string").map(cleanLabel));
            }
        }
    } catch {
        return null;
    }
    return out;
}

/** Keep a label's fields as served (sig included when present), JSON-safe. */
function cleanLabel(l: any): Label {
    return parseLossless(stringifyLossless(l)) as Label;
}
