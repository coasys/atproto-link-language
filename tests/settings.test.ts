/**
 * Unit tests for settings parser.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseSettings, DEFAULT_SETTINGS } from "../src/settings.js";
import type { ATProtoSettings } from "../src/settings.js";

// ---------------------------------------------------------------------------
// parseSettings
// ---------------------------------------------------------------------------

describe("parseSettings", () => {
    it("returns defaults for null input", () => {
        const settings = parseSettings(null);
        assert.equal(settings.syncMode, "bidirectional");
        assert.equal(settings.rendering.strategy, "dual");
        assert.equal(settings.membership, "open");
    });

    it("returns defaults for undefined input", () => {
        const settings = parseSettings(undefined);
        assert.equal(settings.syncMode, "bidirectional");
    });

    it("returns defaults for empty string", () => {
        const settings = parseSettings("");
        assert.equal(settings.syncMode, "bidirectional");
    });

    it("returns defaults for invalid JSON", () => {
        const settings = parseSettings("not json");
        assert.equal(settings.syncMode, "bidirectional");
    });

    it("parses valid full settings", () => {
        const raw = JSON.stringify({
            syncMode: "publish-only",
            rendering: {
                strategy: "native",
                chatPredicates: ["custom://predicate"],
                resolveContent: false,
            },
            firehose: {
                enabled: false,
                relay: "wss://custom-relay.example.com",
                filterByCollection: false,
                reconnectBaseMs: 2000,
                reconnectMaxMs: 120000,
            },
            auth: {
                method: "oauth",
                appPassword: "secret123",
            },
            rateLimit: {
                maxWritesPerMinute: 60,
                maxEventsPerSecond: 200,
            },
            membership: "followers-only",
            dualLanguage: {
                enabled: true,
                excludePredicates: ["flux://internal"],
            },
        });

        const settings = parseSettings(raw);
        assert.equal(settings.syncMode, "publish-only");
        assert.equal(settings.rendering.strategy, "native");
        assert.deepEqual(settings.rendering.chatPredicates, ["custom://predicate"]);
        assert.equal(settings.rendering.resolveContent, false);
        assert.equal(settings.firehose.enabled, false);
        assert.equal(settings.firehose.relay, "wss://custom-relay.example.com");
        assert.equal(settings.firehose.reconnectBaseMs, 2000);
        assert.equal(settings.auth.method, "oauth");
        assert.equal(settings.auth.appPassword, "secret123");
        assert.equal(settings.rateLimit.maxWritesPerMinute, 60);
        assert.equal(settings.membership, "followers-only");
        assert.equal(settings.dualLanguage.enabled, true);
        assert.deepEqual(settings.dualLanguage.excludePredicates, ["flux://internal"]);
    });

    it("handles partial settings - fills missing with defaults", () => {
        const raw = JSON.stringify({
            syncMode: "subscribe-only",
        });

        const settings = parseSettings(raw);
        assert.equal(settings.syncMode, "subscribe-only");
        assert.equal(settings.rendering.strategy, DEFAULT_SETTINGS.rendering.strategy);
        assert.equal(settings.firehose.enabled, DEFAULT_SETTINGS.firehose.enabled);
        assert.equal(settings.membership, DEFAULT_SETTINGS.membership);
    });

    it("rejects invalid syncMode", () => {
        const settings = parseSettings(JSON.stringify({ syncMode: "invalid" }));
        assert.equal(settings.syncMode, "bidirectional");
    });

    it("rejects invalid rendering strategy", () => {
        const settings = parseSettings(JSON.stringify({ rendering: { strategy: "invalid" } }));
        assert.equal(settings.rendering.strategy, "dual");
    });

    it("rejects invalid membership", () => {
        const settings = parseSettings(JSON.stringify({ membership: "invalid" }));
        assert.equal(settings.membership, "open");
    });

    it("rejects non-array chatPredicates", () => {
        const settings = parseSettings(JSON.stringify({
            rendering: { chatPredicates: "not-array" },
        }));
        assert.deepEqual(settings.rendering.chatPredicates, DEFAULT_SETTINGS.rendering.chatPredicates);
    });

    it("rejects negative rate limit", () => {
        const settings = parseSettings(JSON.stringify({
            rateLimit: { maxWritesPerMinute: -5 },
        }));
        assert.equal(settings.rateLimit.maxWritesPerMinute, DEFAULT_SETTINGS.rateLimit.maxWritesPerMinute);
    });

    it("rejects zero rate limit", () => {
        const settings = parseSettings(JSON.stringify({
            rateLimit: { maxWritesPerMinute: 0 },
        }));
        assert.equal(settings.rateLimit.maxWritesPerMinute, DEFAULT_SETTINGS.rateLimit.maxWritesPerMinute);
    });

    it("rejects non-boolean firehose.enabled", () => {
        const settings = parseSettings(JSON.stringify({
            firehose: { enabled: "yes" },
        }));
        assert.equal(settings.firehose.enabled, true);
    });

    it("rejects negative reconnectBaseMs", () => {
        const settings = parseSettings(JSON.stringify({
            firehose: { reconnectBaseMs: -100 },
        }));
        assert.equal(settings.firehose.reconnectBaseMs, DEFAULT_SETTINGS.firehose.reconnectBaseMs);
    });

    it("accepts valid auth methods", () => {
        let s = parseSettings(JSON.stringify({ auth: { method: "app-password" } }));
        assert.equal(s.auth.method, "app-password");

        s = parseSettings(JSON.stringify({ auth: { method: "oauth" } }));
        assert.equal(s.auth.method, "oauth");
    });

    it("rejects invalid auth method", () => {
        const settings = parseSettings(JSON.stringify({ auth: { method: "magic" } }));
        assert.equal(settings.auth.method, "app-password");
    });

    it("handles deeply nested invalid values", () => {
        const settings = parseSettings(JSON.stringify({
            rendering: {
                strategy: "dual",
                chatPredicates: ["valid"],
                resolveContent: "not-boolean",
            },
        }));
        assert.equal(settings.rendering.resolveContent, true); // default
        assert.deepEqual(settings.rendering.chatPredicates, ["valid"]);
    });

    it("accepts all valid sync modes", () => {
        for (const mode of ["bidirectional", "publish-only", "subscribe-only"]) {
            const s = parseSettings(JSON.stringify({ syncMode: mode }));
            assert.equal(s.syncMode, mode);
        }
    });

    it("accepts all valid rendering strategies", () => {
        for (const strategy of ["native", "bluesky", "dual"]) {
            const s = parseSettings(JSON.stringify({ rendering: { strategy } }));
            assert.equal(s.rendering.strategy, strategy);
        }
    });

    it("accepts all valid membership modes", () => {
        for (const membership of ["open", "followers-only", "list-only"]) {
            const s = parseSettings(JSON.stringify({ membership }));
            assert.equal(s.membership, membership);
        }
    });
});
