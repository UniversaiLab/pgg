// Builds the vault side of one server from its configuration (parseVaultConfig): the store, the arbiter's
// signer, the chain adapter and the runtime with one coordinator per vault table. Nothing is started here:
// createGame attaches every TableActor as its coordinator's host first, then starts the runtime.
//
// Tests inject a FakeChain and a MemoryStore; production gets a SqliteStore at VAULT_DB_PATH and the viem
// adapter (imported lazily, so a play-only server never loads it).
import { normalizeAddress, tableKeyFor } from '@pgg/vault';
import { MemoryStore } from './memory-store.js';
import { createVaultRuntime } from './runtime.js';
import { LocalKeySigner } from './signer.js';
import { SqliteStore } from './sqlite-store.js';
import { VaultConfigError, validateVaultTable } from './vault-config.js';

/**
 * Read every table the coordinators will resume (the newest generation the store holds for each, or the
 * first one) and the seats of its members, so the chain cache holds them when init() runs.
 */
export async function warmChainCache(chain, store, tables) {
  const records = store.listTables();
  const reads = [];
  for (const cfg of tables) {
    let record = null;
    for (const r of records) {
      if (r.serverId !== cfg.serverId) continue;
      if (record === null || BigInt(r.generation) > BigInt(record.generation)) record = r;
    }
    const tableKey =
      record?.tableKey ??
      tableKeyFor({
        chainId: chain.info.chainId,
        vault: chain.info.vault,
        serverId: cfg.serverId,
        generation: 1,
      });
    // seat() only queues the read; track() resolves once every queued read is done
    for (const address of new Set([...(record?.roster ?? []), ...(record?.depositors ?? [])])) {
      chain.seat(tableKey, address);
    }
    reads.push(chain.track(tableKey));
  }
  await Promise.all(reads);
}

/**
 * @param {object} vaultConfig  parseVaultConfig(env) with enabled: true (plus pollMs and confirmations,
 *   which config.js adds)
 * @param {{ clock: object, chain?: object, store?: object, log?: object }} deps
 *   chain  a ready ChainPort (tests: FakeChain); otherwise one is built from rpcUrl, vault and the keys
 *   store  a ready StateStore (tests: MemoryStore); otherwise SqliteStore at dbPath, or a MemoryStore
 * Returns { runtime, tables, chain, store, signer, info, close() }. `info` is what the lobby shows of the
 * vault: { chainId, vault, maxRakeBps, exitWindowSec, arbiter }. close() stops the runtime and closes the
 * store and chain this function created (injected ones belong to the caller).
 */
export async function createVaultSetup(
  vaultConfig,
  { clock, chain = null, store = null, log = console } = {},
) {
  if (!vaultConfig?.enabled)
    throw new TypeError('createVaultSetup needs an enabled vault configuration');
  if (!clock || typeof clock.now !== 'function') throw new TypeError('clock is required');
  if (!vaultConfig.arbiterKey) {
    throw new VaultConfigError(['VAULT_ARBITER_KEY is required to run vault tables']);
  }

  const owned = [];
  try {
    if (!store) {
      if (vaultConfig.dbPath) {
        store = new SqliteStore({ path: vaultConfig.dbPath });
      } else {
        log.warn(
          'VAULT_DB_PATH is not set: vault state is kept in MEMORY and lost on restart. Signed states ' +
            'and bundles must be durable before real money; set VAULT_DB_PATH.',
        );
        store = new MemoryStore();
      }
      owned.push(() => store.close());
    }
    const signer = new LocalKeySigner({
      privateKey: vaultConfig.arbiterKey,
      reserved: (tableKey, nonce) => store.getSigned(tableKey, nonce)?.digest ?? null,
    });

    if (!chain) {
      const missing = [
        ['VAULT_RPC_URL', vaultConfig.rpcUrl],
        ['VAULT_ADDRESS', vaultConfig.vault],
        ['VAULT_RELAYER_KEY', vaultConfig.relayerKey],
      ].filter(([, value]) => !value);
      if (missing.length > 0) {
        throw new VaultConfigError(
          missing.map(([name]) => `${name} is required to reach the chain`),
        );
      }
      const { createViemChain } = await import('./viem-chain.js');
      chain = await createViemChain({
        rpcUrl: vaultConfig.rpcUrl,
        vault: vaultConfig.vault,
        arbiterKey: vaultConfig.arbiterKey,
        relayerKey: vaultConfig.relayerKey,
        pollMs: vaultConfig.pollMs ?? 1000,
        confirmations: vaultConfig.confirmations ?? 0,
        chainId: vaultConfig.chainId,
        // low gas, RPC lag, stuck transactions: an operator must see these
        onAlarm: (kind, detail) => log.warn(`[vault chain] ${kind}`, detail),
      });
      owned.push(() => chain.close?.());
    }

    const info = chain.info;
    const problems = [];
    if (vaultConfig.chainId !== undefined && Number(info.chainId) !== vaultConfig.chainId) {
      problems.push(
        `VAULT_CHAIN_ID is ${vaultConfig.chainId} but the RPC serves chain ${info.chainId}`,
      );
    }
    if (vaultConfig.vault && normalizeAddress(info.vault) !== normalizeAddress(vaultConfig.vault)) {
      problems.push(
        `the chain adapter talks to ${info.vault}, not VAULT_ADDRESS ${vaultConfig.vault}`,
      );
    }
    for (const cfg of vaultConfig.tables) {
      for (const problem of validateVaultTable(cfg, info).problems)
        problems.push(`${cfg.id}: ${problem}`);
    }
    if (problems.length > 0) throw new VaultConfigError(problems);
    if (normalizeAddress(info.arbiter) !== normalizeAddress(signer.address)) {
      // not fatal here: a table created under an older arbiter keeps its own, and the coordinator halts
      // any table whose arbiter is not this key
      log.warn(`VAULT_ARBITER_KEY is ${signer.address} but the vault's arbiter is ${info.arbiter}`);
    }

    // A real adapter answers table() and seat() from a cache it fills in the background. Fill it before the
    // coordinators boot: a resumed table that reads as "no table" would halt as table-missing, and a member
    // whose seat is not read yet would have their claim refused.
    if (typeof chain.track === 'function') await warmChainCache(chain, store, vaultConfig.tables);

    const runtime = createVaultRuntime({
      store,
      chain,
      signer,
      clock,
      config: { tables: vaultConfig.tables, policy: vaultConfig.policy },
    });
    let closed = false;
    return {
      runtime,
      tables: vaultConfig.tables,
      chain,
      store,
      signer,
      info: {
        chainId: Number(info.chainId),
        vault: normalizeAddress(info.vault),
        maxRakeBps: Number(info.maxRakeBps),
        exitWindowSec: Number(info.exitWindowSec),
        arbiter: normalizeAddress(signer.address),
      },
      close() {
        if (closed) return;
        closed = true;
        runtime.close();
        for (const close of owned.reverse()) close();
      },
    };
  } catch (error) {
    for (const close of owned.reverse()) {
      try {
        close();
      } catch {
        // the original error is the one worth reporting
      }
    }
    throw error;
  }
}
