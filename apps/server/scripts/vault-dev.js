// A local vault table to play against: starts anvil, deploys MockToken + PokerVault, funds an arbiter and a
// relayer, and runs the game server with one vault table next to the play-money ones. Prints what the web
// app needs. `--bots N` seats N VaultBots that deposit, claim, sign and play (default 0).
//
//   bun run vault:dev [--bots 2] [--port 8787]
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deployVault, startAnvil } from '@pgg/vault/testing';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { loadConfig } from '../src/config.js';
import { createGame } from '../src/server.js';
import { realClock } from '../src/table-actor.js';
import { createVaultSetup } from '../src/vault/boot.js';
import { VaultBot } from '../test/chain/vault-bot.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const BOTS = Number(arg('bots', 0));
const PORT = arg('port', '8787');
const UNIT = 10_000n; // chipUnit default: 0.01 of a 6-decimal token per chip

// Dev keys derived from fixed names: never fund these anywhere but this local chain.
const key = (name) => keccak256(toHex(`pgg-vault-dev:${name}`));
const arbiterKey = key('arbiter');
const relayerKey = key('relayer');

const node = await startAnvil();
for (const k of [arbiterKey, relayerKey]) {
  await node.testClient.setBalance({ address: privateKeyToAccount(k).address, value: 10n ** 21n });
}
const deployed = await deployVault(node, {
  arbiter: privateKeyToAccount(arbiterKey),
  exitWindow: 3600,
  maxRakeBps: 500,
});
const dir = mkdtempSync(join(tmpdir(), 'pgg-vault-dev-'));

const config = loadConfig({
  ...process.env,
  PORT,
  VAULT_TABLES: '1',
  VAULT_SERVER_ID: 'dev',
  VAULT_TESTNET: '1',
  VAULT_CHAIN_ID: String(node.chainId),
  VAULT_RPC_URL: node.rpcUrl,
  VAULT_ADDRESS: deployed.vault,
  VAULT_ARBITER_KEY: arbiterKey,
  VAULT_RELAYER_KEY: relayerKey,
  VAULT_DB_PATH: join(dir, 'vault.sqlite'),
  VAULT_POLL_MS: '250',
});
const vault = await createVaultSetup(config.vault, { clock: realClock });
const game = createGame(config, { vault });
const coordinator = () => game.vault.runtime.coordinator('vault-1');
const tableKey = () => coordinator()?.tableKey;

console.log(`
pgg vault dev
  server        ${game.url}   (websocket ${game.wsUrl})
  anvil rpc     ${node.rpcUrl}   chain id ${node.chainId}
  vault         ${deployed.vault}
  token         ${deployed.token}   (MockToken, 6 decimals; anyone may call mint(to, amount))
  sqlite        ${join(dir, 'vault.sqlite')}

web app (apps/web/.env.local):
  VITE_VAULT_RPC_URL=${node.rpcUrl}
  VITE_VAULT_ADDRESS=${deployed.vault}
  VITE_VAULT_CHAIN_ID=${node.chainId}
`);

const bots = [];
if (BOTS > 0) {
  // deposits need the table on chain: wait until the coordinator has seen TableCreated
  const end = Date.now() + 30_000;
  while (coordinator()?.phase !== 'filling' && Date.now() < end) await Bun.sleep(100);
  if (coordinator()?.phase !== 'filling') throw new Error('the vault table was not created on chain');
  console.log(`table key ${tableKey()}`);
  for (let i = 0; i < BOTS; i += 1) {
    const bot = new VaultBot({
      httpUrl: game.url,
      wsUrl: game.wsUrl,
      name: `Bot ${i + 1}`,
      seed: (i + 1) * 7919,
      node,
      deployed,
    });
    await bot.login();
    await bot.connect();
    await bot.deposit(tableKey(), 500n * UNIT, UNIT);
    bot.claim();
    bot.autoplay = true;
    bots.push(bot);
    console.log(`${bot.name} deposited 500 chips and claimed`);
  }
  // a line per signed hand, so it is visible that the table plays and every state gets signed
  let last = '';
  setInterval(() => {
    const view = coordinator()?.publicView();
    const line = `phase ${view?.phase}  epoch ${view?.epoch}  signed nonce ${view?.nonce}`;
    if (line !== last) console.log(line);
    last = line;
  }, 500);
}

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const bot of bots) {
    bot.close();
    bot.controller?.close();
  }
  const chain = game.vault.chain;
  game.stop();
  await chain.close();
  await node.stop();
  process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
