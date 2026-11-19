/**
 * WebCrypto types for the write path. The repo compiles against ES2022 +
 * Node types (no DOM lib), so the standard WebCrypto interfaces come from
 * Node's `webcrypto` namespace — type-only: esbuild erases this import, and
 * at run time the executor isolate's `globalThis.crypto` is passed in.
 */
import type { webcrypto } from "node:crypto";

export type WebCrypto = webcrypto.Crypto;
export type Jwk = webcrypto.JsonWebKey;
export type Key = webcrypto.CryptoKey;
export type KeyPair = webcrypto.CryptoKeyPair;
