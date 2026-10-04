import { describe, expect, test } from 'bun:test';
import { buildPots, settlePots } from '../src/settle.js';

const none = new Set();

describe('buildPots', () => {
  test('equal contributions make one pot', () => {
    expect(buildPots([100, 100, 100], none)).toEqual([{ size: 300, eligible: [0, 1, 2] }]);
  });

  test('all-in levels make a main pot and side pots; the top stack gets its excess back', () => {
    expect(buildPots([100, 300, 500], none)).toEqual([
      { size: 300, eligible: [0, 1, 2] },
      { size: 400, eligible: [1, 2] },
      { size: 200, eligible: [2] },
    ]);
  });

  test("a folded player's dead money is capped by what the all-in player can win", () => {
    // Seat 0 is all-in for 4. Seat 2 posted 10 and folded. Seat 0 may win 4 from each opponent,
    // so the main pot is 4 x 4 = 16 and the other 18 belong to seats 1 and 3 only.
    // (poker-ts 1.5.0 builds 22 + 12 here, letting seat 0 win 6 chips it has no claim to.)
    expect(buildPots([4, 10, 10, 10], new Set([2]))).toEqual([
      { size: 16, eligible: [0, 1, 3] },
      { size: 18, eligible: [1, 3] },
    ]);
  });

  test('a folded player who put in more than anyone live adds to the top pot', () => {
    expect(buildPots([10, 30, 10], new Set([1]))).toEqual([{ size: 50, eligible: [0, 2] }]);
  });

  test('chips are conserved across pots', () => {
    let state = 99;
    const rand = (n) => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state % n;
    };
    for (let run = 0; run < 2000; run++) {
      const contributions = Array.from({ length: 2 + rand(7) }, () =>
        rand(5) === 0 ? 0 : 1 + rand(500),
      );
      const folded = new Set(
        contributions.flatMap((c, seat) => (c > 0 && rand(3) === 0 ? [seat] : [])),
      );
      if (contributions.every((c, seat) => c === 0 || folded.has(seat))) continue; // nobody live
      const pots = buildPots(contributions, folded);
      expect(pots.reduce((s, p) => s + p.size, 0)).toBe(contributions.reduce((a, b) => a + b, 0));
      for (const pot of pots) {
        expect(pot.eligible.length).toBeGreaterThan(0);
        expect(pot.eligible.every((seat) => !folded.has(seat))).toBe(true);
      }
    }
  });

  test('refuses when nobody is left to award a pot to', () => {
    expect(() => buildPots([10, 10], new Set([0, 1]))).toThrow();
  });
});

describe('settlePots', () => {
  const board = ['2c', '7d', '9h', 'Jc', '3s'];

  test('best hand wins each pot it is eligible for', () => {
    const hole = new Map([
      [0, ['As', 'Ah']],
      [1, ['Ks', 'Kh']],
      [2, ['Qs', 'Qh']],
    ]);
    const { pots, payouts } = settlePots({
      contributions: [100, 300, 300],
      folded: none,
      hole,
      board,
      button: 0,
    });
    expect(payouts).toEqual([300, 400, 0]); // seat 0 takes the main pot, seat 1 the side pot
    expect(pots.map((p) => p.winners.map((w) => w.seat))).toEqual([[0], [1]]);
    expect(pots[0].winners[0].ranking).toBe('Pair');
  });

  test('a short-stack all-in winner is paid (the poker-ts 1.5.0 failure)', () => {
    const hole = new Map([
      [0, ['3s', '5c']], // trips with the board's pair of fives
      [1, ['6d', '4c']],
      [3, ['Qc', '3d']],
    ]);
    const { payouts } = settlePots({
      contributions: [4, 10, 10, 10],
      folded: new Set([2]),
      hole,
      board: ['8c', '2c', '4d', '5s', '5d'],
      button: 0,
    });
    expect(payouts).toEqual([16, 18, 0, 0]);
  });

  test('a split pot gives the odd chip to the first winner clockwise after the button', () => {
    // Royal flush on the board: seats 1 and 3 tie. Pot = 2 + 2 + 1 (seat 0 folded) = 5.
    const royal = ['Ts', 'Js', 'Qs', 'Ks', 'As'];
    const hole = new Map([
      [1, ['2c', '3c']],
      [3, ['2d', '3d']],
    ]);
    const settle = (button) =>
      settlePots({ contributions: [1, 2, 0, 2], folded: new Set([0]), hole, board: royal, button })
        .payouts;
    expect(settle(0)).toEqual([0, 3, 0, 2]); // seat 1 is first after the button
    expect(settle(1)).toEqual([0, 2, 0, 3]); // seat 3 is first after the button
    expect(settle(3)).toEqual([0, 3, 0, 2]); // wraps around: seat 0 folded, so seat 1
  });

  test('an uncontested pot needs no cards and no full board', () => {
    const { payouts, pots } = settlePots({
      contributions: [10, 20],
      folded: new Set([0]),
      hole: new Map(),
      board: [],
      button: 0,
    });
    expect(payouts).toEqual([0, 30]);
    expect(pots[0].winners).toEqual([{ seat: 1 }]);
  });

  test('refuses to guess: a contested pot with a short board or missing cards throws', () => {
    const hole = new Map([[0, ['As', 'Ah']]]);
    expect(() =>
      settlePots({ contributions: [10, 10], folded: none, hole, board: ['2c'], button: 0 }),
    ).toThrow(/full board/);
    expect(() =>
      settlePots({ contributions: [10, 10], folded: none, hole, board, button: 0 }),
    ).toThrow(/missing hole cards/);
  });

  test('payouts always add up to the pot', () => {
    const cards = ['As', 'Ks', 'Qh', 'Jd', 'Tc', '9s', '8h', '7d', '6c', '5s', '4h', '3d', '2c'];
    let state = 7;
    const rand = (n) => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state % n;
    };
    for (let run = 0; run < 500; run++) {
      const n = 2 + rand(5);
      const contributions = Array.from({ length: n }, () => 1 + rand(200));
      const folded = new Set(
        contributions.flatMap((_, seat) => (seat > 0 && rand(3) === 0 ? [seat] : [])),
      );
      const deck = [...cards].sort(() => rand(3) - 1);
      const hole = new Map();
      contributions.forEach((_, seat) => {
        if (!folded.has(seat)) hole.set(seat, [deck[(seat * 2) % 8], deck[(seat * 2 + 1) % 8]]);
      });
      // Duplicated cards are fine for this property (only the totals matter), but pokersolver
      // needs 7 cards, so use a fixed distinct board.
      const { payouts } = settlePots({
        contributions,
        folded,
        hole,
        board: ['2h', '9c', 'Jh', '4s', 'Kd'],
        button: rand(n),
      });
      expect(payouts.reduce((a, b) => a + b, 0)).toBe(contributions.reduce((a, b) => a + b, 0));
    }
  });
});
