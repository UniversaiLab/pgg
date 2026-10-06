// Configuration of vault tables (docs/signing-layer.md section 9). Pure: parseVaultConfig reads an env-like
// object and returns plain values, validateVaultTable checks one table against what the vault allows. Nothing
// here touches the network, the disk or the clock, so every rule has a test.
//
// Vault tables are opt-in: without VAULT_TABLES the server runs its four play-money tables exactly as before.
import { RAKE_BPS_CEILING } from '@pgg/vault';
import { SIGNATURE_COST } from '../hub.js';

/**
 * The policy table of section 6, pilot defaults. Times are milliseconds of the injected (monotonic) clock,
 * except challengeMarginSec, which is CHAIN seconds because exit deadlines are chain time.
 */
export const POLICY_DEFAULTS = Object.freeze({
  signTimeoutMs: 30_000, // soft deadline carried in a signreq
  resendMs: Object.freeze([10_000, 20_000]), // resend to connected members still missing
  absentGraceMs: 90_000, // a member away longer than this between hands counts as a stall
  stallExitMs: 600_000, // mainnet; VAULT_TESTNET=1 makes it 120 000
  challengeMarginSec: 60, // 3 x block time + a fee bump, rounded up
  claimWindowMs: 120_000,
  startHoldMs: 15_000, // pause before start, so a kept player who wants out can leave() first
  minEpochHands: 3,
  maxEpochHands: 500,
  maxEpochMs: 12 * 60 * 60 * 1000,
  idleKickHands: 3,
  policyMaxMs: 12 * 60 * 60 * 1000, // session-key policy age (S3)
  policyMarginMs: 10 * 60 * 1000, // rotate this long before a key reaches its policy age (F14)
  tickMs: 1_000, // how often the runtime ticks every coordinator
  rereadMs: 30_000, // how often the chain view is re-read in full
  jobStaleMs: 120_000, // a sent job whose effect never shows is given up and re-evaluated
  retryBackoffMs: 5_000, // first back-off after a failed job, doubled each time
  maxBackoffMs: 300_000,
  retryDelayMs: 1_000, // a stale chain cache is re-read and the proposal retried once after this
  rebindLimit: 5, // re-binds of one address to a new player id...
  rebindWindowMs: 60_000, // ...per this window
});

export const TESTNET_STALL_EXIT_MS = 120_000;

/** One vault table, pilot defaults (chips are whole chips; chipUnit is token base units per chip). */
export const TABLE_DEFAULTS = Object.freeze({
  numSeats: 6,
  chipUnit: 10_000n, // 0.01 of a 6-decimal stablecoin
  rakeBps: 200,
  smallBlind: 5,
  bigBlind: 10,
  minBuyIn: 200,
  maxBuyIn: 1000,
});

export const MIN_SEATS = 2;
export const MAX_SEATS = 10; // PokerVault.MAX_PLAYERS

export class VaultConfigError extends RangeError {
  constructor(problems) {
    super(`bad vault configuration: ${problems.join('; ')}`);
    this.name = 'VaultConfigError';
    this.problems = problems;
  }
}

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
const SERVER_ID = /^[A-Za-z0-9._-]{1,48}$/;
const INT_KNOBS = [
  'signTimeoutMs',
  'absentGraceMs',
  'stallExitMs',
  'challengeMarginSec',
  'claimWindowMs',
  'startHoldMs',
  'minEpochHands',
  'maxEpochHands',
  'maxEpochMs',
  'idleKickHands',
  'policyMaxMs',
  'policyMarginMs',
  'tickMs',
  'rereadMs',
  'jobStaleMs',
  'retryBackoffMs',
  'maxBackoffMs',
  'retryDelayMs',
  'rebindLimit',
  'rebindWindowMs',
];
// The policy knobs that may be 0 (0 turns the behaviour off or makes it immediate).
const MAY_BE_ZERO = new Set([
  'startHoldMs',
  'minEpochHands',
  'idleKickHands',
  'challengeMarginSec',
]);

// env var name for a knob: signTimeoutMs -> VAULT_SIGN_TIMEOUT_MS
const envName = (knob) => `VAULT_${knob.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;

function readInt(env, name, fallback, problems) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const text = String(raw).trim();
  if (!DECIMAL.test(text) || !Number.isSafeInteger(Number(text))) {
    problems.push(`${name} must be a whole number`);
    return fallback;
  }
  return Number(text);
}

function readList(env, name, fallback, problems) {
  const raw = env[name];
  if (raw === undefined || raw === '') return [...fallback];
  const parts = String(raw)
    .split(',')
    .map((s) => s.trim());
  if (parts.some((p) => !DECIMAL.test(p) || !Number.isSafeInteger(Number(p)))) {
    problems.push(`${name} must be a comma-separated list of whole numbers`);
    return [...fallback];
  }
  return parts.map(Number);
}

/** A bigint from a decimal string (or a bigint, or a safe integer); null when it is not one. */
export function parseUnits(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && DECIMAL.test(value.trim())) return BigInt(value.trim());
  return null;
}

/**
 * Problems with a policy table (empty when it is usable). Every knob must be a whole number, positive unless
 * 0 means "off"; the resends must fall inside the sign deadline; the margin must be below the policy age;
 * minEpochHands cannot exceed maxEpochHands.
 */
export function policyProblems(policy) {
  const problems = [];
  for (const knob of INT_KNOBS) {
    const v = policy[knob];
    const floor = MAY_BE_ZERO.has(knob) ? 0 : 1;
    if (!Number.isSafeInteger(v) || v < floor) {
      problems.push(`${knob} must be a whole number${floor ? ' above 0' : ''}`);
    }
  }
  const resend = policy.resendMs;
  if (!Array.isArray(resend) || resend.some((ms) => !Number.isSafeInteger(ms) || ms <= 0)) {
    problems.push('resendMs must be a list of positive milliseconds');
  } else if (resend.some((ms, i) => ms >= policy.signTimeoutMs || (i > 0 && ms <= resend[i - 1]))) {
    problems.push('resendMs must rise and stay below signTimeoutMs');
  }
  if (policy.policyMarginMs >= policy.policyMaxMs) {
    problems.push('policyMarginMs must be below policyMaxMs');
  }
  if (policy.minEpochHands > policy.maxEpochHands) {
    problems.push('minEpochHands must not exceed maxEpochHands');
  }
  return problems;
}

/**
 * Problems with one vault table against the vault it will live in (empty when it is usable).
 *   cfg        { id, numSeats, chipUnit, rakeBps, smallBlind, bigBlind, minBuyIn, maxBuyIn }
 *   chainInfo  { maxRakeBps } from chain.info, or null before the chain is known (then only the
 *              contract's own ceiling of 500 applies)
 * Returns { ok, problems }.
 */
export function validateVaultTable(cfg, chainInfo = null) {
  const problems = [];
  if (cfg === null || typeof cfg !== 'object') return { ok: false, problems: ['table missing'] };
  const whole = (v) => Number.isSafeInteger(v) && v > 0;
  if (typeof cfg.id !== 'string' || cfg.id === '' || cfg.id.length > 64) {
    problems.push('id must be a non-empty string of at most 64 characters');
  }
  if (!Number.isSafeInteger(cfg.numSeats) || cfg.numSeats < MIN_SEATS || cfg.numSeats > MAX_SEATS) {
    problems.push(`numSeats must be ${MIN_SEATS} to ${MAX_SEATS}`);
  }
  if (typeof cfg.chipUnit !== 'bigint' || cfg.chipUnit <= 0n) {
    problems.push('chipUnit must be a positive number of token base units');
  }
  const ceiling = Math.min(RAKE_BPS_CEILING, chainInfo?.maxRakeBps ?? RAKE_BPS_CEILING);
  if (!Number.isSafeInteger(cfg.rakeBps) || cfg.rakeBps < 0 || cfg.rakeBps > ceiling) {
    problems.push(`rakeBps must be 0 to ${ceiling} (the vault's MAX_RAKE_BPS)`);
  }
  for (const field of ['smallBlind', 'bigBlind', 'minBuyIn', 'maxBuyIn']) {
    if (!whole(cfg[field])) problems.push(`${field} must be a positive whole number of chips`);
  }
  if (whole(cfg.smallBlind) && whole(cfg.bigBlind) && cfg.bigBlind < cfg.smallBlind) {
    problems.push('bigBlind must be at least smallBlind');
  }
  if (whole(cfg.minBuyIn) && whole(cfg.maxBuyIn) && cfg.minBuyIn > cfg.maxBuyIn) {
    problems.push('minBuyIn must not exceed maxBuyIn');
  }
  if (whole(cfg.bigBlind) && whole(cfg.minBuyIn) && cfg.minBuyIn < cfg.bigBlind) {
    problems.push('minBuyIn must cover at least one big blind');
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Read the vault part of the server configuration from `env`. `defaults` may override the built-in table
 * and policy defaults and give the rate-limit capacity the rest of the config chose:
 *   { table?: {...TABLE_DEFAULTS}, policy?: {...POLICY_DEFAULTS}, rateCapacity?: number }
 *
 * Returns { enabled: false } when VAULT_TABLES is unset or 0; otherwise
 *   { enabled: true, serverId, chainId, rpcUrl, vault, arbiterKey, relayerKey, dbPath, policy, tables }
 * with one entry per vault table ({ id, name, serverId, numSeats, chipUnit (bigint), rakeBps, rakeCap,
 * smallBlind, bigBlind, minBuyIn, maxBuyIn, policy }). Throws VaultConfigError listing every problem.
 */
export function parseVaultConfig(env = {}, defaults = {}) {
  const problems = [];
  const count = readInt(env, 'VAULT_TABLES', 0, problems);
  if (problems.length > 0) throw new VaultConfigError(problems);
  if (count === 0) return { enabled: false };
  if (count > 32) throw new VaultConfigError(['VAULT_TABLES must be at most 32']);

  const base = { ...POLICY_DEFAULTS, ...(defaults.policy ?? {}) };
  if (env.VAULT_TESTNET === '1' && env.VAULT_STALL_EXIT_MS === undefined) {
    base.stallExitMs = TESTNET_STALL_EXIT_MS;
  }
  const policy = { ...base, resendMs: readList(env, envName('resendMs'), base.resendMs, problems) };
  for (const knob of INT_KNOBS) policy[knob] = readInt(env, envName(knob), base[knob], problems);
  problems.push(...policyProblems(policy));

  // RATE_CAPACITY is read by config.js; a vault server refuses one that cannot afford a claim or a sig.
  const capacity = readInt(env, 'RATE_CAPACITY', defaults.rateCapacity ?? 40, problems);
  if (capacity < SIGNATURE_COST) {
    problems.push(
      `RATE_CAPACITY must be at least ${SIGNATURE_COST} (the cost of a claim or a signature)`,
    );
  }

  const serverId = env.VAULT_SERVER_ID ?? 'pgg';
  if (!SERVER_ID.test(serverId)) {
    problems.push('VAULT_SERVER_ID must be 1 to 48 letters, digits, dots, dashes or underscores');
  }
  const chainId = readInt(env, 'VAULT_CHAIN_ID', 31337, problems);
  if (chainId <= 0) problems.push('VAULT_CHAIN_ID must be positive');
  const vault = env.VAULT_ADDRESS ?? null;
  if (vault !== null && !ADDRESS.test(vault))
    problems.push('VAULT_ADDRESS must be a 20-byte 0x address');
  for (const name of ['VAULT_ARBITER_KEY', 'VAULT_RELAYER_KEY']) {
    if (env[name] !== undefined && !PRIVATE_KEY.test(env[name])) {
      problems.push(`${name} must be 32 bytes of 0x hex`);
    }
  }

  const t = { ...TABLE_DEFAULTS, ...(defaults.table ?? {}) };
  const chipUnit = parseUnits(env.VAULT_CHIP_UNIT ?? t.chipUnit);
  if (chipUnit === null)
    problems.push('VAULT_CHIP_UNIT must be a whole number of token base units');
  const smallBlind = readInt(env, 'VAULT_SMALL_BLIND', t.smallBlind, problems);
  // a small blind set on its own brings its own big blind, as the play tables do (2 x small)
  const bigDefault = env.VAULT_SMALL_BLIND === undefined ? t.bigBlind : smallBlind * 2;
  const table = {
    numSeats: readInt(env, 'VAULT_NUM_SEATS', t.numSeats, problems),
    chipUnit: chipUnit ?? 0n,
    rakeBps: readInt(env, 'VAULT_RAKE_BPS', t.rakeBps, problems),
    smallBlind,
    bigBlind: readInt(env, 'VAULT_BIG_BLIND', bigDefault, problems),
    rakeCap: readInt(env, 'VAULT_RAKE_CAP', t.rakeCap ?? smallBlind * 6, problems),
    minBuyIn: readInt(env, 'VAULT_MIN_BUY_IN', t.minBuyIn, problems),
    maxBuyIn: readInt(env, 'VAULT_MAX_BUY_IN', t.maxBuyIn, problems),
  };
  const tables = Array.from({ length: count }, (_, i) => ({
    id: `vault-${i + 1}`,
    name: `Vault ${i + 1}`,
    serverId: `${serverId}-vault-${i + 1}`, // one tableKey family per table (tableKeyFor needs no ':')
    ...table,
    policy,
  }));
  for (const cfg of tables) {
    for (const problem of validateVaultTable(cfg).problems) problems.push(`${cfg.id}: ${problem}`);
  }
  if (problems.length > 0) throw new VaultConfigError([...new Set(problems)]);

  return {
    enabled: true,
    serverId,
    chainId,
    rpcUrl: env.VAULT_RPC_URL ?? null,
    vault: vault?.toLowerCase() ?? null,
    arbiterKey: env.VAULT_ARBITER_KEY ?? null,
    relayerKey: env.VAULT_RELAYER_KEY ?? null,
    dbPath: env.VAULT_DB_PATH ?? null,
    policy,
    tables,
  };
}
