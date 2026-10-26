// The whole signing layer on a real chain: a real PokerVault on anvil, the game server built exactly as
// index.js builds it (loadConfig with VAULT_* settings, createVaultSetup over a ViemChain and a SqliteStore in
// a temp file, createGame), and VaultBots that deposit with their own wallets, claim, and sign through the web
// app's own vault controller over real WebSockets. One table is walked through, each step asserted:
//
//   a. three bots deposit and claim, the server starts the epoch on chain, hands are played, and every hand
//      is all-signed before the next one is dealt;
//   b. one bot leaves: the final is signed and settled on chain, the leaver's tokens arrive, a fresh bot
//      deposits at that rotation, and the next epoch starts with the two stayers and the newcomer;
//   d. a bot goes silent: the round passes its deadline and the table shows 'stalled'; the bot signs late
//      and the table carries on (no exit);
//   e. the server is stopped mid-round and started again on the same SQLite file: the bots reconnect and
//      claim, the open round is re-issued and completes, and play continues;
//   c. a bot calls startExit with an older all-signed bundle it kept; the server challenges with the newest
//      one inside the window; once the window has passed (anvil time) finalizeExit pays that newest state;
//   f. every wallet holds what the last bundle (or the final it was paid by) says, the house holds exactly
//      the cumulative rake, and no token was created or lost.
//
// The steps share one table and run in order (c closes it, so it comes last).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ERR } from '@pgg/protocol/constants';
import { chainDescribe, deployVault, startAnvil } from '@pgg/vault/testing';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { loadConfig } from '../../src/config.js';
import { createGame } from '../../src/server.js';
import { realClock } from '../../src/table-actor.js';
import { createVaultSetup } from '../../src/vault/boot.js';
import { VaultBot } from './vault-bot.js';

const key = (name) => keccak256(toHex(`vault-e2e:${name}`));
const UNIT = 10_000n; // the table's chipUnit (TABLE_DEFAULTS)
const EXIT_WINDOW = 3600; // the contract's minimum
const ACTIVE = 2;
const EXITING = 3;
const CLOSED = 4;

async function until(what, predicate, timeoutMs = 20_000) {
  const end = performance.now() + timeoutMs;
  while (performance.now() < end) {
    const value = await predicate();
    if (value) return value;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const nonceOf = (bundle) => (bundle ? BigInt(bundle.state.nonce) : -1n);

chainDescribe('the vault table end to end on anvil', () => {
  const arbiterKey = key('arbiter');
  const relayerKey = key('relayer');
  let node;
  let deployed;
  let dir;
  let game = null;
  let tableKey;
  const bots = new Map(); // name -> VaultBot
  const minted = new Map(); // name -> tokens minted for that bot
  const warnings = [];
  const log = { warn: (...args) => warnings.push(args.join(' ')), log() {}, error() {} };

  const env = () => ({
    PORT: '0',
    HOST: '127.0.0.1',
    PGG_SECRET: 'vault-e2e-secret',
    TURN_MS: '5000',
    INTER_HAND_MS: '50',
    SITOUT_GRACE_MS: '3000',
    RATE_CAPACITY: '400',
    RATE_REFILL: '400',
    WATCHDOG_MS: '0',
    VAULT_TABLES: '1',
    VAULT_SERVER_ID: 'e2e',
    VAULT_CHAIN_ID: String(node.chainId),
    VAULT_RPC_URL: node.rpcUrl,
    VAULT_ADDRESS: deployed.vault,
    VAULT_ARBITER_KEY: arbiterKey,
    VAULT_RELAYER_KEY: relayerKey,
    VAULT_DB_PATH: join(dir, 'vault.sqlite'),
    VAULT_POLL_MS: '100',
    // short real timings: a signature is late after 1.5 s; the stall exit itself never comes in this test
    VAULT_SIGN_TIMEOUT_MS: '1500',
    VAULT_RESEND_MS: '500,1000',
    VAULT_START_HOLD_MS: '2500',
    VAULT_TICK_MS: '50',
    VAULT_REREAD_MS: '2000',
    VAULT_RETRY_BACKOFF_MS: '500',
  });

  const coordinator = () => game.vault.runtime.coordinator('vault-1');
  const row = async () => {
    const raw = await node.publicClient.readContract({
      address: deployed.vault,
      abi: deployed.vaultAbi,
      functionName: 'tables',
      args: [tableKey],
    });
    return { status: Number(raw[0]), nonce: raw[4], exitDeadline: raw[5], escrow: raw[8] };
  };
  const events = (eventName) =>
    node.publicClient.getContractEvents({
      address: deployed.vault,
      abi: deployed.vaultAbi,
      eventName,
      fromBlock: 0n,
    });
  const tokensOf = (address) =>
    node.publicClient.readContract({
      address: deployed.token,
      abi: deployed.tokenAbi,
      functionName: 'balanceOf',
      args: [address],
    });

  async function startServer() {
    const config = loadConfig(env());
    const vault = await createVaultSetup(config.vault, { clock: realClock, log });
    game = createGame(config, { vault });
    return game;
  }

  async function stopServer() {
    console.log(
      'DEBUG alarms',
      JSON.stringify(coordinator().alarms, (_, v) => (typeof v === 'bigint' ? String(v) : v)),
    );
    console.log(
      'DEBUG chain alarms',
      JSON.stringify(game.vault.chain.alarms, (_, v) => (typeof v === 'bigint' ? String(v) : v)),
    );
    console.log('DEBUG skipped', JSON.stringify(game.vault.chain.skipped));
    console.log('DEBUG sent', JSON.stringify(game.vault.chain.sent.map((s) => s.kind)));
    console.log('DEBUG warnings', JSON.stringify(warnings));
    const chain = game.vault.chain;
    game.stop();
    await chain.close();
    game = null;
  }

  async function seatBot(name, chips, dust = 0n) {
    const bot = new VaultBot({
      httpUrl: game.url,
      wsUrl: game.wsUrl,
      name,
      seed: name.length * 7919,
      node,
      deployed,
    });
    bots.set(name, bot);
    await bot.login();
    await bot.connect();
    const amount = BigInt(chips) * UNIT + dust;
    minted.set(name, amount);
    await bot.deposit(tableKey, amount, UNIT);
    bot.claim();
    await until(`${name} seated`, () => bot.tableId === 'vault-1');
    bot.autoplay = true;
    return bot;
  }

  // what nobody should ever see: a refused proposal, a signer failure, a malformed message
  function expectClean(bot) {
    expect(bot.invalid).toEqual([]);
    expect(bot.hookErrors).toEqual([]);
    expect(bot.ui?.failure ?? null).toBeNull();
    expect(bot.ui?.refused ?? null).toBeNull();
    expect(bot.ui?.epochProblem ?? null).toBeNull();
    const unexpected = bot.errors.filter(
      (e) => e.ref !== 'act' && !(e.ref === 'claim' && e.code === ERR.CLAIM_PENDING),
    );
    expect(unexpected).toEqual([]);
  }

  // S1 as the players saw it: at every deal the newest state they held all-signed (a bundle, or the
  // epoch's genesis before its first hand) was the table's head
  function expectSignedBeforeEveryDeal(bot) {
    expect(bot.deals.length).toBeGreaterThan(0);
    for (const deal of bot.deals) expect(deal.held).toBe(deal.head);
  }

  beforeAll(async () => {
    node = await startAnvil();
    for (const k of [arbiterKey, relayerKey]) {
      await node.testClient.setBalance({
        address: privateKeyToAccount(k).address,
        value: 10n ** 21n,
      });
    }
    deployed = await deployVault(node, {
      arbiter: privateKeyToAccount(arbiterKey),
      exitWindow: EXIT_WINDOW,
      maxRakeBps: 500,
    });
    dir = mkdtempSync(join(tmpdir(), 'pgg-vault-e2e-'));
  });

  afterAll(async () => {
    for (const bot of bots.values()) {
      bot.close();
      bot.controller.close();
    }
    if (game) await stopServer();
    await node?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  describe('in order', () => {
    test('a. three deposits and claims, the epoch starts on chain, every hand is all-signed before the next deal', async () => {
      await startServer();
      await until('the table created on chain', () => coordinator().phase === 'filling');
      tableKey = coordinator().tableKey;
      const lobby = await (await fetch(`${game.url}/api/tables`)).json();
      expect(lobby.tables.find((t) => t.id === 'vault-1').vault).toMatchObject({
        chainId: node.chainId,
        vault: deployed.vault.toLowerCase(),
        tableKey,
        chipUnit: String(UNIT),
        exitWindowSec: EXIT_WINDOW,
      });

      await seatBot('alice', 500, 3n); // dust on purpose: it must be carried and paid exactly
      await seatBot('bob', 400);
      await seatBot('carol', 600, 11n);
      const three = [...bots.values()];

      await until('Started on chain', async () => (await row()).status === ACTIVE);
      const [started] = await events('Started');
      expect(started.args.players.map((p) => p.toLowerCase())).toEqual(
        three.map((b) => b.address).sort(),
      );
      await until('the epoch pinned against the chain by every bot', () =>
        three.every((b) => b.ui?.epoch === 1),
      );
      await until(
        'four hands all-signed',
        () => three.every((b) => nonceOf(b.newestBundle) >= 4n),
        30_000,
      );
      for (const bot of three) {
        expectClean(bot);
        expectSignedBeforeEveryDeal(bot);
        // the controller kept the same bundle the bot was shown (every signature verified)
        await bot.controller.settled();
        expect(BigInt(bot.ui.bundleNonce)).toBeGreaterThanOrEqual(4n);
        expect(bot.state.vault.phase).toBe('active');
        expect(bot.state.seats[bot.seat].address).toBe(bot.address);
      }
      expect(coordinator().phase).toBe('active');
    }, 60_000);

    test('b. a leave is settled on chain and paid; a newcomer joins at the rotation; the stayers play on', async () => {
      const alice = bots.get('alice');
      const bob = bots.get('bob');
      const carol = bots.get('carol');
      expect(await bob.tokens()).toBe(0n);

      bob.vaultLeave();
      await until('bob paid by the settle', () => bob.unseatedReason === 'settled', 30_000);
      const settled = await events('Settled');
      expect(settled.length).toBe(1);
      const final = bob.newestBundle;
      expect(final.state.isFinal).toBe(true);
      expect(BigInt(settled[0].args.nonce)).toBe(BigInt(final.state.nonce));
      const i = final.state.players.indexOf(bob.address);
      expect(final.state.keep[i]).toBe(false);
      expect(final.state.keep.filter(Boolean).length).toBe(2);
      expect(await bob.tokens()).toBe(BigInt(final.state.balances[i]));
      expect((await row()).escrow).toBe(
        final.state.balances.reduce(
          (sum, b, j) => (final.state.keep[j] ? sum + BigInt(b) : sum),
          0n,
        ),
      );

      // a fresh deposit while the table is filling again joins the next epoch
      const dave = await seatBot('dave', 300);
      await until(
        'the second epoch started on chain',
        async () => (await events('Started')).length === 2,
      );
      const second = (await events('Started'))[1];
      expect(second.args.players.map((p) => p.toLowerCase())).toEqual(
        [alice, carol, dave].map((b) => b.address).sort(),
      );
      const four = [alice, carol, dave];
      await until(
        'three hands of the second epoch all-signed',
        () =>
          four.every(
            (b) => b.ui?.epoch === 2 && nonceOf(b.newestBundle) >= BigInt(final.state.nonce) + 3n,
          ),
        30_000,
      );
      for (const bot of four) {
        expectClean(bot);
        expectSignedBeforeEveryDeal(bot);
      }
      expectClean(bob);
    }, 60_000);

    test('d. a silent member stalls the table (shown publicly); the late signature lets it carry on', async () => {
      const carol = bots.get('carol');
      const others = [bots.get('alice'), bots.get('dave')];
      carol.goSilent();
      await until(
        'the table stalled',
        () => others.every((b) => b.state?.vault?.phase === 'stalled'),
        20_000,
      );
      const stalledAt = nonceOf(others[0].newestBundle);
      expect(coordinator().phase).toBe('stalled');
      expect(carol.held.size).toBeGreaterThan(0); // she did sign; it just did not go out

      carol.comeBack();
      await until(
        'two more hands after the late signature',
        () => [carol, ...others].every((b) => nonceOf(b.newestBundle) >= stalledAt + 3n),
        30_000,
      );
      expect(others[0].state.vault.phase).toBe('active');
      expect((await row()).status).toBe(ACTIVE);
      expect(await events('ExitStarted')).toEqual([]);
      for (const bot of [carol, ...others]) {
        expectClean(bot);
        expectSignedBeforeEveryDeal(bot);
      }
    }, 60_000);

    test('e. a restart mid-round on the same SQLite file resumes the open round, and play continues', async () => {
      const carol = bots.get('carol');
      const players = [bots.get('alice'), carol, bots.get('dave')];
      carol.goSilent();
      await until('a round left open by carol', () => carol.held.size > 0, 20_000);
      const open = BigInt([...carol.held.keys()].at(-1));
      await stopServer();

      await startServer();
      expect(coordinator().tableKey).toBe(tableKey);
      expect(coordinator().halt).toBeNull();
      for (const bot of players) await bot.reconnect(game);
      await until('everyone claimed again', () => players.every((b) => b.tableId === 'vault-1'));
      carol.comeBack();
      await until(
        'the open round completed and two more hands signed',
        () => players.every((b) => nonceOf(b.newestBundle) >= open + 2n),
        30_000,
      );
      // the round that was open before the restart completed with the same state (no second digest)
      for (const bot of players) {
        const resumed = bot.bundles.filter((b) => BigInt(b.state.nonce) === open);
        expect(new Set(resumed.map((b) => JSON.stringify(b.state))).size).toBe(1);
        expectClean(bot);
      }
      expect(coordinator().phase).toBe('active');
    }, 60_000);

    test('c. a stale startExit is challenged with the newest bundle; after the window finalizeExit pays it', async () => {
      const alice = bots.get('alice');
      const honest = [bots.get('carol'), bots.get('dave')];
      // alice keeps an older all-signed bundle of this epoch, stops co-operating, and exits from it
      const epochBase = BigInt((await events('Settled'))[0].args.nonce); // the second epoch's genesis
      const stale = alice.bundles.find(
        (b) => BigInt(b.state.nonce) > epochBase && !b.state.isFinal,
      );
      expect(stale).toBeDefined();
      alice.goSilent();
      await until('a round left open by alice', () => alice.held.size > 0, 20_000);
      const newest = alice.newestBundle;
      expect(BigInt(newest.state.nonce)).toBeGreaterThan(BigInt(stale.state.nonce));
      await alice.startExit(stale);

      const exit = await until('ExitStarted', async () => (await events('ExitStarted'))[0]);
      expect(BigInt(exit.args.nonce)).toBe(BigInt(stale.state.nonce));
      const challenge = await until(
        'the server challenged',
        async () => (await events('Challenged'))[0],
      );
      expect(BigInt(challenge.args.nonce)).toBe(BigInt(newest.state.nonce));
      const before = await row();
      expect(before.status).toBe(EXITING);
      expect(before.nonce).toBe(BigInt(newest.state.nonce));
      expect(coordinator().phase).toBe('exiting');

      // the window passes on chain; the server finalizes the exit it holds
      await node.advance(EXIT_WINDOW + 1);
      await until(
        'ExitFinalized',
        async () => (await events('ExitFinalized')).length === 1,
        30_000,
      );
      expect((await row()).status).toBe(CLOSED);
      await until('everyone unseated as closed', () =>
        [alice, ...honest].every((b) => b.unseatedReason === 'closed'),
      );
      const state = newest.state;
      for (const bot of [alice, ...honest]) {
        const i = state.players.indexOf(bot.address);
        expect(await bot.tokens()).toBe(BigInt(state.balances[i]));
      }
      for (const bot of honest) expectClean(bot);
    }, 60_000);

    test('f. every wallet holds what its last signed state says; the house holds the rake; tokens are conserved', async () => {
      const final = bots.get('bob').newestBundle.state; // the epoch-1 final bob was paid by
      const last = bots.get('dave').newestBundle.state; // the state the exit paid
      let wallets = 0n;
      for (const [name, bot] of bots) {
        const paidBy = name === 'bob' ? final : last;
        const i = paidBy.players.indexOf(bot.address);
        const tokens = await bot.tokens();
        expect(tokens).toBe(BigInt(paidBy.balances[i]));
        wallets += tokens;
      }
      const house = await tokensOf(deployed.house.address);
      expect(house).toBe(BigInt(last.rake)); // cumulative: the settle paid part, the exit the rest
      expect(await tokensOf(deployed.vault)).toBe(0n);
      const total = [...minted.values()].reduce((a, b) => a + b, 0n);
      expect(wallets + house).toBe(total);
      // deposits minus losses plus wins: the last state conserves the epoch's deposits
      expect(last.balances.reduce((a, b) => a + BigInt(b), 0n) + BigInt(last.rake)).toBe(
        total - BigInt(final.balances[final.players.indexOf(bots.get('bob').address)]),
      );
      // the server moved on to a fresh table key after the close
      await until('the next generation', () => coordinator().tableKey !== tableKey);
    }, 30_000);
  });
});
