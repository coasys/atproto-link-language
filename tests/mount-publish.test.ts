/**
 * Slice 2 rules 1, 3 and 4 (hermetic): explicit publication through the
 * ATPost constructor, the durable publication key with listing before any
 * retry, and the read-back by a distinct account's reader.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { MountService, type ServiceOptions } from "../src/mount/service.js";
import { PublishError } from "../src/mount/publisher.js";
import { mountShapes } from "../src/mount/shapes.js";
import { isTid } from "../src/mount/reader.js";
import { newTid, TidClock } from "../src/mount/bytes.js";
import { CAROL, FOLLOW, PDS, PLC, followOf, plainPost } from "./mount-fixtures.js";
import { ALICE, BOB, CrashError, FakeAgent, MemStorage, POST, SCOPE, testCrypto, writeNet, type FakeWriteNet } from "./mount-write-fixtures.js";
import { ledgerFiles } from "../src/mount/publisher.js";

const LANG = "QmzTestLanguage";

function service(net: FakeWriteNet, opts: Omit<Partial<ServiceOptions>, "agent"> & { agent?: FakeAgent } = {}) {
    const { agent: given, ...over } = opts;
    const agent = given ?? new FakeAgent();
    const storage = over.storage ?? new MemStorage();
    const svc = new MountService({
        accounts: [ALICE, BOB],
        plcUrl: PLC,
        appviewUrl: "",
        transport: net,
        storage,
        files: (storage as MemStorage).disk.api(),
        crypto: testCrypto,
        agent: { did: () => agent.did, openSealed: (b) => agent.openSealed(b) },
        timeoutMs: 200,
        writeTimeoutMs: 200,
        pageLimit: 100,
        maxPages: 50,
        languageAddress: () => LANG,
        ...over,
    });
    return { svc, agent, storage: storage as MemStorage };
}

async function authorize(svc: MountService, net: FakeWriteNet, did = ALICE) {
    const begin = await svc.call("project", "authorize", { account: did });
    return svc.call("project", "completeAuthorization", { callbackUrl: net.approve(begin.authorizeUrl, did) });
}

/** createRecord requests that reached the handler (carried the RS nonce) */
function attempts(net: FakeWriteNet, mark = 0) {
    return net.requestsLog.slice(mark).filter((r) => {
        if (!(r.method === "POST" && r.url.includes("com.atproto.repo.createRecord"))) return false;
        const payload = JSON.parse(Buffer.from((r.headers["dpop"] ?? "..").split(".")[1], "base64url").toString() || "{}");
        return payload.nonce === net.rsNonce;
    });
}

const KEY = "pub-key-0001";
const TEXT = "Hello from AD4M, published explicitly";

async function ready() {
    const net = writeNet();
    const h = service(net);
    await h.svc.refresh();
    await authorize(h.svc, net);
    return { net, ...h };
}

describe("rule 1: publication is an explicit ATPost constructor call", () => {
    it("ATPost has exactly one constructor: a call to <lang>://class/ATPost publish; nothing else writes", () => {
        const shapes = mountShapes(LANG).shapes;
        const post = shapes.find((s) => s.name === "ATPost")!.shape as any;
        assert.deepEqual(post.constructor_actions, [{ action: "call", source: `${LANG}://class/ATPost`, predicate: "publish", target: "{}" }]);
        assert.deepEqual(post.destructor_actions, []);
        for (const s of shapes) {
            if (s.name !== "ATPost") assert.deepEqual((s.shape as any).constructor_actions, [], `${s.name} has no constructor`);
            for (const p of (s.shape as any).properties) {
                assert.equal(p.setter, undefined, `${s.name}.${p.name} has no setter`);
                assert.notEqual(p.writable, true, `${s.name}.${p.name} is not writable`);
            }
        }
        assert.ok(post.properties.some((p: any) => p.name === "publicationKey" && p.max_count === 1));
    });

    it("only class/ATPost offers publish; record addresses offer no interaction (annotations never reach the PDS)", async () => {
        const { svc } = service(writeNet());
        assert.deepEqual(svc.interactions("class/ATPost").map((i) => i.name), ["publish"]);
        assert.deepEqual(svc.interactions(`${ALICE}/${POST}/3kalice00001a`), []);
        assert.deepEqual(svc.interactions(`account/${ALICE}`), []);
        assert.deepEqual(svc.interactions("class/ATFollow"), []);
        assert.deepEqual(
            svc.interactions("project").map((i) => i.name).sort(),
            ["authorize", "completeAuthorization", "refresh", "sessions", "signOut", "status"],
        );
    });

    it("publish creates one app.bsky.feed.post through createRecord as the authorized account", async () => {
        const { net, svc } = await ready();
        const mark = net.requestsLog.length;
        const delta = await svc.call("class/ATPost", "publish", { text: TEXT, atAuthor: ALICE, publicationKey: KEY });
        const sent = attempts(net, mark);
        assert.equal(sent.length, 1, "one createRecord reached the PDS");
        const body = JSON.parse(sent[0].body);
        assert.equal(body.repo, ALICE);
        assert.equal(body.collection, POST);
        assert.ok(isTid(body.rkey), "client-chosen TID rkey");
        assert.notEqual(body.validate, false);
        assert.deepEqual(Object.keys(body.record), ["$type", "text", "createdAt"]);
        assert.equal(body.record.$type, POST);
        assert.equal(body.record.text, TEXT);
        assert.ok(!Number.isNaN(Date.parse(body.record.createdAt)));
        const stored = net.postsWithText(ALICE, TEXT);
        assert.equal(stored.length, 1);
        assert.equal(delta.address, `${ALICE}/${POST}/${body.rkey}`);
        assert.deepEqual(delta.removed, []);
        assert.equal(delta.changed.length, 1);
        const e = delta.changed[0];
        assert.equal(e.class, "ATPost");
        assert.equal(e.address, delta.address);
        assert.equal(e.data.sourceUri, `at://${delta.address}`);
        assert.equal(e.data.cid, stored[0].cid);
        assert.equal(e.data.atAuthor, ALICE);
        assert.equal(e.data.text, TEXT);
        assert.equal(e.data.publicationKey, KEY);
        assert.equal(e.data.verification, "transportTrusted");
        assert.equal("author" in e.data, false, "no AD4M author: the executor signs links, the AT author is atAuthor");
    });

    it("refresh, snapshot, status and sessions never write — not even with a pending publication", async () => {
        const { net, svc } = await ready();
        net.writeFaults.push({ kind: "hangBeforeCommit" });
        await assert.rejects(svc.call("class/ATPost", "publish", { text: TEXT, atAuthor: ALICE, publicationKey: KEY }), PublishError);
        assert.equal(svc.publisher.ledgerEntry(KEY)?.state, "pending");
        const mark = net.requestsLog.length;
        for (let i = 0; i < 3; i++) {
            await svc.refresh();
            svc.snapshot();
            await svc.call("project", "status");
            await svc.call("project", "sessions");
        }
        const posts = net.requestsLog.slice(mark).filter((r) => r.method !== "GET");
        assert.deepEqual(posts.map((r) => r.url), [], "no POST of any kind");
        assert.equal(svc.publisher.ledgerEntry(KEY)?.state, "pending", "a sync does not resolve or retry it either");
    });

    it("refuses bad input before any request", async () => {
        const { net, svc } = await ready();
        const cases: Array<[string, Record<string, unknown>, RegExp]> = [
            ["no key", { text: TEXT, atAuthor: ALICE }, /publicationKey/],
            ["short key", { text: TEXT, atAuthor: ALICE, publicationKey: "k1" }, /publicationKey/],
            ["empty text", { text: "  ", atAuthor: ALICE, publicationKey: KEY }, /text/],
            ["long text", { text: "x".repeat(301), atAuthor: ALICE, publicationKey: KEY }, /300/],
            ["text not a string", { text: 5, atAuthor: ALICE, publicationKey: KEY }, /text/],
            ["author not a DID", { text: TEXT, atAuthor: "alice.test", publicationKey: KEY }, /atAuthor/],
            ["author outside the allowlist", { text: TEXT, atAuthor: CAROL, publicationKey: KEY }, /allowlist/],
            ["author not authorized", { text: TEXT, atAuthor: BOB, publicationKey: KEY }, /not authorized/],
        ];
        for (const [name, params, re] of cases) {
            const mark = net.requestsLog.length;
            await assert.rejects(svc.call("class/ATPost", "publish", params), re, name);
            assert.deepEqual(net.requestsLog.slice(mark).map((r) => r.url), [], `${name}: no request`);
            assert.equal(svc.publisher.ledgerEntry(String(params.publicationKey ?? "")), null, `${name}: no ledger entry`);
        }
    });

    it("a new rkey is a valid, increasing TID", () => {
        const a = newTid(1_795_000_000_000, 1);
        const b = newTid(1_795_000_000_001, 0);
        assert.ok(isTid(a) && isTid(b));
        assert.ok(a < b);
    });
});

describe("rule 3: a durable publication key; an uncertain create is listed before any retry", () => {
    it("the same key twice gives one record and the same URI/CID, with no second request", async () => {
        const { net, svc } = await ready();
        const first = await svc.call("class/ATPost", "publish", { text: TEXT, atAuthor: ALICE, publicationKey: KEY });
        const mark = net.requestsLog.length;
        const again = await svc.call("class/ATPost", "publish", { text: TEXT, atAuthor: ALICE, publicationKey: KEY });
        assert.deepEqual(net.requestsLog.slice(mark).map((r) => r.url), []);
        assert.deepEqual(again, first);
        assert.equal(net.postsWithText(ALICE, TEXT).length, 1);
        const led = svc.publisher.ledgerEntry(KEY)!;
        assert.equal(led.state, "published");
        assert.equal(led.uri, first.changed[0].data.sourceUri);
        assert.equal(led.cid, first.changed[0].data.cid);
    });

    it("the same key with other content is refused, with no request", async () => {
        const { net, svc } = await ready();
        await svc.call("class/ATPost", "publish", { text: TEXT, atAuthor: ALICE, publicationKey: KEY });
        const mark = net.requestsLog.length;
        await assert.rejects(svc.call("class/ATPost", "publish", { text: TEXT + "!", atAuthor: ALICE, publicationKey: KEY }), /already used/);
        assert.deepEqual(net.requestsLog.slice(mark).map((r) => r.url), []);
    });

    it("the ledger survives a restart: the key still answers without a request", async () => {
        const { net, svc, agent, storage } = await ready();
        const first = await svc.call("class/ATPost", "publish", { text: TEXT, atAuthor: ALICE, publicationKey: KEY });
        const { svc: restarted } = service(net, { agent, storage });
        const mark = net.requestsLog.length;
        const again = await restarted.call("class/ATPost", "publish", { text: TEXT, atAuthor: ALICE, publicationKey: KEY });
        assert.deepEqual(net.requestsLog.slice(mark).map((r) => r.url), []);
        assert.deepEqual(again, first);
    });

    for (const kind of ["commitThenHang", "commitThen500"] as const) {
        it(`${kind}: the create is uncertain; the retry lists first, finds it and sends nothing`, async () => {
            const { net, svc } = await ready();
            net.writeFaults.push({ kind });
            await assert.rejects(
                svc.call("class/ATPost", "publish", { text: TEXT, atAuthor: ALICE, publicationKey: KEY }),
                (e: unknown) => e instanceof PublishError && e.uncertain && /retry with the same publicationKey/.test(e.message),
            );
            assert.equal(net.postsWithText(ALICE, TEXT).length, 1, "the PDS did commit it");
            const led = svc.publisher.ledgerEntry(KEY)!;
            assert.equal(led.state, "pending");
            const mark = net.requestsLog.length;
            const res = await svc.call("class/ATPost", "publish", { text: TEXT, atAuthor: ALICE, publicationKey: KEY });
            const after = net.requestsLog.slice(mark);
            const firstList = after.findIndex((r) => r.url.includes("com.atproto.repo.listRecords") && r.url.includes(`repo=${encodeURIComponent(ALICE)}`));
            assert.ok(firstList >= 0, "the account's records were listed");
            assert.equal(attempts(net, mark).length, 0, "no createRecord: the listing found it");
            assert.equal(net.postsWithText(ALICE, TEXT).length, 1, "still exactly one record");
            const rec = net.postsWithText(ALICE, TEXT)[0];
            assert.equal(res.address, `${ALICE}/${POST}/${rec.rkey}`);
            assert.equal(res.address.split("/").pop(), led.rkey, "the rkey chosen before the first send");
            assert.equal(res.changed[0].data.cid, rec.cid);
            assert.equal(svc.publisher.ledgerEntry(KEY)!.state, "published");
        });
    }

    it("hangBeforeCommit: the retry lists, finds nothing, then re-sends the same rkey; one record", async () => {
        const { net, svc } = await ready();
        net.writeFaults.push({ kind: "hangBeforeCommit" });
        await assert.rejects(svc.call("class/ATPost", "publish", { text: TEXT, atAuthor: ALICE, publicationKey: KEY }), PublishError);
        const rkey = svc.publisher.ledgerEntry(KEY)!.rkey;
        const mark = net.requestsLog.length;
        await svc.call("class/ATPost", "publish", { text: TEXT, atAuthor: ALICE, publicationKey: KEY });
        const listAt = net.indexes((r) => r.url.includes("com.atproto.repo.listRecords")).filter((i) => i >= mark);
        const sendAt = net.indexes((r) => r.method === "POST" && r.url.includes("createRecord")).filter((i) => i >= mark);
        assert.ok(listAt.length > 0 && sendAt.length > 0);
        assert.ok(Math.min(...listAt) < Math.min(...sendAt), "listed before the re-send");
        assert.equal(attempts(net, mark).length, 1);
        assert.equal(JSON.parse(attempts(net, mark)[0].body).rkey, rkey);
        assert.equal(net.postsWithText(ALICE, TEXT).length, 1);
    });

    it("a definite rejection is listed before the next attempt too", async () => {
        const { net, svc } = await ready();
        net.writeFaults.push({ kind: "statusBeforeCommit", status: 400 });
        await assert.rejects(svc.call("class/ATPost", "publish", { text: TEXT, atAuthor: ALICE, publicationKey: KEY }), PublishError);
        const mark = net.requestsLog.length;
        await svc.call("class/ATPost", "publish", { text: TEXT, atAuthor: ALICE, publicationKey: KEY });
        const listAt = net.indexes((r) => r.url.includes("com.atproto.repo.listRecords")).filter((i) => i >= mark);
        const sendAt = net.indexes((r) => r.method === "POST" && r.url.includes("createRecord")).filter((i) => i >= mark);
        assert.ok(listAt.length > 0 && Math.min(...listAt) < Math.min(...sendAt));
        assert.equal(net.postsWithText(ALICE, TEXT).length, 1);
    });

    it("a failed listing never re-sends", async () => {
        const { net, svc } = await ready();
        net.writeFaults.push({ kind: "hangBeforeCommit" });
        await assert.rejects(svc.call("class/ATPost", "publish", { text: TEXT, atAuthor: ALICE, publicationKey: KEY }), PublishError);
        net.faults.push({ match: (u) => u.includes("com.atproto.repo.listRecords"), status: 503 });
        const mark = net.requestsLog.length;
        await assert.rejects(svc.call("class/ATPost", "publish", { text: TEXT, atAuthor: ALICE, publicationKey: KEY }), PublishError);
        assert.equal(net.requestsLog.slice(mark).filter((r) => r.url.includes("createRecord")).length, 0);
        assert.equal(svc.publisher.ledgerEntry(KEY)!.state, "pending");
    });

    it("a pending publication survives a restart and is listed before any retry", async () => {
        const { net, svc, agent, storage } = await ready();
        net.writeFaults.push({ kind: "commitThenHang" });
        await assert.rejects(svc.call("class/ATPost", "publish", { text: TEXT, atAuthor: ALICE, publicationKey: KEY }), PublishError);
        const { svc: restarted } = service(net, { agent, storage });
        const mark = net.requestsLog.length;
        await restarted.call("class/ATPost", "publish", { text: TEXT, atAuthor: ALICE, publicationKey: KEY });
        assert.equal(attempts(net, mark).length, 0);
        assert.ok(net.requestsLog.slice(mark).some((r) => r.url.includes("com.atproto.repo.listRecords")));
        assert.equal(net.postsWithText(ALICE, TEXT).length, 1);
    });

    it("concurrent publishes with one key make one create", async () => {
        const { net, svc } = await ready();
        const mark = net.requestsLog.length;
        const p = { text: TEXT, atAuthor: ALICE, publicationKey: KEY };
        const [a, b] = await Promise.all([svc.call("class/ATPost", "publish", p), svc.call("class/ATPost", "publish", p)]);
        assert.deepEqual(a, b);
        assert.equal(attempts(net, mark).length, 1);
        assert.equal(net.postsWithText(ALICE, TEXT).length, 1);
    });

    it("the snapshot keeps the published post until a read at or after its commit includes it; no flap, deletion still removes", async () => {
        const { net, svc } = await ready();
        const delta = await svc.call("class/ATPost", "publish", { text: TEXT, atAuthor: ALICE, publicationKey: KEY });
        const inSnap = () => svc.snapshot().entries.find((e) => e.address === delta.address);
        assert.deepEqual(inSnap(), delta.changed[0], "served before any read");
        const r1 = await svc.refresh();
        assert.deepEqual(inSnap(), delta.changed[0], "the read's entry carries the key too");
        assert.ok(!r1.delta.changed.some((e) => e.address === delta.address), "the read changes nothing about it");
        assert.ok(!r1.delta.removed.includes(delta.address));
        net.del(ALICE, POST, delta.address.split("/").pop()!);
        const r2 = await svc.refresh();
        assert.ok(r2.delta.removed.includes(delta.address), "a later complete read without it removes it");
        assert.equal(inSnap(), undefined);
    });
});

describe("round 2 item 2: the ledger is written atomically and acknowledged before any send", () => {
    const P = { text: TEXT, atAuthor: ALICE, publicationKey: KEY };
    const creates = (net: FakeWriteNet, mark = 0) => net.requestsLog.slice(mark).filter((r) => r.method === "POST" && r.url.includes("createRecord"));

    it("a host without an atomic durable write cannot publish; an already published key still answers", async () => {
        const { net, svc, storage } = await ready();
        const first = await svc.call("class/ATPost", "publish", P);
        storage.disk.atomic = false;
        assert.deepEqual(await svc.call("class/ATPost", "publish", P), first, "the published key answers from the ledger");
        const mark = net.requestsLog.length;
        await assert.rejects(svc.call("class/ATPost", "publish", { ...P, publicationKey: "other-key-0001" }), /atomic/);
        assert.deepEqual(net.requestsLog.slice(mark).map((r) => r.url), [], "no request at all");
    });

    it("the ledger is not kept in the best-effort KV", async () => {
        const { svc, storage, agent } = await ready();
        await svc.call("class/ATPost", "publish", P);
        assert.ok(![...storage.map.keys()].some((k) => k.startsWith("publish/")), "nothing under publish/ in the KV");
        assert.ok(storage.disk.files.has(ledgerFiles.entry(agent.did, KEY)));
    });

    it("a failed ledger write (the pre-chosen rkey, attempt on record) blocks the send", async () => {
        for (const when of ['"attempts":0', '"attempts":1']) {
            const { net, svc, storage } = await ready();
            storage.disk.failWrite = (_n, c) => c.includes(when);
            const mark = net.requestsLog.length;
            await assert.rejects(svc.call("class/ATPost", "publish", P), /ledger/, when);
            assert.equal(creates(net, mark).length, 0, `${when}: no createRecord`);
            assert.equal(net.postsWithText(ALICE, TEXT).length, 0);
        }
    });

    it("a crash between the temp write and the rename keeps the old ledger; after a restart the same rkey is listed and nothing is posted twice", async () => {
        const { net, svc, agent, storage } = await ready();
        net.writeFaults.push({ kind: "commitThenHang" });
        await assert.rejects(svc.call("class/ATPost", "publish", P), PublishError);
        const before = storage.disk.files.get(ledgerFiles.entry(agent.did, KEY))!;
        const rkey = JSON.parse(before).rkey;
        // the retry finds the record and crashes while recording "published"
        storage.disk.crashBeforeRename = (_n, c) => c.includes('"state":"published"');
        // round 3 #1: the boundary reports a fixed code, not the crash's text
        await assert.rejects(svc.call("class/ATPost", "publish", P), /OUTCOME_NOT_RECORDED/);
        assert.equal(storage.disk.files.get(ledgerFiles.entry(agent.did, KEY)), before, "the old entry is intact");
        const { svc: restarted } = service(net, { agent, storage });
        const mark = net.requestsLog.length;
        const res = await restarted.call("class/ATPost", "publish", P);
        assert.equal(res.address.split("/").pop(), rkey, "the same rkey");
        assert.equal(creates(net, mark).length, 0, "listed, not re-sent");
        assert.equal(net.postsWithText(ALICE, TEXT).length, 1);
    });

    it("an unreadable ledger entry fails closed: no new rkey, no request", async () => {
        const { net, svc, agent, storage } = await ready();
        storage.disk.files.set(ledgerFiles.entry(agent.did, KEY), '{"v":1,"key":"pub-key-0001","rk');
        const mark = net.requestsLog.length;
        await assert.rejects(svc.call("class/ATPost", "publish", P), /unreadable/);
        assert.deepEqual(net.requestsLog.slice(mark).map((r) => r.url), []);
    });

    it("a round-1 KV ledger entry is adopted (same rkey), never re-minted", async () => {
        const { net, svc, agent, storage } = await ready();
        const rkey = "3n2oaaaaaaa22";
        net.put(ALICE, POST, rkey, JSON.stringify({ $type: POST, text: TEXT, createdAt: "2026-11-19T20:00:00.000Z" }));
        storage.put(`publish/v1/${agent.did}/${KEY}`, JSON.stringify({ v: 1, key: KEY, account: ALICE, text: TEXT, createdAt: "2026-11-19T20:00:00.000Z", rkey, state: "pending", attempts: 1 }));
        const mark = net.requestsLog.length;
        const res = await svc.call("class/ATPost", "publish", P);
        assert.equal(res.address.split("/").pop(), rkey);
        assert.equal(creates(net, mark).length, 0);
        assert.equal(JSON.parse(storage.disk.files.get(ledgerFiles.entry(agent.did, KEY))!).state, "published");
    });
});

describe("round 2 item 3: reconciliation is a strict, stable, exact read", () => {
    const P = { text: TEXT, atAuthor: ALICE, publicationKey: KEY };
    const creates = (net: FakeWriteNet, mark: number) => net.requestsLog.slice(mark).filter((r) => r.method === "POST" && r.url.includes("createRecord"));
    async function uncertain() {
        const h = await ready();
        h.net.writeFaults.push({ kind: "hangBeforeCommit" }); // not on the PDS: a resend would be the danger
        await assert.rejects(h.svc.call("class/ATPost", "publish", P), PublishError);
        return { ...h, rkey: h.svc.publisher.ledgerEntry(KEY)!.rkey };
    }
    const isList = (u: string) => u.includes("com.atproto.repo.listRecords") && u.includes(encodeURIComponent(POST));

    it("a malformed listing page is a failed read: nothing is sent", async () => {
        const bodies = [
            "{}",
            JSON.stringify({ error: "temporarily_unavailable" }),
            JSON.stringify({ records: null }),
            JSON.stringify({ records: [], cursor: 5 }),
            JSON.stringify({ records: [{ uri: `at://${ALICE}/${POST}/3kaaaaaaaaa2a` }] }),
            JSON.stringify({ records: [{ uri: `at://${ALICE}/${POST}/3kaaaaaaaaa2a`, cid: "bafyx", value: "text" }] }),
            JSON.stringify({ records: [{ uri: `at://${BOB}/${POST}/3kaaaaaaaaa2a`, cid: "bafyx", value: {} }] }),
        ];
        for (const body of bodies) {
            const { net, svc } = await uncertain();
            net.faults.push({ match: isList, status: 200, body, once: true });
            const mark = net.requestsLog.length;
            await assert.rejects(svc.call("class/ATPost", "publish", P), PublishError, body);
            assert.equal(creates(net, mark).length, 0, `${body}: no createRecord`);
            assert.equal(svc.publisher.ledgerEntry(KEY)!.state, "pending");
        }
    });

    it("a head that moves during the listing is a failed read: nothing is sent", async () => {
        const { net, svc } = await uncertain();
        net.faults.push({ match: isList, bumpRevOf: ALICE, once: true });
        const mark = net.requestsLog.length;
        await assert.rejects(svc.call("class/ATPost", "publish", P), PublishError);
        assert.equal(creates(net, mark).length, 0);
    });

    it("a record at our rkey that is not exactly ours is a conflict: not credited, not resent", async () => {
        for (const other of [
            { $type: POST, text: TEXT, createdAt: "2001-01-01T00:00:00.000Z" },
            { $type: POST, text: TEXT, createdAt: "@", langs: ["en"] },
            { $type: "app.example.other", text: TEXT, createdAt: "@" },
        ]) {
            const { net, svc, rkey } = await uncertain();
            const mine = svc.publisher.ledgerEntry(KEY)!;
            const value = { ...other, createdAt: other.createdAt === "@" ? mine.createdAt : other.createdAt };
            net.put(ALICE, POST, rkey, JSON.stringify(value));
            const mark = net.requestsLog.length;
            await assert.rejects(svc.call("class/ATPost", "publish", P), /not this publication/, JSON.stringify(other));
            assert.equal(creates(net, mark).length, 0);
            assert.equal(svc.publisher.ledgerEntry(KEY)!.state, "pending");
        }
    });

    it("an inactive account cannot confirm anything: nothing is sent", async () => {
        const { net, svc } = await uncertain();
        net.repos.get(ALICE)!.active = false;
        const mark = net.requestsLog.length;
        await assert.rejects(svc.call("class/ATPost", "publish", P), PublishError);
        assert.equal(creates(net, mark).length, 0);
    });
});

describe("round 2 item 4: the overlay keeps a publication until a read includes it", () => {
    const P = { text: TEXT, atAuthor: ALICE, publicationKey: KEY };
    const inSnap = (svc: MountService, address: string) => svc.snapshot().entries.find((e) => e.address === address);
    const isPostList = (u: string) => u.includes("com.atproto.repo.listRecords") && u.includes(encodeURIComponent(ALICE)) && u.includes(encodeURIComponent(POST));
    /** alice's real post listing without `rkey` — a short page at the current head */
    function listingWithout(net: FakeWriteNet, rkey: string): string {
        const recs = (net.repos.get(ALICE)!.collections.get(POST) ?? []).filter((r) => r.rkey !== rkey)
            .map((r) => `{"uri":${JSON.stringify(`at://${ALICE}/${POST}/${r.rkey}`)},"cid":${JSON.stringify(r.cid)},"value":${r.value}}`);
        return `{"records":[${recs.join(",")}]}`;
    }

    it("a publication answered without a commit revision is served until a read includes it", async () => {
        const { net, svc } = await ready();
        net.omitCommit = true;
        const delta = await svc.call("class/ATPost", "publish", P);
        assert.equal(svc.publisher.ledgerEntry(KEY)!.commitRev, undefined);
        assert.deepEqual(inSnap(svc, delta.address), delta.changed[0], "served right after the call");
        await svc.refresh();
        assert.deepEqual(inSnap(svc, delta.address), delta.changed[0], "and from the read");
    });

    it("a publication confirmed by reconciliation is served before any refresh", async () => {
        const { net, svc } = await ready();
        net.writeFaults.push({ kind: "commitThenHang" });
        await assert.rejects(svc.call("class/ATPost", "publish", P), PublishError);
        const delta = await svc.call("class/ATPost", "publish", P);
        assert.deepEqual(inSnap(svc, delta.address), delta.changed[0]);
    });

    it("a short read at the publication's revision neither retires the overlay nor becomes the baseline", async () => {
        const { net, svc } = await ready();
        const delta = await svc.call("class/ATPost", "publish", P);
        const rkey = delta.address.split("/").pop()!;
        net.faults.push({ match: isPostList, status: 200, body: listingWithout(net, rkey), once: true });
        const r1 = await svc.refresh();
        assert.equal(r1.accounts.find((a) => a.did === ALICE)!.ok, false, "the short read is refused");
        assert.deepEqual(inSnap(svc, delta.address), delta.changed[0], "still served");
        const r2 = await svc.refresh();
        assert.equal(r2.accounts.find((a) => a.did === ALICE)!.ok, true, "the correct read at the same commit is accepted");
        assert.deepEqual(inSnap(svc, delta.address), delta.changed[0]);
        assert.equal(svc.publisher.ledgerEntry(KEY)!.readBack, "confirmed");
    });

    it("a post deleted before any read-back is removed once the PDS confirms the deletion", async () => {
        const { net, svc } = await ready();
        const delta = await svc.call("class/ATPost", "publish", P);
        net.del(ALICE, POST, delta.address.split("/").pop()!);
        const r = await svc.refresh();
        assert.ok(net.requestsLog.some((q) => q.url.includes("com.atproto.repo.getRecord")), "the deletion was checked explicitly");
        assert.ok(r.delta.removed.includes(delta.address));
        assert.equal(inSnap(svc, delta.address), undefined);
        assert.equal(svc.publisher.ledgerEntry(KEY)!.readBack, "deleted");
    });

    it("an account deactivated before read-back hides the publication; reactivation shows it", async () => {
        const { net, svc } = await ready();
        const delta = await svc.call("class/ATPost", "publish", P);
        net.repos.get(ALICE)!.active = false;
        net.repos.get(ALICE)!.status = "deactivated";
        await svc.refresh();
        assert.equal(inSnap(svc, delta.address), undefined, "hidden with the account");
        net.repos.get(ALICE)!.active = true;
        delete net.repos.get(ALICE)!.status;
        await svc.refresh();
        assert.deepEqual(inSnap(svc, delta.address), delta.changed[0]);
    });
});

describe("round 2 item 5: rkeys come from a monotonic TID allocator", () => {
    it("10k TIDs in a tight loop at one frozen millisecond are valid, unique and strictly increasing", () => {
        const clock = new TidClock(7);
        const out: string[] = [];
        for (let i = 0; i < 10_000; i++) out.push(clock.next(1_795_000_000_000));
        assert.ok(out.every(isTid), "valid TIDs");
        assert.equal(new Set(out).size, out.length, "unique");
        for (let i = 1; i < out.length; i++) assert.ok(out[i - 1] < out[i], `sorted at ${i}`);
    });

    it("a clock that steps back does not step the TIDs back", () => {
        const clock = new TidClock(1);
        const a = clock.next(1_795_000_000_500);
        const b = clock.next(1_795_000_000_000);
        assert.ok(a < b);
    });

    it("distinct publications in one millisecond, and after a restart, get distinct increasing rkeys", async () => {
        const frozen = new Date(1_795_000_000_000);
        const net = writeNet();
        const h = service(net, { now: () => frozen });
        await h.svc.refresh();
        await authorize(h.svc, net);
        const keys = Array.from({ length: 20 }, (_, i) => `same-ms-key-${String(i).padStart(2, "0")}`);
        const res = await Promise.all(keys.map((k, i) => h.svc.call("class/ATPost", "publish", { text: `post ${i}`, atAuthor: ALICE, publicationKey: k })));
        const rkeys = res.map((r) => r.address.split("/").pop()!);
        assert.equal(new Set(rkeys).size, 20, "unique");
        const { svc: restarted } = service(net, { now: () => frozen, agent: h.agent, storage: h.storage });
        const after = await restarted.call("class/ATPost", "publish", { text: "after restart", atAuthor: ALICE, publicationKey: "same-ms-key-restart" });
        const last = after.address.split("/").pop()!;
        assert.ok(rkeys.every((r) => r < last), "above every rkey already in the ledger");
        for (let i = 0; i < 20; i++) assert.equal(net.postsWithText(ALICE, `post ${i}`).length, 1);
    });
});

describe("round 3 item 1: no server text crosses the publication boundary", () => {
    const P = { text: TEXT, atAuthor: ALICE, publicationKey: KEY };
    const SECRET = "sekr1tvalue" + "x".repeat(20);
    const isStatus = (u: string) => u.includes("com.atproto.sync.getRepoStatus");
    const isList = (u: string) => u.includes("com.atproto.repo.listRecords") && u.includes(encodeURIComponent(POST));

    /** run `body` capturing console output; return every message, stack and log line */
    async function capture(body: (seen: string[]) => Promise<void>): Promise<string[]> {
        const seen: string[] = [];
        const methods = ["log", "info", "warn", "error", "debug"] as const;
        const orig = methods.map((m) => console[m]);
        methods.forEach((m) => (console[m] = (...a: unknown[]) => void seen.push(a.map(String).join(" "))));
        try {
            await body(seen);
        } finally {
            methods.forEach((m, i) => (console[m] = orig[i]));
        }
        return seen;
    }
    const failure = async (seen: string[], p: Promise<unknown>) => {
        await p.then(() => assert.fail("expected a rejection"), (e) => void seen.push(String((e as Error).message), String((e as Error).stack)));
    };
    function assertClean(seen: string[], storage: MemStorage, secrets: string[]) {
        const all = [...seen, storage.dump(), ...[...storage.disk.files].map(([k, v]) => `${k}=${v}`)].join("\n");
        for (const x of secrets) assert.ok(!all.includes(x), `leaked ${x.slice(0, 12)}…`);
    }

    it("a PDS echoing the first create's access token in a 500 body (getRepoStatus) or in a listed URI on the retry", async () => {
        for (const how of ["status500", "listedUri"]) {
            const { net, svc, storage } = await ready();
            net.writeFaults.push({ kind: "commitThenHang" });
            const seen = await capture(async (seen) => {
                await failure(seen, svc.call("class/ATPost", "publish", P));
                const token = net.issued[0];
                if (how === "status500") net.faults.push({ match: isStatus, status: 500, body: JSON.stringify({ error: "InternalServerError", message: `bad token ${token}` }) + token, once: true });
                // a malformed listed URI (the reader rejects it, quoting it)
                else net.faults.push({ match: isList, status: 200, body: JSON.stringify({ records: [{ uri: `at://${token}/${POST}/3kaaaaaaaaa2a`, cid: "bafyx", value: {} }] }), once: true });
                await failure(seen, svc.call("class/ATPost", "publish", P));
            });
            assert.ok(seen.some((m) => /RECONCILE_READ_FAILED/.test(m)), `${how}: a fixed code`);
            assertClean(seen, storage, [net.issued[0], net.issued[1]]);
        }
    });

    it("a transport error quoting a secret, and a PDS URL holding one, stay out of publish errors", async () => {
        const { net, svc, storage } = await ready();
        const orig = net.fetch.bind(net);
        let thrown = false;
        net.fetch = async (url, method, headers, body) => {
            if (!thrown && url.includes("createRecord")) {
                thrown = true;
                throw new Error(`POST ${url} failed: ${SECRET} ${headers.Authorization ?? ""}`);
            }
            return orig(url, method, headers, body);
        };
        const seen = await capture(async (seen) => {
            await failure(seen, svc.call("class/ATPost", "publish", P));
            // the account "moves" to a PDS whose URL holds a secret
            net.didDocs.set(ALICE, net.docFor(ALICE, "alice.test", `https://${SECRET}.test`));
            await failure(seen, svc.call("class/ATPost", "publish", { ...P, publicationKey: "moved-key-001" }));
            // and DID resolution failing on a document that names a secret id
            net.didDocs.set(ALICE, { id: `did:plc:${SECRET}`, service: [] });
            await failure(seen, svc.call("class/ATPost", "publish", { ...P, publicationKey: "moved-key-002" }));
        });
        assert.ok(seen.some((m) => /CREATE_UNCERTAIN/.test(m)));
        assert.ok(seen.some((m) => /ACCOUNT_MOVED/.test(m)));
        assert.ok(seen.some((m) => /ACCOUNT_UNRESOLVED/.test(m)));
        assertClean(seen, storage, [SECRET, ...net.issued]);
    });

    it("discovery values (authorization server URL, issuer, endpoints) are not repeated in authorize errors", async () => {
        const breaks: Array<(n: FakeWriteNet) => void> = [
            (n) => n.prm.set(PDS, { resource: PDS, authorization_servers: [`${PDS}/${SECRET}`] }),
            (n) => (n.asMeta.issuer = `https://${SECRET}.test`),
            (n) => (n.asMeta.token_endpoint = `https://${SECRET}.test/oauth/token`),
            (n) => n.prm.set(PDS, { resource: `https://${SECRET}.test`, authorization_servers: [PDS] }),
            (n) => n.prm.set(PDS, { resource: PDS, authorization_servers: [`http://${SECRET}.test`] }),
        ];
        for (const b of breaks) {
            const net = writeNet();
            b(net);
            const { svc, storage } = service(net);
            const seen = await capture(async (seen) => failure(seen, svc.call("project", "authorize", { account: ALICE })));
            assertClean(seen, storage, [SECRET]);
        }
    });

    it("a refresh whose getRepoStatus answers 500 with a secret in the body reports no body text", async () => {
        const { net, svc, storage } = await ready();
        net.faults.push({ match: isStatus, status: 500, body: JSON.stringify({ error: "InternalServerError", message: SECRET }) + SECRET, once: true });
        const seen = await capture(async (seen) => {
            const r = await svc.refresh();
            seen.push(JSON.stringify(r), JSON.stringify(await svc.call("project", "status")));
        });
        assertClean(seen, storage, [SECRET]);
    });
});

describe("round 3 item 2: one writer at a time per ledger, across processes", () => {
    const P = { text: TEXT, atAuthor: ALICE, publicationKey: KEY };
    const attemptsSince = attempts;

    it("two publishers (separate instances, one storage dir) racing one publicationKey: one wins, the other is refused (LEDGER_BUSY), one post", async () => {
        const { net, svc, agent, storage } = await ready();
        const { svc: other } = service(net, { agent, storage }); // a second process on the same dir
        const mark = net.requestsLog.length;
        const [a, b] = await Promise.allSettled([svc.call("class/ATPost", "publish", P), other.call("class/ATPost", "publish", P)]);
        assert.equal(a.status, "fulfilled", String((a as any).reason));
        assert.equal(b.status, "rejected", "the second writer does not wait for the first");
        assert.match(String((b as any).reason), /LEDGER_BUSY/);
        assert.equal(attemptsSince(net, mark).length, 1, "one createRecord");
        assert.equal(net.postsWithText(ALICE, TEXT).length, 1, "one post");
        // once the first is done, the key answers from the ledger in either process
        assert.deepEqual(await other.call("class/ATPost", "publish", P), (a as any).value);
    });

    it("rkeys stay unique across publishers on one dir, even with the same clock id at a frozen clock", async () => {
        const frozen = new Date(1_795_000_000_000);
        const sameClock = new Proxy(testCrypto, {
            get(t, k) {
                if (k === "getRandomValues") return (a: any) => (a instanceof Uint16Array ? a.fill(0) : t.getRandomValues(a));
                const v = (t as any)[k];
                return typeof v === "function" ? v.bind(t) : v;
            },
        });
        const net = writeNet();
        const h = service(net, { now: () => frozen, crypto: sameClock as any });
        await h.svc.refresh();
        await authorize(h.svc, net);
        const { svc: other } = service(net, { now: () => frozen, crypto: sameClock as any, agent: h.agent, storage: h.storage });
        const b1 = await other.call("class/ATPost", "publish", { text: "b1", atAuthor: ALICE, publicationKey: "proc-b-key-01" });
        const a1 = await h.svc.call("class/ATPost", "publish", { text: "a1", atAuthor: ALICE, publicationKey: "proc-a-key-01" });
        const b2 = await other.call("class/ATPost", "publish", { text: "b2", atAuthor: ALICE, publicationKey: "proc-b-key-02" });
        const rk = [b1, a1, b2].map((r) => r.address.split("/").pop());
        assert.equal(new Set(rk).size, 3, `distinct rkeys: ${rk}`);
        for (const t of ["b1", "a1", "b2"]) assert.equal(net.postsWithText(ALICE, t).length, 1, t);
    });

    it("a lock held by another writer: refused at once, no request", async () => {
        const { net, storage, agent } = await ready();
        const { svc } = service(net, { agent, storage });
        storage.disk.files.set(`publish-ledger.${agent.did}.lock`, JSON.stringify({ owner: "someone-else", at: Date.now() }));
        const mark = net.requestsLog.length;
        await assert.rejects(svc.call("class/ATPost", "publish", P), /LEDGER_BUSY/);
        assert.deepEqual(net.requestsLog.slice(mark).map((r) => r.url), []);
    });

    it("a stale lock (a writer that died an hour ago) blocks: no steal, no request; manual recovery unblocks", async () => {
        const { net, storage, agent } = await ready();
        const { svc } = service(net, { agent, storage });
        const lock = `publish-ledger.${agent.did}.lock`;
        const stale = JSON.stringify({ owner: "dead-writer", at: Date.now() - 3_600_000 });
        storage.disk.files.set(lock, stale);
        const mark = net.requestsLog.length;
        await assert.rejects(svc.call("class/ATPost", "publish", P), /LEDGER_BUSY/);
        assert.deepEqual(net.requestsLog.slice(mark).map((r) => r.url), []);
        assert.equal(storage.disk.files.get(lock), stale, "not stolen");
        // the documented recovery: with every executor on the dir stopped, delete the lock file
        storage.disk.files.delete(lock);
        await svc.call("class/ATPost", "publish", P);
        assert.equal(net.postsWithText(ALICE, TEXT).length, 1);
        assert.equal(storage.disk.files.has(lock), false, "released");
    });

    it("a host without exclusive create cannot publish", async () => {
        const { net, svc, storage } = await ready();
        storage.disk.exclusive = false;
        const mark = net.requestsLog.length;
        await assert.rejects(svc.call("class/ATPost", "publish", P), /NO_ATOMIC_WRITE/);
        assert.deepEqual(net.requestsLog.slice(mark).map((r) => r.url), []);
    });
});

describe("round 3 item 3: publish is described as the interaction it is", () => {
    it("status names the publish interaction, reachable through the constructor or directly, and claims no constructor-only path", async () => {
        const { svc } = service(writeNet());
        const st = await svc.call("project", "status");
        assert.match(st.writes, /publish interaction on <lang>:\/\/class\/ATPost/);
        assert.match(st.writes, /constructor/);
        assert.match(st.writes, /directly/);
        assert.doesNotMatch(st.writes, /only:? the ATPost constructor|constructor-only/i);
    });
});

describe("round 4 item 3: refresh and status reports use fixed codes", () => {
    const urlHas = (frag: string) => (u: string) => u.includes(frag) && u.includes(encodeURIComponent(ALICE));
    const cases: Array<[string, (net: FakeWriteNet, token: string) => void, RegExp]> = [
        ["getLatestCommit rev", (n, t) => n.faults.push({ match: urlHas("getLatestCommit"), status: 200, body: JSON.stringify({ cid: "bafyc", rev: t }), once: true }), /REV_NOT_TID/],
        ["describeRepo did", (n, t) => n.faults.push({ match: urlHas("describeRepo"), status: 200, body: JSON.stringify({ did: `did:plc:${t}` }), once: true }), /REPO_MISMATCH/],
        ["malformed listed URI", (n, t) => n.faults.push({ match: urlHas("listRecords"), status: 200, body: JSON.stringify({ records: [{ uri: `at://${t}/x/y`, cid: "b", value: {} }] }), once: true }), /RECORD_INVALID/],
        ["record in another repo", (n, t) => n.faults.push({ match: urlHas("listRecords"), status: 200, body: JSON.stringify({ records: [{ uri: `at://did:plc:${t}/${POST}/3kaaaaaaaaa2a`, cid: "b", value: {} }] }), once: true }), /RECORD_INVALID/],
        ["invalid JSON body", (n, t) => n.faults.push({ match: urlHas("getRepoStatus"), status: 200, body: `{"did": ${t}`, once: true }), /BAD_JSON/],
        ["DID document id", (n, t) => n.didDocs.set(ALICE, { id: `did:plc:${t}`, service: [] }), /DID_UNRESOLVED/],
        ["PDS endpoint with a query", (n, t) => n.didDocs.set(ALICE, { ...(n.docFor(ALICE, "alice.test", PDS) as any), service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: `${PDS}/?${t}` }] }), /PDS_ENDPOINT_INVALID/],
        ["PDS endpoint with a path (allowed; its 404 is reported by code)", (n, t) => n.didDocs.set(ALICE, { ...(n.docFor(ALICE, "alice.test", PDS) as any), service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: `${PDS}/${t}` }] }), /HTTP_ERROR/],
    ];
    for (const [name, plant, code] of cases) {
        it(`a token the PDS saw, echoed in ${name}, is in neither the refresh report nor status`, async () => {
            const { net, svc } = await ready();
            await svc.call("class/ATPost", "publish", { text: TEXT, atAuthor: ALICE, publicationKey: KEY });
            const token = net.issued[0];
            plant(net, token);
            const report = await svc.refresh();
            const status = await svc.call("project", "status");
            const alice = report.accounts.find((a) => a.did === ALICE)!;
            assert.equal(alice.ok, false);
            assert.match(alice.error!, code);
            for (const text of [JSON.stringify(report), JSON.stringify(status)]) assert.ok(!text.includes(token), `${name}: token in a report`);
        });
    }
});

describe("rule 4: read-back by a distinct account's reader", () => {
    it("bob's reader (another agent, no session) shows alice's new post with atAuthor = alice, and bob's follow of alice", async () => {
        const { net, svc } = await ready();
        net.put(BOB, FOLLOW, "3kbobfollow1a", followOf(ALICE));
        const delta = await svc.call("class/ATPost", "publish", { text: TEXT, atAuthor: ALICE, publicationKey: KEY });
        const { svc: bobView } = service(net, { accounts: [BOB, ALICE] });
        const mark = net.requestsLog.length;
        await bobView.refresh();
        assert.deepEqual(net.requestsLog.slice(mark).filter((r) => r.method !== "GET").map((r) => r.url), [], "the reader only reads");
        const entries = bobView.snapshot().entries;
        const post = entries.find((e) => e.address === delta.address)!;
        assert.ok(post, "alice's post is mounted in bob's view");
        assert.equal(post.class, "ATPost");
        assert.equal(post.data.atAuthor, ALICE);
        assert.equal(post.data.text, TEXT);
        assert.equal(post.data.cid, delta.changed[0].data.cid);
        assert.equal("author" in post.data, false);
        assert.equal("publicationKey" in post.data, false, "another user's view has no ledger");
        const follow = entries.find((e) => e.class === "ATFollow" && e.data.atAuthor === BOB && e.data.subject === ALICE);
        assert.ok(follow, "bob follows alice");
        assert.equal(svc.publisher.ledgerEntry(KEY)?.state, "published");
        assert.equal(SCOPE.includes("repo:app.bsky.feed.post?action=create"), true);
        assert.equal(plainPost("x").includes(POST), true);
    });
});
