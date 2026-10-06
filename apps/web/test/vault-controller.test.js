// The browser's vault controller (src/lib/vault.js) driven by the scripted world of @pgg/vault's own tests: a
// FakeChainView, storage fakes that fail like a browser's, and a server that plays hands and proposes states.
// The controller plays alice's browser; bob and carol sign with their own signers.
import { describe, expect, test } from 'bun:test';
import { CLIENT, SERVER } from '@pgg/protocol/constants';
import { hashState, toWire, verifyClaim } from '@pgg/vault';
import {
  CHAIN_ID,
  DOMAIN,
  GAME_TABLE,
  makeWorld,
  memoryStorage,
  publish,
  storedRecord,
  UNIT,
  VAULT,
} from '../../../packages/vault/test/signer-world.js';
import { createVaultController, withTimeout } from '../src/lib/vault.js';

const summaryOf = (w, over = {}) => ({
  id: GAME_TABLE,
  name: 'Vault table',
  vault: {
    chainId: CHAIN_ID,
    vault: VAULT,
    tableKey: w.tableKey,
    chipUnit: String(UNIT),
    maxRakeBps: 500,
    exitWindowSec: 3600,
    arbiter: w.arbiter,
    ...over,
  },
});

/** A world where every client deposited, the chain started, and alice's browser is the controller. */
function setup({ seed = 3, controller: options = {}, start = true } = {}) {
  // tabId: one browser tab, unless a test says otherwise
  const w = makeWorld({ seed });
  for (const c of w.clients) w.depositFor(c);
  const [alice] = w.clients;
  const sent = [];
  const states = [];
  const controller = createVaultController({
    storage: options.storage ?? alice.storage,
    chainView: w.chain,
    send: (message) => {
      sent.push(message);
      return true;
    },
    onState: (tableId, state) => states.push({ tableId, state }),
    locks: null,
    tabId: 'tab-a',
    ...options,
  });
  controller.setContext({ playerId: 'p-alice', tables: [summaryOf(w)] });
  const epoch = start ? w.server.startEpoch(w.clients) : null;
  return {
    w,
    alice,
    controller,
    sent,
    states,
    epoch,
    sigs: () => sent.filter((m) => m.t === CLIENT.SIGN),
  };
}

// The scripted server counts nonces as bigints; the wire carries decimal strings.
const fromSigMessage = (m) => ({ nonce: BigInt(m.nonce), digest: m.digest, sig: m.sig });

// Everyone else signs the request the honest way; the controller has answered (or not) already.
function othersSign(w, req) {
  for (const c of w.clients.slice(1)) {
    const answer = c.signer.handleSignReq(req, { ledger: c.ledger });
    if (answer.action !== 'send') throw new Error(`${c.name}: ${JSON.stringify(answer)}`);
    w.server.collect(c, answer);
  }
}

async function pinOthers(w, epoch) {
  for (const c of w.clients.slice(1))
    expect(await c.signer.handleEpoch(epoch, c.ctx())).toEqual({ ok: true });
}

// One hand: the table messages go to everyone, the request to alice's controller first.
async function hand(t, args) {
  const { w, controller } = t;
  const { tbl, state } = w.server.hand(args);
  publish(w, tbl, w.clients.slice(1));
  await controller.handle(tbl);
  const req = w.server.propose(state);
  await controller.handle(req);
  return { tbl, state, req };
}

describe('the honest table', () => {
  test('claim, epoch, hands signed and bundles kept; the UI state follows', async () => {
    const t = setup();
    const { w, alice, controller, sent, epoch } = t;
    expect(controller.claimAll()).toBe(1);
    const claim = sent[0];
    expect(claim).toMatchObject({ t: CLIENT.CLAIM, tableId: GAME_TABLE, address: alice.wallet });
    expect(
      verifyClaim(
        { domain: DOMAIN, tableKey: w.tableKey, address: alice.wallet, playerId: 'p-alice' },
        claim.sig,
        alice.sessionAddress,
      ),
    ).toBe(true);

    await controller.handle(epoch);
    await pinOthers(w, epoch);
    expect(controller.state(GAME_TABLE)).toMatchObject({
      epoch: 1,
      failure: null,
      epochProblem: null,
    });

    for (let i = 0; i < 3; i++) {
      const { req } = await hand(t, {
        winner: w.clients[i % 3],
        loser: w.clients[(i + 1) % 3],
        amount: 20 + i,
        rake: 1,
      });
      const mine = t.sigs().at(-1);
      expect(mine).toMatchObject({
        t: CLIENT.SIGN,
        nonce: String(i + 1),
        digest: hashState(w.server.pending.state, DOMAIN),
      });
      expect(mine.digest).toBe(req.digest);
      w.server.collect(alice, fromSigMessage(mine));
      othersSign(w, req);
      await controller.handle(w.server.bundle());
    }
    expect(controller.state(GAME_TABLE)).toMatchObject({
      signedNonce: '3',
      bundleNonce: '3',
      waiting: null,
      refused: null,
    });
  });

  test('a request that arrives before the table shows the hand waits, and is signed once it does', async () => {
    const t = setup();
    const { w, controller, epoch } = t;
    await controller.handle(epoch);
    const { tbl, state } = w.server.hand({
      winner: w.clients[0],
      loser: w.clients[1],
      amount: 10,
      rake: 0,
    });
    await controller.handle(w.server.tableMessage({ inHand: true }));
    await controller.handle(w.server.propose(state));
    expect(t.sigs()).toEqual([]);
    expect(controller.state(GAME_TABLE).waiting).toBe('mid-hand');
    await controller.handle(tbl);
    expect(t.sigs()).toHaveLength(1);
    expect(controller.state(GAME_TABLE).waiting).toBeNull();
  });

  test('messages are handled in order: a request right behind its epoch waits for the chain check', async () => {
    const t = setup();
    const { w, controller, epoch } = t;
    const { tbl, state } = w.server.hand({
      winner: w.clients[0],
      loser: w.clients[1],
      amount: 10,
      rake: 1,
    });
    // not awaited: the epoch's chain read is still in flight when the table and the request arrive
    controller.handle(epoch);
    controller.handle(tbl);
    controller.handle(w.server.propose(state));
    await controller.settled();
    expect(t.sigs()).toHaveLength(1);
  });

  test('a reload: the epoch and the bundle re-sent back to back, the bundle is kept', async () => {
    const t = setup();
    const { w, alice, controller, epoch } = t;
    await controller.handle(epoch);
    await pinOthers(w, epoch);
    const first = await hand(t, { winner: w.clients[0], loser: w.clients[1], amount: 10, rake: 1 });
    w.server.collect(alice, fromSigMessage(t.sigs().at(-1)));
    othersSign(w, first.req);
    const bundle = w.server.bundle();
    // the page reloads: a new controller over the same storage, the server re-sends the epoch and the bundle
    const reloaded = createVaultController({
      storage: alice.storage,
      chainView: w.chain,
      send: () => true,
      locks: null,
      tabId: 'tab-a',
    });
    reloaded.setContext({ playerId: 'p-alice', tables: [summaryOf(w)] });
    reloaded.handle(epoch); // not awaited, as messages arrive
    reloaded.handle(bundle);
    await reloaded.settled();
    expect(reloaded.state(GAME_TABLE).bundleNonce).toBe('1');
  });

  test('Leave: the head the server showed is recorded, so a final that keeps me is refused later', async () => {
    const t = setup();
    const { w, alice, controller, epoch } = t;
    await controller.handle(epoch);
    await pinOthers(w, epoch);
    const first = await hand(t, { winner: w.clients[0], loser: w.clients[1], amount: 10, rake: 1 });
    w.server.collect(alice, fromSigMessage(t.sigs().at(-1)));
    othersSign(w, first.req);
    await controller.handle(w.server.bundle());
    await controller.handle(w.server.tableMessage());
    expect(controller.noteLeave(GAME_TABLE)).toMatchObject({ ok: true, leaveAckNonce: 1n });
    const keepMe = w.server.finalState(w.server.keepFor());
    await controller.handle(w.server.propose(keepMe, { handNo: null, reason: 'maintenance' }));
    expect(t.sigs()).toHaveLength(1);
    expect(controller.state(GAME_TABLE).refused).toMatchObject({ rule: 'C2' });
  });
});

describe('durability: on disk before it is sent', () => {
  test('the signature is in storage when send() is called', async () => {
    let checked = 0;
    const t = setup({
      controller: {
        send(message) {
          if (message.t === CLIENT.SIGN) {
            const raw = t.alice.storage.map.get(`pgg.vault.v1.${t.w.tableKey}`);
            if (raw.includes(message.sig.slice(2))) checked += 1;
            else checked = -100;
          }
          return true;
        },
      },
    });
    await t.controller.handle(t.epoch);
    await hand(t, { winner: t.w.clients[0], loser: t.w.clients[1], amount: 10, rake: 1 });
    expect(checked).toBe(1);
  });

  test('a write that fails sends no signature, and the failure is shown', async () => {
    const granted = { request: (_name, _options, callback) => Promise.resolve(callback({})) };
    const t = setup({ controller: { locks: granted } });
    await t.controller.handle(t.epoch);
    t.alice.storage.modes.failSet = true;
    await hand(t, { winner: t.w.clients[0], loser: t.w.clients[1], amount: 10, rake: 1 });
    expect(t.sigs()).toEqual([]);
    expect(t.controller.state(GAME_TABLE)).toMatchObject({
      refused: { rule: 'STORAGE' },
      failure: { kind: 'storage' },
    });
  });

  test('without Web Locks, broken storage stops signing at the lease, and says so', async () => {
    const t = setup();
    await t.controller.handle(t.epoch);
    t.alice.storage.modes.failSet = true;
    await hand(t, { winner: t.w.clients[0], loser: t.w.clients[1], amount: 10, rake: 1 });
    expect(t.sigs()).toEqual([]);
    expect(t.controller.state(GAME_TABLE).waiting).toBe('storage');
    t.alice.storage.modes.failSet = false; // storage works again: the kept request is answered
    await t.controller.handle(t.w.server.tableMessage());
    expect(t.sigs()).toHaveLength(1);
  });

  test('a reload mid-round: a new controller over the same storage answers with the identical signature', async () => {
    const t = setup();
    await t.controller.handle(t.epoch);
    const { tbl, req } = await hand(t, {
      winner: t.w.clients[0],
      loser: t.w.clients[1],
      amount: 10,
      rake: 1,
    });
    const before = t.sigs()[0];
    const again = [];
    const reloaded = createVaultController({
      storage: t.alice.storage,
      chainView: t.w.chain,
      send: (m) => again.push(m),
      locks: null,
      tabId: 'tab-a', // the same tab, reloaded: sessionStorage kept its identity
    });
    reloaded.setContext({ playerId: 'p-alice', tables: [summaryOf(t.w)] });
    await reloaded.handle(t.epoch); // the server re-sends the epoch, then the open request
    await reloaded.handle(tbl);
    await reloaded.handle(req);
    expect(again.filter((m) => m.t === CLIENT.SIGN)).toEqual([before]);
  });
});

describe('a hostile server gets no signature', () => {
  test('a second digest at a signed nonce: refused, and a lasting block shown', async () => {
    const t = setup();
    const { w, controller } = t;
    await controller.handle(t.epoch);
    const { state } = await hand(t, {
      winner: w.clients[0],
      loser: w.clients[1],
      amount: 10,
      rake: 1,
    });
    expect(t.sigs()).toHaveLength(1);
    await controller.handle(w.server.propose({ ...state, volume: state.volume + 1n }));
    expect(t.sigs()).toHaveLength(1);
    expect(controller.state(GAME_TABLE)).toMatchObject({
      refused: { rule: 'C1a' },
      failure: { kind: 'equivocation', blocking: true },
    });
  });

  test('my balance moved without a hand, a lying digest, an epoch for another table: nothing signed or pinned', async () => {
    const t = setup();
    const { w, alice, controller } = t;
    await controller.handle(t.epoch);
    await controller.handle(w.server.tableMessage());
    const moved = {
      ...w.server.head,
      nonce: w.server.head.nonce + 1n,
      balances: [...w.server.head.balances],
    };
    const i = w.server.roster.indexOf(alice);
    moved.balances[i] -= 100n * UNIT;
    moved.balances[(i + 1) % moved.balances.length] += 100n * UNIT;
    await controller.handle(w.server.propose(moved, { handNo: null }));
    expect(controller.state(GAME_TABLE).refused).toMatchObject({ rule: 'C1b' });
    const fair = { ...w.server.head, nonce: w.server.head.nonce + 1n };
    await controller.handle(
      w.server.propose(fair, { handNo: null, digest: `0x${'ab'.repeat(32)}` }),
    );
    expect(controller.state(GAME_TABLE).refused).toMatchObject({ rule: 'C1d' });
    expect(t.sigs()).toEqual([]);

    const other = setup({ seed: 4 });
    const foreign = {
      ...t.epoch,
      state: toWire({ ...w.server.genesis, tableId: other.w.tableKey }),
    };
    const fresh = setup({ seed: 3, start: false });
    await fresh.controller.handle(foreign);
    expect(fresh.controller.state(GAME_TABLE).epochProblem).toMatchObject({ rule: 'TABLE' });
  });

  test("the server's maxRakeBps can only make the check stricter", async () => {
    const t = setup();
    t.controller.setContext({ playerId: 'p-alice', tables: [summaryOf(t.w, { maxRakeBps: 1 })] });
    await t.controller.handle(t.epoch);
    await hand(t, { winner: t.w.clients[0], loser: t.w.clients[1], amount: 10, rake: 1 }); // 1 chip on 20: 500 bps
    expect(t.sigs()).toEqual([]);
    expect(t.controller.state(GAME_TABLE).refused).toMatchObject({ rule: 'C1e' });
    const loose = setup({ seed: 5 });
    loose.controller.setContext({
      playerId: 'p-alice',
      tables: [summaryOf(loose.w, { maxRakeBps: 10_000 })],
    });
    await loose.controller.handle(loose.epoch);
    // 3 chips on a 20-chip pot is 1500 bps: above the contract's 500 whatever the server says. The epoch was
    // still pinned (the server's figure is not used, so it cannot break the check either): the refusal is C1e
    await hand(loose, {
      winner: loose.w.clients[0],
      loser: loose.w.clients[1],
      amount: 10,
      rake: 3,
    });
    expect(loose.sigs()).toEqual([]);
    expect(loose.controller.state(GAME_TABLE)).toMatchObject({
      epoch: 1,
      epochProblem: null,
      refused: { rule: 'C1e' },
    });
  });
});

describe('keys, storage, tabs and the chain view', () => {
  test('no key on this device (wiped storage): no claim, no signature, and no key is ever made', async () => {
    const t = setup();
    const empty = memoryStorage();
    const sent = [];
    const controller = createVaultController({
      storage: empty,
      chainView: t.w.chain,
      send: (m) => sent.push(m),
      locks: null,
    });
    controller.setContext({ playerId: 'p-alice', tables: [summaryOf(t.w)] });
    expect(controller.claimAll()).toBe(0);
    await controller.handle(t.epoch);
    const { state } = t.w.server.hand({
      winner: t.w.clients[0],
      loser: t.w.clients[1],
      amount: 10,
      rake: 0,
    });
    await controller.handle(t.w.server.propose(state));
    expect(sent).toEqual([]);
    expect(controller.state(GAME_TABLE)).toMatchObject({
      hasKey: false,
      epochProblem: { rule: 'NO-KEY' },
    });
    expect(empty.calls.filter(([name]) => name !== 'getItem')).toEqual([]);
  });

  test('no server message deletes anything', async () => {
    const t = setup();
    await t.controller.handle(t.epoch);
    await hand(t, { winner: t.w.clients[0], loser: t.w.clients[1], amount: 10, rake: 1 });
    for (const message of [
      { t: SERVER.UNSEATED, tableId: GAME_TABLE, reason: 'settled', chips: 0 },
      { t: SERVER.ERROR, code: 'vault-locked' },
      { t: SERVER.WELCOME, player: { id: 'x', name: 'x', balance: 0 }, tables: [], seated: null },
      t.epoch,
    ]) {
      await t.controller.handle(message);
    }
    expect(t.alice.storage.calls.filter(([name]) => name === 'removeItem')).toEqual([]);
    expect(storedRecord(t.alice.storage, t.w.tableKey).sessionKey).toBe(t.alice.sessionKey);
  });

  test('two tabs: only the one holding the Web Lock signs', async () => {
    const t = setup();
    const held = new Set();
    const locks = {
      request(name, _options, callback) {
        if (held.has(name)) return Promise.resolve(callback(null));
        held.add(name);
        return Promise.resolve(callback({ name }));
      },
    };
    const make = () => {
      const sent = [];
      const c = createVaultController({
        storage: t.alice.storage,
        chainView: t.w.chain,
        send: (m) => sent.push(m),
        locks,
      });
      c.setContext({ playerId: 'p-alice', tables: [summaryOf(t.w)] });
      return { c, sent };
    };
    const one = make();
    const two = make();
    const { tbl, state } = t.w.server.hand({
      winner: t.w.clients[0],
      loser: t.w.clients[1],
      amount: 10,
      rake: 1,
    });
    const req = t.w.server.propose(state);
    for (const tab of [one, two]) {
      await tab.c.handle(t.epoch);
      await tab.c.handle(tbl);
      await tab.c.handle(req);
    }
    expect(one.sent.filter((m) => m.t === CLIENT.SIGN)).toHaveLength(1);
    expect(two.sent).toEqual([]);
    expect(two.c.state(GAME_TABLE).waiting).toBe('other-tab');
    one.c.close();
  });

  test('without Web Locks a storage lease decides, and it expires', async () => {
    const t = setup();
    let clock = 1_000;
    const make = (tabId) => {
      const sent = [];
      const c = createVaultController({
        storage: t.alice.storage,
        chainView: t.w.chain,
        send: (m) => sent.push(m),
        locks: null,
        tabId,
        now: () => clock,
        leaseMs: 10_000,
      });
      c.setContext({ playerId: 'p-alice', tables: [summaryOf(t.w)] });
      return { c, sent };
    };
    const one = make('one');
    const two = make('two');
    const { tbl, state } = t.w.server.hand({
      winner: t.w.clients[0],
      loser: t.w.clients[1],
      amount: 10,
      rake: 1,
    });
    const req = t.w.server.propose(state);
    await one.c.handle(t.epoch);
    await one.c.handle(tbl);
    await one.c.handle(req);
    await two.c.handle(t.epoch);
    await two.c.handle(tbl);
    await two.c.handle(req);
    expect(two.sent).toEqual([]);
    clock += 10_001; // the first tab went quiet: its lease runs out
    await two.c.handle(req);
    expect(two.sent.filter((m) => m.t === CLIENT.SIGN)).toEqual(
      one.sent.filter((m) => m.t === CLIENT.SIGN),
    );
  });

  test('no chain view: epochs are refused unless the build allows unpinned (then a lasting warning)', async () => {
    const t = setup({ controller: { chainView: null } });
    await t.controller.handle(t.epoch);
    expect(t.controller.state(GAME_TABLE)).toMatchObject({
      noChainView: true,
      epochProblem: { rule: 'UNPINNED' },
    });
    const dev = setup({ seed: 6, controller: { chainView: null, allowUnpinned: true } });
    await dev.controller.handle(dev.epoch);
    expect(dev.controller.state(GAME_TABLE)).toMatchObject({
      noChainView: false,
      unpinned: true,
      epochProblem: null,
    });
  });

  test('a chain view that never answers times out instead of hanging the table', async () => {
    const hang = { table: () => new Promise(() => {}), seat: () => new Promise(() => {}) };
    const timed = withTimeout(hang, { ms: 5 });
    expect(await timed.table('0x')).toEqual({ ok: false, error: 'timeout' });
    const t = setup({ controller: { chainView: hang, timeoutMs: 5 } });
    await t.controller.handle(t.epoch);
    expect(t.controller.state(GAME_TABLE).epochProblem).toMatchObject({ rule: 'CHAIN-READ' });
    const broken = withTimeout({
      table: async () => {
        throw new Error('boom');
      },
      seat: async () => ({ ok: true, seat: null }),
    });
    expect(await broken.table('0x')).toEqual({ ok: false, error: 'boom' });
  });

  test('persist() is asked for once, when the first claim goes out', () => {
    let asked = 0;
    const t = setup({
      controller: {
        persist: () => {
          asked += 1;
        },
      },
    });
    t.controller.claimAll();
    t.controller.claimAll();
    expect(asked).toBe(1);
  });
});
