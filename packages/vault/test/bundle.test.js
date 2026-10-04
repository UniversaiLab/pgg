import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  bundleDigest,
  bundleFromWire,
  bundleToWire,
  isNewer,
  makeBundle,
  verifyBundle,
} from '../src/bundle.js';
import { hashState } from '../src/eip712.js';
import { makeWorld, UNIT } from './fixtures.js';
import { UINT64_MAX, UINT256_MAX } from './gen.js';

const w = makeWorld({ seed: 5 });
const state = w.nextHand(w.genesis);
const sigs = w.sign(state);
const bundle = makeBundle({ domain: w.domain, state, ...sigs });
const keys = { arbiter: w.arbiter, sessionKeyOf: w.sessionKeyOf };
const flip = (hexString, byte, mask = 0x01) => {
  const at = 2 + byte * 2;
  const value = Number.parseInt(hexString.slice(at, at + 2), 16) ^ mask;
  return `${hexString.slice(0, at)}${value.toString(16).padStart(2, '0')}${hexString.slice(at + 2)}`;
};
const bad = (error, ...args) => ({ ok: false, error, args });

describe('makeBundle', () => {
  test('keeps exactly domain, state, arbiterSig and playerSigs, canonicalised', () => {
    expect(Object.keys(bundle).sort()).toEqual(['arbiterSig', 'domain', 'playerSigs', 'state']);
    const loud = makeBundle({
      domain: {
        chainId: 31337n,
        verifyingContract: w.domain.verifyingContract.toUpperCase().replace('0X', '0x'),
      },
      state: { ...state, tableId: state.tableId.toUpperCase().replace('0X', '0x') },
      arbiterSig: sigs.arbiterSig.toUpperCase().replace('0X', '0x'),
      playerSigs: sigs.playerSigs.map((s) => s.toUpperCase().replace('0X', '0x')),
    });
    expect(loud).toEqual(bundle);
  });

  test('refuses what cannot be a bundle', () => {
    const ok = { domain: w.domain, state, ...sigs };
    expect(() => makeBundle({ ...ok, playerSigs: sigs.playerSigs.slice(1) })).toThrow(RangeError);
    expect(() => makeBundle({ ...ok, playerSigs: undefined })).toThrow(RangeError);
    expect(() => makeBundle({ ...ok, arbiterSig: sigs.arbiterSig.slice(0, 100) })).toThrow(
      /arbiterSig/,
    );
    expect(() => makeBundle({ ...ok, arbiterSig: undefined })).toThrow(RangeError);
    expect(() => makeBundle({ ...ok, playerSigs: ['0x12', '0x34', '0x56'] })).toThrow(
      /playerSigs\[0\]/,
    );
    expect(() =>
      makeBundle({ ...ok, state: { ...state, players: [...state.players].reverse() } }),
    ).toThrow(/players/);
    expect(() =>
      makeBundle({ ...ok, domain: { chainId: 0, verifyingContract: w.domain.verifyingContract } }),
    ).toThrow(/chainId/);
    expect(() => makeBundle(null)).toThrow();
  });

  test('bundleDigest is the digest that was signed', () => {
    expect(bundleDigest(bundle)).toBe(hashState(state, w.domain));
  });
});

describe('verifyBundle', () => {
  test('accepts a correctly signed bundle and returns its digest', () => {
    expect(verifyBundle(bundle, keys)).toEqual({ ok: true, digest: bundleDigest(bundle) });
  });

  test('accepts the shared contract vector', () => {
    const v = JSON.parse(
      readFileSync(new URL('../../../contracts/test/vectors/state.json', import.meta.url), 'utf8'),
    );
    const sessionKeys = new Map(v.players.map((p, i) => [p.toLowerCase(), v.sessionKeys[i]]));
    const b = makeBundle({
      domain: { chainId: v.chainId, verifyingContract: v.vault },
      state: v.state,
      arbiterSig: v.signatures.arbiter,
      playerSigs: v.signatures.players,
    });
    expect(
      verifyBundle(b, { arbiter: v.arbiter, sessionKeyOf: (a) => sessionKeys.get(a) ?? null }),
    ).toEqual({
      ok: true,
      digest: v.digest,
    });
  });

  test('works for 2 to 10 players', () => {
    for (let n = 2; n <= 10; n++) {
      const world = makeWorld({ seed: 100 + n, n });
      const s = world.nextHand(world.genesis);
      const b = makeBundle({ domain: world.domain, state: s, ...world.sign(s) });
      expect(
        verifyBundle(b, { arbiter: world.arbiter, sessionKeyOf: world.sessionKeyOf }),
      ).toMatchObject({
        ok: true,
      });
    }
  });

  describe("tampering is always caught, and by the contract's error", () => {
    test('flipping any bit of any byte of the arbiter signature', () => {
      for (let byte = 0; byte < 65; byte++) {
        for (const mask of [0x01, 0x80]) {
          const result = verifyBundle(
            { ...bundle, arbiterSig: flip(bundle.arbiterSig, byte, mask) },
            keys,
          );
          expect(result.ok, `byte ${byte} mask ${mask}`).toBe(false);
        }
      }
    });

    test('flipping a byte of a player signature names that seat (or the ECDSA error)', () => {
      for (let i = 0; i < 3; i++) {
        for (let byte = 0; byte < 65; byte++) {
          const playerSigs = bundle.playerSigs.map((s, j) => (j === i ? flip(s, byte) : s));
          const result = verifyBundle({ ...bundle, playerSigs }, keys);
          expect(result.ok, `seat ${i} byte ${byte}`).toBe(false);
          if (result.error === 'BadSignature') expect(result.args).toEqual([BigInt(i)]);
          else expect(result.error).toMatch(/^ECDSAInvalidSignature/);
        }
      }
    });

    test('swapping two player signatures', () => {
      const [a, b, c] = bundle.playerSigs;
      expect(verifyBundle({ ...bundle, playerSigs: [b, a, c] }, keys)).toEqual(
        bad('BadSignature', 0n),
      );
      expect(verifyBundle({ ...bundle, playerSigs: [a, c, b] }, keys)).toEqual(
        bad('BadSignature', 1n),
      );
      expect(verifyBundle({ ...bundle, playerSigs: [c, b, a] }, keys)).toEqual(
        bad('BadSignature', 0n),
      );
    });

    test("swapping the arbiter signature with a player's", () => {
      expect(
        verifyBundle(
          {
            ...bundle,
            arbiterSig: bundle.playerSigs[0],
            playerSigs: [bundle.arbiterSig, ...bundle.playerSigs.slice(1)],
          },
          keys,
        ),
      ).toEqual(bad('BadSignature', UINT256_MAX));
    });

    test('changing one balance, the nonce, isFinal, keep, rake or volume invalidates every signature', () => {
      const edits = [
        { balances: state.balances.map((b, i) => (i === 2 ? b + 1n : b)) },
        { balances: state.balances.map((b, i) => (i === 0 ? b - 1n : b)) },
        { nonce: state.nonce + 1n },
        { isFinal: true },
        { keep: [true, false, false] },
        { rake: state.rake + 1n },
        { volume: state.volume + 1n },
        { tableId: `0x${'ee'.repeat(32)}` },
      ];
      for (const edit of edits) {
        const tampered = { ...bundle, state: { ...state, ...edit } };
        expect(verifyBundle(tampered, keys), JSON.stringify(Object.keys(edit))).toEqual(
          bad('BadSignature', UINT256_MAX),
        );
      }
    });

    test('moving the bundle to another chain or vault', () => {
      expect(verifyBundle({ ...bundle, domain: { ...w.domain, chainId: 137 } }, keys)).toEqual(
        bad('BadSignature', UINT256_MAX),
      );
      expect(
        verifyBundle(
          { ...bundle, domain: { ...w.domain, verifyingContract: `0x${'12'.repeat(20)}` } },
          keys,
        ),
      ).toEqual(bad('BadSignature', UINT256_MAX));
    });

    test('the wrong arbiter, an unknown session key, a rotated session key', () => {
      const other = makeWorld({ seed: 6 });
      expect(verifyBundle(bundle, { ...keys, arbiter: other.arbiter })).toEqual(
        bad('BadSignature', UINT256_MAX),
      );
      expect(verifyBundle(bundle, { ...keys, sessionKeyOf: () => null })).toEqual(
        bad('BadSignature', 0n),
      );
      expect(
        verifyBundle(bundle, {
          ...keys,
          sessionKeyOf: (a) =>
            a === state.players[2] ? other.sessionAddresses[0] : w.sessionKeyOf(a),
        }),
      ).toEqual(bad('BadSignature', 2n));
    });
  });

  test('a bad arbiter or sessionKeyOf argument is a caller bug and throws', () => {
    expect(() => verifyBundle(bundle, { sessionKeyOf: w.sessionKeyOf })).toThrow(RangeError);
    expect(() => verifyBundle(bundle, { arbiter: 'nope', sessionKeyOf: w.sessionKeyOf })).toThrow(
      RangeError,
    );
    expect(() => verifyBundle(bundle, { arbiter: w.arbiter })).toThrow(TypeError);
  });

  test('a missing or short set of signatures is a length error, not a crash', () => {
    expect(verifyBundle({ ...bundle, playerSigs: bundle.playerSigs.slice(1) }, keys)).toEqual(
      bad('BadLength'),
    );
    expect(
      verifyBundle({ ...bundle, playerSigs: [...bundle.playerSigs, bundle.arbiterSig] }, keys),
    ).toEqual(bad('BadLength'));
  });

  test('anything that is not a bundle is Malformed, and never throws', () => {
    for (const junk of [
      null,
      undefined,
      5,
      'bundle',
      {},
      { ...bundle, arbiterSig: '0x' },
      { ...bundle, arbiterSig: undefined },
      { ...bundle, playerSigs: ['', '', ''] },
      { ...bundle, state: { ...state, nonce: 'x' } },
      { ...bundle, domain: null },
      bundleToWire(bundle), // a wire bundle is not an internal bundle
    ]) {
      const result = verifyBundle(junk, keys);
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Malformed');
    }
  });
});

describe('wire form', () => {
  test('round-trips through JSON and is plain text', () => {
    const wire = bundleToWire(bundle);
    expect(typeof wire.state.nonce).toBe('string');
    expect(wire.state.balances.every((b) => typeof b === 'string')).toBe(true);
    expect(JSON.parse(JSON.stringify(wire))).toEqual(wire);
    expect(bundleFromWire(JSON.parse(JSON.stringify(wire)))).toEqual(bundle);
    expect(verifyBundle(bundleFromWire(wire), keys)).toMatchObject({ ok: true });
  });

  test('round-trips the extremes', () => {
    const world = makeWorld({ seed: 8, n: 2, deposits: [UINT256_MAX / 2n, UINT256_MAX / 2n] });
    const s = {
      ...world.genesis,
      nonce: UINT64_MAX,
      balances: [UINT256_MAX / 2n, UINT256_MAX / 2n],
    };
    const b = makeBundle({ domain: world.domain, state: s, ...world.sign(s) });
    expect(bundleFromWire(JSON.parse(JSON.stringify(bundleToWire(b))))).toEqual(b);
  });

  test('fromWire is as strict as the state parser', () => {
    const wire = bundleToWire(bundle);
    expect(() => bundleFromWire({ ...wire, state: { ...wire.state, nonce: 1 } })).toThrow(
      RangeError,
    );
    expect(() => bundleFromWire({ ...wire, state: { ...wire.state, nonce: '01' } })).toThrow(
      RangeError,
    );
    expect(() =>
      bundleFromWire({ ...wire, state: { ...wire.state, balances: ['1', '2', 3] } }),
    ).toThrow(RangeError);
    expect(() => bundleFromWire({ ...wire, playerSigs: wire.playerSigs.slice(1) })).toThrow(
      RangeError,
    );
    expect(() => bundleFromWire({ ...wire, arbiterSig: 'abc' })).toThrow(RangeError);
    expect(() =>
      bundleFromWire({
        ...wire,
        domain: { chainId: '1', verifyingContract: w.domain.verifyingContract },
      }),
    ).toThrow(RangeError);
    expect(() => bundleFromWire(null)).toThrow(RangeError);
    expect(() => bundleFromWire({ ...wire, state: undefined })).toThrow(RangeError);
  });

  test('bundleToWire validates the bundle it is given', () => {
    expect(() => bundleToWire({ ...bundle, playerSigs: [] })).toThrow(RangeError);
  });
});

describe('isNewer (monotonicity by nonce)', () => {
  const at = (nonce) => ({ ...bundle, state: { ...state, nonce } });

  test('a higher nonce is newer, a lower or equal one is not', () => {
    expect(isNewer(at(5n), at(4n))).toBe(true);
    expect(isNewer(at(4n), at(5n))).toBe(false);
    expect(isNewer(at(5n), at(5n))).toBe(false);
    expect(isNewer(at(UINT64_MAX), at(UINT64_MAX - 1n))).toBe(true);
    expect(isNewer(at(1n), at(0n))).toBe(true);
  });

  test('anything is newer than nothing; nothing is newer than anything', () => {
    expect(isNewer(at(0n), null)).toBe(true);
    expect(isNewer(at(0n), undefined)).toBe(true);
    expect(isNewer(null, at(0n))).toBe(false);
    expect(isNewer(null, null)).toBe(false);
  });

  test('is a strict order over a sequence: only the maximum is newer than all the others', () => {
    const nonces = [3n, 9n, 1n, 7n, 9n, 0n];
    const bundles = nonces.map(at);
    let best = null;
    for (const b of bundles) if (isNewer(b, best)) best = b;
    expect(best.state.nonce).toBe(9n);
    // equal nonces never replace the stored one: the first 9 stays
    expect(best).toBe(bundles[1]);
  });

  test('the state of one real hand follows the one before', () => {
    const next = w.nextHand(state, { winner: 2, loser: 0, amount: 5n * UNIT, rake: UNIT });
    const nextBundle = makeBundle({ domain: w.domain, state: next, ...w.sign(next) });
    expect(isNewer(nextBundle, bundle)).toBe(true);
    expect(isNewer(bundle, nextBundle)).toBe(false);
  });
});
