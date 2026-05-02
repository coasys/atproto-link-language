/**
 * Dual-language deduplication — pure module.
 *
 * When the AT Proto Link Language operates alongside a primary link
 * language (e.g. Holochain), we need to:
 * - Deduplicate links that arrive via both AT Proto and native sync
 * - Track which links originated from AT Proto vs native
 * - Filter outbound federation for links that arrived via AT Proto
 *   (to avoid echo/re-federation loops)
 *
 * Same architecture as the AP Link Language.
 * Pure functions — no ad4m:host imports. Safe for unit testing.
 */

import type { LinkExpression } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LinkOrigin = "atproto" | "native" | "dual";

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

/**
 * Compute canonical link data for content-based deduplication.
 * Author/timestamp excluded so same logical link from different
 * sync paths is detected as duplicate.
 */
function canonicalLinkData(link: LinkExpression): string {
    return JSON.stringify({
        source: link.data.source || "",
        predicate: link.data.predicate || "",
        target: link.data.target || "",
    });
}

/**
 * Check if a link already exists in the store (dedup before applying).
 */
export function isDuplicate(
    link: LinkExpression,
    existingHashes: Set<string>,
    hashFn: (data: string) => string,
): boolean {
    const contentHash = hashFn(canonicalLinkData(link));
    return existingHashes.has(contentHash);
}

/**
 * Compute the content hash of a link for dedup tracking.
 */
export function linkContentHash(
    link: LinkExpression,
    hashFn: (data: string) => string,
): string {
    return hashFn(canonicalLinkData(link));
}

// ---------------------------------------------------------------------------
// Origin tracking
// ---------------------------------------------------------------------------

/**
 * Build the storage key for tracking a link's origin.
 *
 * Storage layout: `link-origin/{link-hash}` → "atproto" | "native" | "dual"
 */
export function linkOriginKey(linkHash: string): string {
    return `link-origin/${linkHash}`;
}

// ---------------------------------------------------------------------------
// Federation filtering
// ---------------------------------------------------------------------------

/**
 * Determine if an outbound link should be federated to AT Proto.
 *
 * Links that originated from AT Proto should NOT be re-federated to
 * avoid echo loops. Only "native" or "dual" origin links (or links
 * with no tracked origin, i.e. new local commits) should be federated.
 */
export function shouldFederate(
    linkHash: string,
    getOrigin: (key: string) => string | null,
): boolean {
    const origin = getOrigin(linkOriginKey(linkHash));
    if (origin === null) return true;
    return origin !== "atproto";
}

/**
 * Determine if a link should be excluded from federation based on
 * predicate exclusion list (for dual-language mode).
 */
export function isPredicateExcluded(
    predicate: string,
    excludePredicates: string[],
): boolean {
    if (excludePredicates.length === 0) return false;
    return excludePredicates.includes(predicate);
}

/**
 * Combined federation check: origin + predicate exclusion.
 */
export function shouldFederateLink(
    link: LinkExpression,
    linkHash: string,
    getOrigin: (key: string) => string | null,
    excludePredicates: string[],
): boolean {
    const predicate = link.data.predicate || "";
    if (isPredicateExcluded(predicate, excludePredicates)) return false;
    return shouldFederate(linkHash, getOrigin);
}
