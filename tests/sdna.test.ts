/**
 * Unit tests for SDNA pattern detection.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    detectPattern,
    isChatMessage,
    isReply,
    isReaction,
    isShare,
    isFollow,
    patternToBlueskyType,
} from "../src/translate.js";

import type { LinkExpression } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeLink(predicate: string, source: string = "s", target: string = "t"): LinkExpression {
    return {
        author: "did:key:z6MkTest",
        timestamp: "2026-05-02T00:00:00.000Z",
        data: { source, target, predicate },
        proof: { signature: "", key: "" },
    };
}

const DEFAULT_CHAT_PREDICATES = ["flux://has_message", "sioc://content_of"];

// ---------------------------------------------------------------------------
// detectPattern
// ---------------------------------------------------------------------------

describe("detectPattern", () => {
    it("detects chat-message for flux://has_message", () => {
        const link = makeLink("flux://has_message", "channel://main", "expr://msg-001");
        const pattern = detectPattern(link, DEFAULT_CHAT_PREDICATES);
        assert.equal(pattern.type, "chat-message");
        assert.equal(pattern.channelUri, "channel://main");
        assert.equal(pattern.contentUri, "expr://msg-001");
    });

    it("detects chat-message for sioc://content_of", () => {
        const link = makeLink("sioc://content_of", "channel://main", "expr://msg-002");
        const pattern = detectPattern(link, DEFAULT_CHAT_PREDICATES);
        assert.equal(pattern.type, "chat-message");
    });

    it("detects reply for flux://has_reply", () => {
        const link = makeLink("flux://has_reply", "parent-msg", "reply-content");
        const pattern = detectPattern(link, DEFAULT_CHAT_PREDICATES);
        assert.equal(pattern.type, "reply");
        assert.equal(pattern.parentUri, "parent-msg");
        assert.equal(pattern.contentUri, "reply-content");
    });

    it("detects reply for sioc://reply_of", () => {
        const link = makeLink("sioc://reply_of");
        const pattern = detectPattern(link, DEFAULT_CHAT_PREDICATES);
        assert.equal(pattern.type, "reply");
    });

    it("detects mention for predicates containing 'mention'", () => {
        const link = makeLink("flux://has_mention", "post-uri", "did:key:z6MkAlice");
        const pattern = detectPattern(link, []);
        assert.equal(pattern.type, "mention");
        assert.equal(pattern.mentionedAgent, "did:key:z6MkAlice");
    });

    it("detects mention case-insensitively", () => {
        const link = makeLink("custom://HAS_MENTION");
        const pattern = detectPattern(link, []);
        assert.equal(pattern.type, "mention");
    });

    it("detects reaction for flux://has_reaction", () => {
        const link = makeLink("flux://has_reaction", "post-uri", "emoji://👍");
        const pattern = detectPattern(link, []);
        assert.equal(pattern.type, "reaction");
        assert.equal(pattern.contentUri, "emoji://👍");
    });

    it("detects reaction for emoji://reaction", () => {
        const link = makeLink("emoji://reaction");
        const pattern = detectPattern(link, []);
        assert.equal(pattern.type, "reaction");
    });

    it("detects share for flux://has_share", () => {
        const link = makeLink("flux://has_share", "src", "shared-post");
        const pattern = detectPattern(link, []);
        assert.equal(pattern.type, "share");
        assert.equal(pattern.sharedUri, "shared-post");
    });

    it("detects share for sioc://shares", () => {
        const link = makeLink("sioc://shares");
        const pattern = detectPattern(link, []);
        assert.equal(pattern.type, "share");
    });

    it("detects follow for sioc://follows", () => {
        const link = makeLink("sioc://follows", "follower", "followed");
        const pattern = detectPattern(link, []);
        assert.equal(pattern.type, "follow");
        assert.equal(pattern.followedAgent, "followed");
    });

    it("detects follow for flux://follows", () => {
        const link = makeLink("flux://follows");
        const pattern = detectPattern(link, []);
        assert.equal(pattern.type, "follow");
    });

    it("returns unknown for unrecognized predicates", () => {
        const link = makeLink("custom://unknown");
        const pattern = detectPattern(link, []);
        assert.equal(pattern.type, "unknown");
    });

    it("returns unknown for empty predicate", () => {
        const link = makeLink("");
        const pattern = detectPattern(link, []);
        assert.equal(pattern.type, "unknown");
    });

    it("chat predicates take priority over content predicate", () => {
        const link = makeLink("sioc://content_of");
        const pattern = detectPattern(link, ["sioc://content_of"]);
        assert.equal(pattern.type, "chat-message");
    });

    it("reply takes priority over mention", () => {
        // flux://has_reply should be detected as reply, not as mention
        const link = makeLink("flux://has_reply");
        const pattern = detectPattern(link, []);
        assert.equal(pattern.type, "reply");
    });

    it("uses custom chat predicates", () => {
        const link = makeLink("custom://chat");
        const pattern = detectPattern(link, ["custom://chat"]);
        assert.equal(pattern.type, "chat-message");
    });
});

// ---------------------------------------------------------------------------
// Convenience functions
// ---------------------------------------------------------------------------

describe("isChatMessage", () => {
    it("returns true for chat predicates", () => {
        const link = makeLink("flux://has_message");
        assert.equal(isChatMessage(link, DEFAULT_CHAT_PREDICATES), true);
    });

    it("returns false for non-chat predicates", () => {
        const link = makeLink("flux://has_reply");
        assert.equal(isChatMessage(link, DEFAULT_CHAT_PREDICATES), false);
    });
});

describe("isReply", () => {
    it("returns true for reply predicates", () => {
        assert.equal(isReply(makeLink("flux://has_reply")), true);
        assert.equal(isReply(makeLink("sioc://reply_of")), true);
    });
    it("returns false for non-reply predicates", () => {
        assert.equal(isReply(makeLink("flux://has_message")), false);
    });
});

describe("isReaction", () => {
    it("returns true for reaction predicates", () => {
        assert.equal(isReaction(makeLink("flux://has_reaction")), true);
        assert.equal(isReaction(makeLink("emoji://reaction")), true);
    });
    it("returns false for non-reaction predicates", () => {
        assert.equal(isReaction(makeLink("flux://has_message")), false);
    });
});

describe("isShare", () => {
    it("returns true for share predicates", () => {
        assert.equal(isShare(makeLink("flux://has_share")), true);
        assert.equal(isShare(makeLink("sioc://shares")), true);
    });
    it("returns false for non-share predicates", () => {
        assert.equal(isShare(makeLink("flux://has_message")), false);
    });
});

describe("isFollow", () => {
    it("returns true for follow predicates", () => {
        assert.equal(isFollow(makeLink("sioc://follows")), true);
        assert.equal(isFollow(makeLink("flux://follows")), true);
    });
    it("returns false for non-follow predicates", () => {
        assert.equal(isFollow(makeLink("flux://has_message")), false);
    });
});

// ---------------------------------------------------------------------------
// patternToBlueskyType
// ---------------------------------------------------------------------------

describe("patternToBlueskyType", () => {
    it("maps chat-message to post", () => {
        assert.equal(patternToBlueskyType({ type: "chat-message" }), "app.bsky.feed.post");
    });

    it("maps content to post", () => {
        assert.equal(patternToBlueskyType({ type: "content" }), "app.bsky.feed.post");
    });

    it("maps reply to post", () => {
        assert.equal(patternToBlueskyType({ type: "reply" }), "app.bsky.feed.post");
    });

    it("maps reaction to like", () => {
        assert.equal(patternToBlueskyType({ type: "reaction" }), "app.bsky.feed.like");
    });

    it("maps share to repost", () => {
        assert.equal(patternToBlueskyType({ type: "share" }), "app.bsky.feed.repost");
    });

    it("maps follow to follow", () => {
        assert.equal(patternToBlueskyType({ type: "follow" }), "app.bsky.graph.follow");
    });

    it("returns null for unknown", () => {
        assert.equal(patternToBlueskyType({ type: "unknown" }), null);
    });

    it("returns null for mention", () => {
        assert.equal(patternToBlueskyType({ type: "mention" }), null);
    });
});
