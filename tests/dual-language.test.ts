/**
 * Unit tests for dual-language origin tracking and federation filtering.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    isDuplicate,
    linkContentHash,
    linkOriginKey,
    shouldFederate,
    isPredicateExcluded,
    shouldFederateLink,
} from "../src/dual-language.js";
import type { LinkOrigin } from "../src/dual-language.js";
import type { LinkExpression } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeLinkExpression(overrides?: Partial<LinkExpression>): LinkExpression {
    return {
        author: "did:key:z6MkTest",
        timestamp: "2026-05-02T00:00:00.000Z",
        data: {
            source: "literal://hello",
            target: "literal://world",
            predicate: "sioc://content_of",
        },
        proof: { signature: "sig", key: "key" },
        ...overrides,
    };
}

function simpleHash(data: string): string {
    let h = 0;
    for (let i = 0; i < data.length; i++) {
        h = ((h << 5) - h + data.charCodeAt(i)) | 0;
    }
    return `Qm${Math.abs(h).toString(16)}`;
}

// ---------------------------------------------------------------------------
// linkOriginKey
// ---------------------------------------------------------------------------

describe("linkOriginKey", () => {
    it("builds correct key format", () => {
        assert.equal(linkOriginKey("abc123"), "link-origin/abc123");
    });
});

// ---------------------------------------------------------------------------
// isDuplicate
// ---------------------------------------------------------------------------

describe("isDuplicate", () => {
    it("detects duplicate when hash exists", () => {
        const link = makeLinkExpression();
        const hash = linkContentHash(link, simpleHash);
        const existing = new Set([hash]);

        assert.equal(isDuplicate(link, existing, simpleHash), true);
    });

    it("returns false for non-duplicate", () => {
        const link = makeLinkExpression();
        const existing = new Set<string>();

        assert.equal(isDuplicate(link, existing, simpleHash), false);
    });

    it("ignores author and timestamp for dedup", () => {
        const link1 = makeLinkExpression({ author: "did:key:alice" });
        const link2 = makeLinkExpression({ author: "did:key:bob" });

        const hash1 = linkContentHash(link1, simpleHash);
        const hash2 = linkContentHash(link2, simpleHash);

        // Same source/predicate/target → same content hash
        assert.equal(hash1, hash2);
    });

    it("treats different triples as non-duplicates", () => {
        const link1 = makeLinkExpression();
        const link2 = makeLinkExpression({
            data: { source: "different", target: "values", predicate: "here" },
        });

        const hash1 = linkContentHash(link1, simpleHash);
        const hash2 = linkContentHash(link2, simpleHash);

        assert.notEqual(hash1, hash2);
    });
});

// ---------------------------------------------------------------------------
// linkContentHash
// ---------------------------------------------------------------------------

describe("linkContentHash", () => {
    it("produces deterministic hashes", () => {
        const link = makeLinkExpression();
        const h1 = linkContentHash(link, simpleHash);
        const h2 = linkContentHash(link, simpleHash);
        assert.equal(h1, h2);
    });

    it("produces different hashes for different links", () => {
        const link1 = makeLinkExpression();
        const link2 = makeLinkExpression({
            data: { source: "a", target: "b", predicate: "c" },
        });

        assert.notEqual(
            linkContentHash(link1, simpleHash),
            linkContentHash(link2, simpleHash),
        );
    });
});

// ---------------------------------------------------------------------------
// shouldFederate
// ---------------------------------------------------------------------------

describe("shouldFederate", () => {
    it("returns true for unknown origin (new local commit)", () => {
        const getOrigin = (_: string) => null;
        assert.equal(shouldFederate("hash123", getOrigin), true);
    });

    it("returns true for native origin", () => {
        const getOrigin = (_: string) => "native";
        assert.equal(shouldFederate("hash123", getOrigin), true);
    });

    it("returns true for dual origin", () => {
        const getOrigin = (_: string) => "dual";
        assert.equal(shouldFederate("hash123", getOrigin), true);
    });

    it("returns false for atproto origin (prevents echo)", () => {
        const getOrigin = (_: string) => "atproto";
        assert.equal(shouldFederate("hash123", getOrigin), false);
    });

    it("uses correct key format", () => {
        let queriedKey: string = "";
        const getOrigin = (key: string) => { queriedKey = key; return null; };
        shouldFederate("abc", getOrigin);
        assert.equal(queriedKey, "link-origin/abc");
    });
});

// ---------------------------------------------------------------------------
// isPredicateExcluded
// ---------------------------------------------------------------------------

describe("isPredicateExcluded", () => {
    it("returns false for empty exclusion list", () => {
        assert.equal(isPredicateExcluded("flux://has_message", []), false);
    });

    it("returns true for excluded predicate", () => {
        assert.equal(isPredicateExcluded("flux://internal", ["flux://internal"]), true);
    });

    it("returns false for non-excluded predicate", () => {
        assert.equal(isPredicateExcluded("flux://has_message", ["flux://internal"]), false);
    });
});

// ---------------------------------------------------------------------------
// shouldFederateLink
// ---------------------------------------------------------------------------

describe("shouldFederateLink", () => {
    it("blocks links with excluded predicates", () => {
        const link = makeLinkExpression({
            data: { source: "s", target: "t", predicate: "flux://internal" },
        });
        const getOrigin = (_: string) => null;

        assert.equal(shouldFederateLink(link, "hash123", getOrigin, ["flux://internal"]), false);
    });

    it("blocks links with atproto origin", () => {
        const link = makeLinkExpression();
        const getOrigin = (_: string) => "atproto";

        assert.equal(shouldFederateLink(link, "hash123", getOrigin, []), false);
    });

    it("allows links with native origin and non-excluded predicate", () => {
        const link = makeLinkExpression();
        const getOrigin = (_: string) => "native";

        assert.equal(shouldFederateLink(link, "hash123", getOrigin, []), true);
    });

    it("blocks when both conditions apply", () => {
        const link = makeLinkExpression({
            data: { source: "s", target: "t", predicate: "flux://internal" },
        });
        const getOrigin = (_: string) => "atproto";

        assert.equal(shouldFederateLink(link, "hash123", getOrigin, ["flux://internal"]), false);
    });
});
