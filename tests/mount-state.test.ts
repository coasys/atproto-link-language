/**
 * Mounted reader — snapshot state across refreshes (acceptance rules 4, 5
 * and 6 at the language boundary) and the read-only shapes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { MountedReader } from "../src/mount/state.js";
import { mountShapes, CLASS_NAMES } from "../src/mount/shapes.js";
import {
    standardNet, baseConfig, ALICE, BOB, CAROL, POST, FOLLOW, plainPost,
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
