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

Fuzzing `PokerTable` against `poker-ts` found four defects. Each is reproduced by a regression test.

1. **Lost payout.** The dealer nulls all-in players in its internal player list and the payout loop
   skips nulls, so a short-stack all-in player who *wins* is never paid and is then removed as
   "busted". Reproduced on bare `poker-ts`: ~35% of hands in the scenario of a 4-chip stack calling
   all-in against 5/10 blinds.
2. **Wrong pot structure.** A folded player's dead money goes entirely into the main pot, so an
   all-in player can win chips they have no claim to (standard rules cap it at what they put in).
3. **Lost eligibility.** After the first betting round that follows an all-in, the all-in player is
   dropped from the pots' eligible list. If everyone else then folds, `poker-ts` thinks one player
   is left and **never deals the rest of the board**.
4. **Hand ranking.** It ranks two sets of trips on seven cards wrongly (kings full of fours scored
   below the board's fours full of kings).

Mitigation, all in `packages/engine`:

- `settle.js` builds pots from per-seat contributions and ranks hands with `pokersolver`; the table
  then makes its stacks match, re-seating a wrongly removed winner (`ledger().repairs` counts how
  often). `poker-ts` still drives legal actions, turn order, blinds and streets.
- A board `poker-ts` leaves incomplete is dealt from the same committed deck, so the run-out is still
  covered by the fairness proof.
- `pokersolver` is validated against a brute-force reference evaluator in `test/reference-eval.js`
  (5,000 random showdowns plus hand-picked edge cases), and the fuzz test checks every pot against it.
- Chip conservation is asserted on every hand and throws rather than continuing.

Evidence: five seeds of 8,000 hands each (`FUZZ_HANDS=8000 FUZZ_SEED=... bun test -t fuzz`) pass with
`poker-ts` mis-ranking 2 to 7 of roughly 10,700 comparable pots per seed and needing settlement repair
in about 6.7% of hands (the profile is deliberately short-stack heavy).

If `poker-ts` is upgraded, the regression tests will show whether these are fixed. A longer-term option
is to replace its betting state machine too; the `PokerTable` surface is small enough to swap.

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

## Status

See README. Milestone 1: engine, server, mobile UI, play-money. Milestone 2: Foundry vault, session keys,
cashier, indexer (Polygon Amoy, BSC testnet). Milestone 3: scale hardening, audit prep.
