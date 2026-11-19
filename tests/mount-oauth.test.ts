/**
 * Slice 2 rule 2 (hermetic): the atproto OAuth profile against a fake AS —
 * discovery, PAR + PKCE S256 + DPoP ES256 with nonces, the narrowest scope,
 * account checks — and credential handling: tokens and DPoP keys only
 * sealed to the executor agent in host storage, keyed per executor user and
 * AT account, never in a template, a log, a result or an error.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { MountService, type ServiceOptions } from "../src/mount/service.js";
import { CLIENT_ID, OAUTH_SCOPE, REDIRECT_URI } from "../src/mount/oauth.js";
import { vaultKeys } from "../src/mount/vault.js";
import { sealToDid, x25519PublicOfDidKey } from "../src/mount/sealed-box.js";
import { TEMPLATE_VARS } from "../mount-template.mjs";
import { PDS2, PLC } from "./mount-fixtures.js";
import { ALICE, BOB, FakeAgent, ISSUER, MemStorage, PDS, SCOPE, testCrypto, writeNet, type FakeWriteNet } from "./mount-write-fixtures.js";

const LANG = "QmzTestLanguage";

function service(net: FakeWriteNet, over: Partial<ServiceOptions> & { agent?: FakeAgent } = {}) {
    const agent = over.agent ?? new FakeAgent();
    const storage = over.storage ?? new MemStorage();
    const svc = new MountService({
        accounts: [ALICE, BOB],
        plcUrl: PLC,
        appviewUrl: "",
        transport: net,
        storage,
        crypto: testCrypto,
        agent: { did: () => agent.did, openSealed: (b) => agent.openSealed(b) },
        timeoutMs: 200,
        writeTimeoutMs: 200,
        languageAddress: () => LANG,
        ...over,
    });
    return { svc, agent, storage: storage as MemStorage };
}

const formOf = (body: string) => Object.fromEntries(new URLSearchParams(body));
const jwtPart = (jwt: string, i: number) => JSON.parse(Buffer.from(jwt.split(".")[i], "base64url").toString());

describe("rule 2: atproto OAuth profile", () => {
    it("authorize: DID -> PDS -> protected resource -> AS discovery, then PAR with PKCE S256, DPoP ES256 + nonce, the narrowest scope", async () => {
        const net = writeNet();
        const { svc } = service(net);
        const r = await svc.call("project", "authorize", { account: ALICE });
        const urls = net.requestsLog.map((q) => `${q.method} ${q.url.split("?")[0]}`);
        assert.deepEqual(urls, [
            `GET ${PLC}/${ALICE}`,
            `GET ${PDS}/.well-known/oauth-protected-resource`,
            `GET ${ISSUER}/.well-known/oauth-authorization-server`,
            `POST ${ISSUER}/oauth/par`,
            `POST ${ISSUER}/oauth/par`,
        ]);
        const [first, par] = net.requestsLog.slice(3);
        assert.equal(jwtPart(first.headers["dpop"], 1).nonce, undefined, "first PAR has no nonce yet");
        assert.equal(jwtPart(par.headers["dpop"], 1).nonce, net.asNonce, "retried with the server's nonce");
        const hdr = jwtPart(par.headers["dpop"], 0);
        assert.equal(hdr.typ, "dpop+jwt");
        assert.equal(hdr.alg, "ES256");
        assert.equal(hdr.jwk.d, undefined, "the proof carries only the public key");
        const f = formOf(par.body);
        assert.equal(f.scope, SCOPE);
        assert.equal(OAUTH_SCOPE, SCOPE, "atproto + create posts only");
        assert.equal(f.code_challenge_method, "S256");
        assert.match(f.code_challenge, /^[A-Za-z0-9_-]{43}$/);
        assert.equal(f.login_hint, ALICE);
        assert.equal(f.response_type, "code");
        assert.equal(f.client_id, CLIENT_ID);
        assert.equal(f.redirect_uri, REDIRECT_URI);
        const cid = new URL(CLIENT_ID);
        assert.equal(cid.origin, "http://localhost");
        assert.equal(cid.searchParams.get("scope"), SCOPE);
        assert.deepEqual(cid.searchParams.getAll("redirect_uri"), [REDIRECT_URI]);
        assert.equal(f.code_verifier, undefined);
        const au = new URL(r.authorizeUrl);
        assert.equal(`${au.origin}${au.pathname}`, `${ISSUER}/oauth/authorize`);
        assert.deepEqual([...au.searchParams.keys()].sort(), ["client_id", "request_uri"]);
        assert.equal(r.account, ALICE);
        assert.equal(r.issuer, ISSUER);
        assert.equal(r.state, f.state);
        assert.deepEqual(Object.keys(r).sort(), ["account", "authorizeUrl", "expiresIn", "issuer", "state"]);
    });

    it("completeAuthorization: the code is redeemed with the PKCE verifier and the PAR's DPoP key; the session is stored sealed only", async () => {
        const net = writeNet();
        const { svc, agent, storage } = service(net);
        const begin = await svc.call("project", "authorize", { account: ALICE });
        const done = await svc.call("project", "completeAuthorization", { callbackUrl: net.approve(begin.authorizeUrl, ALICE) });
        assert.deepEqual(Object.keys(done).sort(), ["account", "expiresAt", "issuer", "scope"]);
        assert.equal(done.account, ALICE);
        assert.equal(done.scope, SCOPE);
        const tokenReq = net.requestsLog.filter((q) => q.url === `${ISSUER}/oauth/token`).pop()!;
        const tf = formOf(tokenReq.body);
        assert.equal(tf.grant_type, "authorization_code");
        assert.ok(tf.code_verifier && tf.code_verifier.length >= 43);
        const parJwk = jwtPart(net.requestsLog.find((q) => q.url.endsWith("/oauth/par"))!.headers["dpop"], 0).jwk;
        assert.deepEqual(jwtPart(tokenReq.headers["dpop"], 0).jwk, parJwk, "same DPoP key as the PAR");

        const sessionKey = vaultKeys.session(agent.did, ALICE);
        assert.ok(sessionKey.includes(agent.did) && sessionKey.includes(ALICE), "keyed per executor user and AT account");
        const stored = storage.get(sessionKey)!;
        assert.ok(stored, "a session is stored");
        const opened = JSON.parse(Buffer.from(await agent.openSealed(JSON.parse(stored).box), "hex").toString());
        assert.equal(opened.account, ALICE);
        assert.ok(opened.accessToken && opened.refreshToken && opened.dpopJwk?.d, "the sealed session holds tokens and the private DPoP key");
        const dump = storage.dump();
        for (const s of [...net.issued, opened.dpopJwk.d, tf.code_verifier]) assert.ok(!dump.includes(s), "no secret in plain storage");
        assert.deepEqual(await svc.call("project", "sessions"), [{ account: ALICE, scope: SCOPE, issuer: ISSUER, expiresAt: done.expiresAt }]);
    });

    it("discovery is checked before any PAR is sent", async () => {
        const cases: Array<[string, (n: FakeWriteNet) => void, RegExp]> = [
            ["no protected-resource metadata", (n) => n.prm.delete(PDS), /protected-resource/],
            ["resource names another server", (n) => n.prm.set(PDS, { resource: PDS2, authorization_servers: [ISSUER] }), /resource/],
            ["no authorization server", (n) => n.prm.set(PDS, { resource: PDS, authorization_servers: [] }), /authorization server/],
            ["AS issuer mismatch", (n) => (n.asMeta.issuer = "https://evil.test"), /issuer/],
            ["no PAR endpoint", (n) => delete n.asMeta.pushed_authorization_request_endpoint, /PAR/],
            ["no S256", (n) => (n.asMeta.code_challenge_methods_supported = ["plain"]), /S256/],
            ["no ES256", (n) => (n.asMeta.dpop_signing_alg_values_supported = ["RS256"]), /ES256/],
            ["no atproto scope", (n) => (n.asMeta.scopes_supported = ["openid"]), /atproto/],
            ["no iss in responses", (n) => (n.asMeta.authorization_response_iss_parameter_supported = false), /iss/],
            ["endpoint on another origin", (n) => (n.asMeta.token_endpoint = "https://evil.test/oauth/token"), /origin/],
            ["DID document for another DID", (n) => n.didDocs.set(ALICE, n.docFor(BOB, "x.test", PDS)), /id/],
        ];
        for (const [name, breakIt, re] of cases) {
            const net = writeNet();
            breakIt(net);
            const { svc, storage } = service(net);
            await assert.rejects(svc.call("project", "authorize", { account: ALICE }), re, name);
            assert.equal(net.requestsLog.filter((q) => q.method === "POST").length, 0, `${name}: no PAR`);
            assert.equal(storage.map.size, 0, `${name}: nothing stored`);
        }
    });

    it("the callback and token response are checked; a failed check stores no session", async () => {
        const cases: Array<[string, (n: FakeWriteNet, url: string, state: string) => string, RegExp]> = [
            ["unknown state", (n, url) => n.approve(url, ALICE, { state: "nope" }), /state/],
            ["iss mismatch", (n, url) => n.approve(url, ALICE, { iss: "https://evil.test" }), /iss/],
            ["denied", (n, url) => n.deny(url), /access_denied/],
            ["token sub is another account", (n, url) => ((n.tokenOverride = { sub: BOB }), n.approve(url, ALICE)), /sub/],
            ["token type is Bearer", (n, url) => ((n.tokenOverride = { token_type: "Bearer" }), n.approve(url, ALICE)), /DPoP/],
            ["scope lacks the create permission", (n, url) => ((n.tokenOverride = { scope: "atproto" }), n.approve(url, ALICE)), /scope/],
            ["the account's PDS now names another AS", (n, url) => {
                n.didDocs.set(ALICE, n.docFor(ALICE, "alice.test", PDS2));
                n.prm.set(PDS2, { resource: PDS2, authorization_servers: ["https://other-as.test"] });
                return n.approve(url, ALICE);
            }, /authorization server/],
        ];
        for (const [name, cb, re] of cases) {
            const net = writeNet();
            const { svc, agent, storage } = service(net);
            const begin = await svc.call("project", "authorize", { account: ALICE });
            await assert.rejects(svc.call("project", "completeAuthorization", { callbackUrl: cb(net, begin.authorizeUrl, begin.state) }), re, name);
            assert.equal(storage.get(vaultKeys.session(agent.did, ALICE)), null, `${name}: no session`);
            assert.deepEqual(await svc.call("project", "sessions"), [], name);
            for (const s of net.issued) assert.ok(!storage.dump().includes(s), `${name}: no token stored`);
        }
    });

    it("a pending authorization is single-use", async () => {
        const net = writeNet();
        const { svc } = service(net);
        const begin = await svc.call("project", "authorize", { account: ALICE });
        const cb = net.approve(begin.authorizeUrl, ALICE);
        await svc.call("project", "completeAuthorization", { callbackUrl: cb });
        await assert.rejects(svc.call("project", "completeAuthorization", { callbackUrl: cb }), /state/);
    });

    it("sessions are per executor user and per AT account", async () => {
        const net = writeNet();
        const shared = new MemStorage();
        const { svc: a } = service(net, { storage: shared });
        await a.call("project", "completeAuthorization", {
            callbackUrl: net.approve((await a.call("project", "authorize", { account: ALICE })).authorizeUrl, ALICE),
        });
        const { svc: b } = service(net, { storage: shared }); // another executor user, same language storage
        assert.deepEqual(await b.call("project", "sessions"), []);
        const mark = net.requestsLog.length;
        await assert.rejects(b.call("class/ATPost", "publish", { text: "x", atAuthor: ALICE, publicationKey: "user-b-key-1" }), /not authorized/);
        await assert.rejects(a.call("class/ATPost", "publish", { text: "x", atAuthor: BOB, publicationKey: "user-a-key-1" }), /not authorized/);
        assert.equal(net.requestsLog.slice(mark).length, 0);
    });

    it("an expired access token is refreshed with the same DPoP key before the write; rotated tokens stay sealed", async () => {
        const net = writeNet();
        let now = Date.now();
        net.nowMs = () => now;
        net.accessTtlMs = 60_000;
        const { svc, storage } = service(net, { now: () => new Date(now) });
        await svc.call("project", "completeAuthorization", {
            callbackUrl: net.approve((await svc.call("project", "authorize", { account: ALICE })).authorizeUrl, ALICE),
        });
        const firstAccess = net.issued[0];
        now += 120_000;
        const mark = net.requestsLog.length;
        await svc.call("class/ATPost", "publish", { text: "after refresh", atAuthor: ALICE, publicationKey: "refresh-key-1" });
        const after = net.requestsLog.slice(mark);
        const ti = after.findIndex((q) => q.url === `${ISSUER}/oauth/token` && formOf(q.body).grant_type === "refresh_token");
        const wi = after.findIndex((q) => q.url.includes("createRecord"));
        assert.ok(ti >= 0 && ti < wi, "refreshed before the write");
        const used = after.filter((q) => q.url.includes("createRecord")).map((q) => q.headers["authorization"]);
        assert.ok(used.every((a) => a !== `DPoP ${firstAccess}`), "the write uses the new token");
        assert.equal(net.postsWithText(ALICE, "after refresh").length, 1);
        for (const s of net.issued) assert.ok(!storage.dump().includes(s));
    });

    it("signOut revokes and forgets the session", async () => {
        const net = writeNet();
        const { svc, agent, storage } = service(net);
        await svc.call("project", "completeAuthorization", {
            callbackUrl: net.approve((await svc.call("project", "authorize", { account: ALICE })).authorizeUrl, ALICE),
        });
        await svc.call("project", "signOut", { account: ALICE });
        assert.ok(net.requestsLog.some((q) => q.url === `${ISSUER}/oauth/revoke`));
        assert.equal(storage.get(vaultKeys.session(agent.did, ALICE)), null);
        assert.equal(net.refresh.size, 0);
        assert.deepEqual(await svc.call("project", "sessions"), []);
    });

    it("no token, refresh token, verifier or DPoP private key appears in any result, error, signal, log, snapshot or shape", async () => {
        const net = writeNet();
        const { svc, agent, storage } = service(net);
        const seen: string[] = [];
        const methods = ["log", "info", "warn", "error", "debug"] as const;
        const orig = methods.map((m) => console[m]);
        methods.forEach((m) => (console[m] = (...a: unknown[]) => void seen.push(a.map(String).join(" "))));
        try {
            const keep = (v: unknown) => seen.push(JSON.stringify(v));
            const fail = async (p: Promise<unknown>) => p.then(keep, (e) => seen.push(String(e), String((e as Error).stack)));
            await svc.refresh().then(keep);
            const begin = await svc.call("project", "authorize", { account: ALICE });
            keep(begin);
            keep(await svc.call("project", "completeAuthorization", { callbackUrl: net.approve(begin.authorizeUrl, ALICE) }));
            keep(await svc.call("class/ATPost", "publish", { text: "t1", atAuthor: ALICE, publicationKey: "scan-key-01" }));
            net.writeFaults.push({ kind: "commitThenHang" });
            await fail(svc.call("class/ATPost", "publish", { text: "t2", atAuthor: ALICE, publicationKey: "scan-key-02" }));
            net.writeFaults.push({ kind: "statusBeforeCommit", status: 401 });
            await fail(svc.call("class/ATPost", "publish", { text: "t3", atAuthor: ALICE, publicationKey: "scan-key-03" }));
            await fail(svc.call("project", "completeAuthorization", { callbackUrl: `${REDIRECT_URI}?state=x&iss=${ISSUER}&code=y` }));
            keep(await svc.call("project", "status"));
            keep(await svc.call("project", "sessions"));
            keep(await svc.refresh());
            keep(svc.snapshot());
            keep(mountShapesOf(svc));
        } finally {
            methods.forEach((m, i) => (console[m] = orig[i]));
        }
        const opened = JSON.parse(Buffer.from(await agent.openSealed(JSON.parse(storage.get(vaultKeys.session(agent.did, ALICE))!).box), "hex").toString());
        const verifiers = net.requestsLog.map((q) => formOf(q.body).code_verifier).filter(Boolean);
        const secrets = [...net.issued, opened.dpopJwk.d, ...verifiers];
        assert.ok(secrets.length >= 4);
        const all = seen.join("\n") + "\n" + storage.dump();
        for (const s of secrets) assert.ok(!all.includes(s), "secret leaked");
    });
});

function mountShapesOf(svc: MountService) {
    return svc.shapes();
}

describe("rule 2: no credential can travel in a template or the bundle", () => {
    it("the template variables are exactly the five non-secret settings", () => {
        assert.deepEqual(TEMPLATE_VARS.map(([k]) => k), ["ACCOUNTS", "PLC_URL", "APPVIEW_URL", "POLL_MS", "ALLOW_HTTP"]);
        for (const [k, v] of TEMPLATE_VARS) {
            assert.doesNotMatch(k, /token|secret|password|key|dpop|session|credential|auth|jwt/i);
            assert.doesNotMatch(v, /^(at|rt)-|eyJ/);
        }
    });

    it("the entry point declares no template variable beyond that list", () => {
        const src = readFileSync(fileURLToPath(new URL("../mount-index.ts", import.meta.url)), "utf8");
        const declared = [...src.matchAll(/^declare const (\w+)\s*:/gm)].map((m) => m[1]);
        assert.deepEqual(declared, TEMPLATE_VARS.map(([k]) => k));
    });
});

describe("sealed box (executor sealed_box.rs format)", () => {
    it("seals to the agent DID; only the agent opens it; every box is fresh", async () => {
        const agent = new FakeAgent();
        const a = await sealToDid(agent.did, "secret-plaintext-é", testCrypto);
        const b = await sealToDid(agent.did, "secret-plaintext-é", testCrypto);
        assert.notEqual(a.ephemeralPublicKey, b.ephemeralPublicKey);
        assert.notEqual(a.nonce, b.nonce);
        assert.equal(Buffer.from(await agent.openSealed(a), "hex").toString(), "secret-plaintext-é");
        assert.ok(!JSON.stringify(a).includes("secret-plaintext"));
        await assert.rejects(new FakeAgent().openSealed(a), "another agent cannot open it");
        const tampered = { ...a, ciphertext: (a.ciphertext[0] === "0" ? "1" : "0") + a.ciphertext.slice(1) };
        await assert.rejects(agent.openSealed(tampered));
    });

    it("the X25519 key from the did:key equals the one derived from the agent's secret", () => {
        const agent = new FakeAgent();
        assert.deepEqual(x25519PublicOfDidKey(agent.did), agent.x25519PublicKey());
    });

    it("refuses DIDs that are not Ed25519 did:keys", async () => {
        for (const did of ["did:plc:alice2222222222222222222", "did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme", "did:key:z6Mk"]) {
            await assert.rejects(sealToDid(did, "x", testCrypto), /did:key/, did);
        }
    });
});
