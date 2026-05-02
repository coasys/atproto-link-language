/**
 * Unit tests for auth token management.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { parseJwtExp, isJwtExpired } from "../src/auth.js";

// ---------------------------------------------------------------------------
// JWT helpers for testing
// ---------------------------------------------------------------------------

function makeJwt(payload: Record<string, unknown>): string {
    const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const body = btoa(JSON.stringify(payload));
    const sig = btoa("fake-signature");
    return `${header}.${body}.${sig}`;
}

function makeJwtBase64url(payload: Record<string, unknown>): string {
    const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    const body = btoa(JSON.stringify(payload))
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    const sig = btoa("fake-signature")
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    return `${header}.${body}.${sig}`;
}

// ---------------------------------------------------------------------------
// parseJwtExp
// ---------------------------------------------------------------------------

describe("parseJwtExp", () => {
    it("extracts exp from a valid JWT", () => {
        const jwt = makeJwt({ exp: 1714600000, sub: "did:plc:abc" });
        const exp = parseJwtExp(jwt);
        assert.equal(exp, 1714600000);
    });

    it("returns 0 for JWT without exp", () => {
        const jwt = makeJwt({ sub: "did:plc:abc" });
        assert.equal(parseJwtExp(jwt), 0);
    });

    it("returns 0 for malformed JWT", () => {
        assert.equal(parseJwtExp("not-a-jwt"), 0);
        assert.equal(parseJwtExp(""), 0);
        assert.equal(parseJwtExp("a.b"), 0);
    });

    it("handles base64url encoding", () => {
        const jwt = makeJwtBase64url({ exp: 1714600000 });
        const exp = parseJwtExp(jwt);
        assert.equal(exp, 1714600000);
    });

    it("returns 0 for non-numeric exp", () => {
        const jwt = makeJwt({ exp: "not-a-number" });
        assert.equal(parseJwtExp(jwt), 0);
    });
});

// ---------------------------------------------------------------------------
// isJwtExpired
// ---------------------------------------------------------------------------

describe("isJwtExpired", () => {
    it("returns false for token expiring far in the future", () => {
        const futureExp = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
        const jwt = makeJwt({ exp: futureExp });
        assert.equal(isJwtExpired(jwt, 60), false);
    });

    it("returns true for expired token", () => {
        const pastExp = Math.floor(Date.now() / 1000) - 60; // 1 minute ago
        const jwt = makeJwt({ exp: pastExp });
        assert.equal(isJwtExpired(jwt), true);
    });

    it("returns true for token about to expire within buffer", () => {
        const nearExp = Math.floor(Date.now() / 1000) + 30; // 30 seconds from now
        const jwt = makeJwt({ exp: nearExp });
        assert.equal(isJwtExpired(jwt, 60), true); // 60 second buffer
    });

    it("returns false for token beyond buffer", () => {
        const nearExp = Math.floor(Date.now() / 1000) + 120; // 2 minutes from now
        const jwt = makeJwt({ exp: nearExp });
        assert.equal(isJwtExpired(jwt, 60), false); // 60 second buffer
    });

    it("returns true for malformed JWT", () => {
        assert.equal(isJwtExpired("not-a-jwt"), true);
    });

    it("returns true for JWT without exp", () => {
        const jwt = makeJwt({ sub: "test" });
        assert.equal(isJwtExpired(jwt), true);
    });

    it("uses default buffer of 60 seconds", () => {
        const exp = Math.floor(Date.now() / 1000) + 50; // 50 seconds
        const jwt = makeJwt({ exp });
        assert.equal(isJwtExpired(jwt), true); // default 60s buffer
    });
});
