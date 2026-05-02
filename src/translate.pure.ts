/**
 * Pure translation functions — LinkExpression ↔ AT Proto record.
 *
 * No I/O, no runtime deps. Safe for unit testing.
 *
 * Implements the bidirectional mapping described in Spec §5.
 */

import type {
    LinkExpression,
    Ad4mLinkTriple,
    BskyPost,
    BskyLike,
    BskyRepost,
    BskyFollow,
    ExpressionProof,
    RepoWrite,
    PerspectiveDiff,
} from "./types.js";
import { tidFromISO } from "./xrpc.pure.js";

// ---------------------------------------------------------------------------
// Outbound: Link → AT Proto Record
// ---------------------------------------------------------------------------

/**
 * Convert a LinkExpression to an ad4m.link.triple record.
 * This is lossless — all link data is preserved.
 */
export function linkToTripleRecord(link: LinkExpression): Ad4mLinkTriple {
    const record: Ad4mLinkTriple = {
        $type: "ad4m.link.triple",
        source: link.data.source || "",
        predicate: link.data.predicate || "",
        target: link.data.target || "",
        author: link.author,
        timestamp: link.timestamp,
    };

    if (link.proof && (link.proof.signature || link.proof.key)) {
        record.proof = {
            signature: link.proof.signature || "",
            key: link.proof.key || "",
        };
    }

    return record;
}

/**
 * Convert a LinkExpression to a Bluesky post record.
 * Returns null if the link's pattern is not suitable for a post.
 *
 * This is a lossy transformation — only the text content from the
 * target expression URI is used.
 */
export function linkToBlueskyPost(
    link: LinkExpression,
    opts: {
        text: string;
        facets?: BskyPost["facets"];
        embed?: BskyPost["embed"];
        reply?: BskyPost["reply"];
    },
): BskyPost {
    return {
        $type: "app.bsky.feed.post",
        text: opts.text,
        createdAt: link.timestamp || new Date().toISOString(),
        facets: opts.facets,
        embed: opts.embed,
        reply: opts.reply,
    };
}

/**
 * Create a Bluesky like record from a reaction link.
 */
export function linkToBlueskyLike(
    link: LinkExpression,
    subjectUri: string,
    subjectCid: string,
): BskyLike {
    return {
        $type: "app.bsky.feed.like",
        subject: { uri: subjectUri, cid: subjectCid },
        createdAt: link.timestamp || new Date().toISOString(),
    };
}

/**
 * Create a Bluesky repost record from a share/boost link.
 */
export function linkToBlueskyRepost(
    link: LinkExpression,
    subjectUri: string,
    subjectCid: string,
): BskyRepost {
    return {
        $type: "app.bsky.feed.repost",
        subject: { uri: subjectUri, cid: subjectCid },
        createdAt: link.timestamp || new Date().toISOString(),
    };
}

// ---------------------------------------------------------------------------
// Inbound: AT Proto Record → Link
// ---------------------------------------------------------------------------

/**
 * Convert an ad4m.link.triple record back to a LinkExpression.
 * This is lossless when the record was created by linkToTripleRecord.
 */
export function tripleRecordToLink(record: Ad4mLinkTriple): LinkExpression {
    const proof: ExpressionProof = record.proof
        ? { signature: record.proof.signature || "", key: record.proof.key || "" }
        : { signature: "", key: "" };

    return {
        author: record.author,
        timestamp: record.timestamp,
        data: {
            source: record.source,
            predicate: record.predicate,
            target: record.target,
        },
        proof,
    };
}

/**
 * Convert a Bluesky post to a LinkExpression.
 * This is lossy — synthesizes a semantic triple from the post.
 */
export function blueskyPostToLink(
    record: BskyPost,
    authorDid: string,
    uri: string,
    neighbourhoodUrl: string,
): LinkExpression {
    return {
        author: `at:${authorDid}`,
        timestamp: record.createdAt,
        data: {
            source: neighbourhoodUrl,
            predicate: "sioc://content_of",
            target: `at:${uri}`,
        },
        proof: { signature: "", key: "" },
    };
}

/**
 * Convert a Bluesky like to a LinkExpression.
 */
export function blueskyLikeToLink(
    record: BskyLike,
    authorDid: string,
): LinkExpression {
    return {
        author: `at:${authorDid}`,
        timestamp: record.createdAt,
        data: {
            source: `at:${record.subject.uri}`,
            predicate: "flux://has_reaction",
            target: "emoji://👍",
        },
        proof: { signature: "", key: "" },
    };
}

/**
 * Convert a Bluesky repost to a LinkExpression.
 */
export function blueskyRepostToLink(
    record: BskyRepost,
    authorDid: string,
    neighbourhoodUrl: string,
): LinkExpression {
    return {
        author: `at:${authorDid}`,
        timestamp: record.createdAt,
        data: {
            source: neighbourhoodUrl,
            predicate: "flux://has_share",
            target: `at:${record.subject.uri}`,
        },
        proof: { signature: "", key: "" },
    };
}

/**
 * Convert a Bluesky follow to a LinkExpression.
 */
export function blueskyFollowToLink(
    record: BskyFollow,
    authorDid: string,
): LinkExpression {
    return {
        author: `at:${authorDid}`,
        timestamp: record.createdAt,
        data: {
            source: `at:${authorDid}`,
            predicate: "sioc://follows",
            target: `at:${record.subject}`,
        },
        proof: { signature: "", key: "" },
    };
}

// ---------------------------------------------------------------------------
// Batch translation
// ---------------------------------------------------------------------------

/**
 * Generate a record key (rkey) for a link.
 * Uses TID derived from the link's timestamp.
 */
export function linkToRkey(link: LinkExpression, clockId: number = 0): string {
    try {
        return tidFromISO(link.timestamp, clockId);
    } catch {
        // Fallback: use current time
        return tidFromISO(new Date().toISOString(), clockId);
    }
}

/**
 * Convert a PerspectiveDiff to applyWrites operations.
 *
 * Each addition becomes a create op for ad4m.link.triple.
 * Each removal becomes a delete op.
 */
export function diffToWriteOps(
    diff: PerspectiveDiff,
    collection: string,
    hashFn: (data: string) => string,
): RepoWrite[] {
    const writes: RepoWrite[] = [];
    const usedRkeys = new Set<string>();

    for (const link of diff.additions) {
        let rkey = linkToRkey(link);
        // Ensure unique rkey by appending hash suffix if collision
        while (usedRkeys.has(rkey)) {
            const hash = hashFn(JSON.stringify(link) + rkey);
            rkey = rkey.substring(0, 10) + hash.substring(0, 3);
        }
        usedRkeys.add(rkey);

        const record = linkToTripleRecord(link);
        writes.push({
            $type: "com.atproto.repo.applyWrites#create",
            collection,
            rkey,
            value: record as unknown as Record<string, unknown>,
        });
    }

    for (const link of diff.removals) {
        // For removals, we need to find the rkey of the existing record.
        // Use TID from timestamp as best-effort match.
        const rkey = linkToRkey(link);
        writes.push({
            $type: "com.atproto.repo.applyWrites#delete",
            collection,
            rkey,
        });
    }

    return writes;
}

/**
 * Translate an inbound AT Proto record to a LinkExpression.
 *
 * Dispatches based on $type:
 * - ad4m.link.triple → lossless
 * - app.bsky.feed.post → lossy
 * - app.bsky.feed.like → lossy
 * - app.bsky.feed.repost → lossy
 * - app.bsky.graph.follow → lossy
 */
export function recordToLink(
    record: Record<string, unknown>,
    authorDid: string,
    uri: string,
    neighbourhoodUrl: string,
): LinkExpression | null {
    const type = record.$type as string;

    if (type === "ad4m.link.triple") {
        return tripleRecordToLink(record as unknown as Ad4mLinkTriple);
    }

    if (type === "app.bsky.feed.post") {
        return blueskyPostToLink(
            record as unknown as BskyPost,
            authorDid,
            uri,
            neighbourhoodUrl,
        );
    }

    if (type === "app.bsky.feed.like") {
        return blueskyLikeToLink(
            record as unknown as BskyLike,
            authorDid,
        );
    }

    if (type === "app.bsky.feed.repost") {
        return blueskyRepostToLink(
            record as unknown as BskyRepost,
            authorDid,
            neighbourhoodUrl,
        );
    }

    if (type === "app.bsky.graph.follow") {
        return blueskyFollowToLink(
            record as unknown as BskyFollow,
            authorDid,
        );
    }

    return null;
}

/**
 * Compute a content key for deduplication.
 * Based on source + predicate + target (author-agnostic).
 */
export function linkContentKey(link: LinkExpression): string {
    return `${link.data.source || ""}:${link.data.predicate || ""}:${link.data.target || ""}`;
}

/**
 * Check if a record is an ad4m.link.triple.
 */
export function isTripleRecord(record: Record<string, unknown>): boolean {
    return record.$type === "ad4m.link.triple";
}

/**
 * Check if a record is a Bluesky post.
 */
export function isBlueskyPost(record: Record<string, unknown>): boolean {
    return record.$type === "app.bsky.feed.post";
}
