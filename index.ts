/**
 * # AT Protocol Link Language for AD4M
 *
 * Bridge language that syncs Perspectives via Bluesky's AT Protocol.
 * Implements perspective-commit, perspective-sync, perspective-query,
 * and peers capabilities.
 *
 * Publishes links as AT Proto records (both native ad4m.link.triple
 * and Bluesky-compatible app.bsky.* records), syncs inbound records
 * via polling, and handles authentication.
 *
 * Spec: atproto-link-language.md
 */

import {
    defineLanguage,
    agentDid,
    hash,
    languageSettings,
    emitPerspectiveDiff,
} from "@coasys/ad4m-ldk";

import type { PerspectiveDiff, LinkExpression } from "./src/types.js";
import { parseSettings } from "./src/settings.js";
import type { ATProtoSettings } from "./src/settings.js";
import { translateDiffToWrites, linkContentKey, shouldFederate, linkOriginKey, linkContentHash } from "./src/translate.js";
import type { LinkOrigin } from "./src/translate.js";
import * as store from "./src/store.js";
import * as xrpc from "./src/xrpc.js";
import { authenticate, getAccessToken, getStoredDid } from "./src/auth.js";
import { syncFromPDS, initialSync } from "./src/sync.js";
import { TRIPLE_COLLECTION } from "./src/lexicon.js";

// Adapter imports
import { initTransport, initStorage, getStorage, initSigning, initRuntime } from "./src/adapters.js";
import { DenoTransport, DenoStorageAdapter, DenoSigningAdapter, DenoRuntime } from "./src/adapters-deno.js";

// ---------------------------------------------------------------------------
// Template Variables (per Spec §9)
// ---------------------------------------------------------------------------

//!@ad4m-template-variable
const AT_PDS_URL = "<to-be-filled>";

//!@ad4m-template-variable
const AT_RELAY_URL = "<to-be-filled>";

//!@ad4m-template-variable
const AT_DID = "<to-be-filled>";

//!@ad4m-template-variable
const AT_HANDLE = "<to-be-filled>";

//!@ad4m-template-variable
const AT_COLLECTION_NSID = "<to-be-filled>";

//!@ad4m-template-variable
const AT_APP_PASSWORD = "<to-be-filled>";

//!@ad4m-template-variable
const NEIGHBOURHOOD_META = "<to-be-filled>";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let myDid: string = "";
let settings: ATProtoSettings;

/**
 * Get the neighbourhood URL from the language address.
 */
function neighbourhoodUrl(): string {
    return `neighbourhood://${AT_DID}`;
}

/**
 * Get the collection NSID, defaulting to ad4m.link.triple.
 */
function collectionNsid(): string {
    return AT_COLLECTION_NSID !== "<to-be-filled>" ? AT_COLLECTION_NSID : TRIPLE_COLLECTION;
}

// ---------------------------------------------------------------------------
// Language definition
// ---------------------------------------------------------------------------

const language = defineLanguage({
    name: "@hexafield/atproto-link-language",
    version: "0.1.0",

    isPublic: true,

    async init() {
        // Initialize adapters before anything else
        initRuntime(new DenoRuntime());
        initStorage(new DenoStorageAdapter());
        initTransport(new DenoTransport());
        initSigning(new DenoSigningAdapter());
        store.initStore();

        myDid = agentDid();
        settings = parseSettings(languageSettings());

        console.log(`[atproto-link-language] init: did=${myDid}, pds=${AT_PDS_URL}`);
        console.log(`[atproto-link-language] AT DID: ${AT_DID}`);
        console.log(`[atproto-link-language] sync mode: ${settings.syncMode}`);
        console.log(`[atproto-link-language] rendering: ${settings.rendering.strategy}`);

        // Authenticate to PDS if we have credentials
        const appPassword = AT_APP_PASSWORD !== "<to-be-filled>" ? AT_APP_PASSWORD : settings.auth.appPassword;
        if (appPassword && AT_PDS_URL !== "<to-be-filled>") {
            const handle = AT_HANDLE !== "<to-be-filled>" ? AT_HANDLE : AT_DID;
            console.log(`[atproto-link-language] attempting auth: handle=${handle}, pds=${AT_PDS_URL}`);
            try {
                const auth = await authenticate(AT_PDS_URL, handle, appPassword);
                if (auth) {
                    console.log(`[atproto-link-language] authenticated as ${auth.did}`);
                    // Initial sync if no cursor exists
                    if (!getStorage().get("at:sync:cursor")) {
                        const diff = await initialSync({
                            pdsUrl: AT_PDS_URL,
                            accessJwt: auth.accessJwt,
                            repo: auth.did,
                            collection: collectionNsid(),
                            neighbourhoodUrl: neighbourhoodUrl(),
                        });
                        if (diff.additions.length > 0) {
                            emitPerspectiveDiff(diff);
                        }
                    }
                } else {
                    console.error("[atproto-link-language] authentication failed — no session returned");
                }
            } catch (authErr: unknown) {
                console.error(`[atproto-link-language] auth error: ${authErr instanceof Error ? authErr.message : String(authErr)}`);
            }
        }
    },

    async teardown() {
        myDid = "";
        console.log("[atproto-link-language] teardown");
    },

    interactions() {
        return [];
    },

    // -----------------------------------------------------------------------
    // perspective-commit
    // -----------------------------------------------------------------------
    commit: {
        async commit(diff: PerspectiveDiff) {
            // 1. Store links locally
            store.applyDiff(diff);

            // 2. Skip outbound in subscribe-only mode
            if (settings.syncMode === "subscribe-only") {
                emitPerspectiveDiff(diff);
                return "";
            }

            // 3. Build federation filter
            const federationFilter = (linkHash: string): boolean => {
                return shouldFederate(linkHash, (key) => getStorage().get(key));
            };

            // 4. Track origins for new commits
            for (const link of diff.additions) {
                const h = store.hashLink(link);
                const originKey = linkOriginKey(h);
                const storage = getStorage();
                const existing = storage.get(originKey);
                if (existing === "atproto") {
                    storage.put(originKey, "dual");
                } else if (!existing) {
                    storage.put(originKey, "native");
                }
            }

            // 5. Translate to AT Proto write operations
            const writes = translateDiffToWrites(diff, {
                did: AT_DID,
                collection: collectionNsid(),
                settings,
                neighbourhoodUrl: neighbourhoodUrl(),
                hashFn: hash,
                shouldFederate: federationFilter,
            });

            // 6. Submit to PDS
            if (writes.length > 0) {
                const auth = await getAccessToken();
                if (auth) {
                    const result = await xrpc.applyWrites(
                        AT_PDS_URL,
                        auth.accessJwt,
                        auth.did,
                        writes,
                    );
                    if (!result.success) {
                        console.error("[atproto-link-language] commit failed: applyWrites error");
                    }
                } else {
                    console.error("[atproto-link-language] commit failed: no auth token");
                }
            }

            // 7. Emit perspective diff for local subscribers
            emitPerspectiveDiff(diff);

            return "";
        },
    },

    // -----------------------------------------------------------------------
    // perspective-sync
    // -----------------------------------------------------------------------
    sync: {
        async sync() {
            // Skip sync in publish-only mode
            if (settings.syncMode === "publish-only") {
                return { additions: [], removals: [] };
            }

            const auth = await getAccessToken();
            if (!auth) {
                return { additions: [], removals: [] };
            }

            return await syncFromPDS({
                pdsUrl: AT_PDS_URL,
                accessJwt: auth.accessJwt,
                repo: auth.did,
                collection: collectionNsid(),
                neighbourhoodUrl: neighbourhoodUrl(),
            });
        },

        async render() {
            return store.allLinks();
        },

        async currentRevision() {
            return store.getRevision() || "";
        },
    },

    // -----------------------------------------------------------------------
    // perspective-query
    // -----------------------------------------------------------------------
    query: {
        supportedKinds() {
            return ["link-pattern"];
        },

        async run(req: { kind: string; payload: unknown }) {
            if (req.kind !== "link-pattern") {
                return { kind: "error", payload: `Unsupported query kind: ${req.kind}` };
            }
            const pattern = req.payload as { source?: string; target?: string; predicate?: string };
            const links = store.queryLinks(pattern);
            return { kind: "links", payload: links };
        },
    },

    // -----------------------------------------------------------------------
    // peers
    // -----------------------------------------------------------------------
    peers: {
        setLocal(agents: string[]) {
            for (const did of agents) {
                store.setPeer(did, { local: true });
            }
        },

        async remote() {
            return store.listPeers("peers/");
        },
    },
});

// ---------------------------------------------------------------------------
// Flat exports
// ---------------------------------------------------------------------------

export const {
    name,
    version,
    isPublic,
    init,
    teardown,
    interactions,
    perspectiveCommit,
    perspectiveSyncSync,
    perspectiveSyncRender,
    perspectiveSyncCurrentRevision,
    perspectiveQuerySupportedKinds,
    perspectiveQueryRun,
    peersSetLocal,
    peersRemote,
} = language;

export default language;

// ---------------------------------------------------------------------------
// Callback registration
// ---------------------------------------------------------------------------

let linkCallback: ((diff: PerspectiveDiff) => void) | null = null;
let syncStateChangeCallback: ((state: string) => void) | null = null;

export function linkSyncAddCallback(callback: (diff: PerspectiveDiff) => void): number {
    linkCallback = callback;
    return 1;
}

export function linkSyncRemoveCallback(callback: (diff: PerspectiveDiff) => void): number {
    if (linkCallback === callback) linkCallback = null;
    return 1;
}

export function linkSyncAddSyncStateChangeCallback(callback: (state: string) => void): number {
    syncStateChangeCallback = callback;
    return 1;
}

// ---------------------------------------------------------------------------
// Signal handler
// ---------------------------------------------------------------------------

/**
 * Handle signals emitted by the executor.
 *
 * The executor may forward inbound data as signals to the language.
 */
export async function handleSignal(signalData: string): Promise<void> {
    let signal: unknown;
    try {
        signal = JSON.parse(signalData);
    } catch {
        return; // Not JSON — not our signal
    }

    // Process signal (e.g. inbound record notification)
    if (typeof signal === "object" && signal !== null) {
        const s = signal as Record<string, unknown>;
        if (s.type === "atproto:record") {
            // A new record notification from the executor
            const record = s.record as { uri: string; cid: string; value: Record<string, unknown> } | undefined;
            if (record) {
                const { recordToLink } = await import("./src/translate.js");
                const uriParts = record.uri.replace("at://", "").split("/");
                const authorDid = uriParts[0] || "";
                const link = recordToLink(record.value, authorDid, record.uri, neighbourhoodUrl());
                if (link) {
                    const diff: PerspectiveDiff = { additions: [link], removals: [] };
                    store.applyDiff(diff);
                    if (linkCallback) {
                        linkCallback(diff);
                    }
                }
            }
        }
    }
}
