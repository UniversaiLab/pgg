import { describe, expect, test } from 'bun:test';
import { toHex as viemToHex } from 'viem';
import { privateKeyToAccount, sign as viemSign } from 'viem/accounts';
import {
  fromHex,
  keccak256,
  newPrivateKey,
  privateKeyToAddress,
  recoverSigner,
  signDigest,
  toHex,
} from '../src/sign.js';

const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

describe('signDigest', () => {
  test('is byte-identical to viem for 200 random keys and digests', async () => {
    for (let i = 0; i < 200; i++) {
      const key = viemToHex(rand(32));
      const digest = viemToHex(rand(32));
      const v = await viemSign({ hash: digest, privateKey: key, to: 'object' });
      const expected = `${v.r}${v.s.slice(2)}${(27 + Number(v.yParity)).toString(16)}`;
      expect(signDigest(key, digest)).toBe(expected);
    }
  });

  test('is deterministic: the same digest signs to the same bytes', () => {
    const key = newPrivateKey();
    const digest = toHex(rand(32));
    expect(signDigest(key, digest)).toBe(signDigest(key, digest));
  });

  test('always produces 65 bytes with v 27/28 and low-s', () => {
    const half = N >> 1n;
    for (let i = 0; i < 200; i++) {
      const sig = fromHex(signDigest(newPrivateKey(), toHex(rand(32))));
      expect(sig.length).toBe(65);
      expect([27, 28]).toContain(sig[64]);
      expect(BigInt(toHex(sig.subarray(32, 64))) <= half).toBe(true);
    }
  });

  test('signs the digest itself, not sha256 of it (prehash off)', async () => {
    const key = viemToHex(rand(32));
    const digest = viemToHex(rand(32));
    const account = privateKeyToAccount(key);
    expect(recoverSigner(digest, signDigest(key, digest))).toBe(account.address.toLowerCase());
  });

  test('rejects a digest that is not 32 bytes', () => {
    expect(() => signDigest(newPrivateKey(), toHex(rand(31)))).toThrow(RangeError);
  });
});

describe('recoverSigner', () => {
  test('recovers the signer address (lowercase) for random keys', () => {
    for (let i = 0; i < 100; i++) {
      const key = newPrivateKey();
      const digest = toHex(rand(32));
      expect(recoverSigner(digest, signDigest(key, digest))).toBe(privateKeyToAddress(key));
    }
  });

  test('matches viem addresses', () => {
    const key = viemToHex(rand(32));
    expect(privateKeyToAddress(key)).toBe(privateKeyToAccount(key).address.toLowerCase());
  });

  test('returns null for everything the contract would reject', () => {
    const key = newPrivateKey();
    const digest = toHex(rand(32));
    const good = fromHex(signDigest(key, digest));
    const withV = (v) => {
      const copy = good.slice();
      copy[64] = v;
      return toHex(copy);
    };
    expect(recoverSigner(digest, toHex(good.subarray(0, 64)))).toBeNull(); // 64 bytes
    expect(recoverSigner(digest, `${toHex(good)}00`)).toBeNull(); // 66 bytes
    expect(recoverSigner(digest, withV(0))).toBeNull();
    expect(recoverSigner(digest, withV(1))).toBeNull();
    expect(recoverSigner(digest, withV(29))).toBeNull();
    expect(recoverSigner(digest, withV(good[64] === 27 ? 28 : 27))).not.toBe(
      privateKeyToAddress(key),
    );

    const s = BigInt(toHex(good.subarray(32, 64)));
    const high = good.slice();
    high.set(fromHex(`0x${(N - s).toString(16).padStart(64, '0')}`), 32);
    high[64] = good[64] === 27 ? 28 : 27; // the flipped-s twin that recovers to the same key in ECDSA
    expect(recoverSigner(digest, toHex(high))).toBeNull(); // high-s

    const zeroR = good.slice();
    zeroR.fill(0, 0, 32);
    expect(recoverSigner(digest, toHex(zeroR))).toBeNull();
    const zeroS = good.slice();
    zeroS.fill(0, 32, 64);
    expect(recoverSigner(digest, toHex(zeroS))).toBeNull();
    expect(recoverSigner(digest, 'not hex')).toBeNull();
  });

  test('a signature over another digest recovers to a different address', () => {
    const key = newPrivateKey();
    const sig = signDigest(key, toHex(rand(32)));
    expect(recoverSigner(toHex(rand(32)), sig)).not.toBe(privateKeyToAddress(key));
  });
});

describe('helpers', () => {
  test('keccak256 of empty input is the well-known constant', () => {
    expect(toHex(keccak256(new Uint8Array()))).toBe(
      '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
    );
  });
  test('fromHex rejects odd length and missing prefix', () => {
    expect(() => fromHex('0x123')).toThrow(TypeError);
    expect(() => fromHex('1234')).toThrow(TypeError);
  });
});
