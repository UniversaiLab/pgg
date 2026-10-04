# PGG

Mobile-only Web3 poker. Players join Texas Hold'em tables from a phone browser; money (later) sits in a
non-custodial escrow contract, gameplay runs off-chain on a fast Bun server.

Derived from [pok3rNetwork/pok3r](https://github.com/pok3rNetwork/pok3r) (MIT) — see [NOTICE](NOTICE).
Plain JavaScript (ES modules) everywhere; only the contracts are Solidity.

## Layout

| Path | What |
| --- | --- |
| `packages/engine` | Hold'em table (`poker-ts`), commit-reveal dealer, rake. `@pgg/engine/fairness` is browser-safe. |
| `packages/protocol` | zod schemas for every client↔server message. |
| `apps/server` | Hono + Bun WebSocket game server. |
| `apps/web` | Mobile-only React client (Vite, Tailwind, motion). |
| `contracts/` | Foundry escrow (Milestone 2). |
| `docs/` | Architecture and trust model. |

## Run

```sh
bun install
bun test              # engine + server tests
bun run dev:server    # game server
bun run dev:web       # mobile client (open on a phone, or a phone-sized viewport)
bun run lint
```

## Status

Milestone 1 (play-money vertical slice) is in progress. **No real-money path exists yet**, and none will be
enabled before an independent audit and legal review. See [docs/architecture.md](docs/architecture.md).
