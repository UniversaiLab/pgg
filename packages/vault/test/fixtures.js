// A small world for tests: an arbiter, N players with session keys, a vault domain and a table row that
// matches the contract's view of a freshly started epoch. `world.ctx()` is what checkState wants.
import { buildNextState, genesisState } from '../src/build.js';
import { hashState } from '../src/eip712.js';
import { privateKeyToAddress, signDigest } from '../src/sign.js';
import { rosterHash } from '../src/state.js';
import { makeRng, randomRoster } from './gen.js';

export const CHAIN_ID = 31337;
export const VAULT = '0x00000000000000000000000000000000000dead1';
export const UNIT = 10_000n; // token base units per chip (0.01 of a 6-decimal token)

export function makeWorld({ seed = 1, n = 3, deposits, maxRakeBps = 500, nonce = 0n } = {}) {
  const rng = makeRng(seed);
  const players = randomRoster(rng, n);
  const arbiterKey = rng.hex(32);
  const sessionKeys = players.map(() => rng.hex(32));
  const sessionAddresses = sessionKeys.map(privateKeyToAddress);
  const keyOf = new Map(players.map((p, i) => [p, sessionAddresses[i]]));
  const amounts = deposits ?? players.map((_, i) => BigInt(1000 + i * 250) * UNIT + BigInt(i));
  const tableId = rng.hex(32);
  const domain = { chainId: CHAIN_ID, verifyingContract: VAULT };
  const genesis = genesisState({ tableId, players, deposits: amounts, nonce });
  const escrow = amounts.reduce((a, b) => a + b, 0n);

  const world = {
    rng,
    players,
    arbiterKey,
    arbiter: privateKeyToAddress(arbiterKey),
    sessionKeys,
    sessionAddresses,
    sessionKeyOf: (address) => keyOf.get(address.toLowerCase()) ?? null,
    domain,
    tableId,
    deposits: amounts,
    genesis,
    escrow,
    maxRakeBps,
    /** The table row after the epoch started (nothing paid out yet). */
    table: {
      status: 2,
      nonce,
      escrow,
      rakePaid: 0n,
      rosterHash: rosterHash(players),
      arbiter: privateKeyToAddress(arbiterKey),
    },
    ctx(overrides = {}) {
      const { table, ...rest } = overrides;
      return {
        domain,
        maxRakeBps,
        sessionKeyOf: world.sessionKeyOf,
        table: { ...world.table, ...table },
        ...rest,
      };
    },
    /** The next state after a hand in which `winner` takes `amount` from `loser`, rake `rake` out of it. */
    nextHand(prev, { winner = 0, loser = 1, amount = 100n * UNIT, rake = 2n * UNIT, pot } = {}) {
      const balances = [...prev.balances];
      balances[loser] -= amount;
      balances[winner] += amount - rake;
      return buildNextState({
        prev,
        balances,
        rakeDelta: rake,
        volumeDelta: pot ?? amount * 2n,
      });
    },
    /** Sign `state` with the real keys. `skip`: indexes of players whose signature is left out. */
    sign(state, domainOverride = domain) {
      const digest = hashState(state, domainOverride);
      return {
        arbiterSig: signDigest(arbiterKey, digest),
        playerSigs: sessionKeys.map((key) => signDigest(key, digest)),
      };
    },
  };
  return world;
}
