import { describe, expect, test } from 'bun:test';
import { allocateRake, computeRake, MAX_RAKE_BPS } from '../src/rake.js';

describe('computeRake', () => {
  test('basis points, rounded down', () => {
    expect(computeRake({ pot: 1000, sawFlop: true, bps: 200 })).toBe(20);
    expect(computeRake({ pot: 999, sawFlop: true, bps: 200 })).toBe(19);
    expect(computeRake({ pot: 49, sawFlop: true, bps: 200 })).toBe(0);
  });

  test('no flop, no drop (default), and it can be turned off', () => {
    expect(computeRake({ pot: 1000, sawFlop: false, bps: 200 })).toBe(0);
    expect(computeRake({ pot: 1000, sawFlop: false, bps: 200, noFlopNoDrop: false })).toBe(20);
  });

  test('cap applies', () => {
    expect(computeRake({ pot: 1_000_000, sawFlop: true, bps: 200, cap: 500 })).toBe(500);
  });

  test('exact on pots beyond 2^53 / bps (BigInt path)', () => {
    const pot = 9_000_000_000_000_000; // < MAX_SAFE_INTEGER, pot * 500 overflows a double
    expect(computeRake({ pot, sawFlop: true, bps: 500 })).toBe(450_000_000_000_000);
  });

  test('validates input', () => {
    expect(() => computeRake({ pot: -1, sawFlop: true, bps: 200 })).toThrow();
    expect(() => computeRake({ pot: 1.5, sawFlop: true, bps: 200 })).toThrow();
    expect(() => computeRake({ pot: 10, sawFlop: true, bps: MAX_RAKE_BPS + 1 })).toThrow();
    expect(() => computeRake({ pot: 10, sawFlop: true, bps: -1 })).toThrow();
  });
});

describe('allocateRake', () => {
  test('splits proportionally with largest remainder', () => {
    expect(allocateRake([100, 0, 100], 3)).toEqual([2, 0, 1]); // tie goes to lowest index
    expect(allocateRake([300, 100], 4)).toEqual([3, 1]);
    expect(allocateRake([0, 50, 0], 5)).toEqual([0, 5, 0]);
  });

  test('zero rake or zero payouts yields zeros', () => {
    expect(allocateRake([10, 20], 0)).toEqual([0, 0]);
    expect(allocateRake([0, 0], 0)).toEqual([0, 0]);
  });

  test('rejects rake larger than the payouts', () => {
    expect(() => allocateRake([1, 1], 3)).toThrow();
  });

  test('property: shares sum to the rake and never exceed a payout', () => {
    // Deterministic LCG so a failure is reproducible.
    let state = 12345;
    const rand = (n) => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state % n;
    };
    for (let run = 0; run < 2000; run++) {
      const payouts = Array.from({ length: 1 + rand(6) }, () => (rand(3) === 0 ? 0 : rand(10_000)));
      const total = payouts.reduce((a, b) => a + b, 0);
      if (total === 0) continue;
      const rake = rand(total + 1);
      const shares = allocateRake(payouts, rake);
      expect(shares.reduce((a, b) => a + b, 0)).toBe(rake);
      shares.forEach((share, i) => {
        expect(share).toBeLessThanOrEqual(payouts[i]);
        if (payouts[i] === 0) expect(share).toBe(0);
      });
    }
  });
});
