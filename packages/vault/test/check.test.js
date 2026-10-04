// Table-driven tests for checkState and checkSettle against PokerVault._verify / settle. Each case names the
// first error the contract would revert with. The same cases are the reference for the anvil equivalence test.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildNextState } from '../src/build.js';
import { checkSettle, checkState, ERRORS, STATUS, tableFromChain } from '../src/check.js';
import { hashState } from '../src/eip712.js';
import { signDigest, tryRecoverSigner } from '../src/sign.js';
import { rosterHash } from '../src/state.js';
import { makeWorld, UNIT } from './fixtures.js';
import { UINT256_MAX } from './gen.js';

const ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HALF = ORDER >> 1n;
const ARBITER = UINT256_MAX; // BadSignature(2^256-1)

const hex = (n) => n.toString(16).padStart(64, '0');
const split = (sig) => ({
  r: BigInt(`0x${sig.slice(2, 66)}`),
  s: BigInt(`0x${sig.slice(66, 130)}`),
  v: Number.parseInt(sig.slice(130, 132), 16),
});
const join = ({ r, s, v }) => `0x${hex(r)}${hex(s)}${v.toString(16).padStart(2, '0')}`;
const fail = (error, ...args) => ({ ok: false, error, args });

const w = makeWorld({ seed: 42 });
const good = w.nextHand(w.genesis); // nonce 1
const goodSigs = w.sign(good);
const ctx = w.ctx();
const withSigs = (patch) => ({ ...goodSigs, ...patch });
const swapIn = (list, i, value) => list.map((x, j) => (j === i ? value : x));

describe('a valid state', () => {
  test('is accepted and the digest is the one that gets signed', () => {
    expect(checkState(good, goodSigs, ctx)).toEqual({
      ok: true,
      digest: hashState(good, w.domain),
    });
  });

  test('is accepted without signatures when sigs is null (before signing)', () => {
    expect(checkState(good, null, ctx)).toEqual({ ok: true, digest: hashState(good, w.domain) });
    expect(checkState(good, undefined, { ...ctx, sessionKeyOf: undefined })).toMatchObject({
      ok: true,
    });
  });

  test('is accepted with upper-case signatures and addresses', () => {
    const loud = (s) => `0x${s.slice(2).toUpperCase()}`;
    const sigs = {
      arbiterSig: loud(goodSigs.arbiterSig),
      playerSigs: goodSigs.playerSigs.map(loud),
    };
    const state = { ...good, players: good.players.map((p) => `0x${p.slice(2).toUpperCase()}`) };
    const upperCtx = w.ctx({ table: { arbiter: `0x${w.arbiter.slice(2).toUpperCase()}` } });
    expect(checkState(state, sigs, upperCtx)).toMatchObject({ ok: true });
  });

  test('is accepted when the table row carries an upper-case roster hash', () => {
    const loud = `0x${w.table.rosterHash.slice(2).toUpperCase()}`;
    expect(checkState(good, goodSigs, w.ctx({ table: { rosterHash: loud } }))).toMatchObject({
      ok: true,
    });
  });

  test('is accepted for 2 to 10 players over 60 seeds, with rake and dust', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const n = 2 + (seed % 9);
      const world = makeWorld({ seed, n });
      let prev = world.genesis;
      // three hands in a row: each must be accepted against a table that has accepted the one before
      let table = {};
      for (let hand = 0; hand < 3; hand++) {
        const winner = hand % n;
        const loser = (hand + 1) % n;
        const next = world.nextHand(prev, {
          winner,
          loser,
          amount: 20n * UNIT,
          rake: UNIT,
          pot: 40n * UNIT,
        });
        const result = checkState(next, world.sign(next), world.ctx({ table }));
        expect(result, `seed ${seed} hand ${hand}`).toMatchObject({ ok: true });
        prev = next;
        // the contract records nonce on startExit/challenge; escrow and rakePaid change only on settle
        table = { nonce: next.nonce };
      }
    }
  });

  test('accepts the shared contract vector, signatures and all', () => {
    const v = JSON.parse(
      readFileSync(new URL('../../../contracts/test/vectors/state.json', import.meta.url), 'utf8'),
    );
    const keys = new Map(v.players.map((p, i) => [p.toLowerCase(), v.sessionKeys[i]]));
    const vectorCtx = {
      domain: { chainId: v.chainId, verifyingContract: v.vault },
      maxRakeBps: 500,
      sessionKeyOf: (address) => keys.get(address) ?? null,
      table: {
        status: STATUS.Active,
        nonce: 6n,
        escrow: 3_000_000_000n,
        rakePaid: 0n,
        rosterHash: rosterHash(v.players),
        arbiter: v.arbiter,
      },
    };
    const sigs = { arbiterSig: v.signatures.arbiter, playerSigs: v.signatures.players };
    expect(checkState(v.state, sigs, vectorCtx)).toEqual({ ok: true, digest: v.digest });
    expect(checkSettle(v.state, sigs, vectorCtx)).toEqual({ ok: true, digest: v.digest });
    // the same state one notch off is rejected in the contract's way
    expect(checkState({ ...v.state, nonce: 6 }, sigs, vectorCtx)).toEqual(
      fail('StaleNonce', 6n, 6n),
    );
  });
});

describe('each failure, with the contract error and its arguments', () => {
  const cases = [
    // StaleNonce(given, current): nonce must be strictly above the table's
    ['StaleNonce when equal', good, goodSigs, { table: { nonce: 1n } }, fail('StaleNonce', 1n, 1n)],
    ['StaleNonce when lower', good, goodSigs, { table: { nonce: 5n } }, fail('StaleNonce', 1n, 5n)],
    ['StaleNonce at nonce 0', { ...good, nonce: 0n }, goodSigs, {}, fail('StaleNonce', 0n, 0n)],
    // BadLength
    [
      'BadLength: balances short',
      { ...good, balances: good.balances.slice(1) },
      goodSigs,
      {},
      fail('BadLength'),
    ],
    [
      'BadLength: balances long',
      { ...good, balances: [...good.balances, 1n] },
      goodSigs,
      {},
      fail('BadLength'),
    ],
    [
      'BadLength: keep short',
      { ...good, keep: good.keep.slice(1) },
      goodSigs,
      {},
      fail('BadLength'),
    ],
    [
      'BadLength: keep long',
      { ...good, keep: [...good.keep, true] },
      goodSigs,
      {},
      fail('BadLength'),
    ],
    [
      'BadLength: one signature too few',
      good,
      withSigs({ playerSigs: goodSigs.playerSigs.slice(1) }),
      {},
      fail('BadLength'),
    ],
    [
      'BadLength: one signature too many',
      good,
      withSigs({ playerSigs: [...goodSigs.playerSigs, goodSigs.playerSigs[0]] }),
      {},
      fail('BadLength'),
    ],
    ['BadLength: no player signatures', good, withSigs({ playerSigs: [] }), {}, fail('BadLength')],
    // RosterMismatch: the players must hash to the table's roster
    [
      'RosterMismatch: order reversed',
      {
        ...good,
        players: [...good.players].reverse(),
        balances: [...good.balances].reverse(),
        keep: [...good.keep].reverse(),
      },
      goodSigs,
      {},
      fail('RosterMismatch'),
    ],
    [
      'RosterMismatch: a different player',
      { ...good, players: swapIn(good.players, 2, `0x${'ff'.repeat(20)}`) },
      goodSigs,
      {},
      fail('RosterMismatch'),
    ],
    [
      'RosterMismatch: a player left out, arrays kept consistent',
      {
        ...good,
        players: good.players.slice(0, 2),
        balances: good.balances.slice(0, 2),
        keep: good.keep.slice(0, 2),
      },
      withSigs({ playerSigs: goodSigs.playerSigs.slice(0, 2) }),
      {},
      fail('RosterMismatch'),
    ],
    [
      'RosterMismatch: the table has another roster',
      good,
      goodSigs,
      { table: { rosterHash: `0x${'12'.repeat(32)}` } },
      fail('RosterMismatch'),
    ],
    // RakeDecreased
    [
      'RakeDecreased',
      { ...good, rake: 3n * UNIT },
      goodSigs,
      { table: { rakePaid: 4n * UNIT } },
      fail('RakeDecreased'),
    ],
    // RakeTooHigh: rake * 10000 > maxRakeBps * volume
    [
      'RakeTooHigh: just over the cap',
      { ...good, rake: 50n * UNIT, volume: 1000n * UNIT - 1n },
      goodSigs,
      {},
      fail('RakeTooHigh'),
    ],
    [
      'RakeTooHigh: rake with no volume',
      { ...good, volume: 0n },
      goodSigs,
      {},
      fail('RakeTooHigh'),
    ],
    ['RakeTooHigh: cap of zero', good, goodSigs, { maxRakeBps: 0n }, fail('RakeTooHigh')],
    // NotConserved(claimed, escrow): (rake - rakePaid) + sum(balances) == escrow
    [
      'NotConserved: a chip too many',
      { ...good, balances: swapIn(good.balances, 0, good.balances[0] + 1n) },
      goodSigs,
      {},
      fail('NotConserved', w.escrow + 1n, w.escrow),
    ],
    [
      'NotConserved: a chip missing',
      { ...good, balances: swapIn(good.balances, 2, good.balances[2] - 1n) },
      goodSigs,
      {},
      fail('NotConserved', w.escrow - 1n, w.escrow),
    ],
    [
      'NotConserved: rake not counted against the table',
      { ...good, rake: good.rake + UNIT, volume: good.volume + 100n * UNIT },
      goodSigs,
      {},
      fail('NotConserved', w.escrow + UNIT, w.escrow),
    ],
    [
      'NotConserved: the table holds more',
      good,
      goodSigs,
      { table: { escrow: w.escrow + 9n } },
      fail('NotConserved', w.escrow, w.escrow + 9n),
    ],
    [
      'NotConserved: rake already paid is deducted',
      good,
      goodSigs,
      { table: { rakePaid: UNIT } },
      fail('NotConserved', w.escrow - UNIT, w.escrow),
    ],
  ];

  for (const [name, state, sigs, over, expected] of cases) {
    test(name, () => {
      expect(checkState(state, sigs, w.ctx(over))).toEqual(expected);
    });
  }

  test('error names and argument types are the ones in ERRORS', () => {
    for (const [, , , , expected] of cases) {
      const entry = ERRORS[expected.error];
      expect(entry, expected.error).toBeDefined();
      expect(expected.args.length).toBe(entry.params.length);
    }
  });
});

describe('Solidity checked arithmetic: overflow is Panic(0x11), not RakeTooHigh or NotConserved', () => {
  const panic = fail('Panic', 0x11n);
  const base = { ...good, rake: 0n, volume: 0n };
  const cases = [
    ['rake * 10000 overflows', { ...base, rake: UINT256_MAX / 10_000n + 1n, volume: 1n }, {}],
    ['maxRakeBps * volume overflows', { ...base, volume: UINT256_MAX / 500n + 1n }, {}],
    ['the balance sum overflows', { ...base, balances: [1n << 255n, 1n << 255n, 0n] }, {}],
    ['the sum overflows by one', { ...base, balances: [UINT256_MAX, 1n, 0n] }, {}],
    ['rake is huge and so is volume', { ...base, rake: UINT256_MAX, volume: UINT256_MAX }, {}],
  ];
  for (const [name, state, over] of cases) {
    test(name, () => {
      expect(checkState(state, goodSigs, w.ctx(over))).toEqual(panic);
    });
  }

  test('the boundary just below is an ordinary error', () => {
    // rake*10000 fits: it is only too high for the volume
    const rake = UINT256_MAX / 10_000n;
    expect(checkState({ ...base, rake, volume: 1n }, goodSigs, w.ctx())).toEqual(
      fail('RakeTooHigh'),
    );
    // a sum of exactly 2^256-1 does not overflow: it is just not the escrow
    expect(
      checkState({ ...base, balances: [1n << 255n, (1n << 255n) - 1n, 0n] }, goodSigs, w.ctx()),
    ).toEqual(fail('NotConserved', UINT256_MAX, w.escrow));
  });

  test('RakeDecreased still wins over an overflow it would otherwise cause', () => {
    const state = { ...base, rake: UINT256_MAX / 10_000n + 1n };
    expect(checkState(state, goodSigs, w.ctx({ table: { rakePaid: UINT256_MAX } }))).toEqual(
      fail('RakeDecreased'),
    );
  });
});

describe('two faults at once: the contract reports the earlier check', () => {
  const stale = { table: { nonce: 5n } };
  const reversed = {
    players: [...good.players].reverse(),
    balances: [...good.balances].reverse(),
    keep: [...good.keep].reverse(),
  };
  const garbageSigs = { arbiterSig: `0x${'11'.repeat(65)}`, playerSigs: ['0x', '0x', '0x'] };

  const cases = [
    [
      'stale nonce AND bad roster -> StaleNonce',
      { ...good, ...reversed },
      goodSigs,
      stale,
      fail('StaleNonce', 1n, 5n),
    ],
    [
      'stale nonce AND bad lengths -> StaleNonce',
      { ...good, balances: [] },
      goodSigs,
      stale,
      fail('StaleNonce', 1n, 5n),
    ],
    [
      'stale nonce AND bad signatures -> StaleNonce',
      good,
      garbageSigs,
      stale,
      fail('StaleNonce', 1n, 5n),
    ],
    [
      'bad lengths AND bad roster -> BadLength',
      { ...good, ...reversed, balances: [1n] },
      goodSigs,
      {},
      fail('BadLength'),
    ],
    [
      'bad roster AND rake decreased -> RosterMismatch',
      { ...good, ...reversed },
      goodSigs,
      { table: { rakePaid: 99n * UNIT } },
      fail('RosterMismatch'),
    ],
    [
      'rake decreased AND rake too high -> RakeDecreased',
      { ...good, rake: 1n, volume: 0n },
      goodSigs,
      { table: { rakePaid: 5n } },
      fail('RakeDecreased'),
    ],
    [
      'rake too high AND not conserved -> RakeTooHigh',
      { ...good, volume: 0n, balances: [0n, 0n, 0n] },
      goodSigs,
      {},
      fail('RakeTooHigh'),
    ],
    [
      'overflow AND not conserved -> Panic',
      { ...good, balances: [1n << 255n, 1n << 255n, 5n], rake: 0n, volume: 0n },
      goodSigs,
      {},
      fail('Panic', 0x11n),
    ],
    [
      'not conserved AND bad signatures -> NotConserved',
      { ...good, balances: swapIn(good.balances, 0, 0n) },
      garbageSigs,
      {},
      fail('NotConserved', w.escrow - good.balances[0], w.escrow),
    ],
  ];
  for (const [name, state, sigs, over, expected] of cases) {
    test(name, () => {
      expect(checkState(state, sigs, w.ctx(over))).toEqual(expected);
    });
  }

  test('with sigs null the signature steps are skipped, but every earlier check still runs', () => {
    expect(checkState({ ...good, ...reversed }, null, ctx)).toEqual(fail('RosterMismatch'));
    expect(checkState(good, null, w.ctx(stale))).toEqual(fail('StaleNonce', 1n, 5n));
    expect(checkState(good, null, ctx)).toMatchObject({ ok: true });
  });
});

describe('signatures', () => {
  const digest = hashState(good, w.domain);
  const other = makeWorld({ seed: 77 });
  const foreign = signDigest(other.arbiterKey, digest);

  test('arbiter signed by someone else -> BadSignature(2^256-1)', () => {
    expect(checkState(good, withSigs({ arbiterSig: foreign }), ctx)).toEqual(
      fail('BadSignature', ARBITER),
    );
  });

  test('a player signature from the wrong key -> BadSignature(i) for every seat', () => {
    for (let i = 0; i < 3; i++) {
      const sigs = withSigs({ playerSigs: swapIn(goodSigs.playerSigs, i, foreign) });
      expect(checkState(good, sigs, ctx)).toEqual(fail('BadSignature', BigInt(i)));
    }
  });

  test('the arbiter key signing as a player does not work; nor does a player signing as the arbiter', () => {
    const asPlayer = signDigest(w.arbiterKey, digest);
    expect(
      checkState(good, withSigs({ playerSigs: swapIn(goodSigs.playerSigs, 1, asPlayer) }), ctx),
    ).toEqual(fail('BadSignature', 1n));
    expect(checkState(good, withSigs({ arbiterSig: goodSigs.playerSigs[0] }), ctx)).toEqual(
      fail('BadSignature', ARBITER),
    );
  });

  test("two players' signatures swapped -> BadSignature of the first seat", () => {
    const [a, b, c] = goodSigs.playerSigs;
    expect(checkState(good, withSigs({ playerSigs: [b, a, c] }), ctx)).toEqual(
      fail('BadSignature', 0n),
    );
    expect(checkState(good, withSigs({ playerSigs: [a, c, b] }), ctx)).toEqual(
      fail('BadSignature', 1n),
    );
  });

  test('a signature over an older state -> BadSignature', () => {
    const older = signDigest(w.sessionKeys[2], hashState(w.genesis, w.domain));
    expect(
      checkState(good, withSigs({ playerSigs: swapIn(goodSigs.playerSigs, 2, older) }), ctx),
    ).toEqual(fail('BadSignature', 2n));
  });

  test('signatures made under another domain are wrong signatures', () => {
    const elsewhere = w.sign(good, { ...w.domain, chainId: 1 });
    expect(checkState(good, elsewhere, ctx)).toEqual(fail('BadSignature', ARBITER));
    const elsewhereVault = w.sign(good, { ...w.domain, verifyingContract: `0x${'99'.repeat(20)}` });
    expect(checkState(good, elsewhereVault, ctx)).toEqual(fail('BadSignature', ARBITER));
  });

  test('an unknown session key (sessionKeyOf -> null) can never match', () => {
    const noKey = w.ctx({
      sessionKeyOf: (a) => (a === good.players[1] ? null : w.sessionKeyOf(a)),
    });
    expect(checkState(good, goodSigs, noKey)).toEqual(fail('BadSignature', 1n));
    const throwing = w.ctx({
      sessionKeyOf: () => {
        throw new Error('db down');
      },
    });
    expect(checkState(good, goodSigs, throwing)).toEqual(fail('BadSignature', 0n));
  });

  test('a rotated session key invalidates the old signature', () => {
    const rotated = w.ctx({
      sessionKeyOf: (a) => (a === good.players[0] ? other.sessionAddresses[0] : w.sessionKeyOf(a)),
    });
    expect(checkState(good, goodSigs, rotated)).toEqual(fail('BadSignature', 0n));
  });

  test('the arbiter of the table is the one that must have signed', () => {
    expect(checkState(good, goodSigs, w.ctx({ table: { arbiter: other.arbiter } }))).toEqual(
      fail('BadSignature', ARBITER),
    );
    expect(
      checkState(good, goodSigs, w.ctx({ table: { arbiter: `0x${'00'.repeat(20)}` } })),
    ).toEqual(fail('BadSignature', ARBITER));
  });

  // Malformed signatures revert inside OpenZeppelin's ECDSA, before the comparison with the expected signer.
  const find = (predicate) => {
    for (let r = 1n; r < 500n; r++) if (predicate(r)) return r;
    throw new Error('none found');
  };
  const base = split(goodSigs.playerSigs[1]);
  // r is the x of a curve point iff r^3 + 7 is a square mod p (Euler's criterion); find one that is not
  const P = 2n ** 256n - 2n ** 32n - 977n;
  const modPow = (b, e, m) => {
    let result = 1n;
    for (let x = b % m, k = e; k > 0n; k >>= 1n, x = (x * x) % m)
      if (k & 1n) result = (result * x) % m;
    return result;
  };
  const offCurve = find((r) => modPow((r ** 3n + 7n) % P, (P - 1n) / 2n, P) !== 1n);
  const highS = join({ ...base, s: ORDER - base.s, v: base.v === 27 ? 28 : 27 });
  const malformed = [
    [
      '64 bytes (r and s only)',
      goodSigs.playerSigs[1].slice(0, 130),
      fail('ECDSAInvalidSignatureLength', 64n),
    ],
    ['66 bytes', `${goodSigs.playerSigs[1]}00`, fail('ECDSAInvalidSignatureLength', 66n)],
    ['empty', '0x', fail('ECDSAInvalidSignatureLength', 0n)],
    ['one byte', '0xaa', fail('ECDSAInvalidSignatureLength', 1n)],
    [
      'high s, flipped v (the malleable twin)',
      highS,
      fail('ECDSAInvalidSignatureS', `0x${hex(ORDER - base.s)}`),
    ],
    [
      's one above half the order',
      join({ ...base, s: HALF + 1n }),
      fail('ECDSAInvalidSignatureS', `0x${hex(HALF + 1n)}`),
    ],
    [
      'high s is reported before a bad v',
      join({ ...base, s: ORDER - base.s, v: 29 }),
      fail('ECDSAInvalidSignatureS', `0x${hex(ORDER - base.s)}`),
    ],
    ['v = 0', join({ ...base, v: 0 }), fail('ECDSAInvalidSignature')],
    ['v = 1', join({ ...base, v: 1 }), fail('ECDSAInvalidSignature')],
    ['v = 26', join({ ...base, v: 26 }), fail('ECDSAInvalidSignature')],
    ['v = 29', join({ ...base, v: 29 }), fail('ECDSAInvalidSignature')],
    ['v = 255', join({ ...base, v: 255 }), fail('ECDSAInvalidSignature')],
    ['r = 0', join({ ...base, r: 0n }), fail('ECDSAInvalidSignature')],
    ['s = 0', join({ ...base, s: 0n }), fail('ECDSAInvalidSignature')],
    ['r = the curve order', join({ ...base, r: ORDER }), fail('ECDSAInvalidSignature')],
    [
      'r above the curve order',
      join({ ...base, r: 2n ** 256n - 1n }),
      fail('ECDSAInvalidSignature'),
    ],
    [
      `r = ${offCurve} (not the x of any point)`,
      join({ r: offCurve, s: 1n, v: 27 }),
      fail('ECDSAInvalidSignature'),
    ],
  ];

  for (const [name, sig, expected] of malformed) {
    test(`malformed player signature, ${name}`, () => {
      const sigs = withSigs({ playerSigs: swapIn(goodSigs.playerSigs, 1, sig) });
      expect(checkState(good, sigs, ctx)).toEqual(expected);
    });
    test(`malformed arbiter signature, ${name}`, () => {
      expect(checkState(good, withSigs({ arbiterSig: sig }), ctx)).toEqual(expected);
    });
  }

  test('s exactly half the order passes the s check; the error is then about the signer, not s', () => {
    const result = checkState(good, withSigs({ arbiterSig: join({ ...base, s: HALF }) }), ctx);
    expect(result.ok).toBe(false);
    expect(result.error).not.toBe('ECDSAInvalidSignatureS');
  });

  test("signature errors come in the contract's order", () => {
    const wrong = foreign;
    const garbage = '0xaa';
    // arbiter first: a malformed arbiter signature beats a wrong player signature
    expect(
      checkState(
        good,
        { arbiterSig: garbage, playerSigs: swapIn(goodSigs.playerSigs, 0, wrong) },
        ctx,
      ),
    ).toEqual(fail('ECDSAInvalidSignatureLength', 1n));
    // a wrong arbiter beats everything about the players
    expect(
      checkState(good, { arbiterSig: wrong, playerSigs: [garbage, garbage, garbage] }, ctx),
    ).toEqual(fail('BadSignature', ARBITER));
    // then players in seat order: seat 0 wrong beats seat 1 malformed
    expect(
      checkState(good, withSigs({ playerSigs: [wrong, garbage, goodSigs.playerSigs[2]] }), ctx),
    ).toEqual(fail('BadSignature', 0n));
    // seat 1 malformed beats seat 2 wrong
    expect(
      checkState(good, withSigs({ playerSigs: [goodSigs.playerSigs[0], garbage, wrong] }), ctx),
    ).toEqual(fail('ECDSAInvalidSignatureLength', 1n));
    // and a malformed seat 2 is only reached when seats 0 and 1 are fine
    expect(
      checkState(
        good,
        withSigs({ playerSigs: [goodSigs.playerSigs[0], goodSigs.playerSigs[1], garbage] }),
        ctx,
      ),
    ).toEqual(fail('ECDSAInvalidSignatureLength', 1n));
  });

  test('tryRecoverSigner agrees: it is where the classification comes from', () => {
    expect(tryRecoverSigner(digest, highS)).toEqual({
      error: 'ECDSAInvalidSignatureS',
      args: [`0x${hex(ORDER - base.s)}`],
    });
    expect(tryRecoverSigner(digest, 'nothex')).toEqual({ error: 'Malformed', args: [] });
    expect(tryRecoverSigner(digest, goodSigs.arbiterSig)).toEqual({ address: w.arbiter });
  });
});

describe('inputs that are not a state or not signatures', () => {
  test('a state that cannot be ABI-encoded is Malformed, not an exception', () => {
    for (const state of [
      { ...good, nonce: 'one' },
      { ...good, nonce: 2n ** 64n },
      { ...good, balances: [2n ** 256n, 0n, 0n] },
      { ...good, tableId: '0x12' },
      { ...good, players: ['0x12', '0x34', '0x56'] },
      { ...good, keep: [1, 0, 0] },
      null,
      'state',
    ]) {
      const r = checkState(state, goodSigs, ctx);
      expect(r.ok).toBe(false);
      expect(r.error).toBe('Malformed');
      expect(typeof r.args[0]).toBe('string');
    }
  });

  test('signatures that are not hex bytes are Malformed (they could not be in calldata)', () => {
    for (const sigs of [
      { ...goodSigs, arbiterSig: 'zz' },
      { ...goodSigs, arbiterSig: 5 },
      { ...goodSigs, playerSigs: 'nope' },
      { ...goodSigs, playerSigs: [goodSigs.playerSigs[0], null, goodSigs.playerSigs[2]] },
      { ...goodSigs, playerSigs: ['0x123', '0x', '0x'] },
      {},
      'sigs',
    ]) {
      expect(checkState(good, sigs, ctx).error).toBe('Malformed');
    }
  });

  test('undecodable signatures are reported before any state check, as calldata decoding would', () => {
    const stale = w.ctx({ table: { nonce: 5n } });
    expect(checkState(good, { ...goodSigs, arbiterSig: 'zz' }, stale).error).toBe('Malformed');
    expect(checkState(good, { ...goodSigs, playerSigs: ['0x', 'zz', '0x'] }, stale).error).toBe(
      'Malformed',
    );
  });

  test('a ctx that is wrong even where it is not used throws too', () => {
    expect(() => checkState(good, null, w.ctx({ table: { arbiter: 'nope' } }))).toThrow(RangeError);
  });

  test('a broken ctx is a caller bug and throws', () => {
    expect(() => checkState(good, goodSigs, {})).toThrow(TypeError);
    expect(() => checkState(good, goodSigs, w.ctx({ domain: null }))).toThrow(RangeError);
    expect(() => checkState(good, goodSigs, w.ctx({ maxRakeBps: -1 }))).toThrow(RangeError);
    expect(() => checkState(good, goodSigs, w.ctx({ table: { rosterHash: '0x12' } }))).toThrow(
      RangeError,
    );
    expect(() => checkState(good, goodSigs, w.ctx({ table: { nonce: 'x' } }))).toThrow(RangeError);
    expect(() => checkState(good, goodSigs, w.ctx({ sessionKeyOf: undefined }))).toThrow(TypeError);
    expect(() => checkState(good, goodSigs, w.ctx({ table: { status: 9 } }))).toThrow(RangeError);
  });

  test('table numbers may be plain numbers; maxRakeBps may be a bigint', () => {
    const c = w.ctx({ table: { nonce: 0, rakePaid: 0 }, maxRakeBps: 500n });
    expect(checkState(good, goodSigs, c)).toMatchObject({ ok: true });
  });
});

describe('tableFromChain', () => {
  test('reads the array viem returns for tables(id)', () => {
    const row = [
      2,
      6,
      3,
      w.arbiter,
      7n,
      0,
      1n,
      2n,
      1234n,
      56n,
      w.table.rosterHash,
      `0x${'00'.repeat(32)}`,
    ];
    expect(tableFromChain(row)).toEqual({
      status: 2,
      nonce: 7n,
      escrow: 1234n,
      rakePaid: 56n,
      rosterHash: w.table.rosterHash,
      arbiter: w.arbiter,
    });
  });

  test("reads an object with the contract's field names", () => {
    const table = tableFromChain({ ...w.table, maxPlayers: 6, exitDigest: '0x' });
    expect(table).toEqual(w.table);
  });
});

describe('checkSettle', () => {
  const finalState = buildNextState({
    prev: w.genesis,
    balances: [...w.genesis.balances],
    final: true,
    keep: [true, true, false],
  });
  const finalSigs = w.sign(finalState);

  test('accepts a final state while the table is Active or Exiting', () => {
    for (const status of [STATUS.Active, STATUS.Exiting, 'Active', 'Exiting']) {
      expect(checkSettle(finalState, finalSigs, w.ctx({ table: { status } }))).toEqual({
        ok: true,
        digest: hashState(finalState, w.domain),
      });
    }
  });

  test('NotFinal comes first, before the status and before the nonce', () => {
    expect(checkSettle(good, goodSigs, ctx)).toEqual(fail('NotFinal'));
    expect(
      checkSettle(good, goodSigs, w.ctx({ table: { status: STATUS.Closed, nonce: 9n } })),
    ).toEqual(fail('NotFinal'));
  });

  test('WrongStatus(status) for None, Filling and Closed, before the state is verified', () => {
    for (const status of [STATUS.None, STATUS.Filling, STATUS.Closed]) {
      const c = w.ctx({ table: { status, nonce: 99n } }); // a stale nonce too: status is reported first
      expect(checkSettle(finalState, finalSigs, c)).toEqual(fail('WrongStatus', status));
    }
  });

  test('then _verify runs, with all its errors', () => {
    expect(checkSettle(finalState, finalSigs, w.ctx({ table: { nonce: 5n } }))).toEqual(
      fail('StaleNonce', 1n, 5n),
    );
    expect(checkSettle(finalState, withSigs({ arbiterSig: finalSigs.playerSigs[0] }), ctx)).toEqual(
      fail('BadSignature', ARBITER),
    );
    expect(checkSettle(finalState, finalSigs, w.ctx({ table: { escrow: 1n } }))).toMatchObject({
      error: 'NotConserved',
    });
  });

  test('BadKeep(i) when a kept seat has nothing, the lowest such seat, after the signatures', () => {
    const broke = buildNextState({
      prev: w.genesis,
      balances: [0n, 0n, w.genesis.balances[0] + w.genesis.balances[1] + w.genesis.balances[2]],
      final: true,
      keep: [false, true, true],
    });
    expect(checkSettle(broke, w.sign(broke), ctx)).toEqual(fail('BadKeep', 1n));
    const both = { ...broke, keep: [true, true, true] };
    expect(checkSettle(both, w.sign(both), ctx)).toEqual(fail('BadKeep', 0n));
    // a bad signature is reported before BadKeep, because settle verifies first
    expect(checkSettle(broke, { ...w.sign(broke), playerSigs: ['0x', '0x', '0x'] }, ctx)).toEqual(
      fail('ECDSAInvalidSignatureLength', 0n),
    );
    expect(checkSettle(broke, { ...w.sign(broke), arbiterSig: finalSigs.arbiterSig }, ctx)).toEqual(
      fail('BadSignature', ARBITER),
    );
    // not kept with a zero balance is fine
    const leaver = { ...broke, keep: [false, false, true] };
    expect(checkSettle(leaver, w.sign(leaver), ctx)).toMatchObject({ ok: true });
  });

  test('with sigs null it still checks BadKeep, and skips the signatures', () => {
    const broke = buildNextState({
      prev: w.genesis,
      balances: [0n, w.escrow, 0n],
      final: true,
      keep: [true, true, false],
    });
    expect(checkSettle(broke, null, ctx)).toEqual(fail('BadKeep', 0n));
    expect(checkSettle(finalState, null, ctx)).toMatchObject({ ok: true });
  });

  test('ctx.table.status is required', () => {
    const { status, ...table } = w.table;
    expect(() => checkSettle(finalState, finalSigs, { ...ctx, table })).toThrow(TypeError);
  });

  test('a malformed state is reported before anything else', () => {
    expect(checkSettle({ ...finalState, nonce: 'x' }, finalSigs, ctx).error).toBe('Malformed');
  });
});

describe('ERRORS catalogue', () => {
  test('selectors are the first 4 bytes of keccak(signature)', () => {
    expect(ERRORS.Panic.selector).toBe('0x4e487b71');
    expect(ERRORS.StaleNonce.signature).toBe('StaleNonce(uint64,uint64)');
    expect(ERRORS.WrongStatus.signature).toBe('WrongStatus(uint8)');
    expect(ERRORS.BadSignature.signature).toBe('BadSignature(uint256)');
    expect(ERRORS.ECDSAInvalidSignatureS.signature).toBe('ECDSAInvalidSignatureS(bytes32)');
    expect(ERRORS.Malformed.selector).toBeNull();
  });

  test('every error a check can return is catalogued', () => {
    const names = [
      'StaleNonce',
      'BadLength',
      'RosterMismatch',
      'RakeDecreased',
      'RakeTooHigh',
      'NotConserved',
      'BadSignature',
      'NotFinal',
      'WrongStatus',
      'BadKeep',
      'ECDSAInvalidSignature',
      'ECDSAInvalidSignatureLength',
      'ECDSAInvalidSignatureS',
      'Panic',
      'Malformed',
    ];
    expect(Object.keys(ERRORS).sort()).toEqual([...names].sort());
    expect(Object.isFrozen(ERRORS)).toBe(true);
  });
});
