/**
 * Lossless JSON (P2): object keys are own data, never prototype setters.
 * Expected outputs are literal strings, not derived from the parser.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseLossless, stringifyLossless } from "../src/mount/lossless-json.js";
import { readAccount } from "../src/mount/reader.js";
import { MountedReader } from "../src/mount/state.js";
import { standardNet, baseConfig, ALICE, BOB, POST } from "./mount-fixtures.js";

describe("P2: __proto__ keys are data", () => {
    it("a top-level and a nested __proto__ survive a round trip", () => {
        const top = '{"text":"hello","__proto__":{"text":"injected","custom":"lost"}}';
        assert.equal(stringifyLossless(parseLossless(top)), top);
        const nested = '{"a":{"__proto__":{"x":1,"y":[{"__proto__":null}]}},"n":9007199254740993}';
        assert.equal(stringifyLossless(parseLossless(nested)), nested);
        const v = parseLossless(nested) as any;
        assert.ok(Object.prototype.hasOwnProperty.call(v.a, "__proto__"));
    });

    it("no inherited field is visible on a parsed object", () => {
        const v = parseLossless('{"__proto__":{"did":"did:plc:x","active":true}}') as any;
        assert.equal(v.did, undefined);
        assert.equal(v.active, undefined);
        assert.equal(v.toString, undefined, "no Object.prototype either");
        assert.equal(Object.keys(v).join(), "__proto__");
    });

    it("a response whose required fields exist only via __proto__ is rejected", async () => {
        const net = standardNet();
        const orig = net.fetch.bind(net);
        net.fetch = async (url, m, h, b) => {
            if (url.includes("getRepoStatus")) {
                return { status: 200, headers: {}, body: `{"__proto__":{"did":"${ALICE}","active":true}}` };
            }
            return orig(url, m, h, b);
        };
        await assert.rejects(readAccount(ALICE, net, baseConfig), /getRepoStatus/);
    });

    it("a post's projected text never comes from a __proto__ key; the key stays in sourceRecord", async () => {
        const net = standardNet();
        net.put(ALICE, POST, "3kproto00001a", '{"$type":"app.bsky.feed.post","createdAt":"2026-11-19T10:00:00.000Z","__proto__":{"text":"injected"}}');
        const r = new MountedReader({ ...baseConfig, accounts: [ALICE, BOB], transport: net });
        await r.refresh();
        const e = r.snapshot().entries.find((x) => x.address === `${ALICE}/${POST}/3kproto00001a`)!;
        assert.ok(e, "mounted");
        assert.ok(!("text" in e.data), `text leaked: ${JSON.stringify(e.data.text)}`);
        assert.equal(e.data.sourceRecord, '{"$type":"app.bsky.feed.post","createdAt":"2026-11-19T10:00:00.000Z","__proto__":{"text":"injected"}}');
    });
});
