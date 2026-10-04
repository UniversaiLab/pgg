import { describe, expect, test } from 'bun:test';
import { ClientMessage } from '@pgg/protocol';
import { signToken, verifyToken } from '../src/auth.js';
import { TokenBucket } from '../src/ratelimit.js';
import { PlayMoneyWallet } from '../src/wallet.js';

const SECRET = 'test-secret';
const claims = (exp) => ({ id: 'abc', name: 'Ann', exp });

describe('auth tokens', () => {
  test('round trip', () => {
    const token = signToken(SECRET, claims(2_000));
    expect(verifyToken(SECRET, token, 1_000)).toEqual(claims(2_000));
  });

  test('expired, tampered, wrong secret and junk are all rejected', () => {
    const token = signToken(SECRET, claims(2_000));
    expect(verifyToken(SECRET, token, 2_000)).toBeNull(); // exp is exclusive
    expect(verifyToken('other-secret', token, 1_000)).toBeNull();
    const [body, sig] = token.split('.');
    const forged = btoa(JSON.stringify({ ...claims(9_999_999), id: 'admin' })).replace(/=+$/, '');
    expect(verifyToken(SECRET, `${forged}.${sig}`, 1_000)).toBeNull();
    expect(verifyToken(SECRET, `${body}.${sig}x`, 1_000)).toBeNull();
    for (const junk of [undefined, null, '', 'a', 'a.b', 'a.b.c', 5, {}, 'x'.repeat(600)]) {
      expect(verifyToken(SECRET, junk, 1_000)).toBeNull();
    }
  });
});

describe('TokenBucket', () => {
  test('allows a burst, then refills over time', () => {
    let now = 0;
    const bucket = new TokenBucket({ capacity: 3, refillPerSec: 2, now: () => now });
    expect([bucket.take(), bucket.take(), bucket.take(), bucket.take()]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    now += 500; // refills one token
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
    now += 60_000; // never exceeds capacity
    expect([bucket.take(), bucket.take(), bucket.take(), bucket.take()]).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });
});

describe('PlayMoneyWallet', () => {
  test('issues once per player, debits only what exists, and tracks the invariant', () => {
    const wallet = new PlayMoneyWallet({ startBalance: 1000 });
    wallet.open('a');
    wallet.open('a');
    expect(wallet.issued).toBe(1000);
    expect(wallet.debit('a', 1001)).toBe(false);
    expect(wallet.debit('a', 0)).toBe(false);
    expect(wallet.debit('a', 1.5)).toBe(false);
    expect(wallet.debit('nobody', 1)).toBe(false);
    expect(wallet.debit('a', 400)).toBe(true);
    wallet.creditHouse(10);
    expect(wallet.balance('a')).toBe(600);
    expect(wallet.held).toBe(610); // the 390 not accounted for here is "at a table"
    expect(() => wallet.credit('nobody', 1)).toThrow();
    expect(() => wallet.credit('a', -1)).toThrow();
  });
});

describe('ClientMessage', () => {
  test('accepts every valid message', () => {
    for (const msg of [
      { t: 'join', tableId: 'rookie-1', buyIn: 500 },
      { t: 'join', tableId: 'rookie-1', buyIn: 500, seat: 3 },
      { t: 'leave' },
      { t: 'act', handNo: 3, action: 'raise', amount: 40 },
      { t: 'act', handNo: 3, action: 'fold' },
      { t: 'seed', handNo: 4, seed: 'c0ffee' },
      { t: 'rebuy', amount: 100 },
      { t: 'back' },
      { t: 'sync' },
      { t: 'ping', n: 7 },
    ]) {
      expect(ClientMessage.safeParse(msg).success, JSON.stringify(msg)).toBe(true);
    }
  });

  test('rejects malformed, unknown, extra-field and out-of-range messages', () => {
    for (const msg of [
      null,
      'join',
      {},
      { t: 'nope' },
      { t: 'join', tableId: 'x' },
      { t: 'join', tableId: 'x', buyIn: 0 },
      { t: 'join', tableId: 'x', buyIn: -5 },
      { t: 'join', tableId: 'x', buyIn: 1.5 },
      { t: 'join', tableId: '', buyIn: 100 },
      { t: 'join', tableId: 'x', buyIn: 100, extra: 1 },
      { t: 'act', handNo: 1, action: 'allin' },
      { t: 'act', handNo: -1, action: 'fold' },
      { t: 'act', handNo: 1, action: 'raise', amount: -1 },
      { t: 'seed', handNo: 1, seed: 'XYZ' },
      { t: 'seed', handNo: 1, seed: 'a' },
      { t: 'seed', handNo: 1, seed: 'ab'.repeat(40) },
      { t: 'rebuy', amount: 0 },
      { t: 'leave', tableId: 'sneaky' },
    ]) {
      expect(ClientMessage.safeParse(msg).success, JSON.stringify(msg)).toBe(false);
    }
  });
});
