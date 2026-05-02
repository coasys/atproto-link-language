/**
 * Pure facet/embed generation for Bluesky posts.
 *
 * Generates byte-indexed facets for mentions, links, and hashtags.
 *
 * Pure functions — no ad4m:host imports. Safe for unit testing.
 */

import type { BskyFacet, BskyFacetFeature, BskyEmbed, BskyEmbedExternal } from "./types.js";

// ---------------------------------------------------------------------------
// Facet generation
// ---------------------------------------------------------------------------

/**
 * Detect mentions, links, and hashtags in text and generate facets.
 *
 * Facets use byte offsets (not character offsets) per AT Proto spec.
 */
export function generateFacets(text: string): BskyFacet[] {
    const facets: BskyFacet[] = [];
    const encoder = new TextEncoder();
    const textBytes = encoder.encode(text);

    // Detect mentions: @handle.domain.tld
    const mentionRegex = /(^|\s)(@([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)/g;
    let match: RegExpExecArray | null;
    while ((match = mentionRegex.exec(text)) !== null) {
        const mentionText = match[2]; // includes @
        const handle = mentionText.substring(1); // remove @
        const startChar = match.index + match[1].length;
        const endChar = startChar + mentionText.length;
        const byteStart = encoder.encode(text.substring(0, startChar)).length;
        const byteEnd = encoder.encode(text.substring(0, endChar)).length;

        facets.push({
            index: { byteStart, byteEnd },
            features: [{
                $type: "app.bsky.richtext.facet#mention",
                did: "", // DID must be resolved by caller
            }],
        });
    }

    // Detect links: http:// or https://
    const urlRegex = /(^|\s)(https?:\/\/[^\s<>"{}|\\^`\[\]]+)/g;
    while ((match = urlRegex.exec(text)) !== null) {
        const urlText = match[2];
        const startChar = match.index + match[1].length;
        const endChar = startChar + urlText.length;
        const byteStart = encoder.encode(text.substring(0, startChar)).length;
        const byteEnd = encoder.encode(text.substring(0, endChar)).length;

        facets.push({
            index: { byteStart, byteEnd },
            features: [{
                $type: "app.bsky.richtext.facet#link",
                uri: urlText,
            }],
        });
    }

    // Detect hashtags: #word
    const tagRegex = /(^|\s)#([a-zA-Z0-9_]+)/g;
    while ((match = tagRegex.exec(text)) !== null) {
        const fullTag = `#${match[2]}`;
        const tag = match[2];
        const startChar = match.index + match[1].length;
        const endChar = startChar + fullTag.length;
        const byteStart = encoder.encode(text.substring(0, startChar)).length;
        const byteEnd = encoder.encode(text.substring(0, endChar)).length;

        facets.push({
            index: { byteStart, byteEnd },
            features: [{
                $type: "app.bsky.richtext.facet#tag",
                tag,
            }],
        });
    }

    return facets;
}

/**
 * Create a mention facet with a resolved DID.
 */
export function createMentionFacet(
    text: string,
    handle: string,
    did: string,
): BskyFacet | null {
    const encoder = new TextEncoder();
    const mentionText = `@${handle}`;
    const index = text.indexOf(mentionText);
    if (index === -1) return null;

    const byteStart = encoder.encode(text.substring(0, index)).length;
    const byteEnd = encoder.encode(text.substring(0, index + mentionText.length)).length;

    return {
        index: { byteStart, byteEnd },
        features: [{
            $type: "app.bsky.richtext.facet#mention",
            did,
        }],
    };
}

/**
 * Create a link facet.
 */
export function createLinkFacet(
    text: string,
    url: string,
): BskyFacet | null {
    const encoder = new TextEncoder();
    const index = text.indexOf(url);
    if (index === -1) return null;

    const byteStart = encoder.encode(text.substring(0, index)).length;
    const byteEnd = encoder.encode(text.substring(0, index + url.length)).length;

    return {
        index: { byteStart, byteEnd },
        features: [{
            $type: "app.bsky.richtext.facet#link",
            uri: url,
        }],
    };
}

/**
 * Create a tag facet.
 */
export function createTagFacet(
    text: string,
    tag: string,
): BskyFacet | null {
    const encoder = new TextEncoder();
    const hashTag = `#${tag}`;
    const index = text.indexOf(hashTag);
    if (index === -1) return null;

    const byteStart = encoder.encode(text.substring(0, index)).length;
    const byteEnd = encoder.encode(text.substring(0, index + hashTag.length)).length;

    return {
        index: { byteStart, byteEnd },
        features: [{
            $type: "app.bsky.richtext.facet#tag",
            tag,
        }],
    };
}

// ---------------------------------------------------------------------------
// Embed generation
// ---------------------------------------------------------------------------

/**
 * Create an external link embed.
 */
export function createExternalEmbed(
    uri: string,
    title: string,
    description: string,
): BskyEmbed {
    return {
        $type: "app.bsky.embed.external",
        external: { uri, title, description },
    };
}

/**
 * Create a record embed (quote post).
 */
export function createRecordEmbed(uri: string, cid: string): BskyEmbed {
    return {
        $type: "app.bsky.embed.record",
        record: { uri, cid },
    };
}

/**
 * Extract links from text for potential embeds.
 */
export function extractLinks(text: string): string[] {
    const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;
    const matches = text.match(urlRegex);
    return matches || [];
}

/**
 * Extract mentions from text.
 * Returns handles without the @ prefix.
 */
export function extractMentions(text: string): string[] {
    const mentionRegex = /(?:^|\s)@(([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)/g;
    const handles: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = mentionRegex.exec(text)) !== null) {
        handles.push(match[1]);
    }
    return handles;
}

/**
 * Extract hashtags from text.
 * Returns tags without the # prefix.
 */
export function extractHashtags(text: string): string[] {
    const tagRegex = /(?:^|\s)#([a-zA-Z0-9_]+)/g;
    const tags: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = tagRegex.exec(text)) !== null) {
        tags.push(match[1]);
    }
    return tags;
}

/**
 * Convert facets to link predicates for inbound translation.
 * Maps facet features to appropriate AD4M predicates.
 */
export function facetsToLinkPredicates(
    facets: BskyFacet[],
    postUri: string,
): Array<{ source: string; predicate: string; target: string }> {
    const predicates: Array<{ source: string; predicate: string; target: string }> = [];

    for (const facet of facets) {
        for (const feature of facet.features) {
            if (feature.$type === "app.bsky.richtext.facet#mention") {
                predicates.push({
                    source: postUri,
                    predicate: "flux://has_mention",
                    target: `at:${feature.did}`,
                });
            } else if (feature.$type === "app.bsky.richtext.facet#link") {
                predicates.push({
                    source: postUri,
                    predicate: "sioc://links_to",
                    target: feature.uri,
                });
            } else if (feature.$type === "app.bsky.richtext.facet#tag") {
                predicates.push({
                    source: postUri,
                    predicate: "flux://has_tag",
                    target: `tag://${feature.tag}`,
                });
            }
        }
    }

    return predicates;
}
