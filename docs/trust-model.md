# Trust model of `PokerVault`

Read this before trusting the contract with money. It says what the vault guarantees, what it cannot,
and what the rest of the system must do for the guarantees to hold. **The vault has not been audited.
Do not use it with real funds until it has been.**

## The idea in one paragraph

Players lock tokens at a table. The game runs off-chain on our server. After every hand, the server (the
*arbiter*) and **every player's session key** sign a new `State` (who owns how much). The contract never
sees a hand; it only checks that a state is signed by everyone, adds up to the money in the vault, and
has a higher nonce than anything it saw before. Money leaves only through a state that all of them signed
or through a time-locked dispute in which the highest-nonce signed state wins.

## What the contract guarantees

Assuming the contract is correct (which is what the audit is for) and the token behaves like an ERC-20:

1. **Nobody can move your funds alone.** Not the owner, not the arbiter, not the house, not the other
   players. A payout needs your session key's signature on the state that pays it (or your own
   `leave` while the table is not running). Tested: `test_settle_arbiterAloneCannotMoveFunds`,
   `test_settle_playersAloneCannotMoveFunds`, `test_owner_hasNoWayToTakeFunds`.
2. **The server cannot be bypassed either.** A state also needs the arbiter's signature, so players
   cannot collude to rewrite the rake or the rules.
3. **Money is conserved exactly.** Every accepted state must satisfy
   `sum(balances) + rake paid now == tokens escrowed for the table`, to the last unit. Nothing is created
   or stranded. Invariants checked by random testing: the vault's token balance equals what it owes,
   what it owes equals table escrows plus parked payouts, and tokens are never created or destroyed.
4. **You can always get out** without anyone's cooperation, in bounded time:
   - table filling: `leave()` returns your stake at once;
   - table running: `startExit()` (from any state all parties signed) or `startExitFromDeposits()`,
     then after the challenge window `finalizeExit()`. Anyone can call it.
   - Pausing never blocks any of this. The owner can pause only *new* money (`createTable`, `deposit`,
     `start`).
5. **An old state cannot be cashed in on the spot.** Only a state the signers marked `isFinal` pays out
   immediately. Per-hand states can only be used through the challenge window, in which any state with a
   higher nonce replaces them. So a player who holds an old state in which they had more chips cannot just
   submit it; the other side has `EXIT_WINDOW` to answer with the newest.
6. **A blocked recipient cannot freeze a table.** A token that refuses a transfer (USDC blacklist, a
   paused token) does not make `settle` or `finalizeExit` revert; the amount becomes `withdrawable` for
   that address, who can pull it to any address the token accepts.
7. **The rake is bounded.** Cumulative rake never exceeds `MAX_RAKE_BPS` (at most 5%) of cumulative
   volume, and never decreases. (Volume is attested by the signers; see below.)
8. **Fee-on-transfer tokens are refused** at deposit (the balance delta must equal the amount), so the
   books start out equal to the real balance. Tokens whose balances change by themselves (rebasing) are
   not supported and must not be used.
9. **Signatures are bound to one deployment.** The EIP-712 domain carries the chain id and the vault's
   address, so a state signed for Polygon cannot be replayed on BSC or on another vault.

## What the contract cannot protect you from

### 1. Cheating in the game itself

The contract cannot see a hand. It trusts that the state everyone signed is the true result.

- **Dealing is server-side and auditable, not trustless.** The server sees every card while a hand is
  live and could, in principle, peek or deal itself good cards. The commit-reveal scheme (see
  `docs/architecture.md`) lets players verify afterwards that the shuffle matched the commitment, but it
  does not stop a dishonest operator from *reading* hands. An independent review of the dealing/RNG is a
  gate before real money. Mental poker (SRA) is the planned trustless upgrade behind the `Dealer`
  interface.
- **Player collusion and bots** are a game-integrity problem that no escrow contract solves.

### 2. A losing player refusing to sign (rollback of the last hand)

This is the main economic weakness of any design where every state needs every player's signature.

Suppose a player lost a big hand. The server asks everybody to sign the new state. If that player refuses
(and stops playing), the latest state that *everyone* signed is the one before the hand. The player can
then exit from that older state and undo the loss.

What limits it:

- The server must not deal hand *n+1* until hand *n*'s state has all signatures, so a refusal can undo at
  most the hand that was just played, not a whole session. Size tables and stakes with this exposure in
  mind: it is bounded by the largest pot a player can lose in one hand.
- Refusing is visible and attributable: the player's own session key signed every earlier state. The
  operator can ban them, and with identity checks (legal gate before real money) can pursue them.
- Cheaper and stronger fixes are possible later (a per-player bond, or pre-hand commitments). They are not
  in this contract. **This risk is accepted by design, and the audit should look at it.**

### 3. Liveness: someone has to answer a bad exit

If a player starts an exit from a stale state, the correct state must be submitted before the window
closes. That needs somebody online with the newest fully signed state:

- the server runs a watchtower that watches `ExitStarted` and answers with `challenge`;
- clients keep their latest fully signed state and challenge when they see a stale exit while online.

If nobody answers within `EXIT_WINDOW`, the stale state stands. Choose a window of at least 24 hours on
mainnet. The contract allows 1 hour to 30 days; testnets can be short.

### 4. Key compromise

| Key | If stolen | Limit |
| --- | --- | --- |
| Player's wallet | Attacker can deposit/leave/withdraw that player's funds where the contract lets the wallet act. | Only while a table is Filling; once Active the wallet cannot move chips. |
| Player's session key (browser memory) | With the arbiter's cooperation, signs away that player's chips at that table. | Fresh key per table; discard on leave. One table only. |
| Arbiter key alone | Cannot move funds. Can create tables, start epochs, co-sign states. | Needs every player's signature for any payout. Rotate with `setArbiter` (affects new tables; old tables keep theirs). Use KMS/HSM. |
| Owner key | Can pause new deposits and rotate the arbiter for new tables. Cannot touch funds. | Use a multisig. |
| Arbiter + all session keys | Total loss of that table. | Same as above. |

Session keys deliberately have **no on-chain expiry**. An expiry checked when a state is *applied* would
let a losing player run out the clock so that a validly signed state can no longer be used, which is
exactly the rollback attack above. The key's lifetime is enforced off-chain instead: the arbiter refuses
to co-sign with a key it considers expired, and every state needs the arbiter.

### 5. The token

The vault holds a real ERC-20. If the issuer freezes or blacklists the *vault's address*, or pauses the
token, nothing the vault does can move the funds. A recipient the token refuses is handled (see 6 above),
but a vault-wide freeze is outside any contract's control. Decide how much to hold per vault.

### 6. Chain and infrastructure

Reorgs, congested chains, RPC outages and mempool front-running are outside the contract. The cashier
must wait for confirmations before it treats a deposit as real (Milestone 2, cashier/indexer).

## Things that are deliberate, and their cost

- **One member can force a table to close.** Any seated player (or the arbiter) can start an exit at any
  time. That is the guarantee that nobody is trapped, and also a griefing tool: the table closes after the
  window. The server should treat repeated exits as abuse.
- **Rosters are fixed per epoch.** Joining, leaving and topping up happen between epochs, through a
  `final` state in which each player says whether they stay (`keep`). Stayers' chips remain in the vault
  and are not re-deposited.
- **Roster stuffing / start griefing.** Anyone can deposit at a filling table up to its seat limit and
  `leave` again, which can make an `start` call revert if their deposit lands first. The arbiter's remedy
  is a fresh table id (there is no on-chain eviction, to keep the surface small).
- **`volume` is self-attested.** The cap on rake relies on a number all signers agreed on. It protects
  against a server bug, not against a server and every player conspiring.
- **Direct token transfers to the vault are unrecoverable.** The vault tracks only what it owes. There is
  no sweep function, so there is no admin path to funds either.
- **No `permit` deposit yet.** Players approve, then deposit (two transactions).
- **The arbiter of a table is fixed when it is created**, so rotating the global arbiter cannot strand
  running tables, at the price that a lost arbiter key for a running table leaves its players to
  `startExitFromDeposits` or the last state they hold.

## Rules the clients and the server must follow

The contract can only enforce so much. These are requirements for honest implementations, and the test
suite for the server and web client should cover them when the signing layer is built.

Every player's client:

1. Sign a state only if it extends the last state you signed: nonce strictly higher, your balance equal to
   what you saw at the table, and the totals conserved. Never sign two different states with one nonce.
2. Sign an `isFinal` state only when you are leaving or rotating, and sign nothing with a higher nonce in
   that epoch afterwards.
3. Store the latest state that carries *everyone's* signatures, durably (not just in memory).
4. While online, watch for `ExitStarted` on your table and `challenge` if the exit is stale.

The server (arbiter):

1. Do not deal hand *n+1* before hand *n*'s state has every signature.
2. Run the watchtower described above.
3. Refuse to co-sign with a session key past its policy expiry.
4. Never sign two states with the same nonce.

## Parameters to decide per deployment

| Parameter | Meaning | Guidance |
| --- | --- | --- |
| `TOKEN` | The one ERC-20 escrowed | Look up the official address in the issuer's docs and check it in an explorer. The deploy script prints symbol and decimals. |
| `EXIT_WINDOW` | Seconds a dispute stays open | 1 hour minimum, 30 days maximum. 24-72 hours on mainnet. |
| `MAX_RAKE_BPS` | Rake / volume ceiling | At most 500. Product rake is 2%; leave headroom for rounding and caps. |
| `HOUSE` | Receives rake | Treasury multisig. |
| `ARBITER` | Server signing key | KMS/HSM. |
| `OWNER` | Pause and arbiter rotation | Multisig with a timelock if possible. |

The contract targets the Cancun EVM (OpenZeppelin 5.6 uses `MCOPY`). From the node sources, Polygon PoS
(mainnet block 54,876,000, Amoy 5,423,600) and BSC (June 2024; testnet earlier) enable it. Re-check
before each mainnet deployment.

## How it was tested

- **85 Foundry tests**: 75 unit and fuzz tests covering each function, each rejection path, rollover,
  every exit path, blacklisted recipients, pausing, fee-on-transfer and no-return tokens, 6 and 18
  decimals, and re-entrancy by a contract player through an ERC-777-style token hook; 3 cross-language
  tests; 1 deploy-script test; 6 stateful invariant tests.
- **Stateful invariants** (256 runs x 120 calls) drive random deposits, hands, cooperative settles with
  rollover, exits from stale and fresh states, challenges, finalising, blacklisting and withdrawals. A
  scripted test proves every path is reached, and a per-run counter showed thousands of settles, exits,
  challenges and parked payouts across the runs.
- **Mutation check.** I broke the contract on purpose in 26 ways (removing each signature, nonce, roster,
  conservation, rake, window and accounting check, and more) and required the suite to fail each time.
  All 26 were caught. The exercise also exposed two real gaps in my own tests, both now fixed:
  1. The invariant suite first passed while barely reaching exits, rollovers or parked payouts (its
     random calls rarely chained far enough). It was rewritten with whole-step actions and a coverage
     counter.
  2. Removing the roster check was caught only by one test that failed for an incidental reason. The
     real attack (two players and the arbiter signing a consistent state that omits a depositor and
     shares out their money) went untested, and it does succeed without that check. It now has a direct
     test through `settle`, `startExit` and `challenge`.
  Likewise the first re-entrancy tests passed with the guard deleted; they were replaced by tests that
  fail when `nonReentrant` is removed from `leave`, `withdraw` or `settle`.
- **Cross-language**: the browser/server side builds the typed data with viem; the Foundry suite feeds the
  contract a state and signatures made by viem and requires the same digest and an accepted `settle`.
  Changing either side without the other fails a test (checked by editing the type string).
- **Slither 0.11.6**: no high or medium findings. The 11 informational items are: zero-initialised locals
  (intended), comparisons against `block.timestamp` for windows of an hour or more (intended), one
  storage write inside a loop of at most ten payouts (accepted), and upper-case immutable names
  (convention).
- **Size and gas**: 14,763 bytes of runtime code (limit 24,576). `deposit` costs about 120-180k gas,
  `settle` 65-220k depending on the table size, `startExit` about 130k.

None of this replaces an independent audit. Sections 2 and 3 above, the signature scheme, and the
payout fallback are the parts to point the auditors at first.
