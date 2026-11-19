/**
 * The mounted language's behaviour, host-independent: the slice 1 reader
 * plus slice 2's explicit publication. `mount-index.ts` binds it to the
 * executor (httpFetch / fetch, host KV, agent sealing, signals).
 *
 * Interactions:
 *  - `<lang>://project`: refresh, status (read-only); authorize,
 *    completeAuthorization, sessions, signOut (OAuth; they write only to
 *    the authorization server, never to a repo).
 *  - `<lang>://class/ATPost`: publish — the ATPost constructor's `call`.
 *  - every record address: none. A model write to a mounted instance
 *    (annotation, setter) therefore never reaches a PDS.
 */

import type { WebCrypto } from "./webcrypto.js";

import type { Transport } from "../adapters.js";
import { DpopNonces } from "./dpop.js";
import type { MountEntry } from "./mapping.js";
import { CLIENT_ID, OAUTH_SCOPE, OAuthClient } from "./oauth.js";
import { Publisher, type CallDelta, type DurableFiles } from "./publisher.js";
import { mountShapes } from "./shapes.js";
import { MountedReader, diff, type RefreshReport } from "./state.js";
import { CredentialVault, type AgentAccess, type StorageLike } from "./vault.js";

export interface ServiceOptions {
    accounts: string[];
    plcUrl: string;
    appviewUrl: string;
    /** reads (and, in tests, every request) */
    transport: Transport;
    /** OAuth and PDS writes; needs response headers (DPoP-Nonce). Defaults to `transport`. */
    writeTransport?: Transport;
    storage: StorageLike;
    /** the language storage directory with the host's atomic write; without
     *  it publishing is refused (the ledger must be durable) */
    files?: DurableFiles;
    crypto: WebCrypto;
    agent: AgentAccess;
    languageAddress: () => string;
    timeoutMs?: number;
    writeTimeoutMs?: number;
    pageLimit?: number;
    maxPages?: number;
    allowHttp?: boolean;
    now?: () => Date;
}

export interface Interaction {
    name: string;
    label: string;
    execute(params: any): Promise<any>;
}

export class MountService {
    readonly reader: MountedReader;
    readonly vault: CredentialVault;
    readonly oauth: OAuthClient;
    readonly publisher: Publisher;

    constructor(private readonly opts: ServiceOptions) {
        const cfg = {
            plcUrl: opts.plcUrl,
            appviewUrl: opts.appviewUrl,
            timeoutMs: opts.timeoutMs,
            pageLimit: opts.pageLimit,
            maxPages: opts.maxPages,
            allowHttp: opts.allowHttp,
        };
        this.reader = new MountedReader({ ...cfg, accounts: opts.accounts, transport: opts.transport, storage: opts.storage, now: opts.now });
        const writeTransport = opts.writeTransport ?? opts.transport;
        this.vault = new CredentialVault(opts.storage, opts.agent, opts.crypto);
        this.oauth = new OAuthClient({
            ...cfg, timeoutMs: opts.writeTimeoutMs ?? opts.timeoutMs, transport: writeTransport, crypto: opts.crypto,
            vault: this.vault, nonces: new DpopNonces(), now: opts.now,
        });
        this.publisher = new Publisher({
            ...cfg, transport: writeTransport, storage: opts.storage, files: opts.files, oauth: this.oauth, agentDid: () => opts.agent.did(),
            crypto: opts.crypto, accounts: this.reader.accounts, writeTimeoutMs: opts.writeTimeoutMs, now: opts.now,
        });
    }

    shapes() {
        return mountShapes(this.opts.languageAddress());
    }

    snapshot(): { entries: MountEntry[] } {
        return { entries: this.publisher.decorate(this.reader.snapshot().entries, (did) => this.reader.acceptedRev(did)) };
    }

    /** Read every account; the delta is taken over the served snapshot (the
     *  ledger applied), so a published post never flaps. */
    async refresh(): Promise<RefreshReport> {
        const before = this.snapshot().entries;
        const report = await this.reader.refresh();
        return { ...report, delta: diff(before, this.snapshot().entries) };
    }

    publish(params: unknown): Promise<CallDelta> {
        return this.publisher.publish((params ?? {}) as any);
    }

    async status(extra: Record<string, unknown> = {}) {
        return {
            accounts: this.reader.accounts,
            plcUrl: this.opts.plcUrl,
            appviewUrl: this.opts.appviewUrl || null,
            moderation: this.opts.appviewUrl ? "appview" : "unavailable",
            allowHttp: !!this.opts.allowHttp,
            lastReport: this.reader.lastReport,
            writes: "explicit only: the ATPost constructor (com.atproto.repo.createRecord, app.bsky.feed.post), OAuth + DPoP",
            oauth: { clientId: CLIENT_ID, scope: OAUTH_SCOPE, authorizedAccounts: this.vault.accounts() },
            ...extra,
        };
    }

    interactions(address: string): Interaction[] {
        if (address === "class/ATPost") {
            return [{ name: "publish", label: "Publish a plain-text post (explicit; needs authorize first)", execute: (p) => this.publish(p) }];
        }
        if (address !== "project") return [];
        const str = (p: any, k: string) => (p && typeof p[k] === "string" ? p[k] : "");
        return [
            { name: "refresh", label: "Read every allowlisted account now", execute: () => this.refresh() },
            { name: "status", label: "Allowlist, endpoints, authorized accounts and the last refresh report", execute: () => this.status() },
            { name: "authorize", label: "Start OAuth for an account: returns the URL to open", execute: (p) => this.oauth.begin(str(p, "account")) },
            { name: "completeAuthorization", label: "Finish OAuth with the callback URL", execute: (p) => this.oauth.complete(str(p, "callbackUrl")) },
            { name: "sessions", label: "Accounts this executor user authorized (no secrets)", execute: () => this.oauth.sessions() },
            { name: "signOut", label: "Revoke and forget an account's session", execute: (p) => this.oauth.signOut(str(p, "account")) },
        ];
    }

    async call(address: string, name: string, params: unknown = {}): Promise<any> {
        const i = this.interactions(address).find((x) => x.name === name);
        if (!i) throw new Error(`no interaction ${name} on ${address}`);
        return i.execute(params);
    }
}
