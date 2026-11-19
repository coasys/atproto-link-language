/**
 * Live acceptance for slice 2 (explicit, OAuth-authorized publication): a
 * local PLC + PDS (live/pds.mjs with its CONTROL_PORT harness), the pinned
 * Acorn-stack executor and the built bundle (build/mount/bundle.js).
 *
 *  1. OAuth for alice against the local PDS's own authorization server:
 *     the language does discovery, PAR + PKCE + DPoP and the token
 *     exchange; the person at the authorization page is a scripted,
 *     browser-less user agent (sign-in + consent over the AS's own API).
 *  2. Publish through ATPost's constructor (perspective.createSubject).
 *  3. The same publication key twice: one record.
 *  4. A timeout after the request was sent (the PDS commits, its reply is
 *     dropped): resolved by listing, with no duplicate.
 *  5. Syncs, refreshes and an annotation write nothing.
 *  6. Read-back: bob (a distinct account, following alice) reads alice's
 *     post through a separately templated reader in another perspective,
 *     with no session; atAuthor = alice, links signed by the executor.
 *  7. Restart: the sealed session and the ledger survive.
 *  8. Credential scan of the executor data dir and log: 0 hits.
 *
 * Skipped unless MOUNT_LIVE=1. Needs Node >= 22 and AD4M_EXECUTOR.
 *
 *   MOUNT_LIVE=1 AD4M_EXECUTOR=~/code/ad4m-acorn-target/release/ad4m-executor \
 *     node --import tsx --test --test-concurrency=1 tests/mount-publish-live.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync, openSync, rmSync, readdirSync, statSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { parseLossless } from "../src/mount/lossless-json.js";
import { secretHits } from "./mount-secret-scan.js";

const LIVE = process.env.MOUNT_LIVE === "1";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXECUTOR = process.env.AD4M_EXECUTOR ?? "";
const PLC_PORT = Number(process.env.PLC_PORT ?? 47101);
const PDS_PORT = Number(process.env.PDS_PORT ?? 47102);
const CONTROL_PORT = Number(process.env.CONTROL_PORT ?? 47103);
const AD4M_PORT = Number(process.env.AD4M_PORT ?? 47110);
const RUN = process.env.LIVE_RUN_DIR ?? (LIVE ? mkdtempSync(join(tmpdir(), "atproto-s2-live-")) : "");
if (LIVE && RUN) mkdirSync(RUN, { recursive: true });
const EVIDENCE = join(RUN, "evidence.json");
const SECRETS = join(RUN, "pds-issued-secrets.json");
const PASS = "live-test-passphrase";
const POST = "app.bsky.feed.post";
const FOLLOW = "app.bsky.graph.follow";
const NOTE = "ad4m://user_annotation";
const SCOPE = "atproto repo:app.bsky.feed.post?action=create";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const evidence: Record<string, unknown> = { run: RUN };
function record(key: string, value: unknown) {
    evidence[key] = value;
    if (RUN) writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2));
}

// ---- processes --------------------------------------------------------------

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
        env: {
            ...process.env, PLC_PORT: String(PLC_PORT), PDS_PORT: String(PDS_PORT), ENV_OUT: out,
            CONTROL_PORT: String(CONTROL_PORT), SECRETS_OUT: SECRETS,
        },
        stdio: ["ignore", log, log],
    });
    await waitFor("pds", () => existsSync(out), 120000);
    env = JSON.parse(readFileSync(out, "utf8"));
    await waitFor("pds control", async () => (await fetch(`http://127.0.0.1:${CONTROL_PORT}/log`)).ok, 30000, 500);
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

// ---- executor rpc -------------------------------------------------------------

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
    try {
        return JSON.parse(r);
    } catch {
        return r;
    }
}

// ---- language bundle ---------------------------------------------------------

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
        while (carry) {
            digits.push(carry % 58);
            carry = (carry / 58) | 0;
        }
    }
    let out = "";
    for (const b of bytes) {
        if (b === 0) out += "1";
        else break;
    }
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

async function installTemplated(base: string, accounts: string[]) {
    const templ = { ACCOUNTS: accounts.join(","), PLC_URL: env.plcUrl, APPVIEW_URL: "", POLL_MS: "3600000", ALLOW_HTTP: "1" };
    const ref = await rpc("language.applyTemplateLocal", { sourceLanguageHash: base, templateData: JSON.stringify(templ) }, 300000);
    await waitFor("language status", async () => !!(await interact(`${ref.address}://project`, "status")), 120000, 2000);
    return { address: ref.address as string, template: templ };
}

// ---- PDS: harness log, and writes outside the connector (seeding only) --------

async function pdsLog(): Promise<any[]> {
    return (await fetch(`http://127.0.0.1:${CONTROL_PORT}/log`)).json();
}
async function arm(kind: string) {
    const r = await fetch(`http://127.0.0.1:${CONTROL_PORT}/arm?kind=${kind}`, { method: "POST" });
    assert.equal((await r.json()).armed, kind);
}
function issued(): { accessTokens: string[]; refreshTokens: string[]; verifiers: string[]; dpopPublic: Array<{ x: string; y: string }>; scopes: string[] } {
    return JSON.parse(readFileSync(SECRETS, "utf8"));
}

const legacyTokens = new Map<string, string>();
async function pdsCall(method: string, opts: { did?: string; body?: unknown; query?: Record<string, string> } = {}) {
    const q = opts.query ? "?" + new URLSearchParams(opts.query).toString() : "";
    const headers: Record<string, string> = {};
    if (opts.did) headers.authorization = `Bearer ${legacyTokens.get(opts.did)}`;
    if (opts.body) headers["content-type"] = "application/json";
    const res = await fetch(`${env.pdsUrl}/xrpc/${method}${q}`, {
        method: opts.body ? "POST" : "GET", headers, body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} -> ${res.status} ${text}`);
    return text;
}
/** Seeding outside the connector (bob's follow) uses the PDS's legacy
 *  session, as slice 1's live test did. The language never sees it. */
async function login(acct: { did: string; password: string }) {
    const r = JSON.parse(await pdsCall("com.atproto.server.createSession", { body: { identifier: acct.did, password: acct.password } }));
    legacyTokens.set(acct.did, r.accessJwt);
}
async function listPds(did: string, collection: string) {
    const j = parseLossless(await pdsCall("com.atproto.repo.listRecords", { query: { repo: did, collection, limit: "100" } })) as any;
    return j.records as Array<{ uri: string; cid: string; value: any }>;
}

// ---- the person at the authorization page: a scripted, browser-less user agent -

function raw(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
    // node:http, not fetch: fetch rewrites the sec-fetch-* headers a browser sends
    return new Promise((resolve, reject) => {
        const req = http.request(url, { method: opts.method ?? "GET", headers: opts.headers ?? {} }, (r) => {
            let t = "";
            r.on("data", (c) => (t += c));
            r.on("end", () => resolve({ status: r.statusCode ?? 0, headers: r.headers, text: t }));
        });
        req.on("error", reject);
        if (opts.body) req.write(opts.body);
        req.end();
    });
}

/** Open the authorization URL, sign in, consent; returns the callback URL
 *  the browser would be redirected to. Only the AS's own UI API is used. */
async function personApproves(authorizeUrl: string, acct: { did: string; handle: string; password: string }) {
    const as = new URL(authorizeUrl).origin;
    const jar = new Map<string, string>();
    const keep = (h: http.IncomingHttpHeaders) => {
        for (const c of h["set-cookie"] ?? []) {
            const kv = c.split(";")[0];
            const i = kv.indexOf("=");
            jar.set(kv.slice(0, i), kv.slice(i + 1));
        }
    };
    const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const page = await raw(authorizeUrl, { headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "sec-fetch-site": "none", "user-agent": "s2-live" } });
    assert.equal(page.status, 200, "authorization page");
    keep(page.headers);
    const api = async (ep: string, body: unknown) => {
        const r = await raw(`${as}/@atproto/oauth-provider/~api${ep}`, {
            method: "POST", body: JSON.stringify(body), headers: {
                "content-type": "application/json", origin: as, referer: authorizeUrl,
                "sec-fetch-mode": "same-origin", "sec-fetch-site": "same-origin", "sec-fetch-dest": "empty",
                "x-csrf-token": jar.get("csrf-token") ?? "", cookie: cookie(), "user-agent": "s2-live",
            },
        });
        keep(r.headers);
        return { status: r.status, json: JSON.parse(r.text) };
    };
    const signIn = await api("/sign-in", { locale: "en", identifier: acct.handle, password: acct.password, remember: true });
    assert.equal(signIn.status, 200, `sign-in: ${JSON.stringify(signIn.json).slice(0, 200)}`);
    assert.equal(signIn.json.account?.sub ?? signIn.json.account?.did, acct.did);
    const consent = await api("/consent", { did: acct.did, scope: SCOPE });
    assert.equal(consent.status, 200, `consent: ${JSON.stringify(consent.json).slice(0, 200)}`);
    const redirect = await raw(consent.json.url, {
        headers: {
            referer: authorizeUrl, origin: as, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document",
            "sec-fetch-site": "same-origin", cookie: cookie(), "user-agent": "s2-live",
        },
    });
    assert.ok(redirect.status >= 300 && redirect.status < 400 && redirect.headers.location, `redirect ${redirect.status}`);
    return String(redirect.headers.location);
}

// ---- perspective helpers --------------------------------------------------------

let L = "";
let R = "";
let pubUuid = "";
let readUuid = "";
let me = "";

async function modelQuery(uuid: string, cls: string): Promise<any[]> {
    const res = await rpc("perspective.modelQuery", { uuid, class_name: cls, query_json: "{}" }, 180000);
    const parsed = typeof res === "string" ? JSON.parse(res) : res;
    return parsed?.instances ?? [];
}
async function allLinks(uuid: string): Promise<any[]> {
    const r = await rpc("perspective.queryLinks", { uuid }, 180000);
    return typeof r === "string" ? JSON.parse(r) : r;
}
async function createPost(text: string, publicationKey: string, atAuthor: string) {
    return rpc("perspective.createSubject", {
        uuid: pubUuid, subjectClass: "ATPost", expressionAddress: "",
        initialValues: JSON.stringify({ text, atAuthor, publicationKey }),
    }, 180000);
}
const creates = (log: any[], did: string) => log.filter((e) => e.method === "POST" && e.path === "/xrpc/com.atproto.repo.createRecord" && e.repo === did);
const postsWithText = async (did: string, text: string) => (await listPds(did, POST)).filter((r) => r.value?.text === text);

/** every file under `dir` whose name matches `re` */
function filesUnder(dir: string, re: RegExp): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) out.push(...filesUnder(p, re));
        else if (re.test(name)) out.push(p);
    }
    return out;
}

// -----------------------------------------------------------------------------------

describe("slice 2 — explicit OAuth publication, live", { skip: !LIVE && "set MOUNT_LIVE=1 (needs Node >= 22, AD4M_EXECUTOR)" }, () => {
    let alice: any, bob: any;
    const K1 = "live-key-0001";
    const K2 = "live-key-0002-timeout";
    const K3 = "live-key-0003-after-restart";
    const T1 = `Hello from AD4M (slice 2 live, ${new Date().toISOString()})`;
    const T2 = "A post whose createRecord reply is dropped";
    const T3 = "Published after an executor restart";
    let url1 = "";
    let url2 = "";

    before(async () => {
        assert.ok(EXECUTOR && existsSync(EXECUTOR), "AD4M_EXECUTOR must point at the built executor");
        const bundle = join(ROOT, "build", "mount", "bundle.js");
        assert.ok(existsSync(bundle), "build the bundle first: node mount-build.mjs");
        record("executor", EXECUTOR);
        record("bundleSha256", createHash("sha256").update(readFileSync(bundle)).digest("hex"));
        await startPds();
        [alice, bob] = env.accounts;
        record("accounts", env.accounts.map(({ name, did, handle }) => ({ name, did, handle })));
        record("pds", { plcUrl: env.plcUrl, pdsUrl: env.pdsUrl });
        me = await startExecutor(true);
        record("executorDid", me);
    });

    after(async () => {
        rpcClose();
        await stop(exeProc, "executor");
        await stop(pdsProc, "pds");
        // the issued-secrets file served the scan; do not leave tokens around
        if (existsSync(SECRETS)) rmSync(SECRETS);
    });

    it("seeds bob following alice (outside the connector) and installs + mounts the publisher language", async () => {
        await login(bob);
        await pdsCall("com.atproto.repo.createRecord", {
            did: bob.did, body: { repo: bob.did, collection: FOLLOW, record: { $type: FOLLOW, subject: alice.did, createdAt: new Date().toISOString() } },
        });
        const base = publishLocal(join(ROOT, "build", "mount", "bundle.js"));
        const lang = await installTemplated(base, [alice.did, bob.did]);
        L = lang.address;
        record("publisherLanguage", { base, templated: L, template: lang.template });
        pubUuid = (await rpc("perspective.create", { name: "atproto publisher (alice's executor user)" })).uuid;
        await rpc("perspective.mount", { uuid: pubUuid, languageAddress: L }, 300000);
        assert.deepEqual(await rpc("perspective.mounts", { uuid: pubUuid }), [L]);
        const status = await interact(`${L}://project`, "status");
        assert.deepEqual(status.oauth.authorizedAccounts, []);
        assert.equal(status.oauth.scope, SCOPE);
        record("status_before", status);
    });

    it("OAuth: the language authorizes alice at the local PDS's AS (PAR, PKCE, DPoP); a scripted person signs in and consents", async () => {
        const begin = await interact(`${L}://project`, "authorize", { account: alice.did });
        assert.equal(begin.account, alice.did);
        assert.equal(begin.issuer, env.pdsUrl);
        const au = new URL(begin.authorizeUrl);
        assert.equal(`${au.origin}${au.pathname}`, `${env.pdsUrl}/oauth/authorize`);
        assert.deepEqual([...au.searchParams.keys()].sort(), ["client_id", "request_uri"]);
        const callbackUrl = await personApproves(begin.authorizeUrl, alice);
        const cb = new URL(callbackUrl);
        assert.equal(`${cb.origin}${cb.pathname}`, "http://127.0.0.1/callback");
        assert.equal(cb.searchParams.get("iss"), env.pdsUrl);
        const done = await interact(`${L}://project`, "completeAuthorization", { callbackUrl });
        assert.equal(done.account, alice.did);
        assert.equal(done.scope, SCOPE, "the narrowest scope: atproto + create posts");
        assert.deepEqual(Object.keys(done).sort(), ["account", "expiresAt", "issuer", "scope"]);
        const sessions = await interact(`${L}://project`, "sessions");
        assert.deepEqual(sessions.map((s: any) => s.account), [alice.did]);
        const log = await pdsLog();
        const oauthPaths = log.filter((e) => e.path.startsWith("/oauth/") || e.path.startsWith("/.well-known/oauth")).map((e) => `${e.method} ${e.path} ${e.status}`);
        assert.ok(oauthPaths.includes("POST /oauth/par 201"), "PAR");
        assert.ok(oauthPaths.some((p) => p.startsWith("POST /oauth/token 200")), "token");
        const sec = issued();
        assert.ok(sec.accessTokens.length >= 1 && sec.refreshTokens.length >= 1 && sec.verifiers.length >= 1 && sec.dpopPublic.length >= 1, "harness captured what to scan for");
        assert.deepEqual(sec.scopes, [SCOPE]);
        record("oauth", { begin: { issuer: begin.issuer, expiresIn: begin.expiresIn }, done, sessions, oauthRequests: oauthPaths });
    });

    it("publish: createSubject(ATPost) creates one app.bsky.feed.post as alice; the model shows it with atAuthor = alice, signed by the executor", async () => {
        const mark = (await pdsLog()).length;
        url1 = await createPost(T1, K1, alice.did);
        assert.equal(typeof url1, "string");
        assert.ok(url1.startsWith(`${L}://${alice.did}/${POST}/`), url1);
        const rkey = url1.split("/").pop()!;
        const onPds = await postsWithText(alice.did, T1);
        assert.equal(onPds.length, 1, "one record on the PDS");
        assert.equal(onPds[0].uri, `at://${alice.did}/${POST}/${rkey}`);
        const sent = creates((await pdsLog()).slice(mark), alice.did);
        assert.equal(sent.filter((e) => e.status === 200).length, 1, "one createRecord succeeded");
        const posts = await modelQuery(pubUuid, "ATPost");
        const row = posts.find((p) => p.id === url1);
        assert.ok(row, "queryable right after the call (the call's delta)");
        assert.equal(row.text, T1);
        assert.equal(row.atAuthor, alice.did);
        assert.equal(row.cid, onPds[0].cid);
        assert.equal(row.sourceUri, onPds[0].uri);
        assert.equal(row.publicationKey, K1);
        assert.equal(row.author, me, "the link signer is the executor agent");
        assert.notEqual(row.author, alice.did);
        const links = (await allLinks(pubUuid)).filter((l) => l.data.source === url1);
        assert.ok(links.length > 0 && links.every((l) => l.author === me));
        record("publish", { url: url1, pds: onPds[0], model: row, createRecordRequests: sent.map(({ t, status, rkey }) => ({ t, status, rkey })) });
    });

    it("the same publication key twice gives one record and no request", async () => {
        const mark = (await pdsLog()).length;
        const again = await createPost(T1, K1, alice.did);
        assert.equal(again, url1);
        assert.equal(creates((await pdsLog()).slice(mark), alice.did).length, 0, "no createRecord");
        assert.equal((await postsWithText(alice.did, T1)).length, 1);
        record("sameKeyTwice", { url: again, createRecordRequests: 0 });
    });

    it("a timeout after the request was sent is resolved by listing, without a duplicate", async () => {
        await arm("commitThenDrop");
        const mark = (await pdsLog()).length;
        const t0 = Date.now();
        await assert.rejects(createPost(T2, K2, alice.did), /outcome uncertain/);
        const failedAfterMs = Date.now() - t0;
        const first = (await pdsLog()).slice(mark);
        const dropped = creates(first, alice.did).filter((e) => e.dropped);
        assert.equal(dropped.length, 1, "the create reached the PDS and its reply was dropped");
        assert.equal(dropped[0].status, 200, "the PDS committed it");
        assert.equal((await postsWithText(alice.did, T2)).length, 1, "it is on the PDS");

        const mark2 = (await pdsLog()).length;
        url2 = await createPost(T2, K2, alice.did);
        const second = (await pdsLog()).slice(mark2);
        const listAt = second.findIndex((e) => e.path === "/xrpc/com.atproto.repo.listRecords" && e.repo === alice.did && e.collection === POST);
        assert.ok(listAt >= 0, "the retry listed alice's posts");
        assert.equal(creates(second, alice.did).length, 0, "and sent no createRecord");
        assert.equal(url2.split("/").pop(), dropped[0].rkey, "the record the dropped request created");
        const onPds = await postsWithText(alice.did, T2);
        assert.equal(onPds.length, 1, "still one record");
        const row = (await modelQuery(pubUuid, "ATPost")).find((p) => p.id === url2);
        assert.equal(row?.cid, onPds[0].cid);
        assert.equal(row?.publicationKey, K2);
        record("uncertainCreate", {
            failedAfterMs, dropped: dropped.map(({ t, rkey, status, reply }) => ({ t, rkey, status, reply })),
            retry: second.map(({ t, method, path, repo, collection, status }) => ({ t, method, path, repo, collection, status })),
            url: url2, pds: onPds[0],
        });
    });

    it("refreshes, syncs and an annotation write nothing to the PDS", async () => {
        const mark = (await pdsLog()).length;
        const before = (await listPds(alice.did, POST)).length;
        await rpc("perspective.addLink", { uuid: pubUuid, link: { source: url1, predicate: NOTE, target: "literal:string:annotated%20locally" } });
        for (let i = 0; i < 3; i++) {
            await interact(`${L}://project`, "refresh");
            await rpc("perspective.syncMount", { uuid: pubUuid, languageAddress: L }, 300000);
        }
        const after = (await pdsLog()).slice(mark);
        const writes = after.filter((e) => e.method !== "GET");
        assert.deepEqual(writes.map((e) => `${e.method} ${e.path}`), [], "no POST of any kind");
        assert.equal((await listPds(alice.did, POST)).length, before);
        const row = (await modelQuery(pubUuid, "ATPost")).find((p) => p.id === url1);
        assert.equal(row?.publicationKey, K1, "the read keeps the key: no flap");
        const notes = (await allLinks(pubUuid)).filter((l) => l.data.predicate === NOTE);
        assert.equal(notes.length, 1, "the annotation is kept");
        record("noSideEffectWrites", { requests: after.length, nonGet: writes.length });
    });

    it("read-back: bob's reader (another perspective and language instance, no session) shows alice's posts with atAuthor = alice", async () => {
        const base = publishLocal(join(ROOT, "build", "mount", "bundle.js"));
        const lang = await installTemplated(base, [bob.did, alice.did]);
        R = lang.address;
        assert.notEqual(R, L);
        readUuid = (await rpc("perspective.create", { name: "bob's view" })).uuid;
        const mark = (await pdsLog()).length;
        await rpc("perspective.mount", { uuid: readUuid, languageAddress: R }, 300000);
        const status = await interact(`${R}://project`, "status");
        assert.deepEqual(status.oauth.authorizedAccounts, [], "this reader holds no session");
        const follows = await modelQuery(readUuid, "ATFollow");
        assert.ok(follows.some((f) => f.atAuthor === bob.did && f.subject === alice.did), "bob follows alice");
        const posts = await modelQuery(readUuid, "ATPost");
        for (const [u, t] of [[url1, T1], [url2, T2]]) {
            const id = `${R}://${u.slice(`${L}://`.length)}`;
            const row = posts.find((p) => p.id === id);
            assert.ok(row, `bob's view has ${id}`);
            assert.equal(row.text, t);
            assert.equal(row.atAuthor, alice.did);
            assert.equal(row.author, me, "signed by the executor agent, not alice");
            assert.equal(row.publicationKey, undefined, "no ledger in this language instance");
        }
        const reads = (await pdsLog()).slice(mark);
        assert.deepEqual(reads.filter((e) => e.method !== "GET").map((e) => e.path), [], "the reader only reads");
        record("readBack", { reader: R, template: lang.template, follows: follows.map(({ atAuthor, subject }) => ({ atAuthor, subject })), posts: posts.map(({ id, text, atAuthor, author }) => ({ id, text, atAuthor, author })) });
    });

    it("restart: the sealed session opens again and the ledger still answers", async () => {
        rpcClose();
        await stop(exeProc, "executor-restart");
        await startExecutor(false);
        await waitFor("publisher reloaded", async () => !!(await interact(`${L}://project`, "status")), 180000, 2000);
        await waitFor("mount re-activated", async () => !!(await rpc("perspective.syncMount", { uuid: pubUuid, languageAddress: L }, 60000)), 180000, 2000);
        const mark = (await pdsLog()).length;
        assert.equal(await createPost(T1, K1, alice.did), url1, "K1 answers from the ledger");
        assert.equal(creates((await pdsLog()).slice(mark), alice.did).length, 0);
        const url3 = await createPost(T3, K3, alice.did);
        assert.equal((await postsWithText(alice.did, T3)).length, 1, "the restored session publishes");
        const all = (await listPds(alice.did, POST)).map((r) => r.value.text).sort();
        assert.deepEqual(all, [T2, T1, T3].sort(), "alice's repo holds exactly the three publications");
        record("restart", { url3, alicePosts: all });
    });

    it("credential scan: no token, verifier or DPoP key in the executor data dir or log", async () => {
        rpcClose();
        await stop(exeProc, "executor-final");
        const sec = issued();
        const values = [
            ...sec.accessTokens, ...sec.refreshTokens, ...sec.verifiers,
            ...sec.dpopPublic.flatMap((k) => [k.x, k.y]),
            ...env.accounts.map((a) => a.password),
        ];
        assert.ok(values.length >= 7, "something to scan for");
        const paths = [join(RUN, "executor"), join(RUN, "executor.log")];
        const hits = secretHits(values, paths);
        assert.deepEqual(hits, [], "credentials in executor state");
        // the language KV holds the session — sealed: no JWK or token field names in clear
        const kv = filesUnder(join(RUN, "executor"), /^ad4m-language-kv\.json$/);
        assert.ok(kv.length >= 1, "language KV files exist");
        const kvText = kv.map((f) => readFileSync(f, "utf8")).join("\n");
        assert.ok(kvText.includes(`oauth/v1/session/${me}/${alice.did}`), "a sealed session is stored (the scan is not vacuous)");
        for (const pattern of [/"d"\s*:/, /accessToken|refreshToken|access_token|refresh_token|dpopJwk|verifier/, /"crv"\s*:\s*"P-256"/]) {
            assert.doesNotMatch(kvText.replace(/\\"/g, '"'), pattern, String(pattern));
        }
        record("credentialScan", {
            valuesChecked: values.length, kinds: {
                accessTokens: sec.accessTokens.length, refreshTokens: sec.refreshTokens.length, verifiers: sec.verifiers.length,
                dpopPublicKeys: sec.dpopPublic.length, passwords: env.accounts.length,
            }, paths, hits, kvFiles: kv.length,
        });
    });
});
