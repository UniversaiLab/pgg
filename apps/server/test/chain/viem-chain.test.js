// ViemChain against a real PokerVault on anvil. One table is walked through its whole life with jobs sent by
// the adapter and the players' own calls made directly with viem: createTable, deposits with session keys,
// start, settle of an all-signed final, a second epoch, a player's exit from an older bundle, the challenge
// with the newer one, the window passing, finalizeExit. Along the way: the cached rows and seats, the events
// (types, order, fields), the token balances, a reverted job becoming JobFailed with the contract's error
// name, submit's idempotency, priority between two queued jobs, a stuck transaction being replaced, and the
// refusal to start with a key that is not the vault's arbiter.
//
// The resolver here is a plain table of answers per job key: the real JobResolver is tested on its own and
// end to end; this file is about the adapter.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  buildNextState,
  epochBaseline,
  genesisState,
  hashState,
  makeBundle,
  privateKeyToAddress,
  signDigest,
} from '@pgg/vault';
import { chainDescribe, deployVault, startAnvil } from '@pgg/vault/testing';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { assertChainPort, JOB_KINDS, makeJob } from '../../src/vault/chain-port.js';
import { createViemChain } from '../../src/vault/viem-chain.js';

const key = (name) => keccak256(toHex(`viem-chain-test:${name}`));
const ZERO_HASH = `0x${'00'.repeat(32)}`;
const EXIT_WINDOW = 3600;
const LIMITS = { maxPlayers: 6, minDeposit: 1_000_000n, maxDeposit: 10_000_000_000n };

async function until(what, predicate, timeoutMs = 15_000) {
  const end = performance.now() + timeoutMs;
  while (performance.now() < end) {
    const value = predicate();
    if (value) return value;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

chainDescribe('ViemChain on anvil', () => {
  const arbiterKey = key('arbiter');
  const relayerKey = key('relayer');
  const tableA = key('table-a');
  const tableB = key('table-b');
  const tableC = key('table-c');
  let node;
  let deployed;
  let chain;
  let domain;
  const events = []; // everything delivered, in order
  const plan = new Map(); // job key -> what prepare() answers
  const prepared = []; // job keys in the order prepare() saw them
  const resolver = {
    prepare(job) {
      prepared.push(job.key);
      return plan.get(job.key) ?? { proceed: false, reason: 'not-planned' };
    },
  };
  const go = (kind, tableKey, args) => {
    const job = makeJob(kind, tableKey);
    plan.set(job.key, { proceed: true, args });
    return job;
  };
  const eventsOf = (tableKey) => events.filter((e) => e.tableKey === tableKey);
  const waitEvent = (what, match) => until(what, () => events.find(match));

  let players; // [{ address, wallet, sessionKey }] sorted by address
  const write = async (account, address, abi, functionName, args) => {
    const hash = await node.walletFor(account).writeContract({ address, abi, functionName, args });
    const receipt = await node.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`${functionName} reverted`);
    return receipt;
  };
  const tokenOf = (address) =>
    node.publicClient.readContract({
      address: deployed.token,
      abi: deployed.tokenAbi,
      functionName: 'balanceOf',
      args: [address],
    });
  const sign = (state) => {
    const digest = hashState(state, domain);
    return makeBundle({
      domain,
      state,
      arbiterSig: signDigest(arbiterKey, digest),
      playerSigs: players.map((p) => signDigest(p.sessionKey, digest)),
    });
  };
  const wire = (bundle) => ({
    state: bundle.state,
    arbiterSig: bundle.arbiterSig,
    playerSigs: [...bundle.playerSigs],
  });

  beforeAll(async () => {
    node = await startAnvil();
    const arbiter = privateKeyToAccount(arbiterKey);
    for (const k of [arbiterKey, relayerKey]) {
      await node.testClient.setBalance({
        address: privateKeyToAddress(k),
        value: 10n ** 21n,
      });
    }
    deployed = await deployVault(node, { arbiter, exitWindow: EXIT_WINDOW, maxRakeBps: 500 });
    domain = { chainId: node.chainId, verifyingContract: deployed.vault.toLowerCase() };
    chain = await createViemChain({
      rpcUrl: node.rpcUrl,
      vault: deployed.vault,
      arbiterKey,
      relayerKey,
      pollMs: 20,
      stuckPolls: 3,
    });
    chain.setResolver(resolver);
  });

  afterAll(async () => {
    await chain?.close();
    await node?.stop();
  });

  test('info is read at creation', () => {
    expect(assertChainPort(chain)).toBe(chain);
    expect(chain.info).toEqual({
      chainId: 31337,
      vault: deployed.vault.toLowerCase(),
      arbiter: privateKeyToAddress(arbiterKey),
      relayer: privateKeyToAddress(relayerKey),
      maxRakeBps: 500,
      exitWindowSec: EXIT_WINDOW,
    });
    expect(chain.chainTime()).toBeGreaterThan(0);
  });

  test('createTable, deposits and start: rows, seats and events, priority between two jobs', async () => {
    // a subscriber that throws must not stop the others or the poll
    chain.subscribe(() => {
      throw new Error('broken subscriber');
    });
    chain.subscribe((event) => events.push(event));

    expect(chain.table(tableA)).toBeNull(); // not cached yet: tracked and read in the background
    expect(await chain.track(tableA)).toBeNull(); // no such table on chain

    const create = go(JOB_KINDS.createTable, tableA, LIMITS);
    expect(chain.submit(create)).toBe(true);
    expect(chain.submit(create)).toBe(false); // idempotent while queued or in flight
    await waitEvent('TableCreated', (e) => e.type === 'TableCreated' && e.tableKey === tableA);
    expect(chain.table(tableA)).toEqual({
      status: 'Filling',
      nonce: 0n,
      escrow: 0n,
      rakePaid: 0n,
      rosterHash: ZERO_HASH,
      exitDeadline: 0,
      exitDigest: ZERO_HASH,
      arbiter: chain.info.arbiter,
      seated: 0,
      maxPlayers: 6,
      minDeposit: LIMITS.minDeposit,
      maxDeposit: LIMITS.maxDeposit,
    });
    expect(chain.alarms.some((a) => a.kind === 'subscriber-error')).toBe(true);

    // the players deposit themselves, each with a session key
    const seats = [];
    for (const [i, name] of ['alice', 'bob'].entries()) {
      const wallet = await node.account(name);
      const sessionKey = key(`session:${name}`);
      const amount = 100_000_000n + BigInt(i) * 50_000_007n; // dust on purpose
      await write(wallet, deployed.token, deployed.tokenAbi, 'mint', [wallet.address, amount]);
      await write(wallet, deployed.token, deployed.tokenAbi, 'approve', [deployed.vault, amount]);
      await write(wallet, deployed.vault, deployed.vaultAbi, 'deposit', [
        tableA,
        amount,
        privateKeyToAddress(sessionKey),
      ]);
      seats.push({ address: wallet.address.toLowerCase(), wallet, sessionKey, amount });
    }
    players = seats.sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
    await until(
      'both deposits',
      () => eventsOf(tableA).filter((e) => e.type === 'Deposited').length === 2,
    );
    for (const p of players) {
      // known from the Deposited event, so read before the event was delivered
      expect(chain.seat(tableA, p.address)).toEqual({
        deposit: p.amount,
        sessionKey: privateKeyToAddress(p.sessionKey),
        confirmed: true,
      });
    }
    const deposited = eventsOf(tableA).find((e) => e.type === 'Deposited');
    const first = seats.find((s) => s.address === deposited.player);
    expect(deposited).toEqual({
      type: 'Deposited',
      tableKey: tableA,
      player: first.address,
      amount: first.amount,
      total: first.amount,
      sessionKey: privateKeyToAddress(first.sessionKey),
      block: deposited.block,
      logIndex: deposited.logIndex,
    });
    expect(chain.table(tableA).escrow).toBe(players[0].amount + players[1].amount);

    // two arbiter jobs queued together: start (priority 2) runs before createTable (priority 1)
    const before = prepared.length;
    const createB = go(JOB_KINDS.createTable, tableB, LIMITS);
    const start = go(JOB_KINDS.start, tableA, { players: players.map((p) => p.address) });
    expect(chain.submit(createB)).toBe(true);
    expect(chain.submit(start)).toBe(true);
    await waitEvent('Started', (e) => e.type === 'Started' && e.tableKey === tableA);
    await waitEvent('TableCreated B', (e) => e.type === 'TableCreated' && e.tableKey === tableB);
    expect(prepared.slice(before)).toEqual([start.key, createB.key]);
    const sentOrder = chain.sent.filter((s) => [start.key, createB.key].includes(s.key));
    expect(sentOrder.map((s) => s.key)).toEqual([start.key, createB.key]);
    expect(sentOrder[1].nonce).toBe(sentOrder[0].nonce + 1); // one in flight: sent after the first was mined
    expect(chain.table(tableA).status).toBe('Active');
  }, 30_000);

  let s2;
  test('settle of an all-signed final, then a second epoch starts', async () => {
    const genesis = genesisState({
      tableId: tableA,
      players: players.map((p) => p.address),
      deposits: players.map((p) => p.amount),
    });
    const s1 = buildNextState({
      prev: genesis,
      balances: [genesis.balances[0] + 19_000_000n, genesis.balances[1] - 20_000_000n],
      rakeDelta: 1_000_000n,
      volumeDelta: 40_000_000n,
    });
    s2 = buildNextState({ prev: s1, balances: s1.balances, final: true, keep: [true, true] });
    const settle = go(JOB_KINDS.settle, tableA, { bundle: wire(sign(s2)) });
    expect(chain.submit(settle)).toBe(true);
    const settled = await waitEvent('Settled', (e) => e.type === 'Settled');
    expect(settled).toEqual({
      type: 'Settled',
      tableKey: tableA,
      nonce: 2n,
      rakePaid: 1_000_000n,
      rakeDelta: 1_000_000n,
      stayers: 2,
      block: settled.block,
      logIndex: settled.logIndex,
    });
    expect(chain.sent.find((s) => s.key === settle.key).sender).toBe(chain.info.relayer);
    expect(chain.table(tableA)).toMatchObject({
      status: 'Filling',
      nonce: 2n,
      rakePaid: 1_000_000n,
      escrow: s2.balances[0] + s2.balances[1],
      seated: 2,
      rosterHash: ZERO_HASH,
    });
    expect(chain.seat(tableA, players[0].address).deposit).toBe(s2.balances[0]);
    expect(await tokenOf(deployed.house.address)).toBe(1_000_000n);

    // the start key was released after its receipt, so the same job can run again for epoch 2
    const start = go(JOB_KINDS.start, tableA, { players: players.map((p) => p.address) });
    expect(chain.submit(start)).toBe(true);
    await until('epoch 2 Active', () => chain.table(tableA)?.status === 'Active');
    expect(eventsOf(tableA).filter((e) => e.type === 'Started')).toHaveLength(2);
  }, 30_000);

  test('a player exits from an older bundle, the relayer challenges, a stale job fails by name, finalizeExit pays out', async () => {
    const base = epochBaseline({
      tableId: tableA,
      players: players.map((p) => p.address),
      deposits: s2.balances,
      nonce: s2.nonce,
      rake: s2.rake,
      volume: s2.volume,
    });
    const s3 = buildNextState({
      prev: base,
      balances: [base.balances[0] - 10_000_000n, base.balances[1] + 9_500_000n],
      rakeDelta: 500_000n,
      volumeDelta: 20_000_000n,
    });
    const s4 = buildNextState({
      prev: s3,
      balances: [s3.balances[0] + 4_000_000n, s3.balances[1] - 4_000_000n],
    });
    const b3 = sign(s3);
    const b4 = sign(s4);

    // players[1] prefers nonce 3 and starts the exit with it, directly
    await write(players[1].wallet, deployed.vault, deployed.vaultAbi, 'startExit', [
      s3,
      b3.arbiterSig,
      b3.playerSigs,
    ]);
    const exit = await waitEvent('ExitStarted', (e) => e.type === 'ExitStarted');
    expect(exit).toEqual({
      type: 'ExitStarted',
      tableKey: tableA,
      by: players[1].address,
      nonce: 3n,
      digest: hashState(s3, domain),
      deadline: exit.deadline,
      block: exit.block,
      logIndex: exit.logIndex,
    });
    expect(exit.deadline).toBe(chain.chainTime() + EXIT_WINDOW);
    expect(chain.table(tableA)).toMatchObject({ status: 'Exiting', nonce: 3n });

    const challenge = go(JOB_KINDS.challenge, tableA, { bundle: wire(b4) });
    expect(chain.submit(challenge)).toBe(true);
    const challenged = await waitEvent('Challenged', (e) => e.type === 'Challenged');
    expect(challenged).toMatchObject({
      by: chain.info.relayer,
      nonce: 4n,
      digest: hashState(s4, domain),
    });
    expect(chain.table(tableA)).toMatchObject({
      status: 'Exiting',
      nonce: 4n,
      exitDigest: hashState(s4, domain),
      exitDeadline: challenged.deadline,
    });

    // the same challenge again with the OLDER bundle: the contract says StaleNonce, which is not retryable
    plan.set(challenge.key, { proceed: true, args: { bundle: wire(b3) } });
    expect(chain.submit(challenge)).toBe(true);
    const stale = await waitEvent('JobFailed challenge', (e) => e.type === 'JobFailed');
    expect(stale).toEqual({
      type: 'JobFailed',
      tableKey: tableA,
      key: challenge.key,
      kind: 'challenge',
      error: 'StaleNonce',
      retryable: false,
      args: [3n, 4n],
      block: stale.block,
      logIndex: stale.logIndex,
    });

    // finalizeExit inside the window: refused, and retryable (the window passes by itself)
    const finalize = go(JOB_KINDS.finalizeExit, tableA, { state: s4 });
    expect(chain.submit(finalize)).toBe(true);
    const early = await waitEvent(
      'JobFailed finalizeExit',
      (e) => e.type === 'JobFailed' && e.kind === 'finalizeExit',
    );
    expect(early).toMatchObject({ error: 'ExitWindowOpen', retryable: true });

    await node.advance(EXIT_WINDOW + 1);
    await until('chain time past the deadline', () => chain.chainTime() > challenged.deadline);
    expect(chain.submit(finalize)).toBe(true);
    const finalized = await waitEvent('ExitFinalized', (e) => e.type === 'ExitFinalized');
    expect(finalized).toMatchObject({ nonce: 4n, rakePaid: 1_500_000n, rakeDelta: 500_000n });
    await until('three payouts', () => events.indexOf(finalized) + 3 < events.length);

    expect(chain.table(tableA)).toMatchObject({
      status: 'Closed',
      escrow: 0n,
      seated: 0,
      exitDigest: ZERO_HASH,
    });
    expect(chain.seat(tableA, players[0].address)).toBeNull();
    for (const [i, p] of players.entries()) {
      expect(await tokenOf(p.address)).toBe(s4.balances[i]);
    }
    expect(await tokenOf(deployed.house.address)).toBe(1_500_000n);
    expect(await tokenOf(deployed.vault)).toBe(0n);

    // the whole life of table A, in delivery order
    expect(eventsOf(tableA).map((e) => e.type)).toEqual([
      'TableCreated',
      'Deposited',
      'Deposited',
      'Started',
      'Settled',
      'Payout',
      'Started',
      'ExitStarted',
      'Challenged',
      'JobFailed',
      'JobFailed',
      'ExitFinalized',
      'Payout',
      'Payout',
      'Payout',
    ]);
    const payouts = eventsOf(tableA).slice(-3);
    expect(payouts.map(({ to, amount, pushed }) => ({ to, amount, pushed }))).toEqual([
      { to: players[0].address, amount: s4.balances[0], pushed: true },
      { to: players[1].address, amount: s4.balances[1], pushed: true },
      { to: deployed.house.address.toLowerCase(), amount: 500_000n, pushed: true },
    ]);
    // strictly increasing positions over everything delivered, JobFailed included
    for (let i = 1; i < events.length; i++) {
      const [a, b] = [events[i - 1], events[i]];
      expect(a.block < b.block || (a.block === b.block && a.logIndex < b.logIndex)).toBe(true);
    }
  }, 30_000);

  test('a transaction with no receipt is re-sent with the same nonce and higher fees', async () => {
    await node.testClient.setAutomine(false);
    try {
      const create = go(JOB_KINDS.createTable, tableC, LIMITS);
      chain.table(tableC);
      expect(chain.submit(create)).toBe(true);
      const stuck = await until('a replacement', () =>
        chain.inflight.find((f) => f.key === create.key && f.hashes.length >= 2),
      );
      // the node dropped the original from its pool, so compare what was sent
      const [original, replacement] = stuck.hashes
        .slice(0, 2)
        .map((hash) => chain.sent.find((s) => s.hash === hash));
      expect(replacement.nonce).toBe(original.nonce);
      expect(replacement.fees.maxFeePerGas).toBeGreaterThan(
        (original.fees.maxFeePerGas * 11n) / 10n,
      );
      expect(chain.alarms.some((a) => a.kind === 'tx-replaced')).toBe(true);
      await node.testClient.mine({ blocks: 1 });
      await until('table C created', () => chain.table(tableC)?.status === 'Filling');
      await until('lane free', () => chain.inflight.length === 0);
      expect(chain.submit(create)).toBe(true); // released after the receipt
    } finally {
      await node.testClient.setAutomine(true);
    }
  }, 30_000);
});

chainDescribe('ViemChain refuses', () => {
  let node;
  let deployed;
  beforeAll(async () => {
    node = await startAnvil();
    deployed = await deployVault(node);
  });
  afterAll(async () => {
    await node?.stop();
  });

  test('to start with a key that is not the vault arbiter', async () => {
    const stranger = key('stranger');
    await expect(
      createViemChain({
        rpcUrl: node.rpcUrl,
        vault: deployed.vault,
        arbiterKey: stranger,
        relayerKey: stranger,
      }),
    ).rejects.toThrow(/arbiter/);
  });
});

describe('ViemChain options', () => {
  test('needs an rpcUrl', async () => {
    await expect(createViemChain({})).rejects.toThrow(/rpcUrl/);
  });
});
