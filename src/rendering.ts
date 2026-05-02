/**
 * Bluesky record rendering — I/O wrappers.
 *
 * Resolves handles to DIDs for mention facets,
 * and delegates to pure rendering functions.
 *
 * No ad4m:host imports — uses injected Transport.
 */

import type { BskyFacet, BskyPost, LinkExpression } from "./types.js";
import {
    generateFacets,
    createMentionFacet,
    extractMentions,
    extractLinks,
    createExternalEmbed,
} from "./rendering.pure.js";
import { resolveHandle } from "./xrpc.js";

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

// Re-export pure functions for convenience
export {
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
} from "./rendering.pure.js";
