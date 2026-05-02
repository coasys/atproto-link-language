/**
 * PDS authentication — session management with token refresh.
 *
 * Stores session tokens in KV via StorageAdapter.
 * Auto-refreshes before JWT expiry by parsing the exp claim.
 *
 * No ad4m:host imports — uses injected adapters.
 */

import { getStorage } from "./storage-interface.js";
import * as xrpc from "./xrpc.js";
import type { ATSession } from "./types.js";

// ---------------------------------------------------------------------------
// KV keys
// ---------------------------------------------------------------------------

const KEY_ACCESS_JWT = "at:session:accessJwt";
const KEY_REFRESH_JWT = "at:session:refreshJwt";
const KEY_DID = "at:session:did";
const KEY_PDS_URL = "at:session:pdsUrl";

// ---------------------------------------------------------------------------
// JWT expiry parsing
// ---------------------------------------------------------------------------

/**
 * Parse the expiry timestamp (seconds since epoch) from a JWT.
 * Returns 0 if parsing fails.
 */
export function parseJwtExp(jwt: string): number {
    try {
        const parts = jwt.split(".");
        if (parts.length !== 3) return 0;
        // Base64url decode the payload
        const payload = parts[1];
        const padded = payload.replace(/-/g, "+").replace(/_/g, "/");
        const decoded = atob(padded);
        const data = JSON.parse(decoded);
        return typeof data.exp === "number" ? data.exp : 0;
    } catch {
        return 0;
    }
}

/**
 * Check if a JWT is expired or will expire within the given buffer (seconds).
 */
export function isJwtExpired(jwt: string, bufferSeconds: number = 60): boolean {
    const exp = parseJwtExp(jwt);
    if (exp === 0) return true;
    const now = Math.floor(Date.now() / 1000);
    return now >= (exp - bufferSeconds);
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

/**
 * Store session tokens in KV.
 */
function storeSession(session: ATSession, pdsUrl: string): void {
    const storage = getStorage();
    storage.put(KEY_ACCESS_JWT, session.accessJwt);
    storage.put(KEY_REFRESH_JWT, session.refreshJwt);
    storage.put(KEY_DID, session.did);
    storage.put(KEY_PDS_URL, pdsUrl);
}

/**
 * Load session tokens from KV.
 */
function loadSession(): { accessJwt: string; refreshJwt: string; did: string; pdsUrl: string } | null {
    const storage = getStorage();
    const accessJwt = storage.get(KEY_ACCESS_JWT);
    const refreshJwt = storage.get(KEY_REFRESH_JWT);
    const did = storage.get(KEY_DID);
    const pdsUrl = storage.get(KEY_PDS_URL);

    if (!accessJwt || !refreshJwt || !did || !pdsUrl) return null;
    return { accessJwt, refreshJwt, did, pdsUrl };
}

/**
 * Clear stored session.
 */
function clearSession(): void {
    const storage = getStorage();
    storage.delete(KEY_ACCESS_JWT);
    storage.delete(KEY_REFRESH_JWT);
    storage.delete(KEY_DID);
    storage.delete(KEY_PDS_URL);
}

/**
 * Authenticate to PDS. Creates a new session or refreshes existing.
 *
 * Returns the access JWT for use in subsequent XRPC calls,
 * or null if authentication fails.
 */
export async function authenticate(
    pdsUrl: string,
    identifier: string,
    password: string,
): Promise<{ accessJwt: string; did: string } | null> {
    // Check for existing session
    const existing = loadSession();
    if (existing && existing.pdsUrl === pdsUrl) {
        // Try refresh if access token is about to expire
        if (!isJwtExpired(existing.accessJwt, 120)) {
            return { accessJwt: existing.accessJwt, did: existing.did };
        }

        // Access token expired/expiring — try refresh
        if (!isJwtExpired(existing.refreshJwt, 60)) {
            const refreshed = await xrpc.refreshSession(pdsUrl, existing.refreshJwt);
            if (refreshed) {
                storeSession(refreshed, pdsUrl);
                return { accessJwt: refreshed.accessJwt, did: refreshed.did };
            }
        }

        // Refresh failed or expired — clear and re-authenticate
        clearSession();
    }

    // Create new session
    const session = await xrpc.createSession(pdsUrl, identifier, password);
    if (!session) return null;

    storeSession(session, pdsUrl);
    return { accessJwt: session.accessJwt, did: session.did };
}

/**
 * Get the current access token, refreshing if needed.
 *
 * Returns null if no session exists or refresh fails.
 */
export async function getAccessToken(): Promise<{ accessJwt: string; did: string } | null> {
    const existing = loadSession();
    if (!existing) return null;

    // Token still valid
    if (!isJwtExpired(existing.accessJwt, 120)) {
        return { accessJwt: existing.accessJwt, did: existing.did };
    }

    // Try refresh
    if (!isJwtExpired(existing.refreshJwt, 60)) {
        const refreshed = await xrpc.refreshSession(existing.pdsUrl, existing.refreshJwt);
        if (refreshed) {
            storeSession(refreshed, existing.pdsUrl);
            return { accessJwt: refreshed.accessJwt, did: refreshed.did };
        }
    }

    return null;
}

/**
 * Get the stored DID.
 */
export function getStoredDid(): string | null {
    return getStorage().get(KEY_DID);
}

/**
 * Get the stored PDS URL.
 */
export function getStoredPdsUrl(): string | null {
    return getStorage().get(KEY_PDS_URL);
}

/**
 * Logout — delete the session.
 */
export function logout(): void {
    clearSession();
}
