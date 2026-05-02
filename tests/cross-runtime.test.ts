/**
 * Cross-runtime test harness.
 *
 * Exercises the full production modules (store, xrpc, sync, translate,
 * dual-language, auth) using mock adapters that simulate an alternative
 * runtime (e.g. WASM).
 *
 * This proves that the core logic has NO hidden dependency on ad4m:host —
 * every external call goes through the injected adapters.
 *
 * Test scenarios:
 * 1. Store links via mock storage, query them back, verify indexes
 * 2. Translate links to write operations, verify record structure
 * 3. Sync from PDS with mock transport providing paginated responses
 * 4. Full round-trip: link → triple record → link → store → query
 * 5. Dual-language origin tracking with mock storage
 * 6. Settings parse in cross-runtime context
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Adapter interfaces
import type { StorageAdapter } from "../src/storage-interface.js";
import { initStorage, getStorage } from "../src/storage-interface.js";
import type { Transport, TransportResponse } from "../src/transport.js";
import { initTransport } from "../src/transport.js";
import type { SigningAdapter } from "../src/signing-interface.js";
import { initSigning } from "../src/signing-interface.js";
import type { RuntimeAdapter } from "../src/runtime-interface.js";
import { initRuntime } from "../src/runtime-interface.js";

// Production modules under test
import * as store from "../src/store.js";
import { linkToTripleRecord, tripleRecordToLink, diffToWriteOps, recordToLink, linkContentKey } from "../src/translate.pure.js";
import { translateDiffToWrites } from "../src/translate.js";
import { syncFromPDS, getCursor, setCursor, getSyncStatus } from "../src/sync.js";
import { shouldFederate, linkOriginKey, linkContentHash, isDuplicate } from "../src/dual-language.js";
import { detectPattern, patternToBlueskyType } from "../src/sdna.js";
import { parseSettings, DEFAULT_SETTINGS } from "../src/settings.js";
import { generateFacets, extractLinks, extractMentions, facetsToLinkPredicates } from "../src/rendering.pure.js";
import { validateTripleRecord, validateNeighbourhoodRecord, TRIPLE_COLLECTION } from "../src/lexicon.js";
import { parseJwtExp, isJwtExpired } from "../src/auth.js";
import {
    tidFromISO,
    tidNow,
    buildAtUri,
    rkeyFromUri,
    collectionFromUri,
    didFromUri,
    parseSessionResponse,
    parseListRecordsResponse,
} from "../src/xrpc.pure.js";

import type { LinkExpression, PerspectiveDiff, Ad4mLinkTriple } from "../src/types.js";

// ---------------------------------------------------------------------------
// Mock Adapters
// ---------------------------------------------------------------------------

class MockStorageAdapter implements StorageAdapter {
    private data = new Map<string, string>();

    get(key: string): string | null {
        return this.data.get(key) ?? null;
    }
    put(key: string, value: string): void {
        this.data.set(key, value);
    }
    delete(key: string): void {
        this.data.delete(key);
    }
    listKeys(prefix?: string): string[] {
        const all = [...this.data.keys()];
        if (!prefix) return all;
        return all.filter(k => k.startsWith(prefix));
    }
    _dump(): Map<string, string> {
        return new Map(this.data);
    }
    _clear(): void {
        this.data.clear();
    }
}

interface RecordedRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
}

class MockTransport implements Transport {
    private responses = new Map<string, TransportResponse>();
    public requests: RecordedRequest[] = [];

    addResponse(urlMatch: string, response: TransportResponse): void {
        this.responses.set(urlMatch, response);
    }

    async fetch(
        url: string,
        method: string,
        headers: Record<string, string>,
        body: string,
    ): Promise<TransportResponse> {
        this.requests.push({ url, method, headers, body });
        for (const [match, response] of this.responses) {
            if (url.includes(match)) return response;
        }
        return { status: 404, headers: {}, body: '{"error":"not found"}' };
    }
}

class MockRuntime implements RuntimeAdapter {
    public emittedDiffs: unknown[] = [];
    public emittedSignals: string[] = [];

    hash(data: string): string {
        let h = 0;
        for (let i = 0; i < data.length; i++) {
            h = ((h << 5) - h + data.charCodeAt(i)) | 0;
        }
        return `Qm${Math.abs(h).toString(16)}`;
    }

    emitSignal(data: string): void {
        this.emittedSignals.push(data);
    }

    emitPerspectiveDiff(diff: unknown): void {
        this.emittedDiffs.push(diff);
    }
}

class MockSigning implements SigningAdapter {
    signStringHex(payload: string): string {
        return `mock-sig-${payload.substring(0, 8)}`;
    }
    signingKeyId(): string {
        return "mock-key-id";
    }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let mockStorage: MockStorageAdapter;
let mockTransport: MockTransport;
let mockRuntime: MockRuntime;
let mockSigning: MockSigning;

function simpleHash(data: string): string {
    let h = 0;
    for (let i = 0; i < data.length; i++) {
        h = ((h << 5) - h + data.charCodeAt(i)) | 0;
    }
    return `Qm${Math.abs(h).toString(16)}`;
}

function makeLinkExpression(overrides?: Partial<LinkExpression>): LinkExpression {
    return {
        author: "did:key:z6MkTest",
        timestamp: "2026-05-02T00:00:00.000Z",
        data: {
            source: "literal://hello",
            target: "literal://world",
            predicate: "sioc://content_of",
        },
        proof: { signature: "abc123", key: "key123" },
        ...overrides,
    };
}

beforeEach(() => {
    mockStorage = new MockStorageAdapter();
    mockTransport = new MockTransport();
    mockRuntime = new MockRuntime();
    mockSigning = new MockSigning();

    initStorage(mockStorage);
    initTransport(mockTransport);
    initRuntime(mockRuntime);
    initSigning(mockSigning);
    store.initStore(simpleHash);
});

// ---------------------------------------------------------------------------
// Scenario 1: Store + Query
// ---------------------------------------------------------------------------

describe("Cross-runtime: Store + Query", () => {
    it("stores and retrieves a link", () => {
        const link = makeLinkExpression();
        const h = store.putLink(link);
        const retrieved = store.getLink(h);
        assert.ok(retrieved);
        assert.equal(retrieved!.data.source, "literal://hello");
    });

    it("queries links by source", () => {
        store.putLink(makeLinkExpression());
        store.putLink(makeLinkExpression({
            data: { source: "other://source", target: "t", predicate: "p" },
        }));

        const results = store.queryLinks({ source: "literal://hello" });
        assert.equal(results.length, 1);
        assert.equal(results[0].data.source, "literal://hello");
    });

    it("queries links by predicate", () => {
        store.putLink(makeLinkExpression());
        store.putLink(makeLinkExpression({
            data: { source: "s", target: "t", predicate: "flux://has_message" },
        }));

        const results = store.queryLinks({ predicate: "flux://has_message" });
        assert.equal(results.length, 1);
    });

    it("queries links by target", () => {
        store.putLink(makeLinkExpression());
        const results = store.queryLinks({ target: "literal://world" });
        assert.equal(results.length, 1);
    });

    it("returns all links with no filter", () => {
        store.putLink(makeLinkExpression());
        store.putLink(makeLinkExpression({
            data: { source: "s2", target: "t2", predicate: "p2" },
        }));

        const results = store.queryLinks({});
        assert.equal(results.length, 2);
    });

    it("removes a link and its indexes", () => {
        const link = makeLinkExpression();
        store.putLink(link);
        store.removeLink(link);

        const results = store.queryLinks({ source: "literal://hello" });
        assert.equal(results.length, 0);
    });

    it("applies a diff (additions + removals)", () => {
        const existing = makeLinkExpression();
        store.putLink(existing);

        const newLink = makeLinkExpression({
            data: { source: "new", target: "link", predicate: "pred" },
        });

        store.applyDiff({
            additions: [newLink],
            removals: [existing],
        });

        assert.equal(store.queryLinks({ source: "literal://hello" }).length, 0);
        assert.equal(store.queryLinks({ source: "new" }).length, 1);
    });

    it("allLinks returns all stored links", () => {
        store.putLink(makeLinkExpression());
        store.putLink(makeLinkExpression({
            data: { source: "s2", target: "t2", predicate: "p2" },
        }));

        const all = store.allLinks();
        assert.equal(all.links.length, 2);
    });

    it("linkCount returns correct count", () => {
        assert.equal(store.linkCount(), 0);
        store.putLink(makeLinkExpression());
        assert.equal(store.linkCount(), 1);
    });

    it("revision tracking works", () => {
        assert.equal(store.getRevision(), null);
        store.setRevision("rev-1");
        assert.equal(store.getRevision(), "rev-1");
    });

    it("peer management works", () => {
        store.setPeer("did:key:alice", { local: true });
        store.setPeer("did:key:bob", { local: false });

        const peers = store.listPeers();
        assert.equal(peers.length, 2);

        store.removePeer("did:key:alice");
        assert.equal(store.listPeers().length, 1);
    });
});

// ---------------------------------------------------------------------------
// Scenario 2: Translation + Write Ops
// ---------------------------------------------------------------------------

describe("Cross-runtime: Translation + Write Ops", () => {
    it("translates a diff to create operations", () => {
        const diff: PerspectiveDiff = {
            additions: [makeLinkExpression()],
            removals: [],
        };

        const ops = diffToWriteOps(diff, TRIPLE_COLLECTION, simpleHash);
        assert.equal(ops.length, 1);
        assert.equal(ops[0].$type, "com.atproto.repo.applyWrites#create");
        const value = (ops[0] as any).value;
        assert.equal(value.$type, "ad4m.link.triple");
        assert.equal(value.source, "literal://hello");
    });

    it("translateDiffToWrites applies rendering strategy", () => {
        const diff: PerspectiveDiff = {
            additions: [makeLinkExpression({
                data: {
                    source: "channel://main",
                    target: "literal://hello%20world",
                    predicate: "flux://has_message",
                },
            })],
            removals: [],
        };

        // "native" strategy — only triple records
        const nativeWrites = translateDiffToWrites(diff, {
            did: "did:plc:test",
            collection: TRIPLE_COLLECTION,
            settings: { ...DEFAULT_SETTINGS, rendering: { ...DEFAULT_SETTINGS.rendering, strategy: "native" } },
            neighbourhoodUrl: "neighbourhood://test",
            hashFn: simpleHash,
            shouldFederate: () => true,
        });

        const tripleCreates = nativeWrites.filter(w =>
            w.$type === "com.atproto.repo.applyWrites#create" && (w as any).collection === TRIPLE_COLLECTION
        );
        assert.ok(tripleCreates.length >= 1);
    });

    it("translateDiffToWrites respects federation filter", () => {
        const diff: PerspectiveDiff = {
            additions: [makeLinkExpression()],
            removals: [],
        };

        const writes = translateDiffToWrites(diff, {
            did: "did:plc:test",
            collection: TRIPLE_COLLECTION,
            settings: DEFAULT_SETTINGS,
            neighbourhoodUrl: "neighbourhood://test",
            hashFn: simpleHash,
            shouldFederate: () => false, // block all
        });

        assert.equal(writes.length, 0);
    });
});

// ---------------------------------------------------------------------------
// Scenario 3: Sync from PDS
// ---------------------------------------------------------------------------

describe("Cross-runtime: Sync from PDS", () => {
    it("syncs records from mock transport", async () => {
        mockTransport.addResponse("listRecords", {
            status: 200,
            headers: {},
            body: JSON.stringify({
                records: [
                    {
                        uri: "at://did:plc:abc/ad4m.link.triple/123",
                        cid: "cid1",
                        value: {
                            $type: "ad4m.link.triple",
                            source: "remote://source",
                            predicate: "remote://predicate",
                            target: "remote://target",
                            author: "did:key:remote",
                            timestamp: "2026-05-02T06:00:00.000Z",
                        },
                    },
                ],
            }),
        });

        const diff = await syncFromPDS({
            pdsUrl: "https://pds.example.com",
            accessJwt: "mock-jwt",
            repo: "did:plc:abc",
            collection: "ad4m.link.triple",
            neighbourhoodUrl: "neighbourhood://test",
        });

        assert.equal(diff.additions.length, 1);
        assert.equal(diff.additions[0].data.source, "remote://source");
        assert.equal(diff.additions[0].author, "did:key:remote");

        // Verify stored in local store
        const allLinks = store.allLinks();
        assert.equal(allLinks.links.length, 1);
    });

    it("sets origin tracking for synced records", async () => {
        mockTransport.addResponse("listRecords", {
            status: 200,
            headers: {},
            body: JSON.stringify({
                records: [
                    {
                        uri: "at://did:plc:abc/ad4m.link.triple/123",
                        cid: "cid1",
                        value: {
                            $type: "ad4m.link.triple",
                            source: "s",
                            predicate: "p",
                            target: "t",
                            author: "did:key:z6Mk1",
                            timestamp: "2026-05-02T00:00:00.000Z",
                        },
                    },
                ],
            }),
        });

        await syncFromPDS({
            pdsUrl: "https://pds.example.com",
            accessJwt: "mock-jwt",
            repo: "did:plc:abc",
            collection: "ad4m.link.triple",
            neighbourhoodUrl: "neighbourhood://test",
        });

        // Check that origin was tracked
        const link = store.allLinks().links[0];
        const linkHash = simpleHash(linkContentKey(link));
        const origin = mockStorage.get(linkOriginKey(linkHash));
        assert.equal(origin, "atproto");
    });
});

// ---------------------------------------------------------------------------
// Scenario 4: Full round-trip
// ---------------------------------------------------------------------------

describe("Cross-runtime: Full round-trip", () => {
    it("link → triple record → link → store → query", () => {
        const original = makeLinkExpression({
            data: {
                source: "channel://test",
                predicate: "flux://has_message",
                target: "expr://msg-42",
            },
        });

        // Step 1: Link → Record
        const record = linkToTripleRecord(original);
        assert.equal(record.$type, "ad4m.link.triple");

        // Step 2: Record → Link (simulating inbound)
        const reconstructed = tripleRecordToLink(record);
        assert.equal(reconstructed.data.source, original.data.source);
        assert.equal(reconstructed.data.predicate, original.data.predicate);
        assert.equal(reconstructed.data.target, original.data.target);
        assert.equal(reconstructed.author, original.author);

        // Step 3: Store
        const h = store.putLink(reconstructed);
        assert.ok(h);

        // Step 4: Query
        const results = store.queryLinks({ predicate: "flux://has_message" });
        assert.equal(results.length, 1);
        assert.equal(results[0].data.target, "expr://msg-42");
    });
});

// ---------------------------------------------------------------------------
// Scenario 5: Dual-language origin tracking
// ---------------------------------------------------------------------------

describe("Cross-runtime: Dual-language", () => {
    it("tracks origin and blocks re-federation", () => {
        const link = makeLinkExpression();
        const h = store.hashLink(link);

        // Mark as arriving from atproto
        mockStorage.put(linkOriginKey(h), "atproto");

        // Should NOT be federated back to atproto
        const result = shouldFederate(h, (key) => mockStorage.get(key));
        assert.equal(result, false);
    });

    it("allows native origin to be federated", () => {
        const link = makeLinkExpression();
        const h = store.hashLink(link);

        mockStorage.put(linkOriginKey(h), "native");

        const result = shouldFederate(h, (key) => mockStorage.get(key));
        assert.equal(result, true);
    });

    it("allows new links (no origin) to be federated", () => {
        const link = makeLinkExpression();
        const h = store.hashLink(link);

        const result = shouldFederate(h, (key) => mockStorage.get(key));
        assert.equal(result, true);
    });

    it("dedup detects same triple from different authors", () => {
        const link1 = makeLinkExpression({ author: "did:key:alice" });
        const link2 = makeLinkExpression({ author: "did:key:bob" });

        const hash1 = linkContentHash(link1, simpleHash);
        const existing = new Set([hash1]);

        assert.equal(isDuplicate(link2, existing, simpleHash), true);
    });
});

// ---------------------------------------------------------------------------
// Scenario 6: Lexicon validation
// ---------------------------------------------------------------------------

describe("Cross-runtime: Lexicon validation", () => {
    it("validates a correct triple record", () => {
        const record = linkToTripleRecord(makeLinkExpression());
        assert.equal(validateTripleRecord(record as unknown as Record<string, unknown>), true);
    });

    it("rejects triple record missing source", () => {
        assert.equal(validateTripleRecord({ predicate: "p", target: "t", author: "a", timestamp: "ts" }), false);
    });

    it("rejects triple record with oversized source", () => {
        assert.equal(validateTripleRecord({
            source: "x".repeat(5000),
            predicate: "p",
            target: "t",
            author: "a",
            timestamp: "ts",
        }), false);
    });

    it("validates a correct neighbourhood record", () => {
        assert.equal(validateNeighbourhoodRecord({
            name: "Test Neighbourhood",
            description: "A test neighbourhood",
        }), true);
    });

    it("rejects neighbourhood record missing name", () => {
        assert.equal(validateNeighbourhoodRecord({ description: "desc" }), false);
    });
});

// ---------------------------------------------------------------------------
// Scenario 7: SDNA + Rendering
// ---------------------------------------------------------------------------

describe("Cross-runtime: SDNA + Rendering", () => {
    it("detects pattern and maps to Bluesky type", () => {
        const link = makeLinkExpression({
            data: { source: "ch", target: "msg", predicate: "flux://has_message" },
        });

        const pattern = detectPattern(link, DEFAULT_SETTINGS.rendering.chatPredicates);
        assert.equal(pattern.type, "chat-message");

        const bskyType = patternToBlueskyType(pattern);
        assert.equal(bskyType, "app.bsky.feed.post");
    });

    it("generates facets for rich text", () => {
        const facets = generateFacets("Hello @alice.bsky.social! #ad4m https://ad4m.dev");
        assert.ok(facets.length >= 3);
    });

    it("facets convert to link predicates", () => {
        const facets = generateFacets("Check #ad4m");
        const predicates = facetsToLinkPredicates(facets, "at://post");
        assert.ok(predicates.some(p => p.predicate === "flux://has_tag"));
    });
});

// ---------------------------------------------------------------------------
// Scenario 8: Auth (pure functions)
// ---------------------------------------------------------------------------

describe("Cross-runtime: Auth helpers", () => {
    it("parseJwtExp extracts expiry", () => {
        const payload = btoa(JSON.stringify({ exp: 1714600000 }));
        const jwt = `header.${payload}.sig`;
        assert.equal(parseJwtExp(jwt), 1714600000);
    });

    it("isJwtExpired detects expired tokens", () => {
        const exp = Math.floor(Date.now() / 1000) - 100;
        const payload = btoa(JSON.stringify({ exp }));
        const jwt = `h.${payload}.s`;
        assert.equal(isJwtExpired(jwt), true);
    });
});

// ---------------------------------------------------------------------------
// Scenario 9: XRPC pure helpers
// ---------------------------------------------------------------------------

describe("Cross-runtime: XRPC helpers", () => {
    it("TID generation is consistent", () => {
        const tid1 = tidFromISO("2026-05-02T00:00:00.000Z");
        const tid2 = tidFromISO("2026-05-02T00:00:00.000Z");
        assert.equal(tid1, tid2);
        assert.equal(tid1.length, 13);
    });

    it("AT URI helpers work correctly", () => {
        const uri = buildAtUri("did:plc:abc", "ad4m.link.triple", "rkey1");
        assert.equal(uri, "at://did:plc:abc/ad4m.link.triple/rkey1");
        assert.equal(rkeyFromUri(uri), "rkey1");
        assert.equal(collectionFromUri(uri), "ad4m.link.triple");
        assert.equal(didFromUri(uri), "did:plc:abc");
    });
});

// ---------------------------------------------------------------------------
// Scenario 10: Settings in cross-runtime
// ---------------------------------------------------------------------------

describe("Cross-runtime: Settings", () => {
    it("parses settings without runtime dependency", () => {
        const settings = parseSettings(JSON.stringify({
            syncMode: "publish-only",
            rendering: { strategy: "native" },
        }));
        assert.equal(settings.syncMode, "publish-only");
        assert.equal(settings.rendering.strategy, "native");
    });

    it("defaults work without any input", () => {
        const settings = parseSettings(null);
        assert.equal(settings.syncMode, "bidirectional");
        assert.equal(settings.rendering.strategy, "dual");
    });
});
