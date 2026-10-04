import { beforeEach, describe, expect, test } from 'bun:test';
import { createClient } from '../src/lib/client.js';
import { initialState } from '../src/lib/game.js';
import { createStore } from '../src/lib/store.js';

class FakeSocket {
  static last = null;
  sent = [];
  open = true;
  constructor(options) {
    this.options = options;
    FakeSocket.last = this;
  }
  connect() {
    this.options.onStatus('open');
  }
  close() {
    this.closed = true;
  }
  send(message) {
    this.sent.push(message);
    return this.open;
  }
  receive(message) {
    this.options.onMessage(message);
  }
}

const memory = () => {
  const data = new Map();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v),
    removeItem: (k) => data.delete(k),
    data,
  };
};

const tableMsg = (seq, over = {}, events = []) => ({
  t: 'tbl',
  tableId: 't1',
  seq,
  events,
  state: {
    tableId: 't1',
    name: 'T',
    handNo: 3,
    inHand: true,
    button: 0,
    toAct: 0,
    round: 'flop',
    board: [],
    pot: 0,
    seats: [{ seat: 0, playerId: 'me', name: 'Me', chips: 100 }, null],
    legal: null,
    deadline: null,
    fairness: { current: { handNo: 3, commitment: 'c' }, next: { handNo: 4, commitment: 'n' } },
    ...over,
  },
});

function setup(options = {}) {
  const storage = memory();
  const logins = [];
  let seeds = 0;
  const client = createClient({
    store: createStore(initialState),
    storage,
    login: async (arg) => {
      logins.push(arg);
      if (options.rejectLogin) throw new Error('nope');
      return { token: 'tok', player: { id: 'me', name: 'Me', balance: 5000 } };
    },
    wsUrl: () => 'ws://x/ws',
    SocketImpl: FakeSocket,
    seed: () => `seed${++seeds}`.padEnd(8, '0').replace(/[^0-9a-f]/g, 'a'),
    verify: options.verify ?? (async () => true),
  });
  return { client, storage, logins, state: () => client.store.get() };
}

const seat = () => {
  FakeSocket.last.receive({
    t: 'welcome',
    v: 1,
    player: { id: 'me', name: 'Me', balance: 5000 },
    tables: [],
    seated: { tableId: 't1', seat: 0 },
  });
};

beforeEach(() => {
  FakeSocket.last = null;
});

describe('boot and login', () => {
  test('no saved session shows the login screen', async () => {
    const { client, state } = setup();
    await client.boot();
    expect(state().phase).toBe('login');
    expect(FakeSocket.last).toBeNull();
  });

  test('a saved session resumes and connects', async () => {
    const { client, storage, logins, state } = setup();
    storage.setItem('pgg.token', 'saved');
    await client.boot();
    expect(logins).toEqual([{ token: 'saved' }]);
    expect(FakeSocket.last.options.url()).toContain('?token=tok');
    FakeSocket.last.receive({
      t: 'welcome',
      v: 1,
      player: { id: 'me', name: 'Me', balance: 5000 },
      tables: [],
      seated: null,
    });
    expect(state()).toMatchObject({ phase: 'lobby', balance: 5000, connection: 'open' });
  });

  test('a rejected saved session falls back to login and forgets the token', async () => {
    const { client, storage, state } = setup({ rejectLogin: true });
    storage.setItem('pgg.token', 'stale');
    await client.boot();
    expect(state().phase).toBe('login');
    expect(storage.getItem('pgg.token')).toBeNull();
  });

  test('logging in stores the token; an unauthorized socket clears it', async () => {
    const { client, storage, state } = setup();
    await client.login('Me');
    expect(storage.getItem('pgg.token')).toBe('tok');
    FakeSocket.last.options.onStatus('unauthorized');
    expect(storage.getItem('pgg.token')).toBeNull();
    expect(state().phase).toBe('login');
  });

  test('logout closes the socket and returns to login', async () => {
    const { client, storage, state } = setup();
    await client.login('Me');
    const socket = FakeSocket.last;
    client.logout();
    expect(socket.closed).toBe(true);
    expect(storage.getItem('pgg.token')).toBeNull();
    expect(state()).toMatchObject({ phase: 'login', me: null });
  });
});

describe('actions', () => {
  test('join, leave, back and rebuy send the right messages', async () => {
    const { client } = setup();
    await client.login('Me');
    client.join('t1', 500);
    client.leave();
    client.back();
    client.rebuy(200);
    expect(FakeSocket.last.sent).toEqual([
      { t: 'join', tableId: 't1', buyIn: 500 },
      { t: 'leave' },
      { t: 'back' },
      { t: 'rebuy', amount: 200 },
    ]);
  });

  test('act is tagged with the current hand number', async () => {
    const { client } = setup();
    await client.login('Me');
    seat();
    FakeSocket.last.receive(tableMsg(1));
    client.act('raise', 80);
    client.act('fold');
    expect(FakeSocket.last.sent.filter((m) => m.t === 'act')).toEqual([
      { t: 'act', handNo: 3, action: 'raise', amount: 80 },
      { t: 'act', handNo: 3, action: 'fold' },
    ]);
  });

  test('act does nothing before a table is known', async () => {
    const { client } = setup();
    await client.login('Me');
    expect(client.act('fold')).toBe(false);
  });
});

describe('fairness', () => {
  test('contributes exactly one client seed per upcoming hand', async () => {
    const { client } = setup();
    await client.login('Me');
    seat();
    FakeSocket.last.receive(tableMsg(1));
    FakeSocket.last.receive(tableMsg(2));
    FakeSocket.last.receive(
      tableMsg(3, {
        fairness: { current: { handNo: 4, commitment: 'n' }, next: { handNo: 5, commitment: 'm' } },
      }),
    );
    const seeds = FakeSocket.last.sent.filter((m) => m.t === 'seed');
    expect(seeds.map((s) => s.handNo)).toEqual([4, 5]);
    expect(seeds[0].seed).toMatch(/^[0-9a-f]+$/);
  });

  test('does not send a seed when not seated', async () => {
    const { client } = setup();
    await client.login('Me');
    FakeSocket.last.receive({
      t: 'welcome',
      v: 1,
      player: { id: 'me', name: 'Me', balance: 1 },
      tables: [],
      seated: null,
    });
    expect(FakeSocket.last.sent.filter((m) => m.t === 'seed')).toEqual([]);
  });

  test('retries the seed if the socket could not send it', async () => {
    const { client } = setup();
    await client.login('Me');
    seat();
    FakeSocket.last.open = false;
    FakeSocket.last.receive(tableMsg(1));
    FakeSocket.last.open = true;
    FakeSocket.last.receive(tableMsg(2));
    expect(FakeSocket.last.sent.filter((m) => m.t === 'seed' && m.handNo === 4)).toHaveLength(2);
  });

  test('verifies a proof and records the outcome', async () => {
    const { client, state } = setup({ verify: async (proof) => proof.good });
    await client.login('Me');
    seat();
    FakeSocket.last.receive({ t: 'proof', tableId: 't1', handNo: 3, proof: { good: true } });
    FakeSocket.last.receive({ t: 'proof', tableId: 't1', handNo: 2, proof: { good: false } });
    await new Promise((r) => setTimeout(r, 0));
    expect(state().proofs.map((p) => [p.handNo, p.ok])).toEqual([
      [2, false],
      [3, true],
    ]);
  });
});

describe('staying in sync', () => {
  test('a gap in the sequence asks for a resync, once', async () => {
    const { client } = setup();
    await client.login('Me');
    seat();
    FakeSocket.last.receive(tableMsg(1));
    FakeSocket.last.receive(tableMsg(2));
    FakeSocket.last.receive(tableMsg(5)); // 3 and 4 were lost
    FakeSocket.last.receive(tableMsg(5));
    expect(FakeSocket.last.sent.filter((m) => m.t === 'sync')).toHaveLength(1);
  });

  test('consecutive messages do not trigger a resync', async () => {
    const { client } = setup();
    await client.login('Me');
    seat();
    for (const seq of [1, 2, 3, 4]) FakeSocket.last.receive(tableMsg(seq));
    expect(FakeSocket.last.sent.filter((m) => m.t === 'sync')).toEqual([]);
  });
});
