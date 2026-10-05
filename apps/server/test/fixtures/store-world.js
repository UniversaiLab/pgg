// A small deterministic world for the store tests: one vault table with three players, an arbiter, real
// session keys, and helpers that build and sign real States and bundles with @pgg/vault. Keys come from
// names, so every run (and the child process of the SIGKILL test) sees the same bytes.
import {
  hashState,
  keccak256,
  makeBundle,
  privateKeyToAddress,
  rosterHash,
  signDigest,
  tableKeyFor,
  toHex,
} from '@pgg/vault';

export const UNIT = 10_000n; // token base units per chip
export const VAULT = '0x00000000000000000000000000000000000dead1';
export const DOMAIN = { chainId: 31337, verifyingContract: VAULT };

export const keyFor = (name) => toHex(keccak256(new TextEncoder().encode(`pgg-store:${name}`)));

export function makeWorld({ names = ['alice', 'bob', 'carol'], generation = 1 } = {}) {
  const arbiterKey = keyFor('arbiter');
  const arbiter = privateKeyToAddress(arbiterKey);
  const seats = names
    .map((name) => ({
      name,
      address: privateKeyToAddress(keyFor(`wallet:${name}`)),
      sessionKey: keyFor(`session:${name}`),
    }))
    .sort((a, b) => (a.address < b.address ? -1 : 1)); // states list players in ascending address order
  const players = seats.map((s) => s.address);
  const sessionKeyOf = (address) => {
    const seat = seats.find((s) => s.address === address);
    return seat ? privateKeyToAddress(seat.sessionKey) : null;
  };
  const tableKey = tableKeyFor({
    chainId: DOMAIN.chainId,
    vault: VAULT,
    serverId: 'store',
    generation,
  });
  const deposits = players.map((_, i) => 1000n * UNIT + BigInt(i));

  /**
   * A state at `nonce`. `variant` moves one token unit between two players, so the same nonce can be given
   * two different digests; amounts are not meant to conserve (the store does not check money).
   */
  const stateAt = (
    nonce,
    { variant = 0n, isFinal = false, keep, rake, volume, balances } = {},
  ) => ({
    tableId: tableKey,
    nonce,
    isFinal,
    players: [...players],
    balances:
      balances ?? deposits.map((d, i) => (i === 0 ? d + variant : i === 1 ? d - variant : d)),
    keep: keep ?? players.map(() => false),
    rake: rake ?? nonce * 10n,
    volume: volume ?? nonce * 1000n,
  });

  const digestOf = (state) => hashState(state, DOMAIN);
  const arbiterSigFor = (state) => signDigest(arbiterKey, digestOf(state));
  const playerSigFor = (state, index) => signDigest(seats[index].sessionKey, digestOf(state));

  const bundleFor = (state, { arbiterSig, playerSigs } = {}) =>
    makeBundle({
      domain: DOMAIN,
      state,
      arbiterSig: arbiterSig ?? arbiterSigFor(state),
      playerSigs: playerSigs ?? seats.map((_, i) => playerSigFor(state, i)),
    });

  const record = (overrides = {}) => ({
    tableKey,
    serverId: 'store',
    generation,
    epoch: 1,
    phase: 'active',
    roster: seats.map((s, i) => ({
      address: s.address,
      seat: i,
      sessionKey: privateKeyToAddress(s.sessionKey),
    })),
    pinned: { chipUnit: UNIT, blinds: { small: 5, big: 10 }, rakeBps: 200, numSeats: 6 },
    epochBaseNonce: 0n,
    nonceHw: 0n,
    rakeCum: 0n,
    volumeCum: 0n,
    rakePaid: 0n,
    dust: { [players[0]]: 7n },
    lastAppliedEvent: { block: 12n, logIndex: 3 },
    updatedAt: 1000,
    ...overrides,
  });

  // verifyCtx for saveBundle: who the arbiter is, whose session key belongs to whom, and what the
  // bundle must be for.
  const verifyCtx = (overrides = {}) => ({
    arbiter,
    sessionKeyOf,
    expect: { domain: DOMAIN, tableId: tableKey, players: [...players] },
    ...overrides,
  });

  return {
    arbiterKey,
    arbiter,
    seats,
    players,
    sessionKeyOf,
    tableKey,
    deposits,
    rosterHash: rosterHash(players),
    stateAt,
    digestOf,
    arbiterSigFor,
    playerSigFor,
    bundleFor,
    record,
    verifyCtx,
  };
}
