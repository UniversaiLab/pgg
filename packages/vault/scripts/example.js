// The worked example from README.md, runnable: `bun packages/vault/scripts/example.js`.
// test/readme.test.js checks that README.md contains this file's code and that it still runs.
import {
  buildNextState,
  bundleConflict,
  bundleFromWire,
  bundleToWire,
  canDeal,
  checkState,
  clientShouldSign,
  decideSign,
  epochBaseline,
  hashState,
  isNewer,
  makeBundle,
  newPrivateKey,
  privateKeyToAddress,
  rosterHash,
  signDigest,
  sortRoster,
  tableKeyFor,
  toTokenUnits,
  verifyBundle,
} from '@pgg/vault';

export function main() {
  const vault = '0x00000000000000000000000000000000000dead1';
  const domain = { chainId: 31337, verifyingContract: vault };
  const unit = 10_000n; // one chip is 0.01 of a 6-decimal token
  const maxRakeBps = 500;

  // Three seats. The wallet address is on-chain; the session key signs states and never leaves the browser.
  const arbiterKey = newPrivateKey();
  const arbiter = privateKeyToAddress(arbiterKey);
  const seats = ['alice', 'bob', 'carol'].map((name) => {
    const sessionKey = newPrivateKey();
    return { name, address: privateKeyToAddress(newPrivateKey()), sessionKey };
  });
  const { sorted, position } = sortRoster(seats); // states list players in ascending address order
  const players = sorted.map((s) => s.address);
  const sessionKeyOf = (address) => {
    const seat = sorted.find((s) => s.address === address);
    return seat ? privateKeyToAddress(seat.sessionKey) : null;
  };

  // The epoch starts: each player deposited 1000 chips and 7 token units of dust. A brand-new table has
  // nonce, rake and volume 0, written out; a rolled-over epoch passes the table's nonce and rakePaid and the
  // cumulative volume of the final state that closed the last epoch (depositState is only for exit digests).
  const tableId = tableKeyFor({ chainId: 31337, vault, serverId: 'pgg-1', generation: 1 });
  const deposits = players.map(() => toTokenUnits(1000, unit) + 7n);
  const genesis = epochBaseline({ tableId, players, deposits, nonce: 0n, rake: 0n, volume: 0n });
  const table = {
    nonce: genesis.nonce,
    escrow: deposits.reduce((a, b) => a + b, 0n),
    rakePaid: 0n,
    rosterHash: rosterHash(players),
    arbiter,
  };
  const ctx = { domain, maxRakeBps, sessionKeyOf, table };

  // A hand ends: alice wins 100 chips from bob, the house takes 2 chips out of a pot of 200.
  const [alice, bob] = [position[0], position[1]]; // seat -> index in the state
  const balances = [...genesis.balances];
  balances[alice] += toTokenUnits(98, unit);
  balances[bob] -= toTokenUnits(100, unit);
  const state = buildNextState({
    prev: genesis,
    balances,
    rakeDelta: toTokenUnits(2, unit),
    volumeDelta: toTokenUnits(200, unit),
  });

  // The server checks the state against the contract's rules BEFORE it proposes it...
  const proposal = checkState(state, null, ctx);

  // ...and each client checks it against what it saw at the table before it signs.
  const deltas = players.map(() => 0);
  deltas[alice] = 98;
  deltas[bob] = -100;
  const view = (seat) => ({
    me: seat.address,
    domain,
    tableId,
    roster: players,
    unit,
    maxRakeBps,
    baseline: genesis,
    myBalance: deposits[sorted.indexOf(seat)], // my own deposit record, never the server's message
    last: null,
    intent: 'play',
    observed: { deltas, rake: 2, pot: 200 },
  });
  const verdicts = sorted.map((seat) => clientShouldSign({ state, domain }, view(seat)));
  const forged = { ...state, balances: state.balances.map((b, i) => (i === alice ? b + unit : b)) };
  const refused = clientShouldSign({ state: forged, domain }, view(sorted[0]));

  // The nonce record is written before the signature is sent; asking again for the same digest is a repeat.
  // A yes carries the digest the client computed: that is the one to sign.
  const digest = verdicts[0].digest;
  const decision = decideSign({ req: { nonce: state.nonce, digest }, last: null });
  const again = decideSign({
    req: { nonce: state.nonce, digest },
    last: { nonce: state.nonce, digest, isFinal: false },
  });

  // Everyone signs; the bundle is the state with all its signatures.
  const bundle = makeBundle({
    domain,
    state,
    arbiterSig: signDigest(arbiterKey, digest),
    playerSigs: sorted.map((seat, i) => signDigest(seat.sessionKey, verdicts[i].digest)),
  });
  // The browser has no chain access, so it also says which chain, vault, table and roster it expects.
  const verified = verifyBundle(bundle, {
    arbiter,
    sessionKeyOf,
    expect: { domain, tableId, players },
  });
  const contractView = checkState(state, bundle, ctx); // what startExit would do with it

  // Over the wire (JSON) and back, then the table may deal the next hand.
  const received = bundleFromWire(JSON.parse(JSON.stringify(bundleToWire(bundle))));
  const members = players.map(() => ({ claimed: true, online: true }));
  const mayDeal = canDeal({
    active: true,
    roundOpen: false,
    head: state.nonce,
    bundle: received,
    members,
    verify: { arbiter, sessionKeyOf }, // required: the gate checks every signature itself
    tableId,
    domain,
  });

  return {
    proposal,
    verdicts,
    refused,
    decision,
    again,
    verified,
    contractView,
    newer: isNewer(received, null),
    conflict: bundleConflict(received, bundle), // null: two bundles at one nonce would be an alarm
    hashed: hashState(state, domain),
    mayDeal,
  };
}

if (import.meta.main) console.log(main());
