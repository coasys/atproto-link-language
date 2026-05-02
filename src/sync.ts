/**
 * Sync logic — polling-based record sync and cursor management.
 *
 * Uses polling (listRecords with cursor) for the initial implementation,
 * as the ALDK's httpFetch doesn't support WebSocket.
 *
 * No ad4m:host imports — uses injected adapters.
 */

import type { PerspectiveDiff, LinkExpression } from "./types.js";
import { getStorage } from "./storage-interface.js";
import { getRuntime } from "./runtime-interface.js";
import * as xrpc from "./xrpc.js";
import * as store from "./store.js";
import { recordToLink, linkContentKey } from "./translate.pure.js";
import { isDuplicate, linkContentHash, linkOriginKey } from "./dual-language.js";

// ---------------------------------------------------------------------------
// Cursor management
// ---------------------------------------------------------------------------

const CURSOR_KEY = "at:sync:cursor";
const LAST_SYNC_KEY = "at:sync:lastSync";

/**
 * Get the stored sync cursor.
 */
export function getCursor(): string | null {
    return getStorage().get(CURSOR_KEY);
}

/**
 * Store the sync cursor.
 */
export function setCursor(cursor: string): void {
    getStorage().put(CURSOR_KEY, cursor);
}

/**
 * Get the last sync timestamp.
 */
export function getLastSync(): number {
    const raw = getStorage().get(LAST_SYNC_KEY);
    return raw ? parseInt(raw, 10) : 0;
}

/**
 * Update the last sync timestamp.
 */
export function setLastSync(timestamp: number): void {
    getStorage().put(LAST_SYNC_KEY, String(timestamp));
}

// ---------------------------------------------------------------------------
// Sync implementation
// ---------------------------------------------------------------------------

export interface SyncOptions {
    pdsUrl: string;
    accessJwt: string;
    repo: string;
    collection: string;
    neighbourhoodUrl: string;
    /** Maximum pages to fetch per sync */
    maxPages?: number;
    /** Records per page */
    pageSize?: number;
}

/**
 * Sync records from PDS using polling (listRecords with cursor).
 *
 * 1. List records since cursor
 * 2. Translate records → links
 * 3. Deduplicate (skip already-known links)
 * 4. Store new links
 * 5. Update cursor
 * 6. Return accumulated PerspectiveDiff
 */
export async function syncFromPDS(opts: SyncOptions): Promise<PerspectiveDiff> {
    const {
        pdsUrl,
        accessJwt,
        repo,
        collection,
        neighbourhoodUrl,
        maxPages = 10,
        pageSize = 100,
    } = opts;

    const additions: LinkExpression[] = [];
    let cursor = getCursor() ?? undefined;
    let pageCount = 0;

    // Build set of existing content hashes for dedup
    const existingHashes = buildExistingHashSet();

    while (pageCount < maxPages) {
        const result = await xrpc.listRecords(
            pdsUrl,
            accessJwt,
            repo,
            collection,
            cursor,
            pageSize,
        );

        if (!result || result.records.length === 0) break;

        for (const record of result.records) {
            // Extract DID from AT URI
            const uriParts = record.uri.replace("at://", "").split("/");
            const authorDid = uriParts[0] || "";

            const link = recordToLink(
                record.value,
                authorDid,
                record.uri,
                neighbourhoodUrl,
            );

            if (!link) continue;

            // Dedup check
            const hashFn = getRuntime().hash;
            const contentHash = linkContentHash(link, hashFn);
            if (existingHashes.has(contentHash)) continue;

            // Track origin as atproto
            const linkHash = hashFn(linkContentKey(link));
            getStorage().put(linkOriginKey(linkHash), "atproto");

            additions.push(link);
            existingHashes.add(contentHash);
        }

        // Update cursor
        if (result.cursor) {
            cursor = result.cursor;
            setCursor(result.cursor);
        } else {
            break; // No more pages
        }

        pageCount++;

        // If we got fewer records than page size, we've reached the end
        if (result.records.length < pageSize) break;
    }

    if (additions.length === 0) {
        return { additions: [], removals: [] };
    }

    // Apply to local store
    const diff: PerspectiveDiff = { additions, removals: [] };
    store.applyDiff(diff);

    // Update last sync time
    setLastSync(Date.now());

    return diff;
}

/**
 * Build a set of content hashes for existing links (for dedup).
 */
function buildExistingHashSet(): Set<string> {
    const hashes = new Set<string>();
    const hashFn = getRuntime().hash;
    const allLinks = store.allLinks();

    for (const link of allLinks.links) {
        const contentHash = linkContentHash(link, hashFn);
        hashes.add(contentHash);
    }

    return hashes;
}

/**
 * Perform initial sync — fetch all records from the repo.
 *
 * Used on first init when no cursor exists.
 */
export async function initialSync(opts: SyncOptions): Promise<PerspectiveDiff> {
    // Reset cursor so we start from the beginning
    getStorage().delete(CURSOR_KEY);
    return syncFromPDS({ ...opts, maxPages: 50 });
}

/**
 * Check if sync is needed based on the time since last sync.
 */
export function isSyncNeeded(intervalMs: number): boolean {
    const lastSync = getLastSync();
    return Date.now() - lastSync >= intervalMs;
}

/**
 * Get sync status information.
 */
export function getSyncStatus(): {
    cursor: string | null;
    lastSync: number;
    linkCount: number;
} {
    return {
        cursor: getCursor(),
        lastSync: getLastSync(),
        linkCount: store.linkCount(),
    };
}
