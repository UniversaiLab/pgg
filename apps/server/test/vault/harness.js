// A reusable world for the coordinator, the later TableActor integration tests and the simulation: a
// FakeChain, a MemoryStore, a FakeClock, the real LocalKeySigner and JobResolver, a fake host that records
// what the coordinator asks of the actor, and one simulated CLIENT per player that does what a browser does
// with @pgg/vault: checks the epoch against the chain (F1), judges every signreq with clientShouldSign against
// its OWN view (the public chips it saw, F8), writes its {nonce, digest, sig} record before it sends, and keeps
// the newest bundle only when every signature verifies. Keys come from names, so every run is the same run.
//
// Messages never re-enter the coordinator from inside a call: host.send only drops them in the client's
// inbox, and pump() delivers them afterwards, as sockets do.
import { SERVER } from '@pgg/protocol/constants';
import {
  bundleFromWire,
  chainShowsSettled,
  clientShouldSign,
  decideSign,
  fromWire,
  hashState,
  isNewer,
  keccak256,
  privateKeyToAddress,
  signClaim,
  signDigest,
  toChips,
  toHex,
  verifyBundle,
  verifyEpochAgainstChain,
} from '@pgg/vault';
import { VaultCoordinator } from '../../src/vault/coordinator.js';
import { expectOk, FakeChain } from '../../src/vault/fake-chain.js';
import { JobResolver } from '../../src/vault/job-resolver.js';
import { MemoryStore } from '../../src/vault/memory-store.js';
import { LocalKeySigner } from '../../src/vault/signer.js';
import { POLICY_DEFAULTS } from '../../src/vault/vault-config.js';
import { FakeClock } from '../helpers.js';

export const UNIT = 10_000n; // token base units per chip

export const keyFor = (name) => toHex(keccak256(new TextEncoder().encode(`pgg-coord-b:${name}`)));
export const addressFor = (name) => privateKeyToAddress(keyFor(name));

/** Records everything the coordinator asks of the actor. Messages are cloned as if they crossed the wire. */
export class FakeHost {
  sent = []; // { playerId, msg }
  unseats = [];
  rekeys = [];
  publishes = 0;
  starts = 0;
  inHandFlag = false;
  seats = new Map(); // address -> seat number
  onSend = null;
  onUnseat = null;

  send(playerId, msg) {
    const copy = JSON.parse(JSON.stringify(msg));
    this.sent.push({ playerId, msg: copy });
    this.onSend?.(playerId, copy);
  }

  publishStatus() {
    this.publishes += 1;
  }

  unseat(address, info) {
    this.unseats.push({ address, ...info });
    this.onUnseat?.(address, info);
  }

  scheduleStart() {
    this.starts += 1;
  }

  rekey(oldId, newId, address) {
    this.rekeys.push({ oldId, newId, address });
  }

  inHand() {
    return this.inHandFlag;
  }

  seatOf(address) {
    return this.seats.get(address) ?? null;
  }

  messagesTo(playerId, type) {
    return this.sent
      .filter((s) => s.playerId === playerId && (type === undefined || s.msg.t === type))
      .map((s) => s.msg);
  }

  ofType(type) {
    return this.sent.filter((s) => s.msg.t === type);
  }
}

/**
 * A browser. `mode`: 'auto' signs as soon as a signreq arrives, 'manual' keeps signreqs in `held` until
 * signHeld(), 'refuse' never signs. `records` is its durable storage (it survives server restarts).
 */
export class SimClient {
  mode = 'auto';
  inbox = [];
  held = [];
  refusals = [];
  signedLog = []; // { nonce, digest } in the order this client signed
  epoch = null; // { number, domain, state, sessionKeys, arbiter }
  baseline = null; // newest all-signed non-final state of the epoch, or the genesis
  last = null; // durable record: { nonce, digest, isFinal, state }
  newestBundle = null;
  finalSigned = null; // the final State this client signed, until the chain shows it settled
  watched = { rake: 0, pot: 0, missed: false }; // hands seen since the base state
  intent = 'play';
  leaveAckNonce = null;
  expectedBalance = null; // what this client's own records say its balance is (deposit or kept final)

  constructor(player) {
    this.player = player;
  }

  reset() {
    this.epoch = null;
    this.baseline = null;
    this.last = null;
    this.newestBundle = null;
    this.watched = { rake: 0, pot: 0, missed: false };
  }
}

const cloneState = (s) => ({
  ...s,
  players: [...s.players],
  balances: [...s.balances],
  keep: [...s.keep],
});

export function makeVaultWorld({
  names = ['alice', 'bob', 'carol'],
  policy = {},
  cfg: cfgOverrides = {},
  chainOptions = {},
} = {}) {
  const clock = new FakeClock();
  const arbiterKey = keyFor('arbiter');
  const arbiter = privateKeyToAddress(arbiterKey);
  const relayer = addressFor('relayer');
  const chain = new FakeChain({ arbiter, relayer, autoMint: true, ...chainOptions });
  const domain = { chainId: chain.info.chainId, verifyingContract: chain.info.vault };
  const cfg = {
    id: 'vault-1',
    serverId: 'coord-b',
    numSeats: 6,
    chipUnit: UNIT,
    rakeBps: 200,
    smallBlind: 5,
    bigBlind: 10,
    minBuyIn: 100,
    maxBuyIn: 5000,
    ...cfgOverrides,
    policy: { ...POLICY_DEFAULTS, ...policy },
  };

  const players = names.map((name, seat) => {
    const sessionKey = keyFor(`session:${name}`);
    const player = {
      name,
      wallet: addressFor(`wallet:${name}`),
      sessionKey,
      session: privateKeyToAddress(sessionKey),
      playerId: `p-${name}`,
      seat,
      chips: 0, // the public stack the actor shows
      connected: true,
      status: 'seated',
      leaving: false,
      atTable: false, // a roster member of the current epoch (or a depositor in filling)
    };
    player.client = new SimClient(player);
    return player;
  });
  const byWallet = new Map(players.map((p) => [p.wallet, p]));

  const host = new FakeHost();
  for (const p of players) host.seats.set(p.wallet, p.seat);

  const world = {
    clock,
    chain,
    domain,
    arbiter,
    arbiterKey,
    cfg,
    players,
    host,
    store: new MemoryStore(),
    coordinator: null,
    unsubscribe: null,
    handNo: 0,
    /** Every signreq ever seen by any client: nonce -> Set of digests (one digest per nonce, always). */
    digestsByNonce: new Map(),
    proposals: [], // { nonce, digest, state } in the order they were first seen
    bundles: [], // verified bundles in the order they were first seen
    violations: [], // invariant breaks noticed by the world itself

    player(name) {
      return players.find((p) => p.name === name);
    },

    get tableKey() {
      return world.coordinator.tableKey;
    },

    signerFor(store) {
      return new LocalKeySigner({
        privateKey: arbiterKey,
        reserved: (tableKey, nonce) => store.getSigned(tableKey, nonce)?.digest ?? null,
      });
    },

    /** A fresh coordinator on `store` (a restart when one already ran), subscribed and initialised. */
    boot({ store = world.store, signer, init = true } = {}) {
      world.unsubscribe?.();
      chain.resolver = new JobResolver({
        store,
        chain,
        challengeMarginSec: cfg.policy.challengeMarginSec,
      });
      world.coordinator = new VaultCoordinator({
        cfg,
        store,
        chain,
        signer: signer ?? world.signerFor(store),
        clock,
        host,
      });
      const coordinator = world.coordinator;
      world.unsubscribe = chain.subscribe((event) => coordinator.onChainEvent(event));
      if (init) coordinator.init();
      world.pump();
      return coordinator;
    },

    /** The server process dies here and a new one starts on the same store (and chain). */
    restart(options = {}) {
      return world.boot(options);
    },

    // ---- time and the chain ----------------------------------------------------------------------

    /** Move the clock (timers fire) and tick the coordinator. */
    tick(ms = 0) {
      clock.advance(ms);
      world.coordinator.tick();
      world.pump();
    },

    /** One chain poll: run queued jobs, refresh the view, deliver events; then let messages flow. */
    chainTick() {
      const result = chain.tick();
      world.pump();
      return result;
    },

    /** Let coordinator and chain go back and forth until nothing is queued (bounded). */
    settle(rounds = 6) {
      for (let i = 0; i < rounds; i++) {
        world.coordinator.tick();
        world.pump();
        if (chain.queued.length === 0) break;
        world.chainTick();
      }
    },

    advanceChain(seconds) {
      chain.advanceTime(seconds);
      world.chainTick();
    },

    // ---- players --------------------------------------------------------------------------------

    deposit(player, chips, { dust = 0n, confirmed = true } = {}) {
      const amount = BigInt(chips) * UNIT + dust;
      expectOk(
        chain.deposit(world.tableKey, player.wallet, amount, player.session, { confirmed }),
        `deposit ${player.name}`,
      );
      player.client.expectedBalance = (player.client.expectedBalance ?? 0n) + amount;
      return amount;
    },

    claimSig(player, playerId = player.playerId, key = player.sessionKey) {
      return signClaim(key, {
        domain,
        tableKey: world.tableKey,
        address: player.wallet,
        playerId,
      });
    },

    claim(player, { playerId = player.playerId, sig } = {}) {
      const result = world.coordinator.claim(playerId, {
        address: player.wallet,
        sig: sig ?? world.claimSig(player, playerId),
      });
      if (result.ok) {
        player.playerId = playerId;
        player.chips = result.chips;
        player.atTable = true;
        player.connected = true;
      }
      world.pump();
      return result;
    },

    connect(player) {
      player.connected = true;
      world.coordinator.onConnect(player.playerId);
      world.pump();
    },

    disconnect(player) {
      player.connected = false;
      world.coordinator.onDisconnect(player.playerId);
      world.pump();
    },

    /** Players who are members of the table as the actor sees it. */
    get seated() {
      return players.filter((p) => p.atTable);
    },

    /**
     * createTable, deposits (chips each, optional dust per player), claims, start: an Active epoch.
     * Returns the coordinator.
     */
    activate({ chips = 500, dust = [], who = players } = {}) {
      if (!world.coordinator) world.boot();
      world.settle();
      who.forEach((p, i) => {
        world.deposit(p, Array.isArray(chips) ? chips[i] : chips, { dust: dust[i] ?? 0n });
      });
      world.chainTick();
      for (const p of who) expectOk(world.claim(p), `claim ${p.name}`);
      world.startEpoch();
      return world.coordinator;
    },

    /** Wait out startHoldMs and let the start go through. */
    startEpoch() {
      world.tick(cfg.policy.startHoldMs);
      world.settle();
    },

    snapshot({ handNo = world.handNo, rake = 0, pot = 0 } = {}) {
      return {
        handNo,
        result: { pot, rake },
        entries: world.seated.map((p) => ({
          address: p.wallet,
          chips: p.chips,
          leaving: p.leaving,
          connected: p.connected,
          status: p.status,
          seat: p.seat,
        })),
      };
    },

    /**
     * Deal and play one hand if the gate is open: `winner` takes `amount` chips from `loser` and pays
     * `rake` of them to the house. Returns false (and plays nothing) when the gate is closed.
     */
    playHand({ winner, loser, amount = 10, rake = 0, pot, during } = {}) {
      if (!world.coordinator.canDeal()) return false;
      const w = typeof winner === 'string' ? world.player(winner) : winner;
      const l = typeof loser === 'string' ? world.player(loser) : loser;
      const take = Math.min(amount, l.chips);
      const potChips = pot ?? take * 2;
      world.handNo += 1;
      host.inHandFlag = true;
      during?.();
      l.chips -= take;
      w.chips += take - Math.min(rake, take);
      host.inHandFlag = false;
      const realRake = Math.min(rake, take);
      for (const p of world.seated) {
        if (p.connected) {
          p.client.watched.rake += realRake;
          p.client.watched.pot += potChips;
        } else {
          p.client.watched.missed = true;
        }
      }
      world.coordinator.onHandEnd(world.snapshot({ rake: realRake, pot: potChips }));
      world.coordinator.flush();
      world.pump();
      return true;
    },

    // ---- the clients ------------------------------------------------------------------------------

    /** Deliver every message to its client, and the clients' answers back, until it is quiet. */
    pump(limit = 10_000) {
      for (let i = 0; i < limit; i++) {
        const busy = players.find((p) => p.client.inbox.length > 0);
        if (!busy) return;
        world.handle(busy.client, busy.client.inbox.shift());
      }
      throw new Error('pump did not settle');
    },

    handle(client, msg) {
      switch (msg.t) {
        case SERVER.EPOCH:
          return world.onEpoch(client, msg);
        case SERVER.SIGN_REQ:
          return world.onSignreq(client, msg);
        case SERVER.BUNDLE:
          return world.onBundle(client, msg);
        default:
          return undefined;
      }
    },

    onEpoch(client, msg) {
      const state = fromWire(msg.state);
      if (client.epoch && msg.epoch === client.epoch.number) return; // a resend of the epoch it holds
      if (client.epoch && msg.epoch < client.epoch.number) {
        client.refusals.push({ type: 'epoch', rule: 'epoch-went-back' });
        return;
      }
      // a client that signed a final clears its latch only on its own chain read (F1, C2)
      const row = chain.table(world.tableKey);
      if (
        client.finalSigned &&
        !chainShowsSettled({ chainTable: row, final: client.finalSigned })
      ) {
        client.refusals.push({ type: 'epoch', rule: 'final-not-settled' });
        return;
      }
      const chainSeats = state.players.map((p) => chain.seat(world.tableKey, p));
      const verdict = verifyEpochAgainstChain({
        epoch: { domain: msg.domain, state, sessionKeys: msg.sessionKeys, arbiter: msg.arbiter },
        tableKey: world.tableKey,
        chainTable: row,
        chainSeats,
        myAddress: client.player.wallet,
        myExpectedBalance: client.expectedBalance,
      });
      if (!verdict.ok) {
        client.refusals.push({ type: 'epoch', ...verdict });
        return;
      }
      client.reset();
      client.finalSigned = null;
      client.epoch = {
        number: msg.epoch,
        domain: msg.domain,
        state,
        sessionKeys: msg.sessionKeys,
        arbiter: msg.arbiter,
      };
      client.baseline = state;
      // decideSign's record for a new epoch: the genesis, never final
      client.last = { nonce: state.nonce, digest: hashState(state, msg.domain), isFinal: false };
    },

    onSignreq(client, msg) {
      world.noteProposal(msg);
      if (client.mode === 'refuse') {
        client.refusals.push({ type: 'signreq', rule: 'mode', nonce: msg.state.nonce });
        return;
      }
      if (client.mode === 'manual') {
        client.held.push(msg);
        return;
      }
      world.signAs(client, msg);
    },

    /** Sign the held signreqs of a manual client now (a late signature). */
    signHeld(player) {
      const held = player.client.held.splice(0);
      for (const msg of held) world.signAs(player.client, msg);
      world.pump();
    },

    /** What this client saw at the table since its base state, in chips (F8: from the public stacks). */
    observedFor(client, base) {
      const deltas = base.players.map((address, i) => {
        const p = byWallet.get(address);
        const before = toChips(base.balances[i], UNIT).chips;
        return (p?.chips ?? before) - before;
      });
      const watched = client.watched;
      if (watched.missed) return { deltas, rake: -deltas.reduce((a, b) => a + b, 0), pot: null };
      return { deltas, rake: watched.rake, pot: watched.pot };
    },

    signAs(client, msg) {
      if (!client.epoch) {
        client.refusals.push({ type: 'signreq', rule: 'no-epoch', nonce: msg.state.nonce });
        return null;
      }
      let state;
      try {
        state = fromWire(msg.state);
      } catch (error) {
        client.refusals.push({ type: 'signreq', rule: 'MALFORMED', detail: error.message });
        return null;
      }
      const base =
        client.last?.state && client.last.nonce > client.baseline.nonce
          ? client.last.state
          : client.baseline;
      const verdict = clientShouldSign(
        { state, domain: msg.domain ?? client.epoch.domain, digest: msg.digest },
        {
          me: client.player.wallet,
          domain: client.epoch.domain,
          tableId: world.tableKey,
          roster: client.epoch.state.players,
          unit: UNIT,
          maxRakeBps: chain.info.maxRakeBps,
          baseline: client.baseline,
          last: client.last,
          intent: client.intent,
          leaveAckNonce: client.leaveAckNonce,
          observed: world.observedFor(client, base),
        },
      );
      if (!verdict.ok) {
        client.refusals.push({ type: 'signreq', nonce: state.nonce, ...verdict });
        return null;
      }
      const decision = decideSign({
        req: { nonce: state.nonce, digest: verdict.digest },
        last: client.last,
      });
      if (decision === 'new') {
        // the durable record is written BEFORE the signature leaves
        client.last = {
          nonce: state.nonce,
          digest: verdict.digest,
          isFinal: state.isFinal,
          state: cloneState(state),
        };
        client.watched = { rake: 0, pot: 0, missed: false };
        if (state.isFinal) client.finalSigned = cloneState(state);
        client.signedLog.push({ nonce: state.nonce, digest: verdict.digest });
      } else if (decision !== 'repeat') {
        client.refusals.push({ type: 'signreq', nonce: state.nonce, rule: decision });
        return null;
      }
      const sig = signDigest(client.player.sessionKey, verdict.digest);
      const result = world.coordinator.sign(client.player.playerId, {
        nonce: String(state.nonce),
        digest: verdict.digest,
        sig,
      });
      if (!result.ok) client.refusals.push({ type: 'sign-refused', nonce: state.nonce, ...result });
      return result;
    },

    onBundle(client, msg) {
      if (!client.epoch) return;
      let bundle;
      try {
        bundle = bundleFromWire({
          domain: msg.domain,
          state: msg.state,
          arbiterSig: msg.arbiterSig,
          playerSigs: msg.playerSigs,
        });
      } catch (error) {
        client.refusals.push({ type: 'bundle', rule: 'MALFORMED', detail: error.message });
        return;
      }
      const { players: roster } = client.epoch.state;
      const verdict = verifyBundle(bundle, {
        arbiter: client.epoch.arbiter,
        sessionKeyOf: (a) => client.epoch.sessionKeys[roster.indexOf(a)] ?? null,
        expect: { domain: client.epoch.domain, tableId: world.tableKey, players: roster },
      });
      if (!verdict.ok) {
        client.refusals.push({ type: 'bundle', ...verdict });
        return;
      }
      world.noteBundle(bundle, verdict.digest);
      if (!isNewer(bundle, client.newestBundle)) return;
      client.newestBundle = bundle;
      if (bundle.state.isFinal) {
        const i = roster.indexOf(client.player.wallet);
        if (bundle.state.keep[i]) client.expectedBalance = bundle.state.balances[i];
        else client.expectedBalance = null;
      } else if (bundle.state.nonce > client.baseline.nonce) {
        client.baseline = bundle.state;
      }
    },

    noteProposal(msg) {
      const nonce = BigInt(msg.state.nonce);
      if (!world.digestsByNonce.has(nonce)) world.digestsByNonce.set(nonce, new Set());
      const seen = world.digestsByNonce.get(nonce);
      if (!seen.has(msg.digest)) {
        seen.add(msg.digest);
        world.proposals.push({ nonce, digest: msg.digest, state: fromWire(msg.state) });
      }
      if (seen.size > 1) world.violations.push(`two digests at nonce ${nonce}`);
    },

    noteBundle(bundle, digest) {
      if (!world.bundles.some((b) => b.digest === digest)) world.bundles.push({ bundle, digest });
    },
  };

  host.onSend = (playerId, msg) => {
    const p = players.find((x) => x.playerId === playerId);
    if (p?.connected) p.client.inbox.push(msg);
  };
  host.onUnseat = (address) => {
    const p = byWallet.get(address);
    if (!p) return;
    p.atTable = false;
    p.chips = 0;
    p.leaving = false;
  };
  return world;
}
