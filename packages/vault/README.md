# @pgg/vault

The signing layer for the `PokerVault` escrow contract (`contracts/src/PokerVault.sol`). After every hand the
server (the **arbiter**) and every seated player's session key sign an EIP-712 `State`. This package is the
one place that knows how to hash, build, check, verify and judge those states, so the server, the web client,
the test bots and the watchtower cannot disagree about them.

- Plain JavaScript ES modules, **browser-safe**: no `node:` imports, no `Buffer`, no `viem`, no `Date.now()`,
  no `Math.random()` (the only randomness is `crypto.getRandomValues` inside `newPrivateKey`).
- Every token amount, nonce, rake and volume is a `BigInt`.
- The contract is the source of truth. Where this package and `PokerVault.sol` disagree, this package is wrong.
- `viem` is a dev dependency, used only by the tests.

```js
import { hashState, checkState, clientShouldSign /* ... */ } from '@pgg/vault';
```

## Conventions

| Thing | Shape |
| --- | --- |
| **State** (internal) | `{ tableId, nonce, isFinal, players, balances, keep, rake, volume }`. `tableId` is `'0x'` + 64 lowercase hex. `nonce` is a `bigint` (uint64). `players` are lowercase `0x` addresses, strictly ascending by value, 2 to 10 of them. `balances` are `bigint[]`, `keep` is `boolean[]`, both one per player. `rake` and `volume` are `bigint`, **cumulative since the table was created**. |
| **Wire State** | The same, with `nonce`, `balances`, `rake` and `volume` as **decimal strings**, so it survives JSON. `toWire` / `fromWire` convert. |
| **Domain** | `{ chainId: number, verifyingContract: lowercase address }`. The contract name and version are fixed. |
| **Signature** | `'0x'` + 130 hex: `r \|\| s \|\| v`, 65 bytes, `v` 27 or 28, low-s. |
| **Digest** | `'0x'` + 64 hex. |
| **Addresses** | Lowercased inside the library; any case is accepted on input. |
| **Errors** | Validation failures throw a `RangeError` whose message starts with the field (`nonce is out of range for uint64`, `players[2] must be above players[1] (strictly ascending)`). The `check*`, `verifyBundle` and rule predicates do not throw on bad *input*; they return a result. A bad *argument* (a broken `ctx`, a non-function `sessionKeyOf`) is a caller bug and throws. |
| **Chips and tokens** | The game counts whole chips (numbers); the vault counts token base units (`bigint`). `unit` is the number of base units per chip. A deposit need not be a multiple of the unit: the remainder (dust) stays on the player's balance and conserves exactly. |

## API

### `units.js`

- `toTokenUnits(chips: number, unit: bigint) -> bigint`. `chips` must be a non-negative safe integer.
- `toChips(tokenUnits: bigint, unit: bigint) -> { chips: number, dust: bigint }`. Throws `RangeError` when the
  chip count is not a safe integer, or `unit <= 0n`.

### `state.js`

- `normalizeState(raw) -> State`. Checks and canonicalises: uint64 nonce, uint256 amounts, bytes32 `tableId`,
  20-byte addresses, equal array lengths, 2 to 10 players, strictly ascending, first player not zero. Accepts
  safe-integer numbers for number fields. Returns a new object.
- `decodeState(raw)`. Only what the contract's ABI decoder would check (types and ranges). Used by `checkState`
  so a state with a bad roster gets the contract's error instead of an exception.
- `toWire(state)`, `fromWire(wire)`. `fromWire` is strict: a number must be a string of digits, no leading zero
  (except `'0'`), no sign, no whitespace, no `0x`, no decimal point; JSON numbers are refused.
- `statesEqual(a, b)`, `normalizeAddress(a)`, `compareAddress(a, b)` (numeric), `isStrictlyAscending(list)`.
- `rosterHash(players)`: `keccak256` of the 32-byte-padded concatenation, exactly the contract's `rosterHash`.
- `MIN_PLAYERS`, `MAX_PLAYERS`.

### `eip712.js`

- `STATE_TYPEHASH`, `DOMAIN_TYPEHASH`, `STATE_TYPE_STRING`: built from `STATE_TYPES` in `@pgg/protocol/vault`,
  which stays the single source. The encoder is driven by the same list, so a change there changes the hash.
- `domainSeparator(domain)`, `hashStruct(state)`, `hashState(state, domain) -> digest`. Equal to
  `PokerVault.stateDigest()` and viem's `hashTypedData` (tested on 600 random states and on anvil).
- `normalizeDomain(domain)`, `domainsEqual(a, b)`.

### `build.js`

- `genesisState({ tableId, players, deposits, nonce = 0n, rake = 0n })`. What `startExitFromDeposits` and
  `depositState` use: `isFinal` false, `keep` all false, `volume` 0. `players` must already be the roster in
  ascending order; `deposits[i]` belongs to `players[i]`. Pass the table's `nonce` and `rakePaid` for a
  rolled-over epoch.
- `buildNextState({ prev, balances, rakeDelta = 0n, volumeDelta = 0n, final = false, keep })`. `nonce = prev.nonce + 1n`,
  same roster, `rake` and `volume` advanced by the deltas. A final state takes `keep` (default: nobody stays);
  a state that is not final always has `keep` all false. It does **not** check the money: run `checkState`.
- `sortRoster(items) -> { sorted, order, position }` for `{ address, ... }` objects. `order[j]` is the input
  index at state index `j`; `position[i]` is the state index of input `i`. Duplicates throw.

### `check.js`: `checkState` and `checkSettle`

`PokerVault._verify` (and `settle`) rewritten check for check, in the contract's order and with its error names.

```js
checkState(state, sigs, ctx) -> { ok: true, digest } | { ok: false, error, args }
checkSettle(state, sigs, ctx) -> the same
```

- `sigs`: `{ arbiterSig, playerSigs }` (a bundle works as it is), or `null` to skip the signature steps (use it
  before signing).
- `ctx`:
  ```js
  {
    domain,                         // { chainId, verifyingContract }
    maxRakeBps,                     // number or bigint: the vault's MAX_RAKE_BPS
    sessionKeyOf(playerAddress),    // -> the seat's on-chain session key, or null
    table: {                        // the contract's tables(id) row
      nonce, escrow, rakePaid,      // bigint (numbers accepted)
      rosterHash, arbiter,
      status,                       // 0..4 or 'None'|'Filling'|'Active'|'Exiting'|'Closed'; only checkSettle needs it
    },
  }
  ```
  `tableFromChain(row)` builds `ctx.table` from what viem returns for `tables(id)` (array or object).
- Order for `checkState`: `StaleNonce(given, current)`, `BadLength`, `RosterMismatch`, `RakeDecreased`,
  `RakeTooHigh`, `NotConserved(claimed, escrow)`, then the arbiter signature (`BadSignature(2n**256n - 1n)`), then
  each player in order (`BadSignature(i)`). A malformed signature reverts inside OpenZeppelin's ECDSA before the
  comparison, so it is reported in place of `BadSignature`: `ECDSAInvalidSignatureLength(length)` (not 65 bytes),
  `ECDSAInvalidSignatureS(s)` (high-s; checked before `v`), `ECDSAInvalidSignature()` (ecrecover returns
  nothing: `v` not 27/28, `r` or `s` zero, `r` not below the curve order, `r` not the x of a point).
- Solidity 0.8 arithmetic is checked: `rake * 10000`, `maxRakeBps * volume` and the balance sum revert with
  `Panic(0x11)` on overflow, returned as `{ error: 'Panic', args: [0x11n] }`.
- `checkSettle` adds `NotFinal` first, then `WrongStatus(status)` unless the table is Active or Exiting, then the
  same checks, then `BadKeep(i)` for the first `keep[i] && balances[i] == 0`.
- `args` are typed as viem decodes the revert: uint as `bigint`, the `Status` enum as a `number`, `bytes32` as hex.
- `Malformed` (not a contract error): the state or signatures could not even be ABI-encoded (`args[0]` says why).
- Not checked, because they depend on the entry point: `startExit` needs status Active and a member or the
  arbiter; `challenge` needs Exiting and an open window; `finalizeExit` needs the exit digest.
- `ERRORS`: every error name with `source`, `params`, `signature` and 4-byte `selector`. `STATUS`: the enum.

### `bundle.js`

A bundle is a State with every signature: `{ domain, state, arbiterSig, playerSigs }`. It is the only thing
the contract accepts, so servers and clients keep the newest one durably.

- `makeBundle({ domain, state, arbiterSig, playerSigs })`: validates the shape (65-byte signatures, one per player).
- `verifyBundle(bundle, { arbiter, sessionKeyOf }) -> { ok: true, digest } | { ok: false, error, args }`. The
  digest is recomputed; the arbiter and every player are recovered and compared, in the contract's order, with
  the contract's errors. A bad bundle is a result (`Malformed` or `BadLength`); a bad `arbiter` or `sessionKeyOf`
  argument is a caller bug and throws. It does not know the
  table, so it cannot say whether the state is newer or conserves the escrow (that is `checkState`).
- `bundleToWire(bundle)`, `bundleFromWire(wire)` (strict), `bundleDigest(bundle)`.
- `isNewer(a, b)`: strictly higher nonce; anything is newer than `null`. Equal nonces with different digests
  are an alarm, not an update, and are the caller's to raise.

### `rules.js`: the rules in `docs/trust-model.md`

| Id | Rule | Where |
| --- | --- | --- |
| **C1a** | Sign only a nonce above the last one signed, or the identical digest again; never two digests at one nonce. | `clientShouldSign`, `decideSign` |
| **C1b** | Every balance, the rake and the volume move by exactly what the client saw at the table. | `clientShouldSign` |
| **C1c** | Balances plus rake equal the last all-signed baseline's balances plus rake. | `clientShouldSign` |
| **C1d** | Same table, roster and domain as pinned; the client computes the digest itself. | `clientShouldSign` |
| **C1e** | Rake never decreases and stays within `maxRakeBps` of cumulative volume. | `clientShouldSign` |
| **C2** | A final state only when leaving or rotating, and nothing higher after it in the epoch. | `clientShouldSign`, `decideSign` |
| **S1** | No next hand before the last state has every signature. | `canDeal`, `dealBlocker` |
| **S3** | No co-signing with a session key past its policy expiry. | `serverMayCoSign` |
| **S4** | Never two states at one nonce (the arbiter uses `decideSign` too). | `decideSign` |

(C3, store the newest all-signed state durably, and C4/S2, watch for stale exits, are behaviours rather than
predicates; the helpers are `isNewer` and `verifyBundle`.)

**`decideSign({ req, last }) -> 'new' | 'repeat' | 'refuse-lower' | 'refuse-equivocation' | 'refuse-after-final'`**

- `req = { nonce, digest }`, `last = null | { nonce, digest, isFinal }`: the durable record of the highest nonce
  signed **in this epoch**. On a new epoch store `{ nonce: settledNonce, digest, isFinal: false }` so the final
  flag does not outlive its epoch.
- `new`: sign, and write the record **before** sending the signature. `repeat`: same nonce and digest, send the
  same signature again (signing is deterministic). The refusals are as named; `refuse-after-final` also covers
  any higher nonce after a final. Bad arguments throw `TypeError`.

**`clientShouldSign(req, view) -> { ok: true } | { ok: false, rule, detail }`**

```js
req = {
  state,          // the proposed State (internal; run fromWire on the wire form first)
  domain,         // optional: if present it must equal the pinned domain
  digest,         // optional: if present it must equal the digest the client computes itself
}
view = {          // what THIS client knows, none of it taken from the request
  me,             // my wallet address (a seat in `roster`)
  domain,         // pinned when I deposited
  tableId,        // pinned
  roster,         // pinned, ascending: the players the contract started the epoch with
  unit,           // bigint, token base units per chip
  maxRakeBps,     // number, from the vault
  baseline,       // State: the newest all-signed state, or the genesis state built from the deposits
  last,           // null | { nonce, digest, isFinal }: the durable record read by decideSign
  intent,         // 'play' | 'leave' | 'rotate': leave = I asked to leave; rotate = a rotation is due
  observed,       // null | { deltas, rake, pot }: the hand I watched, in CHIPS (number or bigint);
                  //   deltas[i] is the chips player i (state order) won or lost, rake and pot are chips.
                  //   null means no hand was seen: every delta, the rake and the pot are 0.
}
```

Checked in this order (cheap structure first, then the money from the coarsest invariant to the exact amounts).
`rule` is one of `MALFORMED` (the request is not a valid State), `VIEW` (the client's view is unusable),
`C1d`, `C1a`, `C2`, `C1e`, `C1c`, `C1b`, or `INTERNAL` (an unexpected exception: it fails closed).

1. `C1d`: table, roster, `req.domain`, `req.digest` against the pinned values; the digest is computed with the pinned domain.
2. `C1a`: via `decideSign`. An identical digest returns `{ ok: true }` at once (the client already vouched for it); a
   lower nonce or a second digest at one nonce is refused; the nonce must also beat the baseline's. A higher
   nonce after a signed final is `C2`.
3. `C2`: a final state needs `intent` `leave` or `rotate`; when leaving, `keep[me]` must be false; no kept seat
   may have a zero balance (`settle` would revert with `BadKeep`).
4. `C1e`: `rake >= baseline.rake` and `rake * 10000 <= maxRakeBps * volume`.
5. `C1c`: `sum(balances) + rake == sum(baseline.balances) + baseline.rake`.
6. `C1b`: `balances[i] - baseline.balances[i] == deltas[i] * unit` for every seat, `rake - baseline.rake == observed.rake * unit`,
   `volume - baseline.volume == observed.pot * unit`.

**`serverMayCoSign({ sessionKeyAgeMs, policyMaxMs }) -> boolean`** (S3). True while the age is within the maximum
(equal is allowed). Anything that is not a finite non-negative number is `false`. The caller does the clock.

**`canDeal(view) -> boolean`** and **`dealBlocker(view) -> null | { reason, detail }`** (S1)

```js
view = {
  active,         // boolean: the epoch is Active
  roundOpen,      // boolean: a sign round is still collecting signatures
  head,           // bigint | null: nonce of the newest state proposed this epoch; null before the first hand ends
  bundle,         // the newest all-signed bundle | null
  members,        // [{ claimed: boolean, online: boolean }], one per roster seat (online = recently connected)
  verify,         // optional { arbiter, sessionKeyOf }: also run verifyBundle on `bundle`
}
```

`true` only if the epoch is active, no round is open, every member has claimed their seat and is online, and
either nothing has been proposed yet (`head` is null) or `bundle.state.nonce === head`, that state is not final,
and the bundle carries the arbiter's and every player's signature. Reasons, in the order they are checked:
`bad-view`, `not-active`, `round-open`, `member-not-claimed`, `member-offline`, `no-bundle`, `bundle-not-head`,
`bundle-final`, `bundle-incomplete`, `bundle-invalid`. Anything unexpected is a "no".

### `ids.js`

- `tableKeyFor({ chainId, vault, serverId, generation })` = `keccak256(utf8("pgg:" + chainId + ":" + vault + ":" + serverId + ":" + generation))`,
  vault lowercase. `serverId` is a non-empty string without `:`.
- `claimDigest({ domain, tableKey, address, playerId })` = `keccak256(utf8("PGG claim v1") || uint256(chainId) || vault (20 bytes) || tableKey (32 bytes) || address (20 bytes) || utf8(playerId))`.
- `signClaim(sessionPrivateKey, claim)`, `recoverClaim(claim, signature) -> address | null`,
  `verifyClaim(claim, signature, sessionKey) -> boolean`. A session-key proof of an on-chain seat; the server
  checks it against `seats(tableKey, address).sessionKey`.

### `sign.js`

`signDigest(key, digest)`, `recoverSigner(digest, sig)`, `tryRecoverSigner(digest, sig)` (says *why* a signature
fails, with OpenZeppelin's error names), `newPrivateKey()`, `privateKeyToAddress`, `publicKeyToAddress`,
`keccak256`, `toHex`, `fromHex`. This is the only file that touches `@noble/curves`.

### `abi.js`

`pokerVaultAbi`: the full ABI, committed as data. Regenerate it after the contract changes:

```sh
(cd contracts && forge build)
bun packages/vault/scripts/vault-abi.js
```

`test/abi.test.js` fails when the committed copy differs from `contracts/out` (and fails when the artifact is
missing and `PGG_REQUIRE_CHAIN_TESTS=1`), and checks that every error in `ERRORS` is a real contract error.

## Worked example

`scripts/example.js` (run it with `bun packages/vault/scripts/example.js`; `test/readme.test.js` keeps this copy
and the file identical and runs it).

```js
// The worked example from README.md, runnable: `bun packages/vault/scripts/example.js`.
// test/readme.test.js checks that README.md contains this file's code and that it still runs.
import {
  buildNextState,
  bundleFromWire,
  bundleToWire,
  canDeal,
  checkState,
  clientShouldSign,
  decideSign,
  genesisState,
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

  // The epoch starts: each player deposited 1000 chips and 7 token units of dust.
  const tableId = tableKeyFor({ chainId: 31337, vault, serverId: 'pgg-1', generation: 1 });
  const deposits = players.map(() => toTokenUnits(1000, unit) + 7n);
  const genesis = genesisState({ tableId, players, deposits });
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
    last: null,
    intent: 'play',
    observed: { deltas, rake: 2, pot: 200 },
  });
  const verdicts = sorted.map((seat) => clientShouldSign({ state, domain }, view(seat)));
  const forged = { ...state, balances: state.balances.map((b, i) => (i === alice ? b + unit : b)) };
  const refused = clientShouldSign({ state: forged, domain }, view(sorted[0]));

  // The nonce record is written before the signature is sent; asking again for the same digest is a repeat.
  const digest = hashState(state, domain);
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
    playerSigs: sorted.map((seat) => signDigest(seat.sessionKey, digest)),
  });
  const verified = verifyBundle(bundle, { arbiter, sessionKeyOf });
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
    mayDeal,
  };
}

if (import.meta.main) console.log(main());
```

## Tests

```sh
PATH=/opt/foundry:$PATH PGG_REQUIRE_CHAIN_TESTS=1 bun test packages/vault
```

- `eip712.test.js`: the digest equals viem's and the contract vector (`contracts/test/vectors/state.json`) on
  600 seeded random states plus the edge values (nonce 2^64-1, amounts 2^256-1, 2 and 10 players).
- `check.test.js`: every failure of `_verify` and `settle`, the order when two faults are present, and the
  Solidity overflow panics.
- `chain/digest.test.js`: the same pipeline against the real contract on anvil (digest, `depositState`, reverts,
  `Panic(0x11)`, `settle`).
- `chain/signatures.test.js`: 300 mutated signatures and 420 mutated states (several faults at once, and a
  rolled-over epoch with rake already paid) must give the contract's first error with the same arguments, and
  the test fails if any ECDSA error or any `_verify` error is never reached. `chain/setup.js` is the shared
  set-up (one Active table of three players on anvil).
- `rules.test.js`, `bundle.test.js`, `state.test.js`, `units.test.js`, `ids.test.js`, `build.test.js`, `abi.test.js`.
- The seeded generators are in `test/gen.js`, a small world (keys, table row) in `test/fixtures.js`.
