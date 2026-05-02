/**
 * Link ↔ AT Proto record translation — I/O wrappers.
 *
 * Bridges pure translation functions with runtime adapters
 * (XRPC, storage, signing). Handles SDNA pattern detection
 * and rendering strategy.
 *
 * No ad4m:host imports — uses injected adapters.
 */

import type { LinkExpression, PerspectiveDiff, RepoWrite, Ad4mLinkTriple, BskyPost } from "./types.js";
import type { ATProtoSettings } from "./settings.js";
import {
    linkToTripleRecord,
    linkToBlueskyPost,
    linkToRkey,
    diffToWriteOps,
    recordToLink,
    linkContentKey,
} from "./translate.pure.js";
import { detectPattern } from "./sdna.js";
import { generateFacets } from "./rendering.pure.js";
import { TRIPLE_COLLECTION } from "./lexicon.js";
import { getRuntime } from "./runtime-interface.js";

// ---------------------------------------------------------------------------
// Outbound translation
// ---------------------------------------------------------------------------

export interface CommitOptions {
    did: string;
    collection: string;
    settings: ATProtoSettings;
    neighbourhoodUrl: string;
    hashFn: (data: string) => string;
    shouldFederate: (linkHash: string) => boolean;
}

/**
 * Translate a PerspectiveDiff into write operations for the PDS.
 *
 * Applies rendering strategy:
 * - "native" → only ad4m.link.triple records
 * - "bluesky" → only app.bsky.* records (for supported patterns)
 * - "dual" → both native triples and Bluesky records
 *
 * Applies federation filter (skip links from AT Proto origin).
 */
export function translateDiffToWrites(
    diff: PerspectiveDiff,
    opts: CommitOptions,
): RepoWrite[] {
    const writes: RepoWrite[] = [];
    const usedRkeys = new Set<string>();
    const { settings, hashFn, shouldFederate, collection } = opts;
    const strategy = settings.rendering.strategy;

    for (const link of diff.additions) {
        const linkHash = hashFn(linkContentKey(link));

        // Check federation filter
        if (!shouldFederate(linkHash)) continue;

        let rkey = linkToRkey(link);
        while (usedRkeys.has(rkey)) {
            const h = hashFn(JSON.stringify(link) + rkey);
            rkey = rkey.substring(0, 10) + h.substring(0, 3);
        }
        usedRkeys.add(rkey);

        // Native triple
        if (strategy === "native" || strategy === "dual") {
            const record = linkToTripleRecord(link);
            writes.push({
                $type: "com.atproto.repo.applyWrites#create",
                collection,
                rkey,
                value: record as unknown as Record<string, unknown>,
            });
        }

        // Bluesky record (for supported patterns)
        if (strategy === "bluesky" || strategy === "dual") {
            const pattern = detectPattern(link, settings.rendering.chatPredicates);

            if (pattern.type === "chat-message" || pattern.type === "content") {
                // Generate a Bluesky post
                const text = extractTextContent(link);
                if (text) {
                    const facets = generateFacets(text);
                    const bskyRkey = `bsky-${rkey}`;
                    usedRkeys.add(bskyRkey);

                    const post = linkToBlueskyPost(link, { text, facets });
                    writes.push({
                        $type: "com.atproto.repo.applyWrites#create",
                        collection: "app.bsky.feed.post",
                        rkey: bskyRkey,
                        value: post as unknown as Record<string, unknown>,
                    });
                }
            }
        }
    }

    for (const link of diff.removals) {
        const linkHash = hashFn(linkContentKey(link));
        if (!shouldFederate(linkHash)) continue;

        const rkey = linkToRkey(link);

        if (strategy === "native" || strategy === "dual") {
            writes.push({
                $type: "com.atproto.repo.applyWrites#delete",
                collection,
                rkey,
            });
        }

        if (strategy === "bluesky" || strategy === "dual") {
            writes.push({
                $type: "com.atproto.repo.applyWrites#delete",
                collection: "app.bsky.feed.post",
                rkey: `bsky-${rkey}`,
            });
        }
    }

    return writes;
}

/**
 * Extract text content from a link's target URI.
 *
 * Handles literal:// URIs directly. For expression URIs (expr://),
 * returns a placeholder — in production this would resolve via
 * the expression store.
 */
function extractTextContent(link: LinkExpression): string | null {
    const target = link.data.target || "";

    // literal:// URIs contain the content directly
    if (target.startsWith("literal://")) {
        try {
            const decoded = decodeURIComponent(target.replace("literal://", ""));
            // Try to parse as JSON string
            try {
                const parsed = JSON.parse(decoded);
                if (typeof parsed === "string") return parsed;
                if (typeof parsed === "object" && parsed !== null) {
                    // Look for common content fields
                    return parsed.content || parsed.text || parsed.message || JSON.stringify(parsed);
                }
                return String(parsed);
            } catch {
                return decoded;
            }
        } catch {
            return target.replace("literal://", "");
        }
    }

    // For expr:// URIs, we can't resolve in pure translation
    // Return null — the caller should resolve the expression
    if (target.startsWith("expr://")) {
        return null;
    }

    // For other URIs, use the URI itself as text
    if (target.startsWith("http://") || target.startsWith("https://")) {
        return target;
    }

    return null;
}

/**
 * Translate inbound records to links.
 */
export function translateRecordsToLinks(
    records: Array<{ uri: string; cid: string; value: Record<string, unknown> }>,
    neighbourhoodUrl: string,
): LinkExpression[] {
    const links: LinkExpression[] = [];

    for (const record of records) {
        // Extract DID from AT URI: at://did:plc:abc/collection/rkey
        const uriParts = record.uri.replace("at://", "").split("/");
        const authorDid = uriParts[0] || "";

        const link = recordToLink(
            record.value,
            authorDid,
            record.uri,
            neighbourhoodUrl,
        );

        if (link) {
            links.push(link);
        }
    }

    return links;
}

// Re-export pure functions for convenience
export {
    linkToTripleRecord,
    tripleRecordToLink,
    blueskyPostToLink,
    blueskyLikeToLink,
    blueskyRepostToLink,
    blueskyFollowToLink,
    linkToBlueskyPost,
    linkToBlueskyLike,
    linkToBlueskyRepost,
    linkToRkey,
    diffToWriteOps,
    recordToLink,
    linkContentKey,
    isTripleRecord,
    isBlueskyPost,
} from "./translate.pure.js";
