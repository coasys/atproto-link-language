/**
 * Write-side fixtures for slice 2: an in-memory atproto OAuth authorization
 * server and a writable PDS on top of the reader's FakeNet, plus a fake
 * executor agent that opens sealed boxes, all behind the injectable
 * `Transport`.
 *
 * The fake AS follows the atproto OAuth profile as the local PDS 0.5.61
 * serves it (probed, see REPORT): protected-resource and AS metadata, PAR
 * only, PKCE S256, DPoP ES256 with server nonces (AS: 400 use_dpop_nonce;
 * RS: 401 + WWW-Authenticate), DPoP-bound tokens checked by jkt and `ath`,
 * granular `repo:<collection>?action=create` scope, refresh-token rotation.
 * A second createRecord at an existing rkey is refused with 500, as the
 * real PDS does.
 *
 * `approve()` / `deny()` stand in for the person at the authorization page.
 * Write faults: `commitThenHang` (the record is written, the reply never
 * comes: an uncertain create), `commitThen500`, `hangBeforeCommit`,
 * `statusBeforeCommit`.
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, webcrypto } from "node:crypto";

import type { TransportResponse } from "../src/adapters.js";
import { FakeNet, PDS, POST, ALICE, BOB, standardNet, tidOf } from "./mount-fixtures.js";

export const subtle = webcrypto.subtle as unknown as SubtleCrypto;
export const testCrypto = webcrypto as unknown as Crypto;

const b64u = (b: Uint8Array | ArrayBuffer) => Buffer.from(b as ArrayBuffer).toString("base64url");
const unb64u = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
const sha256b64u = (s: string) => createHash("sha256").update(s).digest("base64url");
const rand = (n = 12) => Buffer.from(webcrypto.getRandomValues(new Uint8Array(n))).toString("hex");

// ---- fake executor agent (did:key Ed25519, opens sealed boxes) --------------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(bytes: Uint8Array): string {
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

export interface SealedBoxJson {
    ephemeralPublicKey: string;
    nonce: string;
    ciphertext: string;
}

/** An executor agent as the language sees it: its DID and `openSealed`
 *  (hex plaintext, like `agentOpenSealed`). Opening follows the executor's
 *  `agent/sealed_box.rs` with Node's own X25519 — independent of the
 *  language's Ed25519 -> X25519 conversion, which it therefore checks. */
export class FakeAgent {
    readonly did: string;
    private readonly x25519Pkcs8: Buffer;
    private readonly x25519Public: Uint8Array;
    opened = 0;

    constructor() {
        const { privateKey, publicKey } = generateKeyPairSync("ed25519");
        const seed = Buffer.from(privateKey.export({ format: "jwk" }).d!, "base64url");
        const pub = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
        this.did = "did:key:z" + base58(new Uint8Array([0xed, 0x01, ...pub]));
        // libsodium crypto_sign_ed25519_sk_to_curve25519: clamp(sha512(seed)[..32])
        const h = createHash("sha512").update(seed).digest().subarray(0, 32);
        h[0] &= 248;
        h[31] &= 127;
        h[31] |= 64;
        this.x25519Pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), h]);
        const spki = createPublicKey(createPrivateKey({ key: this.x25519Pkcs8, format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" });
        this.x25519Public = new Uint8Array(spki.subarray(spki.length - 32));
    }

    /** the X25519 public key derived from the agent's secret (not from its DID) */
    x25519PublicKey(): Uint8Array {
        return this.x25519Public;
    }

    async openSealed(box: SealedBoxJson): Promise<string> {
        this.opened += 1;
        const eph = Buffer.from(box.ephemeralPublicKey, "hex");
        const priv = await subtle.importKey("pkcs8", this.x25519Pkcs8, { name: "X25519" }, false, ["deriveBits"]);
        const pub = await subtle.importKey("raw", eph, { name: "X25519" }, false, []);
        const shared = new Uint8Array(await subtle.deriveBits({ name: "X25519", public: pub } as any, priv, 256));
        if (shared.every((b) => b === 0)) throw new Error("low-order key");
        const salt = new Uint8Array([...eph, ...this.x25519Public]);
        const hk = await subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
        const key = await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("ad4m:sealed-box:v1") }, hk, 256);
        const aes = await subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
        const pt = await subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(box.nonce, "hex") }, aes, Buffer.from(box.ciphertext, "hex"));
        return Buffer.from(pt).toString("hex");
    }
}

// ---- a recording, failable in-memory storage --------------------------------

export class MemStorage {
    map = new Map<string, string>();
    get(k: string): string | null {
        return this.map.get(k) ?? null;
    }
    put(k: string, v: string): void {
        this.map.set(k, v);
    }
    delete(k: string): void {
        this.map.delete(k);
    }
    /** every stored key and value as one string, for secret scans */
    dump(): string {
        return [...this.map].map(([k, v]) => `${k}=${v}`).join("\n");
    }
}

// ---- fake OAuth AS + writable PDS ------------------------------------------

export const SCOPE = "atproto repo:app.bsky.feed.post?action=create";
export const ISSUER = PDS;

interface Par {
    clientId: string;
    redirectUri: string;
    scope: string;
    state: string;
    challenge: string;
    jkt: string;
    loginHint?: string;
}
interface Grant {
    sub: string;
    scope: string;
    jkt: string;
    exp: number;
    refresh?: string;
}

export type WriteFault =
    | { kind: "commitThenHang"; once?: boolean }
    | { kind: "commitThen500"; once?: boolean }
    | { kind: "hangBeforeCommit"; once?: boolean }
    | { kind: "statusBeforeCommit"; status: number; once?: boolean };

export interface WriteRequest {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string;
}

export class FakeWriteNet extends FakeNet {
    /** what the AS advertises; tests mutate it to break discovery */
    asMeta: Record<string, unknown> = {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth/authorize`,
        token_endpoint: `${ISSUER}/oauth/token`,
        revocation_endpoint: `${ISSUER}/oauth/revoke`,
        pushed_authorization_request_endpoint: `${ISSUER}/oauth/par`,
        require_pushed_authorization_requests: true,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        dpop_signing_alg_values_supported: ["ES256", "ES256K"],
        token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
        scopes_supported: ["atproto", "transition:generic"],
        authorization_response_iss_parameter_supported: true,
        client_id_metadata_document_supported: true,
    };
    /** pds origin -> protected-resource metadata */
    prm = new Map<string, Record<string, unknown>>([[PDS, { resource: PDS, authorization_servers: [ISSUER] }]]);
    /** every request, method + url + headers + body, in order */
    requestsLog: WriteRequest[] = [];
    writeFaults: WriteFault[] = [];
    /** token endpoint overrides: a test can make the AS answer a wrong sub etc. */
    /** token answer overrides; a function sees what was just issued and the request form */
    tokenOverride: Partial<Record<string, unknown>> | ((issued: { access_token: string; refresh_token: string }, form: URLSearchParams) => Record<string, unknown>) | null = null;
    accessTtlMs = 3600_000;
    nowMs = () => Date.now();
    asNonce = "as-nonce-1";
    rsNonce = "rs-nonce-1";
    readonly pars = new Map<string, Par>();
    readonly codes = new Map<string, { par: Par; sub: string }>();
    readonly access = new Map<string, Grant>();
    readonly refresh = new Map<string, Grant>();
    /** every access and refresh token ever issued (secret scans) */
    readonly issued: string[] = [];
    /** every DPoP public JWK seen in a proof (its private half must stay sealed) */
    readonly dpopKeys = new Map<string, JsonWebKey>();
    private commitCounter = 0;

    writes(): WriteRequest[] {
        return this.requestsLog.filter((r) => r.method === "POST" && r.url.includes("/xrpc/com.atproto.repo.createRecord"));
    }
    lists(collection = POST): WriteRequest[] {
        return this.requestsLog.filter((r) => r.url.includes("/xrpc/com.atproto.repo.listRecords") && r.url.includes(`collection=${encodeURIComponent(collection)}`));
    }
    /** the index in `requestsLog` of each matching request */
    indexes(pred: (r: WriteRequest) => boolean): number[] {
        return this.requestsLog.flatMap((r, i) => (pred(r) ? [i] : []));
    }

    async fetch(url: string, method: string, headers: Record<string, string>, body: string): Promise<TransportResponse> {
        const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
        this.requestsLog.push({ method, url, headers: h, body });
        const u = new URL(url);
        if (u.pathname === "/.well-known/oauth-protected-resource") {
            this.log.push(url);
            const m = this.prm.get(u.origin);
            return m ? json(200, m) : json(404, { error: "NotFound" });
        }
        if (u.pathname === "/.well-known/oauth-authorization-server") {
            this.log.push(url);
            return u.origin === ISSUER ? json(200, this.asMeta) : json(404, { error: "NotFound" });
        }
        if (u.origin === ISSUER && u.pathname.startsWith("/oauth/")) {
            this.log.push(url);
            return this.oauth(u, method, h, body);
        }
        if (method === "POST" && u.pathname === "/xrpc/com.atproto.repo.createRecord") {
            this.log.push(url);
            return this.createRecord(u, h, body);
        }
        return super.fetch(url, method, headers, body);
    }

    // -- the person at the authorization page --

    /** Approve the authorization request in `authorizeUrl` as `did`; returns
     *  the callback URL the browser would be sent to. */
    approve(authorizeUrl: string, did: string, opts: { iss?: string; state?: string } = {}): string {
        const u = new URL(authorizeUrl);
        const par = this.pars.get(u.searchParams.get("request_uri") ?? "");
        if (!par) throw new Error("approve: unknown request_uri");
        if (u.searchParams.get("client_id") !== par.clientId) throw new Error("approve: client_id mismatch");
        const code = "code-" + rand();
        this.codes.set(code, { par, sub: did });
        this.pars.delete(u.searchParams.get("request_uri")!);
        const cb = new URL(par.redirectUri);
        cb.searchParams.set("state", opts.state ?? par.state);
        cb.searchParams.set("iss", opts.iss ?? ISSUER);
        cb.searchParams.set("code", code);
        return cb.href;
    }

    deny(authorizeUrl: string): string {
        const u = new URL(authorizeUrl);
        const par = this.pars.get(u.searchParams.get("request_uri") ?? "")!;
        const cb = new URL(par.redirectUri);
        cb.searchParams.set("state", par.state);
        cb.searchParams.set("iss", ISSUER);
        cb.searchParams.set("error", "access_denied");
        return cb.href;
    }

    // -- DPoP --

    private async verifyDpop(h: Record<string, string>, method: string, url: string, nonce: string, accessToken?: string): Promise<{ jkt: string } | { error: string; nonce?: true }> {
        const proof = h["dpop"];
        if (!proof) return { error: "missing DPoP proof" };
        const [hb, pb, sb] = proof.split(".");
        const header = JSON.parse(Buffer.from(hb, "base64url").toString());
        const payload = JSON.parse(Buffer.from(pb, "base64url").toString());
        if (header.typ !== "dpop+jwt" || header.alg !== "ES256" || !header.jwk || header.jwk.d) return { error: "bad DPoP header" };
        const key = await subtle.importKey("jwk", header.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
        const ok = await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, unb64u(sb), new TextEncoder().encode(`${hb}.${pb}`));
        if (!ok) return { error: "bad DPoP signature" };
        const htu = new URL(url);
        htu.search = "";
        htu.hash = "";
        if (payload.htm !== method || payload.htu !== htu.href) return { error: `DPoP htm/htu mismatch: ${payload.htm} ${payload.htu}` };
        if (typeof payload.jti !== "string" || typeof payload.iat !== "number") return { error: "DPoP jti/iat" };
        if (accessToken !== undefined && payload.ath !== sha256b64u(accessToken)) return { error: "DPoP ath mismatch" };
        const { crv, kty, x, y } = header.jwk;
        const jkt = sha256b64u(JSON.stringify({ crv, kty, x, y }));
        this.dpopKeys.set(jkt, header.jwk);
        if (payload.nonce !== nonce) return { error: "use_dpop_nonce", nonce: true };
        return { jkt };
    }

    // -- AS endpoints --

    private async oauth(u: URL, method: string, h: Record<string, string>, body: string): Promise<TransportResponse> {
        if (method !== "POST") return json(405, { error: "invalid_request" });
        const form = new URLSearchParams(body);
        const asNonceHeader = { "dpop-nonce": this.asNonce };
        if (u.pathname === "/oauth/revoke") {
            const t = form.get("token") ?? "";
            this.access.delete(t);
            this.refresh.delete(t);
            return json(200, {});
        }
        const dp = await this.verifyDpop(h, "POST", u.href, this.asNonce);
        if ("error" in dp) {
            return json(400, { error: dp.nonce ? "use_dpop_nonce" : "invalid_dpop_proof", error_description: dp.error }, asNonceHeader);
        }
        if (u.pathname === "/oauth/par") {
            const clientId = form.get("client_id") ?? "";
            let cid: URL;
            try {
                cid = new URL(clientId);
            } catch {
                return json(400, { error: "invalid_client" }, asNonceHeader);
            }
            const redirect = form.get("redirect_uri") ?? "";
            const scope = form.get("scope") ?? "";
            if (cid.origin !== "http://localhost" || !cid.searchParams.getAll("redirect_uri").includes(redirect)) {
                return json(400, { error: "invalid_client", error_description: "loopback client / redirect_uri" }, asNonceHeader);
            }
            if (!scope.split(" ").includes("atproto") || scope !== (cid.searchParams.get("scope") ?? "atproto")) {
                return json(400, { error: "invalid_scope" }, asNonceHeader);
            }
            if (form.get("code_challenge_method") !== "S256" || !form.get("code_challenge")) return json(400, { error: "invalid_request", error_description: "PKCE S256 required" }, asNonceHeader);
            if (form.get("response_type") !== "code" || !form.get("state")) return json(400, { error: "invalid_request" }, asNonceHeader);
            const requestUri = "urn:ietf:params:oauth:request_uri:req-" + rand();
            this.pars.set(requestUri, {
                clientId, redirectUri: redirect, scope, state: form.get("state")!, challenge: form.get("code_challenge")!,
                jkt: dp.jkt, loginHint: form.get("login_hint") ?? undefined,
            });
            return json(201, { request_uri: requestUri, expires_in: 299 }, asNonceHeader);
        }
        if (u.pathname === "/oauth/token") {
            const grant = form.get("grant_type");
            if (grant === "authorization_code") {
                const c = this.codes.get(form.get("code") ?? "");
                if (!c) return json(400, { error: "invalid_grant" }, asNonceHeader);
                this.codes.delete(form.get("code")!);
                if (c.par.clientId !== form.get("client_id") || c.par.redirectUri !== form.get("redirect_uri")) return json(400, { error: "invalid_grant" }, asNonceHeader);
                if (sha256b64u(form.get("code_verifier") ?? "") !== c.par.challenge) return json(400, { error: "invalid_grant", error_description: "PKCE verifier" }, asNonceHeader);
                if (dp.jkt !== c.par.jkt) return json(400, { error: "invalid_dpop_key_binding" }, asNonceHeader);
                return json(200, this.issue(c.sub, c.par.scope, dp.jkt, form), asNonceHeader);
            }
            if (grant === "refresh_token") {
                const rt = form.get("refresh_token") ?? "";
                const g = this.refresh.get(rt);
                if (!g || g.jkt !== dp.jkt) return json(400, { error: "invalid_grant" }, asNonceHeader);
                this.refresh.delete(rt); // rotation: one use
                return json(200, this.issue(g.sub, g.scope, dp.jkt, form), asNonceHeader);
            }
            return json(400, { error: "unsupported_grant_type" }, asNonceHeader);
        }
        return json(404, { error: "not_found" });
    }

    private issue(sub: string, scope: string, jkt: string, form: URLSearchParams) {
        const at = "at-" + rand(24);
        const rt = "rt-" + rand(24);
        const g: Grant = { sub, scope, jkt, exp: this.nowMs() + this.accessTtlMs, refresh: rt };
        this.access.set(at, g);
        this.refresh.set(rt, g);
        this.issued.push(at, rt);
        return {
            access_token: at, token_type: "DPoP", refresh_token: rt, scope, sub,
            expires_in: Math.floor(this.accessTtlMs / 1000),
            ...(typeof this.tokenOverride === "function" ? this.tokenOverride({ access_token: at, refresh_token: rt }, form) : this.tokenOverride ?? {}),
        };
    }

    // -- PDS write --

    private async createRecord(u: URL, h: Record<string, string>, body: string): Promise<TransportResponse> {
        const rsNonceHeaders = { "dpop-nonce": this.rsNonce };
        const auth = h["authorization"] ?? "";
        if (!auth.startsWith("DPoP ")) return json(401, { error: "AuthenticationRequired" }, rsNonceHeaders);
        const at = auth.slice(5);
        const dp = await this.verifyDpop(h, "POST", u.href, this.rsNonce, at);
        if ("error" in dp) {
            if (dp.nonce) return json(401, { error: "use_dpop_nonce", message: "DPoP nonce mismatch" }, { ...rsNonceHeaders, "www-authenticate": 'DPoP error="use_dpop_nonce", error_description="DPoP nonce mismatch"' });
            return json(401, { error: "InvalidToken", message: dp.error }, rsNonceHeaders);
        }
        const g = this.access.get(at);
        if (!g || g.jkt !== dp.jkt) return json(401, { error: "InvalidToken" }, rsNonceHeaders);
        if (g.exp <= this.nowMs()) return json(401, { error: "InvalidToken", message: "exp" }, { ...rsNonceHeaders, "www-authenticate": 'DPoP error="invalid_token"' });
        const input = JSON.parse(body);
        if (input.repo !== g.sub) return json(401, { error: "AuthenticationRequired" }, rsNonceHeaders);
        if (!g.scope.split(" ").includes(`repo:${input.collection}?action=create`)) {
            return json(403, { error: "ScopeMissingError", message: `Missing required scope "repo:${input.collection}?action=create"` }, rsNonceHeaders);
        }
        const fault = this.writeFaults[0];
        if (fault && fault.once !== false) this.writeFaults.shift();
        if (fault?.kind === "hangBeforeCommit") return new Promise(() => {});
        if (fault?.kind === "statusBeforeCommit") return json(fault.status, { error: "Injected" }, rsNonceHeaders);
        const repo = this.repos.get(input.repo)!;
        const list = repo.collections.get(input.collection) ?? [];
        const rkey: string = input.rkey ?? tidOf(9000 + list.length);
        if (list.some((r) => r.rkey === rkey)) return json(500, { error: "InternalServerError", message: "Internal Server Error" }, rsNonceHeaders);
        this.commitCounter += 1;
        const cid = `bafyreipub${this.commitCounter}${rkey}`;
        this.put(input.repo, input.collection, rkey, JSON.stringify(input.record), cid);
        const out = { uri: `at://${input.repo}/${input.collection}/${rkey}`, cid, commit: { cid: repo.commitCid, rev: repo.rev }, validationStatus: "valid" };
        if (fault?.kind === "commitThenHang") return new Promise(() => {});
        if (fault?.kind === "commitThen500") return json(500, { error: "InternalServerError" }, rsNonceHeaders);
        return json(200, out, rsNonceHeaders);
    }

    /** posts in `did`'s repo whose text is `text` */
    postsWithText(did: string, text: string) {
        return (this.repos.get(did)?.collections.get(POST) ?? []).filter((r) => JSON.parse(r.value).text === text);
    }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): TransportResponse {
    return { status, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) };
}

/** The standard reader network with the OAuth AS and write endpoints. */
export function writeNet(): FakeWriteNet {
    const net = new FakeWriteNet();
    const std = standardNet();
    for (const [did, repo] of std.repos) net.repos.set(did, repo);
    for (const [did, doc] of std.didDocs) net.didDocs.set(did, doc);
    return net;
}

export { ALICE, BOB, PDS, POST };
