// A vault session through the real client (createClient, the reducer, the lazily loaded controller) over a fake
// socket, against the scripted server of @pgg/vault's tests: claim on welcome, the epoch, hands signed and
// bundles kept with the UI state following, lies refused end to end, a reload answering with the identical
// signature, Leave recorded before the leave goes out, and a pending claim retried.
import { describe, expect, test } from 'bun:test';
import { CLIENT, SERVER } from '@pgg/protocol/constants';
import {
  CHAIN_ID,
  DOMAIN,
  GAME_TABLE,
  makeWorld,
  publish,
  UNIT,
  VAULT,
} from '../../../packages/vault/test/signer-world.js';
import { createClient } from '../src/lib/client.js';
import { initialState, vaultHere } from '../src/lib/game.js';
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

class FakeTimers {
  queue = [];
  setTimeout = (fn, ms) => {
    this.queue.push({ fn, ms });
    return this.queue.length;
  };
  clearTimeout = () => {};
  runAll() {
    for (const { fn } of this.queue.splice(0)) fn();
  }
}

const summaryOf = (w) => ({
  id: GAME_TABLE,
  name: 'Vault table',
  smallBlind: 5,
  bigBlind: 10,
  minBuyIn: 100,
  maxBuyIn: 5000,
  numSeats: 6,
  occupied: 3,
  rakeBps: 200,
  vault: {
    chainId: CHAIN_ID,
    vault: VAULT,
    tableKey: w.tableKey,
    chipUnit: String(UNIT),
    maxRakeBps: 500,
    exitWindowSec: 3600,
    arbiter: w.arbiter,
  },
});

function makeClient(w, alice, { timers = new FakeTimers() } = {}) {
  alice.storage.setItem('pgg.token', 'tok');
  return createClient({
    store: createStore(initialState),
    storage: alice.storage,
    login: async () => ({ token: 'tok', player: { id: 'p-alice', name: 'alice', balance: 0 } }),
    wsUrl: () => 'ws://x/ws',
    SocketImpl: FakeSocket,
    seed: () => 'ab'.repeat(16),
    verify: async () => true,
    vaultConfig: { rpcUrl: null, domain: DOMAIN, allowUnpinned: false },
    vaultOptions: { chainView: w.chain, locks: null, tabId: 'tab-a' },
    timers,
  });
}

async function session({ seed = 7 } = {}) {
  const w = makeWorld({ seed });
  for (const c of w.clients) w.depositFor(c);
  const [alice] = w.clients;
  const timers = new FakeTimers();
  const client = makeClient(w, alice, { timers });
  await client.boot();
  const socket = FakeSocket.last;
  const epoch = w.server.startEpoch(w.clients);
  for (const c of w.clients.slice(1)) await c.signer.handleEpoch(epoch, c.ctx());
  const welcome = {
    t: SERVER.WELCOME,
    v: 1,
    player: { id: 'p-alice', name: 'alice', balance: 0 },
    tables: [summaryOf(w)],
    seated: null,
  };
  const deliver = async (message) => {
    socket.receive(message);
    await client.vaultSettled();
  };
  return {
    w,
    alice,
    client,
    socket,
    epoch,
    welcome,
    deliver,
    timers,
    sigs: () => socket.sent.filter((m) => m.t === CLIENT.SIGN),
  };
}

// Everyone but alice signs; then the bundle goes to everyone.
async function finishRound(s, req) {
  const mine = s.sigs().at(-1);
  s.w.server.collect(s.alice, { nonce: BigInt(mine.nonce), digest: mine.digest, sig: mine.sig });
  for (const c of s.w.clients.slice(1))
    s.w.server.collect(c, c.signer.handleSignReq(req, { ledger: c.ledger }));
  const bundle = s.w.server.bundle();
  for (const c of s.w.clients.slice(1)) c.signer.acceptBundle(bundle);
  await s.deliver(bundle);
}

async function playHand(s, args) {
  const { tbl, state } = s.w.server.hand(args);
  publish(s.w, tbl, s.w.clients.slice(1));
  await s.deliver(tbl);
  const req = s.w.server.propose(state);
  await s.deliver(req);
  return req;
}

describe('a vault session through the client', () => {
  test('welcome claims, the epoch pins, hands are signed and bundles kept; the reducer shows it', async () => {
    const s = await session();
    await s.deliver(s.welcome);
    const claim = s.socket.sent.find((m) => m.t === CLIENT.CLAIM);
    expect(claim).toMatchObject({ tableId: GAME_TABLE, address: s.alice.wallet });
    await s.deliver({ t: SERVER.SEATED, tableId: GAME_TABLE, seat: 0 });
    await s.deliver(s.epoch);
    for (let i = 0; i < 3; i++) {
      const req = await playHand(s, {
        winner: s.w.clients[i % 3],
        loser: s.w.clients[(i + 1) % 3],
        amount: 15,
        rake: 1,
      });
      expect(s.sigs()).toHaveLength(i + 1);
      await finishRound(s, req);
    }
    const vault = vaultHere(s.client.store.get());
    expect(vault).toMatchObject({
      tableId: GAME_TABLE,
      epoch: 1,
      signedNonce: '3',
      bundleNonce: '3',
      failure: null,
      refused: null,
    });
  });

  test('a lie is refused end to end: no signature leaves, the refusal is in the state', async () => {
    const s = await session({ seed: 8 });
    await s.deliver(s.welcome);
    await s.deliver({ t: SERVER.SEATED, tableId: GAME_TABLE, seat: 0 });
    await s.deliver(s.epoch);
    await s.deliver(s.w.server.tableMessage());
    const head = s.w.server.head;
    const i = s.w.server.roster.indexOf(s.alice);
    const balances = [...head.balances];
    balances[i] -= 50n * UNIT;
    balances[(i + 1) % balances.length] += 50n * UNIT;
    await s.deliver(
      s.w.server.propose({ ...head, nonce: head.nonce + 1n, balances }, { handNo: null }),
    );
    expect(s.sigs()).toEqual([]);
    expect(vaultHere(s.client.store.get()).refused).toMatchObject({ rule: 'C1b' });
  });

  test('a reload mid-round: the new page claims again and answers the re-sent request identically', async () => {
    const s = await session({ seed: 9 });
    await s.deliver(s.welcome);
    await s.deliver({ t: SERVER.SEATED, tableId: GAME_TABLE, seat: 0 });
    await s.deliver(s.epoch);
    const { tbl, state } = s.w.server.hand({
      winner: s.w.clients[0],
      loser: s.w.clients[1],
      amount: 10,
      rake: 1,
    });
    await s.deliver(tbl);
    const req = s.w.server.propose(state);
    await s.deliver(req);
    const first = s.sigs()[0];
    const reloaded = makeClient(s.w, s.alice);
    await reloaded.boot();
    const socket = FakeSocket.last;
    for (const message of [
      s.welcome,
      { t: SERVER.SEATED, tableId: GAME_TABLE, seat: 0 },
      s.epoch,
      tbl,
      req,
    ]) {
      socket.receive(message);
      await reloaded.vaultSettled();
    }
    expect(socket.sent.filter((m) => m.t === CLIENT.SIGN)).toEqual([first]);
    expect(socket.sent.filter((m) => m.t === CLIENT.CLAIM)).toHaveLength(1);
  });

  test('Leave at a vault table records the intent before the leave message goes out', async () => {
    const s = await session({ seed: 10 });
    await s.deliver(s.welcome);
    await s.deliver({ t: SERVER.SEATED, tableId: GAME_TABLE, seat: 0 });
    await s.deliver(s.epoch);
    await s.deliver(s.w.server.tableMessage());
    expect(s.client.leave()).toBe(true);
    expect(s.socket.sent.at(-1)).toEqual({ t: CLIENT.LEAVE });
    const record = JSON.parse(s.alice.storage.map.get(`pgg.vault.v1.${s.w.tableKey}`));
    expect(record.leaveAckNonce).toBe('0');
  });

  test('a pending claim (deposit not confirmed yet) is retried, once at a time', async () => {
    const s = await session({ seed: 11 });
    await s.deliver(s.welcome);
    const claims = () => s.socket.sent.filter((m) => m.t === CLIENT.CLAIM).length;
    expect(claims()).toBe(1);
    await s.deliver({ t: SERVER.ERROR, code: 'claim-pending' });
    await s.deliver({ t: SERVER.ERROR, code: 'claim-pending' });
    expect(s.timers.queue).toHaveLength(1);
    s.timers.runAll();
    expect(claims()).toBe(2);
    expect(s.client.store.get().toasts.at(-1).text).toMatch(/still being confirmed/);
  });

  test('logout keeps the vault record on this device', async () => {
    const s = await session({ seed: 12 });
    await s.deliver(s.welcome);
    await s.deliver(s.epoch);
    s.client.logout();
    expect(s.alice.storage.map.has(`pgg.vault.v1.${s.w.tableKey}`)).toBe(true);
    expect(s.client.store.get().vault).toBeNull();
  });
});
