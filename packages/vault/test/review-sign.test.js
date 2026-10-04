// Adversarial review of sign.js: the signature format PokerVault accepts (OpenZeppelin ECDSA.recoverCalldata)
// against what the library produces and what it says about signatures it is handed. The contract-side
// differential (the same signatures sent to a real vault) is in review-chain.test.js.
import { describe, expect, test } from 'bun:test';
import { hexToBytes, recoverAddress, keccak256 as viemKeccak, toHex as viemToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  fromHex,
  keccak256,
  newPrivateKey,
  privateKeyToAddress,
  publicKeyToAddress,
  recoverSigner,
  signDigest,
  toHex,
  tryRecoverSigner,
} from '../src/sign.js';
import { makeRng } from './gen.js';

const ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HALF = ORDER >> 1n;
const word = (n) => n.toString(16).padStart(64, '0');
const join = (r, s, v) => `0x${word(r)}${word(s)}${v.toString(16).padStart(2, '0')}`;
const parts = (sig) => ({
  r: BigInt(`0x${sig.slice(2, 66)}`),
  s: BigInt(`0x${sig.slice(66, 130)}`),
  v: Number.parseInt(sig.slice(130, 132), 16),
});

const KEY = `0x${'0'.repeat(63)}1`;
const DIGEST = `0x${'ab'.repeat(32)}`;
const good = signDigest(KEY, DIGEST);

describe('keys and addresses', () => {
  test('known answers: private key 1 and 2 (the generator and its double)', () => {
    expect(privateKeyToAddress(KEY)).toBe('0x7e5f4552091a69125d5dfcb7b8c2659029395bdf');
    expect(privateKeyToAddress(`0x${'0'.repeat(63)}2`)).toBe(
      '0x2b5ad5c4795c026514f8317c7a215e218dccd6cf',
    );
  });

  test('the largest valid key (n - 1) works and agrees with viem; 0, n and above are refused', () => {
    const top = `0x${word(ORDER - 1n)}`;
    expect(privateKeyToAddress(top)).toBe(privateKeyToAccount(top).address.toLowerCase());
    expect(() => privateKeyToAddress(`0x${word(0n)}`)).toThrow();
    expect(() => privateKeyToAddress(`0x${word(ORDER)}`)).toThrow();
    expect(() => privateKeyToAddress(`0x${word(ORDER + 1n)}`)).toThrow();
    expect(() => privateKeyToAddress(`0x${'ff'.repeat(32)}`)).toThrow();
    expect(() => signDigest(`0x${word(0n)}`, DIGEST)).toThrow();
    expect(() => signDigest(`0x${word(ORDER)}`, DIGEST)).toThrow();
  });

  test('keys of the wrong shape are refused', () => {
    for (const bad of [
      '0x',
      '0x01',
      `0x${'11'.repeat(31)}`,
      `0x${'11'.repeat(33)}`,
      '11'.repeat(32),
      `0x${'1'.repeat(63)}`,
      `0x${'zz'.repeat(32)}`,
      5,
      null,
      undefined,
    ]) {
      expect(() => privateKeyToAddress(bad), String(bad)).toThrow();
      expect(() => signDigest(bad, DIGEST), String(bad)).toThrow();
    }
  });

  test('uppercase hex and raw bytes give the same address and signature', () => {
    const key = `0x${'ab'.repeat(32)}`;
    const upper = `0x${'AB'.repeat(32)}`;
    expect(privateKeyToAddress(upper)).toBe(privateKeyToAddress(key));
    expect(privateKeyToAddress(fromHex(key))).toBe(privateKeyToAddress(key));
    expect(signDigest(upper, DIGEST)).toBe(signDigest(key, DIGEST));
    expect(signDigest(fromHex(key), fromHex(DIGEST))).toBe(signDigest(key, DIGEST));
  });

  test('a compressed and an uncompressed public key give the same address', async () => {
    const { secp256k1 } = await import('@noble/curves/secp256k1.js');
    const key = fromHex(`0x${'ab'.repeat(32)}`);
    expect(publicKeyToAddress(secp256k1.getPublicKey(key, true))).toBe(
      publicKeyToAddress(secp256k1.getPublicKey(key, false)),
    );
    expect(publicKeyToAddress(secp256k1.getPublicKey(key, false))).toBe(privateKeyToAddress(key));
  });

  test('newPrivateKey: 32 bytes, in range, and different every time', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) {
      const key = newPrivateKey();
      expect(key).toMatch(/^0x[0-9a-f]{64}$/);
      const n = BigInt(key);
      expect(n > 0n && n < ORDER).toBe(true);
      seen.add(key);
      expect(() => privateKeyToAddress(key)).not.toThrow();
    }
    expect(seen.size).toBe(200);
  });

  test('keccak256 is Keccak, not the NIST SHA-3 (the empty string)', () => {
    expect(toHex(keccak256(new Uint8Array(0)))).toBe(
      '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
    );
    expect(toHex(keccak256(hexToBytes('0x1234')))).toBe(viemKeccak('0x1234'));
  });

  test('hex helpers: strict about the prefix, length and alphabet', () => {
    for (const bad of [
      '',
      '0x1',
      '1234',
      '0X12',
      '0x12 ',
      ' 0x12',
      '0x1g',
      '0x12\n',
      12,
      null,
      undefined,
      {},
    ]) {
      expect(() => fromHex(bad), String(bad)).toThrow(TypeError);
    }
    expect(fromHex('0x')).toEqual(new Uint8Array(0));
    expect(toHex(new Uint8Array([0, 255, 16]))).toBe('0x00ff10');
  });
});

describe('what signDigest produces', () => {
  test('1000 random signatures: 65 bytes, v 27 or 28, low s, nonzero r and s, equal to viem, recoverable', async () => {
    const rng = makeRng(2718);
    const seenV = new Set();
    for (let i = 0; i < 1000; i++) {
      const key = rng.hex(32);
      const digest = rng.hex(32);
      if (BigInt(key) === 0n || BigInt(key) >= ORDER) continue;
      const sig = signDigest(key, digest);
      expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
      const { r, s, v } = parts(sig);
      expect([27, 28]).toContain(v);
      seenV.add(v);
      expect(r > 0n && r < ORDER).toBe(true);
      expect(s > 0n && s <= HALF).toBe(true);
      expect(recoverSigner(digest, sig)).toBe(privateKeyToAddress(key));
      if (i % 10 === 0) {
        expect(sig).toBe(await privateKeyToAccount(key).sign({ hash: digest }));
        expect((await recoverAddress({ hash: digest, signature: sig })).toLowerCase()).toBe(
          privateKeyToAddress(key),
        );
      }
    }
    expect(seenV.size).toBe(2); // both parities were produced, so the v mapping was exercised both ways
  });

  test('it is deterministic: the same key and digest give the same bytes, a different digest a different r', () => {
    const a = signDigest(KEY, DIGEST);
    expect(signDigest(KEY, DIGEST)).toBe(a);
    expect(signDigest(KEY, DIGEST.replace('ab', 'ac'))).not.toBe(a);
    expect(parts(signDigest(KEY, DIGEST.replace('ab', 'ac'))).r).not.toBe(parts(a).r);
  });

  test('edge digests: all zero, all ones (above the curve order), the order itself and one below it', () => {
    for (const d of [
      `0x${'00'.repeat(32)}`,
      `0x${'ff'.repeat(32)}`,
      `0x${word(ORDER)}`,
      `0x${word(ORDER - 1n)}`,
      `0x${word(ORDER + 1n)}`,
    ]) {
      const sig = signDigest(KEY, d);
      expect(recoverSigner(d, sig), d).toBe(privateKeyToAddress(KEY));
      expect(parts(sig).s <= HALF).toBe(true);
    }
  });

  test('the digest must be exactly 32 bytes, as hex or bytes', () => {
    for (const bad of [
      '0x',
      '0x12',
      `0x${'ab'.repeat(31)}`,
      `0x${'ab'.repeat(33)}`,
      new Uint8Array(31),
      new Uint8Array(33),
      new Uint8Array(0),
    ]) {
      expect(() => signDigest(KEY, bad)).toThrow(RangeError);
      expect(() => tryRecoverSigner(bad, good)).toThrow(RangeError);
    }
  });

  test('a subarray view of a bigger buffer signs the same as a copy', () => {
    const backing = new Uint8Array(100).fill(0xcd);
    backing.set(fromHex(DIGEST), 40);
    expect(signDigest(KEY, backing.subarray(40, 72))).toBe(signDigest(KEY, DIGEST));
  });

  test('the key and digest arguments are never modified', () => {
    const key = fromHex(`0x${'ab'.repeat(32)}`);
    const digest = fromHex(DIGEST);
    signDigest(key, digest);
    expect(key).toEqual(fromHex(`0x${'ab'.repeat(32)}`));
    expect(digest).toEqual(fromHex(DIGEST));
  });
});

describe('tryRecoverSigner mirrors ECDSA.recoverCalldata, in its order', () => {
  const { r, s, v } = parts(good);
  const as = (p) => tryRecoverSigner(DIGEST, p);

  test('a good signature recovers, in lowercase', () => {
    expect(as(good)).toEqual({ address: privateKeyToAddress(KEY) });
    expect(as(good.toUpperCase().replace('0X', '0x'))).toEqual({
      address: privateKeyToAddress(KEY),
    });
    expect(as(fromHex(good))).toEqual({ address: privateKeyToAddress(KEY) });
  });

  test('the length is looked at first, and reported', () => {
    for (const bytes of [0, 1, 32, 63, 64, 66, 96, 130]) {
      const sig = `0x${'ab'.repeat(bytes)}`;
      expect(as(sig)).toEqual({ error: 'ECDSAInvalidSignatureLength', args: [BigInt(bytes)] });
    }
    // 64 bytes is the EIP-2098 compact form: OpenZeppelin's recoverCalldata does not take it
    expect(as(good.slice(0, 2 + 128))).toEqual({
      error: 'ECDSAInvalidSignatureLength',
      args: [64n],
    });
    // a wrong length with a high s: the length error wins
    expect(as(`0x${word(r)}${word(ORDER - 1n)}${'00'.repeat(2)}`)).toMatchObject({
      error: 'ECDSAInvalidSignatureLength',
    });
  });

  test('high s is rejected before v and r are looked at, and its value is reported as bytes32', () => {
    const high = HALF + 1n;
    expect(as(join(r, high, v))).toEqual({
      error: 'ECDSAInvalidSignatureS',
      args: [`0x${word(high)}`],
    });
    expect(as(join(r, high, 29))).toMatchObject({ error: 'ECDSAInvalidSignatureS' }); // beats a bad v
    expect(as(join(0n, high, 27))).toMatchObject({ error: 'ECDSAInvalidSignatureS' }); // beats a zero r
    expect(as(join(ORDER, high, 27))).toMatchObject({ error: 'ECDSAInvalidSignatureS' });
    expect(as(join(r, 2n ** 256n - 1n, v))).toMatchObject({ error: 'ECDSAInvalidSignatureS' });
  });

  test('s == n/2 exactly is NOT high; it is passed to ecrecover', () => {
    const outcome = as(join(r, HALF, v));
    expect(outcome.error).not.toBe('ECDSAInvalidSignatureS');
  });

  test('the malleable twin (n - s, other v) is rejected; so is the twin of a twin', () => {
    const twin = join(r, ORDER - s, v === 27 ? 28 : 27);
    expect(as(twin)).toMatchObject({ error: 'ECDSAInvalidSignatureS' });
    expect(recoverSigner(DIGEST, twin)).toBeNull();
  });

  test('ecrecover failures all come out as ECDSAInvalidSignature (no arguments)', () => {
    const invalid = { error: 'ECDSAInvalidSignature', args: [] };
    for (const bad of [
      join(r, s, 0),
      join(r, s, 1),
      join(r, s, 2),
      join(r, s, 26),
      join(r, s, 29),
      join(r, s, 30),
      join(r, s, 255),
      join(0n, s, v),
      join(r, 0n, v),
      join(0n, 0n, v),
      join(ORDER, s, v),
      join(ORDER + 1n, s, v),
      join(2n ** 256n - 1n, s, v),
      join(ORDER - 1n, s, v), // r = n - 1 is below the order but is not the x of any curve point
      `0x${'00'.repeat(64)}1b`, // r = s = 0
    ]) {
      expect(as(bad), bad).toEqual(invalid);
    }
  });

  test('a signature over another digest recovers to some other address, never to null and never to the signer', () => {
    const other = as(signDigest(KEY, `0x${'cd'.repeat(32)}`));
    expect(other.address).toBeDefined();
    expect(other.address).not.toBe(privateKeyToAddress(KEY));
  });

  test('a signature that is not hex at all is Malformed rather than an exception', () => {
    for (const bad of [
      '',
      'abc',
      '0x12',
      '0xzz',
      `0x${'g'.repeat(130)}`,
      `${good} `,
      ` ${good}`,
      `${good}\n`,
      '0X12',
    ]) {
      const got = as(bad);
      expect(['Malformed', 'ECDSAInvalidSignatureLength'], bad).toContain(got.error);
    }
  });

  test('recoverSigner turns every failure into null and never throws, whatever it is handed', () => {
    const junk = [
      undefined,
      null,
      5,
      {},
      [],
      'x',
      '0x',
      new Uint8Array(3),
      good.slice(0, -2),
      `${good}00`,
    ];
    for (const bad of junk) expect(recoverSigner(DIGEST, bad), String(bad)).toBeNull();
    expect(recoverSigner('0x1234', good)).toBeNull(); // a short digest: no address either
    expect(recoverSigner(undefined, good)).toBeNull();
  });

  test('tryRecoverSigner itself does throw for a missing signature (callers must validate first)', () => {
    // documented behaviour is "{ error: 'Malformed' } for a signature that is not hex"; undefined is a caller bug
    expect(() => tryRecoverSigner(DIGEST, undefined)).toThrow();
    expect(() => tryRecoverSigner(DIGEST, null)).toThrow();
  });
});

describe('cross-checks with viem on the format itself', () => {
  test('viem recovers what we sign and we recover what viem signs, for 100 digests including edge ones', async () => {
    const rng = makeRng(99);
    const account = privateKeyToAccount(KEY);
    const digests = [
      `0x${'00'.repeat(32)}`,
      `0x${'ff'.repeat(32)}`,
      ...Array.from({ length: 98 }, () => rng.hex(32)),
    ];
    for (const d of digests) {
      const ours = signDigest(KEY, d);
      const theirs = await account.sign({ hash: d });
      expect(ours).toBe(theirs);
      expect(await recoverAddress({ hash: d, signature: ours })).toBe(account.address);
      expect(recoverSigner(d, theirs)).toBe(account.address.toLowerCase());
    }
  });

  test('viem and the library agree on the digest bytes: toHex round trips', () => {
    const bytes = fromHex(DIGEST);
    expect(toHex(bytes)).toBe(DIGEST);
    expect(viemToHex(bytes)).toBe(DIGEST);
  });
});
