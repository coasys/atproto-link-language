/**
 * ATProto records -> mount entries (`{class, address, data}`), pure.
 *
 * Identity: the address is the DID-based AT URI without `at://`
 * (`<did>/<collection>/<rkey>`), so equal bodies at different URIs stay
 * distinct and a handle change moves no address. The executor prefixes it
 * with `<language-address>://`; `sourceUri` keeps the original `at://` URI.
 *
 * Data: a few curated scalar fields for model queries, plus `sourceRecord`
 * — the record value as exact compact JSON (lossless numbers, key order,
 * unknown fields and union variants kept). Curated fields never replace
 * the source; anything not curated lives only there.
 *
 * Authorship: `atAuthor` is the repo DID the record was read from. No entry
 * carries an AD4M `author`: the executor signs the mounted links as its own
 * agent, which proves only that this importer observed the record.
 * `verification: "transportTrusted"` says the record was taken from the
 * account's PDS over HTTP without a repository proof.
 */

import { stringifyLossless } from "./lossless-json.js";
import { FOLLOW_NSID, POST_NSID, type AccountRead, type Label, type RawRecord } from "./reader.js";

export interface MountEntry {
    class: string;
    address: string;
    data: Record<string, unknown>;
}

export const VERIFICATION = "transportTrusted";

export function addressOfUri(uri: string): string {
    return uri.slice("at://".length);
}

export function accountAddress(did: string): string {
    return `account/${did}`;
}

const str = (v: unknown): v is string => typeof v === "string";

function common(rec: RawRecord, did: string): Record<string, unknown> {
    return {
        sourceUri: rec.uri,
        cid: rec.cid,
        atAuthor: did,
        collection: rec.collection,
        rkey: rec.rkey,
        verification: VERIFICATION,
        sourceRecord: stringifyLossless(rec.value),
    };
}

function ctsMs(l: Label): number {
    const t = Date.parse(String(l.cts));
    return Number.isNaN(t) ? -Infinity : t;
}

/** Labels currently in force on one record version: matching URI, no CID
 *  or this CID, not expired at `now`, and the latest label per (src, val)
 *  not a negation. */
export function activeLabels(labels: Label[], uri: string, cid: string, now: Date): string[] {
    const latest = new Map<string, Label>();
    for (const l of labels) {
        if (l.uri !== uri) continue;
        if (l.cid !== undefined && l.cid !== cid) continue;
        const k = `${l.src}\u0000${l.val}`;
        const prev = latest.get(k);
        // Instants, not strings: offsets and sub-second precision vary.
        // An unparseable cts sorts oldest.
        if (!prev || ctsMs(l) >= ctsMs(prev)) latest.set(k, l);
    }
    const out = new Set<string>();
    for (const l of latest.values()) {
        if (l.neg) continue;
        if (l.exp !== undefined && Date.parse(l.exp) <= now.getTime()) continue;
        out.add(l.val);
    }
    return [...out].sort();
}

function moderation(data: Record<string, unknown>, rec: RawRecord, labels: Map<string, Label[]> | null, now: Date) {
    const mine = labels?.get(rec.uri);
    if (!mine) {
        // no AppView, a failed lookup, or the AppView has not indexed it
        data.moderation = "unavailable";
        return;
    }
    const active = activeLabels(mine, rec.uri, rec.cid, now);
    data.labels = JSON.stringify(mine);
    data.activeLabels = active;
    data.moderation = active.length ? "labelled" : "none";
}

export function postEntry(rec: RawRecord, did: string, labels: Map<string, Label[]> | null, now: Date): MountEntry {
    const v = rec.value as Record<string, any>;
    const data = common(rec, did);
    if (str(v.text)) data.text = v.text;
    if (str(v.createdAt)) data.postCreatedAt = v.createdAt;
    if (Array.isArray(v.langs) && v.langs.every(str)) data.langs = v.langs;
    const reply = v.reply;
    if (reply && typeof reply === "object") {
        if (str(reply.root?.uri)) data.replyRootUri = reply.root.uri;
        if (str(reply.root?.cid)) data.replyRootCid = reply.root.cid;
        if (str(reply.parent?.uri)) data.replyParentUri = reply.parent.uri;
        if (str(reply.parent?.cid)) data.replyParentCid = reply.parent.cid;
    }
    moderation(data, rec, labels, now);
    return { class: "ATPost", address: addressOfUri(rec.uri), data };
}

export function followEntry(rec: RawRecord, did: string): MountEntry {
    const v = rec.value as Record<string, any>;
    const data = common(rec, did);
    if (str(v.subject) && v.subject.startsWith("did:")) data.subject = v.subject;
    if (str(v.createdAt)) data.followCreatedAt = v.createdAt;
    return { class: "ATFollow", address: addressOfUri(rec.uri), data };
}

export function accountEntry(read: AccountRead): MountEntry {
    const data: Record<string, unknown> = {
        did: read.did,
        pds: read.pds,
        active: read.active,
        status: read.active ? "active" : (read.status ?? "inactive"),
    };
    if (read.handle) data.handle = read.handle;
    if (read.rev) data.repoRev = read.rev;
    if (read.commitCid) data.commitCid = read.commitCid;
    return { class: "ATAccount", address: accountAddress(read.did), data };
}

/** Every entry one complete account read contributes. An inactive account
 *  contributes only its ATAccount entry: its records are hidden. */
export function entriesFor(read: AccountRead, labels: Map<string, Label[]> | null, now: Date): MountEntry[] {
    const out: MountEntry[] = [accountEntry(read)];
    if (!read.active) return out;
    for (const rec of read.records) {
        if (rec.collection === POST_NSID) out.push(postEntry(rec, read.did, labels, now));
        else if (rec.collection === FOLLOW_NSID) out.push(followEntry(rec, read.did));
    }
    return out;
}
