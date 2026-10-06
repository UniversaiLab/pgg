// Rotation policy: when an epoch ends and who stays. keep = chips > 0 && !leaving && !kicked, so dust alone
// never keeps a seat (F9); forced reasons rotate at once, voluntary ones wait for minEpochHands; the epoch
// ends before the oldest session key reaches its policy age (F14).
import { describe, expect, test } from 'bun:test';
import {
  epochRemainingMs,
  FORCED_REASONS,
  keyExpiring,
  ROTATION_REASONS,
  rotationDecision,
} from '../../src/vault/policy.js';
import { POLICY_DEFAULTS } from '../../src/vault/vault-config.js';

const HOUR = 60 * 60 * 1000;
const config = { ...POLICY_DEFAULTS }; // min 3 hands, max 500, 12 h epochs and keys, 10 min margin, idle 3
const A = `0x${'0a'.repeat(20)}`;
const B = `0x${'0b'.repeat(20)}`;
const C = `0x${'0c'.repeat(20)}`;
const entries = (chips = [100, 100, 100], over = []) =>
  [A, B, C].map((address, i) => ({ address, chips: chips[i], ...(over[i] ?? {}) }));
const decide = (args) =>
  rotationDecision({ entries: entries(), handsInEpoch: 10, config, ...args });

describe('rotationDecision: reasons', () => {
  test('a quiet table with nothing due does not rotate', () => {
    expect(decide({})).toEqual({
      rotate: false,
      reason: null,
      keep: [true, true, true],
      kicked: [],
      leaving: [],
    });
  });

  // [name, args, reason]
  const cases = [
    [
      'a bust (0 chips) is forced, even on the first hand',
      { entries: entries([200, 0, 100]), handsInEpoch: 1 },
      'bust',
    ],
    ['the hand cap is maintenance', { handsInEpoch: 500 }, 'maintenance'],
    ['one hand below the cap is not', { handsInEpoch: 499 }, null],
    ['the epoch age cap is maintenance', { epochAgeMs: 12 * HOUR }, 'maintenance'],
    ['just below the age cap is not', { epochAgeMs: 12 * HOUR - 1 }, null],
    [
      'a key at policy age minus the margin is maintenance (F14)',
      { keyAges: { [B]: 12 * HOUR - 10 * 60_000 } },
      'maintenance',
    ],
    ['a key one ms younger is not', { keyAges: new Map([[B, 12 * HOUR - 10 * 60_000 - 1]]) }, null],
    ['a leave request after the minimum hands', { leaveRequests: [B] }, 'leave'],
    [
      'a leave flag on an entry',
      { entries: entries(undefined, [{}, {}, { leaving: true }]) },
      'leave',
    ],
    [
      'a leave request before the minimum hands waits',
      { leaveRequests: [B], handsInEpoch: 2 },
      null,
    ],
    ['exactly the minimum hands is enough', { leaveRequests: [B], handsInEpoch: 3 }, 'leave'],
    ['drain after the minimum hands', { drain: true }, 'drain'],
    ['drain before the minimum hands waits', { drain: true, handsInEpoch: 0 }, null],
    ['idle for idleKickHands hands', { entries: entries(undefined, [{ idleHands: 3 }]) }, 'idle'],
    ['idle for one hand fewer is not', { entries: entries(undefined, [{ idleHands: 2 }]) }, null],
    [
      'a forced reason beats a voluntary one',
      { entries: entries([0, 10, 10]), drain: true },
      'bust',
    ],
    [
      'maintenance is named before bust',
      { entries: entries([0, 10, 10]), handsInEpoch: 500 },
      'maintenance',
    ],
    [
      'drain is named before leave, leave before idle',
      { drain: true, leaveRequests: [A], entries: entries(undefined, [{ idleHands: 9 }]) },
      'drain',
    ],
    [
      'leave is named before idle',
      { leaveRequests: [A], entries: entries(undefined, [{}, { idleHands: 9 }]) },
      'leave',
    ],
  ];
  for (const [name, args, reason] of cases) {
    test(name, () => {
      const d = decide(args);
      expect(d.reason).toBe(reason);
      expect(d.rotate).toBe(reason !== null);
    });
  }

  test('the reason lists: forced ones are a subset, in the order they are named', () => {
    expect(ROTATION_REASONS).toEqual(['maintenance', 'bust', 'drain', 'leave', 'idle']);
    expect(FORCED_REASONS).toEqual(['maintenance', 'bust']);
  });

  test('idleKickHands 0 turns the idle kick off', () => {
    const d = rotationDecision({
      entries: entries(undefined, [{ idleHands: 1000 }]),
      handsInEpoch: 10,
      config: { ...config, idleKickHands: 0 },
    });
    expect(d).toMatchObject({ rotate: false, kicked: [] });
  });
});

describe('rotationDecision: keep', () => {
  test('dust never keeps a seat: chips 0 is paid out whatever the balance', () => {
    const d = decide({ entries: entries([250, 0, 1]) });
    expect(d.keep).toEqual([true, false, true]);
  });

  test('whoever is leaving or kicked is out of ANY rotation, whatever its reason', () => {
    const d = decide({
      entries: entries([100, 0, 100], [{ idleHands: 5 }]),
      leaveRequests: new Set([C.toUpperCase().replace('0X', '0x')]),
      handsInEpoch: 1, // voluntary reasons are not due yet, but the bust rotates and takes them along
    });
    expect(d).toMatchObject({ rotate: true, reason: 'bust', keep: [false, false, false] });
    expect(d.kicked).toEqual([A]);
    expect(d.leaving).toEqual([C]);
  });

  test('drain kicks everyone; an expiring key is kicked (it could not be co-signed next epoch)', () => {
    expect(decide({ drain: true }).keep).toEqual([false, false, false]);
    expect(decide({ drain: true }).kicked).toEqual([A, B, C]);
    const d = decide({ keyAges: { [A]: 12 * HOUR } });
    expect(d).toMatchObject({
      rotate: true,
      reason: 'maintenance',
      keep: [false, true, true],
      kicked: [A],
    });
  });

  test('addresses are compared in lowercase, in state order', () => {
    const upper = [A, B, C].map((address) => ({
      address: address.toUpperCase().replace('0X', '0x'),
      chips: 5,
    }));
    const d = rotationDecision({ entries: upper, handsInEpoch: 3, leaveRequests: [B], config });
    expect(d.keep).toEqual([true, false, true]);
    expect(d.leaving).toEqual([B]);
  });
});

describe('epoch timing', () => {
  test('remaining time is the nearer of the epoch cap and the oldest key, minus the margin', () => {
    expect(epochRemainingMs({ epochAgeMs: HOUR, config })).toBe(11 * HOUR);
    const keyAges = { [A]: 2 * HOUR, [B]: 11 * HOUR };
    expect(epochRemainingMs({ epochAgeMs: HOUR, keyAges, addresses: [A, B], config })).toBe(
      HOUR - 10 * 60_000,
    );
    // a key the coordinator could not age is no bound; nothing known at all is no bound
    expect(epochRemainingMs({ keyAges: {}, addresses: [A], config })).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(epochRemainingMs({ epochAgeMs: -1, config })).toBe(Number.POSITIVE_INFINITY);
  });

  test('keyExpiring at exactly policy age minus margin; unknown ages never expire', () => {
    expect(keyExpiring(12 * HOUR - 10 * 60_000, config)).toBe(true);
    expect(keyExpiring(12 * HOUR - 10 * 60_000 - 1, config)).toBe(false);
    for (const age of [undefined, null, Number.NaN, -5, '99999999999'])
      expect(keyExpiring(age, config)).toBe(false);
  });
});

describe('caller bugs throw TypeError', () => {
  test('bad config, entries, hands, drain, ages or requests', () => {
    const bad = [
      { config: null },
      { config: { ...config, minEpochHands: -1 } },
      { config: { ...config, maxEpochMs: Number.NaN } },
      { entries: [] },
      { entries: [null] },
      { entries: [{ address: A, chips: 1.5 }] },
      { entries: [{ address: A, chips: 1, idleHands: -1 }] },
      { handsInEpoch: -1 },
      { drain: 'yes' },
      { keyAges: 'old' },
      { leaveRequests: A },
    ];
    for (const args of bad) expect(() => decide(args)).toThrow(TypeError);
  });
});
