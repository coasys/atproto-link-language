/**
 * XRPC client — all AT Proto API calls.
 *
 * Uses getTransport().fetch() for all HTTP communication.
 * No ad4m:host imports — uses injected Transport.
 */

import { getTransport } from "./transport.js";
import type { TransportResponse } from "./transport.js";
import type {
    ATSession,
    ListRecordsResponse,
    ATRecord,
    RepoWrite,
} from "./types.js";
import {
    buildCreateSessionRequest,
    buildRefreshSessionRequest,
    buildApplyWritesRequest,
    buildListRecordsRequest,
    buildGetRecordRequest,
    buildUploadBlobRequest,
    buildDeleteRecordRequest,
    buildResolveHandleRequest,
    buildCreateRecordRequest,
    parseSessionResponse,
    parseListRecordsResponse,
    parseGetRecordResponse,
    parseResolveHandleResponse,
    parseUploadBlobResponse,
} from "./xrpc.pure.js";

// ---------------------------------------------------------------------------
// XRPC API calls
// ---------------------------------------------------------------------------

/**
 * Authenticate to PDS and create a session.
 */
export async function createSession(
    pdsUrl: string,
    identifier: string,
    password: string,
): Promise<ATSession | null> {
    const req = buildCreateSessionRequest(pdsUrl, identifier, password);
    const response = await getTransport().fetch(req.url, req.method, req.headers, req.body);

    if (response.status >= 200 && response.status < 300) {
        return parseSessionResponse(response.body);
    }
    console.error(`[xrpc] createSession failed: ${response.status} ${response.body}`);
    return null;
}

/**
 * Refresh an existing session.
 */
export async function refreshSession(
    pdsUrl: string,
    refreshJwt: string,
): Promise<ATSession | null> {
    const req = buildRefreshSessionRequest(pdsUrl, refreshJwt);
    const response = await getTransport().fetch(req.url, req.method, req.headers, req.body);

    if (response.status >= 200 && response.status < 300) {
        return parseSessionResponse(response.body);
    }
    console.error(`[xrpc] refreshSession failed: ${response.status} ${response.body}`);
    return null;
}

/**
 * Batch create/update/delete records atomically.
 */
export async function applyWrites(
    pdsUrl: string,
    token: string,
    repo: string,
    writes: RepoWrite[],
): Promise<{ success: boolean; response: TransportResponse }> {
    const req = buildApplyWritesRequest(pdsUrl, token, repo, writes);
    const response = await getTransport().fetch(req.url, req.method, req.headers, req.body);

    const success = response.status >= 200 && response.status < 300;
    if (!success) {
        console.error(`[xrpc] applyWrites failed: ${response.status} ${response.body}`);
    }
    return { success, response };
}

/**
 * List records in a collection with optional cursor pagination.
 */
export async function listRecords(
    pdsUrl: string,
    token: string,
    repo: string,
    collection: string,
    cursor?: string,
    limit: number = 100,
): Promise<ListRecordsResponse | null> {
    const req = buildListRecordsRequest(pdsUrl, token, repo, collection, cursor, limit);
    const response = await getTransport().fetch(req.url, req.method, req.headers, req.body);

    if (response.status >= 200 && response.status < 300) {
        return parseListRecordsResponse(response.body);
    }
    console.error(`[xrpc] listRecords failed: ${response.status} ${response.body}`);
    return null;
}

/**
 * Get a single record by its rkey.
 */
export async function getRecord(
    pdsUrl: string,
    token: string,
    repo: string,
    collection: string,
    rkey: string,
): Promise<ATRecord | null> {
    const req = buildGetRecordRequest(pdsUrl, token, repo, collection, rkey);
    const response = await getTransport().fetch(req.url, req.method, req.headers, req.body);

    if (response.status >= 200 && response.status < 300) {
        return parseGetRecordResponse(response.body);
    }
    console.error(`[xrpc] getRecord failed: ${response.status} ${response.body}`);
    return null;
}

/**
 * Upload a binary blob to the PDS.
 */
export async function uploadBlob(
    pdsUrl: string,
    token: string,
    blob: string,
    mimeType: string = "application/octet-stream",
): Promise<{ ref: { $link: string }; mimeType: string; size: number } | null> {
    const req = buildUploadBlobRequest(pdsUrl, token, mimeType);
    const response = await getTransport().fetch(req.url, req.method, req.headers, blob);

    if (response.status >= 200 && response.status < 300) {
        return parseUploadBlobResponse(response.body);
    }
    console.error(`[xrpc] uploadBlob failed: ${response.status} ${response.body}`);
    return null;
}

/**
 * Resolve a handle to a DID.
 */
export async function resolveHandle(
    pdsUrl: string,
    handle: string,
): Promise<string | null> {
    const req = buildResolveHandleRequest(pdsUrl, handle);
    const response = await getTransport().fetch(req.url, req.method, req.headers, req.body);

    if (response.status >= 200 && response.status < 300) {
        return parseResolveHandleResponse(response.body);
    }
    console.error(`[xrpc] resolveHandle failed: ${response.status} ${response.body}`);
    return null;
}

/**
 * Create a single record.
 */
export async function createRecord(
    pdsUrl: string,
    token: string,
    repo: string,
    collection: string,
    rkey: string,
    record: Record<string, unknown>,
): Promise<{ uri: string; cid: string } | null> {
    const req = buildCreateRecordRequest(pdsUrl, token, repo, collection, rkey, record);
    const response = await getTransport().fetch(req.url, req.method, req.headers, req.body);

    if (response.status >= 200 && response.status < 300) {
        try {
            const data = JSON.parse(response.body);
            return { uri: data.uri, cid: data.cid };
        } catch {
            return null;
        }
    }
    console.error(`[xrpc] createRecord failed: ${response.status} ${response.body}`);
    return null;
}

/**
 * Delete a single record.
 */
export async function deleteRecord(
    pdsUrl: string,
    token: string,
    repo: string,
    collection: string,
    rkey: string,
): Promise<boolean> {
    const req = buildDeleteRecordRequest(pdsUrl, token, repo, collection, rkey);
    const response = await getTransport().fetch(req.url, req.method, req.headers, req.body);

    if (response.status >= 200 && response.status < 300) {
        return true;
    }
    console.error(`[xrpc] deleteRecord failed: ${response.status} ${response.body}`);
    return false;
}
