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

Fuzzing and load-testing `PokerTable` against `poker-ts` found five defects. Each has a regression test.

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
- Chip conservation is asserted on every hand **and after every single action**.
- If any invariant ever fails, the table actor **aborts the hand and refunds everyone** instead of
  guessing, logs it, and keeps running (`abortHand`, `TableActor.#recover`).
- The server runs a **watchdog thread** that kills the process if its event loop stalls for 10 s, so a
  wedged process is restarted by its supervisor instead of silently serving nobody.

Evidence: five seeds of 8,000 hands each (`FUZZ_HANDS=8000 FUZZ_SEED=... bun test -t fuzz`), and nine
deliberate mutations of the engine and actor, are all caught by the test suite.

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

## Status

See README. Milestone 1: engine, server, mobile UI, play-money. Milestone 2: Foundry vault, session keys,
cashier, indexer (Polygon Amoy, BSC testnet). Milestone 3: scale hardening, audit prep.
