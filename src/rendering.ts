/**
 * Bluesky record rendering — I/O wrappers.
 *
 * Resolves handles to DIDs for mention facets,
 * and delegates to pure rendering functions.
 *
 * No ad4m:host imports — uses injected Transport.
 *
 * Also includes: Pure facet/embed generation (was rendering.pure.ts).
 */

import type { BskyFacet, BskyPost, BskyEmbed, BskyFacetFeature, BskyEmbedExternal, LinkExpression } from "./types.js";
import { resolveHandle } from "./xrpc.js";

// ---------------------------------------------------------------------------
// Pure facet/embed generation (was rendering.pure.ts)
// ---------------------------------------------------------------------------

/**
 * Detect mentions, links, and hashtags in text and generate facets.
 *
 * Facets use byte offsets (not character offsets) per AT Proto spec.
 */
export function generateFacets(text: string): BskyFacet[] {
    const facets: BskyFacet[] = [];
    const encoder = new TextEncoder();

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

export function createRecordEmbed(uri: string, cid: string): BskyEmbed {
    return {
        $type: "app.bsky.embed.record",
        record: { uri, cid },
    };
}

export function extractLinks(text: string): string[] {
    const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;
    const matches = text.match(urlRegex);
    return matches || [];
}

export function extractMentions(text: string): string[] {
    const mentionRegex = /(?:^|\s)@(([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)/g;
    const handles: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = mentionRegex.exec(text)) !== null) {
        handles.push(match[1]);
    }
    return handles;
}

export function extractHashtags(text: string): string[] {
    const tagRegex = /(?:^|\s)#([a-zA-Z0-9_]+)/g;
    const tags: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = tagRegex.exec(text)) !== null) {
        tags.push(match[1]);
    }
    return tags;
}

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

/**
 * Generate facets with resolved mention DIDs.
 *
 * Calls resolveHandle for each @mention to get the actual DID.
 */
export async function generateFacetsWithResolvedMentions(
    text: string,
    pdsUrl: string,
): Promise<BskyFacet[]> {
    // Start with basic facets (links and tags are already correct)
    const facets = generateFacets(text);
    const mentions = extractMentions(text);

    if (mentions.length === 0) return facets;

    // Resolve each mention handle to a DID
    for (const handle of mentions) {
        const did = await resolveHandle(pdsUrl, handle);
        if (!did) continue;

        // Find the matching mention facet and update the DID
        const mentionFacet = createMentionFacet(text, handle, did);
        if (mentionFacet) {
            // Replace the placeholder mention facet
            const idx = facets.findIndex(f =>
                f.features.some(feat =>
                    feat.$type === "app.bsky.richtext.facet#mention" &&
                    (feat as { did: string }).did === "" &&
                    f.index.byteStart === mentionFacet.index.byteStart
                )
            );
            if (idx >= 0) {
                facets[idx] = mentionFacet;
            } else {
                facets.push(mentionFacet);
            }
        }
    }

    // Remove mention facets with unresolved DIDs
    return facets.filter(f => {
        for (const feat of f.features) {
            if (feat.$type === "app.bsky.richtext.facet#mention" && (feat as { did: string }).did === "") {
                return false;
            }
        }
        return true;
    });
}

/**
 * Build a complete Bluesky post from a link expression.
 *
 * Generates text, facets, and embeds.
 */
export async function buildBlueskyPost(
    link: LinkExpression,
    text: string,
    pdsUrl: string,
): Promise<BskyPost> {
    const facets = await generateFacetsWithResolvedMentions(text, pdsUrl);

    // Check for embedded links
    const links = extractLinks(text);
    let embed = undefined;
    if (links.length > 0) {
        // Use the first link as an external embed
        embed = createExternalEmbed(links[0], "", "");
    }

    return {
        $type: "app.bsky.feed.post",
        text,
        createdAt: link.timestamp || new Date().toISOString(),
        facets: facets.length > 0 ? facets : undefined,
        embed,
    };
}

