/**
 * Mounted reader — DID resolution and inventory reads (acceptance rules 3
 * and 5 at the reader boundary).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveDid, readAccount } from "../src/mount/reader.js";
import {
    standardNet, baseConfig, ALICE, BOB, CAROL, PDS, PDS2, PLC, POST, plainPost,
} from "./mount-fixtures.js";

describe("rule 3: DID resolution through validated PDS discovery", () => {
    it("resolves did:plc through the PLC directory", async () => {
        const net = standardNet();
        const r = await resolveDid(ALICE, net, baseConfig);
        assert.deepEqual(r, { did: ALICE, handle: "alice.test", pds: PDS });
        assert.deepEqual(net.requests(/plc\.test/), [`${PLC}/${ALICE}`]);
    });

    it("resolves hostname did:web through /.well-known/did.json", async () => {
        const net = standardNet();
        const r = await resolveDid(CAROL, net, baseConfig);
        assert.deepEqual(r, { did: CAROL, handle: "carol.example", pds: PDS2 });
        assert.deepEqual(net.requests(/carol\.example/), ["https://carol.example/.well-known/did.json"]);
    });

    it("rejects a DID document whose id names another account", async () => {
        const net = standardNet();
        net.didDocs.set(ALICE, net.docFor(BOB, "bob.test", PDS));
        await assert.rejects(resolveDid(ALICE, net, baseConfig), /id/);
    });

    it("rejects a document without an #atproto_pds service", async () => {
        const net = standardNet();
        const doc: any = net.docFor(ALICE, "alice.test", PDS);
        doc.service = [{ id: "#other", type: "Whatever", serviceEndpoint: PDS }];
        net.didDocs.set(ALICE, doc);
        await assert.rejects(resolveDid(ALICE, net, baseConfig), /atproto_pds/);
    });

    it("rejects a non-http(s) PDS endpoint", async () => {
        const net = standardNet();
        net.didDocs.set(ALICE, net.docFor(ALICE, "alice.test", "ftp://pds.test"));
        await assert.rejects(resolveDid(ALICE, net, baseConfig), /endpoint/);
    });

    it("rejects path did:web and non-ATProto DID methods without any request", async () => {
        const net = standardNet();
        await assert.rejects(resolveDid("did:web:example.com:user:alice", net, baseConfig), /did:web/);
        await assert.rejects(resolveDid("did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK", net, baseConfig), /method/);
        await assert.rejects(resolveDid("alice.test", net, baseConfig), /DID/);
        assert.equal(net.log.length, 0);
    });

    it("a failed lookup never falls back to another PDS or account", async () => {
        const net = standardNet();
        net.didDocs.delete(ALICE);
        await assert.rejects(readAccount(ALICE, net, baseConfig), /resolve/);
        assert.deepEqual(net.requests(/\/xrpc\//), [], "no PDS was asked for anything");
    });

    it("rejects a PDS that answers for a different repo DID", async () => {
        const net = standardNet();
        // Alice's document points at a PDS whose describeRepo says Bob
        const orig = net.fetch.bind(net);
        net.fetch = async (url, m, h, b) => {
            if (url.includes("describeRepo")) {
                return { status: 200, headers: {}, body: JSON.stringify({ did: BOB, handle: "bob.test" }) };
            }
            return orig(url, m, h, b);
        };
        await assert.rejects(readAccount(ALICE, net, baseConfig), /describeRepo/);
    });

    it("rejects listed records whose URI names another repo", async () => {
        const net = standardNet();
        const orig = net.fetch.bind(net);
        net.fetch = async (url, m, h, b) => {
            const res = await orig(url, m, h, b);
            if (url.includes("listRecords") && url.includes(encodeURIComponent(ALICE))) {
                return { ...res, body: res.body.split(ALICE).join(BOB) };
            }
            return res;
        };
        await assert.rejects(readAccount(ALICE, net, baseConfig), /another repo|repo/);
    });
});

describe("rule 5: inventories are complete or rejected", () => {
    it("pages through every record and pins the revision", async () => {
        const net = standardNet();
        for (let i = 0; i < 230; i++) {
            net.put(BOB, POST, "3kbulk" + String(i).padStart(7, "2"), plainPost("bulk " + i));
        }
        const r = await readAccount(BOB, net, { ...baseConfig, pageLimit: 100 });
        assert.equal(r.records.filter((x) => x.collection === POST).length, 231);
        assert.equal(r.rev, net.repos.get(BOB)!.rev);
        assert.equal(net.requests(/listRecords.*app\.bsky\.feed\.post/).length, 3);
    });

    it("a head that moves during the read rejects the inventory", async () => {
        const net = standardNet();
        net.faults.push({ match: (u) => u.includes("listRecords"), bumpRevOf: ALICE, once: true });
        await assert.rejects(readAccount(ALICE, net, baseConfig), /revision/);
    });

    it("a 429 page rejects the inventory", async () => {
        const net = standardNet();
        for (let i = 0; i < 150; i++) net.put(ALICE, POST, "3kbulk" + String(i).padStart(7, "2"), plainPost("b" + i));
        net.faults.push({ match: (u) => u.includes("listRecords") && u.includes("cursor="), status: 429 });
        await assert.rejects(readAccount(ALICE, net, baseConfig), /429/);
    });

    it("a timeout rejects the inventory", async () => {
        const net = standardNet();
        net.faults.push({ match: (u) => u.includes("listRecords"), hang: true });
        await assert.rejects(readAccount(ALICE, net, { ...baseConfig, timeoutMs: 50 }), /timed out/);
    });

    it("a 5xx and a malformed body reject the inventory", async () => {
        const net = standardNet();
        net.faults.push({ match: (u) => u.includes("listRecords"), status: 502, once: true });
        await assert.rejects(readAccount(ALICE, net, baseConfig), /502/);
        net.faults.push({ match: (u) => u.includes("listRecords"), status: 200, body: "{not json", once: true });
        await assert.rejects(readAccount(ALICE, net, baseConfig), /JSON|parse/i);
    });

    it("too many pages is incomplete, not partial", async () => {
        const net = standardNet();
        for (let i = 0; i < 30; i++) net.put(ALICE, POST, "3kbulk" + String(i).padStart(7, "2"), plainPost("b" + i));
        await assert.rejects(readAccount(ALICE, net, { ...baseConfig, pageLimit: 10, maxPages: 2 }), /pages/);
    });

    it("a repeating cursor is rejected instead of looping", async () => {
        const net = standardNet();
        for (let i = 0; i < 30; i++) net.put(ALICE, POST, "3kbulk" + String(i).padStart(7, "2"), plainPost("b" + i));
        const orig = net.fetch.bind(net);
        net.fetch = async (url, m, h, b) => {
            const res = await orig(url, m, h, b);
            if (url.includes("listRecords")) {
                const j = JSON.parse(res.body);
                return { ...res, body: JSON.stringify({ ...j, cursor: "stuck" }) };
            }
            return res;
        };
        await assert.rejects(readAccount(ALICE, net, { ...baseConfig, pageLimit: 10 }), /cursor/);
    });

    it("a deactivated repo reads as an empty, complete, inactive inventory", async () => {
        const net = standardNet();
        net.repos.get(ALICE)!.active = false;
        net.repos.get(ALICE)!.status = "deactivated";
        const r = await readAccount(ALICE, net, baseConfig);
        assert.equal(r.active, false);
        assert.equal(r.status, "deactivated");
        assert.deepEqual(r.records, []);
    });
});
