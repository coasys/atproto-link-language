/**
 * Mounted reader — snapshot state across refreshes (acceptance rules 4, 5
 * and 6 at the language boundary) and the read-only shapes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { MountedReader } from "../src/mount/state.js";
import { mountShapes, CLASS_NAMES } from "../src/mount/shapes.js";
import {
    standardNet, baseConfig, OLDEST_TID, ALICE, BOB, CAROL, POST, FOLLOW, plainPost,
} from "./mount-fixtures.js";

const NOW = () => new Date("2026-11-19T12:00:00.000Z");

function reader(net = standardNet(), accounts = [ALICE, BOB, CAROL]) {
    return new MountedReader({ ...baseConfig, accounts, transport: net, now: NOW });
}

function memStorage() {
    const m = new Map<string, string>();
    return {
        get: (k: string) => m.get(k) ?? null,
        put: (k: string, v: string) => void m.set(k, v),
        delete: (k: string) => void m.delete(k),
        listKeys: (p = "") => [...m.keys()].filter((k) => k.startsWith(p)),
        keys: () => [...m.keys()],
    };
}

const addresses = (r: MountedReader) => r.snapshot().entries.map((e) => e.address);
const recordAddrs = (r: MountedReader) =>
    r.snapshot().entries.filter((e) => e.class !== "ATAccount").map((e) => e.address);

describe("rule 4: repeated refreshes are idempotent; updates replace only their record", () => {
    it("two refreshes over unchanged repos give identical snapshots and an empty delta", async () => {
        const r = reader();
        await r.refresh();
        const first = JSON.stringify(r.snapshot());
        const report = await r.refresh();
        assert.equal(JSON.stringify(r.snapshot()), first);
        assert.deepEqual(report.delta, { changed: [], removed: [] });
        const addrs = addresses(r);
        assert.equal(new Set(addrs).size, addrs.length, "no duplicate addresses");
    });

    it("an outside update changes exactly that record in the delta", async () => {
        const net = standardNet();
        const r = reader(net);
        await r.refresh();
        const before = r.snapshot().entries;
        net.put(ALICE, POST, "3kalice00001a", plainPost("alice one, edited"));
        const report = await r.refresh();
        const target = `${ALICE}/${POST}/3kalice00001a`;
        const changedRecords = report.delta.changed.filter((e) => e.class !== "ATAccount");
        assert.deepEqual(changedRecords.map((e) => e.address), [target]);
        assert.equal(changedRecords[0].data.text, "alice one, edited");
        assert.deepEqual(report.delta.removed, []);
        const after = r.snapshot().entries;
        for (const e of after) {
            if (e.address === target || e.class === "ATAccount") continue;
            assert.deepEqual(e, before.find((b) => b.address === e.address));
        }
    });

    it("snapshot order is stable (sorted by address)", async () => {
        const r = reader();
        await r.refresh();
        const a = addresses(r);
        assert.deepEqual(a, [...a].sort());
    });
});

describe("rule 5: only a revision-stable complete inventory removes records", () => {
    const gone = `${ALICE}/${POST}/3kalice00002a`;

    it("a complete inventory removes a deleted record", async () => {
        const net = standardNet();
        const r = reader(net);
        await r.refresh();
        net.del(ALICE, POST, "3kalice00002a");
        const report = await r.refresh();
        assert.ok(!recordAddrs(r).includes(gone));
        assert.deepEqual(report.delta.removed, [gone]);
    });

    const faults: Array<[string, (net: ReturnType<typeof standardNet>) => void]> = [
        ["a changed head", (net) => net.faults.push({ match: (u) => u.includes("listRecords") && u.includes(encodeURIComponent(ALICE)), bumpRevOf: ALICE, once: true })],
        ["a failed page", (net) => net.faults.push({ match: (u) => u.includes("listRecords") && u.includes(encodeURIComponent(ALICE)) && u.includes(FOLLOW), status: 500 })],
        ["a 429", (net) => net.faults.push({ match: (u) => u.includes(encodeURIComponent(ALICE)) && u.includes("getLatestCommit"), status: 429 })],
        ["a timeout", (net) => net.faults.push({ match: (u) => u.includes("listRecords") && u.includes(encodeURIComponent(ALICE)), hang: true })],
        ["a failed DID lookup", (net) => net.didDocs.delete(ALICE)],
    ];
    for (const [what, inject] of faults) {
        it(`${what} removes nothing and keeps the last complete snapshot`, async () => {
            const net = standardNet();
            const r = reader(net);
            await r.refresh();
            const before = JSON.stringify(r.snapshot());
            net.del(ALICE, POST, "3kalice00002a");
            net.put(ALICE, POST, "3kalice00009a", plainPost("new while failing"));
            inject(net);
            const report = await r.refresh();
            assert.equal(JSON.stringify(r.snapshot()), before, "snapshot untouched");
            assert.deepEqual(report.delta, { changed: [], removed: [] });
            const acct = report.accounts.find((a) => a.did === ALICE)!;
            assert.equal(acct.ok, false);
            assert.ok(acct.error, "the failure is reported");
            // the other accounts still refreshed
            assert.ok(report.accounts.filter((a) => a.did !== ALICE).every((a) => a.ok));
        });
    }

    it("a restarted reader keeps the persisted complete snapshot while its PDS is down", async () => {
        const net = standardNet();
        const storage = memStorage();
        const r1 = new MountedReader({ ...baseConfig, accounts: [ALICE, BOB], transport: net, now: NOW, storage });
        await r1.refresh();
        const before = JSON.stringify(r1.snapshot());
        // executor restart: a new reader over the same storage, PDS unreachable
        net.faults.push({ match: () => true, status: 503 });
        const r2 = new MountedReader({ ...baseConfig, accounts: [ALICE, BOB], transport: net, now: NOW, storage });
        const report = await r2.refresh();
        assert.ok(report.accounts.every((a) => !a.ok));
        assert.equal(JSON.stringify(r2.snapshot()), before);
        // persisted state is public record data only
        assert.ok(storage.keys().every((k) => k.startsWith("mount/")));
    });

    it("an account dropped from the allowlist is not served from persisted state", async () => {
        const net = standardNet();
        const storage = memStorage();
        await new MountedReader({ ...baseConfig, accounts: [ALICE, BOB], transport: net, now: NOW, storage }).refresh();
        const r = new MountedReader({ ...baseConfig, accounts: [BOB], transport: net, now: NOW, storage });
        await r.refresh();
        assert.ok(recordAddrs(r).every((a) => a.startsWith(BOB)));
    });

    it("a first read that fails mounts nothing for that account but the others", async () => {
        const net = standardNet();
        net.didDocs.delete(ALICE);
        const r = reader(net);
        await r.refresh();
        assert.ok(!recordAddrs(r).some((a) => a.startsWith(ALICE)));
        assert.ok(recordAddrs(r).some((a) => a.startsWith(BOB)));
    });
});

describe("P1: a stable read is checked against the last accepted rev, commit and inventory", () => {
    const posts = [`${ALICE}/${POST}/3kalice00001a`, `${ALICE}/${POST}/3kalice00002a`];

    /** Truncate Alice's post listing to a 200 with no records and no cursor. */
    function truncatePosts(net: ReturnType<typeof standardNet>) {
        const orig = net.fetch.bind(net);
        net.fetch = async (url, m, h, b) => {
            if (url.includes("listRecords") && url.includes(encodeURIComponent(ALICE)) && url.includes(POST)) {
                net.log.push(url);
                return { status: 200, headers: {}, body: '{"records":[]}' };
            }
            return orig(url, m, h, b);
        };
    }

    /** Serve an older revision of Alice's repo (a stale or rolled-back PDS). */
    function rollBack(net: ReturnType<typeof standardNet>, rev: string, cid: string) {
        const repo = net.repos.get(ALICE)!;
        repo.collections.set(POST, []);
        repo.rev = rev;
        repo.commitCid = cid;
    }

    async function setup(storage = memStorage()) {
        const net = standardNet();
        const r = new MountedReader({ ...baseConfig, accounts: [ALICE, BOB], transport: net, now: NOW, storage });
        await r.refresh();
        return { net, r, storage, before: JSON.stringify(r.snapshot()) };
    }

    it("a same-rev empty listing is rejected and removes nothing", async () => {
        const { net, r, before } = await setup();
        truncatePosts(net);
        const report = await r.refresh();
        const alice = report.accounts.find((a) => a.did === ALICE)!;
        assert.equal(alice.ok, false);
        assert.match(alice.error!, /inventory/);
        assert.deepEqual(report.delta, { changed: [], removed: [] });
        assert.equal(JSON.stringify(r.snapshot()), before);
        for (const a of posts) assert.ok(recordAddrs(r).includes(a));
    });

    it("a revision regression is rejected and removes nothing", async () => {
        const { net, r, before } = await setup();
        rollBack(net, OLDEST_TID, "bafycommitOLD");
        const report = await r.refresh();
        const alice = report.accounts.find((a) => a.did === ALICE)!;
        assert.equal(alice.ok, false);
        assert.match(alice.error!, /regress/);
        assert.deepEqual(report.delta, { changed: [], removed: [] });
        assert.equal(JSON.stringify(r.snapshot()), before);
    });

    it("the same rev with a different commit CID is rejected", async () => {
        const { net, r, before } = await setup();
        net.repos.get(ALICE)!.commitCid = "bafyFORKED";
        const report = await r.refresh();
        assert.equal(report.accounts.find((a) => a.did === ALICE)!.ok, false);
        assert.equal(JSON.stringify(r.snapshot()), before);
    });

    it("both guards hold after a restart (accepted state reloaded from storage)", async () => {
        const { net, storage, before } = await setup();
        truncatePosts(net);
        const r2 = new MountedReader({ ...baseConfig, accounts: [ALICE, BOB], transport: net, now: NOW, storage });
        const rep2 = await r2.refresh();
        assert.equal(rep2.accounts.find((a) => a.did === ALICE)!.ok, false);
        assert.equal(JSON.stringify(r2.snapshot()), before);

        const s2 = await setup();
        rollBack(s2.net, OLDEST_TID, "bafycommitOLD");
        const r3 = new MountedReader({ ...baseConfig, accounts: [ALICE, BOB], transport: s2.net, now: NOW, storage: s2.storage });
        const rep3 = await r3.refresh();
        assert.equal(rep3.accounts.find((a) => a.did === ALICE)!.ok, false);
        assert.match(rep3.accounts.find((a) => a.did === ALICE)!.error!, /regress/);
        assert.equal(JSON.stringify(r3.snapshot()), s2.before);
    });

    it("a regression is still caught after a deactivate / reactivate cycle", async () => {
        const { net, r } = await setup();
        const repo = net.repos.get(ALICE)!;
        repo.active = false;
        repo.status = "deactivated";
        await r.refresh();
        rollBack(net, OLDEST_TID, "bafycommitOLD");
        repo.active = true;
        repo.status = undefined;
        const report = await r.refresh();
        const alice = report.accounts.find((a) => a.did === ALICE)!;
        assert.equal(alice.ok, false);
        assert.match(alice.error!, /regress/);
        assert.deepEqual(report.delta, { changed: [], removed: [] });
        assert.deepEqual(recordAddrs(r).filter((a) => a.startsWith(ALICE)), [], "the deactivated state stays");
    });

    it("a newer revision that is genuinely empty is accepted", async () => {
        const { net, r } = await setup();
        net.del(ALICE, POST, "3kalice00001a");
        net.del(ALICE, POST, "3kalice00002a");
        net.del(ALICE, FOLLOW, "3kfollow0001a");
        const report = await r.refresh();
        assert.equal(report.accounts.find((a) => a.did === ALICE)!.ok, true);
        assert.deepEqual(recordAddrs(r).filter((a) => a.startsWith(ALICE)), []);
    });

    it("an unchanged commit with the same inventory is still accepted (idempotent)", async () => {
        const { r, before } = await setup();
        const report = await r.refresh();
        assert.ok(report.accounts.every((a) => a.ok));
        assert.equal(JSON.stringify(r.snapshot()), before);
    });
});

describe("round 3: a repo revision must be a valid TID (live and restored)", () => {
    const BAD = ["z", "", "3lrev00000000", "3l222222222222", "kl22222222222", "3L22222222222"];

    function setRev(net: ReturnType<typeof standardNet>, rev: string) {
        net.repos.get(ALICE)!.rev = rev;
    }

    for (const bad of BAD) {
        it(`a stable malformed rev ${JSON.stringify(bad)} with an empty listing removes and persists nothing`, async () => {
            const net = standardNet();
            const storage = memStorage();
            const r = new MountedReader({ ...baseConfig, accounts: [ALICE, BOB], transport: net, now: NOW, storage });
            await r.refresh();
            const before = JSON.stringify(r.snapshot());
            const stored = JSON.stringify(storage.keys().sort().map((k) => [k, storage.get(k)]));
            const repo = net.repos.get(ALICE)!;
            repo.collections.set(POST, []);
            repo.collections.set(FOLLOW, []);
            setRev(net, bad);
            const report = await r.refresh();
            const alice = report.accounts.find((a) => a.did === ALICE)!;
            assert.equal(alice.ok, false);
            assert.match(alice.error!, /TID/);
            assert.deepEqual(report.delta, { changed: [], removed: [] });
            assert.equal(JSON.stringify(r.snapshot()), before);
            assert.equal(JSON.stringify(storage.keys().sort().map((k) => [k, storage.get(k)])), stored, "storage untouched");
            // the baseline is not poisoned: the next valid rev is accepted
            net.bump(ALICE);
            const next = await r.refresh();
            assert.equal(next.accounts.find((a) => a.did === ALICE)!.ok, true);
        });
    }

    it("a malformed FIRST read mounts and persists nothing, and does not poison the baseline", async () => {
        const net = standardNet();
        const storage = memStorage();
        setRev(net, "z");
        const r = new MountedReader({ ...baseConfig, accounts: [ALICE, BOB], transport: net, now: NOW, storage });
        const report = await r.refresh();
        assert.equal(report.accounts.find((a) => a.did === ALICE)!.ok, false);
        assert.ok(!recordAddrs(r).some((a) => a.startsWith(ALICE)));
        assert.ok(storage.keys().every((k) => !k.endsWith(ALICE)), `persisted: ${storage.keys()}`);
        net.bump(ALICE);
        const next = await r.refresh();
        assert.equal(next.accounts.find((a) => a.did === ALICE)!.ok, true);
        assert.ok(recordAddrs(r).some((a) => a.startsWith(ALICE)));
    });

    it("a malformed restored rev discards the baseline and reports it", async () => {
        const net = standardNet();
        const storage = memStorage();
        await new MountedReader({ ...baseConfig, accounts: [ALICE, BOB], transport: net, now: NOW, storage }).refresh();
        const key = `mount/accepted/${ALICE}`;
        const acc = JSON.parse(storage.get(key)!);
        storage.put(key, JSON.stringify({ ...acc, rev: "z" }));
        const r = new MountedReader({ ...baseConfig, accounts: [ALICE, BOB], transport: net, now: NOW, storage });
        assert.match(r.restoreIssues.get(ALICE) ?? "", /TID/);
        // a valid newer head is accepted (not refused as a regression from "z")
        net.bump(ALICE);
        const report = await r.refresh();
        const alice = report.accounts.find((a) => a.did === ALICE)!;
        assert.equal(alice.ok, true);
        assert.match(alice.warning ?? "", /discarded/);
        assert.notEqual(JSON.parse(storage.get(key)!).rev, "z", "a fresh baseline replaced it");
    });
});

describe("decision: RepoNotFound is a failed read, not a deletion (spike policy)", () => {
    it("a repo the PDS no longer knows keeps its records and reports the failure", async () => {
        const net = standardNet();
        const r = reader(net);
        await r.refresh();
        const before = JSON.stringify(r.snapshot());
        net.repos.delete(ALICE); // DID document still points at the PDS
        const report = await r.refresh();
        const alice = report.accounts.find((a) => a.did === ALICE)!;
        assert.equal(alice.ok, false);
        assert.match(alice.error!, /RepoNotFound/);
        assert.deepEqual(report.delta, { changed: [], removed: [] });
        assert.equal(JSON.stringify(r.snapshot()), before);
    });
});

describe("rule 6: account deactivation hides its records", () => {
    it("hides an inactive account's records and shows them again on reactivation", async () => {
        const net = standardNet();
        const r = reader(net);
        await r.refresh();
        const aliceRecords = recordAddrs(r).filter((a) => a.startsWith(ALICE));
        assert.ok(aliceRecords.length >= 3);
        net.repos.get(ALICE)!.active = false;
        net.repos.get(ALICE)!.status = "deactivated";
        const report = await r.refresh();
        assert.deepEqual(recordAddrs(r).filter((a) => a.startsWith(ALICE)), []);
        assert.deepEqual([...report.delta.removed].sort(), [...aliceRecords].sort());
        const acct = r.snapshot().entries.find((e) => e.class === "ATAccount" && e.data.did === ALICE)!;
        assert.equal(acct.data.active, false);
        assert.equal(acct.data.status, "deactivated");
        net.repos.get(ALICE)!.active = true;
        net.repos.get(ALICE)!.status = undefined;
        await r.refresh();
        assert.deepEqual(recordAddrs(r).filter((a) => a.startsWith(ALICE)).sort(), [...aliceRecords].sort());
    });

    it("never mounts an account outside the allowlist, even when followed", async () => {
        const net = standardNet();
        const r = reader(net, [ALICE]);
        await r.refresh();
        assert.ok(recordAddrs(r).every((a) => a.startsWith(ALICE)));
        assert.ok(net.requests(new RegExp(encodeURIComponent(BOB) + "|" + BOB)).every((u) => !u.includes("listRecords")));
    });
});

describe("shapes: read-only ATPost / ATFollow / ATAccount", () => {
    it("declare no constructor, destructor, setter or writable property", () => {
        const s = mountShapes();
        assert.deepEqual(s.shapes.map((x: any) => x.name), [...CLASS_NAMES]);
        assert.ok(typeof s.version === "string" && s.version.length > 0);
        for (const { shape } of s.shapes as any[]) {
            assert.deepEqual(shape.constructor_actions, []);
            assert.deepEqual(shape.destructor_actions, []);
            for (const p of shape.properties) {
                assert.ok(!p.writable && !p.setter, `${p.name} is writable`);
            }
        }
    });

    it("every mapped data key is a declared property", async () => {
        const net = standardNet();
        const r = reader(net);
        await r.refresh();
        const s = mountShapes();
        for (const e of r.snapshot().entries) {
            const shape: any = (s.shapes as any[]).find((x) => x.name === e.class)!.shape;
            const names = new Set(shape.properties.map((p: any) => p.name));
            for (const k of Object.keys(e.data)) assert.ok(names.has(k), `${e.class}.${k} not in the shape`);
        }
    });

    it("TextContent alias only on ATPost.text", () => {
        const s = mountShapes();
        const aliased = (s.shapes as any[]).flatMap((x) =>
            x.shape.properties.filter((p: any) => p.alias).map((p: any) => `${x.name}.${p.name}`));
        assert.deepEqual(aliased, ["ATPost.text"]);
    });
});
