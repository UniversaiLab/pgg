import { describe, expect, test } from 'bun:test';
import { hashState } from '@pgg/vault';
import { makeJob } from '../../src/vault/chain-port.js';
import { expectOk } from '../../src/vault/fake-chain.js';
import { ALARMS, nextChainAction, stallAction } from '../../src/vault/reconcile.js';
import { makeWorld } from './fake-chain-world.js';

// Two epochs of one table. Epoch 1 starts at nonce 0 and ends with the final state f3. Epoch 2 starts at
// nonce 3 (the nonce the settle left on the chain) and has hands 4 and 5 and a final 6.
const w = makeWorld();
const g1 = w.baseline();
const h1 = w.hand(g1);
const h2 = w.hand(h1, { winner: 1, loser: 2 });
const f3 = w.final(h2);
const g2 = w.baseline(f3.balances, { nonce: 3n, rake: f3.rake, volume: f3.volume });
const h4 = w.hand(g2);
const h5 = w.hand(h4, { winner: 2, loser: 0 });
const f6 = w.final(h5);
const b = Object.fromEntries(
  Object.entries({ h1, h2, f3, h4, h5, f6 }).map(([name, state]) => [name, w.bundle(state)]),
);
const digest = (state) => w.digest(state);
const depositDigest1 = digest(w.depositState());
const depositDigest2 = digest(w.depositState(f3.balances, { nonce: 3n, rake: f3.rake }));

const NOW = 1_000_000;
const DEADLINE = NOW + 100;
const MARGIN = 30;
const OTHER_DIGEST = `0x${'ee'.repeat(32)}`;

const active = (nonce) => ({ status: 'Active', nonce: BigInt(nonce) });
const exiting = (nonce, exitDigest, exitDeadline = DEADLINE) => ({
  status: 'Exiting',
  nonce: BigInt(nonce),
  exitDigest,
  exitDeadline,
});
const store = ({ base = 0, bundle = null, finalBundle = null, openRound } = {}) => ({
  epochBaseNonce: BigInt(base),
  bundle,
  finalBundle,
  ...(openRound ? { openRound } : {}),
});
const settle = { kind: 'settle' };
const challenge = { kind: 'challenge' };
const finalizeExit = { kind: 'finalizeExit' };
const alarm = (name) => ({ alarm: name });

// [name, chainRow, store, chainTime, margin, depositDigest, expected]
const ROWS = [
  // ---- Active ---------------------------------------------------------------------------------------
  [
    'Active, no bundle: nothing (a stall is stallAction)',
    active(0),
    store(),
    NOW,
    MARGIN,
    undefined,
    null,
  ],
  [
    'Active, bundle not final: nothing',
    active(0),
    store({ bundle: b.h2 }),
    NOW,
    MARGIN,
    undefined,
    null,
  ],
  [
    'Active, bundle final: settle',
    active(0),
    store({ bundle: b.f3 }),
    NOW,
    MARGIN,
    undefined,
    settle,
  ],
  [
    'Active, final bundle already on chain (Settled not applied yet): nothing',
    active(3),
    store({ bundle: b.f3 }),
    NOW,
    MARGIN,
    undefined,
    null,
  ],
  [
    'Active at a non-final bundle nonce: impossible, alarm',
    active(2),
    store({ bundle: b.h2 }),
    NOW,
    MARGIN,
    undefined,
    alarm(ALARMS.chainNonceAboveBundle),
  ],
  [
    'Active above the bundle: alarm',
    active(5),
    store({ bundle: b.h2 }),
    NOW,
    MARGIN,
    undefined,
    alarm(ALARMS.chainNonceAboveBundle),
  ],
  [
    'Active above the epoch base with no bundle at all: alarm',
    active(5),
    store({ base: 3 }),
    NOW,
    MARGIN,
    undefined,
    alarm(ALARMS.chainNonceAboveBundle),
  ],
  [
    'rollover: the previous final equals the chain nonce, no bundle in the new epoch: nothing (settle would be StaleNonce)',
    active(3),
    store({ base: 3, finalBundle: b.f3 }),
    NOW,
    MARGIN,
    undefined,
    null,
  ],
  [
    'rollover, new epoch under way (bundle not final): nothing',
    active(3),
    store({ base: 3, bundle: b.h5, finalBundle: b.f3 }),
    NOW,
    MARGIN,
    undefined,
    null,
  ],
  [
    'rollover, new epoch ended (bundle final): settle that one',
    active(3),
    store({ base: 3, bundle: b.f6, finalBundle: b.f3 }),
    NOW,
    MARGIN,
    undefined,
    settle,
  ],
  [
    'the chain is behind the previous final (settle reorged away): settle it again',
    active(1),
    store({ base: 3, finalBundle: b.f3 }),
    NOW,
    MARGIN,
    undefined,
    settle,
  ],
  [
    'the chain is behind the previous final and the new epoch has a bundle: the old final first',
    active(1),
    store({ base: 3, bundle: b.h4, finalBundle: b.f3 }),
    NOW,
    MARGIN,
    undefined,
    settle,
  ],
  [
    'an open round never causes an action (Active, no bundle)',
    active(0),
    store({ openRound: { nonce: 2n } }),
    NOW,
    MARGIN,
    undefined,
    null,
  ],
  [
    'an open round never causes an action (Active, older bundle)',
    active(3),
    store({ base: 3, bundle: b.h4, finalBundle: b.f3, openRound: { nonce: 5n } }),
    NOW,
    MARGIN,
    undefined,
    null,
  ],

  // ---- Exiting: the chain is behind what we hold -----------------------------------------------------
  [
    'Exiting behind a FINAL bundle: settle, never challenge (time left)',
    exiting(1, digest(h1)),
    store({ bundle: b.f3 }),
    NOW,
    MARGIN,
    undefined,
    settle,
  ],
  [
    'Exiting behind a FINAL bundle, after the deadline: settle is still valid until finalizeExit',
    exiting(1, digest(h1)),
    store({ bundle: b.f3 }),
    DEADLINE + 50,
    MARGIN,
    undefined,
    settle,
  ],
  [
    'Exiting behind a non-final bundle, well before the deadline: challenge',
    exiting(1, digest(h1)),
    store({ bundle: b.h2 }),
    NOW,
    MARGIN,
    undefined,
    challenge,
  ],
  [
    'margin edge: now + margin = deadline - 1 still challenges',
    exiting(1, digest(h1)),
    store({ bundle: b.h2 }),
    DEADLINE - MARGIN - 1,
    MARGIN,
    undefined,
    challenge,
  ],
  [
    'margin edge: now + margin = deadline does not (strict): the window was missed',
    exiting(1, digest(h1)),
    store({ bundle: b.h2 }),
    DEADLINE - MARGIN,
    MARGIN,
    undefined,
    alarm(ALARMS.challengeWindowMissed),
  ],
  [
    'inside the margin: missed',
    exiting(1, digest(h1)),
    store({ bundle: b.h2 }),
    DEADLINE - 1,
    MARGIN,
    undefined,
    alarm(ALARMS.challengeWindowMissed),
  ],
  [
    'deadline equality: now = deadline is too late for the margin',
    exiting(1, digest(h1)),
    store({ bundle: b.h2 }),
    DEADLINE,
    MARGIN,
    undefined,
    alarm(ALARMS.challengeWindowMissed),
  ],
  [
    'after the deadline: missed',
    exiting(1, digest(h1)),
    store({ bundle: b.h2 }),
    DEADLINE + 1,
    MARGIN,
    undefined,
    alarm(ALARMS.challengeWindowMissed),
  ],
  [
    'margin 0: one second before the deadline still challenges',
    exiting(1, digest(h1)),
    store({ bundle: b.h2 }),
    DEADLINE - 1,
    0,
    undefined,
    challenge,
  ],
  [
    'margin 0: at the deadline it is missed',
    exiting(1, digest(h1)),
    store({ bundle: b.h2 }),
    DEADLINE,
    0,
    undefined,
    alarm(ALARMS.challengeWindowMissed),
  ],
  [
    'a stale exit from deposits (nonce = epoch base) is answered by the bundle we hold',
    exiting(0, depositDigest1),
    store({ bundle: b.h1 }),
    NOW,
    MARGIN,
    depositDigest1,
    challenge,
  ],
  [
    'a stale exit from deposits is answered by settling when the bundle is final',
    exiting(0, depositDigest1),
    store({ bundle: b.f3 }),
    NOW,
    MARGIN,
    depositDigest1,
    settle,
  ],
  [
    'epoch 2: a stale exit from deposits (nonce 3) against a hand: challenge',
    exiting(3, depositDigest2),
    store({ base: 3, bundle: b.h4, finalBundle: b.f3 }),
    NOW,
    MARGIN,
    depositDigest2,
    challenge,
  ],
  [
    'epoch 2: an exit from hand 4 against hand 5: challenge',
    exiting(4, digest(h4)),
    store({ base: 3, bundle: b.h5, finalBundle: b.f3 }),
    NOW,
    MARGIN,
    undefined,
    challenge,
  ],
  [
    'epoch 2: a stale exit against the final: settle',
    exiting(4, digest(h4)),
    store({ base: 3, bundle: b.f6, finalBundle: b.f3 }),
    NOW,
    MARGIN,
    undefined,
    settle,
  ],

  // ---- Exiting: equal nonce -----------------------------------------------------------------------------
  [
    'equal nonce, equal digest, before the deadline: wait',
    exiting(2, digest(h2)),
    store({ bundle: b.h2 }),
    NOW,
    MARGIN,
    undefined,
    null,
  ],
  [
    'equal nonce, equal digest, now = deadline: still wait (finalizeExit needs now > deadline)',
    exiting(2, digest(h2)),
    store({ bundle: b.h2 }),
    DEADLINE,
    MARGIN,
    undefined,
    null,
  ],
  [
    'equal nonce, equal digest, now = deadline + 1: finalizeExit',
    exiting(2, digest(h2)),
    store({ bundle: b.h2 }),
    DEADLINE + 1,
    MARGIN,
    undefined,
    finalizeExit,
  ],
  [
    'equal nonce, equal digest, long after the deadline: finalizeExit',
    exiting(2, digest(h2)),
    store({ bundle: b.h2 }),
    DEADLINE + 100_000,
    MARGIN,
    undefined,
    finalizeExit,
  ],
  [
    'a member front-ran the settle with the final bundle itself: wait, then finalizeExit (settle would be StaleNonce)',
    exiting(3, digest(f3)),
    store({ bundle: b.f3 }),
    NOW,
    MARGIN,
    undefined,
    null,
  ],
  [
    'the same, after the deadline',
    exiting(3, digest(f3)),
    store({ bundle: b.f3 }),
    DEADLINE + 1,
    MARGIN,
    undefined,
    finalizeExit,
  ],
  [
    'equal nonce, DIFFERENT digest, before the deadline: alarm',
    exiting(2, OTHER_DIGEST),
    store({ bundle: b.h2 }),
    NOW,
    MARGIN,
    undefined,
    alarm(ALARMS.exitDigestMismatch),
  ],
  [
    'equal nonce, different digest, after the deadline: alarm, not finalizeExit',
    exiting(2, OTHER_DIGEST),
    store({ bundle: b.h2 }),
    DEADLINE + 1,
    MARGIN,
    undefined,
    alarm(ALARMS.exitDigestMismatch),
  ],
  [
    'with a bundle, the deposit digest does not excuse a different digest',
    exiting(2, depositDigest1),
    store({ bundle: b.h2 }),
    NOW,
    MARGIN,
    depositDigest1,
    alarm(ALARMS.exitDigestMismatch),
  ],
  [
    'a digest in capitals is the same digest',
    exiting(2, digest(h2).toUpperCase().replace('0X', '0x')),
    store({ bundle: b.h2 }),
    DEADLINE + 1,
    MARGIN,
    undefined,
    finalizeExit,
  ],

  [
    'a deposit digest in capitals is the same digest',
    exiting(0, depositDigest1),
    store(),
    DEADLINE + 1,
    MARGIN,
    depositDigest1.toUpperCase().replace('0X', '0x'),
    finalizeExit,
  ],

  // ---- Exiting: no bundle in this epoch ---------------------------------------------------------------------
  [
    'no bundle, exit from the deposit state (the correct baseline): wait',
    exiting(0, depositDigest1),
    store(),
    NOW,
    MARGIN,
    depositDigest1,
    null,
  ],
  [
    'no bundle, exit from the deposit state, after the deadline: finalizeExit',
    exiting(0, depositDigest1),
    store(),
    DEADLINE + 1,
    MARGIN,
    depositDigest1,
    finalizeExit,
  ],
  [
    'no bundle, exit digest is not the deposit state: alarm',
    exiting(0, OTHER_DIGEST),
    store(),
    NOW,
    MARGIN,
    depositDigest1,
    alarm(ALARMS.exitDigestMismatch),
  ],
  [
    'no bundle and no deposit digest to compare with: cannot be called correct, alarm',
    exiting(0, depositDigest1),
    store(),
    NOW,
    MARGIN,
    undefined,
    alarm(ALARMS.exitDigestMismatch),
  ],
  [
    'no bundle, rollover: a deposit exit at the previous final nonce is correct (and is not the final bundle)',
    exiting(3, depositDigest2),
    store({ base: 3, finalBundle: b.f3 }),
    DEADLINE + 1,
    MARGIN,
    depositDigest2,
    finalizeExit,
  ],
  [
    'no bundle, rollover: the previous final is not an excuse for a digest that is not the deposit state',
    exiting(3, digest(f3)),
    store({ base: 3, finalBundle: b.f3 }),
    NOW,
    MARGIN,
    depositDigest2,
    alarm(ALARMS.exitDigestMismatch),
  ],
  [
    'no bundle, chain above the epoch base: alarm',
    exiting(5, OTHER_DIGEST),
    store({ base: 3 }),
    NOW,
    MARGIN,
    undefined,
    alarm(ALARMS.chainNonceAboveBundle),
  ],
  [
    'no bundle, chain below the epoch base and no final to replay: the store is ahead of the chain, alarm',
    exiting(1, digest(h1)),
    store({ base: 3 }),
    NOW,
    MARGIN,
    undefined,
    alarm(ALARMS.chainBehindStore),
  ],
  [
    'no bundle, chain below the previous final: settle it again (never challenge a final)',
    exiting(1, digest(h1)),
    store({ base: 3, finalBundle: b.f3 }),
    NOW,
    MARGIN,
    undefined,
    settle,
  ],

  // ---- Exiting: the chain is ahead of what we hold -------------------------------------------------------------
  [
    'chain nonce above the bundle: alarm',
    exiting(3, digest(f3)),
    store({ bundle: b.h2 }),
    NOW,
    MARGIN,
    undefined,
    alarm(ALARMS.chainNonceAboveBundle),
  ],
  [
    'chain nonce above the bundle, after the deadline: still an alarm, not finalizeExit',
    exiting(3, digest(f3)),
    store({ bundle: b.h2 }),
    DEADLINE + 1,
    MARGIN,
    undefined,
    alarm(ALARMS.chainNonceAboveBundle),
  ],
  [
    'chain nonce above the bundle of a final',
    exiting(7, OTHER_DIGEST),
    store({ bundle: b.f3 }),
    NOW,
    MARGIN,
    undefined,
    alarm(ALARMS.chainNonceAboveBundle),
  ],

  // ---- Filling, Closed, no row ---------------------------------------------------------------------------------
  ...[
    ['Filling', store()],
    ['Filling', store({ bundle: b.f3 })],
    ['Filling', store({ base: 3, bundle: b.h4, finalBundle: b.f3 })],
    ['Closed', store()],
    ['Closed', store({ bundle: b.h2 })],
    ['Closed', store({ base: 3, finalBundle: b.f3 })],
  ].map(([status, s]) => [
    `${status}: done, whatever the store holds`,
    { status, nonce: 0n, exitDigest: OTHER_DIGEST, exitDeadline: 0 },
    s,
    NOW,
    MARGIN,
    undefined,
    null,
  ]),
  ['no row at all: nothing', null, store(), NOW, MARGIN, undefined, null],
  ['a None row: nothing', { status: 'None' }, store(), NOW, MARGIN, undefined, null],
];

describe('nextChainAction: every row of the table', () => {
  for (const [name, chainRow, s, chainTime, challengeMarginSec, depositDigest, expected] of ROWS) {
    test(name, () => {
      expect(
        nextChainAction({ chainRow, store: s, chainTime, challengeMarginSec, depositDigest }),
      ).toEqual(expected);
    });
  }

  test('the table has every action and every alarm in it (a row was not lost)', () => {
    const seen = new Set(ROWS.map((row) => JSON.stringify(row[6])));
    for (const expected of [settle, challenge, finalizeExit, null]) {
      expect(seen.has(JSON.stringify(expected))).toBe(true);
    }
    for (const name of Object.values(ALARMS))
      expect(seen.has(JSON.stringify(alarm(name)))).toBe(true);
  });
});

describe('ALARMS', () => {
  test('are these four strings, all different: an operator greps for them', () => {
    expect(ALARMS).toEqual({
      chainNonceAboveBundle: 'chain-nonce-above-bundle',
      chainBehindStore: 'chain-behind-store',
      exitDigestMismatch: 'exit-digest-mismatch',
      challengeWindowMissed: 'challenge-window-missed',
    });
    expect(new Set(Object.values(ALARMS)).size).toBe(4);
    expect(Object.isFrozen(ALARMS)).toBe(true);
  });
});

describe('nextChainAction: the result and its input', () => {
  const base = {
    chainRow: active(0),
    store: store({ bundle: b.f3 }),
    chainTime: NOW,
    challengeMarginSec: MARGIN,
  };

  test('tableKey is echoed into an action, and left out when it was not given', () => {
    expect(nextChainAction(base)).toEqual({ kind: 'settle' });
    expect('tableKey' in nextChainAction(base)).toBe(false);
    expect(nextChainAction({ ...base, tableKey: w.tableKey })).toEqual({
      kind: 'settle',
      tableKey: w.tableKey,
    });
    const exit = { ...base, chainRow: exiting(1, digest(h1)), store: store({ bundle: b.h2 }) };
    expect(nextChainAction({ ...exit, tableKey: w.tableKey })).toEqual({
      kind: 'challenge',
      tableKey: w.tableKey,
    });
    const done = { ...base, chainRow: exiting(2, digest(h2)), store: store({ bundle: b.h2 }) };
    expect(nextChainAction({ ...done, chainTime: DEADLINE + 1, tableKey: w.tableKey })).toEqual({
      kind: 'finalizeExit',
      tableKey: w.tableKey,
    });
    // an alarm or nothing carries no table key
    expect(nextChainAction({ ...done, tableKey: w.tableKey })).toBeNull();
    expect(
      nextChainAction({ ...done, chainRow: exiting(2, OTHER_DIGEST), tableKey: w.tableKey }),
    ).toEqual({ alarm: ALARMS.exitDigestMismatch });
  });

  test('every action it can name is a job kind', () => {
    const kinds = new Set(ROWS.map((row) => row[6]?.kind).filter(Boolean));
    for (const kind of kinds) expect(() => makeJob(kind, w.tableKey)).not.toThrow();
  });

  test('is pure: the same input twice, and the input is not touched', () => {
    const input = {
      ...base,
      chainRow: exiting(1, digest(h1)),
      store: store({ bundle: b.h2, finalBundle: null }),
    };
    const frozen = JSON.stringify(input, (_, v) => (typeof v === 'bigint' ? `${v}n` : v));
    const first = nextChainAction(input);
    expect(nextChainAction(input)).toEqual(first);
    expect(JSON.stringify(input, (_, v) => (typeof v === 'bigint' ? `${v}n` : v))).toBe(frozen);
  });

  test('reads numbers as numbers: a chain nonce as a number, seconds as bigint, a bundle nonce as a string', () => {
    const row = { ...exiting(1, digest(h1)), nonce: 1, exitDeadline: BigInt(DEADLINE) };
    const asString = {
      ...b.h2,
      state: { ...b.h2.state, nonce: String(b.h2.state.nonce) },
    };
    expect(
      nextChainAction({
        chainRow: row,
        store: { epochBaseNonce: 0, bundle: asString, finalBundle: null },
        chainTime: BigInt(NOW),
        challengeMarginSec: BigInt(MARGIN),
      }),
    ).toEqual(challenge);
    // 10 is above 9 as a number (a string comparison would say otherwise)
    const nine = { ...b.h2, state: { ...b.h2.state, nonce: 9n } };
    expect(
      nextChainAction({
        chainRow: { ...exiting(10, OTHER_DIGEST) },
        store: store({ bundle: nine }),
        chainTime: NOW,
        challengeMarginSec: MARGIN,
      }),
    ).toEqual(alarm(ALARMS.chainNonceAboveBundle));
  });

  test('input it cannot read is a caller bug and throws', () => {
    const ok = {
      chainRow: exiting(1, digest(h1)),
      store: store({ bundle: b.h2 }),
      chainTime: NOW,
      challengeMarginSec: MARGIN,
    };
    expect(() => nextChainAction(ok)).not.toThrow();
    const bad = (patch) => () => nextChainAction({ ...ok, ...patch });
    expect(bad({ store: undefined })).toThrow(TypeError);
    expect(bad({ store: null })).toThrow(TypeError);
    expect(bad({ store: { ...ok.store, epochBaseNonce: undefined } })).toThrow(TypeError);
    expect(bad({ store: { ...ok.store, epochBaseNonce: -1n } })).toThrow(TypeError);
    expect(bad({ store: { ...ok.store, bundle: { state: {} } } })).toThrow(TypeError);
    expect(bad({ store: { ...ok.store, finalBundle: b.h2 } })).toThrow(/final/);
    expect(bad({ chainTime: undefined })).toThrow(TypeError);
    expect(bad({ chainTime: -1 })).toThrow(TypeError);
    expect(bad({ chainTime: 1.5 })).toThrow(TypeError);
    expect(bad({ challengeMarginSec: undefined })).toThrow(TypeError);
    expect(bad({ challengeMarginSec: -1 })).toThrow(TypeError);
    expect(bad({ chainRow: { ...ok.chainRow, exitDigest: undefined } })).toThrow(
      'chainRow.exitDigest is required',
    );
    expect(bad({ chainRow: { ...ok.chainRow, exitDigest: 5 } })).toThrow(TypeError);
    expect(bad({ chainRow: { ...ok.chainRow, exitDeadline: undefined } })).toThrow(TypeError);
    expect(bad({ chainRow: { ...ok.chainRow, nonce: undefined } })).toThrow(TypeError);
    for (const nonce of [
      '0x10',
      '',
      ' 5',
      '-1',
      '1.5',
      '1e3',
      '007',
      'abc',
      2 ** 53,
      -1,
      1.5,
      null,
    ]) {
      expect(bad({ chainRow: { ...ok.chainRow, nonce } })).toThrow(TypeError);
    }
    expect(bad({ chainRow: { ...ok.chainRow, status: 'Weird' } })).toThrow(RangeError);
  });
});

describe('stallAction', () => {
  const stall = (chainRow, s, extra = {}) => stallAction({ chainRow, store: s, ...extra });

  test('startExit(B) when the current epoch has a bundle newer than the chain', () => {
    expect(stall(active(0), store({ bundle: b.h2 }))).toEqual({ kind: 'startExit' });
    expect(stall(active(0), store({ bundle: b.h1 }))).toEqual({ kind: 'startExit' });
    expect(stall(active(3), store({ base: 3, bundle: b.h4, finalBundle: b.f3 }))).toEqual({
      kind: 'startExit',
    });
  });

  test('startExitFromDeposits when there is no bundle in this epoch', () => {
    expect(stall(active(0), store())).toEqual({ kind: 'startExitFromDeposits' });
  });

  test('the first round of an epoch: the previous final equals the chain nonce, so NOT startExit (StaleNonce)', () => {
    expect(stall(active(3), store({ base: 3, finalBundle: b.f3 }))).toEqual({
      kind: 'startExitFromDeposits',
    });
  });

  test('a bundle that is not newer than the chain is not put up', () => {
    expect(stall(active(2), store({ bundle: b.h2 }))).toEqual({ kind: 'startExitFromDeposits' });
    expect(stall(active(5), store({ bundle: b.h2 }))).toEqual({ kind: 'startExitFromDeposits' });
  });

  test('an open round is never what an exit puts up', () => {
    const openRound = { nonce: 9n };
    expect(stall(active(3), store({ base: 3, finalBundle: b.f3, openRound }))).toEqual({
      kind: 'startExitFromDeposits',
    });
    expect(stall(active(0), store({ bundle: b.h1, openRound }))).toEqual({ kind: 'startExit' });
  });

  test('a final bundle is settled, not exited from (the table goes back to Filling and nobody waits out a window)', () => {
    expect(stall(active(0), store({ bundle: b.f3 }))).toEqual({ kind: 'settle' });
  });

  test('only an Active table can start a stall exit', () => {
    for (const row of [
      exiting(1, digest(h1)),
      { status: 'Filling', nonce: 0n },
      { status: 'Closed', nonce: 0n },
      { status: 'None' },
      null,
    ]) {
      expect(stall(row, store({ bundle: b.h2 }))).toBeNull();
    }
  });

  test('echoes tableKey when given', () => {
    expect(stall(active(0), store({ bundle: b.h2 }), { tableKey: w.tableKey })).toEqual({
      kind: 'startExit',
      tableKey: w.tableKey,
    });
    expect(stall(active(0), store(), { tableKey: w.tableKey })).toEqual({
      kind: 'startExitFromDeposits',
      tableKey: w.tableKey,
    });
    expect('tableKey' in stall(active(0), store())).toBe(false);
  });

  test('input it cannot read throws', () => {
    expect(() => stallAction({ chainRow: active(0), store: undefined })).toThrow(TypeError);
    expect(() => stallAction({ chainRow: active(0), store: {} })).toThrow(TypeError);
  });
});

// The reconciler against the FakeChain: what it decides must be something the chain accepts, and following
// it must end where the design says (the funds paid out exactly as the newest state says).
describe('the reconciler driving a FakeChain', () => {
  const account = (world) => {
    const resolveBundle = { current: null };
    world.resolver.set('settle', () => ({ bundle: resolveBundle.current }));
    world.resolver.set('challenge', () => ({ bundle: resolveBundle.current }));
    return resolveBundle;
  };
  const decide = (world, s, margin = 60, depositDigest) =>
    nextChainAction({
      tableKey: world.tableKey,
      chainRow: world.chain.table(world.tableKey),
      store: s,
      chainTime: world.chain.chainTime(),
      challengeMarginSec: margin,
      depositDigest,
    });
  const follow = (world, action) => {
    world.chain.submit(makeJob(action.kind, action.tableKey));
    return world.chain.tick();
  };

  test('stale exit by a player: challenge with the newer bundle, wait out the window, finalise, pay the newest state', () => {
    const world = makeWorld();
    const genesis = world.activate();
    const s1 = world.hand(genesis, { winner: 0, loser: 1, amount: 100n, rake: 2n });
    const s2 = world.hand(s1, { winner: 1, loser: 2, amount: 50n, rake: 1n });
    const held = account(world);
    held.current = world.bundle(s2);
    const view = { epochBaseNonce: 0n, bundle: held.current, finalBundle: null };
    expect(decide(world, view)).toBeNull(); // Active, hand 2 not final: nothing to do

    // the loser of hand 2 exits from hand 1
    expectOk(world.chain.send(world.players[2], 'startExit', { bundle: world.bundle(s1) }));
    world.chain.tick();
    const action = decide(world, view);
    expect(action).toEqual({ kind: 'challenge', tableKey: world.tableKey });
    const result = follow(world, action);
    expect(result.jobs[0]).toMatchObject({ kind: 'challenge', outcome: 'sent' });
    world.chain.tick();
    expect(world.chain.table(world.tableKey)).toMatchObject({ status: 'Exiting', nonce: 2n });
    expect(decide(world, view)).toBeNull(); // equal nonce and digest: wait

    world.chain.advanceTime(world.chain.info.exitWindowSec + 1);
    world.chain.tick();
    const finish = decide(world, view);
    expect(finish).toEqual({ kind: 'finalizeExit', tableKey: world.tableKey });
    world.resolver.set('finalizeExit', { state: s2 });
    expect(follow(world, finish).jobs[0]).toMatchObject({ kind: 'finalizeExit', outcome: 'sent' });
    world.chain.tick();
    expect(world.chain.table(world.tableKey).status).toBe('Closed');
    expect(decide(world, view)).toBeNull();
    world.seats.forEach((seat, i) => {
      expect(world.chain.balances.of(seat.wallet)).toBe(s2.balances[i]);
    });
    expect(world.chain.balances.house).toBe(s2.rake);
    expect(world.chain.invariants().ok).toBe(true);
    expect(world.chain.delivered.some((e) => e.type === 'JobFailed')).toBe(false);
  });

  test('a final bundle while a stale exit is running: settle it (the chain accepts it) and the table is Filling again', () => {
    const world = makeWorld();
    const genesis = world.activate();
    const s1 = world.hand(genesis);
    const fin = world.final(s1, [true, true, false]);
    const held = account(world);
    held.current = world.bundle(fin);
    const view = { epochBaseNonce: 0n, bundle: held.current, finalBundle: null };
    expect(decide(world, view)).toEqual({ kind: 'settle', tableKey: world.tableKey });

    expectOk(world.chain.send(world.players[0], 'startExit', { bundle: world.bundle(s1) }));
    world.chain.tick();
    const action = decide(world, view);
    expect(action).toEqual({ kind: 'settle', tableKey: world.tableKey }); // never challenge a final
    expect(follow(world, action).jobs[0]).toMatchObject({ kind: 'settle', outcome: 'sent' });
    world.chain.tick();
    expect(world.chain.table(world.tableKey)).toMatchObject({ status: 'Filling', nonce: 2n });
    // the epoch has rolled over: the bundle is now the previous final, and the table is done for the reconciler
    expect(
      decide(world, { epochBaseNonce: 2n, bundle: null, finalBundle: held.current }),
    ).toBeNull();
  });

  test('after the rollover the next epoch begins at the previous final nonce: nothing to send, and a stall exits from deposits', () => {
    const world = makeWorld();
    const genesis = world.activate();
    const fin = world.final(world.hand(genesis), [true, true, true]);
    const held = account(world);
    held.current = world.bundle(fin);
    follow(world, decide(world, { epochBaseNonce: 0n, bundle: held.current, finalBundle: null }));
    world.chain.tick();
    expect(world.chain.table(world.tableKey).status).toBe('Filling');

    world.start(); // the stayers carry their balances into epoch 2
    world.chain.tick();
    const next = { epochBaseNonce: fin.nonce, bundle: null, finalBundle: held.current };
    expect(world.chain.table(world.tableKey)).toMatchObject({ status: 'Active', nonce: fin.nonce });
    expect(decide(world, next)).toBeNull(); // settle(f) again would be StaleNonce

    const stalled = stallAction({
      tableKey: world.tableKey,
      chainRow: world.chain.table(world.tableKey),
      store: next,
    });
    expect(stalled).toEqual({ kind: 'startExitFromDeposits', tableKey: world.tableKey });
    world.resolver.set('startExitFromDeposits', { players: world.players });
    expect(follow(world, stalled).jobs[0]).toMatchObject({ outcome: 'sent' });
    world.chain.tick();

    const deposits = world.seats.map((s) => world.chain.seat(world.tableKey, s.wallet).deposit);
    const depositState = world.depositState(deposits, { nonce: fin.nonce, rake: fin.rake });
    const depositDigest = hashState(depositState, world.domain);
    expect(decide(world, next, 60, depositDigest)).toBeNull(); // the correct baseline: wait
    expect(decide(world, next, 60, undefined)).toEqual({ alarm: ALARMS.exitDigestMismatch });
    world.chain.advanceTime(world.chain.info.exitWindowSec + 1);
    world.chain.tick();
    const finish = decide(world, next, 60, depositDigest);
    expect(finish).toEqual({ kind: 'finalizeExit', tableKey: world.tableKey });
    world.resolver.set('finalizeExit', { state: depositState });
    expect(follow(world, finish).jobs[0]).toMatchObject({ outcome: 'sent' });
    world.chain.tick();
    expect(world.chain.table(world.tableKey).status).toBe('Closed');
    world.seats.forEach((seat, i) => {
      expect(world.chain.balances.of(seat.wallet)).toBe(deposits[i]);
    });
    expect(deposits.reduce((a, c) => a + c, 0n)).toBe(fin.balances.reduce((a, c) => a + c, 0n));
    expect(world.chain.invariants().ok).toBe(true);
  });

  test("a challenge decided too late would be rejected by the chain: the margin is the reconciler's only guard", () => {
    const world = makeWorld();
    const genesis = world.activate();
    const s1 = world.hand(genesis);
    const s2 = world.hand(s1);
    const held = account(world);
    held.current = world.bundle(s2);
    expectOk(world.chain.send(world.players[0], 'startExit', { bundle: world.bundle(s1) }));
    world.chain.advanceTime(world.chain.info.exitWindowSec + 1);
    world.chain.tick();
    const view = { epochBaseNonce: 0n, bundle: held.current, finalBundle: null };
    expect(decide(world, view)).toEqual({ alarm: ALARMS.challengeWindowMissed });
    world.chain.submit(makeJob('challenge', world.tableKey));
    world.chain.tick();
    expect(world.chain.delivered.findLast((e) => e.type === 'JobFailed')).toMatchObject({
      kind: 'challenge',
      error: 'ExitWindowClosed',
      retryable: false,
    });
  });
});
