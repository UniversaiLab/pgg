import { afterAll, beforeAll, expect, test } from 'bun:test';
import { getContract, keccak256, toHex } from 'viem';
import { chainDescribe, deployVault, startAnvil, testAccount } from '../../testing/index.js';

chainDescribe('anvil harness', () => {
  let node;
  let deployed;

  beforeAll(async () => {
    node = await startAnvil();
    deployed = await deployVault(node);
  });
  afterAll(async () => {
    await node?.stop();
  });

  test('deploys the real PokerVault with the configuration asked for', async () => {
    const vault = getContract({
      address: deployed.vault,
      abi: deployed.vaultAbi,
      client: node.publicClient,
    });
    expect(await vault.read.arbiter()).toBe(deployed.arbiter.address);
    expect(await vault.read.HOUSE()).toBe(deployed.house.address);
    expect(await vault.read.EXIT_WINDOW()).toBe(3600);
    expect(await vault.read.MAX_RAKE_BPS()).toBe(500);
    expect(await node.publicClient.getChainId()).toBe(31337);
  });

  test('create, deposit with session keys, start: the table is Active', async () => {
    const tableId = keccak256(toHex('smoke-table'));
    const arbiter = deployed.arbiter;
    const vaultFor = (account) =>
      getContract({
        address: deployed.vault,
        abi: deployed.vaultAbi,
        client: node.walletFor(account),
      });
    const tokenFor = (account) =>
      getContract({
        address: deployed.token,
        abi: deployed.tokenAbi,
        client: node.walletFor(account),
      });
    const wait = (hash) => node.publicClient.waitForTransactionReceipt({ hash });

    await wait(await vaultFor(arbiter).write.createTable([tableId, 6, 1_000_000n, 1_000_000_000n]));

    const players = [];
    for (const name of ['alice', 'bob']) {
      const wallet = await node.account(name);
      const session = testAccount(`session:${name}`);
      await wait(await tokenFor(wallet).write.mint([wallet.address, 500_000_000n]));
      await wait(await tokenFor(wallet).write.approve([deployed.vault, 2n ** 256n - 1n]));
      await wait(await vaultFor(wallet).write.deposit([tableId, 100_000_000n, session.address]));
      players.push(wallet.address);
    }
    players.sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    await wait(await vaultFor(arbiter).write.start([tableId, players]));

    const table = await node.publicClient.readContract({
      address: deployed.vault,
      abi: deployed.vaultAbi,
      functionName: 'tables',
      args: [tableId],
    });
    expect(table[0]).toBe(2); // Status.Active
    expect(table[8]).toBe(200_000_000n); // escrow
  });

  test('the exit window can be skipped with the test client', async () => {
    const before = (await node.publicClient.getBlock()).timestamp;
    await node.advance(3601);
    const after = (await node.publicClient.getBlock()).timestamp;
    expect(after - before).toBeGreaterThanOrEqual(3601n);
  });
});
