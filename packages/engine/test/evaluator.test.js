import { describe, expect, test } from 'bun:test';
import { CANONICAL_DECK } from '../src/fairness.js';
import { settlePots } from '../src/settle.js';
import { referenceWinners } from './reference-eval.js';

// Winners according to the runtime path: settlePots (pokersolver) on a single shared pot.
function runtimeWinners(entries, board) {
  const hole = new Map(entries);
  const contributions = [];
  for (const [seat] of entries) contributions[seat] = 10;
  for (let i = 0; i < contributions.length; i++) contributions[i] ??= 0;
  const { pots } = settlePots({ contributions, folded: new Set(), hole, board, button: 0 });
  return pots[0].winners.map((winner) => winner.seat).sort((a, b) => a - b);
}

const agree = (entries, board) => {
  const reference = referenceWinners(entries, board);
  expect(runtimeWinners(entries, board)).toEqual(reference);
  return reference;
};

describe('runtime evaluator agrees with the brute-force reference', () => {
  test('double trips: kings full of fours beats the board (fuzz hand that poker-ts got wrong)', () => {
    const board = ['4h', 'Kh', '4c', 'Kc', '4s'];
    const winners = agree(
      [
        [0, ['9s', 'Th']],
        [1, ['Ts', '2h']],
        [2, ['2c', 'Ks']],
        [3, ['5d', '6h']],
      ],
      board,
    );
    expect(winners).toEqual([2]);
  });

  test('hand-picked edge cases', () => {
    const cases = [
      // the wheel (ace low) beats a pair of kings; a 7-high straight beats the wheel
      [
        [
          [0, ['Ah', '2d']],
          [1, ['6c', '9d']],
        ],
        ['3s', '4h', '5c', 'Kd', 'Kc'],
        [0],
      ],
      [
        [
          [0, ['Ah', '2d']],
          [1, ['6c', '7d']],
        ],
        ['3s', '4h', '5c', 'Kd', 'Kc'],
        [1],
      ],
      // straight flush beats quads
      [
        [
          [0, ['9h', 'Th']],
          [1, ['Ks', 'Kd']],
        ],
        ['8h', '7h', '6h', 'Kc', 'Kh'],
        [0],
      ],
      // flush beats straight; higher flush wins
      [
        [
          [0, ['Ah', '2h']],
          [1, ['Kh', '3h']],
        ],
        ['5h', '9h', 'Jh', '6c', '7d'],
        [0],
      ],
      // two full houses: higher trips wins
      [
        [
          [0, ['Qs', 'Qd']],
          [1, ['Js', '9d']],
        ],
        ['Qh', 'Jh', 'Jc', '2c', '2d'],
        [0],
      ],
      // four of a kind beats a full house, even a higher one
      [
        [
          [0, ['Qs', 'Qd']],
          [1, ['Js', 'Jd']],
        ],
        ['Qh', 'Jh', 'Jc', '2c', '2d'],
        [1],
      ],
      // three pairs on seven cards: the best two pairs and the best kicker count
      [
        [
          [0, ['As', 'Ad']],
          [1, ['Ks', 'Kd']],
        ],
        ['Qh', 'Qc', '2s', '2d', '9c'],
        [0],
      ],
      // identical hands split
      [
        [
          [0, ['2c', '3c']],
          [1, ['2d', '3d']],
        ],
        ['Ts', 'Js', 'Qs', 'Ks', 'As'],
        [0, 1],
      ],
      // kicker decides a split of pairs
      [
        [
          [0, ['As', '9d']],
          [1, ['Ah', '8d']],
        ],
        ['Ac', '7s', '5h', '3d', '2c'],
        [0],
      ],
      // board plays for everyone
      [
        [
          [0, ['2c', '3d']],
          [1, ['2d', '3c']],
        ],
        ['Ah', 'Ad', 'Ac', 'Kh', 'Kd'],
        [0, 1],
      ],
    ];
    for (const [entries, board, expected] of cases) expect(agree(entries, board)).toEqual(expected);
  });

  test('5,000 random showdowns (2 to 6 players)', () => {
    let state = 424242;
    const rand = (n) => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state % n;
    };
    let splits = 0;
    for (let run = 0; run < 5000; run++) {
      const deck = [...CANONICAL_DECK];
      for (let i = deck.length - 1; i > 0; i--) {
        const j = rand(i + 1);
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
      const players = 2 + rand(5);
      const entries = Array.from({ length: players }, (_, seat) => [
        seat,
        [deck[seat * 2], deck[seat * 2 + 1]],
      ]);
      const board = deck.slice(players * 2, players * 2 + 5);
      if (agree(entries, board).length > 1) splits++;
    }
    expect(splits).toBeGreaterThan(0); // the sample exercised chops too
  }, 60_000);
});
