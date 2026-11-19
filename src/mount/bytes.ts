/**
 * Small byte helpers for the write path (no Node or Deno API: the bundle
 * runs in the executor's language isolate, the tests in Node 18/22).
 */

import type { WebCrypto } from "./webcrypto.js";

export function utf8(s: string): Uint8Array {
    return new TextEncoder().encode(s);
}

export function fromUtf8(b: Uint8Array): string {
    return new TextDecoder().decode(b);
}

export function hex(b: Uint8Array | ArrayBuffer): string {
    return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function unhex(s: string): Uint8Array {
    if (!/^(?:[0-9a-fA-F]{2})*$/.test(s)) throw new Error("not hex");
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
    return out;
}

const B64U = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function b64u(input: Uint8Array | ArrayBuffer | string): string {
    const b = typeof input === "string" ? utf8(input) : new Uint8Array(input);
    let out = "";
    for (let i = 0; i < b.length; i += 3) {
        const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
        out += B64U[(n >> 18) & 63] + B64U[(n >> 12) & 63];
        if (i + 1 < b.length) out += B64U[(n >> 6) & 63];
        if (i + 2 < b.length) out += B64U[n & 63];
    }
    return out;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Decode(s: string): Uint8Array {
    let n = 0n;
    for (const c of s) {
        const i = B58.indexOf(c);
        if (i < 0) throw new Error("not base58");
        n = n * 58n + BigInt(i);
    }
    const out: number[] = [];
    while (n > 0n) {
        out.unshift(Number(n & 255n));
        n >>= 8n;
    }
    for (const c of s) {
        if (c !== "1") break;
        out.unshift(0);
    }
    return new Uint8Array(out);
}

export function randomB64u(crypto: WebCrypto, bytes: number): string {
    return b64u(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256B64u(crypto: WebCrypto, text: string): Promise<string> {
    return b64u(await crypto.subtle.digest("SHA-256", utf8(text)));
}

export async function sha256Hex(crypto: WebCrypto, text: string): Promise<string> {
    return hex(await crypto.subtle.digest("SHA-256", utf8(text)));
}

const TID_ALPHABET = "234567abcdefghijklmnopqrstuvwxyz";

/** An atproto TID: 64 bits (top bit 0) = 53 bits of microseconds since the
 *  epoch + 10 bits of clock id, as 13 base32-sortable characters. */
export function newTid(nowMs: number, clockId: number): string {
    let v = (BigInt(Math.floor(nowMs)) * 1000n) << 10n;
    v |= BigInt(clockId & 1023);
    let out = "";
    for (let i = 0; i < 13; i++) {
        out = TID_ALPHABET[Number(v & 31n)] + out;
        v >>= 5n;
    }
    return out;
}

function tidMicros(tid: string): bigint | null {
    if (!/^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/.test(tid)) return null;
    let v = 0n;
    for (const c of tid) v = (v << 5n) | BigInt(TID_ALPHABET.indexOf(c));
    return v >> 10n;
}

/** A monotonic TID allocator (round 2 #5). The microsecond field is
 *  max(clock, last + 1): within one millisecond, or when the wall clock
 *  steps back, each TID is the previous one plus a microsecond, so TIDs
 *  from one allocator are unique and strictly increasing. The 10-bit clock
 *  id is fixed per allocator (random per process), which separates
 *  allocators that happen to share a microsecond. `observe` raises the
 *  floor to a TID already used (the ledger's rkeys after a restart). */
export class TidClock {
    private last = -1n;
    constructor(private readonly clockId: number) {}

    observe(tid: string): void {
        const us = tidMicros(tid);
        if (us !== null && us > this.last) this.last = us;
    }

    next(nowMs: number): string {
        let us = BigInt(Math.floor(nowMs)) * 1000n;
        if (us <= this.last) us = this.last + 1n;
        this.last = us;
        let v = (us << 10n) | BigInt(this.clockId & 1023);
        let out = "";
        for (let i = 0; i < 13; i++) {
            out = TID_ALPHABET[Number(v & 31n)] + out;
            v >>= 5n;
        }
        return out;
    }
}
