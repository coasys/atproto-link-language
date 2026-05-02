/**
 * Unit tests for sync (cursor management, dedup).
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { StorageAdapter } from "../src/storage-interface.js";
import { initStorage } from "../src/storage-interface.js";
import type { Transport, TransportResponse } from "../src/transport.js";
import { initTransport } from "../src/transport.js";
import type { RuntimeAdapter } from "../src/runtime-interface.js";
import { initRuntime } from "../src/runtime-interface.js";
import { initSigning } from "../src/signing-interface.js";
import type { SigningAdapter } from "../src/signing-interface.js";

import * as store from "../src/store.js";
import { getCursor, setCursor, getLastSync, setLastSync, isSyncNeeded, getSyncStatus, syncFromPDS } from "../src/sync.js";

// ---------------------------------------------------------------------------
// Mock Adapters
// ---------------------------------------------------------------------------

class MockStorage implements StorageAdapter {
    private data = new Map<string, string>();
    get(key: string) { return this.data.get(key) ?? null; }
    put(key: string, value: string) { this.data.set(key, value); }
    delete(key: string) { this.data.delete(key); }
    listKeys(prefix?: string) {
        const all = [...this.data.keys()];
        return prefix ? all.filter(k => k.startsWith(prefix)) : all;
    }
    _clear() { this.data.clear(); }
}

class MockTransport implements Transport {
    private responses = new Map<string, TransportResponse>();
    public requests: Array<{ url: string; method: string }> = [];

    addResponse(urlMatch: string, response: TransportResponse) {
        this.responses.set(urlMatch, response);
    }

    async fetch(url: string, method: string, headers: Record<string, string>, body: string): Promise<TransportResponse> {
        this.requests.push({ url, method });
        // Match by substring
        for (const [match, response] of this.responses) {
            if (url.includes(match)) return response;
        }
        return { status: 404, headers: {}, body: '{"error":"not found"}' };
    }
}

function simpleHash(data: string): string {
    let h = 0;
    for (let i = 0; i < data.length; i++) {
        h = ((h << 5) - h + data.charCodeAt(i)) | 0;
    }
    return `Qm${Math.abs(h).toString(16)}`;
}

class MockRuntime implements RuntimeAdapter {
    hash(data: string) { return simpleHash(data); }
    emitSignal() {}
    emitPerspectiveDiff() {}
}

class MockSigning implements SigningAdapter {
    signStringHex() { return "mock-sig"; }
    signingKeyId() { return "mock-key"; }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let mockStorage: MockStorage;
let mockTransport: MockTransport;

beforeEach(() => {
    mockStorage = new MockStorage();
    mockTransport = new MockTransport();
    initStorage(mockStorage);
    initTransport(mockTransport);
    initRuntime(new MockRuntime());
    initSigning(new MockSigning());
    store.initStore(simpleHash);
});

// ---------------------------------------------------------------------------
// Cursor management
// ---------------------------------------------------------------------------

describe("cursor management", () => {
    it("getCursor returns null initially", () => {
        assert.equal(getCursor(), null);
    });

    it("setCursor stores and getCursor retrieves", () => {
        setCursor("cursor-abc-123");
        assert.equal(getCursor(), "cursor-abc-123");
    });

    it("cursor can be updated", () => {
        setCursor("cursor-1");
        setCursor("cursor-2");
        assert.equal(getCursor(), "cursor-2");
    });
});

// ---------------------------------------------------------------------------
// Last sync tracking
// ---------------------------------------------------------------------------

describe("last sync tracking", () => {
    it("getLastSync returns 0 initially", () => {
        assert.equal(getLastSync(), 0);
    });

    it("setLastSync stores and getLastSync retrieves", () => {
        setLastSync(1714600000);
        assert.equal(getLastSync(), 1714600000);
    });
});

// ---------------------------------------------------------------------------
// isSyncNeeded
// ---------------------------------------------------------------------------

describe("isSyncNeeded", () => {
    it("returns true when no sync has happened", () => {
        assert.equal(isSyncNeeded(60000), true);
    });

    it("returns false immediately after sync", () => {
        setLastSync(Date.now());
        assert.equal(isSyncNeeded(60000), false);
    });

    it("returns true after interval elapsed", () => {
        setLastSync(Date.now() - 120000); // 2 minutes ago
        assert.equal(isSyncNeeded(60000), true); // 1 minute interval
    });
});

// ---------------------------------------------------------------------------
// getSyncStatus
// ---------------------------------------------------------------------------

describe("getSyncStatus", () => {
    it("returns initial status", () => {
        const status = getSyncStatus();
        assert.equal(status.cursor, null);
        assert.equal(status.lastSync, 0);
        assert.equal(status.linkCount, 0);
    });

    it("reflects updated state", () => {
        setCursor("abc");
        setLastSync(123456);
        store.putLink({
            author: "did:key:z6Mk1",
            timestamp: "2026-05-02T00:00:00.000Z",
            data: { source: "s", target: "t", predicate: "p" },
            proof: { signature: "", key: "" },
        });

        const status = getSyncStatus();
        assert.equal(status.cursor, "abc");
        assert.equal(status.lastSync, 123456);
        assert.equal(status.linkCount, 1);
    });
});

// ---------------------------------------------------------------------------
// syncFromPDS
// ---------------------------------------------------------------------------

describe("syncFromPDS", () => {
    it("returns empty diff when no records", async () => {
        mockTransport.addResponse("listRecords", {
            status: 200,
            headers: {},
            body: JSON.stringify({ records: [] }),
        });

        const diff = await syncFromPDS({
            pdsUrl: "https://pds.example.com",
            accessJwt: "jwt",
            repo: "did:plc:abc",
            collection: "ad4m.link.triple",
            neighbourhoodUrl: "neighbourhood://test",
        });

        assert.equal(diff.additions.length, 0);
        assert.equal(diff.removals.length, 0);
    });

    it("translates inbound records to links", async () => {
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
                            source: "literal://hello",
                            predicate: "sioc://content_of",
                            target: "literal://world",
                            author: "did:key:z6Mk1",
                            timestamp: "2026-05-02T00:00:00.000Z",
                        },
                    },
                ],
            }),
        });

        const diff = await syncFromPDS({
            pdsUrl: "https://pds.example.com",
            accessJwt: "jwt",
            repo: "did:plc:abc",
            collection: "ad4m.link.triple",
            neighbourhoodUrl: "neighbourhood://test",
        });

        assert.equal(diff.additions.length, 1);
        assert.equal(diff.additions[0].data.source, "literal://hello");
        assert.equal(diff.additions[0].author, "did:key:z6Mk1");
    });

    it("deduplicates already-known links", async () => {
        // Pre-populate store with a link
        store.putLink({
            author: "did:key:z6Mk1",
            timestamp: "2026-05-02T00:00:00.000Z",
            data: { source: "literal://hello", predicate: "sioc://content_of", target: "literal://world" },
            proof: { signature: "", key: "" },
        });

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
                            source: "literal://hello",
                            predicate: "sioc://content_of",
                            target: "literal://world",
                            author: "did:key:z6Mk1",
                            timestamp: "2026-05-02T00:00:00.000Z",
                        },
                    },
                ],
            }),
        });

        const diff = await syncFromPDS({
            pdsUrl: "https://pds.example.com",
            accessJwt: "jwt",
            repo: "did:plc:abc",
            collection: "ad4m.link.triple",
            neighbourhoodUrl: "neighbourhood://test",
        });

        assert.equal(diff.additions.length, 0, "duplicate should be skipped");
    });

    it("updates cursor after sync", async () => {
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
                            source: "s1",
                            predicate: "p1",
                            target: "t1",
                            author: "did:key:z6Mk1",
                            timestamp: "2026-05-02T00:00:00.000Z",
                        },
                    },
                ],
                cursor: "new-cursor-123",
            }),
        });

        await syncFromPDS({
            pdsUrl: "https://pds.example.com",
            accessJwt: "jwt",
            repo: "did:plc:abc",
            collection: "ad4m.link.triple",
            neighbourhoodUrl: "neighbourhood://test",
        });

        assert.equal(getCursor(), "new-cursor-123");
    });

    it("handles transport errors gracefully", async () => {
        mockTransport.addResponse("listRecords", {
            status: 500,
            headers: {},
            body: '{"error":"internal"}',
        });

        const diff = await syncFromPDS({
            pdsUrl: "https://pds.example.com",
            accessJwt: "jwt",
            repo: "did:plc:abc",
            collection: "ad4m.link.triple",
            neighbourhoodUrl: "neighbourhood://test",
        });

        assert.equal(diff.additions.length, 0);
    });
});
