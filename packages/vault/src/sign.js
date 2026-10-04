// The only file that touches @noble/curves. Everything about the signature format the vault expects lives
// here, so a change in the library's behaviour changes one file and one test.
//
// What PokerVault.sol accepts (OpenZeppelin ECDSA.recoverCalldata): exactly 65 bytes r || s || v, with v 27
// or 28, a non-zero r and s, and s in the lower half of the curve order. What noble-curves 2.x offers:
// sign() hashes the message with sha256 unless told not to (we pass an EIP-712 digest, so prehash is
// false), is deterministic (RFC 6979, so signing the same digest twice gives the same bytes), enforces
// low-s, and its 'recovered' format puts the recovery byte FIRST. Verified byte-for-byte against viem in
// test/sign.test.js.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

const HALF_ORDER = secp256k1.Point.CURVE().n >> 1n;

export const keccak256 = (bytes) => keccak_256(bytes);

/** '0x…' string -> bytes. Throws on anything that is not even-length hex. */
export function fromHex(value) {
  if (typeof value !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(value)) {
    throw new TypeError('expected a 0x-prefixed hex string');
  }
  return hexToBytes(value.slice(2));
}

export const toHex = (bytes) => `0x${bytesToHex(bytes)}`;

/** Lowercase 0x address of an uncompressed (65-byte) or compressed public key. */
export function publicKeyToAddress(publicKey) {
  const uncompressed =
    publicKey.length === 65 ? publicKey : secp256k1.Point.fromBytes(publicKey).toBytes(false);
  return toHex(keccak_256(uncompressed.slice(1)).slice(-20));
}

export function privateKeyToAddress(privateKey) {
  const key = typeof privateKey === 'string' ? fromHex(privateKey) : privateKey;
  return publicKeyToAddress(secp256k1.getPublicKey(key, false));
}

/** A fresh random secp256k1 key from the platform CSPRNG (works over plain HTTP, unlike crypto.subtle). */
export function newPrivateKey() {
  return toHex(secp256k1.utils.randomSecretKey());
}

/**
 * Sign a 32-byte digest. Returns '0x' + r || s || v (65 bytes), v 27 or 28, low-s.
 * Deterministic: the same key and digest always give the same bytes.
 */
export function signDigest(privateKey, digest) {
  const key = typeof privateKey === 'string' ? fromHex(privateKey) : privateKey;
  const hash = typeof digest === 'string' ? fromHex(digest) : digest;
  if (hash.length !== 32) throw new RangeError('digest must be 32 bytes');
  const recovered = secp256k1.sign(hash, key, { prehash: false, format: 'recovered' });
  // noble: [recovery, r(32), s(32)]  ->  vault: [r(32), s(32), 27 + recovery]
  const out = new Uint8Array(65);
  out.set(recovered.subarray(1), 0);
  out[64] = 27 + recovered[0];
  return toHex(out);
}

/**
 * The signer of `digest`, or null for anything PokerVault would reject: wrong length, v outside
 * {27, 28}, zero r or s, high-s, or a signature that recovers to nothing.
 */
export function recoverSigner(digest, signature) {
  try {
    const hash = typeof digest === 'string' ? fromHex(digest) : digest;
    const sig = typeof signature === 'string' ? fromHex(signature) : signature;
    if (hash.length !== 32 || sig.length !== 65) return null;
    const v = sig[64];
    if (v !== 27 && v !== 28) return null;
    const r = BigInt(toHex(sig.subarray(0, 32)));
    const s = BigInt(toHex(sig.subarray(32, 64)));
    if (r === 0n || s === 0n || s > HALF_ORDER) return null;
    const recovered = new Uint8Array(65);
    recovered[0] = v - 27;
    recovered.set(sig.subarray(0, 64), 1);
    const publicKey = secp256k1.recoverPublicKey(recovered, hash, { prehash: false });
    return publicKeyToAddress(publicKey);
  } catch {
    return null;
  }
}
