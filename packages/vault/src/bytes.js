// Small byte and word helpers shared by the hashing code. Internal: not exported from index.js.
// Everything here works on plain Uint8Array and BigInt so it runs unchanged in the browser.
import { fromHex, keccak256, toHex } from './sign.js';

export const UINT64_MAX = (1n << 64n) - 1n;
export const UINT256_MAX = (1n << 256n) - 1n;

const encoder = new TextEncoder();
export const utf8 = (text) => encoder.encode(text);

/** keccak256 of bytes, as a '0x' + 64 hex string. */
export const keccakHex = (bytes) => toHex(keccak256(bytes));

export function concat(parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** A uint as one 32-byte big-endian word. The caller has already range-checked it. */
export const uintWord = (value) => fromHex(`0x${value.toString(16).padStart(64, '0')}`);

export const boolWord = (value) => uintWord(value ? 1n : 0n);

/** An address (any case) as a 32-byte word: 12 zero bytes, then the 20 address bytes. */
export const addressWord = (address) => fromHex(`0x${'00'.repeat(12)}${address.slice(2)}`);

/** A bytes32 given as 0x hex. */
export const bytes32Word = (hex) => fromHex(hex);
