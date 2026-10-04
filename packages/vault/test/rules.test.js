// Every branch of the client and server rules, driven with hostile input. A lying server must not get a
// signature; an honest one must.
import { describe, expect, test } from 'bun:test';
import { buildNextState } from '../src/build.js';
import { makeBundle } from '../src/bundle.js';
import { hashState } from '../src/eip712.js';
import {
  canDeal,
  clientShouldSign,
  dealBlocker,
  decideSign,
  RULES,
  serverMayCoSign,
} from '../src/rules.js';
import { makeWorld, UNIT } from './fixtures.js';
import { UINT64_MAX } from './gen.js';

const w = makeWorld({ seed: 9 });
const ME = 1; // seat of the player whose client is deciding
const base = w.genesis;
// one hand: seat 0 wins 100 chips from seat 1, 2 chips of rake out of a pot of 200
const hand = w.nextHand(base, {
  winner: 0,
  loser: 1,
  amount: 100n * UNIT,
  rake: 2n * UNIT,
  pot: 200n * UNIT,
});
const seen = { deltas: [98, -100, 0], rake: 2, pot: 200 };

const view = (over = {}) => ({
  me: w.players[ME],
  domain: w.domain,
  tableId: w.tableId,
  roster: w.players,
  unit: UNIT,
  maxRakeBps: 500,
  baseline: base,
  last: null,
  intent: 'play',
  observed: seen,
  ...over,
});
const req = (state = hand, over = {}) => ({
  state,
  domain: w.domain,
  digest: hashState(state, w.domain),
  ...over,
});
const digestOf = (state) => hashState(state, w.domain);
const record = (state, isFinal = false) => ({
  nonce: state.nonce,
  digest: digestOf(state),
  isFinal,
});
// a yes carries the digest the client computed itself: the one it signs
const signs = (state = hand) => ({ ok: true, digest: digestOf(state) });
const refused = (rule) => expect.objectContaining({ ok: false, rule });

const move = (state, patch) => ({ ...state, ...patch });
const withBalance = (state, i, delta) =>
  move(state, { balances: state.balances.map((b, j) => (j === i ? b + delta : b)) });

describe('clientShouldSign: an honest request', () => {
  test('a normal hand is signed', () => {
    expect(clientShouldSign(req(), view())).toEqual(signs());
  });

  test('works with only the state in the request', () => {
    expect(clientShouldSign({ state: hand }, view())).toEqual(signs());
  });

  test('observed chips may be bigint', () => {
    expect(
      clientShouldSign(
        req(),
        view({ observed: { deltas: [98n, -100n, 0n], rake: 2n, pot: 200n } }),
      ),
    ).toEqual(signs());
  });

  test('the next hand extends the one the client signed last', () => {
    const next = w.nextHand(hand, {
      winner: 2,
      loser: 0,
      amount: 30n * UNIT,
      rake: UNIT,
      pot: 60n * UNIT,
    });
    const v = view({
      baseline: hand,
      last: record(hand),
      observed: { deltas: [-30, 0, 29], rake: 1, pot: 60 },
    });
    expect(clientShouldSign(req(next), v)).toEqual(signs(next));
  });

  test('with no observed hand, a state that changes nothing is fine (a pure rotation)', () => {
    const quiet = buildNextState({
      prev: base,
      balances: base.balances,
      final: true,
      keep: [true, true, true],
    });
    expect(clientShouldSign(req(quiet), view({ observed: null, intent: 'rotate' }))).toEqual(
      signs(quiet),
    );
  });

  test('a hand where nobody won anything and a rake of zero', () => {
    const flat = buildNextState({ prev: base, balances: base.balances, volumeDelta: 4n * UNIT });
    expect(
      clientShouldSign(req(flat), view({ observed: { deltas: [0, 0, 0], rake: 0, pot: 4 } })),
    ).toEqual(signs(flat));
  });

  test('dust (a balance that is not a multiple of the unit) rides along untouched', () => {
    // the fixture deposits end in 0, 1 and 2 token units of dust; the hand moved whole chips only
    expect(hand.balances[ME] % UNIT).toBe(base.balances[ME] % UNIT);
    expect(clientShouldSign(req(), view())).toEqual(signs());
  });
});

describe('C1a: nonce and equivocation', () => {
  test('a nonce below the last signed one is refused', () => {
    const later = w.nextHand(hand);
    const v = view({ baseline: hand, last: record(later), observed: null });
    const lower = w.nextHand(hand, { amount: 0n, rake: 0n, pot: 0n });
    expect(lower.nonce).toBe(2n);
    expect(clientShouldSign(req(lower), v)).toEqual(refused('C1a'));
  });

  test('a second, different state at an already signed nonce is refused', () => {
    const twin = w.nextHand(base, {
      winner: 2,
      loser: 1,
      amount: 100n * UNIT,
      rake: 2n * UNIT,
      pot: 200n * UNIT,
    });
    expect(twin.nonce).toBe(hand.nonce);
    const r = clientShouldSign(
      req(twin),
      view({ last: record(hand), observed: { deltas: [0, -100, 98], rake: 2, pot: 200 } }),
    );
    expect(r).toEqual(refused('C1a'));
    expect(r.detail).toMatch(/already signed/);
  });

  test('the identical digest again is approved, so the same signature can be re-sent', () => {
    expect(clientShouldSign(req(), view({ last: record(hand) }))).toEqual(signs());
    // even if the client's picture of the table has moved on since: it already vouched for this state
    expect(clientShouldSign(req(), view({ last: record(hand), observed: null }))).toEqual(signs());
    expect(clientShouldSign(req(), view({ last: record(hand), baseline: hand }))).toEqual(signs());
  });

  test('a repeat of a final state is approved too', () => {
    const final = buildNextState({ prev: base, balances: base.balances, final: true });
    expect(
      clientShouldSign(
        req(final),
        view({ last: record(final, true), intent: 'leave', observed: null }),
      ),
    ).toEqual(signs(final));
  });

  test('a nonce that does not beat the baseline is refused even with no signing record', () => {
    expect(clientShouldSign(req(hand), view({ baseline: hand }))).toEqual(refused('C1a'));
    const old = { ...hand, nonce: 0n };
    expect(clientShouldSign(req(old), view({ baseline: base }))).toEqual(refused('C1a'));
  });
});

describe('C1b: every amount moves by what the client saw', () => {
  const shifted = (i, j, chips) =>
    withBalance(withBalance(hand, i, -chips * UNIT), j, chips * UNIT);

  test('chips moved to the wrong player (still conserved) are refused', () => {
    const r = clientShouldSign(req(shifted(0, 2, 10n)), view());
    expect(r).toEqual(refused('C1b'));
    expect(r.detail).toMatch(/player 0/);
  });

  test('my own balance reduced by more than I lost is refused', () => {
    const r = clientShouldSign(req(shifted(ME, 2, 1n)), view());
    expect(r).toEqual(refused('C1b'));
    expect(r.detail).toMatch(/player 1/);
  });

  test('a single token unit moved (not a whole chip) is refused', () => {
    const dust = withBalance(withBalance(hand, 2, 1n), 0, -1n);
    expect(clientShouldSign(req(dust), view())).toEqual(refused('C1b'));
  });

  test("a rake that differs from the hand's rake is refused", () => {
    const moreRake = move(withBalance(hand, 0, -UNIT), { rake: hand.rake + UNIT });
    expect(clientShouldSign(req(moreRake), view())).toEqual(refused('C1b'));
    expect(clientShouldSign(req(moreRake), view())).toMatchObject({
      detail: expect.stringMatching(/player 0|rake/),
    });
    // the rake alone off, with the winner's balance adjusted to match the observation: only rake is wrong
    const lessRake = move(withBalance(hand, 2, UNIT), { rake: hand.rake - UNIT });
    expect(clientShouldSign(req(lessRake), view())).toEqual(refused('C1b'));
  });

  test('the rake moves by exactly rake * unit, checked on its own', () => {
    const r = clientShouldSign(
      req(),
      view({ observed: { deltas: [98, -100, 0], rake: 3, pot: 200 } }),
    );
    expect(r).toEqual(refused('C1b'));
    expect(r.detail).toMatch(/rake/);
  });

  test('a volume that differs from the pot is refused (a server inflating volume to make room for rake)', () => {
    const inflated = move(hand, { volume: hand.volume * 10n });
    const r = clientShouldSign(req(inflated), view());
    expect(r).toEqual(refused('C1b'));
    expect(r.detail).toMatch(/volume/);
    expect(clientShouldSign(req(), view({ observed: { ...seen, pot: 199 } }))).toEqual(
      refused('C1b'),
    );
  });

  test('when no hand was seen, any movement is refused', () => {
    expect(clientShouldSign(req(), view({ observed: null }))).toEqual(refused('C1b'));
  });

  test('a hand the client saw differently is refused', () => {
    expect(
      clientShouldSign(req(), view({ observed: { deltas: [100, -100, 0], rake: 0, pot: 200 } })),
    ).toEqual(refused('C1b'));
  });
});

describe('C1c: conservation against the last all-signed baseline', () => {
  test('chips created out of nothing are refused', () => {
    const r = clientShouldSign(req(withBalance(hand, 2, UNIT)), view());
    expect(r).toEqual(refused('C1c'));
    expect(r.detail).toMatch(/baseline held/);
  });

  test('chips destroyed are refused', () => {
    expect(clientShouldSign(req(withBalance(hand, 0, -UNIT)), view())).toEqual(refused('C1c'));
    expect(clientShouldSign(req(withBalance(hand, 2, -1n)), view())).toEqual(refused('C1c'));
  });

  test('conservation is reported before the per-player check', () => {
    // someone else's balance is also wrong, but the coarser invariant is the one named
    expect(clientShouldSign(req(withBalance(hand, 2, 7n * UNIT)), view())).toEqual(refused('C1c'));
  });

  test('conservation counts the rake already taken', () => {
    const second = w.nextHand(hand, {
      winner: 2,
      loser: 0,
      amount: 10n * UNIT,
      rake: UNIT,
      pot: 20n * UNIT,
    });
    const v = view({ baseline: hand, observed: { deltas: [-10, 0, 9], rake: 1, pot: 20 } });
    expect(clientShouldSign(req(second), v)).toEqual(signs(second));
    // rake taken but not deducted from anyone: balances + rake no longer match
    const cheat = move(second, { rake: second.rake + UNIT });
    expect(clientShouldSign(req(cheat), v)).toEqual(refused('C1c'));
  });
});

describe('C1d: the pinned table, roster and domain', () => {
  test('another table', () => {
    const r = clientShouldSign(req(move(hand, { tableId: `0x${'ab'.repeat(32)}` })), view());
    expect(r).toEqual(refused('C1d'));
    expect(r.detail).toMatch(/table/);
  });

  test('another roster: different players, or fewer of them', () => {
    const other = makeWorld({ seed: 77 });
    expect(clientShouldSign(req(move(hand, { players: other.players })), view())).toEqual(
      refused('C1d'),
    );
    const two = move(hand, {
      players: hand.players.slice(0, 2),
      balances: hand.balances.slice(0, 2),
      keep: hand.keep.slice(0, 2),
    });
    expect(clientShouldSign(req(two), view())).toEqual(refused('C1d'));
    // one seat swapped for a stranger who still sorts into place
    const stranger = `0x${(BigInt(hand.players[2]) + 1n).toString(16).padStart(40, '0')}`;
    expect(
      clientShouldSign(
        req(move(hand, { players: [...hand.players.slice(0, 2), stranger] })),
        view(),
      ),
    ).toEqual(refused('C1d'));
  });

  test('a reordered roster is not even a State (the contract needs ascending players)', () => {
    const rev = (list) => [...list].reverse();
    const reordered = move(hand, {
      players: rev(hand.players),
      balances: rev(hand.balances),
      keep: rev(hand.keep),
    });
    expect(clientShouldSign(req(reordered), view())).toEqual(refused('MALFORMED'));
  });

  test("the client's own pinned roster must be a roster the baseline is for", () => {
    expect(clientShouldSign(req(), view({ roster: [...w.players].reverse() }))).toEqual(
      refused('VIEW'),
    );
  });

  test('a request for another chain or another vault', () => {
    expect(clientShouldSign(req(hand, { domain: { ...w.domain, chainId: 1 } }), view())).toEqual(
      refused('C1d'),
    );
    expect(
      clientShouldSign(
        req(hand, { domain: { ...w.domain, verifyingContract: `0x${'cc'.repeat(20)}` } }),
        view(),
      ),
    ).toEqual(refused('C1d'));
  });

  test('a digest computed for another domain is refused: the client signs only its own digest', () => {
    const elsewhere = hashState(hand, { ...w.domain, chainId: 137 });
    expect(clientShouldSign({ state: hand, digest: elsewhere }, view())).toEqual(refused('C1d'));
    expect(clientShouldSign({ state: hand, digest: `0x${'00'.repeat(32)}` }, view())).toEqual(
      refused('C1d'),
    );
  });

  test('the digest comparison ignores case', () => {
    const loud = `0x${digestOf(hand).slice(2).toUpperCase()}`;
    expect(clientShouldSign({ state: hand, digest: loud }, view())).toEqual(signs());
  });

  test('identity is checked before anything about nonces or money', () => {
    const lower = move(hand, {
      tableId: `0x${'ab'.repeat(32)}`,
      nonce: 0n,
      balances: [0n, 0n, 0n],
    });
    expect(
      clientShouldSign(
        req(lower),
        view({ last: { nonce: 9n, digest: digestOf(hand), isFinal: true } }),
      ),
    ).toEqual(refused('C1d'));
  });
});

describe('C1e: the rake cap', () => {
  test("rake above the vault's share of volume is refused even when everything else matches", () => {
    // hand rake is 2 of 200 = 100 bps
    expect(clientShouldSign(req(), view({ maxRakeBps: 100 }))).toEqual(signs());
    const r = clientShouldSign(req(), view({ maxRakeBps: 99 }));
    expect(r).toEqual(refused('C1e'));
    expect(r.detail).toMatch(/bps/);
  });

  test('rake that goes down is refused', () => {
    const paid = buildNextState({ prev: base, balances: base.balances, rakeDelta: 0n });
    const withRake = {
      ...paid,
      rake: 5n * UNIT,
      volume: 1000n * UNIT,
      balances: paid.balances.map((b, i) => (i === 0 ? b - 5n * UNIT : b)),
    };
    const lowered = buildNextState({ prev: withRake, balances: withRake.balances });
    const decreased = { ...lowered, rake: 2n * UNIT };
    expect(clientShouldSign(req(decreased), view({ baseline: withRake, observed: null }))).toEqual(
      refused('C1e'),
    );
  });

  test('the cap is checked against cumulative volume, not just this hand', () => {
    const rich = {
      ...base,
      volume: 10_000n * UNIT,
      rake: 100n * UNIT,
      balances: base.balances.map((b, i) => (i === 0 ? b - 100n * UNIT : b)),
    };
    const next = w.nextHand(rich, {
      winner: 0,
      loser: 1,
      amount: 4n * UNIT,
      rake: 3n * UNIT,
      pot: 8n * UNIT,
    });
    // 3 of 8 is 37%, but cumulatively 103 of 10008 is 1.03%: within 500 bps
    expect(
      clientShouldSign(
        req(next),
        view({ baseline: rich, observed: { deltas: [1, -4, 0], rake: 3, pot: 8 } }),
      ),
    ).toEqual(signs(next));
  });

  test('is reported before conservation and amounts', () => {
    const r = clientShouldSign(req(withBalance(hand, 2, UNIT)), view({ maxRakeBps: 1 }));
    expect(r).toEqual(refused('C1e'));
  });
});

describe('C2: final states', () => {
  const finalOf = (keep) =>
    buildNextState({ prev: base, balances: base.balances, final: true, keep });
  const leave = finalOf([true, false, true]);

  test('a final state is refused when the client is not leaving or rotating', () => {
    expect(clientShouldSign(req(leave), view({ observed: null, intent: 'play' }))).toEqual(
      refused('C2'),
    );
  });

  test('a leaving player signs a final state that pays them out', () => {
    expect(clientShouldSign(req(leave), view({ observed: null, intent: 'leave' }))).toEqual(
      signs(leave),
    );
  });

  test('a leaving player refuses a final state that keeps their chips at the table', () => {
    const r = clientShouldSign(
      req(finalOf([false, true, true])),
      view({ observed: null, intent: 'leave' }),
    );
    expect(r).toEqual(refused('C2'));
    expect(r.detail).toMatch(/keeps your chips/);
  });

  test('a staying player signs a rotation, kept or paid out', () => {
    for (const keep of [
      [true, true, true],
      [false, false, false],
      [true, false, true],
    ]) {
      expect(
        clientShouldSign(req(finalOf(keep)), view({ observed: null, intent: 'rotate' })),
      ).toEqual(signs(finalOf(keep)));
    }
  });

  test('a kept seat with nothing would make settle revert with BadKeep: refused', () => {
    const broke = buildNextState({
      prev: base,
      balances: [0n, base.balances[1] + base.balances[0], base.balances[2]],
      final: true,
      keep: [true, true, true],
    });
    const r = clientShouldSign(
      req(broke),
      view({ observed: { deltas: [-1000, 1000, 0], rake: 0, pot: 0 }, intent: 'rotate' }),
    );
    expect(r).toEqual(refused('C2'));
    expect(r.detail).toMatch(/BadKeep/);
  });

  test('a final state still has to match the hand that just ended (rotation folded into a hand-end state)', () => {
    const folded = buildNextState({
      prev: base,
      balances: hand.balances,
      rakeDelta: 2n * UNIT,
      volumeDelta: 200n * UNIT,
      final: true,
      keep: [true, true, true],
    });
    expect(clientShouldSign(req(folded), view({ intent: 'rotate' }))).toEqual(signs(folded));
    expect(
      clientShouldSign(
        req(withBalance(withBalance(folded, 0, 1n), 2, -1n)),
        view({ intent: 'rotate' }),
      ),
    ).toEqual(refused('C1b'));
  });

  test('nothing above a final state signed in this epoch', () => {
    const signedFinal = { ...record(leave), isFinal: true };
    const after = w.nextHand(leave);
    const v = view({ baseline: leave, last: signedFinal, observed: null });
    const r = clientShouldSign(req(after), v);
    expect(r).toEqual(refused('C2'));
    expect(r.detail).toMatch(/nothing may follow/);
    // a lower nonce after a final is still C1a, an equal nonce with another digest too
    expect(clientShouldSign(req(hand), view({ last: signedFinal, observed: null }))).toEqual(
      refused('C1a'),
    );
  });

  test('a second, different final state at the same nonce is equivocation', () => {
    const other = finalOf([true, true, true]);
    expect(
      clientShouldSign(
        req(other),
        view({ last: record(leave, true), observed: null, intent: 'rotate' }),
      ),
    ).toEqual(refused('C1a'));
  });
});

describe('malformed requests and views are refused, never thrown', () => {
  test('MALFORMED: a request that is not a State', () => {
    for (const state of [
      null,
      undefined,
      { ...hand, nonce: UINT64_MAX + 1n },
      { ...hand, players: [...hand.players].reverse() },
      { ...hand, keep: [true] },
      { ...hand, balances: [1n, 2n] },
      { ...hand, tableId: '0x12' },
      'state',
    ]) {
      expect(clientShouldSign({ state }, view())).toEqual(refused('MALFORMED'));
    }
    expect(clientShouldSign(undefined, view())).toEqual(refused('MALFORMED'));
    expect(clientShouldSign(null, view())).toEqual(refused('MALFORMED'));
  });

  test('VIEW: a client view that cannot be used', () => {
    const bad = [
      undefined,
      null,
      'view',
      view({ unit: 0n }),
      view({ unit: 10_000 }),
      view({ maxRakeBps: -1 }),
      view({ maxRakeBps: 10_001 }),
      view({ maxRakeBps: 5.5 }),
      view({ intent: 'bet' }),
      view({ intent: undefined }),
      view({ me: `0x${'77'.repeat(20)}` }), // not on the roster
      view({ me: 'me' }),
      view({ roster: 'players' }),
      view({ roster: undefined }),
      view({ tableId: '0x12' }),
      view({ domain: undefined }),
      view({ baseline: null }),
      view({ baseline: { ...base, tableId: `0x${'ab'.repeat(32)}` } }),
      view({
        baseline: { ...base, players: [base.players[0], base.players[1], `0x${'ff'.repeat(20)}`] },
      }),
      view({ observed: { deltas: [1, 2], rake: 0, pot: 0 } }),
      view({ observed: { deltas: [1.5, 0, 0], rake: 0, pot: 0 } }),
      view({ observed: { deltas: ['1', 0, 0], rake: 0, pot: 0 } }),
      view({ observed: { deltas: [0, 0, 0], rake: undefined, pot: 0 } }),
      view({ last: { nonce: 'x', digest: digestOf(hand) } }),
      view({ last: { nonce: 1n, digest: '0x12' } }),
    ];
    for (const v of bad) expect(clientShouldSign(req(), v)).toEqual(refused('VIEW'));
  });

  test('MALFORMED is reported before VIEW', () => {
    expect(clientShouldSign({ state: null }, null)).toEqual(refused('MALFORMED'));
  });
});

describe('rule ordering', () => {
  test('C1d before C1a', () => {
    const wrongTable = move(hand, { tableId: `0x${'ab'.repeat(32)}` });
    expect(
      clientShouldSign(
        req(wrongTable),
        view({ last: { nonce: 99n, digest: digestOf(hand), isFinal: false } }),
      ),
    ).toEqual(refused('C1d'));
  });
  test('C1a before C1b: a lower nonce with the wrong amounts is a nonce problem', () => {
    const lower = move(withBalance(hand, 2, UNIT), { nonce: hand.nonce });
    const r = clientShouldSign(
      req(lower),
      view({ last: { nonce: 5n, digest: digestOf(hand), isFinal: false } }),
    );
    expect(r).toEqual(refused('C1a'));
  });
  test('C2 (not leaving) before the money', () => {
    const final = move(withBalance(hand, 2, UNIT), { isFinal: true });
    expect(clientShouldSign(req(final), view())).toEqual(refused('C2'));
  });
  test('C1e before C1c before C1b', () => {
    expect(clientShouldSign(req(withBalance(hand, 2, UNIT)), view({ maxRakeBps: 1 }))).toEqual(
      refused('C1e'),
    );
    expect(clientShouldSign(req(withBalance(hand, 2, UNIT)), view())).toEqual(refused('C1c'));
    expect(
      clientShouldSign(req(withBalance(withBalance(hand, 2, UNIT), 0, -UNIT)), view()),
    ).toEqual(refused('C1b'));
  });
});

describe('decideSign', () => {
  const D1 = `0x${'01'.repeat(32)}`;
  const D2 = `0x${'02'.repeat(32)}`;
  const last = (nonce, digest = D1, isFinal = false) => ({ nonce, digest, isFinal });
  const table = [
    ['no record yet', { req: { nonce: 0n, digest: D1 }, last: null }, 'new'],
    ['no record (undefined)', { req: { nonce: 7n, digest: D1 }, last: undefined }, 'new'],
    ['a higher nonce', { req: { nonce: 6n, digest: D2 }, last: last(5n) }, 'new'],
    [
      'a much higher nonce (skipped nonces are fine)',
      { req: { nonce: 500n, digest: D2 }, last: last(5n) },
      'new',
    ],
    [
      'the maximum nonce',
      { req: { nonce: UINT64_MAX, digest: D2 }, last: last(UINT64_MAX - 1n) },
      'new',
    ],
    ['same nonce, same digest', { req: { nonce: 5n, digest: D1 }, last: last(5n) }, 'repeat'],
    [
      'same nonce, same digest, different case',
      { req: { nonce: 5n, digest: D1.toUpperCase().replace('0X', '0x') }, last: last(5n) },
      'repeat',
    ],
    [
      'same nonce, same digest, after a final',
      { req: { nonce: 5n, digest: D1 }, last: last(5n, D1, true) },
      'repeat',
    ],
    [
      'same nonce, different digest',
      { req: { nonce: 5n, digest: D2 }, last: last(5n) },
      'refuse-equivocation',
    ],
    [
      'same nonce, different digest, after a final',
      { req: { nonce: 5n, digest: D2 }, last: last(5n, D1, true) },
      'refuse-equivocation',
    ],
    ['a lower nonce', { req: { nonce: 4n, digest: D2 }, last: last(5n) }, 'refuse-lower'],
    [
      'a lower nonce with the very digest signed before',
      { req: { nonce: 4n, digest: D1 }, last: last(5n) },
      'refuse-lower',
    ],
    ['nonce 0 below 1', { req: { nonce: 0n, digest: D2 }, last: last(1n) }, 'refuse-lower'],
    [
      'a lower nonce after a final',
      { req: { nonce: 4n, digest: D2 }, last: last(5n, D1, true) },
      'refuse-lower',
    ],
    [
      'a higher nonce after a final',
      { req: { nonce: 6n, digest: D2 }, last: last(5n, D1, true) },
      'refuse-after-final',
    ],
    [
      'a higher nonce after a final, any digest',
      { req: { nonce: 6n, digest: D1 }, last: last(5n, D1, true) },
      'refuse-after-final',
    ],
    [
      'a truthy non-boolean final flag counts as final',
      { req: { nonce: 6n, digest: D2 }, last: last(5n, D1, 1) },
      'refuse-after-final',
    ],
    ['safe-integer nonces are accepted', { req: { nonce: 6, digest: D2 }, last: last(5) }, 'new'],
  ];
  for (const [name, args, expected] of table) {
    test(`${name} -> ${expected}`, () => {
      expect(decideSign(args)).toBe(expected);
    });
  }

  test('bad arguments throw instead of guessing', () => {
    for (const args of [
      { req: { nonce: 'x', digest: D1 }, last: null },
      { req: { nonce: -1n, digest: D1 }, last: null },
      { req: { nonce: 1n, digest: '0x12' }, last: null },
      { req: { nonce: 1n }, last: null },
      { req: null, last: null },
      { req: { nonce: 1n, digest: D1 }, last: { nonce: 'x', digest: D1 } },
      { req: { nonce: 1n, digest: D1 }, last: { nonce: 1n, digest: 'x' } },
    ]) {
      expect(() => decideSign(args)).toThrow(TypeError);
    }
  });

  test('walks a whole epoch: new, repeat, refuse-lower, equivocation, final, after-final', () => {
    let record = null;
    const step = (nonce, digest, isFinal = false) => {
      const decision = decideSign({ req: { nonce, digest }, last: record });
      if (decision === 'new') record = { nonce, digest, isFinal };
      return decision;
    };
    expect(step(1n, D1)).toBe('new');
    expect(step(1n, D1)).toBe('repeat');
    expect(step(2n, D1)).toBe('new');
    expect(step(1n, D2)).toBe('refuse-lower');
    expect(step(2n, D2)).toBe('refuse-equivocation');
    expect(step(3n, D2, true)).toBe('new');
    expect(step(3n, D2, true)).toBe('repeat');
    expect(step(4n, D1)).toBe('refuse-after-final');
    expect(step(3n, D1)).toBe('refuse-equivocation');
    expect(record).toEqual({ nonce: 3n, digest: D2, isFinal: true });
  });
});

describe('S3: serverMayCoSign', () => {
  const HOUR = 3_600_000;
  test('allows a key within its policy lifetime, and exactly at the limit', () => {
    expect(serverMayCoSign({ sessionKeyAgeMs: 0, policyMaxMs: 12 * HOUR })).toBe(true);
    expect(serverMayCoSign({ sessionKeyAgeMs: 11 * HOUR, policyMaxMs: 12 * HOUR })).toBe(true);
    expect(serverMayCoSign({ sessionKeyAgeMs: 12 * HOUR, policyMaxMs: 12 * HOUR })).toBe(true);
    expect(serverMayCoSign({ sessionKeyAgeMs: 0, policyMaxMs: 0 })).toBe(true);
  });

  test('refuses a key past its expiry', () => {
    expect(serverMayCoSign({ sessionKeyAgeMs: 12 * HOUR + 1, policyMaxMs: 12 * HOUR })).toBe(false);
    expect(serverMayCoSign({ sessionKeyAgeMs: 1, policyMaxMs: 0 })).toBe(false);
  });

  test('says no to anything that is not a usable time', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, '5', null, undefined, 5n]) {
      expect(serverMayCoSign({ sessionKeyAgeMs: bad, policyMaxMs: HOUR })).toBe(false);
      expect(serverMayCoSign({ sessionKeyAgeMs: 1, policyMaxMs: bad })).toBe(false);
    }
    expect(serverMayCoSign({})).toBe(false);
    expect(serverMayCoSign()).toBe(false);
  });
});

describe('S1: canDeal', () => {
  const state = w.nextHand(base);
  const sigs = w.sign(state);
  const bundle = makeBundle({ domain: w.domain, state, ...sigs });
  const members = w.players.map(() => ({ claimed: true, online: true }));
  const keys = { arbiter: w.arbiter, sessionKeyOf: w.sessionKeyOf };
  // the verifier and what this table is are required: the gate checks the bundle itself
  const open = (over = {}) => ({
    active: true,
    roundOpen: false,
    head: state.nonce,
    bundle,
    members,
    verify: keys,
    tableId: w.tableId,
    domain: w.domain,
    ...over,
  });
  const blocked = (reason) => expect.objectContaining({ reason });

  test('true when the last state is fully signed and everyone is here', () => {
    expect(canDeal(open())).toBe(true);
    expect(dealBlocker(open())).toBeNull();
  });

  test('true for the first hand of an epoch: nothing proposed, nothing to wait for', () => {
    expect(canDeal(open({ head: null, bundle: null }))).toBe(true);
  });

  test('a missing head is a bad view, not "no hand yet": only an explicit null opens the first hand', () => {
    expect(dealBlocker(open({ head: undefined, bundle: undefined }))).toEqual(blocked('bad-view'));
    const noHeadKey = open({ bundle: null });
    delete noHeadKey.head;
    expect(dealBlocker(noHeadKey)).toEqual(blocked('bad-view'));
  });

  test('returns real booleans', () => {
    expect(canDeal(open())).toBe(true);
    expect(canDeal(open({ active: false }))).toBe(false);
  });

  const cases = [
    ['the epoch is not active', { active: false }, 'not-active'],
    ['a round is still open', { roundOpen: true }, 'round-open'],
    ['a state was proposed but there is no bundle', { bundle: null }, 'no-bundle'],
    ['the bundle is behind the head', { head: state.nonce + 1n }, 'bundle-not-head'],
    ['the bundle is ahead of the head', { head: state.nonce - 1n }, 'bundle-not-head'],
    [
      'the bundle is a final state',
      { bundle: { ...bundle, state: { ...state, isFinal: true } } },
      'bundle-final',
    ],
    [
      'the arbiter signature is missing',
      { bundle: { ...bundle, arbiterSig: '' } },
      'bundle-incomplete',
    ],
    [
      'a player signature is missing',
      { bundle: { ...bundle, playerSigs: ['', ...bundle.playerSigs.slice(1)] } },
      'bundle-incomplete',
    ],
    [
      'a player signature is short',
      { bundle: { ...bundle, playerSigs: [bundle.playerSigs[0], '0x12', bundle.playerSigs[2]] } },
      'bundle-incomplete',
    ],
    [
      'one player signature is absent',
      { bundle: { ...bundle, playerSigs: bundle.playerSigs.slice(1) } },
      'bundle-incomplete',
    ],
    [
      'a member has not claimed their seat',
      { members: members.map((m, i) => (i === 2 ? { ...m, claimed: false } : m)) },
      'member-not-claimed',
    ],
    [
      'a member is offline',
      { members: members.map((m, i) => (i === 0 ? { ...m, online: false } : m)) },
      'member-offline',
    ],
    [
      'the bundle covers a different number of players than the table has',
      { members: members.slice(1) },
      'bundle-incomplete',
    ],
    ['there are fewer than two members', { members: [members[0]], head: null }, 'bad-view'],
    ['a member entry is junk', { members: [members[0], null, members[2]] }, 'member-not-claimed'],
    [
      'a "claimed" that is merely truthy is not enough',
      { members: members.map((m) => ({ ...m, claimed: 1 })) },
      'member-not-claimed',
    ],
    ['active is not a boolean', { active: 'yes' }, 'bad-view'],
    ['roundOpen is missing', { roundOpen: undefined }, 'bad-view'],
    ['members is missing', { members: undefined }, 'bad-view'],
  ];
  for (const [name, patch, reason] of cases) {
    test(`false when ${name}`, () => {
      expect(canDeal(open(patch))).toBe(false);
      expect(dealBlocker(open(patch))).toEqual(blocked(reason));
    });
  }

  test('never throws on junk and says no', () => {
    for (const junk of [undefined, null, 5, 'view', {}, [], { active: true }]) {
      expect(canDeal(junk)).toBe(false);
    }
    expect(canDeal(open({ head: 'x' }))).toBe(false);
    expect(canDeal(open({ bundle: { state: null } }))).toBe(false);
  });

  test('the signatures themselves are checked, not just their presence', () => {
    expect(canDeal(open())).toBe(true);
    const forged = { ...bundle, playerSigs: [bundle.playerSigs[1], ...bundle.playerSigs.slice(1)] };
    expect(dealBlocker(open({ bundle: forged }))).toEqual(blocked('bundle-invalid'));
    expect(canDeal(open({ verify: { ...keys, arbiter: makeWorld({ seed: 33 }).arbiter } }))).toBe(
      false,
    );
  });

  test('the verifier is mandatory: without one the gate stays closed, with its own reason', () => {
    for (const verify of [
      undefined,
      null,
      'yes',
      {},
      { arbiter: w.arbiter },
      { ...keys, arbiter: 'x' },
    ]) {
      expect(dealBlocker(open({ verify })), String(verify)).toEqual(blocked('no-verifier'));
    }
    // even when a bundle that merely looks complete is on hand, and even before the first hand
    expect(canDeal(open({ verify: undefined, head: null, bundle: null }))).toBe(false);
  });

  test('the order of the reasons: active, round, members, then the bundle', () => {
    const everything = open({
      active: false,
      roundOpen: true,
      members: members.map((m) => ({ ...m, online: false })),
      bundle: null,
    });
    expect(dealBlocker(everything).reason).toBe('not-active');
    expect(dealBlocker({ ...everything, active: true }).reason).toBe('round-open');
    expect(dealBlocker({ ...everything, active: true, roundOpen: false }).reason).toBe(
      'member-offline',
    );
    expect(dealBlocker({ ...everything, active: true, roundOpen: false, members }).reason).toBe(
      'no-bundle',
    );
  });
});

describe('RULES', () => {
  test('lists every rule id the predicates can name', () => {
    for (const id of ['C1a', 'C1b', 'C1c', 'C1d', 'C1e', 'C2', 'S1', 'S3', 'S4']) {
      expect(typeof RULES[id]).toBe('string');
    }
    expect(Object.isFrozen(RULES)).toBe(true);
  });
});
