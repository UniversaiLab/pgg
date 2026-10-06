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
| **Addresses** | Lowercased inside the library; any case is accepted on input. Every `sessionKeyOf(playerAddress)` callback you pass is called with a **lowercase** address, so a `Map` keyed by lowercase addresses works as it is. |
| **Errors** | Validation failures throw a `RangeError` whose message starts with the field (`nonce is out of range for uint64`, `players[2] must be above players[1] (strictly ascending)`). An array with a hole (`new Array(3)`, `delete a[1]`) is refused like any other bad element, and an array longer than a table can have is refused before anything walks it. The `check*`, `verifyBundle` and rule predicates do not throw on bad *input*; they return a result. A bad *argument* (a broken `ctx`, a non-function `sessionKeyOf`, a malformed `expect`) is a caller bug and throws. |
| **Chips and tokens** | The game counts whole chips (numbers); the vault counts token base units (`bigint`). `unit` is the number of base units per chip. A deposit need not be a multiple of the unit: the remainder (dust) stays on the player's balance and conserves exactly. |

## API

### `units.js`

- `toTokenUnits(chips: number, unit: bigint) -> bigint`. `chips` must be a non-negative safe integer.
- `toChips(tokenUnits: bigint, unit: bigint) -> { chips: number, dust: bigint }`. Throws `RangeError` when the
  chip count is not a safe integer, or `unit <= 0n`.

### `state.js`

- `normalizeState(raw) -> State`. Checks and canonicalises: uint64 nonce, uint256 amounts, bytes32 `tableId`,
  20-byte addresses, equal array lengths (an array of more than 10 entries is refused before it is read), 2 to
  10 players, strictly ascending, first player not zero, no holes in any array. Accepts safe-integer numbers
  for number fields. Returns a new object.
- `decodeState(raw)`. Only what the contract's ABI decoder would check (types and ranges). Used by `checkState`
  so a state with a bad roster gets the contract's error instead of an exception.
- `toWire(state)`, `fromWire(wire)`. `fromWire` is strict: a number must be a string of digits, no leading zero
  (except `'0'`), no sign, no whitespace, no `0x`, no decimal point; JSON numbers are refused. The three arrays
  are length-checked before any element is converted, so a 2-million-entry array costs one comparison.
- `statesEqual(a, b)` (never throws; a hole is equal to nothing), `normalizeAddress(a)`, `compareAddress(a, b)` (numeric), `isStrictlyAscending(list)`.
- `rosterHash(players)`: `keccak256` of the 32-byte-padded concatenation, exactly the contract's `rosterHash`.
- `MIN_PLAYERS`, `MAX_PLAYERS`.

### `eip712.js`

- `STATE_TYPEHASH`, `DOMAIN_TYPEHASH`, `STATE_TYPE_STRING`: built from `STATE_TYPES` in `@pgg/protocol/vault`,
  which stays the single source. The encoder is driven by the same list, so a change there changes the hash.
- `domainSeparator(domain)`, `hashStruct(state)`, `hashState(state, domain) -> digest`. Equal to
  `PokerVault.stateDigest()` and viem's `hashTypedData` (tested on 600 random states and on anvil).
- `normalizeDomain(domain)`, `domainsEqual(a, b)`.

### `build.js`

- **Which baseline?** `rake` and `volume` are cumulative since the table was created, and two different states
  start from the deposits, so there are two builders over one internal one:

  | Builder | For | `nonce` / `rake` | `volume` |
  | --- | --- | --- | --- |
  | `depositState({ tableId, players, deposits, nonce = 0n, rake = 0n })` | The synthetic state `startExitFromDeposits` puts up; its digest must equal `PokerVault.depositState`. Compare an exit against it, or finalise one. | the table's `nonce` and `rakePaid` | **always 0** (the vault does not store volume; passing a `volume` option throws) |
  | `epochBaseline({ tableId, players, deposits, nonce, rake, volume })` | The baseline for the **first hand of a new epoch**, and the `baseline` of the client view. | the table's `nonce` and `rakePaid` | the cumulative volume of the final state that closed the previous epoch |

  `epochBaseline` requires all three of `nonce`, `rake` and `volume` (write `0n` for a brand-new table), because
  a silent default is the trap: the vault checks `rake * 10000 <= MAX_RAKE_BPS * volume` on the **cumulative**
  numbers, so a rolled-over epoch whose baseline has `rake = rakePaid` but `volume = 0` makes the next hand at
  2% of its own pot `RakeTooHigh` (proved against the contract on anvil in `test/review-chain.test.js`).
  The vault does not store volume, so take it from the final bundle you hold (C3 says to keep the newest
  all-signed state durably), never from a message the other side sends you. `deposits[i]` belongs to
  `players[i]`: a stayer's balance from that final state, a new player's deposit.
- `genesisState({ tableId, players, deposits, nonce = 0n, rake = 0n, volume = 0n })`. The general form behind
  both, kept so existing callers work. Prefer the two above: they say which one you mean.
- `buildNextState({ prev, balances, rakeDelta = 0n, volumeDelta = 0n, final = false, keep })`. `nonce = prev.nonce + 1n`,
  same roster, `rake` and `volume` advanced by the deltas. `final` must be a boolean (the string `'false'` is a
  `RangeError`, not a final state). A final state takes `keep` (default: nobody stays); a state that is not
  final always has `keep` all false. It does **not** check the money: run `checkState`.
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
    sessionKeyOf(playerAddress),    // -> the seat's on-chain session key, or null (called with a LOWERCASE address)
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
  `RAKE_BPS_CEILING` (500): `PokerVault.RAKE_BPS_CEILING`, the highest `MAX_RAKE_BPS` a vault can be built with
  (`test/rake-ceiling.test.js` compares it with the contract source).

### `bundle.js`

A bundle is a State with every signature: `{ domain, state, arbiterSig, playerSigs }`. It is the only thing
the contract accepts, so servers and clients keep the newest one durably.

- `makeBundle({ domain, state, arbiterSig, playerSigs })`: validates the shape (65-byte signatures, one per player,
  no holes).
- `verifyBundle(bundle, { arbiter, sessionKeyOf, expect? }) -> { ok: true, digest } | { ok: false, error, args }`.
  The digest is recomputed; the arbiter and every player are recovered and compared, in the contract's order,
  with the contract's errors (`sessionKeyOf` is called with lowercase addresses). A bad bundle is a result
  (`Malformed` or `BadLength`), never an exception; a bad `arbiter`, `sessionKeyOf` or `expect` argument is a
  caller bug and throws. It does not know the table's row, so it cannot say whether the state is newer or
  conserves the escrow (that is `checkState`).

  **`expect = { domain, tableId, players }`** (any of them, at least one; a key that is present but `undefined`
  throws, so a variable that was never set cannot silently skip the check). The signatures only prove the
  bundle is consistent with *its own* domain and table. The browser has no chain access, so without `expect` a
  bundle that was legitimately signed for another chain, vault, table or roster (the same session keys) would
  verify, and a hostile server could shadow the real newest bundle with it. With `expect`, a mismatch is
  reported before any signature is read: `{ ok: false, error: 'WrongDomain' | 'WrongTable' | 'WrongRoster',
  args: [what the bundle is for] }` (the names are exported as `EXPECT_ERRORS`).
- `bundleToWire(bundle)`, `bundleFromWire(wire)` (strict), `bundleDigest(bundle)`.
- `isNewer(a, b)`: strictly higher nonce; anything is newer than `null`. Nonces are compared **as numbers**: a
  `bigint`, a safe-integer number and a decimal string (the wire form, so `'10'` is newer than `'9'`) all work;
  anything else, or a value above uint64, throws `TypeError` rather than guess. Equal nonces with different
  digests are not newer either way.
- `bundleConflict(a, b) -> null | { nonce, digests: [digestOfA, digestOfB] }`. The alarm case `isNewer` cannot
  express: two bundles for the same table and domain with the **same nonce and different digests**. An honest
  arbiter signs one state per nonce, so two fully signed states at one nonce mean a bug, a restart that lost its
  record, or a key compromise. Run it on bundles that passed `verifyBundle`. Different tables, domains or
  nonces, or the very same state, give `null`. A value that is not an internal-form bundle throws `RangeError`.

### `rules.js`: the rules in `docs/trust-model.md`

| Id | Rule | Where |
| --- | --- | --- |
| **C1a** | Sign only the very next nonce after the newest state you hold (default step 1, `maxNonceGap`), or the identical digest again; never two digests at one nonce. | `clientShouldSign`, `decideSign` |
| **C1b** | Every balance and the rake move by exactly what the client saw at the table since the base state, and so does the volume, unless the pot is unknown (`observed.pot` null): then it only may not go down. | `clientShouldSign` |
| **C1c** | Balances plus rake equal the base state's balances plus rake. | `clientShouldSign` |
| **C1d** | Same table, roster and domain as pinned; the client computes the digest itself and signs that one. | `clientShouldSign` |
| **C1e** | Rake never decreases and stays within `maxRakeBps` of cumulative volume, and neither is so large that the contract's cap check would panic. | `clientShouldSign` |
| **C2** (F13) | Nothing at all after a final in the epoch (signed by me or all-signed as the baseline). A final state is otherwise signed, whatever the intent, unless I asked to leave and it keeps me (states at or below `leaveAckNonce` are excused), or it keeps a seat with less than one chip. A cash-out I did not ask for is accepted. No keep flag in a state that is not final. | `clientShouldSign`, `decideSign` |
| **F1** | The chain, not the server, is the witness of an epoch: before signing the first state of an epoch the client checks the table and the seats against the `epoch` message. | `verifyEpochAgainstChain`, `chainShowsSettled` (`chainview.js`) |
| **S1** | No next hand before the last state has every signature, verified for this table and domain. | `canDeal`, `dealBlocker` |
| **S3** | No co-signing with a session key past its policy expiry. | `serverMayCoSign` |
| **S4** | Never two states at one nonce (the arbiter uses `decideSign` too). | `decideSign` |

(C3, store the newest all-signed state durably, and C4/S2, watch for stale exits, are behaviours rather than
predicates; the helpers are `isNewer`, `bundleConflict` and `verifyBundle`.)

**`decideSign({ req, last }) -> 'new' | 'repeat' | 'refuse-lower' | 'refuse-equivocation' | 'refuse-after-final'`**

- `req = { nonce, digest }`, `last = null | { nonce, digest, isFinal }`: the durable record of the highest nonce
  signed **in this epoch**. On a new epoch store `{ nonce: settledNonce, digest, isFinal: false }` so the final
  flag does not outlive its epoch.
- `new`: sign, and write the record **before** sending the signature. `repeat`: same nonce and digest, send the
  same signature again (signing is deterministic). The refusals are as named; `refuse-after-final` also covers
  any higher nonce after a final. Bad arguments throw `TypeError`. It only compares numbers: how far the nonce
  jumps is `clientShouldSign`'s business (below).

**`clientShouldSign(req, view) -> { ok: true, digest } | { ok: false, rule, detail }`**

A yes carries `digest`, the digest this function computed itself from the state under the **pinned** domain.
Sign that digest and nothing else, never one the server supplied; a request that names a different digest is a
refusal (`C1d`), not a yes.

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
  maxRakeBps,     // integer 0..500 (RAKE_BPS_CEILING), from the vault
  baseline,       // State: the newest all-signed state of THIS epoch, or the epoch baseline (see
                  //   epochBaseline). Never a final state: once one is all-signed the epoch is over, and a
                  //   request that extends it is refused (C2); after the settle use the next epoch's baseline
  last,           // null | { nonce, digest, isFinal, state? }: the durable record read by decideSign.
                  //   `state` is the full State I signed. REQUIRED when `last.nonce` is above the baseline's
                  //   nonce (I signed a hand whose round is still open): the money is then judged against it.
  intent,         // 'play' | 'leave' ('rotate' is an alias of 'play'): leave = I asked to leave
  leaveAckNonce,  // optional (bigint | number | null): the head nonce the server had acknowledged when I
                  //   pressed Leave. Only read when intent is 'leave': a final state at or below it may keep me
  observed,       // null | { deltas, rake, pot }: what happened at the table SINCE THE BASE STATE, in CHIPS
                  //   (number or bigint); deltas[i] is the chips player i (state order) won or lost, rake and
                  //   pot are chips and not negative. pot may be null (explicitly): the hand was not watched
                  //   live and only the current public stacks are known (see C1b below). A missing pot is a
                  //   VIEW error. observed = null means no hand was seen: all of them are 0, pot included.
  myBalance,      // optional bigint: my balance at the baseline in token units, from MY OWN records
  maxNonceGap,    // optional integer >= 1, default 1: how far above the newest state held a nonce may be
}
```

**The base state.** The money checks (`C1e`, `C1c`, `C1b`) compare the request with the *base*: the state in
`last.state` when `last.nonce` is above `baseline.nonce` (I signed it, its round is still collecting
signatures), otherwise `baseline`. So the next request cannot rewind a hand I already signed, whatever the
ledger reports, and `observed` is measured from the base: the hands since the state I signed, or since the
baseline when I signed nothing newer. A `last` that is ahead of the baseline but carries no `state` is a `VIEW`
refusal (the nonce refusals, `C1a` and `C2`, still apply first). The record must describe itself truthfully
(`state` for this table and roster, `state.nonce === last.nonce`, `state.isFinal === last.isFinal`, and
`state` hashes to `last.digest` under the pinned domain), or it is a `VIEW` refusal.

**`myBalance` (baseline trust).** The baseline normally arrives in the server's `epoch` message. A lying one
that moves my chips to another seat would pass every money check, because they are all relative to it. When
`myBalance` is given and `baseline.balances[me]` differs, the answer is a `VIEW` refusal. The web step must fill
it from the client's **own** record of its balance (its deposit for the first epoch; the balance in the final
state it signed for a rolled-over one; later the balance in the last all-signed state it verified itself), never
from the server's `epoch` message.

Checked in this order (cheap structure first, then the money from the coarsest invariant to the exact amounts).
`rule` is one of `MALFORMED` (the request is not a valid State), `VIEW` (the client's view is unusable or
contradicts what the client knows), `C1d`, `C1a`, `C2`, `C1e`, `C1c`, `C1b`, or `INTERNAL` (an unexpected
exception: it fails closed).

1. `VIEW`: the view and the record are readable and consistent: `me` is on the roster, the baseline is for this
   table and roster, `myBalance` (if given) agrees with the baseline, `last.state` (if given) is what `last`
   says it is.
2. `C1d`: table, roster, `req.domain`, `req.digest` against the pinned values; the digest is computed with the pinned domain.
3. `C1a`: via `decideSign`. An identical digest returns `{ ok: true, digest }` at once (the client already vouched
   for it); a lower nonce or a second digest at one nonce is refused; the nonce must also beat the baseline's and
   be at most `maxNonceGap` above the newest state held (baseline or signed). An honest server steps the nonce by
   one; a bigger jump is refused because at the extreme one signature would burn the whole uint64 space, and no
   later state could follow it or challenge an exit from it. Raise `maxNonceGap` only if a server is known to
   skip nonces. A higher nonce after a signed final is `C2`.
4. `C2` (F13): nothing may follow a final baseline. A final state needs **no** intent of its own: a due rotation
   rides in a hand-end state the client could not have predicted, so it is signed while playing. What is refused
   in a final state: **(a)** `keep[me]` when `intent` is `'leave'`, except for a state whose nonce is at or below
   `leaveAckNonce` (that state was already in flight when I pressed Leave: I sign it and `leave()` in Filling);
   **(b)** a kept seat, mine or anyone's, whose balance is below one chip unit (`balance < unit`): the contract
   only reverts with `BadKeep` for zero, but dust alone never keeps a seat; **(c)** nothing else: a
   `keep[me] = false` I did not ask for is a cash-out, never a loss, and is accepted. A state that is not final
   must have every `keep` false (the contract reads `keep` only in `settle`, but the digest covers it, so a
   server could mint many digests for one economic state). `leaveAckNonce` only widens the set of states that
   cost the leaver a `leave()` call in Filling, never money, but take it from your own records where you can (the
   newest nonce you held or were asked to sign when you pressed Leave).
5. `C1e`: `rake >= base.rake` and `rake * 10000 <= maxRakeBps * volume`; and neither product may exceed
   `2^256 - 1`, because the contract would revert with `Panic(0x11)` and the state could never be used for an
   exit, a challenge or a settle (with an unknown pot nothing else bounds the volume).
6. `C1c`: `sum(balances) + rake == sum(base.balances) + base.rake`.
7. `C1b`: `balances[i] - base.balances[i] == deltas[i] * unit` for every seat, `rake - base.rake == observed.rake * unit`,
   and `volume - base.volume == observed.pot * unit` when the pot is a number. **`observed.pot = null`**: the
   client did not watch the hand live (it knows only the current public stacks), so `deltas` come from the
   stacks and `rake = -sum(deltas)`; the balances and the rake are still compared exactly, conservation (C1c)
   and the cumulative cap (C1e) still hold, and the volume need only not go **down**. Volume is self-attested
   in the contract anyway (it only feeds the rake cap), and extra volume buys headroom, never money, because
   every hand's rake is compared exactly.

**`serverMayCoSign({ sessionKeyAgeMs, policyMaxMs }) -> boolean`** (S3). True while the age is within the maximum
(equal is allowed). Anything that is not a finite non-negative number, including no argument or `null`, is `false`.
The caller does the clock.

**`canDeal(view) -> boolean`** and **`dealBlocker(view) -> null | { reason, detail }`** (S1)

```js
view = {
  active,         // boolean: the epoch is Active
  roundOpen,      // boolean: a sign round is still collecting signatures
  head,           // bigint | null: nonce of the newest state proposed this epoch. REQUIRED: null (explicitly)
                  //   means no hand has ended yet; a missing or undefined head is a bad view, never an open gate
  bundle,         // the newest all-signed bundle | null
  members,        // [{ claimed: boolean, online: boolean }], one per roster seat (online = recently connected)
  verify,         // REQUIRED { arbiter, sessionKeyOf }: the gate runs verifyBundle on `bundle` itself
  tableId,        // REQUIRED: the table this gate is for
  domain,         // REQUIRED: { chainId, verifyingContract }
  roster,         // optional [address]: if given, the bundle must be for exactly this roster
}
```

`true` only if the epoch is active, no round is open, every member has claimed their seat and is online, and
either nothing has been proposed yet (`head` is `null`) or `bundle.state.nonce === head`, that state is not
final, the bundle carries the arbiter's and every player's signature, **every signature verifies**, and the
bundle is for this `tableId`, `domain` (and `roster`). The verifier is not optional: signatures that merely look
complete (65 zero bytes) must not open the gate, and neither may a bundle that was legitimately signed for another
table. Reasons, in the order they are checked: `bad-view` (including a missing `head`, `tableId` or `domain`),
`no-verifier`, `not-active`, `round-open`, `member-not-claimed`, `member-offline`, `no-bundle`, `bundle-not-head`,
`bundle-final`, `bundle-incomplete`, `bundle-wrong-table` (the bundle is valid but for another domain, table or
roster), `bundle-invalid` (a signature fails). Anything unexpected is a "no".

### `chainview.js`: the chain as the witness of an epoch (F1)

Browser-safe and viem-free. The server's `epoch` message is the baseline of every money check a client makes, so
a lying server could announce a fake one. The chain is the one witness it cannot forge. **The web step passes an
RPC-backed chain view whose `rpcUrl` and `vault` address are PINNED IN THE APP BUILD, never taken from a server
message**; without one a client is unprotected against a lying server, which is a gate before real money, not a
silent default.

- **Calldata and decoding**, hand-written for exactly two views of `PokerVault`: `tables(bytes32)` (12 static
  words) and `seats(bytes32,address)` (2 words). `TABLES_SELECTOR` and `SEATS_SELECTOR` are
  `keccak256(signature)[0..4]`. `encodeTablesCall(tableKey)`, `encodeSeatsCall(tableKey, address)` (throw
  `RangeError` on a bad key or address), `decodeTableRow(hex) -> row` (the contract's field names, the shape
  `tableFromChain` accepts: `status`, `maxPlayers`, `seated` numbers; `nonce`, `exitDeadline` and the amounts
  bigint; `arbiter` lowercase; `rosterHash`, `exitDigest` hex) and `decodeSeat(hex) -> { deposit, sessionKey } | null`
  (null for an empty seat). The decoders are strict, because the node may be hostile: exact length, a status
  above Closed, dirty bits in a uint8, uint64 or address word, a table with no status but with data in it, and a
  seat with a deposit and no key (or the reverse) all throw `RangeError`. Tested against viem on random inputs
  and against a real anvil.
- **`createRpcChainView({ rpcUrl, vault, fetch = globalThis.fetch, timeoutMs = 10000 })`** ->
  `{ async table(tableKey), async seat(tableKey, address), async blockTimestamp() }`, plain JSON-RPC over `fetch`
  (`eth_call` at `latest`, `eth_getBlockByNumber('latest', false)`). A bad constructor argument throws; after
  that **nothing ever throws or rejects**: every method resolves one of
  - `table`: `{ ok: true, table: row | null }` (null: no such table) or `{ ok: false, error }`
  - `seat`: `{ ok: true, seat: { deposit, sessionKey } | null }` or `{ ok: false, error }`
  - `blockTimestamp`: `{ ok: true, timestamp: bigint }` (seconds) or `{ ok: false, error }`

  It is strict about the response: HTTP 2xx, a body of at most 64 K characters that is JSON, exactly one JSON-RPC
  2.0 reply object (not a batch) carrying this request's `id` and exactly one of `result` and `error`, a hex
  string result of exactly the expected length, a minimal hex quantity for the timestamp. A network failure, a
  timeout (the request is aborted), a revert and an address with no code (answers `0x`) are all `{ ok: false }`.
  `timeoutMs` is enforced with `AbortSignal.timeout`, so the module reads no clock and arms no timer; on a
  platform without it (Safari before 16) the injected `fetch` must bound the request itself, or the caller
  must race it.
  Bad method arguments are an `{ ok: false }` result too, with no request sent.
- **`verifyEpochAgainstChain({ epoch, tableKey, chainTable, chainSeats, myAddress, myExpectedBalance, allowFilling })`**
  -> `{ ok: true }` | `{ ok: true, filling: true }` | `{ ok: false, rule, detail }`. Pure; it never throws (an
  unusable argument is `rule: 'MALFORMED'`, an unexpected exception `'INTERNAL'`, both closed).
  `epoch` is `{ domain, state, sessionKeys, arbiter }` in internal form (`state` is the genesis, `epochBaseline`;
  `sessionKeys[i]` is `state.players[i]`'s), `chainTable` the `tables(tableKey)` row (`decodeTableRow`,
  `tableFromChain` or a ChainPort row; a status number or its name; `null` for no table), `chainSeats` one
  `{ deposit, sessionKey }` or `null` per roster seat in state order, `myExpectedBalance` a bigint from the
  client's **own** records (its deposit, or the balance of the final it signed if it stayed). Rules, in the order
  checked (`EPOCH_RULES` documents each):

  | `rule` | The chain must show |
  | --- | --- |
  | `table-id` | the epoch's `state.tableId` is the `tableKey` pinned |
  | `status` | the table exists and is Active (Filling too when `allowFilling` is true) |
  | `nonce` | `nonce` equal to the genesis nonce |
  | `roster` | `rosterHash` equal to `rosterHash(players)` (in Filling, where it is still zero: `seated` equals the roster size) |
  | `escrow` | `escrow == sum(balances) + rake - rakePaid` |
  | `rake` | the genesis `rake` equals `rakePaid` |
  | `arbiter` | the table's arbiter is the epoch's |
  | `session-key` | every seat exists (and is not marked unconfirmed) with `sessionKey == sessionKeys[i]` |
  | `my-balance` | my balance in the epoch equals `myExpectedBalance` |
  | `deposit` | every seat's deposit equals its balance in the epoch |

  `table-id`, `rake` and `deposit` go beyond the contract's own list; they only refuse epochs no honest server
  builds. A pass for a Filling table (`{ ok: true, filling: true }`) does not pin the roster (the hash is set by
  `start`): check again when it is Active, and sign nothing before.
- **`chainShowsSettled({ chainTable, final })`** -> boolean (never throws). True when the table is Filling at a
  nonce at or above the final's, or Active at a nonce at or above it (the next epoch's genesis nonce IS the
  final's). Exiting, Closed, a missing table, an unreadable row and a state that is not final are false. `final`
  is the final State I signed (or a bundle carrying it).
- **How the web controller composes them.** Before signing the first state of any epoch, and after every `epoch`
  message: read the table and every roster seat through the view and run `verifyEpochAgainstChain`. The record
  of the highest nonce signed per table is a monotone high-water mark: a genesis nonce below it is refused, and
  **a client that signed a final clears its "final" latch only when `chainShowsSettled` is true on a fresh
  chain read**, never on the server's word. The pure check alone does not stop a server that replays the
  CURRENT epoch's genesis after I signed a final (it matches the chain); the latch and the nonce high-water mark
  do. The lying-server scenario (a fake epoch with the same roster at the final's nonce) is refused on `nonce`
  until the chain really settles, and accepted after (`test/chain/chainview.test.js` runs it across a real
  settle and start).

### `signer.js`: the client's durable signer

`createSigner({ storage, chainView?, newKey?, now? })` is the one place a browser (or a test bot) keeps its
session key and decides what that key signs. `storage` is synchronous and `localStorage`-shaped
(`getItem`, `setItem`, `removeItem`); every call is wrapped, and a failure is reported, never swallowed: a read
that throws is not "no record" (that would mint a second key), and a write that throws or does not read back the
same means no signature leaves. `chainView` is `{ table(tableKey), seat(tableKey, address) }` as
`createRpcChainView` returns it, built from an RPC URL and vault address **pinned in the app build**, never from a
server message. `newKey` and `now` are injected so tests are repeatable.

| Method | Does |
| --- | --- |
| `ensureSessionKey(tableKey, { wallet?, domain?, unit?, chainSeat? })` | Creates the key if there is none and **writes it (and reads it back) before returning the address**, so it exists before any deposit can. Never replaces a key. A record whose key is unreadable, or no record while `chainSeat` (a fresh chain read) shows this wallet seated, is `lost-key`: reported, never regenerated. -> `{ ok, address, created }` or `{ ok: false, kind, detail }` |
| `handleEpoch(epochMsg, ctx)` (async) | Pins an epoch only after `verifyEpochAgainstChain` agrees on a fresh chain read (F1). Refuses a genesis below the nonce high-water mark, another session key for my seat, and anything while a signed final is latched until `chainShowsSettled` (the same read clears the latch). Without a chain view: `UNPINNED`, unless `ctx.allowUnpinned`, which takes only a table's first epoch and records a persistent `unpinned` warning. `ctx = { wallet, domain, unit, maxRakeBps, myDeposit?, allowFilling?, allowUnpinned?, tableKey? }`. Never throws. |
| `handleSignReq(signreqMsg, { ledger, tableKey? })` | Synchronous. `{ action: 'send', nonce, digest, sig }` (the record is on disk: send exactly these), `{ action: 'refuse', rule, detail }` or `{ action: 'wait', reason, detail }` (no epoch pinned yet, or the ledger cannot judge yet: ask again on the next table or epoch message). |
| `acceptBundle(bundleMsg)` | Stores the newest all-signed state only when every signature verifies against the **pinned** keys, arbiter, roster, table and domain, and the nonce is higher. Equal nonce and another digest is a blocking `bundle-conflict`. A final bundle latches the table. -> `{ stored: true, nonce, final }` or `{ stored: false, reason, detail }` |
| `noteLeave(tableKey, headNonce)` | Records `leaveAckNonce` (bounded by my own records: at most one state past the newest I hold). The first press wins. |
| `settledObserved(tableKey, chainTable)` | Pass a FRESH `tables()` read. Opens the final latch only when `chainShowsSettled`; what I carry into the next epoch is the balance the final kept for me. |
| `signClaim(tableKey, { playerId, domain?, wallet? })` | The session-key proof of an on-chain seat (identity, never funds). |
| `restore(tableKey)` | The record without the private key, or why it cannot be read. |
| `failure(tableKey)` | The worst failure on record (`{ kind, rule, detail, nonce, blocking, kinds }`) or `null`. |
| `forget(tableKey, { chainShowsDone, exitWindowPassed })` | Deletes the record only when the caller's own chain read shows the table done AND the exit window has passed. No server message deletes anything. |

The rules it enforces, each tested in `test/signer.test.js`: the `{ nonce, digest, sig, state }` record is
written **before** a signature is returned; the same nonce and digest gets the identical signature (signing is
deterministic); another digest at a signed nonce is refused and is a persistent `equivocation`; a lower nonce is
refused; nothing higher than a signed final is signed until `settledObserved`; the digest signed is the one
`clientShouldSign` computed, never the request's `digest` field; a torn, edited or contradictory record fails
closed.

**The record**, one JSON blob under `RECORD_PREFIX + tableKey` (`'pgg.vault.v1.0x…'`), written with one
`setItem` so a crash leaves the old record or the new one. Amounts and nonces are decimal strings.

```js
{
  v: 1, tableKey, sessionKey,      // the private key: never replaced, never sent anywhere
  address,                         // the session key's address (checked against sessionKey on every read)
  wallet, domain, unit,            // pinned when the key was made or at the first epoch
  roster, deposit,                 // the pinned roster, my balance at its genesis
  last,                            // { nonce, digest, sig, isFinal, state } | null: the newest state this key signed
  bundle,                          // the newest all-signed state (wire form) | null
  pinned,                          // { epoch, genesis, sessionKeys, arbiter, maxRakeBps, unpinned } | null
  epochClosed,                     // the final latch
  leaveAckNonce,                   // null until I press Leave
  failures,                        // [{ kind, rule, detail, nonce }], at most 16, blocking ones are never dropped
  createdAt,
}
```

**Failure kinds** (`FAILURE_KINDS`). Blocking ones stop all signing at that table for good (the stall exit
still pays everyone from the last all-signed state); the others are shown and kept but do not stall an honest
table. The app shows them in a persistent banner, never a toast.

| Kind | Blocking | Means |
| --- | --- | --- |
| `lost-key` | yes | a record or an on-chain seat exists but the key is missing or unreadable; a new one is never made |
| `corrupt` | yes | the record cannot be read or contradicts itself |
| `equivocation` | yes | the server asked for a different state at a nonce this key already signed |
| `bundle-conflict` | yes | two fully signed states at one nonce |
| `storage` | no | a read or write failed; nothing was signed that is not on disk |
| `refused` | no | a proposal broke a rule and was not signed |
| `unpinned` | no | the epoch was taken without a chain view (dev only) |

### `ledger.js`: what the client saw (F8)

`createLedger({ unit, tableId? })` builds what `clientShouldSign` compares a proposal with from the **current
public table state**, not from replayed hand events, so a client that reconnects or backgrounds the page still
has a view.

- `observeTable(tblMsg)`: the seats (address, chips, bet) and whether a hand is running; hand-end events in the
  message are recorded too. A malformed message makes the ledger forget, because stale stacks are worse than none.
- `observeEvent({ type: 'hand-end', result }, epoch?)`: a live hand result keyed by `(epoch, handNo)`; the first
  account of a hand wins, a different second one is a conflict that never clears.
- `observedStatus({ base, roster, handNo })` -> `{ ok: true, observed: { deltas, rake, pot } }` or
  `{ ok: false, reason, detail, permanent }`. `delta_i = chips shown_i - floor(base.balances_i / unit)`, `rake =
  -sum(deltas)`, `pot` is the live result of `handNo` when this client watched it (else `null`). Reasons
  (`LEDGER_BLOCKERS`): `no-table`, `mid-hand` and `unknown-address` are waits (the next table message fixes
  them); `bad-seat`, `duplicate-address`, `stacks-exceed-base` and `conflict` are permanent and the signer
  refuses (`LEDGER`).
- `observedFor(args)`: the same, `null` instead of a reason. `conflicts()` lists every disagreement seen.

### `ids.js`

- `tableKeyFor({ chainId, vault, serverId, generation })` = `keccak256(utf8("pgg:" + chainId + ":" + vault + ":" + serverId + ":" + generation))`,
  vault lowercase. `serverId` is a non-empty, well-formed Unicode string without `:` (a lone surrogate would be
  encoded as U+FFFD and collide with the real U+FFFD, so it is a `RangeError`).
- `claimDigest({ domain, tableKey, address, playerId })` = `keccak256(utf8("PGG claim v1") || uint256(chainId) || vault (20 bytes) || tableKey (32 bytes) || address (20 bytes) || utf8(playerId))`.
- `signClaim(sessionPrivateKey, claim)`, `recoverClaim(claim, signature) -> address | null`,
  `verifyClaim(claim, signature, sessionKey) -> boolean` (`false` when `sessionKey` is not a string). A
  session-key proof of an on-chain seat; the server checks it against `seats(tableKey, address).sessionKey`.
  `playerId` must be well-formed Unicode too.

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
```

## Signer example

The client side in one page: a session key, an epoch checked against a chain view, a hand signed (twice, with
the identical signature), the bundle kept, then two lies refused. `test/signer.test.js` runs this code.

```js
// Signer example: one player's browser, from a new session key to a refused equivocation.
import {
  buildNextState,
  createLedger,
  createSigner,
  epochBaseline,
  hashState,
  privateKeyToAddress,
  RECORD_PREFIX,
  rosterHash,
  STATUS,
  signDigest,
  tableKeyFor,
  toWire,
} from '@pgg/vault';

export async function main() {
  const domain = { chainId: 31337, verifyingContract: '0x00000000000000000000000000000000000dead1' };
  const unit = 10_000n; // token base units per chip
  const tableKey = tableKeyFor({
    chainId: domain.chainId,
    vault: domain.verifyingContract,
    serverId: 'demo',
    generation: 1,
  });
  const key = (byte) => `0x${byte.repeat(32)}`;
  const arbiterKey = key('a1');
  const me = { wallet: privateKeyToAddress(key('01')), sessionKey: key('11') };
  const bob = { wallet: privateKeyToAddress(key('02')), sessionKey: key('22') };
  const players = [me, bob].sort((a, b) => (a.wallet < b.wallet ? -1 : 1)); // ascending, as the contract wants
  const deposit = 1000n * unit;

  // The chain view stands in for createRpcChainView over an RPC URL pinned in the app build. Here it answers
  // from a plain row: both players deposited 1000 chips and the arbiter started the table.
  const genesis = epochBaseline({
    tableId: tableKey,
    players: players.map((p) => p.wallet),
    deposits: players.map(() => deposit),
    nonce: 0n,
    rake: 0n,
    volume: 0n,
  });
  const row = {
    status: STATUS.Active,
    maxPlayers: 6,
    seated: 2,
    arbiter: privateKeyToAddress(arbiterKey),
    nonce: 0n,
    exitDeadline: 0n,
    minDeposit: 1n,
    maxDeposit: 10n ** 30n,
    escrow: 2n * deposit,
    rakePaid: 0n,
    rosterHash: rosterHash(genesis.players),
    exitDigest: `0x${'00'.repeat(32)}`,
  };
  const chainView = {
    table: async () => ({ ok: true, table: row }),
    seat: async (_tableKey, address) => {
      const p = players.find((x) => x.wallet === address);
      return { ok: true, seat: p ? { deposit, sessionKey: privateKeyToAddress(p.sessionKey) } : null };
    },
  };

  // A synchronous storage like localStorage. The signer keeps one JSON record per table in it.
  const map = new Map();
  const storage = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
  // newKey is injected only to make the example repeatable; the default draws a fresh random key
  const signer = createSigner({ storage, chainView, newKey: () => me.sessionKey });

  // 1. The session key is written BEFORE its address is returned: only then may the wallet deposit with it.
  const made = signer.ensureSessionKey(tableKey, { wallet: me.wallet, domain, unit });

  // 2. The epoch message is checked against the chain before anything is signed (F1).
  const epoch = {
    epoch: 1,
    domain,
    state: toWire(genesis),
    sessionKeys: players.map((p) => privateKeyToAddress(p.sessionKey)),
    arbiter: row.arbiter,
  };
  const pinned = await signer.handleEpoch(epoch, { wallet: me.wallet, domain, unit, maxRakeBps: 500 });

  // 3. Hand 1: I win 30 chips from bob and the house takes 1. The ledger keeps what this browser SAW.
  const ledger = createLedger({ unit });
  const chips = (p) => (p === me ? 1029 : 970);
  const seats = [me, bob].map((p, seat) => ({ seat, chips: chips(p), bet: 0, address: p.wallet }));
  const result = { handNo: 1, pot: 60, rake: 1, stacks: seats.map((s) => s.chips), busted: [] };
  ledger.observeTable({
    state: { handNo: 1, inHand: false, seats, vault: { epoch: 1 } },
    events: [{ type: 'hand-end', result }],
  });
  const state = buildNextState({
    prev: genesis,
    balances: players.map((p) => BigInt(chips(p)) * unit),
    rakeDelta: 1n * unit,
    volumeDelta: 60n * unit,
  });
  const digest = hashState(state, domain);
  const req = { epoch: 1, handNo: 1, state: toWire(state), digest };
  const signed = signer.handleSignReq(req, { ledger }); // on disk before it is returned
  const again = signer.handleSignReq(req, { ledger }); // a re-sent request: the identical signature

  // 4. Everyone signed: the bundle is kept only if every signature verifies against the pinned epoch.
  const stored = signer.acceptBundle({
    domain,
    state: toWire(state),
    arbiterSig: signDigest(arbiterKey, digest),
    playerSigs: players.map((p) => (p === me ? signed.sig : signDigest(p.sessionKey, digest))),
  });

  // 5. A server that moves 100 chips from me to bob between hands is refused (C1b: nothing at the table
  //    moved them), and so is a second state at the nonce I already signed (C1a): that is equivocation,
  //    and it stops all signing at this table for good.
  const moved = players.map((p) => BigInt(chips(p) + (p === me ? -100 : 100)) * unit);
  const lie = signer.handleSignReq(
    { epoch: 1, handNo: null, state: toWire(buildNextState({ prev: state, balances: moved })) },
    { ledger },
  );
  const twin = signer.handleSignReq(
    { epoch: 1, handNo: 1, state: toWire({ ...state, volume: state.volume + 1n }) },
    { ledger },
  );
  const failure = signer.failure(tableKey); // persistent: the app shows it as a banner, never a toast

  const record = JSON.parse(storage.getItem(RECORD_PREFIX + tableKey));
  return {
    key: made,
    pinned,
    signed,
    again,
    stored,
    lie,
    twin,
    failure,
    recorded: record.last.sig === signed.sig && record.sessionKey === me.sessionKey,
  };
}
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
- `chainview.test.js` and `chain/chainview.test.js`: the hand-written ABI codec against viem on random inputs, the
  JSON-RPC view against every kind of hostile or broken node (a fake `fetch` and a real HTTP server), every refusal
  rule of `verifyEpochAgainstChain`, the lying-server scenario, and the whole thing against a real anvil.
- `signer.test.js`: write-before-return proved with storage fakes that record call order, throw, or drop
  writes; equivocation; the final latch; bundles; corrupt and torn records; the signer over a real
  `createRpcChainView`. `ledger.test.js`: reconnects, aborted hands, conflicting accounts, unknown addresses.
  `hostile.test.js`: a MaliciousServer drives the real signer, ledger, rules and chain view through every attack
  in `docs/signing-layer.md` section 8 (no signature leaves), and an honest run with a leave, a final, the settle
  and a second epoch (nothing is refused). `signer-world.js` is their shared world.
- `rules.test.js`, `bundle.test.js`, `state.test.js`, `units.test.js`, `ids.test.js`, `build.test.js`, `abi.test.js`,
  `rake-ceiling.test.js`.
- `review-*.test.js`: the adversarial review of every module. A title starting with `REVIEW BUG` or `REVIEW GAP`
  is a finding that has been fixed and is now a regression test; a `test.todo` is a finding that was left open on
  purpose, with the reason in the first line of its body.
- The seeded generators are in `test/gen.js`, a small world (keys, table row) in `test/fixtures.js`.
