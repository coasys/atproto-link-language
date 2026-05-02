/**
 * Unit tests for Bluesky facet and embed generation.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    generateFacets,
    createMentionFacet,
    createLinkFacet,
    createTagFacet,
    createExternalEmbed,
    createRecordEmbed,
    extractLinks,
    extractMentions,
    extractHashtags,
    facetsToLinkPredicates,
} from "../src/rendering.pure.js";

// ---------------------------------------------------------------------------
// generateFacets
// ---------------------------------------------------------------------------

describe("generateFacets", () => {
    it("detects mentions", () => {
        const text = "Hello @alice.bsky.social!";
        const facets = generateFacets(text);
        const mentionFacets = facets.filter(f =>
            f.features.some(feat => feat.$type === "app.bsky.richtext.facet#mention")
        );
        assert.equal(mentionFacets.length, 1);
    });

    it("detects links", () => {
        const text = "Check out https://ad4m.dev for more info";
        const facets = generateFacets(text);
        const linkFacets = facets.filter(f =>
            f.features.some(feat => feat.$type === "app.bsky.richtext.facet#link")
        );
        assert.equal(linkFacets.length, 1);
        const feature = linkFacets[0].features[0] as { $type: string; uri: string };
        assert.equal(feature.uri, "https://ad4m.dev");
    });

    it("detects hashtags", () => {
        const text = "Exploring #ad4m and #decentralization";
        const facets = generateFacets(text);
        const tagFacets = facets.filter(f =>
            f.features.some(feat => feat.$type === "app.bsky.richtext.facet#tag")
        );
        assert.equal(tagFacets.length, 2);
    });

    it("returns empty array for plain text", () => {
        const facets = generateFacets("Hello world, no special content");
        assert.equal(facets.length, 0);
    });

    it("handles multiple feature types in one text", () => {
        const text = "Hey @alice.bsky.social check https://ad4m.dev #cool";
        const facets = generateFacets(text);
        assert.ok(facets.length >= 3);
    });

    it("generates correct byte offsets for ASCII text", () => {
        const text = "Hi @test.bsky.social end";
        const facets = generateFacets(text);
        const mentionFacet = facets.find(f =>
            f.features.some(feat => feat.$type === "app.bsky.richtext.facet#mention")
        );
        assert.ok(mentionFacet);
        // @test.bsky.social is 18 bytes, starting at byte 3
        assert.equal(mentionFacet!.index.byteStart, 3);
        const encoder = new TextEncoder();
        const expected = encoder.encode("Hi @test.bsky.social").length;
        assert.equal(mentionFacet!.index.byteEnd, expected);
    });

    it("handles emoji in text (byte offsets differ from char offsets)", () => {
        const text = "🎉 Hello #test";
        const facets = generateFacets(text);
        const tagFacet = facets.find(f =>
            f.features.some(feat => feat.$type === "app.bsky.richtext.facet#tag")
        );
        assert.ok(tagFacet);
        // 🎉 is 4 bytes in UTF-8, space is 1, "Hello " is 6
        assert.equal(tagFacet!.index.byteStart, 11);
    });

    it("handles at start of text", () => {
        const text = "#hello world";
        const facets = generateFacets(text);
        const tagFacets = facets.filter(f =>
            f.features.some(feat => feat.$type === "app.bsky.richtext.facet#tag")
        );
        assert.equal(tagFacets.length, 1);
    });

    it("handles links at start of text", () => {
        const text = "https://example.com is great";
        const facets = generateFacets(text);
        const linkFacets = facets.filter(f =>
            f.features.some(feat => feat.$type === "app.bsky.richtext.facet#link")
        );
        assert.equal(linkFacets.length, 1);
    });
});

// ---------------------------------------------------------------------------
// createMentionFacet
// ---------------------------------------------------------------------------

describe("createMentionFacet", () => {
    it("creates a facet for a mention in text", () => {
        const facet = createMentionFacet("Hello @alice.bsky.social!", "alice.bsky.social", "did:plc:alice");
        assert.ok(facet);
        assert.equal(facet!.index.byteStart, 6);
        assert.equal(facet!.features[0].$type, "app.bsky.richtext.facet#mention");
        assert.equal((facet!.features[0] as any).did, "did:plc:alice");
    });

    it("returns null if mention not found in text", () => {
        const facet = createMentionFacet("Hello world", "alice.bsky.social", "did:plc:alice");
        assert.equal(facet, null);
    });
});

// ---------------------------------------------------------------------------
// createLinkFacet
// ---------------------------------------------------------------------------

describe("createLinkFacet", () => {
    it("creates a facet for a URL in text", () => {
        const facet = createLinkFacet("Visit https://ad4m.dev today", "https://ad4m.dev");
        assert.ok(facet);
        assert.equal(facet!.features[0].$type, "app.bsky.richtext.facet#link");
    });

    it("returns null if URL not in text", () => {
        const facet = createLinkFacet("Hello world", "https://nothere.com");
        assert.equal(facet, null);
    });
});

// ---------------------------------------------------------------------------
// createTagFacet
// ---------------------------------------------------------------------------

describe("createTagFacet", () => {
    it("creates a facet for a hashtag in text", () => {
        const facet = createTagFacet("Exploring #ad4m", "ad4m");
        assert.ok(facet);
        assert.equal(facet!.features[0].$type, "app.bsky.richtext.facet#tag");
        assert.equal((facet!.features[0] as any).tag, "ad4m");
    });

    it("returns null if tag not in text", () => {
        const facet = createTagFacet("Hello world", "ad4m");
        assert.equal(facet, null);
    });
});

// ---------------------------------------------------------------------------
// Embed generation
// ---------------------------------------------------------------------------

describe("createExternalEmbed", () => {
    it("creates an external embed", () => {
        const embed = createExternalEmbed("https://ad4m.dev", "AD4M", "Decentralized framework");
        assert.equal(embed.$type, "app.bsky.embed.external");
        assert.equal((embed as any).external.uri, "https://ad4m.dev");
        assert.equal((embed as any).external.title, "AD4M");
    });
});

describe("createRecordEmbed", () => {
    it("creates a record embed", () => {
        const embed = createRecordEmbed("at://did:plc:abc/post/123", "bafyrei123");
        assert.equal(embed.$type, "app.bsky.embed.record");
        assert.equal((embed as any).record.uri, "at://did:plc:abc/post/123");
        assert.equal((embed as any).record.cid, "bafyrei123");
    });
});

// ---------------------------------------------------------------------------
// extractLinks
// ---------------------------------------------------------------------------

describe("extractLinks", () => {
    it("extracts URLs from text", () => {
        const links = extractLinks("Visit https://ad4m.dev and http://example.com");
        assert.equal(links.length, 2);
        assert.ok(links.includes("https://ad4m.dev"));
        assert.ok(links.includes("http://example.com"));
    });

    it("returns empty for text without links", () => {
        assert.deepEqual(extractLinks("No links here"), []);
    });
});

// ---------------------------------------------------------------------------
// extractMentions
// ---------------------------------------------------------------------------

describe("extractMentions", () => {
    it("extracts handles from text", () => {
        const mentions = extractMentions("Hey @alice.bsky.social and @bob.test.com");
        assert.equal(mentions.length, 2);
        assert.ok(mentions.includes("alice.bsky.social"));
        assert.ok(mentions.includes("bob.test.com"));
    });

    it("returns empty for text without mentions", () => {
        assert.deepEqual(extractMentions("No mentions here"), []);
    });
});

// ---------------------------------------------------------------------------
// extractHashtags
// ---------------------------------------------------------------------------

describe("extractHashtags", () => {
    it("extracts hashtags from text", () => {
        const tags = extractHashtags("Exploring #ad4m and #dweb");
        assert.equal(tags.length, 2);
        assert.ok(tags.includes("ad4m"));
        assert.ok(tags.includes("dweb"));
    });

    it("returns empty for text without hashtags", () => {
        assert.deepEqual(extractHashtags("No tags here"), []);
    });

    it("handles hashtags with underscores", () => {
        const tags = extractHashtags("#hello_world test");
        assert.equal(tags.length, 1);
        assert.equal(tags[0], "hello_world");
    });
});

// ---------------------------------------------------------------------------
// facetsToLinkPredicates
// ---------------------------------------------------------------------------

describe("facetsToLinkPredicates", () => {
    it("converts mention facets to link predicates", () => {
        const facets = [{
            index: { byteStart: 0, byteEnd: 10 },
            features: [{ $type: "app.bsky.richtext.facet#mention" as const, did: "did:plc:alice" }],
        }];
        const predicates = facetsToLinkPredicates(facets, "at://post/uri");
        assert.equal(predicates.length, 1);
        assert.equal(predicates[0].predicate, "flux://has_mention");
        assert.equal(predicates[0].target, "at:did:plc:alice");
    });

    it("converts link facets to link predicates", () => {
        const facets = [{
            index: { byteStart: 0, byteEnd: 20 },
            features: [{ $type: "app.bsky.richtext.facet#link" as const, uri: "https://example.com" }],
        }];
        const predicates = facetsToLinkPredicates(facets, "at://post/uri");
        assert.equal(predicates.length, 1);
        assert.equal(predicates[0].predicate, "sioc://links_to");
        assert.equal(predicates[0].target, "https://example.com");
    });

    it("converts tag facets to link predicates", () => {
        const facets = [{
            index: { byteStart: 0, byteEnd: 5 },
            features: [{ $type: "app.bsky.richtext.facet#tag" as const, tag: "ad4m" }],
        }];
        const predicates = facetsToLinkPredicates(facets, "at://post/uri");
        assert.equal(predicates.length, 1);
        assert.equal(predicates[0].predicate, "flux://has_tag");
        assert.equal(predicates[0].target, "tag://ad4m");
    });

    it("handles empty facets array", () => {
        assert.deepEqual(facetsToLinkPredicates([], "at://post/uri"), []);
    });

    it("handles multiple features in one facet", () => {
        const facets = [{
            index: { byteStart: 0, byteEnd: 10 },
            features: [
                { $type: "app.bsky.richtext.facet#mention" as const, did: "did:plc:alice" },
                { $type: "app.bsky.richtext.facet#tag" as const, tag: "test" },
            ],
        }];
        const predicates = facetsToLinkPredicates(facets, "at://post/uri");
        assert.equal(predicates.length, 2);
    });
});
