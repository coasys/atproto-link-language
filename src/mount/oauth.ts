/**
 * atproto OAuth client for explicit publication (slice 2).
 *
 * Profile (atproto.com/specs/oauth): discovery from the account DID (DID
 * document -> PDS -> protected-resource metadata -> authorization server
 * metadata), PAR only, PKCE S256, DPoP ES256 with server nonces, `iss` in
 * the callback, and account checks on the token (`sub` is the requested
 * account and that account's PDS names this issuer). Scope: `atproto` plus
 * the granular `repo:app.bsky.feed.post?action=create` — create posts, and
 * nothing else (no delete, no other collection).
 *
 * Client: the atproto loopback client (`http://localhost?redirect_uri=…&scope=…`,
 * a public client). It needs no client metadata document and is meant for
 * development; a deployed client needs an https client_id with metadata
 * (REPORT, Limits). The redirect target is `http://127.0.0.1/callback`: the
 * app that opens the authorization URL hands the callback URL it receives
 * back through `completeAuthorization`. Nothing listens on it here.
 *
 * Credentials (tokens, the DPoP private key, the PKCE verifier) live only
 * in the vault (sealed to the executor agent), and in memory for one
 * request. No message built here contains one: server error texts are cut
 * to their `error` / `error_description` fields.
 */

import type { WebCrypto } from "./webcrypto.js";

import type { Transport } from "../adapters.js";
import { randomB64u, sha256B64u } from "./bytes.js";
import { DpopKey, DpopNonces, dpopRequest, withDeadline, type HttpResult } from "./dpop.js";
import { requireScheme, resolveDid, type ReaderConfig } from "./reader.js";
import type { CredentialVault, Session } from "./vault.js";

export const OAUTH_SCOPE = "atproto repo:app.bsky.feed.post?action=create";
export const REQUIRED_SCOPES = OAUTH_SCOPE.split(" ");
export const REDIRECT_URI = "http://127.0.0.1/callback";
export const CLIENT_ID = `http://localhost?${new URLSearchParams({ redirect_uri: REDIRECT_URI, scope: OAUTH_SCOPE })}`;

/** refresh this long before the access token expires */
const REFRESH_SKEW_MS = 30_000;
/** a pending authorization older than this is refused */
const PENDING_TTL_MS = 15 * 60_000;

export class OAuthError extends Error {}

export interface OAuthOptions extends ReaderConfig {
    transport: Transport;
    crypto: WebCrypto;
    vault: CredentialVault;
    nonces?: DpopNonces;
    now?: () => Date;
}

interface AuthServer {
    issuer: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    parEndpoint: string;
    revocationEndpoint?: string;
}

/** Error identifiers a server may answer that we repeat; anything else —
 *  and every description or message — is server prose and is never
 *  quoted: a server can put a secret it received or issued into any field
 *  (round 2, item 1). OAuth (RFC 6749/9126/9449) and atproto XRPC names. */
const KNOWN_ERRORS = new Set([
    "invalid_request", "invalid_client", "invalid_grant", "unauthorized_client", "unsupported_grant_type",
    "invalid_scope", "access_denied", "unsupported_response_type", "server_error", "temporarily_unavailable",
    "invalid_request_uri", "invalid_request_object", "invalid_dpop_proof", "use_dpop_nonce", "invalid_token",
    "insufficient_scope", "invalid_client_metadata", "invalid_redirect_uri", "invalid_authorization_details",
    "consent_required", "login_required", "interaction_required", "account_selection_required",
    "InvalidRequest", "InternalServerError", "AuthenticationRequired", "AuthMissing", "InvalidToken",
    "ExpiredToken", "ScopeMissingError", "RateLimitExceeded", "RecordNotFound", "RepoNotFound", "InvalidSwap",
    "AccountDeactivated", "AccountTakedown", "MethodNotImplemented", "UpstreamFailure", "UpstreamTimeout",
    "NotEnoughResources", "PayloadTooLarge", "Forbidden", "NotFound",
]);

export function knownError(v: unknown): string {
    return typeof v === "string" && KNOWN_ERRORS.has(v) ? v : "(unrecognized error)";
}

/** A server's error reply as `<status> <known error identifier>` — never
 *  its prose. */
export function serverError(r: HttpResult): string {
    try {
        const j = JSON.parse(r.body);
        if (j && typeof j === "object" && "error" in j) return `${r.status} ${knownError(j.error)}`;
    } catch {
        // not JSON: the status alone
    }
    return String(r.status);
}

export class OAuthClient {
    readonly nonces: DpopNonces;
    private readonly now: () => Date;

    constructor(private readonly opts: OAuthOptions) {
        this.nonces = opts.nonces ?? new DpopNonces();
        this.now = opts.now ?? (() => new Date());
    }

    private get timeout(): number {
        return this.opts.timeoutMs ?? 10_000;
    }

    private async getJson(url: string, what: string): Promise<any> {
        const r = await withDeadline(this.opts.transport.fetch(url, "GET", { accept: "application/json" }, ""), this.timeout, `GET ${what}`);
        if (r.status < 200 || r.status > 299) throw new OAuthError(`no ${what} at ${url} (${r.status})`);
        try {
            return JSON.parse(String(r.body));
        } catch {
            throw new OAuthError(`${what} at ${url} is not JSON`);
        }
    }

    /** DID -> PDS -> the authorization server its protected-resource
     *  metadata names. */
    private async authServerOf(account: string): Promise<{ pds: string; as: string }> {
        let pds: string;
        try {
            pds = (await resolveDid(account, this.opts.transport, this.opts)).pds;
        } catch {
            // fixed text: the DID document is server data
            throw new OAuthError(`cannot resolve ${account} to a PDS (DID document missing, naming another id, or without a valid #atproto_pds)`);
        }
        const origin = new URL(pds).origin;
        const prm = await this.getJson(`${origin}/.well-known/oauth-protected-resource`, "OAuth protected-resource metadata");
        if (prm?.resource !== origin && prm?.resource !== pds) {
            throw new OAuthError(`protected-resource metadata of ${origin} names another resource`);
        }
        const as = Array.isArray(prm.authorization_servers) ? prm.authorization_servers[0] : undefined;
        if (typeof as !== "string" || !as) throw new OAuthError(`${origin} names no authorization server`);
        try {
            requireScheme(as, this.opts, "authorization server");
            new URL(as);
        } catch {
            throw new OAuthError(`${origin} names an authorization server that is not an allowed URL`);
        }
        return { pds, as };
    }

    private async metadata(as: string): Promise<AuthServer> {
        const m = await this.getJson(`${new URL(as).origin}/.well-known/oauth-authorization-server`, "OAuth authorization-server metadata");
        if (m?.issuer !== as) throw new OAuthError(`authorization server metadata names another issuer than ${as}`);
        const origin = new URL(as).origin;
        const endpoint = (k: string, what: string, required = true): string | undefined => {
            const v = m[k];
            if (v === undefined && !required) return undefined;
            if (typeof v !== "string") throw new OAuthError(`authorization server ${as} has no ${what} endpoint`);
            let u: URL;
            try {
                u = new URL(v);
            } catch {
                throw new OAuthError(`${what} endpoint of ${as} is not a URL`);
            }
            if (u.origin !== origin) throw new OAuthError(`${what} endpoint is not on the issuer's origin ${origin}`);
            return v;
        };
        const parEndpoint = endpoint("pushed_authorization_request_endpoint", "PAR")!;
        const has = (k: string, v: string) => Array.isArray(m[k]) && m[k].includes(v);
        if (!has("code_challenge_methods_supported", "S256")) throw new OAuthError(`${as} does not support PKCE S256`);
        if (!has("dpop_signing_alg_values_supported", "ES256")) throw new OAuthError(`${as} does not support DPoP ES256`);
        if (!has("scopes_supported", "atproto")) throw new OAuthError(`${as} does not support the atproto scope`);
        if (m.authorization_response_iss_parameter_supported !== true) throw new OAuthError(`${as} does not send iss in its authorization responses`);
        return {
            issuer: as,
            authorizationEndpoint: endpoint("authorization_endpoint", "authorization")!,
            tokenEndpoint: endpoint("token_endpoint", "token")!,
            parEndpoint,
            revocationEndpoint: endpoint("revocation_endpoint", "revocation", false),
        };
    }

    private async formPost(url: string, key: DpopKey, form: Record<string, string>, what: string): Promise<HttpResult> {
        return dpopRequest(this.opts.transport, this.nonces, key, {
            url, method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
            body: new URLSearchParams(form).toString(),
        }, this.timeout, what);
    }

    /** Start an authorization for `account`: discovery, a fresh DPoP key,
     *  PKCE, PAR. Returns the URL to open; secrets stay sealed. */
    async begin(account: string): Promise<{ account: string; authorizeUrl: string; state: string; issuer: string; expiresIn: number }> {
        const { pds, as } = await this.authServerOf(account);
        const meta = await this.metadata(as);
        const key = await DpopKey.generate(this.opts.crypto);
        const verifier = randomB64u(this.opts.crypto, 32);
        const state = randomB64u(this.opts.crypto, 16);
        const r = await this.formPost(meta.parEndpoint, key, {
            client_id: CLIENT_ID,
            response_type: "code",
            redirect_uri: REDIRECT_URI,
            scope: OAUTH_SCOPE,
            state,
            code_challenge: await sha256B64u(this.opts.crypto, verifier),
            code_challenge_method: "S256",
            login_hint: account,
        }, "PAR");
        let par: any = null;
        try {
            par = JSON.parse(r.body);
        } catch {
            // handled below
        }
        if ((r.status !== 201 && r.status !== 200) || typeof par?.request_uri !== "string") {
            throw new OAuthError(`PAR refused: ${serverError(r)}`);
        }
        await this.opts.vault.putPending({
            account, state, issuer: meta.issuer, pds, tokenEndpoint: meta.tokenEndpoint,
            revocationEndpoint: meta.revocationEndpoint, clientId: CLIENT_ID, redirectUri: REDIRECT_URI,
            verifier, dpopJwk: key.privateJwk(), createdAt: this.now().getTime(),
        });
        const url = new URL(meta.authorizationEndpoint);
        url.searchParams.set("client_id", CLIENT_ID);
        url.searchParams.set("request_uri", par.request_uri);
        return { account, authorizeUrl: url.href, state, issuer: meta.issuer, expiresIn: typeof par.expires_in === "number" ? par.expires_in : 0 };
    }

    /** Check a token response for `account` and turn it into a session. */
    private sessionFrom(r: HttpResult, account: string, base: Omit<Session, "accessToken" | "refreshToken" | "expiresAt" | "scope">, what: string): Session {
        let t: any = null;
        try {
            t = JSON.parse(r.body);
        } catch {
            // handled below
        }
        // Fixed texts only: every field of this answer is server-supplied.
        if (r.status !== 200 || typeof t?.access_token !== "string") throw new OAuthError(`${what} refused: ${serverError(r)}`);
        if (typeof t.token_type !== "string" || t.token_type.toLowerCase() !== "dpop") {
            throw new OAuthError(`${what}: the token type is not DPoP`);
        }
        if (t.sub !== account) throw new OAuthError(`${what}: the token sub is not the requested account ${account}`);
        const granted = typeof t.scope === "string" ? t.scope.split(" ") : [];
        const missing = REQUIRED_SCOPES.filter((s) => !granted.includes(s));
        if (missing.length) throw new OAuthError(`${what}: granted scope lacks ${missing.join(" ")}`);
        const ttl = typeof t.expires_in === "number" && t.expires_in > 0 ? t.expires_in * 1000 : 60_000;
        return {
            ...base,
            scope: t.scope,
            accessToken: t.access_token,
            ...(typeof t.refresh_token === "string" ? { refreshToken: t.refresh_token } : {}),
            expiresAt: this.now().getTime() + ttl,
        };
    }

    /** Revoke tokens of a response we will not keep (best effort). */
    private async discard(r: HttpResult, revocationEndpoint?: string): Promise<void> {
        if (!revocationEndpoint) return;
        let t: any;
        try {
            t = JSON.parse(r.body);
        } catch {
            return;
        }
        for (const token of [t?.refresh_token, t?.access_token]) {
            if (typeof token !== "string") continue;
            try {
                await withDeadline(this.opts.transport.fetch(revocationEndpoint, "POST", { "content-type": "application/x-www-form-urlencoded" },
                    new URLSearchParams({ token, client_id: CLIENT_ID }).toString()), this.timeout, "revoke");
            } catch {
                // best effort
            }
        }
    }

    /** Finish an authorization from the callback URL the browser reached. */
    async complete(callbackUrl: string): Promise<{ account: string; scope: string; issuer: string; expiresAt: number }> {
        let cb: URL;
        try {
            cb = new URL(callbackUrl);
        } catch {
            throw new OAuthError("callbackUrl is not a URL");
        }
        if (`${cb.origin}${cb.pathname}` !== REDIRECT_URI) throw new OAuthError(`callbackUrl is not ${REDIRECT_URI}`);
        if (cb.username || cb.password || cb.hash) throw new OAuthError("callbackUrl carries userinfo or a fragment");
        for (const k of ["state", "iss", "code", "error"]) {
            if (cb.searchParams.getAll(k).length > 1) throw new OAuthError(`callbackUrl repeats ${k}`);
        }
        const state = cb.searchParams.get("state") ?? "";
        const pending = state ? await this.opts.vault.takePending(state) : null;
        if (!pending) throw new OAuthError("unknown or already used authorization state");
        if (this.now().getTime() - pending.createdAt > PENDING_TTL_MS) throw new OAuthError("authorization state expired; authorize again");
        const err = cb.searchParams.get("error");
        if (err) throw new OAuthError(`authorization refused: ${knownError(err)}`);
        if (cb.searchParams.get("iss") !== pending.issuer) throw new OAuthError(`callback iss is not the issuer ${pending.issuer}`);
        const code = cb.searchParams.get("code");
        if (!code) throw new OAuthError("callback has no code");
        const key = await DpopKey.fromJwk(pending.dpopJwk, this.opts.crypto);
        const r = await this.formPost(pending.tokenEndpoint, key, {
            grant_type: "authorization_code", code, redirect_uri: pending.redirectUri,
            code_verifier: pending.verifier, client_id: pending.clientId,
        }, "token request");
        let session: Session;
        try {
            session = this.sessionFrom(r, pending.account, {
                account: pending.account, issuer: pending.issuer, pds: pending.pds, tokenEndpoint: pending.tokenEndpoint,
                revocationEndpoint: pending.revocationEndpoint, clientId: pending.clientId, dpopJwk: pending.dpopJwk,
            }, "token request");
            // account check: the account's PDS must name this issuer now
            const now = await this.authServerOf(pending.account);
            if (now.as !== pending.issuer) {
                throw new OAuthError(`${pending.account}'s PDS names another authorization server than the issuer ${pending.issuer}`);
            }
            session.pds = now.pds;
        } catch (e) {
            await this.discard(r, pending.revocationEndpoint);
            throw e;
        }
        await this.opts.vault.putSession(session);
        return { account: session.account, scope: session.scope, issuer: session.issuer, expiresAt: session.expiresAt };
    }

    hasSession(account: string): boolean {
        return this.opts.vault.hasSession(account);
    }

    /** The session for `account` with its DPoP key, refreshed first when the
     *  access token is (about to be) expired. */
    async access(account: string): Promise<{ session: Session; key: DpopKey }> {
        let session = await this.opts.vault.getSession(account);
        if (!session) throw new OAuthError(`${account} is not authorized for this executor user: run authorize first`);
        const key = await DpopKey.fromJwk(session.dpopJwk, this.opts.crypto);
        if (this.now().getTime() >= session.expiresAt - REFRESH_SKEW_MS) {
            if (!session.refreshToken) {
                this.opts.vault.deleteSession(account);
                throw new OAuthError(`${account}: the session expired and has no refresh token: authorize again (not authorized)`);
            }
            const r = await this.formPost(session.tokenEndpoint, key, {
                grant_type: "refresh_token", refresh_token: session.refreshToken, client_id: session.clientId,
            }, "token refresh");
            if (r.status === 400 && /invalid_grant/.test(r.body)) {
                this.opts.vault.deleteSession(account);
                throw new OAuthError(`${account}: the refresh token was refused: authorize again (not authorized)`);
            }
            const { accessToken: _a, refreshToken: oldRefresh, expiresAt: _e, scope: _s, ...base } = session;
            let next: Session;
            try {
                next = this.sessionFrom(r, account, base, "token refresh");
            } catch (e) {
                // A 200 we refuse spent the old refresh token (rotation):
                // revoke what came back and require a new authorization.
                // Any other answer keeps the session for a later retry.
                if (r.status !== 200) throw e;
                await this.discard(r, session.revocationEndpoint);
                this.opts.vault.deleteSession(account);
                throw new OAuthError(`${(e as Error).message} (not authorized: authorize again)`);
            }
            // no new refresh token issued: the previous one stays valid
            session = next.refreshToken ? next : { ...next, ...(oldRefresh ? { refreshToken: oldRefresh } : {}) };
            await this.opts.vault.putSession(session);
        }
        return { session, key };
    }

    /** A DPoP-bound request to the account's PDS. */
    resourceRequest(account: { session: Session; key: DpopKey }, url: string, method: string, body: string, timeoutMs: number, what: string): Promise<HttpResult> {
        return dpopRequest(this.opts.transport, this.nonces, account.key, {
            url, method, headers: { "content-type": "application/json", accept: "application/json" }, body,
            accessToken: account.session.accessToken,
        }, timeoutMs, what);
    }

    async sessions(): Promise<Array<{ account: string; scope: string; issuer: string; expiresAt: number }>> {
        const out = [];
        for (const account of this.opts.vault.accounts()) {
            const s = await this.opts.vault.getSession(account);
            if (s) out.push({ account: s.account, scope: s.scope, issuer: s.issuer, expiresAt: s.expiresAt });
        }
        return out;
    }

    /** Revoke the account's tokens (best effort) and forget the session. */
    async signOut(account: string): Promise<{ account: string; signedOut: boolean }> {
        const s = await this.opts.vault.getSession(account);
        if (!s) return { account, signedOut: false };
        if (s.revocationEndpoint) {
            for (const token of [s.refreshToken, s.accessToken]) {
                if (!token) continue;
                try {
                    await withDeadline(this.opts.transport.fetch(s.revocationEndpoint, "POST", { "content-type": "application/x-www-form-urlencoded" },
                        new URLSearchParams({ token, client_id: s.clientId }).toString()), this.timeout, "revoke");
                } catch {
                    // best effort: the session is forgotten either way
                }
            }
        }
        this.opts.vault.deleteSession(account);
        return { account, signedOut: true };
    }
}
