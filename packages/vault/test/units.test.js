import { describe, expect, test } from 'bun:test';
import { toChips, toTokenUnits } from '../src/units.js';

const CENT = 10_000n; // 6-decimal token, one chip = 0.01

describe('toTokenUnits', () => {
  test('multiplies by the unit', () => {
    expect(toTokenUnits(0, CENT)).toBe(0n);
    expect(toTokenUnits(1, CENT)).toBe(10_000n);
    expect(toTokenUnits(2500, CENT)).toBe(25_000_000n);
  });

  test('is exact for an 18-decimal token far beyond 2^53', () => {
    const unit = 10n ** 16n; // 0.01 of an 18-decimal token
    expect(toTokenUnits(123_456, unit)).toBe(123_456n * 10n ** 16n);
    expect(toTokenUnits(Number.MAX_SAFE_INTEGER, unit)).toBe(
      BigInt(Number.MAX_SAFE_INTEGER) * unit,
    );
  });

  test('rejects chips that are not non-negative safe integers', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '5', 5n, null]) {
      expect(() => toTokenUnits(bad, CENT)).toThrow(RangeError);
    }
  });

  test('rejects a unit that is not a positive bigint', () => {
    for (const bad of [0n, -1n, 1, '10000', undefined]) {
      expect(() => toTokenUnits(1, bad)).toThrow(RangeError);
    }
  });
});

describe('toChips', () => {
  test('splits into whole chips and dust', () => {
    expect(toChips(25_000_000n, CENT)).toEqual({ chips: 2500, dust: 0n });
    expect(toChips(25_000_007n, CENT)).toEqual({ chips: 2500, dust: 7n });
    expect(toChips(9_999n, CENT)).toEqual({ chips: 0, dust: 9_999n });
    expect(toChips(0n, CENT)).toEqual({ chips: 0, dust: 0n });
  });

  test('round-trips: chips * unit + dust is the original amount', () => {
    for (const tokenUnits of [0n, 1n, 9_999n, 10_000n, 123_456_789n, 10n ** 18n + 5n]) {
      const unit = 10_000n;
      const { chips, dust } = toChips(tokenUnits, unit);
      expect(toTokenUnits(chips, unit) + dust).toBe(tokenUnits);
    }
  });

  test('handles an 18-decimal deposit with dust', () => {
    const unit = 10n ** 16n;
    const deposit = 1_000n * 10n ** 18n + 12_345n; // 1000 tokens and a few wei
    expect(toChips(deposit, unit)).toEqual({ chips: 100_000, dust: 12_345n });
  });

  test('accepts exactly the largest safe chip count and refuses one more', () => {
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    expect(toChips(max, 1n)).toEqual({ chips: Number.MAX_SAFE_INTEGER, dust: 0n });
    expect(() => toChips(max + 1n, 1n)).toThrow(RangeError);
    expect(() => toChips(2n ** 256n - 1n, 1n)).toThrow(RangeError);
    // the same big amount is fine once the unit is large enough
    expect(toChips(2n ** 100n, 10n ** 18n).chips).toBe(Number(2n ** 100n / 10n ** 18n));
  });

  test('rejects bad arguments', () => {
    expect(() => toChips(-1n, CENT)).toThrow(RangeError);
    expect(() => toChips(5, CENT)).toThrow(RangeError);
    expect(() => toChips(5n, 0n)).toThrow(RangeError);
    expect(() => toChips(5n, 10_000)).toThrow(RangeError);
  });
});
