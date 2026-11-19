/**
 * DPoP (RFC 9449) for the atproto OAuth profile: an ES256 key per
 * (executor user, AT account), proofs bound to method + URL (+ `ath` for a
 * resource request), and the server-nonce dance.
 *
 * The one resend this module makes: a reply that is a DPoP nonce challenge
 * (`400 {"error":"use_dpop_nonce"}` from the AS, `401` with
 * `WWW-Authenticate: DPoP error="use_dpop_nonce"` from the PDS). The server
 * refuses such a request in its DPoP check, before any handler runs, so it
 * changed nothing; every other outcome is returned to the caller.
 */

import type { Jwk, Key, KeyPair, WebCrypto } from "./webcrypto.js";

import type { Transport } from "../adapters.js";
import { b64u, randomB64u, sha256B64u, utf8 } from "./bytes.js";

const ALG = { name: "ECDSA", namedCurve: "P-256" } as const;

export class DpopKey {
    private constructor(
        private readonly key: Key,
        private readonly jwk: Jwk,
        private readonly crypto: WebCrypto,
    ) {}

    static async generate(crypto: WebCrypto): Promise<DpopKey> {
        const pair = (await crypto.subtle.generateKey(ALG, true, ["sign", "verify"])) as KeyPair;
        const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
        return new DpopKey(pair.privateKey, jwk, crypto);
    }

    static async fromJwk(jwk: Jwk, crypto: WebCrypto): Promise<DpopKey> {
        const key = await crypto.subtle.importKey("jwk", jwk, ALG, false, ["sign"]);
        return new DpopKey(key, jwk, crypto);
    }

    /** The private JWK — only ever handed to the vault, which seals it. */
    privateJwk(): Jwk {
        return { ...this.jwk };
    }

    publicJwk(): { kty: string; crv: string; x: string; y: string } {
        return { kty: "EC", crv: "P-256", x: String(this.jwk.x), y: String(this.jwk.y) };
    }

    async proof(htm: string, url: string, nonce?: string, accessToken?: string): Promise<string> {
        const u = new URL(url);
        u.search = "";
        u.hash = "";
        const header = b64u(JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk: this.publicJwk() }));
        const payload = b64u(JSON.stringify({
            jti: randomB64u(this.crypto, 16),
            htm,
            htu: u.href,
            iat: Math.floor(Date.now() / 1000),
            ...(nonce ? { nonce } : {}),
            ...(accessToken !== undefined ? { ath: await sha256B64u(this.crypto, accessToken) } : {}),
        }));
        const sig = await this.crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.key, utf8(`${header}.${payload}`));
        return `${header}.${payload}.${b64u(sig)}`;
    }
}

export class TimeoutError extends Error {}

export function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const t = new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new TimeoutError(`${what} timed out after ${ms} ms`)), ms);
    });
    return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

export interface HttpResult {
    status: number;
    /** lower-cased names */
    headers: Record<string, string>;
    body: string;
}

function lower(h: Record<string, string> | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(h ?? {})) out[k.toLowerCase()] = String(v);
    return out;
}

function isNonceChallenge(r: HttpResult): boolean {
    if (r.status === 401 && /use_dpop_nonce/.test(r.headers["www-authenticate"] ?? "")) return true;
    if (r.status === 400 || r.status === 401) {
        try {
            return JSON.parse(r.body)?.error === "use_dpop_nonce";
        } catch {
            return false;
        }
    }
    return false;
}

/** Server nonces per origin, shared by every DPoP request of one language. */
export class DpopNonces {
    private readonly byOrigin = new Map<string, string>();
    get(url: string): string | undefined {
        return this.byOrigin.get(new URL(url).origin);
    }
    take(url: string, r: HttpResult): void {
        const n = r.headers["dpop-nonce"];
        if (n) this.byOrigin.set(new URL(url).origin, n);
    }
}

/** One DPoP request (plus at most one resend on a nonce challenge). A
 *  transport failure or the deadline rejects; a reply of any status
 *  resolves. */
export async function dpopRequest(
    transport: Transport,
    nonces: DpopNonces,
    key: DpopKey,
    req: { url: string; method: string; headers: Record<string, string>; body: string; accessToken?: string },
    timeoutMs: number,
    what: string,
): Promise<HttpResult> {
    let last: HttpResult | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        const headers: Record<string, string> = {
            ...req.headers,
            DPoP: await key.proof(req.method, req.url, nonces.get(req.url), req.accessToken),
        };
        if (req.accessToken !== undefined) headers.Authorization = `DPoP ${req.accessToken}`;
        const raw = await withDeadline(transport.fetch(req.url, req.method, headers, req.body), timeoutMs, what);
        last = { status: raw.status, headers: lower(raw.headers), body: String(raw.body ?? "") };
        const before = nonces.get(req.url);
        nonces.take(req.url, last);
        if (!(isNonceChallenge(last) && attempt === 0 && nonces.get(req.url) !== undefined && nonces.get(req.url) !== before)) break;
    }
    return last!;
}
