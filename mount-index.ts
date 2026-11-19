/**
 * # ATProto mounted language (spike, slices 1 + 2)
 *
 * A separate entry point beside the link language (`index.ts`, untouched).
 * Mounted into a perspective with the Acorn-stack mount API
 * (`perspective.mount`), it shows public `app.bsky.feed.post` and
 * `app.bsky.graph.follow` records of an explicit DID allowlist as the model
 * classes ATPost / ATFollow / ATAccount (slice 1), and publishes a
 * plain-text post only when asked explicitly: `createSubject("ATPost",
 * {text, atAuthor, publicationKey})` runs ATPost's `call` constructor
 * (acorn a2) -> `<lang>://class/ATPost` `publish` -> createRecord under
 * atproto OAuth (slice 2; src/mount/{oauth,publisher}.ts).
 *
 * Contract (ad4m acorn/a9-mount-lifecycle): `mountShapes()` and
 * `mountSnapshot()` through the LDK `mount` capability; the executor
 * expands entries into its own `Local` links and sweeps addresses the
 * snapshot omits. Interactions: src/mount/service.ts.
 *
 * Credentials: OAuth tokens and DPoP keys exist only sealed to the executor
 * agent in host storage (src/mount/vault.ts), keyed per agent and AT
 * account; never in a template variable, the bundle, a log or a result.
 * Not used here: src/mst.ts, the OR-set, native post projection, app
 * passwords.
 *
 * Template variables (set by `language.applyTemplateLocal`; emitted as the
 * bundle banner by mount-build.mjs from mount-template.mjs, so esbuild never
 * renames them). All public settings:
 *   ACCOUNTS    comma-separated account DIDs (the allowlist)
 *   PLC_URL     PLC directory for did:plc
 *   APPVIEW_URL AppView for labels; "" = moderation unavailable
 *   POLL_MS     minimum interval between PDS reads from mountSnapshot()
 *   ALLOW_HTTP  "1" admits http:// PDS/PLC/AppView/OAuth URLs — a local dev
 *               network only; default "" = https only. Not SSRF protection.
 */

import {
    defineLanguage,
    httpFetch,
    storageGet,
    storagePut,
    storageDelete,
    emitSignal,
    agentDid,
    agentOpenSealed,
    languageAddress,
} from "@coasys/ad4m-ldk";

import type { Transport, TransportResponse } from "./src/adapters.js";
import { MountService } from "./src/mount/service.js";
import { allowHttpSetting } from "./src/mount/reader.js";

declare const ACCOUNTS: string;
declare const PLC_URL: string;
declare const APPVIEW_URL: string;
declare const POLL_MS: string;
declare const ALLOW_HTTP: string;

/** `httpFetch` on the Acorn stack resolves `{status, body}` for every HTTP
 *  status (older hosts returned the body and threw on non-2xx); a network
 *  failure or its 10 s timeout rejects. Used for every read. */
class HostTransport implements Transport {
    async fetch(url: string, method: string, headers: Record<string, string>, body: string): Promise<TransportResponse> {
        const r: any = await httpFetch(url, method, JSON.stringify(headers), body);
        if (r && typeof r === "object" && typeof r.status === "number") {
            return { status: r.status, headers: {}, body: String(r.body ?? "") };
        }
        return { status: 200, headers: {}, body: String(r ?? "") };
    }
}

const WRITE_TIMEOUT_MS = 10_000;
const MAX_REPLY_BYTES = 1024 * 1024;

/** OAuth and PDS writes need a response header (DPoP-Nonce) that the host's
 *  `httpFetch` does not return, so they use the isolate's `fetch` — the same
 *  global `httpFetch` wraps — with the same kind of bounds: a deadline and a
 *  reply cap. Redirects are not followed (a DPoP proof is bound to its URL,
 *  and credentials must not follow a redirect). Errors name only method and
 *  origin + path: never a header or body (tokens, verifier). */
class HeaderTransport implements Transport {
    async fetch(url: string, method: string, headers: Record<string, string>, body: string): Promise<TransportResponse> {
        const where = (() => {
            try {
                const u = new URL(url);
                return `${u.origin}${u.pathname}`;
            } catch {
                return "<unparseable url>";
            }
        })();
        const signal = AbortSignal.timeout(WRITE_TIMEOUT_MS + 2_000);
        let res: Response;
        try {
            res = await globalThis.fetch(url, {
                method, headers, signal, redirect: "manual",
                ...(method !== "GET" && method !== "HEAD" && body ? { body } : {}),
            });
        } catch {
            throw new Error(`${method} ${where} failed${signal.aborted ? ": timed out" : " (network error)"}`);
        }
        const out: Record<string, string> = {};
        res.headers.forEach((v, k) => (out[k.toLowerCase()] = v));
        const reader = res.body?.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        if (reader) {
            for (;;) {
                const step = await reader.read();
                if (step.done) break;
                total += step.value.byteLength;
                if (total > MAX_REPLY_BYTES) {
                    reader.cancel().catch(() => {});
                    throw new Error(`${method} ${where}: reply larger than ${MAX_REPLY_BYTES} bytes`);
                }
                chunks.push(step.value);
            }
        }
        const all = new Uint8Array(total);
        let at = 0;
        for (const c of chunks) {
            all.set(c, at);
            at += c.byteLength;
        }
        return { status: res.status, headers: out, body: new TextDecoder().decode(all) };
    }
}

const storage = {
    get: (k: string) => storageGet(k) ?? null,
    put: (k: string, v: string) => storagePut(k, v),
    delete: (k: string) => storageDelete(k),
};

let service: MountService | null = null;
let lastReadAt = 0;
const pollMs = () => {
    const n = Number(POLL_MS);
    return Number.isFinite(n) && n >= 0 ? n : 60000;
};

function theService(): MountService {
    if (!service) throw new Error("atproto mounted language: not initialised");
    return service;
}

async function refreshNow() {
    lastReadAt = Date.now();
    return theService().refresh();
}

const language = defineLanguage({
    name: "atproto-mounted-reader",
    version: "0.2.0",
    isPublic: false,

    async init() {
        const accounts = String(ACCOUNTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        service = new MountService({
            accounts,
            plcUrl: PLC_URL || "https://plc.directory",
            appviewUrl: APPVIEW_URL || "",
            transport: new HostTransport(),
            writeTransport: new HeaderTransport(),
            storage,
            crypto: globalThis.crypto,
            agent: { did: () => agentDid(), openSealed: (box) => agentOpenSealed(box) },
            languageAddress: () => languageAddress(),
            timeoutMs: 15000,
            writeTimeoutMs: WRITE_TIMEOUT_MS,
            pageLimit: 100,
            maxPages: 50,
            allowHttp: allowHttpSetting(ALLOW_HTTP),
        });
    },

    interactions(address: string) {
        const svc = theService();
        return svc.interactions(address).map((i) => {
            if (address === "project" && i.name === "refresh") {
                return {
                    name: i.name, label: i.label, parameters: [],
                    execute: async () => {
                        const report = await refreshNow();
                        const { changed, removed } = report.delta;
                        if (changed.length || removed.length) emitSignal({ mountDelta: { changed, removed } });
                        return report;
                    },
                };
            }
            if (address === "project" && i.name === "status") {
                return { name: i.name, label: i.label, parameters: [], execute: async () => svc.status({ pollMs: pollMs() }) };
            }
            return { name: i.name, label: i.label, parameters: [], execute: (p: unknown) => i.execute(p) };
        });
    },

    mount: {
        shapes: () => theService().shapes(),
        // Bounded polling: the executor resyncs every 15 s; the PDS is read
        // at most every POLL_MS. A failed read serves the last complete
        // snapshot (state.ts), so the sweep never removes on a failure.
        // Never writes: publication is only the ATPost constructor's call.
        async snapshot() {
            const svc = theService();
            if (!svc.reader.lastReport || Date.now() - lastReadAt >= pollMs()) await refreshNow();
            return svc.snapshot();
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
