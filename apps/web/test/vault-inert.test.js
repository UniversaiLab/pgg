// Play-money sessions must not pay for the vault in any way: the controller is never imported, its storage is
// never touched and nothing is logged. A lobby that merely lists a vault table costs one read per such table.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { RECORD_PREFIX } from '@pgg/vault';
import { createClient, VAULT_RECORD_PREFIX } from '../src/lib/client.js';
import { initialState } from '../src/lib/game.js';
import { createStore } from '../src/lib/store.js';

class FakeSocket {
  static last = null;
  sent = [];
  constructor(options) {
    this.options = options;
    FakeSocket.last = this;
  }
  connect() {
    this.options.onStatus('open');
  }
  close() {}
  send(message) {
    this.sent.push(message);
    return true;
  }
  receive(message) {
    this.options.onMessage(message);
  }
}

function spyStorage() {
  const data = new Map([['pgg.token', 'tok']]);
  const calls = [];
  return {
    calls,
    getItem: (k) => {
      calls.push(['getItem', k]);
      return data.get(k) ?? null;
    },
    setItem: (k, v) => {
      calls.push(['setItem', k]);
      data.set(k, v);
    },
    removeItem: (k) => {
      calls.push(['removeItem', k]);
      data.delete(k);
    },
  };
}

const table = (seq, over = {}, events = []) => ({
  t: 'tbl',
  tableId: 't1',
  seq,
  events,
  state: {
    tableId: 't1',
    name: 'T',
    handNo: seq,
    inHand: true,
    button: 0,
    toAct: 0,
    round: 'flop',
    board: [],
    pot: 10,
    seats: [{ seat: 0, playerId: 'me', name: 'Me', chips: 100, bet: 0, status: 'seated' }, null],
    legal: null,
    deadline: null,
    fairness: { current: null, next: { handNo: seq + 1, commitment: 'c' } },
    ...over,
  },
});

const PLAY = {
  id: 't1',
  name: 'T',
  smallBlind: 5,
  bigBlind: 10,
  minBuyIn: 100,
  maxBuyIn: 1000,
  numSeats: 6,
  occupied: 1,
  rakeBps: 0,
};

let logs = [];
const original = {};
beforeEach(() => {
  logs = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    original[level] = console[level];
    console[level] = (...args) => logs.push([level, ...args]);
  }
});
afterEach(() => {
  for (const level of Object.keys(original)) console[level] = original[level];
});

function setup() {
  const storage = spyStorage();
  let loads = 0;
  const client = createClient({
    store: createStore(initialState),
    storage,
    login: async () => ({ token: 'tok', player: { id: 'me', name: 'Me', balance: 5000 } }),
    wsUrl: () => 'ws://x/ws',
    SocketImpl: FakeSocket,
    seed: () => 'ab'.repeat(16),
    verify: async () => true,
    loadVault: () => {
      loads += 1;
      return import('../src/lib/vault.js');
    },
  });
  return { client, storage, loads: () => loads };
}

describe('a play-money session never touches the vault', () => {
  test('welcome, seat, hands, proofs, errors, unseat, lobby, logout: no import, no vault storage, no log', async () => {
    const { client, storage, loads } = setup();
    await client.boot();
    const s = FakeSocket.last;
    s.receive({
      t: 'welcome',
      v: 1,
      player: { id: 'me', name: 'Me', balance: 5000 },
      tables: [PLAY],
      seated: null,
    });
    s.receive({ t: 'seated', tableId: 't1', seat: 0 });
    for (let seq = 1; seq <= 5; seq++) {
      s.receive(table(seq));
      s.receive({ t: 'cards', tableId: 't1', handNo: seq, seat: 0, cards: ['As', 'Kd'] });
      s.receive(
        table(seq, { inHand: false }, [
          {
            type: 'hand-end',
            result: { handNo: seq, pot: 10, rake: 0, stacks: [100], busted: [] },
          },
        ]),
      );
    }
    s.receive({ t: 'err', code: 'not-your-turn' });
    s.receive({ t: 'unseated', tableId: 't1', reason: 'left', chips: 100 });
    s.receive({ t: 'lobby', tables: [PLAY] });
    client.leave();
    client.logout();
    await client.vaultSettled();
    expect(loads()).toBe(0);
    expect(client.store.get().vault).toBeNull();
    expect(storage.calls.filter(([, key]) => key !== 'pgg.token')).toEqual([]);
    expect(logs).toEqual([]);
  });

  test('a lobby that lists a vault table this device has no key for: one read per vault table, no import', async () => {
    const { client, storage, loads } = setup();
    await client.boot();
    const vaultTable = {
      ...PLAY,
      id: 'vault-1',
      vault: {
        chainId: 31337,
        vault: `0x${'0d'.repeat(20)}`,
        tableKey: `0x${'AB'.repeat(32)}`,
        chipUnit: '10000',
        maxRakeBps: 500,
        exitWindowSec: 3600,
        arbiter: `0x${'0a'.repeat(20)}`,
      },
    };
    FakeSocket.last.receive({
      t: 'welcome',
      v: 1,
      player: { id: 'me', name: 'Me', balance: 5000 },
      tables: [PLAY, vaultTable],
      seated: null,
    });
    await client.vaultSettled();
    expect(loads()).toBe(0);
    expect(storage.calls.filter(([, key]) => key !== 'pgg.token')).toEqual([
      ['getItem', `${RECORD_PREFIX}0x${'ab'.repeat(32)}`],
    ]);
    expect(logs).toEqual([]);
  });

  test("the client's copy of the record prefix is the library's", () => {
    expect(VAULT_RECORD_PREFIX).toBe(RECORD_PREFIX);
  });
});
