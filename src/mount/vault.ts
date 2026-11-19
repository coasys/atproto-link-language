/**
 * Credential vault: OAuth sessions (access + refresh token, private DPoP
 * key) and pending authorizations (PKCE verifier, DPoP key), kept in host
 * storage only as boxes sealed to the executor agent (sealed-box.ts) and
 * opened through the agent (`agentOpenSealed`). Storage holds nothing a
 * reader of the data dir could use.
 *
 * Keys are per executor user (the agent DID the language runs as) and per
 * AT account: `oauth/v1/session/<agent did>/<at did>`. The index of an
 * agent's accounts is plain (DIDs only).
 *
 * Nothing here logs, and no method returns a secret except `getSession` /
 * `takePending`, whose callers keep them in memory for one request.
 */

import type { Jwk, WebCrypto } from "./webcrypto.js";

import { fromUtf8, unhex } from "./bytes.js";
import { sealToDid, type SealedBox } from "./sealed-box.js";

export interface AgentAccess {
    /** the executor agent (user) the language currently runs as */
    did(): string;
    /** `agentOpenSealed`: the plaintext of a box sealed to that agent, hex */
    openSealed(box: SealedBox): string | Promise<string>;
}

export type StorageLike = { get(k: string): string | null; put(k: string, v: string): void; delete(k: string): void };

export interface Session {
    account: string;
    issuer: string;
    pds: string;
    tokenEndpoint: string;
    revocationEndpoint?: string;
    clientId: string;
    scope: string;
    accessToken: string;
    refreshToken?: string;
    /** epoch ms */
    expiresAt: number;
    /** the private DPoP key (JWK, ES256) the tokens are bound to */
    dpopJwk: Jwk;
}

export interface PendingAuthorization {
    account: string;
    state: string;
    issuer: string;
    pds: string;
    tokenEndpoint: string;
    revocationEndpoint?: string;
    clientId: string;
    redirectUri: string;
    verifier: string;
    dpopJwk: Jwk;
    /** epoch ms */
    createdAt: number;
}

// DIDs (did:key, did:plc, hostname did:web) hold no "/"; state is base64url.
export const vaultKeys = {
    session: (agent: string, account: string) => `oauth/v1/session/${agent}/${account}`,
    pending: (agent: string, state: string) => `oauth/v1/pending/${agent}/${state}`,
    index: (agent: string) => `oauth/v1/accounts/${agent}`,
};

export class VaultError extends Error {}

export class CredentialVault {
    constructor(
        private readonly storage: StorageLike,
        private readonly agent: AgentAccess,
        private readonly crypto: WebCrypto,
    ) {}

    agentDid(): string {
        return this.agent.did();
    }

    private async seal(key: string, value: unknown): Promise<void> {
        const box = await sealToDid(this.agent.did(), JSON.stringify(value), this.crypto);
        this.storage.put(key, JSON.stringify({ v: 1, box }));
    }

    private async open<T>(key: string): Promise<T | null> {
        const raw = this.storage.get(key);
        if (!raw) return null;
        let box: SealedBox;
        try {
            box = JSON.parse(raw).box;
        } catch {
            throw new VaultError(`vault entry ${key} is unreadable`);
        }
        let plain: string;
        try {
            plain = fromUtf8(unhex(String(await this.agent.openSealed(box))));
        } catch {
            // never echo the box or the agent's error text
            throw new VaultError(`vault entry ${key} cannot be opened by this agent`);
        }
        return JSON.parse(plain) as T;
    }

    accounts(): string[] {
        const raw = this.storage.get(vaultKeys.index(this.agent.did()));
        try {
            const list = raw ? JSON.parse(raw) : [];
            return Array.isArray(list) ? list.filter((d): d is string => typeof d === "string") : [];
        } catch {
            return [];
        }
    }

    private setIndex(list: string[]): void {
        this.storage.put(vaultKeys.index(this.agent.did()), JSON.stringify([...new Set(list)].sort()));
    }

    hasSession(account: string): boolean {
        return !!this.storage.get(vaultKeys.session(this.agent.did(), account));
    }

    async putSession(s: Session): Promise<void> {
        await this.seal(vaultKeys.session(this.agent.did(), s.account), s);
        this.setIndex([...this.accounts(), s.account]);
    }

    async getSession(account: string): Promise<Session | null> {
        const s = await this.open<Session>(vaultKeys.session(this.agent.did(), account));
        return s && s.account === account ? s : null;
    }

    deleteSession(account: string): void {
        this.storage.delete(vaultKeys.session(this.agent.did(), account));
        this.setIndex(this.accounts().filter((a) => a !== account));
    }

    async putPending(p: PendingAuthorization): Promise<void> {
        await this.seal(vaultKeys.pending(this.agent.did(), p.state), p);
    }

    /** The pending authorization for `state`, removed: one use only. */
    async takePending(state: string): Promise<PendingAuthorization | null> {
        const key = vaultKeys.pending(this.agent.did(), state);
        const p = await this.open<PendingAuthorization>(key);
        this.storage.delete(key);
        return p && p.state === state ? p : null;
    }
}
