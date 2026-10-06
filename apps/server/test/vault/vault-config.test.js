// Vault table configuration: opt-in, every knob checked, and a table the vault would refuse (rake above its
// MAX_RAKE_BPS, a seat count it cannot hold, a zero chip unit) never gets as far as createTable.
import { describe, expect, test } from 'bun:test';
import { RAKE_BPS_CEILING } from '@pgg/vault';
import { SIGNATURE_COST } from '../../src/hub.js';
import {
  MAX_SEATS,
  MIN_SEATS,
  POLICY_DEFAULTS,
  parseUnits,
  parseVaultConfig,
  policyProblems,
  TABLE_DEFAULTS,
  TESTNET_STALL_EXIT_MS,
  VaultConfigError,
  validateVaultTable,
} from '../../src/vault/vault-config.js';

const table = (over = {}) => ({ id: 'vault-1', ...TABLE_DEFAULTS, ...over });
const problemsOf = (env, defaults) => {
  try {
    parseVaultConfig(env, defaults);
  } catch (error) {
    expect(error).toBeInstanceOf(VaultConfigError);
    expect(error).toBeInstanceOf(RangeError);
    return error.problems;
  }
  throw new Error('expected a VaultConfigError');
};

describe('parseVaultConfig: opt-in', () => {
  test('without VAULT_TABLES (or with 0 or an empty value) nothing is enabled and nothing else is read', () => {
    for (const env of [{}, { VAULT_TABLES: '0' }, { VAULT_TABLES: '' }]) {
      expect(parseVaultConfig({ ...env, VAULT_RAKE_BPS: 'nonsense' })).toEqual({ enabled: false });
    }
    expect(parseVaultConfig()).toEqual({ enabled: false });
  });

  test('VAULT_TABLES must be a whole number from 0 to 32', () => {
    expect(problemsOf({ VAULT_TABLES: 'two' })).toEqual(['VAULT_TABLES must be a whole number']);
    expect(problemsOf({ VAULT_TABLES: '-1' })).toEqual(['VAULT_TABLES must be a whole number']);
    expect(problemsOf({ VAULT_TABLES: '33' })).toEqual(['VAULT_TABLES must be at most 32']);
    expect(parseVaultConfig({ VAULT_TABLES: '32' }).tables).toHaveLength(32);
  });

  test('the defaults: 6 seats, 0.01 USDC chips, 2% rake capped at 6 small blinds, pilot policy', () => {
    const cfg = parseVaultConfig({ VAULT_TABLES: '2' });
    expect(cfg).toMatchObject({
      enabled: true,
      serverId: 'pgg',
      chainId: 31337,
      rpcUrl: null,
      vault: null,
      arbiterKey: null,
      relayerKey: null,
      dbPath: null,
    });
    expect(cfg.policy).toEqual({ ...POLICY_DEFAULTS, resendMs: [...POLICY_DEFAULTS.resendMs] });
    expect(cfg.tables.map((t) => [t.id, t.name, t.serverId])).toEqual([
      ['vault-1', 'Vault 1', 'pgg-vault-1'],
      ['vault-2', 'Vault 2', 'pgg-vault-2'],
    ]);
    expect(cfg.tables[0]).toMatchObject({
      numSeats: 6,
      chipUnit: 10_000n,
      rakeBps: 200,
      rakeCap: 30,
      smallBlind: 5,
      bigBlind: 10,
      minBuyIn: 200,
      maxBuyIn: 1000,
    });
    expect(cfg.tables[0].policy).toBe(cfg.policy);
  });

  test('every value can be set from the environment, the vault address is lowercased', () => {
    const cfg = parseVaultConfig({
      VAULT_TABLES: '1',
      VAULT_SERVER_ID: 'eu-1.prod',
      VAULT_CHAIN_ID: '8453',
      VAULT_RPC_URL: 'https://rpc.example',
      VAULT_ADDRESS: `0x${'AB'.repeat(20)}`,
      VAULT_ARBITER_KEY: `0x${'11'.repeat(32)}`,
      VAULT_RELAYER_KEY: `0x${'22'.repeat(32)}`,
      VAULT_DB_PATH: '/var/lib/pgg/vault.db',
      VAULT_NUM_SEATS: '4',
      VAULT_CHIP_UNIT: '1000000000000000000',
      VAULT_RAKE_BPS: '500',
      VAULT_SMALL_BLIND: '25',
      VAULT_RAKE_CAP: '100',
      VAULT_MIN_BUY_IN: '500',
      VAULT_MAX_BUY_IN: '5000',
      VAULT_SIGN_TIMEOUT_MS: '45000',
      VAULT_RESEND_MS: '15000, 30000',
      VAULT_CHALLENGE_MARGIN_SEC: '0',
    });
    expect(cfg).toMatchObject({
      serverId: 'eu-1.prod',
      chainId: 8453,
      rpcUrl: 'https://rpc.example',
      vault: `0x${'ab'.repeat(20)}`,
      dbPath: '/var/lib/pgg/vault.db',
    });
    expect(cfg.tables[0]).toMatchObject({
      serverId: 'eu-1.prod-vault-1',
      numSeats: 4,
      chipUnit: 10n ** 18n,
      rakeBps: 500,
      smallBlind: 25,
      bigBlind: 50, // a small blind set on its own brings its own big blind
      rakeCap: 100,
      minBuyIn: 500,
      maxBuyIn: 5000,
    });
    expect(cfg.policy).toMatchObject({
      signTimeoutMs: 45_000,
      resendMs: [15_000, 30_000],
      challengeMarginSec: 0,
    });
  });

  test('VAULT_TESTNET shortens the stall exit to 2 minutes, unless VAULT_STALL_EXIT_MS says otherwise', () => {
    expect(parseVaultConfig({ VAULT_TABLES: '1' }).policy.stallExitMs).toBe(600_000);
    expect(parseVaultConfig({ VAULT_TABLES: '1', VAULT_TESTNET: '1' }).policy.stallExitMs).toBe(
      TESTNET_STALL_EXIT_MS,
    );
    const explicit = { VAULT_TABLES: '1', VAULT_TESTNET: '1', VAULT_STALL_EXIT_MS: '300000' };
    expect(parseVaultConfig(explicit).policy.stallExitMs).toBe(300_000);
  });

  test('defaults passed in by the caller are used, and the environment still wins', () => {
    const cfg = parseVaultConfig(
      { VAULT_TABLES: '1', VAULT_RAKE_BPS: '100' },
      { table: { rakeBps: 300, numSeats: 9 }, policy: { tickMs: 250 } },
    );
    expect(cfg.tables[0]).toMatchObject({ rakeBps: 100, numSeats: 9 });
    expect(cfg.policy.tickMs).toBe(250);
  });
});

describe('parseVaultConfig: every problem is reported, together', () => {
  test('rate capacity below the cost of one signature is refused (a vault server must afford a sig)', () => {
    expect(SIGNATURE_COST).toBe(10);
    expect(problemsOf({ VAULT_TABLES: '1', RATE_CAPACITY: String(SIGNATURE_COST - 1) })).toEqual([
      `RATE_CAPACITY must be at least ${SIGNATURE_COST} (the cost of a claim or a signature)`,
    ]);
    expect(
      parseVaultConfig({ VAULT_TABLES: '1', RATE_CAPACITY: String(SIGNATURE_COST) }).enabled,
    ).toBe(true);
    expect(problemsOf({ VAULT_TABLES: '1' }, { rateCapacity: 5 })).toHaveLength(1);
  });

  test('malformed identities and keys', () => {
    const problems = problemsOf({
      VAULT_TABLES: '1',
      VAULT_SERVER_ID: 'has:colon',
      VAULT_CHAIN_ID: '0',
      VAULT_ADDRESS: '0x1234',
      VAULT_ARBITER_KEY: 'not-a-key',
      VAULT_RELAYER_KEY: `0x${'11'.repeat(31)}`,
    });
    expect(problems).toEqual([
      'VAULT_SERVER_ID must be 1 to 48 letters, digits, dots, dashes or underscores',
      'VAULT_CHAIN_ID must be positive',
      'VAULT_ADDRESS must be a 20-byte 0x address',
      'VAULT_ARBITER_KEY must be 32 bytes of 0x hex',
      'VAULT_RELAYER_KEY must be 32 bytes of 0x hex',
    ]);
  });

  test('a table the vault would refuse, reported once per problem (not once per table)', () => {
    const problems = problemsOf({
      VAULT_TABLES: '3',
      VAULT_NUM_SEATS: '11',
      VAULT_CHIP_UNIT: '0',
      VAULT_RAKE_BPS: '501',
    });
    expect(problems).toContain(`vault-1: numSeats must be ${MIN_SEATS} to ${MAX_SEATS}`);
    expect(problems).toContain('vault-1: chipUnit must be a positive number of token base units');
    expect(problems).toContain(
      `vault-3: rakeBps must be 0 to ${RAKE_BPS_CEILING} (the vault's MAX_RAKE_BPS)`,
    );
    expect(problems.filter((p) => p.startsWith('vault-2:'))).toHaveLength(3);
    expect(new Set(problems).size).toBe(problems.length);
  });

  test('numbers must be whole and non-negative; a bad chip unit is named', () => {
    for (const [name, value] of [
      ['VAULT_NUM_SEATS', '6.5'],
      ['VAULT_RAKE_BPS', '-1'],
      ['VAULT_SMALL_BLIND', '1e3'],
      ['VAULT_TICK_MS', '0x10'],
      ['VAULT_MAX_EPOCH_HANDS', '99999999999999999999'],
    ]) {
      expect(problemsOf({ VAULT_TABLES: '1', [name]: value })).toContain(
        `${name} must be a whole number`,
      );
    }
    expect(problemsOf({ VAULT_TABLES: '1', VAULT_CHIP_UNIT: '1.5' })).toContain(
      'VAULT_CHIP_UNIT must be a whole number of token base units',
    );
    expect(problemsOf({ VAULT_TABLES: '1', VAULT_RESEND_MS: '10000,x' })).toContain(
      'VAULT_RESEND_MS must be a comma-separated list of whole numbers',
    );
  });

  test('policy problems reach the caller', () => {
    expect(problemsOf({ VAULT_TABLES: '1', VAULT_RESEND_MS: '20000,10000' })).toContain(
      'resendMs must rise and stay below signTimeoutMs',
    );
    expect(problemsOf({ VAULT_TABLES: '1', VAULT_TICK_MS: '0' })).toContain(
      'tickMs must be a whole number above 0',
    );
  });
});

describe('policyProblems', () => {
  const policy = (over = {}) => ({ ...POLICY_DEFAULTS, ...over });

  test('the defaults are usable', () => {
    expect(policyProblems(policy())).toEqual([]);
  });

  test('knobs that may be 0 and knobs that may not', () => {
    for (const knob of ['startHoldMs', 'minEpochHands', 'idleKickHands', 'challengeMarginSec']) {
      expect(policyProblems(policy({ [knob]: 0 }))).toEqual([]);
      expect(policyProblems(policy({ [knob]: -1 }))).toEqual([`${knob} must be a whole number`]);
    }
    for (const knob of [
      'signTimeoutMs',
      'absentGraceMs',
      'stallExitMs',
      'policyMaxMs',
      'tickMs',
      'rebindLimit',
    ]) {
      expect(policyProblems(policy({ [knob]: 0 }))).toContain(
        `${knob} must be a whole number above 0`,
      );
      expect(policyProblems(policy({ [knob]: 1.5 }))).toContain(
        `${knob} must be a whole number above 0`,
      );
      expect(policyProblems(policy({ [knob]: undefined }))).toContain(
        `${knob} must be a whole number above 0`,
      );
    }
  });

  test('resends must be positive, rising, and inside the sign deadline', () => {
    const bad = 'resendMs must rise and stay below signTimeoutMs';
    expect(policyProblems(policy({ resendMs: [] }))).toEqual([]);
    expect(policyProblems(policy({ resendMs: [29_999] }))).toEqual([]);
    expect(policyProblems(policy({ resendMs: [30_000] }))).toEqual([bad]);
    expect(policyProblems(policy({ resendMs: [10_000, 10_000] }))).toEqual([bad]);
    expect(policyProblems(policy({ resendMs: [0] }))).toEqual([
      'resendMs must be a list of positive milliseconds',
    ]);
    expect(policyProblems(policy({ resendMs: '10000' }))).toEqual([
      'resendMs must be a list of positive milliseconds',
    ]);
  });

  test('the key margin is below the policy age; min hands do not exceed max hands', () => {
    expect(policyProblems(policy({ policyMarginMs: POLICY_DEFAULTS.policyMaxMs }))).toEqual([
      'policyMarginMs must be below policyMaxMs',
    ]);
    expect(policyProblems(policy({ minEpochHands: 501 }))).toEqual([
      'minEpochHands must not exceed maxEpochHands',
    ]);
    expect(policyProblems(policy({ minEpochHands: 500 }))).toEqual([]);
  });
});

describe('validateVaultTable', () => {
  test('the defaults pass, with or without the chain', () => {
    expect(validateVaultTable(table())).toEqual({ ok: true, problems: [] });
    expect(validateVaultTable(table(), { maxRakeBps: 500 })).toEqual({ ok: true, problems: [] });
  });

  test("rake within the vault's MAX_RAKE_BPS, which may be lower than the contract ceiling", () => {
    expect(validateVaultTable(table({ rakeBps: 300 }), { maxRakeBps: 250 }).problems).toEqual([
      "rakeBps must be 0 to 250 (the vault's MAX_RAKE_BPS)",
    ]);
    expect(validateVaultTable(table({ rakeBps: 250 }), { maxRakeBps: 250 }).ok).toBe(true);
    expect(validateVaultTable(table({ rakeBps: 0 })).ok).toBe(true);
    // a chain that claims more than the contract allows is held to the contract's ceiling
    expect(validateVaultTable(table({ rakeBps: 501 }), { maxRakeBps: 10_000 }).ok).toBe(false);
    expect(validateVaultTable(table({ rakeBps: 2.5 })).ok).toBe(false);
  });

  test('seats 2 to 10 (PokerVault.MAX_PLAYERS)', () => {
    for (const numSeats of [MIN_SEATS, 6, MAX_SEATS])
      expect(validateVaultTable(table({ numSeats })).ok).toBe(true);
    for (const numSeats of [1, MAX_SEATS + 1, 6.5, '6']) {
      expect(validateVaultTable(table({ numSeats })).problems).toEqual([
        `numSeats must be ${MIN_SEATS} to ${MAX_SEATS}`,
      ]);
    }
  });

  test('the chip unit is a positive bigint (a number is a caller bug: it could not hold 18 decimals)', () => {
    for (const chipUnit of [0n, -1n, 10_000, '10000', null]) {
      expect(validateVaultTable(table({ chipUnit })).problems).toEqual([
        'chipUnit must be a positive number of token base units',
      ]);
    }
    expect(validateVaultTable(table({ chipUnit: 1n })).ok).toBe(true);
  });

  test('blinds and buy-ins are positive whole chips in a sensible order', () => {
    expect(validateVaultTable(table({ smallBlind: 0 })).problems).toEqual([
      'smallBlind must be a positive whole number of chips',
    ]);
    expect(validateVaultTable(table({ bigBlind: 4 })).problems).toEqual([
      'bigBlind must be at least smallBlind',
    ]);
    expect(validateVaultTable(table({ minBuyIn: 2000 })).problems).toEqual([
      'minBuyIn must not exceed maxBuyIn',
    ]);
    expect(validateVaultTable(table({ minBuyIn: 9 })).problems).toEqual([
      'minBuyIn must cover at least one big blind',
    ]);
    expect(validateVaultTable(table({ maxBuyIn: 1.5 })).problems).toContain(
      'maxBuyIn must be a positive whole number of chips',
    );
  });

  test('the id is a short non-empty string; a missing table is one problem', () => {
    expect(validateVaultTable(table({ id: '' })).ok).toBe(false);
    expect(validateVaultTable(table({ id: 'x'.repeat(65) })).ok).toBe(false);
    expect(validateVaultTable(table({ id: 'x'.repeat(64) })).ok).toBe(true);
    expect(validateVaultTable(null)).toEqual({ ok: false, problems: ['table missing'] });
  });
});

describe('parseUnits', () => {
  test('decimal strings, bigints and safe integers; nothing else', () => {
    expect(parseUnits('1000000000000000000000000')).toBe(10n ** 24n);
    expect(parseUnits(' 42 ')).toBe(42n);
    expect(parseUnits(7n)).toBe(7n);
    expect(parseUnits(7)).toBe(7n);
    for (const bad of [
      '',
      '01',
      '1.0',
      '-1',
      '0x10',
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      null,
      undefined,
      {},
    ]) {
      expect(parseUnits(bad)).toBeNull();
    }
  });
});
