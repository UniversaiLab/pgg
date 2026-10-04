# contracts

Foundry project for `PokerVault`, the non-custodial escrow behind PGG's real-money tables.

**Status: unaudited. Testnet only.** Read [../docs/trust-model.md](../docs/trust-model.md) first: it says
what the contract guarantees and, just as important, what it cannot.

## How it works

```
createTable ──> Filling ──start──> Active ──settle(final state)──> Filling   (stayers roll over)
                  ▲  │                │
       deposit ───┘  └── leave        └─startExit──> Exiting ──finalizeExit──> Closed
                                                      ▲ │
                                          challenge ──┘ (higher nonce wins, window restarts)
```

- Players `deposit` at a table that is *Filling* and register a **session key**. The arbiter (game server)
  `start`s the epoch with the exact, address-sorted roster.
- After every hand the arbiter and every player's session key sign an EIP-712 `State`
  (`balances`, `nonce`, cumulative `rake` and `volume`, a `keep` flag per player, an `isFinal` flag).
- `settle` accepts only an `isFinal` state signed by everyone. It pays leavers now and keeps stayers'
  chips in the vault for the next epoch.
- Any other signed state can only be used through the dispute path: `startExit`, then anyone may
  `challenge` with a higher nonce, then `finalizeExit` once the window has passed. `startExitFromDeposits`
  exits from the original deposits when nothing was ever signed.
- A payout the token refuses (a blacklisted address) is parked in `withdrawable` instead of reverting.

| Role | Can | Cannot |
| --- | --- | --- |
| Player | deposit, leave while filling, start an exit, challenge, withdraw parked payouts | move chips without everyone's signature |
| Arbiter | create tables, start epochs, co-sign states, start an exit | move any funds alone |
| Owner | pause new deposits/tables/starts, rotate the arbiter for new tables | touch funds, block exits or settlement |

## Layout

| Path | What |
| --- | --- |
| `src/PokerVault.sol` | The contract (about 560 lines). |
| `test/PokerVault.t.sol` | Unit and fuzz tests. |
| `test/PokerVault.invariant.t.sol` | Stateful invariants with a random handler. |
| `test/Compat.t.sol` | Feeds the contract a state and signatures made by viem. |
| `test/vectors/state.json` | The shared vector. Regenerate with `bun run vector` from the repo root. |
| `test/mocks/` | Tokens that misbehave like real stablecoins, and a hostile contract player. |
| `script/Deploy.s.sol` | Deployment. |
| `slither.config.json` | Static-analysis settings. |

## Commands

```sh
# Foundry (https://getfoundry.sh). Developed against 1.5.1.
git submodule update --init                  # forge-std 1.9.7 and OpenZeppelin 5.6.1
forge build
forge test                                   # 85 tests
forge test --match-contract Invariant -vv    # also prints how often each path was reached
forge fmt --check

pip install slither-analyzer && slither . --config-file slither.config.json
```

The state's typed data lives in `packages/protocol/src/vault.js`. `bun run vector` rebuilds the shared
vector with viem; `bun test packages/protocol` fails if the committed vector is stale, and
`forge test` fails if the contract disagrees with it.

## Deploying

```sh
TOKEN=0x... HOUSE=0x... ARBITER=0x... OWNER=0x... \
  forge script script/Deploy.s.sol --rpc-url $RPC --private-key $KEY --broadcast --verify
```

There are no built-in token addresses on purpose. Take the official USDC (Polygon) or USDT (BSC) address
from the issuer's documentation, confirm it in an explorer, and check the symbol and decimals the script
prints before broadcasting. Use a multisig for `OWNER`, a KMS/HSM key for `ARBITER`, and an exit window of
24 hours or more on mainnet. One deployment escrows one token on one chain.

The code targets the Cancun EVM. According to the node sources, Polygon PoS, Amoy, BSC and BSC testnet
all enable it; confirm that again before each mainnet deployment.
