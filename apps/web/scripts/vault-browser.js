// The real-money flow in a real browser, end to end on a local chain: anvil + PokerVault, the game server with
// one vault table, the web app built for that chain, a phone-sized Chromium whose wallet (window.ethereum) is a
// test key, and one VaultBot opponent. The page logs in, connects the wallet, mints test tokens, deposits,
// takes the seat, plays signed hands, leaves, and is paid out on chain. Screenshots go to --out.
//
//   bun scripts/vault-browser.js [--out /tmp/pgg-vault-shots] [--hands 3]
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deployVault, startAnvil } from '@pgg/vault/testing';
import { chromium } from 'playwright-core';
import { loadConfig } from '../../server/src/config.js';
import { createGame } from '../../server/src/server.js';
import { realClock } from '../../server/src/table-actor.js';
import { createVaultSetup } from '../../server/src/vault/boot.js';
import {
  accountOf,
  INJECTED_PROVIDER,
  testWalletHandler,
} from '../../server/test/chain/test-wallet.js';
import { VaultBot } from '../../server/test/chain/vault-bot.js';

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : fallback;
};
const OUT = resolve(arg('out', '/tmp/pgg-vault-shots'));
const HANDS = Number(arg('hands', 3));
const WEB = resolve(import.meta.dirname, '..');
const UNIT = 10_000n;
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const chromePath = () => {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  const found = [...new Bun.Glob('chromium-*/chrome-linux/chrome').scanSync({ cwd: root })]
    .sort()
    .at(-1);
  if (!found) throw new Error(`no Chromium under ${root}`);
  return join(root, found);
};

const node = await startAnvil();
const key = (name) =>
  `0x${Buffer.from(new Bun.CryptoHasher('sha256').update(`pgg-vault-browser:${name}`).digest()).toString('hex')}`;
const arbiterKey = key('arbiter');
const relayerKey = key('relayer');
const playerKey = key('player');
const privateKeyToAccount = accountOf;
for (const k of [arbiterKey, relayerKey, playerKey]) {
  await node.testClient.setBalance({ address: privateKeyToAccount(k).address, value: 10n ** 21n });
}
const deployed = await deployVault(node, {
  arbiter: privateKeyToAccount(arbiterKey),
  exitWindow: 3600,
  maxRakeBps: 500,
});
const player = privateKeyToAccount(playerKey).address;
const balanceOf = async (address) =>
  node.publicClient.readContract({
    address: deployed.token,
    abi: deployed.tokenAbi,
    functionName: 'balanceOf',
    args: [address],
  });

// the web app, built for this chain (the chain view and domain are pinned in the build)
const dist = mkdtempSync(join(tmpdir(), 'pgg-vault-web-'));
const build = Bun.spawnSync(['bunx', 'vite', 'build', '--outDir', dist, '--emptyOutDir'], {
  cwd: WEB,
  env: {
    ...process.env,
    VITE_VAULT_RPC_URL: node.rpcUrl,
    VITE_VAULT_ADDRESS: deployed.vault,
    VITE_VAULT_CHAIN_ID: String(node.chainId),
  },
  stdout: 'ignore',
  stderr: 'pipe',
});
if (build.exitCode !== 0) throw new Error(`web build failed: ${build.stderr}`);

const dbDir = mkdtempSync(join(tmpdir(), 'pgg-vault-db-'));
const config = loadConfig({
  PORT: '0',
  HOST: '127.0.0.1',
  PGG_SECRET: 'vault-browser',
  WEB_DIST: dist,
  TURN_MS: '15000',
  INTER_HAND_MS: '800',
  WATCHDOG_MS: '0',
  VAULT_TABLES: '1',
  VAULT_SERVER_ID: 'browser',
  VAULT_TESTNET: '1',
  VAULT_CHAIN_ID: String(node.chainId),
  VAULT_RPC_URL: node.rpcUrl,
  VAULT_ADDRESS: deployed.vault,
  VAULT_ARBITER_KEY: arbiterKey,
  VAULT_RELAYER_KEY: relayerKey,
  VAULT_DB_PATH: join(dbDir, 'vault.sqlite'),
  VAULT_POLL_MS: '200',
  VAULT_START_HOLD_MS: '2000',
});
const vault = await createVaultSetup(config.vault, {
  clock: realClock,
  log: { warn() {}, log() {}, error() {} },
});
const game = createGame(config, { vault });
const coordinator = () => game.vault.runtime.coordinator('vault-1');
const base = game.url.replace('localhost', '127.0.0.1');

const problems = [];
let browser;
let bot;
let failed = false;
try {
  await until('the table on chain', () => coordinator().phase === 'filling');
  const tableKey = coordinator().tableKey;

  browser = await chromium.launch({ executablePath: chromePath(), args: ['--no-sandbox'] });
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: 'dark',
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  await phone.exposeFunction('__pggWallet', testWalletHandler({ node, privateKey: playerKey }));
  await phone.addInitScript(INJECTED_PROVIDER);
  const page = await phone.newPage();
  page.on('console', (m) => m.type() === 'error' && problems.push(`console.error: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  const shot = async (name) => {
    await page.screenshot({ path: join(OUT, `${name}.png`) });
    console.log('saved', name);
  };

  // login and lobby
  await page.goto(base);
  await page.locator('#name').waitFor();
  await page.locator('#name').fill('Alex');
  await page.getByRole('button', { name: 'Play now' }).click();
  await page.getByText('Real money').first().waitFor();
  await sleep(800);
  await shot('v01-lobby');

  // the deposit sheet: connect, mint test tokens, deposit
  await page.getByRole('button', { name: /Vault/ }).first().click();
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByRole('button', { name: /^Get test/ }).click();
  await page.getByRole('button', { name: /^Deposit / }).waitFor({ timeout: 30_000 });
  await sleep(400);
  await shot('v02-deposit');
  const before = await balanceOf(player);
  await page.getByRole('button', { name: /^Deposit / }).click();

  // the opponent: deposits and claims like the browser did
  bot = new VaultBot({ httpUrl: base, wsUrl: game.wsUrl, name: 'Maya', seed: 7, node, deployed });
  await bot.login();
  await bot.connect();
  await bot.deposit(tableKey, 400n * UNIT, UNIT);
  bot.claim();
  bot.autoplay = true;

  await page.getByRole('button', { name: 'Table menu' }).waitFor({ timeout: 60_000 });
  const deposited = before - (await balanceOf(player));
  console.log(`deposited ${deposited} token units from the browser wallet`);
  await until('the epoch active', () => coordinator().phase === 'active');
  await sleep(1000);
  await shot('v03-table');

  // play: the page answers its turns; the signer signs every state in the background
  const startNonce = BigInt(coordinator().publicView().nonce);
  await until(
    `${HANDS} signed hands`,
    async () => {
      const call = page.getByRole('button', { name: /^(Check|Call)/ });
      if (await call.isVisible().catch(() => false)) await call.click().catch(() => {});
      return BigInt(coordinator().publicView().nonce) >= startNonce + BigInt(HANDS);
    },
    120_000,
  );
  await shot('v04-signed-hands');
  console.log(`signed nonce ${coordinator().publicView().nonce}`);

  // leave: a final is signed, the server settles it, the wallet is paid
  const beforeLeave = await balanceOf(player);
  await page.getByLabel('Leave table').click();
  await page.getByRole('button', { name: 'Leave', exact: true }).click();
  await until(
    'the payout',
    async () => {
      // a hand still in flight is played out (and signed) before the final
      const call = page.getByRole('button', { name: /^(Check|Call)/ });
      if (await call.isVisible().catch(() => false)) await call.click().catch(() => {});
      return (await balanceOf(player)) > beforeLeave;
    },
    120_000,
  );
  const paid = (await balanceOf(player)) - beforeLeave;
  console.log(`paid out ${paid} token units to the browser wallet on chain`);
  await sleep(1000);
  await shot('v05-after-leave');
  if (problems.length) console.log('page problems:', problems);
} catch (error) {
  failed = true;
  console.error(error);
  console.error('page problems:', problems);
} finally {
  bot?.close();
  bot?.controller?.close();
  await browser?.close();
  const chain = game.vault.chain;
  game.stop();
  await chain.close();
  await node.stop();
  rmSync(dist, { recursive: true, force: true });
  rmSync(dbDir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
