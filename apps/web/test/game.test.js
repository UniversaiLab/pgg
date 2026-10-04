import { describe, expect, test } from 'bun:test';
import {
  addToast,
  applyServerMessage,
  dismissToast,
  heroEntry,
  initialState,
  isHeroTurn,
  markProof,
} from '../src/lib/game.js';

const table = (over = {}) => ({
  tableId: 't1',
  name: 'T',
  handNo: 3,
  inHand: true,
  button: 0,
  toAct: 1,
  round: 'flop',
  board: ['2c', '7d', 'Kh'],
  pot: 60,
  seats: [
    { seat: 0, playerId: 'a', name: 'Ann', chips: 400 },
    { seat: 1, playerId: 'me', name: 'Me', chips: 300 },
    null,
  ],
  legal: { actions: ['fold', 'call'], toCall: 20 },
  deadline: 1000,
  fairness: { current: { handNo: 3, commitment: 'c' }, next: { handNo: 4, commitment: 'n' } },
  ...over,
});
const welcome = (seated = null) => ({
  t: 'welcome',
  v: 1,
  player: { id: 'me', name: 'Me', balance: 9000 },
  tables: [{ id: 't1' }],
  seated,
});
const tbl = (seq, over, events = []) => ({
  t: 'tbl',
  tableId: 't1',
  seq,
  state: table(over),
  events,
});
const apply = (state, ...messages) => messages.reduce(applyServerMessage, state);

describe('applyServerMessage', () => {
  test('welcome goes to the lobby, or straight to the table when already seated', () => {
    const lobby = apply(initialState, welcome());
    expect(lobby).toMatchObject({ phase: 'lobby', me: { id: 'me' }, balance: 9000, tableId: null });
    const seated = apply(initialState, welcome({ tableId: 't1', seat: 1 }));
    expect(seated).toMatchObject({ phase: 'table', tableId: 't1', seat: 1 });
  });

  test('seating and unseating move between lobby and table and clear table state', () => {
    let s = apply(initialState, welcome(), { t: 'seated', tableId: 't1', seat: 1 }, tbl(1));
    expect(s).toMatchObject({ phase: 'table', seat: 1, seq: 1 });
    expect(heroEntry(s)).toMatchObject({ name: 'Me' });
    s = apply(s, { t: 'unseated', tableId: 't1', reason: 'left', chips: 300 });
    expect(s).toMatchObject({ phase: 'lobby', tableId: null, seat: null, table: null, seq: 0 });
    expect(s.toasts).toEqual([]);
    s = apply(
      s,
      { t: 'seated', tableId: 't1', seat: 1 },
      { t: 'unseated', tableId: 't1', reason: 'busted', chips: 0 },
    );
    expect(s.toasts[0].text).toMatch(/out of chips/);
  });

  test('table messages carry state, a sequence number and stamped events', () => {
    let s = apply(initialState, welcome({ tableId: 't1', seat: 1 }));
    s = apply(
      s,
      tbl(5, {}, [
        { type: 'action', seat: 0, action: 'call' },
        { type: 'street', round: 'flop' },
      ]),
    );
    expect(s.seq).toBe(5);
    expect(s.table.pot).toBe(60);
    expect(s.events.map((e) => e.type)).toEqual(['action', 'street']);
    expect(new Set(s.events.map((e) => e.id)).size).toBe(2); // unique ids drive animations
    s = apply(s, tbl(6, {}, [{ type: 'action', seat: 1, action: 'fold' }]));
    expect(s.events.map((e) => e.id)).toEqual([...new Set(s.events.map((e) => e.id))]);
  });

  test('ignores messages for a table we are not at', () => {
    const s = apply(initialState, welcome({ tableId: 't1', seat: 1 }));
    expect(applyServerMessage(s, { ...tbl(1), tableId: 'other' })).toBe(s);
  });

  test('hole cards belong to a hand; a new hand clears the old ones', () => {
    let s = apply(initialState, welcome({ tableId: 't1', seat: 1 }), tbl(1));
    s = apply(s, { t: 'cards', tableId: 't1', handNo: 3, seat: 1, cards: ['Ah', 'Kd'] });
    expect(s.hole).toEqual({ handNo: 3, cards: ['Ah', 'Kd'] });
    s = apply(s, tbl(2, { handNo: 3 })); // same hand: keep
    expect(s.hole).not.toBeNull();
    s = apply(s, tbl(3, { handNo: 4 }, [{ type: 'hand-start', handNo: 4 }]));
    expect(s.hole).toBeNull();
  });

  test('your cards arrive BEFORE the hand-start update and must survive it', () => {
    // This is the real order the server uses: private cards first, then the public state.
    let s = apply(initialState, welcome({ tableId: 't1', seat: 1 }));
    s = apply(
      s,
      { t: 'cards', tableId: 't1', handNo: 4, seat: 1, cards: ['Ah', 'Kd'] },
      tbl(7, { handNo: 4 }, [{ type: 'hand-start', handNo: 4 }]),
    );
    expect(s.hole).toEqual({ handNo: 4, cards: ['Ah', 'Kd'] });
    // And when the next hand starts without cards for us (we are not dealt in), they are dropped.
    s = apply(s, tbl(8, { handNo: 5 }, [{ type: 'hand-start', handNo: 5 }]));
    expect(s.hole).toBeNull();
  });

  test('hand-end stores the result; the next hand-start clears it', () => {
    let s = apply(initialState, welcome({ tableId: 't1', seat: 1 }));
    const result = { handNo: 3, pot: 60, pots: [] };
    s = apply(s, tbl(1, { inHand: false }, [{ type: 'hand-end', result }]));
    expect(s.result).toEqual(result);
    s = apply(s, tbl(2, {}, [{ type: 'hand-start', handNo: 4 }]));
    expect(s.result).toBeNull();
  });

  test('proofs are kept newest first and can be marked verified', () => {
    let s = apply(
      initialState,
      { t: 'proof', tableId: 't1', handNo: 1, proof: { a: 1 } },
      { t: 'proof', tableId: 't1', handNo: 2, proof: { a: 2 } },
    );
    expect(s.proofs.map((p) => p.handNo)).toEqual([2, 1]);
    s = markProof(s, 1, true);
    expect(s.proofs.find((p) => p.handNo === 1).ok).toBe(true);
    expect(s.proofs.find((p) => p.handNo === 2).ok).toBeUndefined();
  });

  test('errors become toasts with friendly text; unknown codes still say something', () => {
    let s = apply(
      initialState,
      { t: 'err', code: 'not-your-turn' },
      { t: 'err', code: 'who-knows' },
    );
    expect(s.toasts.map((t) => t.text)).toEqual(['It is not your turn', 'Something went wrong']);
    s = dismissToast(s, s.toasts[0].id);
    expect(s.toasts).toHaveLength(1);
    expect(addToast(s, 'hi').toasts.at(-1)).toMatchObject({ text: 'hi', tone: 'info' });
  });

  test('keeps only the most recent events and toasts', () => {
    let s = apply(initialState, welcome({ tableId: 't1', seat: 1 }));
    for (let i = 1; i <= 30; i++)
      s = apply(s, tbl(i, {}, [{ type: 'action' }, { type: 'action' }, { type: 'action' }]));
    expect(s.events.length).toBe(40);
    for (let i = 0; i < 6; i++) s = addToast(s, `t${i}`);
    expect(s.toasts).toHaveLength(3);
  });

  test('is a pure function: it never mutates its input', () => {
    const before = apply(initialState, welcome({ tableId: 't1', seat: 1 }), tbl(1));
    const snapshot = JSON.stringify(before);
    apply(
      before,
      tbl(2),
      { t: 'cards', tableId: 't1', handNo: 3, seat: 1, cards: ['Ah', 'Kd'] },
      { t: 'err', code: 'x' },
    );
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  test('isHeroTurn follows toAct', () => {
    const s = apply(initialState, welcome({ tableId: 't1', seat: 1 }), tbl(1));
    expect(isHeroTurn(s)).toBe(true);
    expect(isHeroTurn(apply(s, tbl(2, { toAct: 0 })))).toBe(false);
    expect(isHeroTurn(apply(s, tbl(2, { toAct: null })))).toBe(false);
  });
});
