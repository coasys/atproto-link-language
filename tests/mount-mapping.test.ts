/**
 * Mounted reader — mapping rules (acceptance rules 1, 2, 7, 8 at the
 * language boundary). The executor-side halves of rules 4, 6 and 7 are in
 * tests/mount-live.test.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseLossless, stringifyLossless } from "../src/mount/lossless-json.js";
import { MountedReader } from "../src/mount/state.js";
import { mountShapes } from "../src/mount/shapes.js";
import { activeLabels } from "../src/mount/mapping.js";
import {
    standardNet, baseConfig, NESTED_POST_TEXT, ALICE, BOB, POST, FOLLOW, APPVIEW, plainPost,
} from "./mount-fixtures.js";

const NOW = () => new Date("2026-11-19T12:00:00.000Z");

async function mounted(net = standardNet(), accounts = [ALICE, BOB], extra: Record<string, unknown> = {}) {
    const reader = new MountedReader({ ...baseConfig, ...extra, accounts, transport: net, now: NOW });
    await reader.refresh();
    return { net, reader, entries: reader.snapshot().entries };
}

function byUri(entries: any[], uri: string) {
    return entries.find((e) => e.data.sourceUri === uri);
}

describe("rule 1: nested post round-trips source data losslessly", () => {
    it("keeps arrays, unknown fields, byte links and large integers in sourceRecord", async () => {
        const net = standardNet();
        net.put(ALICE, POST, "3knested0001a", NESTED_POST_TEXT, "bafyreinested");
        const { entries } = await mounted(net);
        const e = byUri(entries, `at://${ALICE}/${POST}/3knested0001a`);
        assert.ok(e, "nested post is mounted");
        const src = e.data.sourceRecord as string;
        assert.equal(typeof src, "string");
        // byte-exact canonical form of the PDS's record
        assert.equal(src, stringifyLossless(parseLossless(NESTED_POST_TEXT)));
        assert.ok(src.includes('"big":9007199254740993'), "2^53+1 kept exactly");
        assert.ok(src.includes('"neg":-9223372036854775808'), "i64 min kept exactly");
        assert.ok(src.includes('"$bytes":"AAEC/w"'));
        assert.ok(src.includes('"$link":"bafkreiblob"'));
        assert.ok(src.includes('"langs":["en","de","en"]'), "array order + duplicates");
        assert.ok(src.includes('"nested":[[],{},null,[1,2,2]]'), "empty array/object, null, dupes");
        assert.ok(src.includes('"emptyArr":[]') && src.includes('"nullField":null'));
        assert.ok(src.includes('"$type":"com.example.future#thing","z":true,"a":false'), "unknown union variant, key order");
        // re-parse is structurally identical to the source
        assert.deepEqual(parseLossless(src), parseLossless(NESTED_POST_TEXT));
    });

    it("projects curated fields beside the preserved source", async () => {
        const net = standardNet();
        net.put(ALICE, POST, "3knested0001a", NESTED_POST_TEXT, "bafyreinested");
        const { entries } = await mounted(net);
        const e = byUri(entries, `at://${ALICE}/${POST}/3knested0001a`);
        assert.equal(e.class, "ATPost");
        assert.equal(e.data.text, "Hello from We \u{1F44B} #hello");
        assert.equal(e.data.postCreatedAt, "2026-11-19T09:00:00.000Z");
        assert.equal(e.data.cid, "bafyreinested");
        assert.equal(e.data.collection, POST);
        assert.equal(e.data.rkey, "3knested0001a");
        assert.equal(e.data.verification, "transportTrusted");
        assert.equal(e.data.replyRootUri, `at://${BOB}/app.bsky.feed.post/3kroot222222a`);
        assert.equal(e.data.replyRootCid, "bafyreiroot");
        assert.equal(e.data.replyParentUri, `at://${BOB}/app.bsky.feed.post/3kparent22222`);
        assert.equal(e.data.replyParentCid, "bafyreiparent");
    });

    it("a JSON.parse round trip would have lost the integers (guards the fixture)", () => {
        const naive = JSON.stringify(JSON.parse(NESTED_POST_TEXT));
        assert.ok(!naive.includes("9007199254740993"));
    });
});

describe("rule 2: identity is the DID-based AT URI", () => {
    it("equal bodies at different AT URIs stay distinct instances", async () => {
        const net = standardNet();
        const body = plainPost("same body", "2026-11-19T11:00:00.000Z");
        net.put(ALICE, POST, "3ksame000001a", body, "bafysame");
        net.put(BOB, POST, "3ksame000001a", body, "bafysame");
        net.put(ALICE, POST, "3ksame000002a", body, "bafysame");
        const { entries } = await mounted(net);
        const same = entries.filter((e: any) => e.data.text === "same body");
        assert.equal(same.length, 3);
        assert.equal(new Set(same.map((e: any) => e.address)).size, 3);
        assert.deepEqual(
            same.map((e: any) => e.address).sort(),
            [
                `${ALICE}/${POST}/3ksame000001a`,
                `${ALICE}/${POST}/3ksame000002a`,
                `${BOB}/${POST}/3ksame000001a`,
            ].sort(),
        );
    });

    it("a handle change does not change any address", async () => {
        const net = standardNet();
        const reader = new MountedReader({ ...baseConfig, accounts: [ALICE, BOB], transport: net, now: NOW });
        await reader.refresh();
        const before = reader.snapshot().entries;
        net.setHandle(ALICE, "alice-renamed.test");
        await reader.refresh();
        const after = reader.snapshot().entries;
        assert.deepEqual(after.map((e) => e.address), before.map((e) => e.address));
        const acct = after.find((e) => e.class === "ATAccount" && e.data.did === ALICE)!;
        assert.equal(acct.data.handle, "alice-renamed.test");
        // only the account's handle moved; every record is unchanged
        const changed = after.filter((e, i) => JSON.stringify(e) !== JSON.stringify(before[i]));
        assert.deepEqual(changed.map((e) => e.class), ["ATAccount"]);
    });
});

describe("rule 7 (language side): text, follow targets, AT author vs signer", () => {
    it("posts carry text and the AT author DID; follows carry the target DID", async () => {
        const { entries } = await mounted();
        const post = byUri(entries, `at://${ALICE}/${POST}/3kalice00001a`);
        assert.equal(post.data.text, "alice one");
        assert.equal(post.data.atAuthor, ALICE);
        const follow = byUri(entries, `at://${ALICE}/${FOLLOW}/3kfollow0001a`);
        assert.equal(follow.class, "ATFollow");
        assert.equal(follow.data.subject, BOB);
        assert.equal(follow.data.atAuthor, ALICE);
    });

    it("no mounted record claims an AD4M `author` — signer and AT author stay apart", async () => {
        const { entries } = await mounted();
        for (const e of entries) {
            assert.ok(!("author" in e.data), `${e.address} has an author field`);
        }
        const shapes = mountShapes();
        for (const { name, shape } of shapes.shapes as any[]) {
            const names = shape.properties.map((p: any) => p.name);
            assert.ok(!names.includes("author"), `${name} declares author`);
            if (name !== "ATAccount") {
                const at = shape.properties.find((p: any) => p.name === "atAuthor");
                assert.equal(at.node_kind, "IRI");
            }
        }
    });
});

describe("rule 8: label metadata and unknown moderation status", () => {
    const uri1 = `at://${ALICE}/${POST}/3kalice00001a`;
    const uri2 = `at://${ALICE}/${POST}/3kalice00002a`;

    it("preserves src, cid, val, neg, exp and cts of every label", async () => {
        const net = standardNet();
        const cid1 = net.findByUri(uri1)!.cid;
        net.labels = [
            { src: "did:plc:labeler1", uri: uri1, cid: cid1, val: "porn", cts: "2026-11-19T10:00:00.000Z" },
            { src: "did:plc:labeler1", uri: uri1, cid: cid1, val: "porn", neg: true, cts: "2026-11-19T11:00:00.000Z" },
            { src: "did:plc:labeler2", uri: uri1, cid: cid1, val: "spam", cts: "2026-11-19T10:00:00.000Z", exp: "2026-11-19T11:30:00.000Z" },
            { src: "did:plc:labeler3", uri: uri1, cid: "bafyOLDVERSION", val: "graphic-media", cts: "2026-11-19T10:00:00.000Z" },
            { src: "did:plc:labeler4", uri: uri1, val: "!warn", cts: "2026-11-19T10:00:00.000Z" },
        ];
        const { entries } = await mounted(net);
        const e = byUri(entries, uri1);
        const labels = JSON.parse(e.data.labels);
        assert.equal(labels.length, 5);
        assert.deepEqual(labels[1], { src: "did:plc:labeler1", uri: uri1, cid: cid1, val: "porn", neg: true, cts: "2026-11-19T11:00:00.000Z" });
        assert.equal(labels[2].exp, "2026-11-19T11:30:00.000Z");
        assert.equal(labels[3].cid, "bafyOLDVERSION");
        // negated, expired and other-version labels are not active; an
        // un-versioned label applies to every version
        assert.deepEqual(e.data.activeLabels, ["!warn"]);
        assert.equal(e.data.moderation, "labelled");
        const clean = byUri(entries, uri2);
        assert.equal(clean.data.moderation, "none");
        assert.deepEqual(JSON.parse(clean.data.labels), []);
    });

    it("an unavailable AppView keeps records visible and marks moderation unknown", async () => {
        const net = standardNet();
        net.appviewUp = false;
        const { entries } = await mounted(net);
        const e = byUri(entries, uri1);
        assert.ok(e, "record still mounted");
        assert.equal(e.data.moderation, "unavailable");
        assert.ok(!("labels" in e.data));
    });

    it("no AppView configured also means moderation unavailable, never 'none'", async () => {
        const { entries } = await mounted(standardNet(), [ALICE, BOB], { appviewUrl: "" });
        const e = byUri(entries, uri1);
        assert.equal(e.data.moderation, "unavailable");
    });

    it("a failed label read does not fail the inventory", async () => {
        const net = standardNet();
        net.faults.push({ match: (u) => u.startsWith(APPVIEW), status: 429 });
        const { reader, entries } = await mounted(net);
        assert.ok(byUri(entries, uri1));
        assert.ok(reader.lastReport!.accounts.every((a) => a.ok));
    });
});

describe("P3: label recency compares instants, not strings", () => {
    const uri = `at://${ALICE}/${POST}/3kalice00001a`;
    const now = new Date("2026-11-19T12:00:00.000Z");

    it("a timezone offset does not make an older negation win", () => {
        // negation at 09:00Z (written +02:00) is OLDER than the label at 10:00Z
        const labels = [
            { src: "did:plc:l", uri, val: "spam", cts: "2026-11-19T10:00:00.000Z" },
            { src: "did:plc:l", uri, val: "spam", neg: true, cts: "2026-11-19T11:00:00.000+02:00" },
        ];
        assert.deepEqual(activeLabels(labels, uri, "bafy", now), ["spam"]);
    });

    it("a negation with an unparseable cts does not override a dated label", () => {
        const labels = [
            { src: "did:plc:l", uri, val: "spam", cts: "2026-11-19T10:00:00.000Z" },
            { src: "did:plc:l", uri, val: "spam", neg: true, cts: "not-a-time" },
        ];
        assert.deepEqual(activeLabels(labels, uri, "bafy", now), ["spam"]);
    });

    it("missing milliseconds do not make an older event win", () => {
        // "…10:00:00Z" is 1 ms before "…10:00:00.001Z" but sorts after it as a string
        const labels = [
            { src: "did:plc:l", uri, val: "spam", neg: true, cts: "2026-11-19T10:00:00.001Z" },
            { src: "did:plc:l", uri, val: "spam", cts: "2026-11-19T10:00:00Z" },
        ];
        assert.deepEqual(activeLabels(labels, uri, "bafy", now), []);
    });
});

describe("round 3: object-valued label timestamps are invalid, not fatal", () => {
    const uri1 = `at://${ALICE}/${POST}/3kalice00001a`;

    async function withLabels(labels: any[]) {
        const net = standardNet();
        net.labels = labels;
        const r = new MountedReader({ ...baseConfig, accounts: [ALICE, BOB], transport: net, now: NOW });
        const report = await r.refresh();
        return { report, e: r.snapshot().entries.find((x) => x.data.sourceUri === uri1) };
    }

    it("an object cts sorts as invalid (oldest) instead of throwing", async () => {
        const { report, e } = await withLabels([
            { src: "did:plc:l", uri: uri1, val: "spam", cts: "2026-11-19T10:00:00.000Z" },
            { src: "did:plc:l", uri: uri1, val: "spam", neg: true, cts: { not: "a time" } },
        ]);
        assert.ok(report.accounts.every((a) => a.ok), JSON.stringify(report.accounts));
        assert.deepEqual(e!.data.activeLabels, ["spam"]);
        assert.equal(JSON.parse(e!.data.labels as string)[1].cts.not, "a time", "kept as served");
    });

    it("an object exp is treated as absent instead of throwing", async () => {
        const { report, e } = await withLabels([
            { src: "did:plc:l", uri: uri1, val: "!warn", cts: "2026-11-19T10:00:00.000Z", exp: {} },
        ]);
        assert.ok(report.accounts.every((a) => a.ok), JSON.stringify(report.accounts));
        assert.deepEqual(e!.data.activeLabels, ["!warn"]);
    });

    it("activeLabels itself accepts null-prototype timestamp objects", () => {
        const o = Object.create(null);
        const labels: any[] = [
            { src: "s", uri: uri1, val: "a", cts: o },
            { src: "s", uri: uri1, val: "a", cts: o, exp: o },
        ];
        assert.deepEqual(activeLabels(labels, uri1, "bafy", NOW()), ["a"]);
    });
});
