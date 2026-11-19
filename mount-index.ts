/**
 * # ATProto mounted reader (spike, slice 1)
 *
 * A separate, read-only entry point beside the link language (`index.ts`,
 * untouched). Mounted into a perspective with the Acorn-stack mount API
 * (`perspective.mount`), it shows public `app.bsky.feed.post` and
 * `app.bsky.graph.follow` records of an explicit DID allowlist as the
 * read-only model classes ATPost / ATFollow / ATAccount.
 *
 * Contract (ad4m acorn/a9-mount-lifecycle): `mountShapes()` and
 * `mountSnapshot()` through the LDK `mount` capability; the executor
 * expands entries into its own `Local` links and sweeps addresses the
 * snapshot omits. Interactions on `<lang>://project`: `refresh` (read every
 * account now, push the delta) and `status`. No write interaction exists.
 *
 * Not used here: src/mst.ts, the OR-set, native post projection, app
 * passwords, OAuth. No credential is configured or stored.
 *
 * Template variables (set by `language.applyTemplateLocal`; emitted as the
 * bundle banner by mount-build.mjs, so esbuild never renames them):
 *   ACCOUNTS    comma-separated account DIDs (the allowlist)
 *   PLC_URL     PLC directory for did:plc
 *   APPVIEW_URL AppView for labels; "" = moderation unavailable
 *   POLL_MS     minimum interval between PDS reads from mountSnapshot()
 *   ALLOW_HTTP  "1" admits http:// PDS/PLC/AppView URLs — a local dev
 *               network only; default "" = https only. Not SSRF protection.
 */

import {
    defineLanguage,
    httpFetch,
    storageGet,
    storagePut,
    storageDelete,
    emitSignal,
} from "@coasys/ad4m-ldk";

import type { Transport, TransportResponse } from "./src/adapters.js";
import { MountedReader } from "./src/mount/state.js";
import { allowHttpSetting } from "./src/mount/reader.js";
import { mountShapes as atprotoShapes } from "./src/mount/shapes.js";

declare const ACCOUNTS: string;
declare const PLC_URL: string;
declare const APPVIEW_URL: string;
declare const POLL_MS: string;
declare const ALLOW_HTTP: string;

/** `httpFetch` on the Acorn stack resolves `{status, body}` for every HTTP
 *  status (older hosts returned the body and threw on non-2xx); a network
 *  failure or its 10 s timeout rejects. */
class HostTransport implements Transport {
    async fetch(url: string, method: string, headers: Record<string, string>, body: string): Promise<TransportResponse> {
        const r: any = await httpFetch(url, method, JSON.stringify(headers), body);
        if (r && typeof r === "object" && typeof r.status === "number") {
            return { status: r.status, headers: {}, body: String(r.body ?? "") };
        }
        return { status: 200, headers: {}, body: String(r ?? "") };
    }
}

const storage = {
    get: (k: string) => storageGet(k) ?? null,
    put: (k: string, v: string) => storagePut(k, v),
    delete: (k: string) => storageDelete(k),
};

let reader: MountedReader | null = null;
let lastReadAt = 0;
const pollMs = () => {
    const n = Number(POLL_MS);
    return Number.isFinite(n) && n >= 0 ? n : 60000;
};

function theReader(): MountedReader {
    if (!reader) throw new Error("atproto mounted reader: not initialised");
    return reader;
}

async function refreshNow() {
    lastReadAt = Date.now();
    return theReader().refresh();
}

function status() {
    const r = theReader();
    return {
        accounts: r.accounts,
        plcUrl: PLC_URL,
        appviewUrl: APPVIEW_URL || null,
        moderation: APPVIEW_URL ? "appview" : "unavailable",
        pollMs: pollMs(),
        allowHttp: allowHttpSetting(ALLOW_HTTP),
        lastReport: r.lastReport,
        writes: "none (read-only slice)",
    };
}

const language = defineLanguage({
    name: "atproto-mounted-reader",
    version: "0.1.0",
    isPublic: false,

    async init() {
        const accounts = String(ACCOUNTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        reader = new MountedReader({
            accounts,
            plcUrl: PLC_URL || "https://plc.directory",
            appviewUrl: APPVIEW_URL || "",
            transport: new HostTransport(),
            storage,
            timeoutMs: 15000,
            pageLimit: 100,
            maxPages: 50,
            allowHttp: allowHttpSetting(ALLOW_HTTP),
        });
    },

    interactions(address: string) {
        if (address !== "project") return [];
        return [
            {
                name: "refresh",
                label: "Read every allowlisted account now",
                parameters: [],
                execute: async () => {
                    const report = await refreshNow();
                    const { changed, removed } = report.delta;
                    if (changed.length || removed.length) emitSignal({ mountDelta: { changed, removed } });
                    return report;
                },
            },
            {
                name: "status",
                label: "Allowlist, endpoints and the last refresh report",
                parameters: [],
                execute: async () => status(),
            },
        ];
    },

    mount: {
        shapes: () => atprotoShapes(),
        // Bounded polling: the executor resyncs every 15 s; the PDS is read
        // at most every POLL_MS. A failed read serves the last complete
        // snapshot (state.ts), so the sweep never removes on a failure.
        async snapshot() {
            const r = theReader();
            if (!r.lastReport || Date.now() - lastReadAt >= pollMs()) await refreshNow();
            return r.snapshot();
        },
    },
});

export const {
    name,
    version,
    init,
    teardown,
    isPublic,
    interactions,
    mountShapes,
    mountSnapshot,
} = language;

export default language;
