// The TableActor in vault mode, driven for real: a TableActor with the real engine, the VaultCoordinator and
// runtime built by createVaultSetup, a FakeChain, a MemoryStore and a FakeClock. The players are the
// harness's simulated browsers (they check every epoch against the chain, judge every signreq against the
// public stacks they saw, and sign); their messages travel through a bus that behaves like the Hub's.
// The last test goes through createGame and real WebSockets, to show the Hub routes claim and sig.
import { afterEach, describe, expect, test } from 'bun:test';
import { ServerMessage } from '@pgg/protocol';
import { CLIENT, ERR, SERVER } from '@pgg/protocol/constants';
import { fromWire, hashState, privateKeyToAddress, signClaim, signDigest } from '@pgg/vault';
import { loadConfig } from '../../src/config.js';
import { Registry } from '../../src/registry.js';
import { createGame } from '../../src/server.js';
import { realClock, TableActor } from '../../src/table-actor.js';
import { createVaultSetup } from '../../src/vault/boot.js';
import { FakeChain } from '../../src/vault/fake-chain.js';
import { MemoryStore } from '../../src/vault/memory-store.js';
import { NullWallet } from '../../src/vault/null-wallet.js';
import { POLICY_DEFAULTS, TABLE_DEFAULTS } from '../../src/vault/vault-config.js';
import { Bot, until } from '../bot.js';
import { CFG, FakeBus, player, setup as playSetup } from '../helpers.js';
import { addressFor, keyFor, makeVaultWorld, UNIT } from './harness.js';

const quiet = { warn() {} };
const TIMING = { turnMs: 1000, interHandMs: 100, sitoutGraceMs: 5000 };

// A bus like the Hub's: published table states reach every seated, connected client (they are what a
// client judges a signreq against, F8), and private vault messages reach that player's client only.
class ClientBus extends FakeBus {
  constructor(world) {
    super();
    this.world = world;
  }

  publish(topic, msg) {
    super.publish(topic, msg);
    if (msg.t !== SERVER.TABLE) return;
    for (const seat of msg.state.seats) {
      const p = seat && this.world.players.find((x) => x.wallet === seat.address);
      if (p) p.chips = seat.chips;
    }
    for (const event of msg.events) {
      if (event.type !== 'hand-end') continue;
      for (const p of this.world.players) {
        if (!p.atTable) continue;
        if (p.connected) {
          p.client.watched.rake += event.result.rake;
          p.client.watched.pot += event.result.pot;
        } else {
          p.client.watched.missed = true;
        }
      }
    }
  }

  send(playerId, msg) {
    super.send(playerId, msg);
    const p = this.world.players.find((x) => x.playerId === playerId);
    if (!p?.connected) return;
    if (msg.t === SERVER.UNSEATED) p.atTable = false;
    if ([SERVER.EPOCH, SERVER.SIGN_REQ, SERVER.BUNDLE].includes(msg.t)) {
      p.client.inbox.push(JSON.parse(JSON.stringify(msg)));
    }
  }
}

async function makeTable({ names = ['alice', 'bob', 'carol'], policy = {} } = {}) {
  const world = makeVaultWorld({ names, policy });
  const cfg = { ...world.cfg, name: 'Vault 1', rakeCap: 30 };
  const vault = await createVaultSetup(
    {
      enabled: true,
      chainId: 31337,
      arbiterKey: world.arbiterKey,
      policy: cfg.policy,
      tables: [cfg],
    },
    { clock: world.clock, chain: world.chain, store: world.store, log: quiet },
  );
  const bus = new ClientBus(world);
  const seats = new Map(); // what the registry would hold: playerId -> tableId
  const coordinator = vault.runtime.coordinator(cfg.id);
  const actor = new TableActor({
    cfg: { ...cfg, ...TIMING },
    bus,
    wallet: new NullWallet(),
    clock: world.clock,
    onSeat: (playerId, tableId) => {
      if (tableId === null) seats.delete(playerId);
      else seats.set(playerId, tableId);
    },
    vault: coordinator,
    vaultInfo: vault.info,
  });
  vault.runtime.attachHost(cfg.id, actor.vaultHost);
  // the clients' signatures go through the actor, as the Hub sends them
  world.coordinator = {
    get tableKey() {
      return coordinator.tableKey;
    },
    sign: (playerId, msg) => actor.vaultSign({ id: playerId }, msg),
  };
  vault.runtime.start();
  world.chainTick(); // createTable

  const t = {
    world,
    cfg,
    vault,
    bus,
    actor,
    coordinator,
    seats,
    clock: world.clock,
    get state() {
      return bus.state;
    },
    get tableKey() {
      return coordinator.tableKey;
    },
    advance(ms) {
      world.clock.advance(ms);
      world.pump();
    },
    claim(p) {
      const result = actor.claim(
        { id: p.playerId, name: p.name },
        { tableId: cfg.id, address: p.wallet, sig: world.claimSig(p) },
      );
      if (result.ok) p.atTable = true;
      world.pump();
      return result;
    },
    /** Deposits, claims, the hold, start: an Active epoch with the deal gate open. */
    activate(chips = 500) {
      for (const p of world.players) world.deposit(p, chips);
      world.chainTick();
      for (const p of world.players) expect(t.claim(p)).toMatchObject({ ok: true });
      t.startEpoch();
    },
    startEpoch() {
      t.advance(cfg.policy.startHoldMs + cfg.policy.tickMs);
      world.chainTick(); // start -> Started: the epoch is active and the deal gate open
    },
    /** Deal the next hand if the gate lets it: true when a hand is now in progress. */
    deal() {
      t.advance(TIMING.interHandMs);
      return bus.state.inHand;
    },
    /** Play the hand in progress to its end: check or call; an absent player's turn runs out. */
    finishHand() {
      for (let guard = 0; bus.state.inHand; guard++) {
        expect(guard).toBeLessThan(200);
        const s = bus.state;
        const who = s.seats[s.toAct];
        const p = world.players.find((x) => x.playerId === who.playerId);
        if (!p.connected) {
          world.clock.advance(TIMING.turnMs);
          continue;
        }
        const action = s.legal.actions.includes('check') ? 'check' : 'call';
        expect(actor.act(who.playerId, { handNo: s.handNo, action })).toMatchObject({ ok: true });
      }
      world.pump();
    },
    bundle() {
      return world.store.loadBundle(coordinator.tableKey);
    },
  };
  return t;
}

function noRefusals(world) {
  for (const p of world.players) expect(p.client.refusals).toEqual([]);
  expect(world.violations).toEqual([]);
}

/** The newest bundle carries exactly the stacks the table shows (no dust here), and nothing was created. */
function expectStacksSigned(t) {
  const { state } = t.bundle();
  for (const seat of t.state.seats.filter(Boolean)) {
    const i = state.players.indexOf(seat.address);
    expect(state.balances[i]).toBe(BigInt(seat.chips) * UNIT);
  }
  const total = state.balances.reduce((a, b) => a + b, 0n) + state.rake;
  expect(total).toBe(
    t.world.chain.table(t.tableKey).escrow + t.world.chain.table(t.tableKey).rakePaid,
  );
}

describe('TableActor in vault mode', () => {
  test('claims seat the members, the epoch starts on chain, and every hand is signed by everyone before the next deal', async () => {
    const t = await makeTable();
    const { world } = t;
    const [alice, bob, carol] = world.players;
    for (const p of world.players) world.deposit(p, 500);
    world.chainTick();
    for (const p of world.players) expect(t.claim(p)).toEqual({ ok: true, seat: p.seat });

    // seated as members: the public state names each seat's address, and the lobby shows the vault
    expect(t.state.seats.slice(0, 3)).toMatchObject(
      world.players.map((p) => ({ playerId: p.playerId, address: p.wallet, chips: 500 })),
    );
    expect(t.state.vault).toMatchObject({ epoch: 0, phase: 'filling' });
    expect(t.actor.summary().vault).toEqual({
      chainId: 31337,
      vault: world.chain.info.vault,
      tableKey: t.tableKey,
      chipUnit: String(UNIT),
      maxRakeBps: 500,
      exitWindowSec: 3600,
      arbiter: world.arbiter,
    });
    expect([...t.seats.keys()]).toEqual([alice.playerId, bob.playerId, carol.playerId]);
    expect(t.deal()).toBe(false); // filling: nothing is dealt before the epoch is Active

    t.startEpoch();
    expect(world.chain.table(t.tableKey)).toMatchObject({ status: 'Active' });
    expect(t.state.vault).toMatchObject({ epoch: 1, phase: 'active', awaiting: [] });
    for (const p of world.players) expect(p.client.epoch?.number).toBe(1);

    // two hands, each signed by all three before the next one is dealt
    for (let hand = 1; hand <= 2; hand++) {
      expect(t.deal()).toBe(true);
      expect(t.state.handNo).toBe(hand);
      t.finishHand();
      expect(t.bundle().state.nonce).toBe(BigInt(hand));
      for (const p of world.players) expect(p.client.newestBundle.state.nonce).toBe(BigInt(hand));
      expectStacksSigned(t);
    }

    // carol holds her signature: the round stays open and the gate holds, however long we wait
    carol.client.mode = 'manual';
    expect(t.deal()).toBe(true);
    t.finishHand();
    expect(carol.client.held).toHaveLength(1);
    expect(t.state.vault).toMatchObject({ awaiting: [carol.seat], nonce: '3' });
    t.advance(TIMING.interHandMs * 50);
    expect(t.state).toMatchObject({ inHand: false, handNo: 3 });
    expect(t.coordinator.canDeal()).toBe(false);
    expect(t.bundle().state.nonce).toBe(2n);

    // her signature closes the round; the next hand follows
    carol.client.mode = 'auto';
    world.signHeld(carol);
    expect(t.bundle().state.nonce).toBe(3n);
    expect(t.deal()).toBe(true);
    expect(t.state.handNo).toBe(4);
    t.finishHand();
    expect(t.bundle().state.nonce).toBe(4n);
    expectStacksSigned(t);

    // every message the actor sent matches the protocol (TableState.vault, seat addresses, epoch, ...)
    const everything = [...t.bus.published.map((e) => e.msg), ...[...t.bus.sent.values()].flat()];
    for (const msg of everything) expect(ServerMessage.safeParse(msg).success).toBe(true);
    noRefusals(world);
  });

  test('a leave becomes a final; the settle unseats the leaver with the payout and the stayers play the next epoch', async () => {
    const t = await makeTable();
    const { world } = t;
    const [alice, bob, carol] = world.players;
    t.activate();
    for (let hand = 1; hand <= 3; hand++) {
      expect(t.deal()).toBe(true);
      t.finishHand();
    }
    const before = t.bundle().state;
    expect(before.nonce).toBe(3n);
    const aliceChips = alice.chips;

    // between hands: the leave is a standalone final with the balances unchanged
    alice.client.intent = 'leave';
    alice.client.leaveAckNonce = before.nonce;
    expect(t.actor.leave(alice.playerId)).toEqual({ ok: true, head: '3' });
    world.pump();
    expect(t.state.seats[alice.seat]).toMatchObject({ status: 'sitout', chips: aliceChips });
    const final = t.bundle().state;
    expect(final).toMatchObject({ nonce: 4n, isFinal: true, balances: before.balances });
    expect(final.keep[final.players.indexOf(alice.wallet)]).toBe(false);
    expect(t.deal()).toBe(false); // nothing more is dealt in this epoch
    // the chips have not left yet: only the settle on chain moves them
    expect(t.bus.messagesTo(alice.playerId, SERVER.UNSEATED)).toEqual([]);

    world.chainTick(); // settle -> Settled
    t.advance(t.cfg.policy.tickMs);
    expect(world.chain.table(t.tableKey)).toMatchObject({ status: 'Filling', nonce: 4n });
    expect(t.bus.messagesTo(alice.playerId, SERVER.UNSEATED)).toEqual([
      { t: SERVER.UNSEATED, tableId: t.cfg.id, reason: 'settled', chips: aliceChips },
    ]);
    expect(world.chain.balances.of(alice.wallet)).toBe(BigInt(aliceChips) * UNIT);
    expect(t.state.seats[alice.seat]).toBeNull();
    expect(t.seats.has(alice.playerId)).toBe(false);
    expect(t.bus.messagesTo(alice.playerId, SERVER.BALANCE)).toEqual([]); // play money is not touched

    // epoch 2 with the stayers, at the final's nonce, and play goes on
    t.startEpoch();
    expect(t.state.vault).toMatchObject({ epoch: 2, phase: 'active', nonce: '4' });
    for (const p of [bob, carol]) expect(p.client.epoch.number).toBe(2);
    expect(t.deal()).toBe(true);
    t.finishHand();
    expect(t.bundle().state).toMatchObject({
      nonce: 5n,
      isFinal: false,
      players: [bob.wallet, carol.wallet].sort(),
    });
    expectStacksSigned(t);
    noRefusals(world);
  });

  test('a member who drops mid-hand gets the open signreq again on reconnect, and the table goes on', async () => {
    const t = await makeTable();
    const { world } = t;
    const carol = world.player('carol');
    t.activate();
    expect(t.deal()).toBe(true);
    t.finishHand();

    // carol's socket closes during hand 2: her turns run out and her signreq goes nowhere
    expect(t.deal()).toBe(true);
    carol.connected = false;
    t.actor.disconnect(carol.playerId);
    t.finishHand();
    expect(t.bundle().state.nonce).toBe(1n);
    t.advance(TIMING.sitoutGraceMs + TIMING.interHandMs * 10);
    expect(t.state).toMatchObject({ inHand: false, handNo: 2 });
    expect(t.state.seats[carol.seat]).toMatchObject({ connected: false, address: carol.wallet });
    expect(t.state.vault.awaiting).toEqual([carol.seat]);

    // back: the table state first, then the epoch, the newest bundle and the open signreq
    carol.connected = true;
    t.actor.connect(carol.playerId);
    const sent = t.bus.sent.get(carol.playerId).map((m) => m.t);
    expect(sent.slice(sent.lastIndexOf(SERVER.SEATED))).toEqual([
      SERVER.SEATED,
      SERVER.TABLE,
      SERVER.EPOCH,
      SERVER.BUNDLE,
      SERVER.SIGN_REQ,
    ]);
    world.pump();
    expect(t.bundle().state.nonce).toBe(2n);
    expect(t.deal()).toBe(true);
    expect(t.state.handNo).toBe(3);
    t.finishHand();
    expect(t.bundle().state.nonce).toBe(3n);
    expectStacksSigned(t);
    noRefusals(world);
  });

  test('a top-up after the claim: the stacks follow the epoch genesis, so the first hand still adds up', async () => {
    const t = await makeTable();
    const { world } = t;
    const alice = world.player('alice');
    for (const p of world.players) world.deposit(p, 500);
    world.chainTick();
    for (const p of world.players) expect(t.claim(p)).toMatchObject({ ok: true });
    world.deposit(alice, 100); // allowed while the table is filling
    world.chainTick();
    expect(t.state.seats[alice.seat].chips).toBe(500); // the claim saw the first deposit only
    t.startEpoch();
    expect(t.state.seats[alice.seat].chips).toBe(600);
    expect(t.deal()).toBe(true);
    t.finishHand();
    expect(t.bundle().state.nonce).toBe(1n);
    expect(t.coordinator.halt).toBeNull();
    expectStacksSigned(t);
    noRefusals(world);
  });

  test('join and rebuy are refused with vault-locked; a claim the coordinator refuses seats nobody', async () => {
    const t = await makeTable();
    const { world } = t;
    const [alice, bob] = world.players;
    world.deposit(alice, 500);
    world.chainTick();
    expect(t.actor.join(player(9), { buyIn: 500 })).toMatchObject({
      ok: false,
      code: ERR.VAULT_LOCKED,
    });
    // bob has no deposit (between epochs: retryable, it may not be read yet), and alice's claim signed
    // with bob's key is not hers
    expect(t.claim(bob)).toMatchObject({ ok: false, code: ERR.CLAIM_PENDING });
    const forged = t.actor.claim(
      { id: alice.playerId, name: alice.name },
      {
        tableId: t.cfg.id,
        address: alice.wallet,
        sig: world.claimSig(alice, alice.playerId, bob.sessionKey),
      },
    );
    expect(forged).toMatchObject({ ok: false, code: ERR.BAD_CLAIM });
    expect(t.state?.seats.every((s) => s === null) ?? true).toBe(true);
    expect(t.claim(alice)).toMatchObject({ ok: true });
    expect(t.actor.rebuy(alice.playerId, 100)).toMatchObject({ ok: false, code: ERR.VAULT_LOCKED });
    expect(t.actor.chipsOnTable()).toBe(500);
  });
});

describe('play-money tables', () => {
  test('have no vault: no vault fields, claim and sig refused, and the registry counts their chips', () => {
    const env = playSetup();
    const actor = new TableActor({
      cfg: env.cfg,
      bus: env.bus,
      wallet: env.wallet,
      clock: env.clock,
    });
    expect(actor.isVault).toBe(false);
    expect(actor.vaultHost).toBeNull();
    env.wallet.open('p1');
    env.wallet.open('p2');
    actor.join(player(1), { buyIn: 300 });
    actor.join(player(2), { buyIn: 300 });
    env.clock.advance(CFG.interHandMs);
    expect(env.bus.state.inHand).toBe(true);
    expect(env.bus.state).not.toHaveProperty('vault');
    for (const seat of env.bus.state.seats.filter(Boolean))
      expect(seat).not.toHaveProperty('address');
    expect(actor.summary()).not.toHaveProperty('vault');
    expect(actor.claim(player(1), {})).toMatchObject({ code: ERR.NOT_VAULT_TABLE });
    expect(actor.vaultSign(player(1), {})).toMatchObject({ code: ERR.NOT_VAULT_TABLE });

    const vaultActor = { id: 'v', isVault: true, chipsOnTable: () => 1_000_000, destroy() {} };
    const registry = new Registry();
    registry.add(actor);
    registry.add(vaultActor);
    expect(registry.chipsOnTables()).toBe(600); // escrowed chips are not play money
  });
});

describe('createGame with a vault table', () => {
  let game = null;
  let poll = null;
  const bots = [];
  afterEach(() => {
    for (const bot of bots.splice(0)) bot.close();
    if (poll) clearInterval(poll);
    game?.stop();
    game = null;
  });

  test('the Hub routes claim and sig to the vault actor over real WebSockets', async () => {
    const arbiterKey = keyFor('ws-arbiter');
    const chain = new FakeChain({
      arbiter: privateKeyToAddress(arbiterKey),
      relayer: addressFor('ws-relayer'),
      autoMint: true,
    });
    const policy = { ...POLICY_DEFAULTS, startHoldMs: 0, tickMs: 20, rereadMs: 500 };
    const tables = [
      {
        id: 'vault-1',
        name: 'Vault 1',
        serverId: 'ws-vault-1',
        ...TABLE_DEFAULTS,
        rakeCap: 30,
        policy,
      },
    ];
    const vault = await createVaultSetup(
      { enabled: true, chainId: 31337, arbiterKey, policy, tables },
      { clock: realClock, chain, store: new MemoryStore(), log: quiet },
    );
    game = createGame(
      loadConfig({
        PORT: '0',
        HOST: '127.0.0.1',
        PGG_SECRET: 'vault-ws',
        TURN_MS: '3000',
        INTER_HAND_MS: '20',
        SITOUT_GRACE_MS: '2000',
        RATE_CAPACITY: '400',
        RATE_REFILL: '400',
      }),
      { vault },
    );
    poll = setInterval(() => chain.tick(), 10); // the chain's poll
    const coordinator = vault.runtime.coordinator('vault-1');
    await until(() => coordinator.phase === 'filling', { what: 'the table on chain' });

    const { tables: lobby } = await (await fetch(`${game.url}/api/tables`)).json();
    expect(lobby.find((x) => x.id === 'vault-1').vault.tableKey).toBe(coordinator.tableKey);
    const domain = { chainId: chain.info.chainId, verifyingContract: chain.info.vault };

    for (const name of ['ann', 'ben']) {
      const bot = new Bot({ httpUrl: game.url, wsUrl: game.wsUrl, name });
      const sessionKey = keyFor(`ws-session:${name}`);
      bot.wallet = addressFor(`ws-wallet:${name}`);
      bot.bundles = [];
      // a trusting signer: enough to prove the routing (the real client rules are tested elsewhere)
      bot.onMessageHook = (msg) => {
        if (msg.t === SERVER.BUNDLE) bot.bundles.push(BigInt(msg.state.nonce));
        if (msg.t !== SERVER.SIGN_REQ) return;
        expect(hashState(fromWire(msg.state), domain)).toBe(msg.digest);
        bot.send({
          t: CLIENT.SIGN,
          nonce: msg.state.nonce,
          digest: msg.digest,
          sig: signDigest(sessionKey, msg.digest),
        });
      };
      await bot.login();
      await bot.connect();
      bots.push(bot);
      chain.deposit(coordinator.tableKey, bot.wallet, 500n * UNIT, privateKeyToAddress(sessionKey));
      await until(() => chain.seat(coordinator.tableKey, bot.wallet) !== null, { what: 'deposit' });

      bot.join('vault-1', 500);
      await until(() => bot.errors.length > 0, { what: 'join refused' });
      expect(bot.errors[0]).toMatchObject({ code: ERR.VAULT_LOCKED, ref: 'join' });

      const sig = signClaim(sessionKey, {
        domain,
        tableKey: coordinator.tableKey,
        address: bot.wallet,
        playerId: bot.id,
      });
      bot.send({ t: CLIENT.CLAIM, tableId: 'vault-1', address: bot.wallet, sig });
      await until(() => bot.tableId === 'vault-1', { what: `${name} seated` });
      bot.autoplay = true;
    }

    // the epoch starts, hands are played, and the signatures that came in over the sockets made bundles
    await until(() => bots.every((bot) => bot.bundles.some((n) => n >= 2n)), {
      what: 'two signed hands',
      timeout: 15_000,
    });
    expect(game.registry.tableOf(bots[0].id)?.id).toBe('vault-1');
    for (const bot of bots) {
      expect(bot.invalid).toEqual([]);
      expect(bot.errors.filter((e) => e.ref !== 'join' && e.ref !== 'act')).toEqual([]);
      expect(bot.state.vault.phase).toBe('active');
      expect(bot.state.seats[bot.seat].address).toBe(bot.wallet);
    }
  }, 30_000);
});
