// The client ledger (F8): what this client saw at the table, from the CURRENT PUBLIC TABLE STATE, in the form
// clientShouldSign compares a proposal with. Every way the server's account can be missing, half-done or
// contradictory must come out as "wait" or "refuse", never as a guess.
import { describe, expect, test } from 'bun:test';
import { buildNextState, epochBaseline } from '../src/build.js';
import { createLedger, LEDGER_BLOCKERS } from '../src/ledger.js';
import { clientShouldSign } from '../src/rules.js';
import { makeWorld } from './fixtures.js';

const UNIT = 10_000n;
const w = makeWorld({ seed: 21, n: 4, deposits: [0n, 0n, 0n, 0n] });
const [A, B, C, D] = w.players; // ascending: state order
// the base: 1000/800/600/400 chips, with dust on two of them (dust never moves in a hand)
const base = epochBaseline({
  tableId: w.tableId,
  players: w.players,
  deposits: [1000n * UNIT + 7n, 800n * UNIT, 600n * UNIT + 9_999n, 400n * UNIT],
  nonce: 4n,
  rake: 3n * UNIT,
  volume: 300n * UNIT,
});

// seats are in table order, which is not state order: the ledger must map by address
const SEAT_OF = { [C]: 0, [A]: 1, [D]: 3, [B]: 4 };
const seat = (address, chips, over = {}) => ({
  seat: SEAT_OF[address],
  playerId: `p${SEAT_OF[address]}`,
  name: `n${SEAT_OF[address]}`,
  chips,
  bet: 0,
  folded: false,
  allIn: false,
  hasCards: false,
  status: 'seated',
  connected: true,
  address,
  ...over,
});
const tbl = ({
  chips,
  handNo = 7,
  inHand = false,
  epoch = 2,
  events = [],
  over = {},
  seats,
} = {}) => {
  const list = Array.from({ length: 6 }, () => null);
  for (const s of seats ?? [A, B, C, D].map((p, i) => seat(p, chips[i]))) list[s.seat] = s;
  return {
    t: 'tbl',
    tableId: 'vault-1',
    seq: 1,
    state: { tableId: 'vault-1', handNo, inHand, seats: list, vault: { epoch }, ...over },
    events,
  };
};
const handEnd = (result) => ({ type: 'hand-end', result });
// hand 7: A wins 100 from B, 2 chips of rake out of a pot of 200; C and D fold having put in nothing
const AFTER = [1098, 700, 600, 400];
const stacksOf = (chips) => {
  const stacks = Array.from({ length: 6 }, () => 0);
  [A, B, C, D].forEach((p, i) => {
    stacks[SEAT_OF[p]] = chips[i];
  });
  return stacks;
};
const result7 = { handNo: 7, pot: 200, rake: 2, stacks: stacksOf(AFTER), busted: [] };
const roster = w.players;
const ask = (ledger, handNo = 7) => ledger.observedStatus({ base, roster, handNo });
const watched = () => {
  const ledger = createLedger({ unit: UNIT });
  ledger.observeTable(tbl({ chips: AFTER, events: [handEnd(result7)] }));
  return ledger;
};

describe('createLedger', () => {
  test('the unit must be a positive bigint, the table id a string', () => {
    for (const unit of [undefined, 0n, -1n, 10_000, '10000']) {
      expect(() => createLedger({ unit })).toThrow(TypeError);
    }
    expect(() => createLedger()).toThrow(TypeError);
    expect(() => createLedger({ unit: UNIT, tableId: 7 })).toThrow(TypeError);
  });

  test('every blocker is either wait or permanent, and the table is frozen', () => {
    expect(Object.isFrozen(LEDGER_BLOCKERS)).toBe(true);
    for (const kind of Object.values(LEDGER_BLOCKERS))
      expect(['wait', 'permanent']).toContain(kind);
    expect(LEDGER_BLOCKERS['mid-hand']).toBe('wait');
    expect(LEDGER_BLOCKERS.conflict).toBe('permanent');
  });
});

describe('a hand watched live', () => {
  test('deltas from the stacks in state order, rake as minus their sum, the pot from the hand-end result', () => {
    expect(ask(watched())).toEqual({
      ok: true,
      observed: { deltas: [98, -100, 0, 0], rake: 2, pot: 200 },
    });
    expect(watched().observedFor({ base, roster, handNo: 7 })).toEqual({
      deltas: [98, -100, 0, 0],
      rake: 2,
      pot: 200,
    });
  });

  test('dust is floored away: a base balance of 600 chips + 9999 units shows as 600', () => {
    const ledger = createLedger({ unit: UNIT });
    ledger.observeTable(tbl({ chips: [1000, 800, 600, 400] }));
    expect(ledger.observedFor({ base, roster })).toEqual({
      deltas: [0, 0, 0, 0],
      rake: 0,
      pot: null,
    });
  });

  test('what it reports is exactly what clientShouldSign needs to sign the honest state', () => {
    const balances = [...base.balances];
    balances[0] += 98n * UNIT;
    balances[1] -= 100n * UNIT;
    const state = buildNextState({
      prev: base,
      balances,
      rakeDelta: 2n * UNIT,
      volumeDelta: 200n * UNIT,
    });
    const view = {
      me: C,
      domain: w.domain,
      tableId: w.tableId,
      roster,
      unit: UNIT,
      maxRakeBps: 500,
      baseline: base,
      last: null,
      intent: 'play',
    };
    expect(
      clientShouldSign(
        { state },
        { ...view, observed: watched().observedFor({ base, roster, handNo: 7 }) },
      ),
    ).toMatchObject({ ok: true });
    // the same state with the volume of another pot is refused: the live pot binds the volume
    const padded = { ...state, volume: state.volume + UNIT };
    expect(
      clientShouldSign({ state: padded }, { ...view, observed: ask(watched()).observed }),
    ).toMatchObject({
      ok: false,
      rule: 'C1b',
    });
  });

  test('a hand-end event delivered on its own (observeEvent) counts the same as one inside a table message', () => {
    const ledger = createLedger({ unit: UNIT });
    ledger.observeTable(tbl({ chips: AFTER }));
    expect(ledger.observeEvent(handEnd(result7))).toEqual({ ok: true, stored: true });
    expect(ask(ledger).observed.pot).toBe(200);
  });
});

describe('the pot belongs to the hand the proposal names (a standalone final follows no hand)', () => {
  test('handNo null: no pot, even though the table still shows hand 7 and its live result', () => {
    // A rotation proposed between hands has unchanged balances and volume. Comparing it with hand 7's pot
    // would refuse an honest leave.
    const ledger = watched();
    const after7 = { ...base, nonce: base.nonce + 1n };
    after7.balances = base.balances.map((b, i) => b + BigInt([98, -100, 0, 0][i]) * UNIT);
    expect(ledger.observedStatus({ base: after7, roster, handNo: null })).toEqual({
      ok: true,
      observed: { deltas: [0, 0, 0, 0], rake: 0, pot: null },
    });
    expect(ledger.observedStatus({ base: after7, roster }).observed.pot).toBeNull();
  });

  test('a proposal for another hand than the one the table shows gets no pot', () => {
    expect(ask(watched(), 6).observed).toEqual({ deltas: [98, -100, 0, 0], rake: 2, pot: null });
    expect(ask(watched(), 8).observed.pot).toBeNull();
  });

  test('a handNo that is not a whole number is no hand at all', () => {
    for (const handNo of ['7', 7.5, -7, Number.NaN]) {
      expect(ask(watched(), handNo).observed.pot).toBeNull();
    }
  });
});

describe('a client that did not watch the hand live', () => {
  test('a reconnect (no events at all): the stacks give the deltas and the rake, the pot is unknown (null)', () => {
    const ledger = createLedger({ unit: UNIT });
    ledger.observeTable(tbl({ chips: AFTER }));
    expect(ask(ledger)).toEqual({
      ok: true,
      observed: { deltas: [98, -100, 0, 0], rake: 2, pot: null },
    });
  });

  test('an aborted hand leaves every stack where it was: all deltas 0, no rake', () => {
    const ledger = createLedger({ unit: UNIT });
    ledger.observeTable(tbl({ chips: [1000, 800, 600, 400], events: [{ type: 'hand-aborted' }] }));
    expect(ask(ledger)).toEqual({
      ok: true,
      observed: { deltas: [0, 0, 0, 0], rake: 0, pot: null },
    });
  });

  test('members who are not in the engine (waiting, sitting out) are read from the public seat state too', () => {
    // C sits out and D is waiting: the engine's result has 0 for both, the table shows their real chips
    const seats = [
      seat(A, 1098),
      seat(B, 700),
      seat(C, 600, { status: 'sitout' }),
      seat(D, 400, { status: 'waiting' }),
    ];
    const stacks = stacksOf([1098, 700, 0, 0]);
    const ledger = createLedger({ unit: UNIT });
    ledger.observeTable(tbl({ seats, events: [handEnd({ ...result7, stacks })] }));
    expect(ask(ledger)).toEqual({
      ok: true,
      observed: { deltas: [98, -100, 0, 0], rake: 2, pot: 200 },
    });
  });
});

describe('the server contradicts itself: refuse, never guess', () => {
  test('a hand-end result that disagrees with a stack is a permanent conflict, on record', () => {
    const ledger = createLedger({ unit: UNIT });
    const lie = { ...result7, stacks: stacksOf([1099, 700, 600, 400]) }; // A is shown 1098
    ledger.observeTable(tbl({ chips: AFTER, events: [handEnd(lie)] }));
    expect(ask(ledger)).toMatchObject({ ok: false, reason: 'conflict', permanent: true });
    expect(ledger.observedFor({ base, roster, handNo: 7 })).toBeNull();
    expect(ledger.conflicts()).toEqual([
      expect.objectContaining({ kind: 'stacks', epoch: 2, handNo: 7 }),
    ]);
  });

  test('a result whose rake is not what the stacks lost is a conflict', () => {
    const ledger = createLedger({ unit: UNIT });
    ledger.observeTable(tbl({ chips: AFTER, events: [handEnd({ ...result7, rake: 3 })] }));
    expect(ask(ledger)).toMatchObject({ ok: false, reason: 'conflict', permanent: true });
    expect(ledger.conflicts()[0]).toMatchObject({ kind: 'rake' });
  });

  test('a seat the result says busted must show 0 chips', () => {
    // B busts: the result has 0 for B's seat and lists it as busted; the table shows B with chips
    const bust = {
      handNo: 7,
      pot: 1600,
      rake: 2,
      stacks: stacksOf([1798, 0, 600, 400]),
      busted: [SEAT_OF[B]],
    };
    const honest = createLedger({ unit: UNIT });
    honest.observeTable(tbl({ chips: [1798, 0, 600, 400], events: [handEnd(bust)] }));
    expect(ask(honest).observed).toEqual({ deltas: [798, -800, 0, 0], rake: 2, pot: 1600 });
    // The same hand, but B is shown with 2 chips taken from C, who sat it out (0 in the result, not
    // compared). Every other seat and the rake still add up: only "busted means 0" catches it.
    const seats = [seat(A, 1798), seat(B, 2), seat(C, 598, { status: 'sitout' }), seat(D, 400)];
    const lie = { ...bust, stacks: stacksOf([1798, 0, 0, 400]) };
    const lying = createLedger({ unit: UNIT });
    lying.observeTable(tbl({ seats, events: [handEnd(lie)] }));
    expect(ask(lying)).toMatchObject({ ok: false, reason: 'conflict', permanent: true });
    expect(lying.conflicts()).toEqual([expect.objectContaining({ kind: 'stacks' })]);
  });

  test('two different results for one hand: the first is kept, and that hand can no longer be judged', () => {
    const ledger = watched();
    expect(ledger.observeEvent(handEnd({ ...result7, pot: 202 }))).toEqual({
      ok: true,
      stored: false,
      conflict: true,
    });
    expect(ask(ledger)).toMatchObject({ ok: false, reason: 'conflict', permanent: true });
    expect(ledger.conflicts()).toEqual([expect.objectContaining({ kind: 'hand-end', handNo: 7 })]);
    // an identical repeat is not a conflict
    const again = watched();
    expect(again.observeEvent(handEnd(result7))).toEqual({ ok: true, stored: false });
    expect(again.observeEvent(handEnd({ ...result7, busted: [1] }))).toMatchObject({
      conflict: true,
    });
    expect(ask(watched()).ok).toBe(true);
  });

  test('a conflict about another hand does not block this one; the same hand number in another epoch is another hand', () => {
    const ledger = createLedger({ unit: UNIT });
    ledger.observeEvent(handEnd({ ...result7, handNo: 5 }), 2);
    ledger.observeEvent(handEnd({ ...result7, handNo: 5, pot: 1 }), 2);
    expect(ledger.conflicts()).toHaveLength(1);
    // hand 7 of epoch 1 is not hand 7 of epoch 2
    expect(ledger.observeEvent(handEnd({ ...result7, pot: 999 }), 1)).toEqual({
      ok: true,
      stored: true,
    });
    ledger.observeTable(tbl({ chips: AFTER, events: [handEnd(result7)] }));
    expect(ask(ledger).observed.pot).toBe(200);
  });

  test('two seats showing one address is a permanent refusal', () => {
    const seats = [seat(A, 1098), seat(B, 700), seat(C, 600), { ...seat(A, 0), seat: 5 }];
    const ledger = createLedger({ unit: UNIT });
    ledger.observeTable(tbl({ seats }));
    expect(ask(ledger)).toMatchObject({ ok: false, reason: 'duplicate-address', permanent: true });
  });

  test('stacks holding more chips than the base had: chips cannot appear at a table', () => {
    const ledger = createLedger({ unit: UNIT });
    ledger.observeTable(tbl({ chips: [1001, 800, 600, 400] }));
    expect(ask(ledger)).toMatchObject({
      ok: false,
      reason: 'stacks-exceed-base',
      permanent: true,
    });
  });

  test('an unreadable chip count on a roster seat is permanent', () => {
    for (const chips of [-1, 1.5, '700', null, 2 ** 53]) {
      const ledger = createLedger({ unit: UNIT });
      ledger.observeTable(
        tbl({ seats: [seat(A, 1098), seat(B, chips), seat(C, 600), seat(D, 400)] }),
      );
      expect(ask(ledger)).toMatchObject({ ok: false, reason: 'bad-seat', permanent: true });
    }
  });
});

describe('not known yet: wait', () => {
  test('no table message yet', () => {
    expect(ask(createLedger({ unit: UNIT }))).toMatchObject({
      ok: false,
      reason: 'no-table',
      permanent: false,
    });
  });

  test('a hand in progress, a bet still out, or no explicit inHand: false', () => {
    const cases = [
      tbl({ chips: AFTER, inHand: true }),
      tbl({ seats: [seat(A, 1098, { bet: 2 }), seat(B, 700), seat(C, 600), seat(D, 400)] }),
      tbl({ chips: AFTER, over: { inHand: undefined } }),
      tbl({ chips: AFTER, over: { inHand: 'false' } }),
    ];
    for (const message of cases) {
      const ledger = createLedger({ unit: UNIT });
      expect(ledger.observeTable(message)).toEqual({ ok: true });
      expect(ask(ledger)).toMatchObject({ ok: false, reason: 'mid-hand', permanent: false });
      expect(ledger.observedFor({ base, roster })).toBeNull();
    }
  });

  test('an address no seat shows (not claimed yet, unreadable, or missing) until a table message shows it', () => {
    const ledger = createLedger({ unit: UNIT });
    for (const address of [undefined, null, 'not-an-address']) {
      ledger.observeTable(
        tbl({ seats: [seat(A, 1098), seat(B, 700), seat(C, 600), seat(D, 400, { address })] }),
      );
      expect(ask(ledger)).toMatchObject({ ok: false, reason: 'unknown-address', permanent: false });
    }
    ledger.observeTable(tbl({ chips: AFTER }));
    expect(ask(ledger).ok).toBe(true);
  });

  test('addresses are matched in any case', () => {
    const ledger = createLedger({ unit: UNIT });
    ledger.observeTable(
      tbl({
        seats: [
          seat(A, 1098, { address: A.toUpperCase().replace('0X', '0x') }),
          seat(B, 700),
          seat(C, 600),
          seat(D, 400),
        ],
      }),
    );
    expect(ask(ledger).observed.deltas).toEqual([98, -100, 0, 0]);
  });
});

describe('what the server sends never throws', () => {
  test('a malformed table message makes the ledger forget the last one (stale stacks are worse than none)', () => {
    const ledger = watched();
    for (const bad of [
      null,
      {},
      { state: null },
      { state: { seats: 'x' } },
      { state: { seats: [7] } },
    ]) {
      expect(ledger.observeTable(bad)).toEqual({ ok: false, reason: 'malformed' });
      expect(ask(ledger)).toMatchObject({ ok: false, reason: 'no-table' });
    }
  });

  test('a ledger for one game table ignores another table, and keeps what it knew', () => {
    const ledger = createLedger({ unit: UNIT, tableId: 'vault-1' });
    ledger.observeTable(tbl({ chips: AFTER }));
    expect(ledger.observeTable({ ...tbl({ chips: [0, 0, 0, 0] }), tableId: 'other' })).toEqual({
      ok: false,
      reason: 'other-table',
    });
    expect(ask(ledger).observed.deltas).toEqual([98, -100, 0, 0]);
  });

  test('malformed hand-end results are not stored', () => {
    const ledger = createLedger({ unit: UNIT });
    const bad = [
      null,
      { ...result7, handNo: -1 },
      { ...result7, pot: -1 },
      { ...result7, rake: 1.5 },
      { ...result7, stacks: 'x' },
      { ...result7, stacks: [1, -2] },
      { ...result7, busted: 'x' },
      { ...result7, busted: [0.5] },
    ];
    for (const result of bad) {
      expect(ledger.observeEvent(handEnd(result))).toEqual({ ok: false, reason: 'malformed' });
    }
    for (const event of [null, 'x', { type: 'street' }]) {
      expect(ledger.observeEvent(event)).toEqual({ ok: false, reason: 'malformed' });
    }
    // and inside a table message they are skipped
    ledger.observeTable(tbl({ chips: AFTER, events: [handEnd(bad[2]), null, 'x'] }));
    expect(ask(ledger).observed.pot).toBeNull();
  });

  test('only the newest 32 results are kept', () => {
    const ledger = createLedger({ unit: UNIT });
    for (let h = 1; h <= 40; h++) ledger.observeEvent(handEnd({ ...result7, handNo: h }), 2);
    // hand 7 was dropped long ago, so a different account of it is not a conflict any more
    expect(ledger.observeEvent(handEnd({ ...result7, pot: 1 }), 2)).toEqual({
      ok: true,
      stored: true,
    });
    expect(ledger.observeEvent(handEnd({ ...result7, handNo: 40, pot: 1 }), 2)).toMatchObject({
      conflict: true,
    });
  });

  test('a table message without vault facts keys its results under a null epoch', () => {
    const ledger = createLedger({ unit: UNIT });
    ledger.observeTable(
      tbl({ chips: AFTER, over: { vault: undefined }, events: [handEnd(result7)] }),
    );
    expect(ask(ledger).observed.pot).toBe(200);
  });
});

describe('caller bugs throw (they are not the server talking)', () => {
  test('a roster that is not a list of addresses, or a base for another roster', () => {
    const ledger = watched();
    expect(() => ledger.observedStatus({ base, roster: [] })).toThrow(TypeError);
    expect(() => ledger.observedStatus({ base })).toThrow(TypeError);
    expect(() => ledger.observedStatus()).toThrow(TypeError);
    expect(() => ledger.observedStatus({ base, roster: ['x', B, C, D] })).toThrow(RangeError);
    expect(() => ledger.observedStatus({ base, roster: [B, A, C, D] })).toThrow(TypeError);
    expect(() => ledger.observedStatus({ base, roster: [A, B, C] })).toThrow(TypeError);
    expect(() => ledger.observedStatus({ base: null, roster })).toThrow(TypeError);
    const wire = { ...base, balances: base.balances.map(String) };
    expect(() => ledger.observedStatus({ base: wire, roster })).toThrow(TypeError);
  });

  test('a roster in upper case is the same roster', () => {
    const upper = roster.map((p) => `0x${p.slice(2).toUpperCase()}`);
    expect(watched().observedStatus({ base, roster: upper, handNo: 7 }).ok).toBe(true);
  });
});

describe('numbers beyond a safe integer stay exact', () => {
  test('a base balance of 2^200 units: the deltas and rake come back as bigints, and refuse nothing silently', () => {
    const huge = { ...base, balances: [2n ** 200n, ...base.balances.slice(1)] };
    const ledger = createLedger({ unit: UNIT });
    ledger.observeTable(tbl({ chips: [1000, 800, 600, 400] }));
    const { observed } = ledger.observedStatus({ base: huge, roster });
    expect(typeof observed.deltas[0]).toBe('bigint');
    expect(observed.deltas[0]).toBe(1000n - 2n ** 200n / UNIT);
    expect(observed.rake).toBe(-observed.deltas[0]);
    expect(observed.deltas.slice(1)).toEqual([0, 0, 0]);
  });
});
