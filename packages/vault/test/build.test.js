import { describe, expect, test } from 'bun:test';
import { buildNextState, genesisState, sortRoster } from '../src/build.js';
import { statesEqual } from '../src/state.js';
import { makeRng, randomRoster, UINT64_MAX } from './gen.js';

const A = `0x${'00'.repeat(19)}01`;
const B = `0x${'00'.repeat(19)}02`;
const C = `0x${'00'.repeat(19)}03`;
const tableId = `0x${'11'.repeat(32)}`;

describe('genesisState', () => {
  test('balances are the deposits; nothing final, kept or traded', () => {
    const g = genesisState({ tableId, players: [A, B, C], deposits: [5n, 6n, 7n] });
    expect(g).toEqual({
      tableId,
      nonce: 0n,
      isFinal: false,
      players: [A, B, C],
      balances: [5n, 6n, 7n],
      keep: [false, false, false],
      rake: 0n,
      volume: 0n,
    });
  });

  test('carries the table nonce and rake paid, like depositState does', () => {
    const g = genesisState({ tableId, players: [A, B], deposits: [1, 2], nonce: 9n, rake: 4n });
    expect(g.nonce).toBe(9n);
    expect(g.rake).toBe(4n);
    expect(g.volume).toBe(0n);
    expect(g.balances).toEqual([1n, 2n]);
  });

  test('refuses an unsorted roster or deposits that do not line up', () => {
    expect(() => genesisState({ tableId, players: [B, A], deposits: [1n, 2n] })).toThrow(
      RangeError,
    );
    expect(() => genesisState({ tableId, players: [A, B], deposits: [1n] })).toThrow(RangeError);
    expect(() => genesisState({ tableId, players: [A, B], deposits: null })).toThrow(RangeError);
  });
});

describe('buildNextState', () => {
  const prev = genesisState({
    tableId,
    players: [A, B, C],
    deposits: [100n, 100n, 100n],
    nonce: 4n,
  });

  test('nonce + 1, same roster, balances as given, rake and volume cumulative', () => {
    const next = buildNextState({
      prev,
      balances: [150n, 48n, 100n],
      rakeDelta: 2n,
      volumeDelta: 100n,
    });
    expect(next).toEqual({
      tableId,
      nonce: 5n,
      isFinal: false,
      players: [A, B, C],
      balances: [150n, 48n, 100n],
      keep: [false, false, false],
      rake: 2n,
      volume: 100n,
    });
    const after = buildNextState({
      prev: next,
      balances: next.balances,
      rakeDelta: 3n,
      volumeDelta: 50n,
    });
    expect(after.nonce).toBe(6n);
    expect(after.rake).toBe(5n);
    expect(after.volume).toBe(150n);
  });

  test('does not mutate prev, and the result shares no arrays with it', () => {
    const copy = structuredClone(prev);
    const next = buildNextState({ prev, balances: prev.balances });
    expect(statesEqual(prev, copy)).toBe(true);
    expect(next.players).not.toBe(prev.players);
    expect(next.balances).not.toBe(prev.balances);
  });

  test('a final state carries keep; without keep, nobody stays', () => {
    const kept = buildNextState({
      prev,
      balances: [100n, 100n, 100n],
      final: true,
      keep: [true, false, true],
    });
    expect(kept.isFinal).toBe(true);
    expect(kept.keep).toEqual([true, false, true]);
    expect(buildNextState({ prev, balances: prev.balances, final: true }).keep).toEqual([
      false,
      false,
      false,
    ]);
  });

  test('a state that is not final always has keep all false', () => {
    const next = buildNextState({ prev, balances: prev.balances, keep: [true, true, true] });
    expect(next.isFinal).toBe(false);
    expect(next.keep).toEqual([false, false, false]);
  });

  test('refuses a negative rake or volume step even when the sum would still be a valid number', () => {
    const rich = { ...prev, rake: 10n, volume: 10n };
    expect(() => buildNextState({ prev: rich, balances: prev.balances, rakeDelta: -1n })).toThrow(
      /rakeDelta/,
    );
    expect(() => buildNextState({ prev: rich, balances: prev.balances, volumeDelta: -1n })).toThrow(
      /volumeDelta/,
    );
  });

  test('refuses what cannot be a state', () => {
    expect(() => buildNextState({ prev, balances: [1n, 2n] })).toThrow(RangeError);
    expect(() => buildNextState({ prev, balances: prev.balances, rakeDelta: -1n })).toThrow(
      RangeError,
    );
    expect(() => buildNextState({ prev, balances: prev.balances, volumeDelta: -1n })).toThrow(
      RangeError,
    );
    expect(() =>
      buildNextState({ prev, balances: prev.balances, final: true, keep: [true] }),
    ).toThrow(RangeError);
    expect(() => buildNextState({ prev, balances: prev.balances, rakeDelta: 1.5 })).toThrow(
      RangeError,
    );
    expect(() =>
      buildNextState({ prev: { ...prev, nonce: UINT64_MAX }, balances: prev.balances }),
    ).toThrow(/nonce/);
  });
});

describe('sortRoster', () => {
  test('sorts ascending and returns the permutation both ways', () => {
    const seats = [
      { address: C, name: 'c' },
      { address: A, name: 'a' },
      { address: B, name: 'b' },
    ];
    const { sorted, order, position } = sortRoster(seats);
    expect(sorted.map((s) => s.name)).toEqual(['a', 'b', 'c']);
    expect(sorted[0]).toBe(seats[1]); // same objects, not copies
    expect(order).toEqual([1, 2, 0]); // state index j holds input order[j]
    expect(position).toEqual([2, 0, 1]); // input i sits at state index position[i]
    for (let i = 0; i < seats.length; i++) expect(sorted[position[i]]).toBe(seats[i]);
    for (let j = 0; j < seats.length; j++) expect(seats[order[j]]).toBe(sorted[j]);
  });

  test('orders mixed-case addresses by value', () => {
    const high = `0xF${'0'.repeat(39)}`;
    const low = `0xa${'0'.repeat(39)}`;
    expect(sortRoster([{ address: high }, { address: low }]).order).toEqual([1, 0]);
  });

  test('works for random rosters of 2 to 10 and keeps seats mapped to balances', () => {
    const rng = makeRng(4);
    for (let n = 2; n <= 10; n++) {
      const sortedAddresses = randomRoster(rng, n);
      const shuffled = [...sortedAddresses].sort(() => (rng.bool() ? 1 : -1));
      const seats = shuffled.map((address, i) => ({ address, chips: BigInt(i) }));
      const { sorted, position } = sortRoster(seats);
      expect(sorted.map((s) => s.address)).toEqual(sortedAddresses);
      const balances = new Array(n);
      for (const [i, seat] of seats.entries()) balances[position[i]] = seat.chips;
      expect(balances).toEqual(sorted.map((s) => s.chips));
    }
  });

  test('refuses duplicates, bad addresses and non-arrays', () => {
    expect(() =>
      sortRoster([{ address: A }, { address: A.toUpperCase().replace('0X', '0x') }]),
    ).toThrow(/duplicate/);
    expect(() => sortRoster([{ address: '0x12' }])).toThrow(RangeError);
    expect(() => sortRoster([{}])).toThrow(RangeError);
    expect(() => sortRoster(null)).toThrow(RangeError);
    expect(sortRoster([])).toEqual({ sorted: [], order: [], position: [] });
  });
});
