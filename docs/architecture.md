# Architecture

## What came from upstream (pok3rNetwork/pok3r @ 0437e8e, Sept 2022)

Concepts only; no upstream code remains. The old stack is recoverable with `git show 0437e8e:<path>`.

Kept as ideas: lobby lifecycle (waiting → active), ready-up, min bet / max players, off-chain game
logic with an on-chain escrow.

Replaced, and why (from reading the upstream source):

- `LobbyTracker.sol` / `DepositTracker.sol` are **custodial in practice**: `disseminate`, `ejectPlayer`
  and `abortGame` are `onlyOwner`, so the server key alone can rewrite any player's balance with no
  player signature. They also loop over unbounded arrays (`joinableLobbies()` scans every lobby) and
  ignore ERC-20 return values. The new vault requires player-signed state (Milestone 2).
- The REST API starts a match with an on-chain `startGame` transaction per lobby and keeps state in a
  file cache; it cannot scale. Replaced by in-memory single-writer table actors over WebSockets.
- Chainlink VRF dealing and Mumbai (deprecated) are dropped.
- The engine, a vendored ~1,100-line `holdem.js`, is replaced by `poker-ts` (MIT) for the betting
  state machine only. Settlement is our own; see the next section.

## poker-ts 1.5.0: what we do not trust

Fuzzing and load-testing `PokerTable` against `poker-ts` found five defects, and a sixth quirk that only
affects what is displayed. Each has a regression test.

1. **Lost payout.** The dealer nulls all-in players in its internal player list and the payout loop
   skips nulls, so a short-stack all-in player who *wins* is never paid and is then removed as
   "busted". Reproduced on bare `poker-ts`: ~35% of hands in the scenario of a 4-chip stack calling
   all-in against 5/10 blinds.
2. **Wrong pot structure.** A folded player's dead money goes entirely into the main pot, so an
   all-in player can win chips they have no claim to (standard rules cap it at what they put in).
3. **Lost eligibility.** Once a later betting round starts, all-in players are dropped from the
   pots' eligible lists. Consequences: if everyone else then folds, the rest of the board is never
   dealt; and the pot can be **awarded to a player who lost** (two short stacks that tied for the win
   were skipped and the pot went to a third player holding a worse hand).
4. **Hand ranking.** It ranks two sets of trips on seven cards wrongly (kings full of fours scored
   below the board's fours full of kings).
5. **Unbounded loops in `showdown()`.** Its odd-chip distribution is
   `do { i++ } while (array[i] === null)` over players it has already nulled, and `pot % 0` yields
   `NaN`, which never reaches zero. A server running `showdown()` froze once under load at 100% CPU
   with a constant memory footprint (a tight loop in JIT-compiled JS, seen with `gdb`). The exact
   input was **not** reproduced, so this is the leading suspect, not a proven cause.
6. **Folded bets vanish from view until the round is collected.** After a fold on the flop, turn or
   river, poker-ts moves the folder's bet into a private aggregate that neither `seats()` nor `pots()`
   reports until the betting round ends (and after a *preflop* fold it leaves the chips on the player
   instead). When a player folds to a raise while someone else still has to act, anything computed from
   poker-ts's seats and pots is short by the folded bet until the next action: the pot shown to players
   shrank and then jumped back, and our own "total chips" check read low. Payouts were never affected,
   since settlement works from what each seat has put in. This surfaced only in a CI run: the server's
   random-play test failed 36 times in 400 (about one engine-fuzz hand in 3,000 hits it, but that test
   re-raises with large amounts). The displayed pot and `totalChips()` are now computed from each seat's
   contribution (start-of-hand stack minus current stack), which is exact at every moment, and poker-ts's
   own books are cross-checked where they are complete, at the end of every betting round.

Design response, all in `packages/engine`:

- `poker-ts` is a betting state machine only: whose turn, legal actions and bet sizes, when a street
  ends. A **fresh `poker-ts` table is built for every hand and discarded**, and `showdown()` is never
  called, so none of its settlement code can run.
- Stacks, the dealer button, pots, winners and rake are ours (`table.js`, `settle.js`). Pots are built
  from per-seat contributions and hands are ranked with `pokersolver`.
- A board `poker-ts` leaves incomplete is dealt from the same committed deck, so the run-out is still
  covered by the fairness proof.
- `pokersolver` is validated against a brute-force reference evaluator (`test/reference-eval.js`):
  5,000 random showdowns, hand-picked edge cases, and every pot of the fuzz run.
- Chip conservation is asserted on every hand. Mid-hand, the table total is exact by construction (stacks are
  untouched while a hand runs) and poker-ts's seats-plus-pots total is cross-checked at the end of every
  betting round, when all bets are collected; a mismatch aborts and refunds the hand (see defect 6 for why
  this is not done after every single action).
- If any invariant ever fails, the table actor **aborts the hand and refunds everyone** instead of
  guessing, logs it, and keeps running (`abortHand`, `TableActor.#recover`).
- The server runs a **watchdog thread** that kills the process if its event loop stalls for 10 s, so a
  wedged process is restarted by its supervisor instead of silently serving nobody.

Evidence: five seeds of 10,000 hands each (`FUZZ_HANDS=10000 FUZZ_SEED=1..5 bun test packages/engine -t fuzz`)
pass with every cross-check active, and deliberate mutations of the engine and actor are caught by the
test suite. (An earlier version of this paragraph quoted a similar run from before the check described in
defect 6 existed; it is replaced by the run above.)

If `poker-ts` is upgraded, the regression tests show whether these are fixed. Because it is now used
only for betting, replacing it entirely is a small, well-bounded job.

## Dealing and fairness

`poker-ts` shuffles with `crypto.randomInt` inside a private `Deck`. That is secure but neither
reproducible nor committable, so `@pgg/engine` replaces the deck's `shuffle` with a deterministic one:

    deck = Fisher-Yates driven by HMAC-SHA256(serverSeed, context)

- The server commits `SHA256(serverSeed)` for hand N+1 **during hand N**, so players can answer with a
  client seed with no added latency, and the server cannot choose its seed after seeing them.
- After the hand, `serverSeed` is released to that hand's participants; `verifyHand` (browser-safe)
  recomputes the deck and checks the dealt cards and the commitment.
- Trade-off: a revealed seed also reveals mucked hole cards, so it goes to participants only, not the
  public lobby.
- This is **auditable, not trustless**: the server sees every card while a hand is live. `Dealer` is an
  interface so SRA mental poker can slot in later.
- The override reaches into `poker-ts` internals, so the version is pinned to an exact release and a
  test fails if the dealt cards ever stop matching the committed deck.

## Game server (`apps/server`)

- **Table actor.** `TableActor` owns one table: the engine, the dealer, the roster and the timers.
  Nothing else touches them, so state changes are serialised by construction and a table can later move
  to its own worker. It talks only to an injected `bus` and `clock`, so tests drive it with a fake clock.
- **Bun pub/sub.** Public table state is identical for every viewer: it is serialised **once** and
  published to the table's topic; Bun fans it out in native code. Hole cards are never on a topic; they
  go to the owning socket as a private `cards` message. Seeds are revealed only to the players dealt in.
- **Clients never name a table** after joining, so a client cannot act on another table. Every client
  message is validated (zod), size-limited (2 KB) and rate-limited per connection (40 burst, 20/s).
- **Money.** Chips move between wallet and table only in `join`, `rebuy` and `#remove`. Tests assert
  `wallet + chips at tables + house == issued` after every step of randomised play.
- **Disconnects.** A dropped player keeps the seat; the turn clock acts for them; after a grace period
  they are removed and refunded. Reconnecting resumes the seat, the state and the hole cards.
- **Lobby.** Only players who are not seated receive lobby broadcasts. (Pushing the full table list to
  seated players multiplied p99 latency by ~10 at 1,800 connections.)

## Web client (`apps/web`)

- **Mobile only.** Touch devices up to 900px get the app; everything else gets a QR code. Portrait is
  enforced with a rotate notice. Safe-area insets and `dvh` units are used throughout.
- **Light.** The initial download is **~118 KB gzip** (JS + CSS + HTML), checked against a 160 KB
  budget by `bun run size`. React and `motion` (the `m` component with `LazyMotion`) are the only
  runtime libraries; the QR generator and the fairness verifier are separate chunks loaded on demand.
  No web3 stack is in the bundle yet; Milestone 2 loads it lazily on the cashier screens.
- **A pure core.** Server messages go through one pure reducer (`lib/game.js`); a reconnecting socket
  (`lib/socket.js`) measures RTT and clock skew so the turn timer matches the server's deadline; the
  controller (`lib/client.js`) does the side effects: sending a fairness seed per upcoming hand,
  requesting a resync on a gap in `seq`, verifying every proof in the browser. All three are unit tested
  with fakes; none touch the DOM.
- **Motion.** Cards are dealt from the pot and flip in 3D; board cards flip in one after another; bets
  slide out to the felt and sweep into the pot; winnings fly to the winner. The turn timer is an SVG
  ring drained by a CSS animation, so it costs no JavaScript per frame. Everything animates only
  `transform` and `opacity`, and `prefers-reduced-motion` is honoured.
- **Layout is pixel-aware.** A seat is anchored by its avatar centre; cards and nameplate hang off it at
  fixed offsets, and the seat ring is computed from the real felt size (`lib/seats.js`), tested across
  three phone heights, 2-9 players and every hero seat.
- **Looked at, not just tested.** `bun run shots` drives a real phone-sized Chromium through login,
  lobby, buy-in, a live table against bots, a raise, a result, the fairness sheet and the desktop gate,
  and fails on console errors or content stuck at zero opacity (which Playwright otherwise counts as
  visible). Reviewing its screenshots found, among others: hole cards wiped by message ordering,
  white-on-white button text from an unlayered CSS reset, and a blank desktop gate from a missing
  animation provider. Each is fixed and has a guard.

Known gaps: the pot pill can touch one bet chip on the smallest (360x640) screens; there is no sound;
the desktop QR points at the page's own origin, which a phone cannot reach if that is `localhost`.

## Measured capacity

`bun apps/server/scripts/loadtest.js --tables N --clients 3 --seconds 15 --think 150`. One server
process, the load generator in three separate processes, a 4-core machine. Bots act about every 150 ms
(a person takes seconds), so each connection is far busier than a real player. Latency is measured by
the bots from sending an action until the broadcast containing it returns, so it includes their own
event-loop delay and is an upper bound for the server.

| Players (tables) | Actions/s | Hands/s | p50 / p95 / p99 | Server CPU | Memory |
| --- | --- | --- | --- | --- | --- |
| 1,800 (300) | ~1,780 | ~60 | 1.3 / 5 / 10 ms | 48% of a core | ~120 MB |
| 3,600 (600) | ~3,480 | ~119 | 1.7 / 12 / 73 ms | 79% | 169 MB |
| 6,012 (1,002) | ~5,200 | ~170 | 10 / 64 / 129 ms | 90% (near the limit) | 179 MB |

Zero errors in every run. A single Bun process is roughly one core's worth of table logic, so the way
to go beyond ~6,000 busy connections is to shard tables across processes by `hash(tableId)` behind a
gateway, with Redis for the lobby index and presence and Postgres for hand history and settlement. The
actor boundary above is built for that; it is Milestone 3. **Not yet measured:** multi-process scaling,
real network latency, and the cost of persistence.

Known limits at higher scale: the lobby list is sent whole (45 KB at 300 tables) in `welcome` and
broadcast to unseated players, and needs pagination or deltas well before thousands of tables; and
state is in memory, so a restart (or a watchdog kill) loses hands in flight.

## Escrow contract (`contracts/`)

`PokerVault.sol` is a non-custodial escrow: one deployment holds one ERC-20 on one chain (USDC on
Polygon, USDT on BSC). The game stays off-chain; the chain only guards the money.

- **Signed state.** Every hand produces an EIP-712 `State` signed by the server (the *arbiter*) and by
  **every player's session key**. The contract checks the signatures, that the roster is exactly the
  seated players, that `sum(balances) + rake == escrow` to the last unit, and that the nonce is higher
  than anything seen. It never evaluates poker.
- **Closing.** A state marked `isFinal` pays out at once and lets players `keep` their chips for the next
  epoch (join/leave/top up happen between epochs). Any other signed state must go through a time-locked
  dispute (`startExit`, `challenge`, `finalizeExit`), so a player holding an old state cannot cash it in.
- **Not custodial.** The owner can only pause new money and rotate the arbiter; the arbiter alone cannot
  pay anybody. Withdrawing is never paused. A recipient the token refuses cannot block a settlement.
- **Session keys** are registered at deposit time and have no on-chain expiry (see the trust model for
  why: an expiry that gates settlement would help a losing player stall).
- **Same code on both chains.** BSC is a second deployment with USDT; tables are per chain.

The signed-state typed data is shared with the clients in `packages/protocol/src/vault.js` and is
checked against the contract with real viem signatures.

The honest summary of what this does not give you (the dealing is server-side, a losing player can refuse
to sign and roll back one hand, someone must answer bad exits in time) is in
[trust-model.md](trust-model.md). The contract is **unaudited**.

## Status

Milestone 1 (engine, server, mobile UI, play-money) is complete. Milestone 2 has its core: the `PokerVault`
escrow with its tests and trust model. Still to do in Milestone 2: the signing layer in the server and web
client (session keys, per-hand signatures, the watchtower), the cashier and chain indexer, wallet connection,
and deployment on Polygon Amoy and BSC testnet. Milestone 3: scale hardening, audit prep.
