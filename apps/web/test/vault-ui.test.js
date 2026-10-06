// What the table screen says at a vault table: pure functions of the public table state and of this device's
// signer, so every sentence is tested without a DOM.
import { describe, expect, test } from 'bun:test';
import { bannerFor, clock, signedLabel, vaultAlarm, waitingText } from '../src/lib/vault-ui.js';

const seat = (n, name) => ({ seat: n, name, chips: 100, address: `0x${String(n).repeat(40)}` });
const table = (vault, over = {}) => ({
  inHand: false,
  seats: [seat(0, 'Ann'), seat(1, 'Bo'), seat(2, 'Cy'), null],
  vault: { epoch: 1, phase: 'active', nonce: '4', awaiting: [], deadline: null, ...vault },
  ...over,
});
const device = (over = {}) => ({
  hasKey: true,
  failure: null,
  keyLost: false,
  noChainView: false,
  refused: null,
  epochProblem: null,
  waiting: null,
  unpinned: false,
  bundleNonce: '4',
  ...over,
});

describe('waitingText', () => {
  test('a round open: who has signed, and the time left; past the deadline, the one missing by name', () => {
    expect(waitingText(table({ awaiting: [2], deadline: 31_000 }), 1_000)).toBe(
      'Waiting for signatures (2/3) · 0:30',
    );
    expect(waitingText(table({ awaiting: [1, 2], deadline: 10_000 }), 1_000)).toBe(
      'Waiting for signatures (1/3) · 0:09',
    );
    expect(waitingText(table({ awaiting: [2], deadline: 1_000 }), 5_000)).toBe(
      'Waiting for Cy to sign',
    );
    expect(waitingText(table({ awaiting: [1, 2], deadline: 1_000 }), 5_000)).toBe(
      'Waiting for signatures (1/3)',
    );
  });

  test('no round: an absent member by name, several by count; nothing to wait for is null', () => {
    expect(waitingText(table({ awaiting: [1] }))).toBe('Waiting for Bo to reconnect');
    expect(waitingText(table({ awaiting: [0, 2] }))).toBe('Waiting for 2 players to reconnect');
    expect(waitingText(table({}))).toBeNull();
  });

  test('the epoch phases between rounds; a hand in play or a play-money table says nothing', () => {
    expect(waitingText(table({ phase: 'settling' }))).toBe('Settling on chain…');
    expect(waitingText(table({ phase: 'exiting' }))).toBe('The table is closing on chain');
    expect(waitingText(table({ phase: 'filling' }))).toBe('Waiting for the table to start');
    expect(waitingText(table({ awaiting: [1] }, { inHand: true }))).toBeNull();
    expect(waitingText({ inHand: false, seats: [] })).toBeNull();
  });
});

describe('bannerFor', () => {
  test("this device's trouble comes first, in plain words, and it is red", () => {
    const cases = [
      [device({ keyLost: true }), 'This device has no key for this table'],
      [device({ hasKey: false }), 'This device has no key for this table'],
      [
        device({ failure: { kind: 'equivocation', blocking: true } }),
        'Signing stopped at this table',
      ],
      [device({ noChainView: true }), 'Signing is off in this app'],
      [device({ refused: { rule: 'C1b' } }), 'A result was not signed'],
      [device({ epochProblem: { rule: 'FINAL-LATCHED' } }), 'The table could not be checked'],
      [device({ waiting: 'storage' }), "This device's storage is unavailable"],
    ];
    for (const [vault, title] of cases) {
      const banner = bannerFor(table({ phase: 'stalled' }), vault);
      expect(banner).toMatchObject({ tone: 'red', title });
    }
    expect(bannerFor(table({}), device({ refused: { rule: 'C1b' } })).body).toContain(
      'do not match what happened at the table',
    );
    expect(
      bannerFor(table({}), device({ failure: { kind: 'equivocation', blocking: true } })).body,
    ).toContain('two different results');
  });

  test('then what the table is doing; a healthy active table shows nothing', () => {
    expect(bannerFor(table({ phase: 'stalled' }), device())).toMatchObject({
      title: 'Waiting for a player',
    });
    expect(bannerFor(table({ phase: 'exiting' }), device())).toMatchObject({
      title: 'The table is closing on chain',
    });
    expect(bannerFor(table({ phase: 'halted' }), null)).toMatchObject({ tone: 'muted' });
    expect(bannerFor(table({}), device())).toBeNull();
    expect(bannerFor(table({}), device({ waiting: 'other-tab' }))).toMatchObject({ tone: 'muted' });
    expect(bannerFor(table({}), device({ unpinned: true }))).toMatchObject({
      title: 'Development mode',
    });
    // a chain that did not answer is checked again by itself: no alarm for that
    expect(bannerFor(table({}), device({ epochProblem: { rule: 'CHAIN-READ' } }))).toBeNull();
  });
});

describe('labels and the shield', () => {
  test('signed state number, the red shield, the clock', () => {
    expect(signedLabel(device())).toBe('Signed state #4');
    expect(signedLabel(device({ bundleNonce: null }))).toBeNull();
    expect(signedLabel(null)).toBeNull();
    expect(vaultAlarm(device())).toBe(false);
    expect(vaultAlarm(device({ refused: { rule: 'C1a' } }))).toBe(true);
    expect(vaultAlarm(device({ failure: { kind: 'storage', blocking: false } }))).toBe(false);
    expect(vaultAlarm(null)).toBe(false);
    expect(clock(61_000)).toBe('1:01');
    expect(clock(-5)).toBe('0:00');
  });
});
