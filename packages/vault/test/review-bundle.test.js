// Adversarial review of bundle.js: can verifyBundle be fooled, does isNewer order bundles correctly, and does
// the wire form survive a hostile peer. verifyBundle must agree with checkState's signature half (which the
// anvil tests compare with the real contract) on every forgery below.
//
// "REVIEW BUG" titles fail on purpose today (see the report); `test.todo` bodies are design gaps as specs.
import { describe, expect, test } from 'bun:test';
import {
  bundleDigest,
  bundleFromWire,
  bundleToWire,
  isNewer,
  makeBundle,
  verifyBundle,
} from '../src/bundle.js';
import { checkState } from '../src/check.js';
import { hashState, hashStruct } from '../src/eip712.js';
import { signDigest } from '../src/sign.js';
import { toWire } from '../src/state.js';
import { makeWorld } from './fixtures.js';
import { UINT64_MAX } from './gen.js';

const w = makeWorld({ seed: 777, n: 4 });
const s1 = w.nextHand(w.genesis);
const s2 = w.nextHand(s1, {
  winner: 2,
  loser: 3,
  amount: 50n * 10_000n,
  rake: 0n,
  pot: 100n * 10_000n,
});
const sigs1 = w.sign(s1);
const sigs2 = w.sign(s2);
const b1 = makeBundle({ domain: w.domain, state: s1, ...sigs1 });
const b2 = makeBundle({ domain: w.domain, state: s2, ...sigs2 });
const keys = { arbiter: w.arbiter, sessionKeyOf: w.sessionKeyOf };
const bad = (error, ...args) => ({ ok: false, error, args });
const MAX = 2n ** 256n - 1n;
const withSigs = (bundle, patch) => ({ ...bundle, ...patch });

/** What checkState says about the signature half for the same forgery: they must match. */
const viaCheckState = (bundle, ctxPatch = {}) => {
  const ctx = w.ctx({ table: { nonce: bundle.state.nonce - 1n, escrow: w.escrow }, ...ctxPatch });
  const r = checkState(bundle.state, bundle, ctx);
  return r.ok ? { ok: true, digest: r.digest } : bad(r.error, ...r.args);
};

describe('control', () => {
  test('a real bundle verifies and the digest is the state’s', () => {
    expect(verifyBundle(b1, keys)).toEqual({ ok: true, digest: hashState(s1, w.domain) });
    expect(bundleDigest(b1)).toBe(hashState(s1, w.domain));
    expect(viaCheckState(b1)).toEqual({ ok: true, digest: hashState(s1, w.domain) });
  });
});

describe('forging a bundle out of valid parts', () => {
  const forgeries = {
    'two players’ signatures swapped': withSigs(b1, {
      playerSigs: [b1.playerSigs[1], b1.playerSigs[0], b1.playerSigs[2], b1.playerSigs[3]],
    }),
    'the player list rotated by one': withSigs(b1, {
      playerSigs: [...b1.playerSigs.slice(1), b1.playerSigs[0]],
    }),
    'the player list reversed': withSigs(b1, { playerSigs: [...b1.playerSigs].reverse() }),
    'the arbiter’s signature in a player slot': withSigs(b1, {
      playerSigs: [b1.playerSigs[0], b1.arbiterSig, b1.playerSigs[2], b1.playerSigs[3]],
    }),
    'a player’s signature in the arbiter slot': withSigs(b1, { arbiterSig: b1.playerSigs[0] }),
    'one player’s signature in every slot': withSigs(b1, {
      playerSigs: [b1.playerSigs[0], b1.playerSigs[0], b1.playerSigs[0], b1.playerSigs[0]],
    }),
    'the arbiter’s signature in every slot': withSigs(b1, {
      playerSigs: [b1.arbiterSig, b1.arbiterSig, b1.arbiterSig, b1.arbiterSig],
    }),
    'every signature from the PREVIOUS state': withSigs(b1, { ...sigs2 }),
    'the arbiter signed this state, the players signed the next one': withSigs(b1, {
      playerSigs: sigs2.playerSigs,
    }),
    'one player signed the next state, the rest this one': withSigs(b1, {
      playerSigs: [b1.playerSigs[0], b1.playerSigs[1], b1.playerSigs[2], sigs2.playerSigs[3]],
    }),
    'one signature by a stranger': withSigs(b1, {
      playerSigs: [
        b1.playerSigs[0],
        signDigest(`0x${'77'.repeat(32)}`, hashState(s1, w.domain)),
        b1.playerSigs[2],
        b1.playerSigs[3],
      ],
    }),
    'the player’s WALLET key signed instead of the session key': withSigs(b1, {
      playerSigs: [
        signDigest(`0x${'05'.repeat(32)}`, hashState(s1, w.domain)),
        ...b1.playerSigs.slice(1),
      ],
    }),
    'a signature over the digest of another domain': withSigs(b1, {
      arbiterSig: signDigest(w.arbiterKey, hashState(s1, { ...w.domain, chainId: 1 })),
    }),
    'a signature over the bare struct hash instead of the typed digest': withSigs(b1, {
      arbiterSig: signDigest(w.arbiterKey, hashStruct(s1)),
    }),
  };

  for (const [name, forged] of Object.entries(forgeries)) {
    test(`${name}: refused, and checkState says the same`, () => {
      const mine = verifyBundle(forged, keys);
      expect(mine.ok, name).toBe(false);
      expect(mine.error).toBe('BadSignature');
      expect(mine).toEqual(viaCheckState(forged));
    });
  }

  test('which slot is blamed: the arbiter first, then the first wrong player in roster order', () => {
    expect(verifyBundle(forgeries['a player’s signature in the arbiter slot'], keys)).toEqual(
      bad('BadSignature', MAX),
    );
    expect(verifyBundle(forgeries['two players’ signatures swapped'], keys)).toEqual(
      bad('BadSignature', 0n),
    );
    expect(verifyBundle(forgeries['the arbiter’s signature in a player slot'], keys)).toEqual(
      bad('BadSignature', 1n),
    );
    expect(verifyBundle(forgeries['one signature by a stranger'], keys)).toEqual(
      bad('BadSignature', 1n),
    );
    expect(
      verifyBundle(forgeries['one player signed the next state, the rest this one'], keys),
    ).toEqual(bad('BadSignature', 3n));
    // arbiter wrong AND a player wrong: the arbiter is reported
    expect(
      verifyBundle(
        withSigs(forgeries['two players’ signatures swapped'], { arbiterSig: b1.playerSigs[2] }),
        keys,
      ),
    ).toEqual(bad('BadSignature', MAX));
  });

  test('a state edited after it was signed no longer verifies, whichever field is touched', () => {
    const edits = {
      nonce: { nonce: s1.nonce + 1n },
      isFinal: { isFinal: true },
      balance: { balances: s1.balances.map((b, i) => (i === 0 ? b + 1n : b)) },
      keep: { keep: [true, false, false, false] },
      rake: { rake: s1.rake + 1n },
      volume: { volume: s1.volume + 1n },
      tableId: { tableId: `0x${'ab'.repeat(32)}` },
    };
    for (const [name, patch] of Object.entries(edits)) {
      const edited = { ...b1, state: { ...b1.state, ...patch } };
      expect(verifyBundle(edited, keys), name).toEqual(bad('BadSignature', MAX));
    }
  });

  test('the signed state object being changed after makeBundle does not change the bundle; changing the bundle breaks it', () => {
    const state = {
      ...s1,
      balances: [...s1.balances],
      players: [...s1.players],
      keep: [...s1.keep],
    };
    const sigs = [...sigs1.playerSigs];
    const bundle = makeBundle({
      domain: { ...w.domain },
      state,
      arbiterSig: sigs1.arbiterSig,
      playerSigs: sigs,
    });
    state.balances[0] = 0n;
    state.players[0] = `0x${'ff'.repeat(20)}`;
    sigs[0] = sigs[1];
    expect(verifyBundle(bundle, keys).ok).toBe(true);
    bundle.state.balances[0] += 1n; // the bundle object itself is mutable; verification recomputes everything
    expect(verifyBundle(bundle, keys)).toEqual(bad('BadSignature', MAX));
    bundle.state.balances[0] -= 1n;
    bundle.playerSigs[0] = bundle.playerSigs[1];
    expect(verifyBundle(bundle, keys)).toEqual(bad('BadSignature', 0n));
  });
});

describe('malformed signatures inside a bundle', () => {
  test('a bundle cannot carry a signature of the wrong length: it is Malformed, not an ECDSA error', () => {
    for (const sig of [
      '0x',
      `0x${'ab'.repeat(64)}`,
      `0x${'ab'.repeat(66)}`,
      'abc',
      5,
      null,
      undefined,
    ]) {
      const r = verifyBundle({ ...b1, arbiterSig: sig }, keys);
      expect(r.ok).toBe(false);
      expect(r.error).toBe('Malformed');
      const p = verifyBundle(
        { ...b1, playerSigs: [b1.playerSigs[0], sig, b1.playerSigs[2], b1.playerSigs[3]] },
        keys,
      );
      expect(p.error).toBe('Malformed');
    }
  });

  test('the wrong NUMBER of player signatures is BadLength, before anything else', () => {
    expect(verifyBundle({ ...b1, playerSigs: b1.playerSigs.slice(1) }, keys)).toEqual(
      bad('BadLength'),
    );
    expect(verifyBundle({ ...b1, playerSigs: [...b1.playerSigs, b1.playerSigs[0]] }, keys)).toEqual(
      bad('BadLength'),
    );
    expect(verifyBundle({ ...b1, playerSigs: [] }, keys)).toEqual(bad('BadLength'));
    expect(verifyBundle({ ...b1, playerSigs: undefined }, keys)).toEqual(bad('BadLength'));
    expect(verifyBundle({ ...b1, playerSigs: 'abc' }, keys)).toEqual(bad('BadLength'));
  });

  test('a high-s twin or a bad v of an otherwise right signature is refused with the contract’s ECDSA error', () => {
    const { r, s, v } = {
      r: BigInt(`0x${b1.arbiterSig.slice(2, 66)}`),
      s: BigInt(`0x${b1.arbiterSig.slice(66, 130)}`),
      v: Number.parseInt(b1.arbiterSig.slice(130, 132), 16),
    };
    const ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const hex = (n) => n.toString(16).padStart(64, '0');
    const twin = `0x${hex(r)}${hex(ORDER - s)}${(v === 27 ? 28 : 27).toString(16)}`;
    const noV = `0x${hex(r)}${hex(s)}00`;
    for (const [sig, error] of [
      [twin, 'ECDSAInvalidSignatureS'],
      [noV, 'ECDSAInvalidSignature'],
    ]) {
      const forged = { ...b1, arbiterSig: sig };
      const mine = verifyBundle(forged, keys);
      expect(mine.error).toBe(error);
      expect(mine).toEqual(viaCheckState(forged));
      // in a player slot too
      const slot = {
        ...b1,
        playerSigs: [b1.playerSigs[0], b1.playerSigs[1], sig, b1.playerSigs[3]],
      };
      expect(verifyBundle(slot, keys).error).toBe(error);
    }
  });
});

describe('sessionKeyOf and arbiter: whatever a caller hands in', () => {
  const lookup = (answer) => ({ arbiter: w.arbiter, sessionKeyOf: () => answer });
  const real = (i) => w.sessionAddresses[i];

  test('no key (null, undefined, empty, zero address) means nobody can have signed: BadSignature(0)', () => {
    for (const answer of [null, undefined, '', 0, false, `0x${'00'.repeat(20)}`]) {
      expect(verifyBundle(b1, lookup(answer)), String(answer)).toEqual(bad('BadSignature', 0n));
    }
  });

  test('a key in another case is the same key; a key with a typo or the wrong length is not', () => {
    const upper = (a) => `0x${a.slice(2).toUpperCase()}`;
    const keyOf = (address) => upper(w.sessionKeyOf(address));
    expect(verifyBundle(b1, { arbiter: upper(w.arbiter), sessionKeyOf: keyOf }).ok).toBe(true);
    const flipped = `${real(0).slice(0, -1)}${real(0).endsWith('0') ? '1' : '0'}`;
    for (const answer of [
      flipped,
      real(0).slice(0, 41),
      `${real(0)}00`,
      real(0).slice(2),
      5,
      {},
      [],
      Promise.resolve(real(0)),
    ]) {
      expect(verifyBundle(b1, lookup(answer)), String(answer).slice(0, 20)).toEqual(
        bad('BadSignature', 0n),
      );
    }
  });

  test('a lookup that throws is treated as no key, not as a crash, and not as a pass', () => {
    const boom = {
      arbiter: w.arbiter,
      sessionKeyOf: () => {
        throw new Error('db down');
      },
    };
    expect(verifyBundle(b1, boom)).toEqual(bad('BadSignature', 0n));
  });

  test('sessionKeyOf is asked about the state’s own players, lowercase, in order, and only until the first failure', () => {
    const asked = [];
    const spy = {
      arbiter: w.arbiter,
      sessionKeyOf: (address) => {
        asked.push(address);
        return w.sessionKeyOf(address);
      },
    };
    expect(verifyBundle(b1, spy).ok).toBe(true);
    expect(asked).toEqual(b1.state.players);
    expect(asked.every((a) => a === a.toLowerCase())).toBe(true);
    asked.length = 0;
    verifyBundle(withSigs(b1, { playerSigs: [b1.playerSigs[1], ...b1.playerSigs.slice(1)] }), spy);
    expect(asked).toEqual([b1.state.players[0]]); // stops at the first bad seat
  });

  test('a caller error is an exception, not a result: bad arbiter, no lookup, lookup not a function', () => {
    for (const arbiter of [undefined, null, '0x12', 'nope', 5, `0x${'1'.repeat(41)}`]) {
      expect(() => verifyBundle(b1, { arbiter, sessionKeyOf: w.sessionKeyOf })).toThrow(RangeError);
    }
    for (const sessionKeyOf of [undefined, null, 'abc', {}, 5]) {
      expect(() => verifyBundle(b1, { arbiter: w.arbiter, sessionKeyOf })).toThrow(TypeError);
    }
    expect(() => verifyBundle(b1)).toThrow();
    expect(() => verifyBundle(b1, null)).toThrow();
  });

  test('the zero address as arbiter can never match a recovered signer', () => {
    expect(
      verifyBundle(b1, { arbiter: `0x${'00'.repeat(20)}`, sessionKeyOf: w.sessionKeyOf }),
    ).toEqual(bad('BadSignature', MAX));
  });

  test('a player whose session key IS the arbiter’s address: the arbiter’s signature serves for that seat, as on chain', () => {
    // PokerVault.deposit accepts any non-zero session key, including the arbiter's. The contract then takes
    // the arbiter's signature for that seat too (see review-chain.test.js, which proves it on anvil), so
    // verifyBundle must not be stricter or looser: a policy against it belongs in the server, at start().
    const keyOf = (address) =>
      address === b1.state.players[1] ? w.arbiter : w.sessionKeyOf(address);
    const swapped = withSigs(b1, {
      playerSigs: [b1.playerSigs[0], b1.arbiterSig, b1.playerSigs[2], b1.playerSigs[3]],
    });
    expect(verifyBundle(swapped, { arbiter: w.arbiter, sessionKeyOf: keyOf }).ok).toBe(true);
    expect(verifyBundle(b1, { arbiter: w.arbiter, sessionKeyOf: keyOf })).toEqual(
      bad('BadSignature', 1n),
    );
  });

  test('two seats sharing one session key: one signature serves for both, as on chain', () => {
    const keyOf = (address) =>
      address === b1.state.players[3]
        ? w.sessionKeyOf(b1.state.players[2])
        : w.sessionKeyOf(address);
    const shared = withSigs(b1, { playerSigs: [...b1.playerSigs.slice(0, 3), b1.playerSigs[2]] });
    expect(verifyBundle(shared, { arbiter: w.arbiter, sessionKeyOf: keyOf }).ok).toBe(true);
  });
});

describe('what a bundle claims about itself is not checked against anything (documented limit)', () => {
  // verifyBundle recomputes the digest from the bundle's OWN domain and state. A client that pins the chain,
  // the vault and the table id must compare them itself, or a bundle that was legitimately signed for
  // another table or deployment (same keys) passes.
  test('a bundle for another chain verifies under its own domain', () => {
    const otherDomain = { chainId: 1, verifyingContract: w.domain.verifyingContract };
    const digest = hashState(s1, otherDomain);
    const foreign = makeBundle({
      domain: otherDomain,
      state: s1,
      arbiterSig: signDigest(w.arbiterKey, digest),
      playerSigs: w.sessionKeys.map((k) => signDigest(k, digest)),
    });
    expect(verifyBundle(foreign, keys).ok).toBe(true); // documented: it cannot know which domain is right
    // the contract-side check, which takes the real domain from ctx, refuses it:
    expect(viaCheckState(foreign)).toEqual(bad('BadSignature', MAX));
  });

  test.todo('REVIEW GAP: verifyBundle should accept the expected { domain, tableId } and refuse a bundle for another', () => {
    // The browser has no chain access ("client-side chain watching" is out of scope), so verifyBundle is the
    // only check it can run before storing "the newest all-signed bundle". A hostile server that holds a
    // bundle legitimately signed for another table (a session key reused across tables) with a high nonce
    // could shadow the real one. The expectation is a third argument, e.g. { domain, tableId }.
    const otherDomain = { chainId: 1, verifyingContract: w.domain.verifyingContract };
    const digest = hashState(s1, otherDomain);
    const foreign = makeBundle({
      domain: otherDomain,
      state: s1,
      arbiterSig: signDigest(w.arbiterKey, digest),
      playerSigs: w.sessionKeys.map((k) => signDigest(k, digest)),
    });
    expect(verifyBundle(foreign, { ...keys, domain: w.domain, tableId: s1.tableId }).ok).toBe(
      false,
    );
  });
});

describe('isNewer', () => {
  test('strictly higher nonce wins; equal is not newer in either direction; anything beats nothing', () => {
    expect(isNewer(b2, b1)).toBe(true);
    expect(isNewer(b1, b2)).toBe(false);
    expect(isNewer(b1, b1)).toBe(false);
    expect(isNewer(b1, null)).toBe(true);
    expect(isNewer(b1, undefined)).toBe(true);
    expect(isNewer(null, b1)).toBe(false);
    expect(isNewer(undefined, null)).toBe(false);
  });

  test('equal nonces with different digests are neither newer: the caller must raise the alarm', () => {
    const twinState = {
      ...s1,
      balances: s1.balances.map((b, i) => (i === 0 ? b + 1n : i === 1 ? b - 1n : b)),
    };
    const digest = hashState(twinState, w.domain);
    const twin = makeBundle({
      domain: w.domain,
      state: twinState,
      arbiterSig: signDigest(w.arbiterKey, digest),
      playerSigs: w.sessionKeys.map((k) => signDigest(k, digest)),
    });
    expect(twin.state.nonce).toBe(b1.state.nonce);
    expect(bundleDigest(twin)).not.toBe(bundleDigest(b1));
    expect(isNewer(twin, b1)).toBe(false);
    expect(isNewer(b1, twin)).toBe(false);
    expect(verifyBundle(twin, keys).ok).toBe(true); // both are fully signed: this is exactly the alarm case
  });

  test('nonces at the uint64 edge, compared as numbers', () => {
    const at = (nonce) => ({ state: { nonce } });
    expect(isNewer(at(UINT64_MAX), at(UINT64_MAX - 1n))).toBe(true);
    expect(isNewer(at(10n), at(9n))).toBe(true); // not text order
    expect(isNewer(at(9n), at(10n))).toBe(false);
    expect(isNewer(at(100n), at(99n))).toBe(true);
  });

  test('REVIEW BUG: a wire bundle (decimal-string nonces) is ordered by text, so "10" is not newer than "9"', () => {
    // isNewer reads state.nonce without checking its type. A store that keeps bundles in wire form (JSON) and
    // calls isNewer on them replaces the newest bundle with an older one the moment the nonce gains a digit.
    // Either refusing the input or comparing numerically would be right; silently answering false is not.
    const wire = (n) => bundleToWire({ ...b1, state: { ...b1.state, nonce: n } });
    let answer;
    try {
      answer = isNewer(wire(10n), wire(9n));
    } catch {
      answer = true; // refusing a non-bundle is acceptable
    }
    expect(answer).toBe(true);
  });

  test('a mix of bigint and number nonces compares by value', () => {
    expect(isNewer({ state: { nonce: 10 } }, { state: { nonce: 9n } })).toBe(true);
    expect(isNewer({ state: { nonce: 9 } }, { state: { nonce: 9n } })).toBe(false);
  });
});

describe('makeBundle, bundleToWire and bundleFromWire', () => {
  test('the wire form survives JSON exactly, for the widest state, and is verified identically afterwards', () => {
    const wide = { ...s1, nonce: UINT64_MAX };
    const digest = hashState(wide, w.domain);
    const bundle = makeBundle({
      domain: w.domain,
      state: wide,
      arbiterSig: signDigest(w.arbiterKey, digest),
      playerSigs: w.sessionKeys.map((k) => signDigest(k, digest)),
    });
    const back = bundleFromWire(JSON.parse(JSON.stringify(bundleToWire(bundle))));
    expect(back).toEqual(bundle);
    expect(verifyBundle(back, keys)).toEqual(verifyBundle(bundle, keys));
  });

  test('bundleFromWire is as strict as fromWire: numbers, signs, spaces and bad states are refused', () => {
    const wire = bundleToWire(b1);
    const mutations = [
      (x) => ({ ...x, state: { ...x.state, nonce: 1 } }),
      (x) => ({ ...x, state: { ...x.state, nonce: '01' } }),
      (x) => ({ ...x, state: { ...x.state, nonce: ' 1' } }),
      (x) => ({ ...x, state: { ...x.state, balances: x.state.balances.map(Number) } }),
      (x) => ({ ...x, state: { ...x.state, rake: '-1' } }),
      (x) => ({ ...x, state: undefined }),
      (x) => ({
        ...x,
        domain: { chainId: '31337', verifyingContract: x.domain.verifyingContract },
      }),
      (x) => ({ ...x, domain: undefined }),
      (x) => ({ ...x, arbiterSig: x.arbiterSig.slice(0, -2) }),
      (x) => ({ ...x, playerSigs: x.playerSigs.slice(1) }),
      (x) => ({ ...x, playerSigs: 'abc' }),
    ];
    for (const [i, mutate] of mutations.entries()) {
      expect(() => bundleFromWire(mutate(wire)), `mutation ${i}`).toThrow();
    }
    for (const junk of [null, undefined, 1, 'x', true])
      expect(() => bundleFromWire(junk)).toThrow(RangeError);
  });

  test('bundleFromWire drops fields it does not know and ignores a __proto__ key from JSON', () => {
    const text = JSON.stringify({ ...bundleToWire(b1), extra: 1 }).replace(
      '{',
      '{"__proto__":{"arbiterSig":"0x00"},',
    );
    const back = bundleFromWire(JSON.parse(text));
    expect(Object.keys(back).sort()).toEqual(['arbiterSig', 'domain', 'playerSigs', 'state']);
    expect(back.arbiterSig).toBe(b1.arbiterSig);
    expect({}.arbiterSig).toBeUndefined();
  });

  test('toWire(state) inside a wire bundle is the state’s own wire form', () => {
    expect(bundleToWire(b1).state).toEqual(toWire(s1));
  });

  test('makeBundle canonicalises case, so two spellings of one bundle are equal and verify alike', () => {
    const shout = (h) => `0x${h.slice(2).toUpperCase()}`;
    const loud = makeBundle({
      domain: { chainId: w.domain.chainId, verifyingContract: shout(w.domain.verifyingContract) },
      state: { ...s1, tableId: shout(s1.tableId), players: s1.players.map(shout) },
      arbiterSig: shout(sigs1.arbiterSig),
      playerSigs: sigs1.playerSigs.map(shout),
    });
    expect(loud).toEqual(b1);
    expect(verifyBundle(loud, keys)).toEqual(verifyBundle(b1, keys));
  });

  test('a bundle for a state that is not a valid State is refused at the door', () => {
    const ok = { domain: w.domain, ...sigs1 };
    expect(() =>
      makeBundle({ ...ok, state: { ...s1, players: [...s1.players].reverse() } }),
    ).toThrow(RangeError);
    expect(() => makeBundle({ ...ok, state: { ...s1, nonce: UINT64_MAX + 1n } })).toThrow(
      RangeError,
    );
    expect(() => makeBundle({ ...ok, state: null })).toThrow(RangeError);
    expect(() =>
      makeBundle({
        ...ok,
        state: s1,
        domain: { chainId: 0, verifyingContract: w.domain.verifyingContract },
      }),
    ).toThrow(RangeError);
  });

  test.todo('REVIEW GAP (nit): a sparse playerSigs array must not become a bundle (verifyBundle then throws, it does not answer)', () => {
    let bundle;
    try {
      bundle = makeBundle({
        domain: w.domain,
        state: s1,
        arbiterSig: sigs1.arbiterSig,
        playerSigs: new Array(4),
      });
    } catch (error) {
      expect(error).toBeInstanceOf(RangeError); // refusing is the right answer
      return;
    }
    expect(verifyBundle(bundle, keys).ok).toBe(false); // otherwise a result, never an exception
  });

  test('every public function leaves a frozen bundle alone', () => {
    const deepFreeze = (o) => {
      for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
      return Object.freeze(o);
    };
    const frozen = deepFreeze(JSON.parse(JSON.stringify(bundleToWire(b1))));
    const back = bundleFromWire(frozen);
    expect(verifyBundle(deepFreeze(back), keys).ok).toBe(true);
    expect(bundleToWire(back)).toEqual(frozen);
  });
});
