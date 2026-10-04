# The signing layer

How the game server, the browsers and the chain keep `PokerVault` in step with the hands being played. Read
[trust-model.md](trust-model.md) first (what the contract guarantees and what it cannot) and
`packages/vault/README.md` (the pure library every piece below is built on).

Status: this is the design the code is written against, revised after an adversarial review (findings are cited
as F1..F17 in the code comments and tests where they shaped a rule). Where code and text disagree, fix whichever
is wrong and say so in the commit.

## 1. What happens to one hand

```
hand ends in the engine
  TableActor.#onHandEnd  ->  vault.onHandEnd(snapshot)            (before #reconcile; must never throw)
      state n+1 = epoch base + balances (chips x chipUnit + dust), cumulative rake and volume
      checkState(state, null, ctx)            refuse a state the contract would refuse: halt instead of signing
      store.reserve(...)                      the arbiter's double-sign guard (primary key table+nonce)
      arbiterSig = signer.signReserved(tableKey, nonce)    store.attachArbiterSig(...)
  TableActor publishes the public table state (the stacks every player sees), then vault.flush():
      signreq -> every claimed member (private)          deadline = now + signTimeoutMs
  each client: clientShouldSign(...) against ITS OWN view -> write {nonce,digest,sig} durably -> send sig
  coordinator: recover over the server's own digest for that nonce == the seat's session key -> store.addPlayerSig
  last signature in (one store transaction): makeBundle + verifyBundle + saveBundle (monotone)
      + phase update + (if the state was final) enqueue the settle job
      bundle(n) -> every member, BEFORE any signreq(n+1)             round closes
  gate opens: vault.canDeal() -> true -> TableActor.#scheduleStart() deals the next hand
```

Nothing is dealt while a round is open. A hand that aborts produces no state (stacks are unchanged, so the last
bundle is still right). **Chips after a restart come from the highest reserved state of the epoch**, not from the
last bundle: if round n was open, the next state must be built on state n.

## 2. Epochs and the table lifecycle

The vault's roster is frozen while a table is Active, so a vault table lives in **epochs**:

```
creating --TableCreated--> filling --(every depositor claimed, >= 2, startHoldMs elapsed)--> starting --Started--> active
active --(round past deadline)--> stalled --(late sigs)--> active
active/stalled --(stall timeout)--> stall exit --ExitStarted--> exiting --(settle of a final)--> filling
exiting --Challenged*--> --finalizeExit--> closed
active --(final bundle complete)--> settling --Settled--> filling   (stayers carry their balance over)
settling --ExitStarted with nonce >= the final's--> exiting         (a member front-ran the settle; keep is then ignored)
any --(fatal invariant failure)--> halted; recoverable ones (stale chain cache, paused vault) retry with backoff
closed --> generation + 1, new tableKey, creating
```

- `tableKey = tableKeyFor({chainId, vault, serverId, generation})`. A Closed table can never be reused, so the
  generation is persisted and bumped. **`chipUnit`, blinds, `rakeBps` and `numSeats` are pinned per tableKey in
  the store**; the server refuses to resume a table under a different configuration (a changed unit silently
  changes everyone's chip counts and breaks the clients' pinned unit).
- **Two baselines, never confused** (F7). `depositState` (volume 0) is used only for `startExitFromDeposits` and
  the `finalizeExit` digest. `epochBase` is `{nonce: N0, rake: rakePaid, volume: cumulative volume at the last
  settle, balances: deposits}` and is the baseline for `buildNextState`, `checkState` and the clients.
  `epochBaseNonce` is persisted, and `head = nonceHw > epochBaseNonce ? nonceHw : null`: the first hand of an
  epoch has no head, whatever the previous epoch's final nonce was.
- **Rotation** ends an epoch. Reasons: `leave`, `bust` (**chips == 0**; dust alone never keeps a seat, it is
  paid out), `idle` (sat out >= `idleKickHands` hands while connected), `drain` (operator), `maintenance` (epoch
  older than `maxEpochMs`, or more than `maxEpochHands`, or the oldest session key about to pass its policy age,
  see below). `join` and `topup` rotations are a later phase.
- **A due rotation is folded into the hand-end state**: that state is `isFinal` with `keep` flags
  (`keep[i] = chips_i > 0 && !leaving && !kicked`). A rotation requested between hands proposes a standalone
  final at the next nonce with unchanged balances. After a final is proposed nothing else is proposed in that
  epoch. After `Settled` the server waits `startHoldMs` before `start`, so a kept player who wants out can
  `leave()` first.
- A disconnect never removes a player (the contract cannot drop a roster member). It sets them away; if they
  stay away the table stalls (section 6).
- Balances: `balance_i = chipsOf(entry_i) * chipUnit + dust_i`. `chipsOf` covers seated, waiting and sit-out
  entries (the engine's `result.stacks` does not). Dust is kept apart and added back so conservation is exact.
  `rake` and `volume` are cumulative since the table was created and are restored from the store.
- Rake: a vault table's `rakeBps` must be <= the vault's `MAX_RAKE_BPS` (checked at creation); product rate 2%.
- **Session-key policy age (S3)** is counted from the key's `Deposited`/`SessionKeySet` event. The epoch ends at
  `min(maxEpochMs, oldestKeyRegisteredAt + policyMaxMs - margin)`, so a table rotates *before* the arbiter would
  have to refuse a co-signature, never on one (F14). A pilot table therefore lives at most one key lifetime.

## 3. Identity (interim)

A member **claims** their on-chain seat by signing `claimDigest({domain, tableKey, address, playerId})` with the
seat's session key. Order of checks, cheapest first (F12): the table is a vault table; the player is not seated
elsewhere; `chain.seat(address)` exists (a deposit still below confirmation depth answers the **retryable**
`claim-pending`, not `bad-claim`); the member is a depositor/roster member; only then the ECDSA recovery against
`seat.sessionKey`. Rules:

- The latest valid claim for an address wins and **re-keys** the binding: the actor migrates `entry.playerId`,
  `#byPlayer`, `#hole`, `#participants` and subscriptions from the old id to the new one (`rekey`), and calls
  `onSeat(old, null)`, `onSeat(new, tableKey-table)`. Dev-login ids change on every login, so a 12-hour epoch
  spans re-logins routinely. Re-binds are rate limited **per address**, not only per socket.
- A claim is valid only while `chain.seat(address).sessionKey` still equals the key that signed it
  (`deposit()` overwrites the key); it is re-checked at `start` and whenever `sessionKeyOf` is used.
- `claim` is accepted in `stalled`, `exiting`, `settling` and `halted` for existing roster members, so late
  `signreq`s can be received, and members stay registered (`onSeat`) through those phases. After a restart the
  registry is empty: a client with a stored vault record claims first on every `welcome` with `seated: null`.
- Claims are not replay-protected beyond playerId and tableKey in the digest (identity only, never funds). SIWE
  replaces the authentication later; session-key signing stays.

## 4. Interfaces

All of these are synchronous from the actor's point of view. Chain I/O happens in the background and comes back
as events or as a changed cached view.

### StateStore (`apps/server/src/vault/store.js`; `MemoryStore` and `SqliteStore` pass one shared test suite)

```js
store.transaction(fn)                                   // atomic; returns fn's result
store.loadTable(tableKey) / saveTable(record)           // { tableKey, serverId, generation, epoch, phase, roster,
                                                        //   pinned: {chipUnit, blinds, rakeBps, numSeats},
                                                        //   epochBaseNonce, nonceHw, rakeCum, volumeCum, rakePaid,
                                                        //   dust: {address: bigint}, lastAppliedEvent: {block, logIndex}, updatedAt }
store.reserve(tableKey, state, digest)                  // PRIMARY KEY (table, nonce). Same digest again: idempotent.
                                                        //   A different digest at an existing nonce throws DoubleSignError.
                                                        //   Advances nonceHw, rakeCum and volumeCum in the same transaction.
store.attachArbiterSig(tableKey, nonce, sig)
store.addPlayerSig(tableKey, nonce, address, sig)       // idempotent; a different sig for the same (nonce, address) is ignored and reported
store.playerSigs(tableKey, nonce) -> Map<address, sig>
store.getSigned(tableKey, nonce) / latestSigned(tableKey) -> { state, digest, arbiterSig|null } | null
store.openRound(tableKey) -> the highest signed nonce in the CURRENT epoch that has no complete bundle at or above it | null
store.saveBundle(tableKey, bundle, expect) -> { saved, reason? }   // verifies first (with expect = domain/table/roster); monotone;
                                                        //   an equal nonce with a different digest is reported as a conflict (alarm), not saved
store.loadBundle(tableKey) -> the newest bundle OF THE CURRENT EPOCH (nonce > epochBaseNonce) | null
store.loadFinalBundle(tableKey) -> the last epoch's final bundle (kept for the watchtower), | null
store.enqueueJob(job) -> boolean                        // idempotent by job.key; job = { key, kind, tableKey, priority }
store.pendingJobs() / markJob(key, status, patch)       // patch may carry txHash, attempts, error
store.getCursor() / setCursor(blockNumber)              // always written in the SAME transaction as the jobs it caused
store.close()
```

SQLite: `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA locking_mode=EXCLUSIVE;` (the exclusive lock is
a lease: two arbiters on one file is a bug and fails at open). Everything that matters is written **before** the
message that depends on it is sent. At boot and at every claim the server compares `nonceHw` with the chain's
nonce and with any bundle a client presents (bundles are self-authenticating): if the evidence is *higher* than
the store, the server adopts the bundle or halts that table (a restored old database must never make the server
propose a different state at a nonce clients already signed) (F10). The interface is deliberately small so a
Postgres version can replace it when tables are sharded.

### Chain actions: ONE reconciler (F3, F5)

Jobs carry **no bundle or state**: the executor reads the current best one from the store at execution time,
re-reads `chain.table()`, and simulates first. Job keys are per table and kind (`chain-action:{tableKey}`; one
action in flight per table). The decision is a pure, table-driven function
`nextChainAction(storeView, chainView, chainTime) -> job | null`, used by BOTH the coordinator and the
watchtower, evaluated **level-triggered** on every tick and on startup (events are only a hint):

| Chain row | Current-epoch bundle B | Action |
| --- | --- | --- |
| Active | none | nothing (stall: `startExitFromDeposits`) |
| Active | B final | `settle(B)` |
| Active | B not final | nothing (stall: `startExit(B)`) |
| Exiting, chain nonce < B.nonce | B final | `settle(B)`, **never** `challenge` |
| Exiting, chain nonce < B.nonce | B not final | `challenge(B)` if `chainTime + challengeMarginSec < exitDeadline` |
| Exiting, nonce equal, digest equal | any | wait; `finalizeExit` after the deadline |
| Exiting, nonce equal, digest differs | any | alarm (unless B is absent and the exit is the epoch's `depositState`, which is correct) |
| Exiting, chain nonce > B.nonce | any | alarm; try adoption of a client-presented bundle |
| Filling or Closed | any | done |

A job is *done* only when a re-read of `chain.table()` shows the intended effect at confirmation depth
(`startExit`: `exitDigest` equals its target or a higher nonce is in force; `settle`: status Filling and nonce
>= the bundle's). `StaleNonce`/`WrongStatus` with any other chain state is a `JobFailed` alarm, never success. A
reorged transaction is therefore retried on the next tick. The stall `startExit` job has a `guard()` that
re-checks "round still open, chain still Active, stall timeout still elapsed" and aborts otherwise.

`finalizeExit` picks its struct by **digest equality** with `chain.table().exitDigest`, in this order: the
current-epoch bundle's state, the stored signed state for the exit's nonce, the rebuilt deposit state
(from `seat.deposit` while the roster hash is still readable); it verifies equality before sending.

Execution (F6): `ViemChain` sends `settle`, `challenge` and `finalizeExit` (all permissionless) from a separate
funded **relayer** account and keeps the arbiter key for digest signing, `createTable`, `start` and the stall
`startExit`. A priority queue runs challenge > settle > finalize > startExit > start > createTable. It records
the tx hash per job and replaces a stuck transaction (same account nonce, fee bumped after N blocks). It alarms
on a low gas balance and on RPC lag (a stale `chainTime`). Anyone can submit a stored bundle if the operator is
down; that is documented, not built.

### ChainPort (`chain-port.js`; `FakeChain` for unit tests, `ViemChain` for anvil and real chains)

```js
chain.info                       // { chainId, vault, arbiter, relayer, maxRakeBps, exitWindowSec }
chain.table(tableKey) -> null | { status, nonce, escrow, rakePaid, rosterHash, exitDeadline, exitDigest, arbiter,
                                  seated, maxPlayers, minDeposit, maxDeposit }   // cached; a periodic re-read repairs a missed event
chain.seat(tableKey, address) -> null | { deposit, sessionKey, confirmed }
chain.chainTime() -> seconds      // latest known block timestamp; never Date.now() for contract deadlines
chain.submit(job)                // idempotent by job.key
chain.subscribe(sink) -> unsubscribe
```

Events (from the poll timer, never from inside a call; each carries `tableKey`, `block`, `logIndex`):
`TableCreated`, `Deposited`, `SessionKeySet`, `Left`, `Started {players}`, `Settled {nonce, rakePaid, rakeDelta,
stayers}`, `ExitStarted {by, nonce, digest, deadline}`, `Challenged`, `ExitFinalized`, `Payout`, and a synthetic
`JobFailed {key, kind, error, retryable}`. The last applied event position is persisted with the state change it
caused; anything at or below it is ignored, and the phase is recomputed from `(store, chain.table)` on boot. A
paused vault makes `start` fail with a retryable `JobFailed` and backoff, not a halt.

### ArbiterSigner

`{ address, signReserved(tableKey, nonce) -> signature }` (synchronous for the local key). It signs only a
digest the store has *reserved* for that table and nonce, so a coding mistake cannot sign an arbitrary digest.
In the `sig` handler the server recovers over its own digest for that nonce and uses the client's `digest`
field only as a consistency check. A KMS/HSM signer is asynchronous and a later change (the
reserve-sign-attach order already allows it).

### VaultCoordinator (`coordinator.js`), one per vault table

Constructed with `{ cfg, store, chain, signer, clock, host }`. `host` is what the `TableActor` provides:
`send(playerId, msg)`, `publishStatus()`, `unseat(address, {reason, chips})`, `scheduleStart()`. Time comes only
from the injected monotonic `clock` (not `Date.now()`), so an NTP step cannot fire an exit early. The actor calls:

```js
coordinator.init()                                  // load, reconcile with the chain, resume or recover (see section 5)
coordinator.claim(playerId, {address, sig}) -> {ok}|{ok:false, code, msg}
coordinator.sign(playerId, {nonce, digest, sig}) -> {ok}|{ok:false, code, msg}   // late or duplicate: {ok:true}, silent
coordinator.onHandEnd(snapshot)                     // { handNo, result: {pot, rake}, entries: [{address, chips, leaving, connected, status}] }; never throws
coordinator.flush()                                 // send what onHandEnd queued (after the actor has published)
coordinator.requestLeave(playerId)                  // acks with the head nonce; see the client leave rule in section 8
coordinator.onConnect(playerId) / onDisconnect(playerId)   // resend epoch, newest bundle, then the open signreq
coordinator.canDeal() -> boolean                    // S1, with verify/tableId/domain/head supplied
coordinator.publicView() -> TableState.vault
coordinator.onChainEvent(event) / tick()
```

### TableActor in vault mode

Optional injected `vault`. Play tables never have one and behave exactly as before. `isVault` is true. `join` and
`rebuy` fail with `vault-locked`; `leave` requests a rotation and never refunds; `#onDrop` only marks the player
away; `#remove`/`#reconcile` become `#park`; chips leave the table only when `Settled` is observed
(`host.unseat`). The wallet is a `NullWallet` (`debit` fails, `credit`/`creditHouse` do nothing). The deal gate is
checked in `#scheduleStart` and again at the top of `#dealHand`; opening it calls `#scheduleStart()` itself. A
hand in flight when a member-started `ExitStarted` arrives is allowed to finish and its state is proposed and
collected (so a challenge can raise the exit); nothing new is dealt; it is abandoned on `ExitFinalized` or `Settled`.

## 5. Durability and crash recovery

- Arbiter order: **reserve, sign (`signReserved`), attach, send**. The reservation guards against two digests at
  one nonce across restarts. `saveBundle` + phase = settling + `enqueueJob(settle)` are one transaction.
- On `init()` after a restart, in this order:
  1. a round whose signatures are all stored but whose bundle was not saved: complete it now;
  2. reserved but not signed: re-sign the same digest (RFC 6979 gives identical bytes);
  3. a round was open: re-issue it **verbatim** (state, digest, arbiter signature) with a fresh deadline, keeping
     stored player signatures (those members are not asked again);
  4. a hand was in flight: abandoned like `abortHand`; chips come from the **highest reserved state** of the epoch;
  5. the roster is rebuilt as placeholders; the gate stays closed until every member has re-claimed;
  6. recompute the phase from `(store, chain.table)`; replay a stored final bundle whose nonce is above the chain's.
- The server sends `bundle(n)` before `signreq(n+1)`. The client baseline is the higher of its newest verified
  bundle and its own last signed state (it signed that one, so it extends it).
- Clients write their `{nonce, digest, sig}` record **before** sending the signature and re-send the identical
  signature if asked again for the same digest. A second digest at a signed nonce is refused and shown as a
  persistent failure.

## 6. Stall policy

| Knob | Pilot default | Meaning |
| --- | --- | --- |
| `signTimeoutMs` | 30 000 | soft deadline in the `signreq` |
| resend | +10 s, +20 s | to members who are connected |
| `absentGraceMs` | 90 000 | a member offline longer than this counts as a stall |
| `stallExitMs` | 600 000 (testnet 120 000) | from `gateClosedSince` or the first missed deadline |
| `challengeMarginSec` | 3 x block time + bump | `challenge` is only attempted this far before the deadline (chain time) |
| `claimWindowMs` / `startHoldMs` | 120 000 / 15 000 | filling: wait for claims; pause before `start` |
| `minEpochHands` / `maxEpochHands` / `maxEpochMs` | 3 / 500 / 12 h | rotation pacing |
| `idleKickHands` | 3 | sit-out hands before a proactive kick while still connected |

`gateClosedSince` (F11) is set whenever the deal gate is closed for `member-offline` or `member-not-claimed`
with no round open (between hands, after a restart, a sit-out member offline); after `absentGraceMs +
stallExitMs` of continuous closure the stall exit starts, so a quiet table cannot hold everyone forever.

The stall exit is `startExit(B)` if the current epoch has a bundle with `B.nonce > chain nonce`; otherwise
`startExitFromDeposits(roster)` (in the first round of an epoch the previous final's nonce equals the chain's, so
`startExit` would revert `StaleNonce`). **A late signature does not reopen the table**: it changes which state an
exit pays out (the watchtower challenges with the newer bundle). The real recovery is **exit recovery**: if all
members return inside the window, the coordinator completes the open round, then proposes a standalone final
with `keep = true` for everyone with chips (`reason: 'exit-recovery'`), and when it is all-signed `settle`s it.
`settle` is valid during Exiting even after the deadline until someone calls `finalizeExit`, so the table goes
back to Filling instead of Closed. After the deadline anyone (a griefer, the relayer) can call `finalizeExit`, so
the server calls it promptly and relies on no grace.

Longest a single player can hold a table: between hands offline, `absentGraceMs + stallExitMs + W`; open round,
silent, `stallExitMs + W`, plus at most one more `W` if they sign at the very end and the server challenges;
Filling with a withheld claim, unbounded for that table (contract limit, F13): the server creates the next
generation after `claimWindowMs` and tells claimed members to move; a front-running depositor can deny new
tables at the cost of gas only. (`W` = the exit window.)

## 7. Watchtower

`apps/server/src/vault/watchtower.js` is the *runner* of `nextChainAction`, nothing more: on every tick (and on
startup) it reads each live table and the store, asks the reconciler, and submits what it returns. Events trigger
an immediate tick but are never the only trigger. The cursor and the jobs they cause are one transaction, so a
crash cannot skip an exit. Epoch scoping: "latest bundle" means the current epoch's; with no bundle in this epoch
the correct exit digest is `hash(depositState)` and only a different digest alarms.

## 8. Client side

`@pgg/vault` supplies the rules; `apps/web/src/lib/vault.js` is a lazily imported controller (off the initial
bundle). Rules that go beyond the library's predicates:

- **Chain-pinned epochs (F1).** The controller takes an injectable `ChainView` (default: a plain `eth_call` over
  `fetch` to an RPC URL and vault address **pinned in the app build, never taken from a server message**; the
  test double is `FakeChain`). Before signing the first state of any epoch and after every `epoch` message it
  checks that `tables(tableKey)` is Active (or Filling then Active) with `nonce` equal to the genesis nonce,
  `rosterHash` equal to `rosterHash(players)`, `escrow` equal to `sum(balances) + rake - rakePaid`; that
  `seats(tableKey, p).sessionKey` equals `sessionKeys[i]` for every roster member; and that its own balance
  equals its own deposit (or the previous final's balance if it stayed). `last` is a per-tableKey monotone
  high-water mark; `isFinal` is cleared **only** when the chain read shows the table settled (nonce >= the
  final's and status Filling or a newer Active). A genesis with a nonce below `last.nonce` is refused. A client
  that signed a final signs nothing higher until that holds. Without a `ChainView` a client is unprotected
  against a lying server; that is a gate before real money, not a silent default.
- **What the client compares a proposal with (F8).** Its own ledger, built from the **current public table
  state** (the stacks every player sees between hands), not from replayed hand events: `delta_i = chips shown_i -
  chips in the base state_i`, `rake delta = -sum(delta_i)`, and the volume delta must only be non-negative and
  within the rake cap (exact pot equality is checked when the client watched the hand live). Dust is constant
  per player. The safety-critical checks are the client's *own* balance and conservation; per-other-seat checks
  need the seat-to-address map and are advisory when an address is unknown. The `reason` field of a `signreq`
  is never used.
- **Finals (F13).** A final state is acceptable unless it extends a final; `keep[me]` must be false if I asked to
  leave (except for states at or below the head nonce the server had acked when I pressed Leave, which are
  signed and I `leave()` in Filling); `keep[i]` is refused for any seat whose balance is below one chip unit; a
  `keep[me]=false` I did not ask for is accepted (it is a cash-out, never a loss).
- **Storage.** The session key is written to `localStorage` synchronously **before** any deposit exists. A
  returning client whose storage was wiped never auto-generates a replacement key for an Active seat: it shows
  "key lost, the table will exit" and stays a non-signer (the stall exit still returns the funds). The newest
  all-signed bundle is replaced only when every signature verifies against the pinned roster/domain and the
  nonce is higher. **Nothing is deleted on a server message.** Records are deleted only after the client's own
  chain read shows the table settled or Closed and `W` has passed (F15).
- **Two tabs.** The controller takes a Web Lock per tableKey and signs only in the lock-holding tab; a
  BroadcastChannel hands bundles to the other tab.
- Play-money tables never touch any of this (no import, no storage access, no logging).

## 9. Configuration

Vault tables are opt-in (`VAULT_TABLES=1` or a `vault` block in the table config); the four default play tables
are unchanged. Per table: `numSeats` (default 6), `chipUnit` (10 000 for a 6-decimal stablecoin = 0.01 per chip),
`rakeBps` (200), blinds and buy-in range in chips. Per server: chain id, RPC URL, vault address, arbiter key
(development only), relayer key, database path, and the policy table above. `RATE_CAPACITY` below the
signature cost (10) is rejected at startup.

## 10. Known gaps, stated plainly

- **Free rollback option on every hand.** A player with positive equity in a hand can refuse to sign when they
  lose and exit from n-1; a busted player who closes the app has the same effect on the winners. The default
  needs no malice. With six seats and a 2% chance per player of being unreachable at a hand end, a table stalls
  on roughly one hand in nine. Mitigations: ban refusers by address, cap pots against stakes, a "stepping away"
  flow that rotates a player out before they background the app. Real fixes are in the contract (`refundSeat`,
  then eviction).
- **No client watchtower and no self-exit UI in this step.** Exits need a wallet. Until they ship, guarantee 1 of
  the trust model ("nobody can move your funds alone") does not hold in practice against a hostile arbiter: the
  arbiter can `startExit` an old bundle and nobody answers. It is a gate before real money.
- Filling no-shows and roster stuffing (contract level).
- Safari may purge `localStorage` after about 7 days; iOS freezes backgrounded pages, so auto-signing happens only
  while the page is alive. `navigator.storage.persist()` now; IndexedDB and a service-worker signer later.
- Reorgs deeper than the confirmation depth, an RPC outage blinding the watchtower, arbiter gas funding, a KMS
  signer. Server restarts abandon the hand in flight (the previous state stays valid).

Deliberately not here: cashier and deposit UI, SIWE and wallet connect, KYC and legal gating, a production
indexer, multi-chain, Postgres and sharding, waitlist and top-up rotations, and any contract change.
