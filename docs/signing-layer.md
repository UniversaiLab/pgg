# The signing layer

How the game server, the browsers and the chain keep `PokerVault` in step with the hands being played. Read
[trust-model.md](trust-model.md) first (what the contract guarantees and what it cannot) and
`packages/vault/README.md` (the pure library every piece below is built on).

Status: this document is the design the code is written against. Where the code and this text disagree, fix
whichever is wrong and say so in the commit.

## 1. What happens to one hand

```
hand ends in the engine
  TableActor.#onHandEnd  ->  vault.onHandEnd(snapshot)            (before #reconcile; must never throw)
      build State n+1 from balances (chips x chipUnit + dust), cumulative rake and volume
      checkState(state, null, ctx)            reject a state the contract would refuse (halt instead of signing)
      store.reserve(...)                      the arbiter's double-sign guard (primary key table+nonce)
      arbiterSig = signer.signDigest(digest)  store.attachArbiterSig(...)
  TableActor publishes the public table state, then vault.flush()
      signreq -> every claimed member (private)          deadline = now + signTimeoutMs
  each client: clientShouldSign(...)  -> write {nonce,digest,sig} durably -> send sig
  coordinator: recover signer == the seat's session key -> store.addPlayerSig
  last signature in: makeBundle + verifyBundle + store.saveBundle (monotone)
      bundle -> every member (they store it durably)       round closes
      if the state was isFinal: chain.submit(settle)
  gate opens: vault.canDeal() -> true -> TableActor.#scheduleStart() deals the next hand
```

Nothing is dealt while a round is open. A hand that aborts produces no state (stacks are unchanged, so the
last bundle is still right).

## 2. Epochs and the table lifecycle

The vault's roster is frozen while a table is Active, so a vault table lives in **epochs**:

```
creating --TableCreated--> filling --(all depositors claimed, >=2)--start job--> starting --Started--> active
active --(round past deadline)--> stalled --(late sigs)--> active
active/stalled --(stall timeout)--> startExit job --ExitStarted--> exiting --Challenged*--> --ExitFinalized--> closed
active --(final bundle complete)--> settling --Settled--> filling   (stayers carry their balance over)
any --(invariant failed)--> halted (gate shut; after the stall timeout startExit from the last bundle)
closed --> generation + 1, new tableKey, creating
```

- `tableKey = tableKeyFor({chainId, vault, serverId, generation})`. A Closed table can never be reused, so the
  generation is persisted and bumped.
- **Rotation** ends an epoch. Reasons: `leave`, `bust` (balance 0: the contract forbids `keep` with a zero
  balance), `idle` (sat out >= `idleKickHands` hands while connected), `drain` (operator), `maintenance`
  (epoch older than `maxEpochMs` = 12 h, which is also the session-key policy expiry, or more than
  `maxEpochHands`). `join` and `topup` rotations are a later phase.
- **A due rotation is folded into the hand-end state**: that state is `isFinal` with `keep` flags
  (`keep[i] = balance > 0 && !leaving && !kicked`). A player who busts and walks away therefore costs nothing:
  they sign the bust hand like everyone else. A rotation requested *between* hands proposes a standalone final
  state at the next nonce with unchanged balances. After a final is proposed nothing else is proposed in that
  epoch.
- A disconnect never removes a player (the contract cannot drop a roster member). It sets them away and, if
  they stay away, the table stalls (section 6).
- Balances: `balance_i = chipsOf(entry_i) * chipUnit + dust_i`. `chipsOf` covers seated, waiting and sit-out
  entries (the engine's `result.stacks` does not). Deposits need not be multiples of `chipUnit`; the remainder
  is that player's dust, kept apart and added back so conservation is exact. `rake` and `volume` are
  cumulative since the table was created and are restored from the store after a restart.
- Rake: a vault table's `rakeBps` must be <= the vault's `MAX_RAKE_BPS` (checked at creation); the product rate
  is 2% (200 bps).

## 3. Identity (interim)

Players are uuid dev-logins with no wallet. For this step a member **claims** their on-chain seat by signing
`claimDigest({domain, tableKey, address, playerId})` with the seat's session key; the server recovers it and
compares with `chain.seat(tableKey, address).sessionKey`. A forged binding gets an attacker nothing (they cannot
sign states). The latest valid claim for an address wins and replaces the previous socket binding. SIWE replaces
the authentication later; session-key signing stays. Claims carry no server nonce, so a captured claim can be
replayed (identity only, never funds).

## 4. Interfaces

All of these are synchronous from the actor's point of view. Chain I/O happens in the background and comes back
as events.

### StateStore (`apps/server/src/vault/store.js`; `MemoryStore` and `SqliteStore` pass one shared test suite)

```js
store.transaction(fn)                                   // atomic; returns fn's result
store.loadTable(tableKey) / saveTable(record)           // record: { tableKey, serverId, generation, epoch, phase,
                                                        //   roster: [addresses], nonceHw, rakeCum, volumeCum, rakePaid, updatedAt }
store.reserve(tableKey, state, digest)                  // PRIMARY KEY (table, nonce). Same digest again: idempotent.
                                                        //   A different digest at an existing nonce throws DoubleSignError.
                                                        //   Also advances nonceHw, rakeCum and volumeCum in the same transaction.
store.attachArbiterSig(tableKey, nonce, sig)
store.addPlayerSig(tableKey, nonce, address, sig)       // idempotent; a different sig for the same (nonce, address) is ignored and reported
store.playerSigs(tableKey, nonce) -> Map<address, sig>
store.getSigned(tableKey, nonce) / latestSigned(tableKey) -> { state, digest, arbiterSig|null } | null
store.openRound(tableKey) -> the highest signed nonce that has no complete bundle at or above it | null
store.saveBundle(tableKey, bundle, verifyCtx) -> { saved, reason? }   // verifies first; monotone (a lower or equal nonce is not saved; equal nonce with a different digest is an alarm)
store.loadBundle(tableKey) -> bundle | null
store.enqueueJob(job) -> boolean                        // idempotent by job.key
store.pendingJobs() / markJob(key, status, patch)
store.getCursor() / setCursor(blockNumber)              // watchtower's log cursor
store.close()
```

SQLite: `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;` The process may be SIGKILLed by the watchdog, so every
write that matters happens **before** the message that depends on it is sent. The interface is deliberately
small so a Postgres version can replace it when tables are sharded.

### ChainPort (`chain-port.js`; `FakeChain` for unit tests, `ViemChain` for anvil and real chains)

```js
chain.info                       // { chainId, vault, arbiter, maxRakeBps, exitWindowSec }
chain.table(tableKey) -> null | { status, nonce, escrow, rakePaid, rosterHash, exitDeadline, exitDigest, arbiter,
                                  seated, maxPlayers, minDeposit, maxDeposit }          // cached, updated on every observed event
chain.seat(tableKey, address) -> null | { deposit, sessionKey }
chain.chainTime() -> seconds      // latest known block timestamp; never Date.now() for contract deadlines
chain.submit(job)                // idempotent by job.key; job = { key, kind, tableKey, args }
chain.subscribe(sink) -> unsubscribe
```

Job kinds and args: `createTable {maxPlayers, minDeposit, maxDeposit}`, `start {players}`, `settle {bundle}`,
`startExit {bundle}`, `startExitFromDeposits {players}`, `challenge {bundle}`, `finalizeExit {state}`.
Every job re-reads the chain at execution time and simulates first; `StaleNonce`/`WrongStatus` mean "already
done", `ExitWindowClosed` is an alarm. One serial executor per arbiter account, so there is no nonce race.

Events delivered to sinks (from the poll timer, never from inside a call): `TableCreated`, `Deposited`,
`SessionKeySet`, `Left`, `Started {players}`, `Settled {nonce, rakePaid, rakeDelta, stayers}`,
`ExitStarted {by, nonce, digest, deadline}`, `Challenged {by, nonce, digest, deadline}`, `ExitFinalized`,
`Payout {to, amount, pushed}`, and a synthetic `JobFailed {key, kind, error, retryable}`. Each carries `tableKey`.

### ArbiterSigner

`{ address, signDigest(digest) -> signature }` (synchronous). `LocalKeySigner(privateKey)` is for development; a
KMS/HSM signer must be asynchronous and is a later change (the reserve-then-sign-then-attach order already
allows it).

### VaultCoordinator (`coordinator.js`), one per vault table

Constructed with `{ cfg, store, chain, signer, clock, host }`. `host` is what the `TableActor` provides:
`send(playerId, msg)`, `publishStatus()` (re-publish `TableState.vault`), `unseat(address, {reason, chips})`,
`scheduleStart()`, `now()`. The actor calls:

```js
coordinator.init()                                  // load from the store, reconcile with the chain, resume or recover
coordinator.claim(playerId, {address, sig}) -> {ok}|{ok:false, code, msg}
coordinator.sign(playerId, {nonce, digest, sig}) -> {ok}|{ok:false, code, msg}   // late or duplicate: {ok:true}, silent
coordinator.onHandEnd(snapshot)                     // snapshot = { handNo, result: {pot, rake}, entries: [{address, chips, leaving, connected, status}] }; never throws
coordinator.flush()                                 // send what onHandEnd queued (after the actor has published)
coordinator.requestLeave(playerId)
coordinator.onConnect(playerId) / onDisconnect(playerId)   // resend the open signreq and the latest bundle on connect
coordinator.canDeal() -> boolean                    // S1
coordinator.publicView() -> TableState.vault
coordinator.onChainEvent(event)                     // subscribed by the wiring
```

Outbound messages are `epoch`, `signreq`, `bundle` (see `packages/protocol`). They are sent with `host.send`, which
silently drops if the player has no socket, so everything pending is re-sent in `onConnect`.

### TableActor in vault mode

Optional injected `vault` (a coordinator). Play tables never have one and behave exactly as before.
`isVault` is true. `join`, `rebuy` fail with `vault-locked`; `leave` requests a rotation and never refunds;
`#onDrop` only marks the player away; `#remove`/`#reconcile` become `#park` (stand the engine seat up, keep the
entry at zero chips, no wallet); chips leave the table only when `Settled` is observed (`host.unseat`). The
wallet is a `NullWallet` whose `debit` fails and whose `credit`/`creditHouse` do nothing, so a missed call site
fails closed instead of minting play money. The deal gate is checked in `#scheduleStart` and again at the top of
`#dealHand`; opening it calls `#scheduleStart()` itself.

## 5. Durability and crash recovery

- Arbiter order is **reserve, sign, attach, send**. The reservation is the guard against signing two digests at
  one nonce, across restarts.
- On restart:
  - reserved but not signed: re-sign the same digest;
  - a round was open: re-issue it **verbatim** (same state, digest and arbiter signature) with a fresh deadline,
    keeping the player signatures already stored (those members are not asked again);
  - a hand was in flight: abandoned, exactly like `abortHand` (balances come from the last bundle);
  - the roster is rebuilt as placeholders; the gate stays closed until every member has re-claimed, and the
    stall-exit clock starts at boot.
- Clients write their `{nonce, digest, sig}` record to durable storage **before** sending the signature, and
  re-send the identical signature if asked again for the same digest. A second digest at a signed nonce is
  refused and shown to the player as a persistent failure.

## 6. Stall policy

| Knob | Pilot default | Meaning |
| --- | --- | --- |
| `signTimeoutMs` | 30 000 | soft deadline in the `signreq` |
| resend | +10 s, +20 s | to members who are connected |
| `absentGraceMs` | 90 000 | a member offline longer than this counts as a stall |
| `stallExitMs` | 600 000 (testnet 120 000) | from the first missed deadline, start `startExit(latest bundle)` |
| `claimWindowMs` | 120 000 | filling: wait for depositors to claim before alerting |
| `minEpochHands` / `maxEpochHands` / `maxEpochMs` | 3 / 500 / 12 h | rotation pacing and session-key policy expiry |
| `idleKickHands` | 3 | sit-out hands before a proactive kick while still connected |

On a missed deadline the phase becomes `stalled`, the awaiting seats are published, and the round **stays open
and keeps accepting late signatures**. At the stall timeout the coordinator submits `startExit` from the latest
*all-signed* bundle (nonce n-1 while round n is open). The exit is reversible by a late signature: the open
round is kept through `exiting`, and if the missing member signs inside the window the watchtower submits
`challenge(bundle n)`. Any player can also start an exit themselves at any time.

## 7. Watchtower

`apps/server/src/vault/watchtower.js` consumes `ChainPort` events for the server's own tables. On
`ExitStarted`/`Challenged` it compares the event nonce with the stored all-signed bundle: bundle higher means
`challenge(bundle)` (job key `challenge:{tableKey}:{nonce}`); equal nonce but a different digest, or a lower
bundle nonce, is an alarm; no bundle means the deposit-based exit is the right baseline and nothing is
challenged. It finalizes after the window (chain time), supplies `finalizeExit` with the exact struct whose
digest the exit holds (bundle state, else `depositState`, else a stored signed state by digest), and on startup
replays any stored final bundle whose nonce is above the chain's. Events are idempotent, so replay after a crash
is safe. `ViemChain` polls `getLogs` from a persisted cursor behind a confirmation depth (1 on anvil, >= 10 on
Polygon).

## 8. Client side

`@pgg/vault` supplies the rules (`clientShouldSign`, `decideSign`, `verifyBundle`); `apps/web/src/lib/vault.js`
is a lazily imported controller (off the initial bundle). It generates the session key and writes it to
`localStorage` synchronously **before** any deposit exists, keeps the durable sign record and the newest
all-signed bundle (replaced only when every signature verifies and the nonce is higher), and never wipes them
on logout or unseat while funds are at a table. The client's own ledger of what it saw at the table (per-hand
chip deltas, rake and pot) is what `clientShouldSign` compares a proposal with; the `reason` field of a
`signreq` is never used for that. Play-money tables never touch any of it.

## 9. Configuration

Vault tables are opt-in (`VAULT_TABLES=1` or a `vault` block in the table config); the four default play
tables are unchanged. Per table: `numSeats` (<= 6 by default), `chipUnit` (token base units per chip; 10 000 for
a 6-decimal stablecoin gives 0.01 per chip), `rakeBps` (200), blinds and buy-in range in chips. Per server:
chain id, RPC URL, vault address, arbiter key (development only), database path, and the policy table above.

## 10. What is deliberately not here

Cashier and deposit UI, SIWE and wallet connect, KYC and legal gating, a production indexer, multi-chain,
Postgres and sharding, KMS signing, client-side chain watching and the self-exit UI, waitlist and top-up
rotations, exit recovery, and any contract change (`refundSeat` and player eviction are the first contract
items before real money).
