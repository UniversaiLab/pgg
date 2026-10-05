// A small world for the chain-port tests: a FakeChain, an arbiter, a relayer, N players with wallets and
// session keys, a table key, a resolver the tests fill in, and helpers that build and sign real States with
// @pgg/vault. Keys come from names, so every run is the same run.
import {
  buildNextState,
  depositState,
  epochBaseline,
  hashState,
  keccak256,
  makeBundle,
  privateKeyToAddress,
  signDigest,
  sortRoster,
  tableKeyFor,
  toHex,
} from '@pgg/vault';
import { makeJob } from '../../src/vault/chain-port.js';
import { expectOk, FakeChain } from '../../src/vault/fake-chain.js';

export const UNIT = 10_000n; // token base units per chip

export const keyFor = (name) => toHex(keccak256(new TextEncoder().encode(`pgg-coord-a:${name}`)));
export const addressFor = (name) => privateKeyToAddress(keyFor(name));

/**
 * A resolver for tests. `set(kind, args)` answers every job of that kind (args may be a function, evaluated
 * when the job executes, which is the whole point of resolving late); `decline(kind, reason)` makes it say
 * proceed:false. A kind nobody set up declines with 'no args', so a forgotten setup is visible.
 */
export class TestResolver {
  #byKind = new Map();
  calls = [];

  set(kind, args) {
    this.#byKind.set(kind, args);
  }

  decline(kind, reason = 'declined') {
    this.#byKind.set(kind, { proceed: false, reason });
  }

  prepare(job) {
    this.calls.push(job);
    if (!this.#byKind.has(job.kind)) return { proceed: false, reason: 'no args' };
    const entry = this.#byKind.get(job.kind);
    const value = typeof entry === 'function' ? entry(job) : entry;
    if (value && typeof value.proceed === 'boolean') return value;
    return { proceed: true, args: value };
  }
}

export function makeWorld({ names = ['alice', 'bob', 'carol'], chainOptions = {}, deposits } = {}) {
  const arbiterKey = keyFor('arbiter');
  const arbiter = privateKeyToAddress(arbiterKey);
  const relayer = addressFor('relayer');
  const resolver = new TestResolver();
  const chain = new FakeChain({ arbiter, relayer, resolver, ...chainOptions });
  const domain = { chainId: chain.info.chainId, verifyingContract: chain.info.vault };
  const tableKey = tableKeyFor({
    chainId: chain.info.chainId,
    vault: chain.info.vault,
    serverId: 'coord-a',
    generation: 1,
  });

  const people = names.map((name) => {
    const sessionKey = keyFor(`session:${name}`);
    return {
      name,
      wallet: addressFor(`wallet:${name}`),
      sessionKey,
      session: privateKeyToAddress(sessionKey),
    };
  });
  const seats = sortRoster(people.map((p) => ({ ...p, address: p.wallet }))).sorted;
  const players = seats.map((s) => s.wallet);
  const amounts = deposits ?? seats.map((_, i) => 1000n * UNIT + BigInt(i * 7));

  const world = {
    chain,
    resolver,
    domain,
    tableKey,
    arbiterKey,
    arbiter,
    relayer,
    seats,
    players,
    amounts,
    unit: UNIT,

    /** Run one job through the real path (submit, tick) with these resolver args. */
    run(kind, args, key = tableKey) {
      resolver.set(kind, args);
      chain.submit(makeJob(kind, key));
      return chain.tick();
    },

    createTable({ maxPlayers = 6, minDeposit = UNIT, maxDeposit = 10_000_000n * UNIT } = {}) {
      return world.run('createTable', { maxPlayers, minDeposit, maxDeposit });
    },

    /** Everyone deposits, then one tick delivers the events. */
    depositAll(list = amounts, options = {}) {
      seats.forEach((seat, i) => {
        chain.mint(seat.wallet, list[i]);
        expectOk(chain.deposit(tableKey, seat.wallet, list[i], seat.session, options), 'deposit');
      });
      return chain.tick();
    },

    start() {
      return world.run('start', { players });
    },

    /** createTable, deposits and start: an Active table of all the seats. Returns the epoch baseline. */
    activate(list = amounts) {
      world.createTable();
      world.depositAll(list);
      world.start();
      return world.baseline(list);
    },

    baseline(list = amounts, { nonce = 0n, rake = 0n, volume = 0n } = {}) {
      return epochBaseline({ tableId: tableKey, players, deposits: list, nonce, rake, volume });
    },

    depositState(list = amounts, { nonce = 0n, rake = 0n } = {}) {
      return depositState({ tableId: tableKey, players, deposits: list, nonce, rake });
    },

    digest(state) {
      return hashState(state, domain);
    },

    /** The next hand: seat `winner` takes `amount` chips from seat `loser`, `rake` chips go to the house. */
    hand(prev, { winner = 0, loser = 1, amount = 100n, rake = 2n, pot } = {}) {
      const balances = [...prev.balances];
      balances[loser] -= amount * UNIT;
      balances[winner] += (amount - rake) * UNIT;
      return buildNextState({
        prev,
        balances,
        rakeDelta: rake * UNIT,
        volumeDelta: (pot ?? amount * 2n) * UNIT,
      });
    },

    /** A final state at the next nonce: unchanged balances, `keep` per seat. */
    final(prev, keep = prev.players.map(() => true)) {
      return buildNextState({ prev, balances: prev.balances, final: true, keep });
    },

    /** The state with every signature: the arbiter's and each seat's session key. */
    bundle(state) {
      const digest = hashState(state, domain);
      return makeBundle({
        domain,
        state,
        arbiterSig: signDigest(arbiterKey, digest),
        playerSigs: seats.map((s) => signDigest(s.sessionKey, digest)),
      });
    },

    /** The state signed by everyone except the arbiter, or except `skip` (a seat index). */
    partial(state, { skip, noArbiter = false } = {}) {
      const full = world.bundle(state);
      const digest = hashState(state, domain);
      return {
        ...full,
        arbiterSig: noArbiter ? signDigest(keyFor('stranger'), digest) : full.arbiterSig,
        playerSigs: full.playerSigs.map((sig, i) =>
          i === skip ? signDigest(keyFor('stranger'), digest) : sig,
        ),
      };
    },
  };
  return world;
}
