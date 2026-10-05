import { describe, expect, test } from 'bun:test';
import { privateKeyToAddress, recoverSigner, signDigest } from '@pgg/vault';
import { privateKeyToAccount } from 'viem/accounts';
import { LocalKeySigner } from '../../src/vault/signer.js';
import { keyFor } from './fake-chain-world.js';

const KEY = keyFor('arbiter');
const TABLE = `0x${'ab'.repeat(32)}`;
const OTHER_TABLE = `0x${'cd'.repeat(32)}`;
const DIGEST_5 = `0x${'05'.repeat(32)}`;
const DIGEST_6 = `0x${'06'.repeat(32)}`;

// A store stand-in: reserve(table, nonce, digest) and the callback the signer is given.
function makeStore() {
  const reservations = new Map();
  const calls = [];
  return {
    calls,
    reserve: (table, nonce, digest) => reservations.set(`${table}:${nonce}`, digest),
    reserved: (table, nonce) => {
      calls.push([table, nonce]);
      return reservations.get(`${table}:${nonce}`);
    },
  };
}

describe('LocalKeySigner', () => {
  test('its address is the address of the key', () => {
    const store = makeStore();
    const signer = new LocalKeySigner({ privateKey: KEY, reserved: store.reserved });
    expect(signer.address).toBe(privateKeyToAddress(KEY));
    expect(signer.address).toBe(privateKeyToAccount(KEY).address.toLowerCase());
  });

  test('signs the reserved digest, and the signature recovers to the signer address', () => {
    const store = makeStore();
    const signer = new LocalKeySigner({ privateKey: KEY, reserved: store.reserved });
    store.reserve(TABLE, 5n, DIGEST_5);
    const sig = signer.signReserved(TABLE, 5n);
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
    expect(recoverSigner(DIGEST_5, sig)).toBe(signer.address);
    expect(recoverSigner(DIGEST_6, sig)).not.toBe(signer.address); // it signed that digest and no other
    expect(sig).toBe(signDigest(KEY, DIGEST_5));
  });

  test('is byte-identical to viem (r || s || v, v 27 or 28, low-s): the contract accepts it', async () => {
    const store = makeStore();
    const signer = new LocalKeySigner({ privateKey: KEY, reserved: store.reserved });
    store.reserve(TABLE, 1n, DIGEST_5);
    const viemSig = await privateKeyToAccount(KEY).sign({ hash: DIGEST_5 });
    expect(signer.signReserved(TABLE, 1n)).toBe(viemSig);
  });

  test('signing again gives the same bytes, however often (a crash between reserve and attach re-signs)', () => {
    const store = makeStore();
    const signer = new LocalKeySigner({ privateKey: KEY, reserved: store.reserved });
    store.reserve(TABLE, 5n, DIGEST_5);
    const first = signer.signReserved(TABLE, 5n);
    for (let i = 0; i < 5; i++) expect(signer.signReserved(TABLE, 5n)).toBe(first);
    const again = new LocalKeySigner({ privateKey: KEY, reserved: store.reserved });
    expect(again.signReserved(TABLE, 5n)).toBe(first);
  });

  test('refuses a nonce nothing was reserved for, and says which table and nonce', () => {
    const store = makeStore();
    const signer = new LocalKeySigner({ privateKey: KEY, reserved: store.reserved });
    expect(() => signer.signReserved(TABLE, 5n)).toThrow(/nothing is reserved/);
    expect(() => signer.signReserved(TABLE, 5n)).toThrow(TABLE);
    store.reserve(TABLE, 5n, DIGEST_5);
    expect(() => signer.signReserved(TABLE, 6n)).toThrow(/nonce 6/); // 5 is reserved, 6 is not
    expect(() => signer.signReserved(TABLE, 4n)).toThrow(/nothing is reserved/);
    expect(() => signer.signReserved(OTHER_TABLE, 5n)).toThrow(/nothing is reserved/); // another table
  });

  test('a null, undefined or missing answer from the store is a refusal, never a guess', () => {
    for (const answer of [null, undefined]) {
      const signer = new LocalKeySigner({ privateKey: KEY, reserved: () => answer });
      expect(() => signer.signReserved(TABLE, 1n)).toThrow(/nothing is reserved/);
    }
  });

  test('asks the store with exactly (tableKey, nonce) every time and remembers nothing', () => {
    const store = makeStore();
    const signer = new LocalKeySigner({ privateKey: KEY, reserved: store.reserved });
    store.reserve(TABLE, 5n, DIGEST_5);
    signer.signReserved(TABLE, 5n);
    signer.signReserved(TABLE, 5n);
    expect(store.calls).toEqual([
      [TABLE, 5n],
      [TABLE, 5n],
    ]);

    // the store is the authority at the moment of signing: when it no longer has the reservation, no signature
    let live = DIGEST_5;
    const signer2 = new LocalKeySigner({ privateKey: KEY, reserved: () => live });
    signer2.signReserved(TABLE, 5n);
    live = undefined;
    expect(() => signer2.signReserved(TABLE, 5n)).toThrow(/nothing is reserved/);
    live = DIGEST_6;
    expect(recoverSigner(DIGEST_6, signer2.signReserved(TABLE, 5n))).toBe(signer2.address);
  });

  test('a number nonce means the same as the bigint; a nonce that is not a nonce is refused', () => {
    const store = makeStore();
    const signer = new LocalKeySigner({ privateKey: KEY, reserved: store.reserved });
    store.reserve(TABLE, 7n, DIGEST_5);
    expect(signer.signReserved(TABLE, 7)).toBe(signer.signReserved(TABLE, 7n));
    expect(store.calls.every(([, nonce]) => typeof nonce === 'bigint')).toBe(true);
    for (const bad of [-1n, -1, 1.5, '7', null, undefined, Number.NaN, {}]) {
      expect(() => signer.signReserved(TABLE, bad)).toThrow(TypeError);
    }
    expect(() => signer.signReserved('', 7n)).toThrow(TypeError);
    expect(() => signer.signReserved(undefined, 7n)).toThrow(TypeError);
    expect(() => signer.signReserved(5, 7n)).toThrow(TypeError);
  });

  test('refuses to sign something that is not a digest, even if the store returns it', () => {
    for (const junk of [
      '0x1234',
      `0x${'05'.repeat(33)}`,
      'hello',
      5,
      5n,
      {},
      [],
      `${'05'.repeat(32)}`,
    ]) {
      const signer = new LocalKeySigner({ privateKey: KEY, reserved: () => junk });
      expect(() => signer.signReserved(TABLE, 1n)).toThrow(TypeError);
    }
  });

  test('an error from the store reaches the caller; nothing is signed around it', () => {
    const signer = new LocalKeySigner({
      privateKey: KEY,
      reserved: () => {
        throw new Error('database is locked');
      },
    });
    expect(() => signer.signReserved(TABLE, 1n)).toThrow('database is locked');
  });

  test('has no way to sign an arbitrary digest and does not show its key', () => {
    const store = makeStore();
    const signer = new LocalKeySigner({ privateKey: KEY, reserved: store.reserved });
    expect(Object.getOwnPropertyNames(LocalKeySigner.prototype).sort()).toEqual([
      'address',
      'constructor',
      'signReserved',
    ]);
    expect(Object.keys(signer)).toEqual([]);
    expect(Object.getOwnPropertyNames(signer)).toEqual([]);
    for (const name of ['sign', 'signDigest', 'signHash', 'signMessage', 'privateKey', 'key']) {
      expect(signer[name]).toBeUndefined();
    }
    const shown = `${JSON.stringify(signer)} ${String(signer)} ${JSON.stringify(Object.entries(signer))}`;
    expect(shown).not.toContain(KEY.slice(2));
    expect(Object.isFrozen(signer)).toBe(true);
    expect(() => {
      signer.sign = (digest) => digest;
    }).toThrow();
  });

  test('refuses a bad key or a missing store callback at construction', () => {
    const reserved = () => null;
    for (const privateKey of [
      undefined,
      null,
      '',
      KEY.slice(2),
      KEY.slice(0, -2),
      `${KEY}00`,
      5n,
      'zz'.repeat(32),
    ]) {
      expect(() => new LocalKeySigner({ privateKey, reserved })).toThrow(TypeError);
    }
    expect(() => new LocalKeySigner({ privateKey: KEY })).toThrow(TypeError);
    expect(() => new LocalKeySigner({ privateKey: KEY, reserved: 'x' })).toThrow(TypeError);
    expect(() => new LocalKeySigner({})).toThrow(TypeError);
  });
});
