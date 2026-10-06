// A small vault world for the signer, ledger and hostile-server tests (signer.test.js, ledger.test.js,
// hostile.test.js): a FakeChainView with the contract's rules for create, deposit, start, settle and exits
// (settle runs the library's checkSettle, so a state the vault would refuse is refused here too), storage
// fakes that can fail in each way a browser's can, and a scripted server that plays hands, proposes states,
// collects signatures and sends bundles exactly as docs/signing-layer.md section 1 says. The hostile tests
// bend that server; the honest one must never be refused.
import { buildNextState, epochBaseline } from '../src/build.js';
import { bundleToWire, makeBundle } from '../src/bundle.js';
import { checkSettle, STATUS } from '../src/check.js';
import { hashState } from '../src/eip712.js';
import { tableKeyFor } from '../src/ids.js';
import { createLedger } from '../src/ledger.js';
import { privateKeyToAddress, recoverSigner, signDigest } from '../src/sign.js';
import { createSigner, RECORD_PREFIX } from '../src/signer.js';
import { compareAddress, rosterHash, toWire } from '../src/state.js';
import { makeRng } from './gen.js';

export const UNIT = 10_000n; // token base units per chip
export const CHAIN_ID = 31337;
export const VAULT = '0x00000000000000000000000000000000000dead1';
export const DOMAIN = Object.freeze({ chainId: CHAIN_ID, verifyingContract: VAULT });
export const MAX_RAKE_BPS = 500;
export const GAME_TABLE = 'vault-1'; // the game table id the server's messages carry
const ZERO32 = `0x${'00'.repeat(32)}`;

// ---- storage -----------------------------------------------------------------------------------------------

/**
 * A synchronous Map-backed storage like the browser's. `calls` records every call in order. Failure modes:
 *   failSet     setItem throws (quota, private mode)
 *   failGet     getItem throws
 *   dropWrites  setItem returns but stores nothing (a storage that lies)
 */
export function memoryStorage() {
  const map = new Map();
  const calls = [];
  const modes = { failSet: false, failGet: false, dropWrites: false };
  return {
    map,
    calls,
    modes,
    getItem(key) {
      calls.push(['getItem', key]);
      if (modes.failGet) throw new Error('SecurityError: storage is disabled');
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      calls.push(['setItem', key, value]);
      if (modes.failSet) throw new Error('QuotaExceededError');
      if (!modes.dropWrites) map.set(key, String(value));
    },
    removeItem(key) {
      calls.push(['removeItem', key]);
      map.delete(key);
    },
  };
}

/** The stored record of a table, parsed (or null). */
export const storedRecord = (storage, tableKey) => {
  const raw = storage.map.get(RECORD_PREFIX + tableKey);
  return raw === undefined ? null : JSON.parse(raw);
};

// ---- the chain ---------------------------------------------------------------------------------------------

/**
 * The chain as createRpcChainView sees it (async table/seat/blockTimestamp with the same result shapes), plus
 * the contract's transitions so a test can move it. `down` makes every read fail; `reads` counts them.
 */
export class FakeChainView {
  tables = new Map();
  seats = new Map(); // `${tableKey}:${address}` -> { deposit, sessionKey }
  down = false;
  reads = 0;
  timestamp = 1_700_000_000n;

  createTable(tableKey, { arbiter, maxPlayers = 6 }) {
    this.tables.set(tableKey, {
      status: STATUS.Filling,
      maxPlayers,
      seated: 0,
      arbiter,
      nonce: 0n,
      exitDeadline: 0n,
      minDeposit: 1n,
      maxDeposit: 10n ** 30n,
      escrow: 0n,
      rakePaid: 0n,
      rosterHash: ZERO32,
      exitDigest: ZERO32,
    });
  }

  row(tableKey) {
    const row = this.tables.get(tableKey);
    if (!row) throw new Error('no such table');
    return row;
  }

  deposit(tableKey, wallet, amount, sessionKey) {
    const row = this.row(tableKey);
    if (row.status !== STATUS.Filling) throw new Error('WrongStatus');
    const key = `${tableKey}:${wallet}`;
    const seat = this.seats.get(key);
    if (!seat) row.seated += 1;
    this.seats.set(key, { deposit: (seat?.deposit ?? 0n) + amount, sessionKey });
    row.escrow += amount;
  }

  start(tableKey, players) {
    const row = this.row(tableKey);
    if (row.status !== STATUS.Filling || players.length !== row.seated)
      throw new Error('BadRoster');
    row.rosterHash = rosterHash(players);
    row.status = STATUS.Active;
  }

  /** settle(final bundle) with the contract's checks (checkSettle) and effects. */
  settle(tableKey, bundle, domain = DOMAIN) {
    const row = this.row(tableKey);
    const sessionKeyOf = (p) => this.seats.get(`${tableKey}:${p}`)?.sessionKey ?? null;
    const verdict = checkSettle(bundle.state, bundle, {
      domain,
      maxRakeBps: MAX_RAKE_BPS,
      sessionKeyOf,
      table: row,
    });
    if (!verdict.ok) throw new Error(`settle reverted: ${verdict.error}`);
    const { state } = bundle;
    row.nonce = state.nonce;
    row.rakePaid = state.rake;
    row.status = STATUS.Filling;
    row.rosterHash = ZERO32;
    let kept = 0n;
    let stayers = 0;
    state.players.forEach((p, i) => {
      const key = `${tableKey}:${p}`;
      if (state.keep[i]) {
        this.seats.get(key).deposit = state.balances[i];
        kept += state.balances[i];
        stayers += 1;
      } else this.seats.delete(key);
    });
    row.escrow = kept;
    row.seated = stayers;
  }

  /** startExit(state): the table is Exiting at that state's nonce. */
  startExit(tableKey, state, domain = DOMAIN) {
    const row = this.row(tableKey);
    row.status = STATUS.Exiting;
    row.nonce = state.nonce;
    row.exitDigest = hashState(state, domain);
  }

  async table(tableKey) {
    this.reads += 1;
    if (this.down) return { ok: false, error: 'the RPC did not answer' };
    const row = this.tables.get(tableKey);
    return { ok: true, table: row ? { ...row } : null };
  }

  async seat(tableKey, address) {
    this.reads += 1;
    if (this.down) return { ok: false, error: 'the RPC did not answer' };
    const seat = this.seats.get(`${tableKey}:${address}`);
    return { ok: true, seat: seat ? { ...seat } : null };
  }

  async blockTimestamp() {
    return this.down ? { ok: false, error: 'down' } : { ok: true, timestamp: this.timestamp };
  }
}

// ---- the world -------------------------------------------------------------------------------------------

const sortByAddress = (list) => [...list].sort((a, b) => compareAddress(a.wallet, b.wallet));

/**
 * One table on one chain, with a client per player. Each client has its own storage, signer (whose session
 * key is known to the test, so a test can tell what a signature would have been), ledger and wallet.
 *
 *   makeWorld({ seed, names, deposits, chainView: false })   chainView false: the signers have none
 *   makeWorld({ ServerClass })                               a subclass of Server (hostile.test.js bends it)
 */
export function makeWorld({
  seed = 1,
  names = ['alice', 'bob', 'carol'],
  deposits,
  chainView = true,
  generation = seed,
  ServerClass = Server,
} = {}) {
  const rng = makeRng(seed);
  const arbiterKey = rng.hex(32);
  const arbiter = privateKeyToAddress(arbiterKey);
  const tableKey = tableKeyFor({
    chainId: CHAIN_ID,
    vault: VAULT,
    serverId: 'pgg-test',
    generation,
  });
  const chain = new FakeChainView();
  chain.createTable(tableKey, { arbiter });
  const world = { rng, arbiterKey, arbiter, tableKey, chain, clients: [], domain: DOMAIN };

  world.addClient = (name, deposit) => {
    const walletKey = rng.hex(32);
    const sessionKey = rng.hex(32);
    const storage = memoryStorage();
    const client = {
      name,
      wallet: privateKeyToAddress(walletKey),
      sessionKey,
      sessionAddress: privateKeyToAddress(sessionKey),
      storage,
      ledger: createLedger({ unit: UNIT }),
      signer: createSigner({
        storage,
        chainView: chainView ? chain : null,
        newKey: () => sessionKey,
      }),
      deposit,
    };
    client.ctx = (over = {}) => ({
      wallet: client.wallet,
      domain: DOMAIN,
      unit: UNIT,
      maxRakeBps: MAX_RAKE_BPS,
      ...over,
    });
    world.clients.push(client);
    return client;
  };

  /** ensureSessionKey, then deposit on the chain with the key it returned (the order a browser must use). */
  world.depositFor = (client) => {
    const made = client.signer.ensureSessionKey(tableKey, {
      wallet: client.wallet,
      domain: DOMAIN,
      unit: UNIT,
    });
    if (!made.ok) throw new Error(`no session key: ${made.kind}`);
    chain.deposit(tableKey, client.wallet, client.deposit, made.address);
    return made.address;
  };

  names.forEach((name, i) => {
    world.addClient(name, deposits?.[i] ?? BigInt(1000 + 100 * i) * UNIT + BigInt(i * 3));
  });
  world.byName = (name) => world.clients.find((c) => c.name === name);
  world.server = new ServerClass(world);
  return world;
}

/**
 * The server, scripted. It keeps the table the way TableActor does (seats with chips; dust kept apart) and
 * proposes states the way the coordinator does. Nothing here is checked by the server itself: a hostile test
 * hands the clients whatever it likes.
 */
export class Server {
  constructor(world) {
    this.world = world;
    this.epoch = 0;
    this.handNo = 0;
    this.seq = 0;
    this.seats = []; // { seat, client, chips, dust, status }
    this.volume = 0n; // cumulative, from the final that closed the last epoch
    this.head = null; // the newest state proposed or all-signed
    this.genesis = null;
    this.pending = null;
  }

  get roster() {
    return sortByAddress(this.seats.map((s) => s.client));
  }

  /** Start an epoch with these clients (all must have deposited): start() on the chain, then the message. */
  startEpoch(clients) {
    const { chain, tableKey } = this.world;
    const players = sortByAddress(clients).map((c) => c.wallet);
    chain.start(tableKey, players);
    return this.openEpoch(clients);
  }

  /** The epoch message for what the chain holds now (no chain change): the honest genesis. */
  openEpoch(clients) {
    const { chain, tableKey } = this.world;
    const row = chain.row(tableKey);
    const sorted = sortByAddress(clients);
    const deposits = sorted.map((c) => chain.seats.get(`${tableKey}:${c.wallet}`).deposit);
    // seats keep their place across epochs; newcomers take the next free one
    const kept = this.seats.filter((s) => clients.includes(s.client));
    const used = new Set(kept.map((s) => s.seat));
    const seats = clients.map((client) => {
      const old = kept.find((s) => s.client === client);
      if (old) return old;
      let seat = 0;
      while (used.has(seat)) seat += 1;
      used.add(seat);
      return { seat, client, status: 'seated' };
    });
    this.seats = seats.map((s) => {
      const deposit = deposits[sorted.indexOf(s.client)];
      return { ...s, chips: Number(deposit / UNIT), dust: deposit % UNIT, status: 'seated' };
    });
    this.epoch += 1;
    this.genesis = epochBaseline({
      tableId: tableKey,
      players: sorted.map((c) => c.wallet),
      deposits,
      nonce: row.nonce,
      rake: row.rakePaid,
      volume: this.volume,
    });
    this.head = this.genesis;
    return this.epochMessage();
  }

  epochMessage(state = this.genesis, over = {}) {
    const sorted = sortByAddress(this.seats.map((s) => s.client));
    return {
      t: 'epoch',
      tableId: GAME_TABLE,
      epoch: this.epoch,
      domain: this.world.domain,
      state: toWire(state),
      sessionKeys: sorted.map((c) => c.sessionAddress),
      arbiter: this.world.arbiter,
      ...over,
    };
  }

  seatOf(client) {
    return this.seats.find((s) => s.client === client);
  }

  /** The public table state message, as TableActor#publish sends it. */
  tableMessage({ inHand = false, events = [], seats } = {}) {
    this.seq += 1;
    const view = Array.from({ length: 6 }, () => null);
    for (const s of seats ?? this.seats) {
      view[s.seat] = {
        seat: s.seat,
        playerId: `p-${s.client.name}`,
        name: s.client.name,
        chips: s.chips,
        bet: s.bet ?? 0,
        folded: false,
        allIn: false,
        hasCards: false,
        status: s.status,
        connected: true,
        address: s.address === undefined ? s.client.wallet : s.address,
      };
    }
    return {
      t: 'tbl',
      tableId: GAME_TABLE,
      seq: this.seq,
      state: {
        tableId: GAME_TABLE,
        name: 'Vault table',
        handNo: this.handNo || null,
        inHand,
        button: null,
        toAct: null,
        round: null,
        board: [],
        pot: 0,
        seats: view,
        legal: null,
        deadline: null,
        fairness: { current: null, next: null },
        vault: {
          epoch: this.epoch,
          phase: 'active',
          nonce: this.head.nonce.toString(),
          awaiting: [],
          deadline: null,
        },
      },
      events,
    };
  }

  balances() {
    return this.roster.map((c) => {
      const s = this.seatOf(c);
      return BigInt(s.chips) * UNIT + s.dust;
    });
  }

  /**
   * Play one hand: `loser` puts in `amount` and loses it, `winner` puts in `amount` too and takes the pot less
   * `rake` (all in chips). Returns { tbl, result, state } where tbl is the table message carrying the
   * hand-end event and state the next State. `final`/`keep` fold a rotation into the hand-end state.
   */
  hand({ winner, loser, amount = 100, rake = 2, final = false, keep, live = true } = {}) {
    const w = this.seatOf(winner);
    const l = this.seatOf(loser);
    this.handNo += 1;
    l.chips -= amount;
    w.chips += amount - rake;
    // every seat dealt in is in the engine's result; waiting and sitting-out seats are 0 there
    const stacks = Array.from({ length: 6 }, () => 0);
    for (const s of this.seats) if (s.status === 'seated') stacks[s.seat] = s.chips;
    const result = {
      handNo: this.handNo,
      board: [],
      pot: 2 * amount,
      rake,
      stacks,
      busted: l.chips === 0 ? [l.seat] : [],
    };
    const state = buildNextState({
      prev: this.head,
      balances: this.balances(),
      rakeDelta: BigInt(rake) * UNIT,
      volumeDelta: BigInt(2 * amount) * UNIT,
      final,
      keep: final ? keep : undefined,
    });
    const tbl = this.tableMessage({ events: live ? [{ type: 'hand-end', result }] : [] });
    return { tbl, result, state };
  }

  /** A standalone final between hands (a leave, a drain): balances unchanged, keep as given. */
  finalState(keep) {
    return buildNextState({ prev: this.head, balances: this.balances(), final: true, keep });
  }

  /** The keep flags of an honest rotation: chips > 0 and not leaving. */
  keepFor(leaving = []) {
    return this.roster.map((c) => this.seatOf(c).chips > 0 && !leaving.includes(c));
  }

  /** Propose `state`: the arbiter signs, and the signreq every member gets. */
  propose(state, { handNo = this.handNo, reason = 'hand', digest, epoch = this.epoch } = {}) {
    const real = hashState(state, this.world.domain);
    this.pending = {
      state,
      digest: real,
      arbiterSig: signDigest(this.world.arbiterKey, real),
      sigs: new Map(),
    };
    return {
      t: 'signreq',
      tableId: GAME_TABLE,
      epoch,
      handNo,
      state: toWire(state),
      digest: digest ?? real,
      deadline: 30_000,
      reason,
    };
  }

  /** A client's `sig` message. The server recovers over its own digest, as the coordinator does. */
  collect(client, { nonce, digest, sig }) {
    const { pending } = this;
    if (nonce !== pending.state.nonce || digest !== pending.digest) throw new Error('wrong round');
    if (recoverSigner(pending.digest, sig) !== client.sessionAddress)
      throw new Error('bad signature');
    pending.sigs.set(client.wallet, sig);
  }

  /** Every signature in: the bundle message, and the head moves on. */
  bundle() {
    const { pending } = this;
    const roster = this.roster;
    const b = makeBundle({
      domain: this.world.domain,
      state: pending.state,
      arbiterSig: pending.arbiterSig,
      playerSigs: roster.map((c) => pending.sigs.get(c.wallet)),
    });
    this.head = pending.state;
    this.lastBundle = b;
    if (b.state.isFinal) this.volume = b.state.volume;
    this.pending = null;
    return this.bundleMessage(b);
  }

  bundleMessage(b, over = {}) {
    return {
      t: 'bundle',
      tableId: GAME_TABLE,
      epoch: this.epoch,
      ...bundleToWire(b),
      sessionKeys: this.roster.map((c) => c.sessionAddress),
      ...over,
    };
  }

  /** settle(the final bundle) on the chain; the leavers' seats go. */
  settleOnChain() {
    this.world.chain.settle(this.world.tableKey, this.lastBundle);
    const keep = this.lastBundle.state.keep;
    const players = this.lastBundle.state.players;
    this.seats = this.seats.filter((s) => keep[players.indexOf(s.client.wallet)]);
  }
}

/** Deliver a table message to every client's ledger. */
export const publish = (world, tbl, clients = world.clients) => {
  for (const c of clients) c.ledger.observeTable(tbl);
};

/**
 * One honest round: every client in `clients` is asked to sign; each answer must be a signature, which the
 * server collects; then the bundle goes to everyone and must be stored. Returns the bundle message.
 */
export function honestRound(world, state, { clients, handNo, reason } = {}) {
  const members = clients ?? world.server.roster;
  const req = world.server.propose(state, { handNo, reason });
  for (const c of members) {
    const answer = c.signer.handleSignReq(req, { ledger: c.ledger });
    if (answer.action !== 'send') {
      throw new Error(`${c.name} did not sign: ${JSON.stringify(answer)}`);
    }
    world.server.collect(c, answer);
  }
  const bundle = world.server.bundle();
  for (const c of members) {
    const stored = c.signer.acceptBundle(bundle);
    if (!stored.stored)
      throw new Error(`${c.name} did not store the bundle: ${JSON.stringify(stored)}`);
  }
  return bundle;
}

/** Deposit, start and pin the first epoch for every client of the world. */
export async function startedWorld(options) {
  const world = makeWorld(options);
  for (const c of world.clients) world.depositFor(c);
  const epoch = world.server.startEpoch(world.clients);
  for (const c of world.clients) {
    const pinned = await c.signer.handleEpoch(epoch, c.ctx());
    if (!pinned.ok) throw new Error(`${c.name} did not pin the epoch: ${JSON.stringify(pinned)}`);
  }
  world.epochMessage = epoch;
  return world;
}

/** Play a hand and run its round honestly. */
export function playHand(world, hand) {
  const { tbl, state } = world.server.hand(hand);
  publish(world, tbl);
  return honestRound(world, state, { handNo: world.server.handNo });
}
