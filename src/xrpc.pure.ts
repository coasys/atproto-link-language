/**
 * Pure XRPC request/response builders — no I/O.
 *
 * Constructs XRPC request objects and parses responses.
 * All HTTP is delegated to the Transport layer via xrpc.ts.
 *
 * Pure functions — no ad4m:host imports. Safe for unit testing.
 */

import type {
    ATSession,
    ListRecordsResponse,
    ATRecord,
    RepoWrite,
} from "./types.js";

// ---------------------------------------------------------------------------
// TID generation (Timestamp-based Identifier)
// ---------------------------------------------------------------------------

/** Base32 sort characters (0-9, a-v) */
const BASE32_CHARS = "234567abcdefghijklmnopqrstuvwxyz";

/**
 * Generate a TID from a timestamp in microseconds.
 *
 * A TID is a 13-character base32-sortable string encoding microsecond
 * timestamps with a 10-bit clock identifier.
 */
export function tidFromTimestamp(timestampUs: bigint, clockId: number = 0): string {
    // TID layout: 54 bits timestamp + 10 bits clock ID = 64 bits
    const combined = (timestampUs << 10n) | BigInt(clockId & 0x3ff);
    let result = "";
    let value = combined;
    for (let i = 0; i < 13; i++) {
        result = BASE32_CHARS[Number(value & 31n)] + result;
        value >>= 5n;
    }
    return result;
}

/**
 * Generate a TID from an ISO timestamp string.
 */
export function tidFromISO(isoTimestamp: string, clockId: number = 0): string {
    const ms = new Date(isoTimestamp).getTime();
    const us = BigInt(ms) * 1000n;
    return tidFromTimestamp(us, clockId);
}

/**
 * Generate a TID for the current time.
 */
export function tidNow(clockId: number = 0): string {
    const us = BigInt(Date.now()) * 1000n;
    return tidFromTimestamp(us, clockId);
}

// ---------------------------------------------------------------------------
// XRPC request builders
// ---------------------------------------------------------------------------

export interface XrpcRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
}

/**
 * Build a createSession request.
 */
export function buildCreateSessionRequest(
    pdsUrl: string,
    identifier: string,
    password: string,
): XrpcRequest {
    return {
        url: `${pdsUrl}/xrpc/com.atproto.server.createSession`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, password }),
    };
}

/**
 * Build a refreshSession request.
 */
export function buildRefreshSessionRequest(
    pdsUrl: string,
    refreshJwt: string,
): XrpcRequest {
    return {
        url: `${pdsUrl}/xrpc/com.atproto.server.refreshSession`,
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${refreshJwt}`,
        },
        body: "",
    };
}

/**
 * Build an applyWrites request.
 */
export function buildApplyWritesRequest(
    pdsUrl: string,
    token: string,
    repo: string,
    writes: RepoWrite[],
): XrpcRequest {
    return {
        url: `${pdsUrl}/xrpc/com.atproto.repo.applyWrites`,
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ repo, writes }),
    };
}

/**
 * Build a listRecords request URL.
 */
export function buildListRecordsRequest(
    pdsUrl: string,
    token: string,
    repo: string,
    collection: string,
    cursor?: string,
    limit: number = 100,
): XrpcRequest {
    let url = `${pdsUrl}/xrpc/com.atproto.repo.listRecords?repo=${encodeURIComponent(repo)}&collection=${encodeURIComponent(collection)}&limit=${limit}`;
    if (cursor) {
        url += `&cursor=${encodeURIComponent(cursor)}`;
    }
    return {
        url,
        method: "GET",
        headers: {
            Authorization: `Bearer ${token}`,
        },
        body: "",
    };
}

/**
 * Build a getRecord request URL.
 */
export function buildGetRecordRequest(
    pdsUrl: string,
    token: string,
    repo: string,
    collection: string,
    rkey: string,
): XrpcRequest {
    const url = `${pdsUrl}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(repo)}&collection=${encodeURIComponent(collection)}&rkey=${encodeURIComponent(rkey)}`;
    return {
        url,
        method: "GET",
        headers: {
            Authorization: `Bearer ${token}`,
        },
        body: "",
    };
}

/**
 * Build an uploadBlob request.
 */
export function buildUploadBlobRequest(
    pdsUrl: string,
    token: string,
    mimeType: string,
): XrpcRequest {
    return {
        url: `${pdsUrl}/xrpc/com.atproto.repo.uploadBlob`,
        method: "POST",
        headers: {
            "Content-Type": mimeType,
            Authorization: `Bearer ${token}`,
        },
        body: "", // actual blob body set by caller
    };
}

/**
 * Build a deleteRecord request.
 */
export function buildDeleteRecordRequest(
    pdsUrl: string,
    token: string,
    repo: string,
    collection: string,
    rkey: string,
): XrpcRequest {
    return {
        url: `${pdsUrl}/xrpc/com.atproto.repo.deleteRecord`,
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ repo, collection, rkey }),
    };
}

/**
 * Build a resolveHandle request.
 */
export function buildResolveHandleRequest(
    pdsUrl: string,
    handle: string,
): XrpcRequest {
    return {
        url: `${pdsUrl}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`,
        method: "GET",
        headers: {},
        body: "",
    };
}

/**
 * Build a createRecord request (single record write).
 */
export function buildCreateRecordRequest(
    pdsUrl: string,
    token: string,
    repo: string,
    collection: string,
    rkey: string,
    record: Record<string, unknown>,
): XrpcRequest {
    return {
        url: `${pdsUrl}/xrpc/com.atproto.repo.createRecord`,
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ repo, collection, rkey, record }),
    };
}

// ---------------------------------------------------------------------------
// Response parsers
// ---------------------------------------------------------------------------

/**
 * Parse a createSession / refreshSession response.
 */
export function parseSessionResponse(body: string): ATSession | null {
    try {
        const data = JSON.parse(body);
        if (data.accessJwt && data.refreshJwt && data.did) {
            return {
                accessJwt: data.accessJwt,
                refreshJwt: data.refreshJwt,
                did: data.did,
                handle: data.handle,
            };
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Parse a listRecords response.
 */
export function parseListRecordsResponse(body: string): ListRecordsResponse | null {
    try {
        const data = JSON.parse(body);
        if (Array.isArray(data.records)) {
            return {
                records: data.records,
                cursor: data.cursor,
            };
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Parse a getRecord response.
 */
export function parseGetRecordResponse(body: string): ATRecord | null {
    try {
        const data = JSON.parse(body);
        if (data.uri && data.value) {
            return {
                uri: data.uri,
                cid: data.cid || "",
                value: data.value,
            };
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Parse a resolveHandle response.
 */
export function parseResolveHandleResponse(body: string): string | null {
    try {
        const data = JSON.parse(body);
        return data.did || null;
    } catch {
        return null;
    }
}

/**
 * Parse an uploadBlob response to get the blob ref.
 */
export function parseUploadBlobResponse(body: string): { ref: { $link: string }; mimeType: string; size: number } | null {
    try {
        const data = JSON.parse(body);
        if (data.blob) {
            return data.blob;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Extract the rkey from an AT URI.
 * e.g. "at://did:plc:abc/ad4m.link.triple/3k2abc" → "3k2abc"
 */
export function rkeyFromUri(uri: string): string {
    const parts = uri.split("/");
    return parts[parts.length - 1];
}

/**
 * Extract the collection from an AT URI.
 * e.g. "at://did:plc:abc/ad4m.link.triple/3k2abc" → "ad4m.link.triple"
 */
export function collectionFromUri(uri: string): string {
    const parts = uri.replace("at://", "").split("/");
    return parts.length >= 2 ? parts[1] : "";
}

/**
 * Build an AT URI from components.
 */
export function buildAtUri(did: string, collection: string, rkey: string): string {
    return `at://${did}/${collection}/${rkey}`;
}

/**
 * Extract the DID from an AT URI.
 */
export function didFromUri(uri: string): string {
    const stripped = uri.replace("at://", "");
    const slashIndex = stripped.indexOf("/");
    return slashIndex >= 0 ? stripped.substring(0, slashIndex) : stripped;
}
