/**
 * In-memory ATProto network for the mounted-reader tests: a PLC directory,
 * did:web hosts, one or more PDS hosts and an AppView, all behind the
 * language's injectable `Transport`. Responses are raw JSON text so the
 * lossless-number path is exercised exactly as on the wire.
 *
 * Fault injection: `faults` lets a test fail one request (status / hang)
 * or move a repo's head while an inventory is being read.
 */

import type { Transport, TransportResponse } from "../src/adapters.js";

export const PLC = "https://plc.test";
export const PDS = "https://pds.test";
export const PDS2 = "https://pds2.test";
export const APPVIEW = "https://appview.test";

export const ALICE = "did:plc:alice2222222222222222222";
export const BOB = "did:plc:bob333333333333333333333";
export const CAROL = "did:web:carol.example";

export const POST = "app.bsky.feed.post";
export const FOLLOW = "app.bsky.graph.follow";

/** A nested post exercising every lossless rule: arrays with duplicates,
 *  empty arrays, nulls, unknown fields, unknown union variant, `$bytes`,
 *  `$link`, a blob, a strong-ref reply and integers beyond 2^53. Raw text —
 *  JSON.parse would round the big integers. */
export const NESTED_POST_TEXT = `{
  "$type": "app.bsky.feed.post",
  "text": "Hello from We \u{1F44B} #hello",
  "createdAt": "2026-11-19T09:00:00.000Z",
  "langs": ["en", "de", "en"],
  "facets": [
    { "index": { "byteStart": 19, "byteEnd": 25 },
      "features": [ { "$type": "app.bsky.richtext.facet#tag", "tag": "hello" } ] }
  ],
  "reply": {
    "root":   { "uri": "at://${BOB}/app.bsky.feed.post/3kroot222222a", "cid": "bafyreiroot" },
    "parent": { "uri": "at://${BOB}/app.bsky.feed.post/3kparent22222", "cid": "bafyreiparent" }
  },
  "embed": {
    "$type": "app.bsky.embed.images",
    "images": [ { "alt": "", "image": { "$type": "blob", "ref": { "$link": "bafkreiblob" }, "mimeType": "image/png", "size": 1234 } } ]
  },
  "x.unknown.field": {
    "nested": [[], {}, null, [1, 2, 2]],
    "bytes": { "$bytes": "AAEC/w" },
    "big": 9007199254740993,
    "neg": -9223372036854775808,
    "variant": { "$type": "com.example.future#thing", "z": true, "a": false }
  },
  "emptyArr": [],
  "nullField": null
}`;

export interface FakeRecord {
    rkey: string;
    cid: string;
    /** raw JSON text of the record value */
    value: string;
}

export interface FakeRepo {
    did: string;
    pds: string;
    handle: string;
    active: boolean;
    status?: string;
    rev: string;
    commitCid: string;
    collections: Map<string, FakeRecord[]>;
}

export interface FakeLabel {
    src: string;
    uri: string;
    cid?: string;
    val: string;
    neg?: boolean;
    cts: string;
    exp?: string;
}

export type Fault =
    | { match: (url: string) => boolean; status: number; body?: string; once?: boolean }
    | { match: (url: string) => boolean; hang: true; once?: boolean }
    | { match: (url: string) => boolean; bumpRevOf: string; once?: boolean };

export function plainPost(text: string, createdAt = "2026-11-19T10:00:00.000Z"): string {
    return JSON.stringify({ $type: POST, text, createdAt });
}

export function followOf(subject: string, createdAt = "2026-11-19T10:00:00.000Z"): string {
    return JSON.stringify({ $type: FOLLOW, subject, createdAt });
}

let revCounter = 0;
function nextRev(): string {
    revCounter += 1;
    return "3lrev" + String(revCounter).padStart(8, "0");
}

export class FakeNet implements Transport {
    repos = new Map<string, FakeRepo>();
    /** did -> DID document JSON (as served) — lets a test serve a wrong doc */
    didDocs = new Map<string, unknown>();
    labels: FakeLabel[] = [];
    appviewUp = true;
    faults: Fault[] = [];
    /** every request URL, in order */
    log: string[] = [];

    addAccount(did: string, handle: string, pds = PDS): FakeRepo {
        const repo: FakeRepo = {
            did, pds, handle, active: true, rev: nextRev(), commitCid: "bafycommit" + revCounter,
            collections: new Map([[POST, []], [FOLLOW, []]]),
        };
        this.repos.set(did, repo);
        this.didDocs.set(did, this.docFor(did, handle, pds));
        return repo;
    }

    docFor(did: string, handle: string, pds: string): unknown {
        return {
            "@context": ["https://www.w3.org/ns/did/v1"],
            id: did,
            alsoKnownAs: [`at://${handle}`],
            verificationMethod: [],
            service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: pds }],
        };
    }

    setHandle(did: string, handle: string): void {
        const repo = this.repos.get(did)!;
        repo.handle = handle;
        this.didDocs.set(did, this.docFor(did, handle, repo.pds));
    }

    put(did: string, collection: string, rkey: string, value: string, cid?: string): void {
        const repo = this.repos.get(did)!;
        const list = repo.collections.get(collection) ?? [];
        const i = list.findIndex((r) => r.rkey === rkey);
        const rec = { rkey, cid: cid ?? `bafyrec${rkey}${revCounter + 1}`, value };
        if (i >= 0) list[i] = rec;
        else list.push(rec);
        repo.collections.set(collection, list);
        this.bump(did);
    }

    del(did: string, collection: string, rkey: string): void {
        const repo = this.repos.get(did)!;
        repo.collections.set(collection, (repo.collections.get(collection) ?? []).filter((r) => r.rkey !== rkey));
        this.bump(did);
    }

    bump(did: string): void {
        const repo = this.repos.get(did)!;
        repo.rev = nextRev();
        repo.commitCid = "bafycommit" + revCounter;
    }

    async fetch(url: string, method: string, _headers: Record<string, string>, _body: string): Promise<TransportResponse> {
        this.log.push(url);
        for (const f of [...this.faults]) {
            if (!f.match(url)) continue;
            if (f.once) this.faults.splice(this.faults.indexOf(f), 1);
            if ("hang" in f) return new Promise(() => {});
            if ("bumpRevOf" in f) {
                this.bump(f.bumpRevOf);
                continue;
            }
            return { status: f.status, headers: {}, body: f.body ?? JSON.stringify({ error: "Injected", message: `status ${f.status}` }) };
        }
        if (method !== "GET") return err(405, "MethodNotAllowed");
        const u = new URL(url);

        // PLC directory: GET <plc>/<did>
        if (u.origin === PLC) {
            const did = decodeURIComponent(u.pathname.slice(1));
            const doc = this.didDocs.get(did);
            return doc ? ok(JSON.stringify(doc)) : err(404, "NotFound");
        }
        // did:web: GET https://<host>/.well-known/did.json
        if (u.pathname === "/.well-known/did.json") {
            const did = "did:web:" + u.host;
            const doc = this.didDocs.get(did);
            return doc ? ok(JSON.stringify(doc)) : err(404, "NotFound");
        }
        if (u.origin === APPVIEW) {
            if (!this.appviewUp) return err(503, "Unavailable");
            if (u.pathname === "/xrpc/app.bsky.feed.getPosts") {
                const uris = u.searchParams.getAll("uris");
                const posts = uris.flatMap((uri) => {
                    const rec = this.findByUri(uri);
                    if (!rec) return [];
                    return [{ uri, cid: rec.cid, labels: this.labels.filter((l) => l.uri === uri) }];
                });
                return ok(JSON.stringify({ posts }));
            }
            return err(404, "MethodNotImplemented");
        }
        const xrpc = u.pathname.replace(/^\/xrpc\//, "");
        const repoParam = u.searchParams.get("repo") ?? u.searchParams.get("did") ?? "";
        const repo = this.repos.get(repoParam);
        if (!repo || repo.pds !== u.origin) return err(400, "RepoNotFound");
        switch (xrpc) {
            case "com.atproto.repo.describeRepo":
                // a real PDS (0.5.x) refuses describeRepo for an inactive repo
                if (!repo.active) return err(400, "RepoDeactivated");
                return ok(JSON.stringify({ did: repo.did, handle: repo.handle, handleIsCorrect: true, collections: [...repo.collections.keys()] }));
            case "com.atproto.sync.getRepoStatus":
                return ok(JSON.stringify({ did: repo.did, active: repo.active, ...(repo.status ? { status: repo.status } : {}), rev: repo.rev }));
            case "com.atproto.sync.getLatestCommit":
                if (!repo.active) return err(400, "RepoDeactivated");
                return ok(JSON.stringify({ cid: repo.commitCid, rev: repo.rev }));
            case "com.atproto.repo.listRecords": {
                if (!repo.active) return err(400, "RepoDeactivated");
                const collection = u.searchParams.get("collection") ?? "";
                const limit = Number(u.searchParams.get("limit") ?? "50");
                const cursor = u.searchParams.get("cursor");
                // newest first, like a PDS (descending rkey)
                const all = [...(repo.collections.get(collection) ?? [])].sort((a, b) => (a.rkey < b.rkey ? 1 : -1));
                const start = cursor ? all.findIndex((r) => r.rkey < cursor) : 0;
                const page = start < 0 ? [] : all.slice(start, start + limit);
                const next = start >= 0 && start + limit < all.length ? page[page.length - 1].rkey : undefined;
                const records = page.map((r) => `{"uri":${JSON.stringify(`at://${repo.did}/${collection}/${r.rkey}`)},"cid":${JSON.stringify(r.cid)},"value":${r.value}}`);
                return ok(`{${next ? `"cursor":${JSON.stringify(next)},` : ""}"records":[${records.join(",")}]}`);
            }
        }
        return err(404, "MethodNotImplemented");
    }

    findByUri(uri: string): FakeRecord | undefined {
        const m = uri.match(/^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/);
        if (!m) return undefined;
        return this.repos.get(m[1])?.collections.get(m[2])?.find((r) => r.rkey === m[3]);
    }

    /** request URLs since `mark` matching `re` */
    requests(re: RegExp, mark = 0): string[] {
        return this.log.slice(mark).filter((u) => re.test(u));
    }
}

function ok(body: string): TransportResponse {
    return { status: 200, headers: { "content-type": "application/json" }, body };
}

function err(status: number, error: string): TransportResponse {
    return { status, headers: {}, body: JSON.stringify({ error, message: error }) };
}

/** A standard two-account network (+ did:web carol) used by most tests. */
export function standardNet(): FakeNet {
    const net = new FakeNet();
    net.addAccount(ALICE, "alice.test");
    net.addAccount(BOB, "bob.test");
    net.addAccount(CAROL, "carol.example", PDS2);
    net.put(ALICE, POST, "3kalice00001a", plainPost("alice one"));
    net.put(ALICE, POST, "3kalice00002a", plainPost("alice two"));
    net.put(ALICE, FOLLOW, "3kfollow0001a", followOf(BOB));
    net.put(BOB, POST, "3kbob0000001a", plainPost("bob one"));
    net.put(CAROL, POST, "3kcarol00001a", plainPost("carol one"));
    return net;
}

export const baseConfig = {
    plcUrl: PLC,
    appviewUrl: APPVIEW,
    timeoutMs: 200,
    pageLimit: 100,
    maxPages: 50,
};
