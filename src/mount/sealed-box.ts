/**
 * Sealing to the executor agent's DID, in the executor's own format
 * (`rust-executor/src/agent/sealed_box.rs`, opened by the `agentOpenSealed`
 * host import): an ephemeral X25519 key, ECDH with the X25519 form of the
 * agent's Ed25519 `did:key`, HKDF-SHA256(shared, salt = ephemeral public ‖
 * recipient public, info = "ad4m:sealed-box:v1") as an AES-256-GCM key, a
 * random 12-byte nonce; every field hex.
 *
 * Anyone can seal to a DID; only the executor holding the agent's key opens.
 * The write path keeps OAuth tokens and DPoP keys only in such boxes, so
 * host storage (a plain JSON file in the executor's data dir) never holds
 * a credential in clear.
 */

import type { KeyPair, WebCrypto } from "./webcrypto.js";

import { base58Decode, hex, utf8 } from "./bytes.js";

export interface SealedBox {
    ephemeralPublicKey: string;
    nonce: string;
    ciphertext: string;
}

export const SEALED_BOX_INFO = "ad4m:sealed-box:v1";

const P = 2n ** 255n - 19n;
const mod = (a: bigint) => ((a % P) + P) % P;
function pow(b: bigint, e: bigint): bigint {
    let r = 1n;
    b = mod(b);
    while (e > 0n) {
        if (e & 1n) r = (r * b) % P;
        b = (b * b) % P;
        e >>= 1n;
    }
    return r;
}

/** The X25519 public key of an Ed25519 `did:key` (RFC 7748 birational map,
 *  u = (1 + y) / (1 − y), libsodium's crypto_sign_ed25519_pk_to_curve25519). */
export function x25519PublicOfDidKey(did: string): Uint8Array {
    const id = did.split("#")[0];
    if (!id.startsWith("did:key:z6Mk")) throw new Error(`not an Ed25519 did:key: ${did}`);
    let bytes: Uint8Array;
    try {
        bytes = base58Decode(id.slice("did:key:z".length));
    } catch {
        throw new Error(`not an Ed25519 did:key: ${did}`);
    }
    if (bytes.length !== 34 || bytes[0] !== 0xed || bytes[1] !== 0x01) throw new Error(`not an Ed25519 did:key: ${did}`);
    const ed = bytes.subarray(2);
    let y = 0n;
    for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? ed[i] & 0x7f : ed[i]);
    if (y >= P || mod(1n - y) === 0n) throw new Error(`not a usable Ed25519 did:key: ${did}`);
    let u = mod((1n + y) * pow(1n - y, P - 2n));
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
        out[i] = Number(u & 255n);
        u >>= 8n;
    }
    return out;
}

export async function sealToDid(did: string, plaintext: string, crypto: WebCrypto): Promise<SealedBox> {
    const s = crypto.subtle;
    const recipient = x25519PublicOfDidKey(did);
    const eph = (await s.generateKey({ name: "X25519" } as any, true, ["deriveBits"])) as KeyPair;
    const ephPub = new Uint8Array(await s.exportKey("raw", eph.publicKey));
    const rk = await s.importKey("raw", recipient, { name: "X25519" } as any, false, []);
    const shared = new Uint8Array(await s.deriveBits({ name: "X25519", public: rk } as any, eph.privateKey, 256));
    if (shared.every((b) => b === 0)) throw new Error("sealed box: low-order recipient key");
    const salt = new Uint8Array(64);
    salt.set(ephPub, 0);
    salt.set(recipient, 32);
    const hk = await s.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
    const keyBits = await s.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: utf8(SEALED_BOX_INFO) }, hk, 256);
    const aes = await s.importKey("raw", keyBits, "AES-GCM", false, ["encrypt"]);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ct = await s.encrypt({ name: "AES-GCM", iv: nonce }, aes, utf8(plaintext));
    return { ephemeralPublicKey: hex(ephPub), nonce: hex(nonce), ciphertext: hex(ct) };
}
