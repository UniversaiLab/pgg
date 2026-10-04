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
- The engine, a vendored ~1,100-line `holdem.js`, is replaced by `poker-ts` (MIT; side pots and hand
  evaluation included).

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
