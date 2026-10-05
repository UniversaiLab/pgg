import { describe, expect, test } from 'bun:test';
import { ERR } from '@pgg/protocol/constants';
import { TableActor } from '../../src/table-actor.js';
import { NullWallet } from '../../src/vault/null-wallet.js';
import { PlayMoneyWallet } from '../../src/wallet.js';
import { player, setup } from '../helpers.js';

const members = (cls) =>
  Object.entries(Object.getOwnPropertyDescriptors(cls.prototype))
    .filter(([name]) => name !== 'constructor')
    .map(([name, d]) => `${typeof d.value === 'function' ? 'method' : 'getter'} ${name}`)
    .sort();

describe('NullWallet', () => {
  test('has exactly the interface of PlayMoneyWallet, so it swaps in without touching a caller', () => {
    expect(members(NullWallet)).toEqual(members(PlayMoneyWallet));
  });

  test('debit always refuses, whatever is asked', () => {
    const wallet = new NullWallet();
    for (const amount of [
      1,
      100,
      0,
      -5,
      1.5,
      Number.NaN,
      Number.MAX_SAFE_INTEGER,
      10n,
      '5',
      null,
    ]) {
      expect(wallet.debit('p1', amount)).toBe(false);
    }
    expect(wallet.debit('nobody', 1)).toBe(false);
    expect(wallet.debit(undefined, 1)).toBe(false);
  });

  test('credit and creditHouse do nothing: no throw, no balance, no house', () => {
    const wallet = new NullWallet();
    expect(() => wallet.credit('p1', 500)).not.toThrow();
    expect(() => wallet.credit('p1', -1)).not.toThrow();
    expect(() => wallet.credit('unknown', Number.NaN)).not.toThrow();
    expect(() => wallet.creditHouse(40)).not.toThrow();
    expect(() => wallet.creditHouse(-3)).not.toThrow();
    expect(wallet.balance('p1')).toBe(0);
    expect(wallet.house).toBe(0);
    expect(wallet.held).toBe(0);
    expect(wallet.issued).toBe(0);
  });

  test('it keeps no state: nothing a caller does is remembered, so a missed call site leaves no trace', () => {
    const wallet = new NullWallet();
    wallet.open('p1');
    wallet.credit('p1', 500);
    wallet.creditHouse(40);
    wallet.debit('p1', 1);
    wallet.balance('p1');
    expect(Object.getOwnPropertyNames(wallet)).toEqual([]);
    expect(Object.getOwnPropertySymbols(wallet)).toEqual([]);
  });

  test('every balance is 0 and open() creates nothing', () => {
    const wallet = new NullWallet();
    expect(wallet.open('p1')).toBe(0);
    expect(wallet.balance('p1')).toBe(0);
    expect(wallet.balance('p2')).toBe(0);
    expect(wallet.house).toBe(0);
    expect(wallet.issued).toBe(0);
    expect(wallet.held).toBe(0);
    expect(wallet.debit('p1', 1)).toBe(false); // opening it did not give it funds
  });

  test('fails closed in a TableActor: a missed call site cannot seat anyone with chips from nowhere', () => {
    const env = setup();
    const actor = new TableActor({
      cfg: env.cfg,
      bus: env.bus,
      wallet: new NullWallet(),
      clock: env.clock,
    });
    expect(actor.join(player(1), { buyIn: 200 })).toMatchObject({
      ok: false,
      code: ERR.INSUFFICIENT_FUNDS,
    });
    expect(actor.chipsOnTable()).toBe(0);
  });
});
