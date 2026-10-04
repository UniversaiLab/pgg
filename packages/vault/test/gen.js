// Seeded random data for the tests. A fixed seed gives the same states on every run, so a failure
// reproduces; the library itself never uses randomness except newPrivateKey.
import { toHex } from '../src/sign.js';

/** mulberry32: 32 bits of state, plenty for test data. */
export function makeRng(seed) {
  let a = seed >>> 0;
  const u32 = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  const rng = {
    u32,
    /** Integer in [0, n). */
    int: (n) => u32() % n,
    bool: (p = 0.5) => u32() / 2 ** 32 < p,
    pick: (list) => list[u32() % list.length],
    bytes(n) {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = u32() & 0xff;
      return out;
    },
    hex: (n) => toHex(rng.bytes(n)),
    /** A uniformly random integer with up to `bits` bits. */
    bigint(bits) {
      let value = 0n;
      for (let i = 0; i < bits; i += 32) value = (value << 32n) | BigInt(u32());
      return value & ((1n << BigInt(bits)) - 1n);
    },
  };
  return rng;
}

export const UINT64_MAX = (1n << 64n) - 1n;
export const UINT256_MAX = (1n << 256n) - 1n;

/** `n` distinct random addresses, lowercase, strictly ascending (the order a roster must have). */
export function randomRoster(rng, n) {
  const seen = new Set();
  while (seen.size < n) {
    const address = rng.hex(20);
    if (BigInt(address) !== 0n) seen.add(address);
  }
  return [...seen].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
}

const AMOUNT_BITS = [0, 1, 8, 24, 32, 64, 96, 128, 200, 256];

/** A random valid State; extreme values show up often on purpose. */
export function randomState(rng, { players } = {}) {
  const n = players ?? 2 + rng.int(9);
  const amount = () => {
    const bits = rng.pick(AMOUNT_BITS);
    return bits === 256 && rng.bool(0.3) ? UINT256_MAX : rng.bigint(bits);
  };
  return {
    tableId: rng.hex(32),
    nonce: rng.bool(0.15) ? UINT64_MAX : rng.bool(0.15) ? BigInt(rng.int(3)) : rng.bigint(64),
    isFinal: rng.bool(),
    players: randomRoster(rng, n),
    balances: Array.from({ length: n }, amount),
    keep: Array.from({ length: n }, () => rng.bool()),
    rake: amount(),
    volume: amount(),
  };
}

export const randomDomain = (rng) => ({
  chainId: 1 + rng.int(2 ** 31),
  verifyingContract: rng.hex(20),
});
