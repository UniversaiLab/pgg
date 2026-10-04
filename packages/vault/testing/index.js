// Test support for anything that needs a real chain: finds Foundry, starts anvil on a free port, deploys the
// real PokerVault and a mock token from contracts/out, and hands back viem clients. Shared by the vault
// library tests and the server's end-to-end tests (import it as '@pgg/vault/testing').
//
// Skipping: without anvil/forge (or without compiled artifacts) the chain tests skip with a logged reason,
// and PGG_SKIP_CHAIN_TESTS=1 skips them on purpose. Set PGG_REQUIRE_CHAIN_TESTS=1 (CI's Foundry job does)
// and a missing prerequisite becomes a failure instead.

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  keccak256,
  toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

const REPO = new URL('../../../', import.meta.url).pathname;
const CONTRACTS = join(REPO, 'contracts');
export const REQUIRE_CHAIN = process.env.PGG_REQUIRE_CHAIN_TESTS === '1';

/** Look for a Foundry binary on PATH, in $FOUNDRY_BIN_DIR, /opt/foundry and ~/.foundry/bin. */
export function findBinary(name) {
  const onPath = Bun.which(name);
  if (onPath) return onPath;
  const dirs = [process.env.FOUNDRY_BIN_DIR, '/opt/foundry', join(homedir(), '.foundry', 'bin')];
  for (const dir of dirs) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

const artifactPath = (contract) => join(CONTRACTS, 'out', `${contract}.sol`, `${contract}.json`);

/** Compiled ABI + bytecode for the contracts the tests deploy. Builds them if forge is available. */
export function loadArtifacts() {
  if (!existsSync(artifactPath('PokerVault')) || !existsSync(artifactPath('MockToken'))) {
    const forge = findBinary('forge');
    if (forge) {
      const build = Bun.spawnSync([forge, 'build'], {
        cwd: CONTRACTS,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if (build.exitCode !== 0) return null;
    }
  }
  if (!existsSync(artifactPath('PokerVault')) || !existsSync(artifactPath('MockToken')))
    return null;
  const read = (contract) => {
    const json = JSON.parse(readFileSync(artifactPath(contract), 'utf8'));
    return { abi: json.abi, bytecode: json.bytecode.object };
  };
  return { vault: read('PokerVault'), token: read('MockToken') };
}

/** { ok: true, anvil } or { ok: false, reason }. Cheap enough to call at module load. */
export function chainTestSupport() {
  if (process.env.PGG_SKIP_CHAIN_TESTS === '1') {
    return { ok: false, reason: 'disabled by PGG_SKIP_CHAIN_TESTS=1' };
  }
  const anvil = findBinary('anvil');
  if (!anvil)
    return { ok: false, reason: 'anvil not found (set FOUNDRY_BIN_DIR or add it to PATH)' };
  if (!loadArtifacts()) {
    return {
      ok: false,
      reason: 'contracts/out artifacts missing and `forge build` unavailable or failed',
    };
  }
  return { ok: true, anvil };
}

const support = chainTestSupport();

/**
 * describe() for chain tests. Skips (with a logged reason) when Foundry is missing, unless
 * PGG_REQUIRE_CHAIN_TESTS=1, in which case it fails loudly instead of silently passing.
 */
export function chainDescribe(name, body) {
  if (support.ok) return describe(name, body);
  if (REQUIRE_CHAIN) {
    return describe(name, () => {
      test('chain test prerequisites are present', () => {
        expect(support.reason).toBeUndefined();
      });
    });
  }
  console.warn(`[chain tests skipped] ${name}: ${support.reason}`);
  return describe.skip(name, body);
}

async function freePort() {
  const server = Bun.serve({ port: 0, fetch: () => new Response('') });
  const { port } = server;
  await server.stop(true);
  return port;
}

async function waitForRpc(url, child, timeoutMs = 15_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`anvil exited early (code ${child.exitCode})`);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await Bun.sleep(50);
  }
  throw new Error('anvil did not become ready in time');
}

/** A throwaway account derived from a name. Never fund these anywhere but a local test chain. */
export const testAccount = (name) =>
  privateKeyToAccount(keccak256(toHex(`pgg-chain-test:${name}`)));

/**
 * Start a local anvil. Returns viem clients and helpers; call stop() when done.
 * Accounts are made up from names and funded with setBalance, so no well-known dev keys are used.
 */
export async function startAnvil({ chainId = 31337 } = {}) {
  if (!support.ok) throw new Error(`chain tests unavailable: ${support.reason}`);
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const child = Bun.spawn(
    [support.anvil, '--port', String(port), '--chain-id', String(chainId), '--quiet'],
    { stdout: 'ignore', stderr: 'ignore' },
  );
  try {
    await waitForRpc(rpcUrl, child);
  } catch (error) {
    child.kill();
    throw error;
  }

  const chain = { ...foundry, id: chainId };
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  const testClient = createTestClient({ chain, transport, mode: 'anvil' });
  const walletFor = (account) => createWalletClient({ account, chain, transport });

  const node = {
    rpcUrl,
    chain,
    chainId,
    publicClient,
    testClient,
    walletFor,
    /** Fund `name`'s account with 1,000 ETH and return it. */
    async account(name) {
      const account = testAccount(name);
      await testClient.setBalance({ address: account.address, value: 1000n * 10n ** 18n });
      return account;
    },
    /** Move chain time forward and mine a block. */
    async advance(seconds) {
      await testClient.increaseTime({ seconds });
      await testClient.mine({ blocks: 1 });
    },
    async stop() {
      child.kill();
      await child.exited;
    },
  };
  return node;
}

async function deploy(node, deployer, { abi, bytecode }, args = []) {
  const wallet = node.walletFor(deployer);
  const hash = await wallet.deployContract({ abi, bytecode, args });
  const receipt = await node.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('deploy failed');
  return receipt.contractAddress;
}

/**
 * Deploy a MockToken and a PokerVault for it. `exitWindow` is in seconds (the contract's minimum is 3600).
 * Returns the addresses, ABIs and the accounts used, ready to pass to viem's getContract.
 */
export async function deployVault(
  node,
  { decimals = 6, exitWindow = 3600, maxRakeBps = 500, arbiter, house, owner, deployer } = {},
) {
  const artifacts = loadArtifacts();
  const admin = deployer ?? (await node.account('deployer'));
  const arbiterAccount = arbiter ?? (await node.account('arbiter'));
  const houseAccount = house ?? (await node.account('house'));
  const ownerAccount = owner ?? (await node.account('owner'));

  const token = await deploy(node, admin, artifacts.token, [decimals]);
  const vault = await deploy(node, admin, artifacts.vault, [
    token,
    houseAccount.address,
    arbiterAccount.address,
    ownerAccount.address,
    exitWindow,
    maxRakeBps,
  ]);
  return {
    token,
    vault,
    tokenAbi: artifacts.token.abi,
    vaultAbi: artifacts.vault.abi,
    decimals,
    exitWindow,
    maxRakeBps,
    arbiter: arbiterAccount,
    house: houseAccount,
    owner: ownerAccount,
    deployer: admin,
  };
}
