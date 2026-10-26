# Deploying PGG

Two modes:

- **Play money** (no chain): `bun run build:web`, then `PGG_SECRET=… WEB_DIST=apps/web/dist bun apps/server/src/index.js`.
- **Real money (vault tables)**: everything below. **Testnets only until the contract audit, the legal review
  and the dealing/RNG review are done** (see `docs/trust-model.md`).

## 1. Try it locally (one command)

```sh
cd apps/server && bun run vault:dev --bots 2
```

This starts anvil, deploys a MockToken and a PokerVault, and runs the server with one vault table and two bot
players. It prints the `VITE_VAULT_*` values. Put them in `apps/web/.env.local` and run `bun run dev:web` to play
from a phone browser that has a wallet. `apps/web/scripts/vault-browser.js` runs the whole flow in a real
Chromium with a test wallet: sign in, deposit, play, leave, get paid.

## 2. Testnet (Polygon Amoy 80002, BSC testnet 97)

Keys you need (all fresh, never reused):

| Key | Holds | Notes |
| --- | --- | --- |
| deployer | gas for two deployments | any account |
| arbiter (`VAULT_ARBITER_KEY`) | gas for createTable / start / stall exits | the vault's arbiter; signs every state |
| relayer (`VAULT_RELAYER_KEY`) | gas for settle / challenge / finalizeExit | keep it funded; the server alarms when it runs low |
| owner | nothing | a multisig on mainnet; can pause new deposits and rotate the arbiter only |
| house | receives the rake | a treasury address |

Deploy a mintable test token and the vault:

```sh
cd contracts
HOUSE=0x… ARBITER=0x<arbiter address> OWNER=0x… \
  forge script script/DeployTestnet.s.sol --rpc-url $RPC --broadcast --private-key $DEPLOYER_KEY
```

It prints the MockToken and PokerVault addresses. The exit window defaults to 1 hour (the minimum).

## 3. Server

```sh
PGG_SECRET=<32+ random bytes, stable across restarts> \
WEB_DIST=apps/web/dist \
VAULT_TABLES=1 \
VAULT_TESTNET=1 \
VAULT_CHAIN_ID=80002 \
VAULT_RPC_URL=https://<your Amoy RPC> \
VAULT_ADDRESS=0x<PokerVault> \
VAULT_ARBITER_KEY=0x<arbiter private key> \
VAULT_RELAYER_KEY=0x<relayer private key> \
VAULT_DB_PATH=/var/lib/pgg/vault.sqlite \
VAULT_CONFIRMATIONS=3 \
SIWE_DOMAINS=play.example.com \
bun apps/server/src/index.js
```

- `VAULT_DB_PATH` is the arbiter's memory: the double-sign guard and every all-signed state. Put it on a
  persistent disk and back it up. It is opened with an exclusive lock, so a second server on the same file fails
  at start. Never run two servers for one vault with different files.
- Without `VAULT_DB_PATH` the server uses an in-memory store and warns: fine for a demo, wrong for money.
- `VAULT_TESTNET=1` shortens the stall exit to 2 minutes. On mainnet leave it out (10 minutes).
- Other knobs (chip unit, blinds, seats, timeouts) are listed in `apps/server/src/vault/vault-config.js`.

## 4. Web app

Build it with the chain pinned. The browser checks every epoch against this RPC, never against the server:

```sh
VITE_VAULT_CHAIN_ID=80002 \
VITE_VAULT_ADDRESS=0x<PokerVault> \
VITE_VAULT_RPC_URL=https://<a public Amoy RPC the browser can reach> \
bun run build:web
```

Serve it over **HTTPS** on the domain in `SIWE_DOMAINS` (wallets refuse to sign in on plain HTTP pages other than
localhost). Players open the site in their wallet app's browser (MetaMask, Coinbase Wallet, Rabby…), tap
**Sign in with wallet**, open the **Real money** table, tap **Get test USDC**, then deposit.

## 5. Mainnet (not yet)

Use `script/Deploy.s.sol` with the issuer's real token address, looked up in the issuer's docs and checked in an
explorer. Use a 24 to 72 hour exit window, a multisig owner and a KMS/HSM arbiter key. The gates come first:
an independent audit of `PokerVault`, a legal review, a review of the dealing/RNG, and the contract change that
lets a table drop a silent player without stopping everyone (see `docs/trust-model.md`, section 2 and
"Liveness").
