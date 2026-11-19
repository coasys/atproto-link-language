/**
 * Live acceptance for the mounted reader: a local PDS + PLC
 * (live/pds.mjs, @atproto/dev-env), the pinned Acorn-stack executor, and
 * the built mount bundle (build/mount/bundle.js). Covers the executor-side
 * halves of rules 4, 6 and 7 plus the brief's live acceptance list.
 *
 * Skipped unless MOUNT_LIVE=1. Needs Node >= 22 (dev-env, global
 * WebSocket) and AD4M_EXECUTOR. It starts and stops every process itself.
 *
 *   MOUNT_LIVE=1 AD4M_EXECUTOR=~/code/ad4m-acorn-target/release/ad4m-executor \
 *     node --import tsx --test tests/mount-live.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { parseLossless, stringifyLossless } from "../src/mount/lossless-json.js";
import { secretHits } from "./mount-secret-scan.js";

const LIVE = process.env.MOUNT_LIVE === "1";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXECUTOR = process.env.AD4M_EXECUTOR ?? "";
const PLC_PORT = Number(process.env.PLC_PORT ?? 47101);
const PDS_PORT = Number(process.env.PDS_PORT ?? 47102);
const AD4M_PORT = Number(process.env.AD4M_PORT ?? 47110);
const RUN = process.env.LIVE_RUN_DIR ?? (LIVE ? mkdtempSync(join(tmpdir(), "atproto-s1-live-")) : "");
if (LIVE && RUN) mkdirSync(RUN, { recursive: true });
const EVIDENCE = process.env.LIVE_EVIDENCE ?? join(RUN, "evidence.json");
const PASS = "live-test-passphrase";
const POST = "app.bsky.feed.post";
const FOLLOW = "app.bsky.graph.follow";
const NOTE = "ad4m://user_annotation";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const evidence: Record<string, unknown> = { run: RUN };
function record(key: string, value: unknown) {
    evidence[key] = value;
    if (!RUN) return;
    writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2));
}

// ---- processes ------------------------------------------------------------

let pdsProc: ChildProcess | null = null;
let exeProc: ChildProcess | null = null;
let env: { plcUrl: string; pdsUrl: string; accounts: Array<{ name: string; did: string; handle: string; password: string }> };

async function waitFor(what: string, fn: () => Promise<boolean> | boolean, timeoutMs = 120000, stepMs = 1000) {
    const t0 = Date.now();
    let last: unknown = null;
    while (Date.now() - t0 < timeoutMs) {
        try {
            if (await fn()) return;
        } catch (e) {
            last = e;
        }
        await sleep(stepMs);
    }
    throw new Error(`${what}: not ready after ${timeoutMs}ms ${last ? `(last: ${(last as Error).message})` : ""}`);
}

async function startPds() {
    const out = join(RUN, "pds.json");
    const log = openSync(join(RUN, "pds.log"), "a");
    pdsProc = spawn(process.execPath, [join(ROOT, "live", "pds.mjs")], {
        cwd: join(ROOT, "live"),
        env: { ...process.env, PLC_PORT: String(PLC_PORT), PDS_PORT: String(PDS_PORT), ENV_OUT: out },
        stdio: ["ignore", log, log],
    });
    await waitFor("pds", () => existsSync(out), 120000);
    env = JSON.parse(readFileSync(out, "utf8"));
}

async function startExecutor(first: boolean) {
    const data = join(RUN, "executor");
    if (first) {
        mkdirSync(data, { recursive: true });
        execFileSync(EXECUTOR, ["init", "-d", data], { stdio: "ignore" });
    }
    const log = openSync(join(RUN, "executor.log"), "a");
    exeProc = spawn(EXECUTOR, [
        "run", "-a", data, "--port", String(AD4M_PORT), "--localhost", "true",
        "--insecure-no-admin-credential", "--hc-use-proxy", "false",
        "--hc-use-bootstrap", "false", "--hc-use-mdns", "false",
        "--hc-admin-port", String(AD4M_PORT + 1), "--hc-app-port", String(AD4M_PORT + 2),
        "--run-dapp-server", "false", "--enable-mcp", "false", "--exit-with-parent", "true",
    ], { stdio: ["ignore", log, log], env: { ...process.env, RUST_LOG: process.env.RUST_LOG ?? "info" } });
    await waitFor("executor health", async () => (await fetch(`http://127.0.0.1:${AD4M_PORT}/health`)).ok, 120000);
    rpcClose();
    const st = await rpc("agent.status");
    if (!st.isInitialized) await rpc("agent.generate", { passphrase: PASS }, 300000);
    else if (!st.isUnlocked) await rpc("agent.unlock", { passphrase: PASS }, 300000);
    const me = await rpc("agent.status");
    assert.ok(me.isUnlocked, "agent unlocked");
    return me.did as string;
}

async function stop(p: ChildProcess | null, name: string) {
    if (!p || p.exitCode !== null) return;
    p.kill("SIGTERM");
    for (let i = 0; i < 30 && p.exitCode === null; i++) await sleep(500);
    if (p.exitCode === null) {
        p.kill("SIGKILL");
        await sleep(500);
    }
    record(`stopped_${name}`, p.exitCode ?? p.signalCode);
}

// ---- executor rpc (ws://…/api/v1/ws, {id,type,params}) ----------------------

let ws: WebSocket | null = null;
let wsOpen: Promise<void> | null = null;
let nextId = 1;
const pending = new Map<string, (m: any) => void>();

function rpcClose() {
    ws?.close();
    ws = null;
    wsOpen = null;
}

function rpc(method: string, params: Record<string, unknown> = {}, timeoutMs = 120000): Promise<any> {
    if (!wsOpen) {
        ws = new WebSocket(`ws://127.0.0.1:${AD4M_PORT}/api/v1/ws`);
        ws.onmessage = (ev) => {
            const msg = JSON.parse(String(ev.data));
            if (msg.id != null && pending.has(msg.id)) {
                pending.get(msg.id)!(msg);
                pending.delete(msg.id);
            }
        };
        wsOpen = new Promise((res, rej) => {
            ws!.onopen = () => res();
            ws!.onerror = (e) => rej(new Error("ws error " + String((e as any).message ?? "")));
        });
    }
    return wsOpen.then(() => new Promise((res, rej) => {
        const id = String(nextId++);
        const timer = setTimeout(() => {
            pending.delete(id);
            rej(new Error(`${method}: timed out`));
        }, timeoutMs);
        pending.set(id, (m) => {
            clearTimeout(timer);
            if (m.error) rej(new Error(`${method}: ${JSON.stringify(m.error)}`));
            else res(m.result);
        });
        ws!.send(JSON.stringify({ id, type: method, params }));
    }));
}

async function interact(url: string, name: string, params: unknown = {}) {
    const r = await rpc("expression.interact", { url, interactionCall: { name, parametersStringified: JSON.stringify(params) } }, 180000);
    if (typeof r !== "string") return r;
    try { return JSON.parse(r); } catch { return r; }
}

// ---- language bundle ------------------------------------------------------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Buffer) {
    const digits = [0];
    for (const byte of bytes) {
        let carry = byte;
        for (let i = 0; i < digits.length; i++) {
            const n = (digits[i] << 8) + carry;
            digits[i] = n % 58;
            carry = (n / 58) | 0;
        }
        while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
    }
    let out = "";
    for (const b of bytes) { if (b === 0) out += "1"; else break; }
    return out + digits.reverse().map((d) => B58[d]).join("");
}
/** rust-executor/src/languages/mod.rs calculate_language_hash */
function languageHash(src: string) {
    const digest = createHash("sha256").update(src, "utf8").digest();
    return "Qmz" + base58(Buffer.concat([Buffer.from([0x01, 0x00, 0x12, 0x20]), digest]));
}

function publishLocal(bundlePath: string): string {
    const src = readFileSync(bundlePath, "utf8");
    const address = languageHash(src);
    const dir = join(RUN, "executor", "ad4m", "languages", address);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bundle.js"), src);
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ name: "atproto-mounted-reader" }));
    return address;
}

// ---- PDS (outside the connector) -------------------------------------------

const tokens = new Map<string, string>();
async function pdsCall(method: string, opts: { did?: string; body?: unknown; post?: boolean; query?: Record<string, string> } = {}) {
    const q = opts.query ? "?" + new URLSearchParams(opts.query).toString() : "";
    const headers: Record<string, string> = {};
    if (opts.did) headers.authorization = `Bearer ${tokens.get(opts.did)}`;
    if (opts.body) headers["content-type"] = "application/json";
    const res = await fetch(`${env.pdsUrl}/xrpc/${method}${q}`, {
        method: opts.body || opts.post ? "POST" : "GET", headers, body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} -> ${res.status} ${text}`);
    return text;
}
async function login(acct: { did: string; handle: string; password: string }) {
    const r = JSON.parse(await pdsCall("com.atproto.server.createSession", { body: { identifier: acct.did, password: acct.password } }));
    tokens.set(acct.did, r.accessJwt);
}
async function createRecord(did: string, collection: string, rec: unknown) {
    return JSON.parse(await pdsCall("com.atproto.repo.createRecord", { did, body: { repo: did, collection, record: rec } }));
}
async function putRecord(did: string, collection: string, rkey: string, rec: unknown) {
    return JSON.parse(await pdsCall("com.atproto.repo.putRecord", { did, body: { repo: did, collection, rkey, record: rec } }));
}
async function deleteRecord(did: string, collection: string, rkey: string) {
    await pdsCall("com.atproto.repo.deleteRecord", { did, body: { repo: did, collection, rkey } });
}
async function listPds(did: string, collection: string) {
    const j = parseLossless(await pdsCall("com.atproto.repo.listRecords", { query: { repo: did, collection, limit: "100" } })) as any;
    return j.records as Array<{ uri: string; cid: string; value: any }>;
}
const rkeyOf = (uri: string) => uri.split("/").pop()!;

// ---- perspective helpers ---------------------------------------------------

let L = "";
let uuid = "";
let me = "";
const idOf = (uri: string) => `${L}://${uri.slice("at://".length)}`;

async function modelQuery(cls: string): Promise<any[]> {
    const res = await rpc("perspective.modelQuery", { uuid, class_name: cls, query_json: "{}" }, 180000);
    const parsed = typeof res === "string" ? JSON.parse(res) : res;
    return parsed?.instances ?? [];
}
async function allLinks(): Promise<any[]> {
    const r = await rpc("perspective.queryLinks", { uuid }, 180000);
    return typeof r === "string" ? JSON.parse(r) : r;
}
const key = (l: any) => `${l.data.source} ${l.data.predicate} ${l.data.target}`;
async function connectorLinks() {
    return (await allLinks()).filter((l) => l.data.source.startsWith(`${L}://`) && l.data.predicate !== NOTE);
}
async function refreshAndSync() {
    const report = await interact(`${L}://project`, "refresh");
    const sync = await rpc("perspective.syncMount", { uuid, languageAddress: L }, 300000);
    return { report, sync };
}

// ---------------------------------------------------------------------------

describe("mounted reader — live acceptance", { skip: !LIVE && "set MOUNT_LIVE=1 (needs Node >= 22, AD4M_EXECUTOR)" }, () => {
    let alice: any, bob: any;
    const created: Record<string, { uri: string; cid: string }> = {};

    before(async () => {
        assert.ok(EXECUTOR && existsSync(EXECUTOR), "AD4M_EXECUTOR must point at the built executor");
        record("executor", EXECUTOR);
        await startPds();
        [alice, bob] = env.accounts;
        record("accounts", env.accounts.map(({ name, did, handle }) => ({ name, did, handle })));
        record("pds", { plcUrl: env.plcUrl, pdsUrl: env.pdsUrl });
        await login(alice);
        await login(bob);
        me = await startExecutor(true);
        record("executorDid", me);
    });

    after(async () => {
        rpcClose();
        await stop(exeProc, "executor");
        await stop(pdsProc, "pds");
    });

    it("seeds both accounts outside the connector", async () => {
        created.a1 = await createRecord(alice.did, POST, { $type: POST, text: "alice: first live post", createdAt: new Date().toISOString(), langs: ["en", "de", "en"] });
        created.a2 = await createRecord(alice.did, POST, {
            $type: POST, text: "alice: nested", createdAt: new Date().toISOString(),
            "x.ad4m.unknown": { arr: [3, 1, 3], empty: [], nil: null, bytes: { $bytes: "AAEC/w" }, deep: { $type: "com.example.future#v", z: 1 } },
        });
        created.b1 = await createRecord(bob.did, POST, { $type: POST, text: "bob: hello", createdAt: new Date().toISOString() });
        // equal body at a different AT URI (rule 2)
        created.same = await createRecord(bob.did, POST, { $type: POST, text: "same body", createdAt: "2026-11-19T00:00:00.000Z" });
        created.same2 = await createRecord(alice.did, POST, { $type: POST, text: "same body", createdAt: "2026-11-19T00:00:00.000Z" });
        created.f1 = await createRecord(alice.did, FOLLOW, { $type: FOLLOW, subject: bob.did, createdAt: new Date().toISOString() });
        record("seeded", created);
    });

    it("installs the templated bundle and mounts it (no credentials in the template)", async () => {
        const bundle = join(ROOT, "build", "mount", "bundle.js");
        assert.ok(existsSync(bundle), "build the bundle first: node mount-build.mjs");
        const base = publishLocal(bundle);
        const templ = { ACCOUNTS: `${alice.did},${bob.did}`, PLC_URL: env.plcUrl, APPVIEW_URL: "", POLL_MS: "3600000" };
        const ref = await rpc("language.applyTemplateLocal", { sourceLanguageHash: base, templateData: JSON.stringify(templ) }, 300000);
        L = ref.address;
        record("language", { base, templated: L, template: templ });
        await waitFor("language status", async () => !!(await interact(`${L}://project`, "status")), 120000, 2000);
        const handle = await rpc("perspective.create", { name: "atproto mounted reader" });
        uuid = handle.uuid;
        await rpc("perspective.mount", { uuid, languageAddress: L }, 300000);
        assert.deepEqual(await rpc("perspective.mounts", { uuid }), [L]);
    });

    it("rule 7: model queries match the PDS and separate AT author from link signer", async () => {
        const posts = await modelQuery("ATPost");
        const pdsPosts = [...await listPds(alice.did, POST), ...await listPds(bob.did, POST)];
        assert.deepEqual(posts.map((p) => p.sourceUri).sort(), pdsPosts.map((p) => p.uri).sort());
        for (const p of pdsPosts) {
            const row = posts.find((r) => r.sourceUri === p.uri);
            assert.equal(row.id, idOf(p.uri));
            assert.equal(row.cid, p.cid);
            assert.equal(row.text, p.value.text);
            assert.equal(row.atAuthor, p.uri.split("/")[2]);
            // rule 1 live: the mounted source equals the PDS's own record JSON
            assert.equal(row.sourceRecord, stringifyLossless(p.value));
            assert.equal(row.verification, "transportTrusted");
            assert.equal(row.moderation, "unavailable", "no AppView configured on the controlled network");
        }
        const follows = await modelQuery("ATFollow");
        assert.equal(follows.length, 1);
        assert.equal(follows[0].subject, bob.did);
        assert.equal(follows[0].atAuthor, alice.did);
        // rule 2 live: same body at two URIs → two instances
        assert.equal(posts.filter((p) => p.text === "same body").length, 2);
        // the links are signed by the executor's agent, not the AT author
        const links = await rpc("perspective.queryLinks", { uuid, source: idOf(created.a1.uri) });
        assert.ok(links.length > 0);
        for (const l of links) {
            assert.equal(l.author, me);
            assert.notEqual(l.author, alice.did);
        }
        record("rule7", { posts, follows, sampleLink: links[0] });
    });

    it("rule 4: repeated refreshes do not duplicate links", async () => {
        const before = (await connectorLinks()).map(key).sort();
        const syncs = [];
        for (let i = 0; i < 3; i++) syncs.push((await refreshAndSync()).sync);
        const afterLinks = (await connectorLinks()).map(key).sort();
        assert.deepEqual(afterLinks, before);
        assert.equal(new Set(afterLinks).size, afterLinks.length, "no duplicate links");
        assert.deepEqual(syncs, syncs.map(() => ({ added: 0, removed: 0 })));
        record("rule4_idempotent", { links: before.length, syncs });
    });

    it("create/update/delete outside the connector change only those instances", async () => {
        // a user annotation on a record that will NOT change, and on one that will
        await rpc("perspective.addLink", { uuid, link: { source: idOf(created.b1.uri), predicate: NOTE, target: "literal:string:keep%20me" } });
        await rpc("perspective.addLink", { uuid, link: { source: idOf(created.a1.uri), predicate: NOTE, target: "literal:string:on%20edited" } });
        const before = new Set((await connectorLinks()).map(key));

        const c = await createRecord(bob.did, POST, { $type: POST, text: "bob: created later", createdAt: new Date().toISOString() });
        const u = await putRecord(alice.did, POST, rkeyOf(created.a1.uri), { $type: POST, text: "alice: first live post (edited)", createdAt: new Date().toISOString() });
        await deleteRecord(alice.did, POST, rkeyOf(created.a2.uri));
        const { report, sync } = await refreshAndSync();

        const afterLinks = await connectorLinks();
        const after = new Set(afterLinks.map(key));
        const added = [...after].filter((k) => !before.has(k));
        const removed = [...before].filter((k) => !after.has(k));
        const touched = new Set([...added, ...removed].map((k) => k.split(" ")[0]));
        const allowed = new Set([idOf(c.uri), idOf(created.a1.uri), idOf(created.a2.uri), `${L}://account/${alice.did}`, `${L}://account/${bob.did}`]);
        for (const s of touched) assert.ok(allowed.has(s), `unexpected instance changed: ${s}`);
        assert.ok(touched.has(idOf(c.uri)) && touched.has(idOf(created.a1.uri)) && touched.has(idOf(created.a2.uri)));

        const posts = await modelQuery("ATPost");
        assert.ok(posts.some((p) => p.sourceUri === c.uri && p.text === "bob: created later"));
        const edited = posts.find((p) => p.sourceUri === created.a1.uri);
        assert.equal(edited.text, "alice: first live post (edited)");
        assert.equal(edited.cid, u.cid);
        assert.ok(!posts.some((p) => p.sourceUri === created.a2.uri), "deleted record is gone");
        // annotations survive, including on the edited record
        const notes = (await allLinks()).filter((l) => l.data.predicate === NOTE).map((l) => l.data.source).sort();
        assert.deepEqual(notes, [idOf(created.a1.uri), idOf(created.b1.uri)].sort());
        created.c = c;
        record("crud", { report, sync, added, removed });
    });

    it("rule 6: deactivation hides an account's records; reactivation restores them", async () => {
        await pdsCall("com.atproto.server.deactivateAccount", { did: bob.did, body: {} });
        const { report } = await refreshAndSync();
        const posts = await modelQuery("ATPost");
        assert.ok(!posts.some((p) => p.atAuthor === bob.did), "bob's posts hidden");
        assert.ok(posts.some((p) => p.atAuthor === alice.did));
        const accts = await modelQuery("ATAccount");
        assert.equal(accts.find((a) => a.did === bob.did).active, false);
        await pdsCall("com.atproto.server.activateAccount", { did: bob.did, post: true });
        await refreshAndSync();
        const back = await modelQuery("ATPost");
        assert.ok(back.some((p) => p.atAuthor === bob.did), "bob's posts back");
        record("rule6_deactivation", { report, accounts: accts });
    });

    it("rule 6: unmount removes connector links but keeps annotations; remount restores", async () => {
        const notesBefore = await notes();
        const linksBefore = (await connectorLinks()).map(key).sort();
        await rpc("perspective.unmount", { uuid, languageAddress: L });
        assert.deepEqual(await connectorLinks(), [], "no connector links after unmount");
        assert.deepEqual(await notes(), notesBefore);
        await rpc("perspective.mount", { uuid, languageAddress: L }, 300000);
        const linksAfter = (await connectorLinks()).map(key).sort();
        assert.deepEqual(linksAfter, linksBefore);
        assert.deepEqual(await notes(), notesBefore);
        record("unmount_remount", { connectorLinks: linksBefore.length, notes: notesBefore });
    });

    it("restart the executor (PDS up) and remount: a fresh read gives the same links", async () => {
        const r = await restartAndRemount();
        assert.ok(r.refresh.accounts.every((a: any) => a.ok), "a real PDS read after the restart");
        record("restart_pds_up", r);
    });

    it("rule 5 live: a refresh against an unreachable PDS removes nothing", async () => {
        const before = (await connectorLinks()).map(key).sort();
        await stop(pdsProc, "pds-for-outage");
        const { report, sync } = await refreshAndSync();
        assert.ok(report.accounts.every((a: any) => !a.ok));
        assert.deepEqual((await connectorLinks()).map(key).sort(), before);
        record("rule5_outage", { report, sync });
    });

    it("restart the executor with the PDS down: the persisted snapshot is kept; no leaked credentials", async () => {
        const r = await restartAndRemount();
        assert.ok(r.refresh.accounts.every((a: any) => !a.ok), "PDS still down after the restart");

        // credentials: neither account password nor any session token
        // appears anywhere in the executor's data dir or log
        const secrets = [...env.accounts.map((a) => a.password), ...tokens.values()];
        const hits = secretHits(secrets, [join(RUN, "executor"), join(RUN, "executor.log")]);
        assert.deepEqual(hits, [], "credentials leaked into executor state");
        record("restart_pds_down", { ...r, credentialHits: hits, secretsChecked: secrets.length });
    });
});

async function notes() {
    return (await allLinks()).filter((l) => l.data.predicate === NOTE).map(key).sort();
}

/** Stop and restart the executor on the same data dir, wait for the reader
 *  and the mount to come back, refresh, then unmount + mount again. Each
 *  step must leave the connector links and the annotations exactly as
 *  they were. */
async function restartAndRemount() {
    const linksBefore = (await connectorLinks()).map(key).sort();
    const notesBefore = await notes();
    rpcClose();
    await stop(exeProc, "executor-restart");
    await startExecutor(false);
    // load_installed_languages reloads the templated bundle after the agent
    // unlocks; restore_mounts then activates the mount (it polls every 5 s)
    // and syncMount is refused until it has
    const t0 = Date.now();
    await waitFor("reader reloaded", async () => !!(await interact(`${L}://project`, "status")), 180000, 2000);
    await waitFor("mount re-activated", async () => !!(await rpc("perspective.syncMount", { uuid, languageAddress: L }, 60000)), 180000, 2000);
    const reactivatedMs = Date.now() - t0;
    assert.deepEqual((await connectorLinks()).map(key).sort(), linksBefore, "restore changed nothing");
    const { report: refresh, sync } = await refreshAndSync();
    assert.deepEqual((await connectorLinks()).map(key).sort(), linksBefore, "refresh after restart changed nothing");
    await rpc("perspective.unmount", { uuid, languageAddress: L });
    await rpc("perspective.mount", { uuid, languageAddress: L }, 300000);
    const after = (await connectorLinks()).map(key).sort();
    assert.deepEqual(after, linksBefore, "remount after restart changed nothing");
    assert.equal(new Set(after).size, after.length, "no duplicate links");
    assert.deepEqual(await notes(), notesBefore, "annotations kept");
    return { reactivatedMs, links: after.length, notes: notesBefore.length, refresh, sync };
}
