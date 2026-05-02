/**
 * SDNA / Subject Class pattern detection — pure module.
 *
 * Detects known Subject Class patterns in LinkExpressions for smart
 * content rendering. Enables chat messages, threaded replies, mentions,
 * and reactions to be translated into appropriate AT Proto record types.
 *
 * Pure functions — no ad4m:host imports. Safe for unit testing.
 */

import type { LinkExpression } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DetectedPattern {
    type: "chat-message" | "reply" | "content" | "mention" | "reaction" | "share" | "follow" | "unknown";
    /** Expression URI to resolve for content */
    contentUri?: string;
    /** For replies: the parent message URI */
    parentUri?: string;
    /** For chat: the channel/conversation URI */
    channelUri?: string;
    /** For mentions: the mentioned agent DID or URI */
    mentionedAgent?: string;
    /** For shares/boosts: the shared post URI */
    sharedUri?: string;
    /** For follows: the followed agent DID */
    followedAgent?: string;
}

// ---------------------------------------------------------------------------
// Well-known predicates
// ---------------------------------------------------------------------------

const REPLY_PREDICATES = new Set([
    "flux://has_reply",
    "sioc://reply_of",
]);

const REACTION_PREDICATES = new Set([
    "flux://has_reaction",
    "emoji://reaction",
]);

const SHARE_PREDICATES = new Set([
    "flux://has_share",
    "sioc://shares",
]);

const FOLLOW_PREDICATES = new Set([
    "sioc://follows",
    "flux://follows",
]);

const CONTENT_PREDICATE = "sioc://content_of";

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detect the Subject Class pattern of a link based on its predicate.
 *
 * Priority (first match wins):
 * 1. Predicate in `chatPredicates` → chat-message
 * 2. Reply predicates → reply
 * 3. Predicate contains "mention" → mention
 * 4. Reaction predicates → reaction
 * 5. Share predicates → share
 * 6. Follow predicates → follow
 * 7. sioc://content_of → content
 * 8. Default → unknown
 */
export function detectPattern(
    link: LinkExpression,
    chatPredicates: string[],
): DetectedPattern {
    const predicate = link.data.predicate || "";
    const source = link.data.source || "";
    const target = link.data.target || "";

    // 1. Chat message
    if (predicate && chatPredicates.includes(predicate)) {
        return {
            type: "chat-message",
            contentUri: target,
            channelUri: source,
        };
    }

    // 2. Reply
    if (REPLY_PREDICATES.has(predicate)) {
        return {
            type: "reply",
            contentUri: target,
            parentUri: source,
        };
    }

    // 3. Mention
    if (predicate && predicate.toLowerCase().includes("mention")) {
        return {
            type: "mention",
            mentionedAgent: target,
        };
    }

    // 4. Reaction
    if (REACTION_PREDICATES.has(predicate)) {
        return {
            type: "reaction",
            contentUri: target,
        };
    }

    // 5. Share/boost
    if (SHARE_PREDICATES.has(predicate)) {
        return {
            type: "share",
            sharedUri: target,
        };
    }

    // 6. Follow
    if (FOLLOW_PREDICATES.has(predicate)) {
        return {
            type: "follow",
            followedAgent: target,
        };
    }

    // 7. Content
    if (predicate === CONTENT_PREDICATE) {
        return {
            type: "content",
            contentUri: target,
        };
    }

    // 8. Unknown
    return { type: "unknown" };
}

/**
 * Check if a link represents a chat-style message.
 */
export function isChatMessage(link: LinkExpression, chatPredicates: string[]): boolean {
    return detectPattern(link, chatPredicates).type === "chat-message";
}

/**
 * Check if a link represents a reply.
 */
export function isReply(link: LinkExpression): boolean {
    const predicate = link.data.predicate || "";
    return REPLY_PREDICATES.has(predicate);
}

/**
 * Check if a link represents a reaction.
 */
export function isReaction(link: LinkExpression): boolean {
    const predicate = link.data.predicate || "";
    return REACTION_PREDICATES.has(predicate);
}

/**
 * Check if a link represents a share/boost.
 */
export function isShare(link: LinkExpression): boolean {
    const predicate = link.data.predicate || "";
    return SHARE_PREDICATES.has(predicate);
}

/**
 * Check if a link represents a follow.
 */
export function isFollow(link: LinkExpression): boolean {
    const predicate = link.data.predicate || "";
    return FOLLOW_PREDICATES.has(predicate);
}

/**
 * Get the set of supported Bluesky record types for a pattern.
 */
export function patternToBlueskyType(pattern: DetectedPattern): string | null {
    switch (pattern.type) {
        case "chat-message":
        case "content":
        case "reply":
            return "app.bsky.feed.post";
        case "reaction":
            return "app.bsky.feed.like";
        case "share":
            return "app.bsky.feed.repost";
        case "follow":
            return "app.bsky.graph.follow";
        default:
            return null;
    }
}
