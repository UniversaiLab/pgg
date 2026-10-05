import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  assertChainPort,
  assertJob,
  compareJobs,
  comparePosition,
  EVENT_TYPES,
  isRetryableRevert,
  JOB_KINDS,
  JOB_PRIORITY,
  JOB_SENDER,
  makeJob,
  makeJobKey,
  statusName,
  TABLE_STATUS,
} from '../../src/vault/chain-port.js';
import { FakeChain } from '../../src/vault/fake-chain.js';

const T = `0x${'ab'.repeat(32)}`;
const OTHER = `0x${'cd'.repeat(32)}`;

describe('JOB_KINDS, JOB_PRIORITY, JOB_SENDER', () => {
  test('the seven kinds, each named by its own key, frozen', () => {
    expect(Object.keys(JOB_KINDS).sort()).toEqual(
      [
        'challenge',
        'createTable',
        'finalizeExit',
        'settle',
        'start',
        'startExit',
        'startExitFromDeposits',
      ].sort(),
    );
    for (const [name, value] of Object.entries(JOB_KINDS)) expect(value).toBe(name);
    expect(Object.isFrozen(JOB_KINDS)).toBe(true);
    expect(Object.isFrozen(JOB_PRIORITY)).toBe(true);
    expect(Object.isFrozen(JOB_SENDER)).toBe(true);
  });

  test('challenge > settle > finalizeExit > startExit = startExitFromDeposits > start > createTable', () => {
    const p = JOB_PRIORITY;
    expect(p.challenge).toBeGreaterThan(p.settle);
    expect(p.settle).toBeGreaterThan(p.finalizeExit);
    expect(p.finalizeExit).toBeGreaterThan(p.startExit);
    expect(p.startExit).toBe(p.startExitFromDeposits);
    expect(p.startExit).toBeGreaterThan(p.start);
    expect(p.start).toBeGreaterThan(p.createTable);
    expect(Object.keys(p).sort()).toEqual(Object.keys(JOB_KINDS).sort());
  });

  test('a higher priority sorts first with compareJobs', () => {
    const jobs = ['createTable', 'challenge', 'start', 'settle'].map((k) => makeJob(k, T));
    expect(jobs.sort(compareJobs).map((j) => j.kind)).toEqual([
      'challenge',
      'settle',
      'start',
      'createTable',
    ]);
  });

  test('the arbiter account sends create, start and the exits it starts; the relayer the permissionless three', () => {
    expect(JOB_SENDER).toEqual({
      createTable: 'arbiter',
      start: 'arbiter',
      startExit: 'arbiter',
      startExitFromDeposits: 'arbiter',
      settle: 'relayer',
      challenge: 'relayer',
      finalizeExit: 'relayer',
    });
  });
});

describe('EVENT_TYPES', () => {
  test('exactly the events of the spec, plus the synthetic JobFailed', () => {
    expect(Object.values(EVENT_TYPES).sort()).toEqual(
      [
        'TableCreated',
        'Deposited',
        'SessionKeySet',
        'Left',
        'Started',
        'Settled',
        'ExitStarted',
        'Challenged',
        'ExitFinalized',
        'Payout',
        'JobFailed',
      ].sort(),
    );
    for (const [name, value] of Object.entries(EVENT_TYPES)) expect(value).toBe(name);
  });

  test('comparePosition orders by block, then by logIndex', () => {
    const at = (block, logIndex) => ({ block, logIndex });
    expect(comparePosition(at(1, 5), at(2, 0))).toBe(-1);
    expect(comparePosition(at(2, 0), at(1, 5))).toBe(1);
    expect(comparePosition(at(2, 1), at(2, 3))).toBe(-1);
    expect(comparePosition(at(2, 3), at(2, 1))).toBe(1);
    expect(comparePosition(at(2, 3), at(2, 3))).toBe(0);
  });
});

describe('makeJobKey and makeJob: the kind is part of the key', () => {
  test('the format is chain-action:<tableKey>:<kind>', () => {
    expect(makeJobKey('settle', T)).toBe(`chain-action:${T}:settle`);
  });

  test('DECISION: two different actions on one table never share a key, so one never swallows the other', () => {
    expect(makeJobKey('startExit', T)).not.toBe(makeJobKey('settle', T));
    expect(makeJobKey('challenge', T)).not.toBe(makeJobKey('settle', T));
    expect(makeJobKey('settle', T)).toBe(makeJobKey('settle', T));
    expect(makeJobKey('settle', T)).not.toBe(makeJobKey('settle', OTHER));
  });

  test('an unknown kind or a tableKey that cannot be told apart in a key is refused', () => {
    expect(() => makeJobKey('refund', T)).toThrow(RangeError);
    expect(() => makeJobKey(undefined, T)).toThrow(RangeError);
    expect(() => makeJobKey('settle', '')).toThrow(RangeError);
    expect(() => makeJobKey('settle', undefined)).toThrow(RangeError);
    expect(() => makeJobKey('settle', 'a:b')).toThrow(RangeError);
  });

  test('a job is only { key, kind, tableKey, priority }', () => {
    for (const kind of Object.values(JOB_KINDS)) {
      const job = makeJob(kind, T);
      expect(job).toEqual({
        key: `chain-action:${T}:${kind}`,
        kind,
        tableKey: T,
        priority: JOB_PRIORITY[kind],
      });
      expect(Object.keys(job).sort()).toEqual(['key', 'kind', 'priority', 'tableKey']);
    }
  });
});

describe('assertJob', () => {
  test('accepts what makeJob builds', () => {
    for (const kind of Object.values(JOB_KINDS)) {
      const job = makeJob(kind, T);
      expect(assertJob(job)).toBe(job);
    }
  });

  test('F3, F4: refuses a job that carries a bundle or a state, or anything else extra', () => {
    const job = makeJob('settle', T);
    expect(() => assertJob({ ...job, bundle: {} })).toThrow(/bundle/);
    expect(() => assertJob({ ...job, state: {} })).toThrow(/state/);
    expect(() => assertJob({ ...job, args: {} })).toThrow(/args/);
    expect(() => assertJob({ ...job, status: 'pending' })).toThrow(/status/);
  });

  test('refuses a missing field, a wrong key, a wrong priority, a bad tableKey and a non-object', () => {
    const job = makeJob('challenge', T);
    for (const field of ['key', 'kind', 'tableKey', 'priority']) {
      const { [field]: _gone, ...rest } = job;
      expect(() => assertJob(rest)).toThrow(TypeError);
    }
    expect(() => assertJob({ ...job, key: makeJobKey('settle', T) })).toThrow(/key/);
    expect(() => assertJob({ ...job, priority: JOB_PRIORITY.settle })).toThrow(/priority/);
    expect(() => assertJob({ ...job, priority: String(job.priority) })).toThrow(/priority/);
    expect(() => assertJob({ ...job, kind: 'refund' })).toThrow(/kind/);
    expect(() => assertJob({ ...job, tableKey: 'table-1' })).toThrow(/tableKey/);
    expect(() => assertJob({ ...job, tableKey: T.toUpperCase().replace('0X', '0x') })).toThrow(
      /tableKey/,
    );
    for (const notAJob of [null, 'job', undefined, 5, true]) {
      expect(() => assertJob(notAJob)).toThrow(TypeError);
      expect(() => assertJob(notAJob)).toThrow(/job must be an object/);
    }
  });
});

describe('statusName', () => {
  test('names, the contract numbers (number and bigint) and nothing else', () => {
    expect(['None', 'Filling', 'Active', 'Exiting', 'Closed'].map(statusName)).toEqual([
      'None',
      'Filling',
      'Active',
      'Exiting',
      'Closed',
    ]);
    expect([0, 1, 2, 3, 4].map(statusName)).toEqual([
      TABLE_STATUS.None,
      TABLE_STATUS.Filling,
      TABLE_STATUS.Active,
      TABLE_STATUS.Exiting,
      TABLE_STATUS.Closed,
    ]);
    expect(statusName(3n)).toBe('Exiting');
    for (const bad of [5, -1, 1.5, 'active', 'toString', 'constructor', null, undefined, {}]) {
      expect(() => statusName(bad)).toThrow(RangeError);
    }
  });
});

describe('isRetryableRevert', () => {
  test('only reverts that go away by themselves are retryable', () => {
    expect(isRetryableRevert('EnforcedPause')).toBe(true);
    expect(isRetryableRevert('ExitWindowOpen')).toBe(true);
    for (const error of [
      'StaleNonce',
      'WrongStatus',
      'NotConserved',
      'BadSignature',
      'ExitWindowClosed',
      'DigestMismatch',
      'NotArbiter',
      'RosterMismatch',
      'Panic',
      'Malformed',
    ]) {
      expect(isRetryableRevert(error)).toBe(false);
    }
  });
});

describe('assertChainPort', () => {
  const good = () => ({
    info: {
      chainId: 31337,
      vault: `0x${'11'.repeat(20)}`,
      arbiter: `0x${'22'.repeat(20)}`,
      relayer: `0x${'33'.repeat(20)}`,
      maxRakeBps: 500,
      exitWindowSec: 3600,
    },
    table: () => null,
    seat: () => null,
    chainTime: () => 0,
    submit: () => true,
    subscribe: () => () => {},
  });

  test('a FakeChain is a ChainPort, and so is a hand-made one', () => {
    const chain = new FakeChain();
    expect(assertChainPort(chain)).toBe(chain);
    const port = good();
    expect(assertChainPort(port)).toBe(port);
  });

  test('says what is missing, all of it at once', () => {
    for (const method of ['table', 'seat', 'chainTime', 'submit', 'subscribe']) {
      const port = good();
      delete port[method];
      expect(() => assertChainPort(port)).toThrow(new RegExp(`${method} must be a function`));
    }
    const port = good();
    port.submit = 'nope';
    delete port.seat;
    expect(() => assertChainPort(port)).toThrow(/submit.*seat|seat.*submit/s);
  });

  test('checks every field of info', () => {
    const mutate = (patch) => ({ ...good(), info: { ...good().info, ...patch } });
    expect(() => assertChainPort({ ...good(), info: undefined })).toThrow(/info/);
    expect(() => assertChainPort(mutate({ chainId: 0 }))).toThrow(/chainId/);
    expect(() => assertChainPort(mutate({ chainId: '31337' }))).toThrow(/chainId/);
    expect(() => assertChainPort(mutate({ vault: '0x12' }))).toThrow(/vault/);
    expect(() => assertChainPort(mutate({ arbiter: undefined }))).toThrow(/arbiter/);
    expect(() => assertChainPort(mutate({ relayer: 5 }))).toThrow(/relayer/);
    expect(() => assertChainPort(mutate({ maxRakeBps: 501 }))).toThrow(/maxRakeBps/);
    expect(() => assertChainPort(mutate({ maxRakeBps: -1 }))).toThrow(/maxRakeBps/);
    expect(() => assertChainPort(mutate({ maxRakeBps: 1.5 }))).toThrow(/maxRakeBps/);
    expect(() => assertChainPort(mutate({ exitWindowSec: 0 }))).toThrow(/exitWindowSec/);
    expect(() => assertChainPort(mutate({ exitWindowSec: 3600n }))).toThrow(/exitWindowSec/);
  });

  test('refuses things that are not objects', () => {
    expect(() => assertChainPort(null)).toThrow(TypeError);
    expect(() => assertChainPort(undefined)).toThrow(TypeError);
    expect(() => assertChainPort('chain')).toThrow(TypeError);
  });
});

// Ground rules for everything the TableActor's vault layer sits on: synchronous (no awaiting inside a method
// the actor calls) and no wall clock or randomness (an NTP step must not fire an exit early, and a test must
// be able to replay a run). A scan is blunt but it fails the moment someone adds one.
describe('the chain-side vault files obey the ground rules', () => {
  const FILES = ['chain-port', 'fake-chain', 'reconcile', 'signer', 'null-wallet'];
  const code = (name) =>
    readFileSync(new URL(`../../src/vault/${name}.js`, import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

  test('no Date.now, no Math.random, no timers, no async or await', () => {
    for (const name of FILES) {
      const source = code(name);
      expect(source).not.toMatch(/\bDate\b/);
      expect(source).not.toMatch(/\bperformance\b/);
      expect(source).not.toMatch(/Math\.random/);
      expect(source).not.toMatch(/\b(setTimeout|setInterval|setImmediate|queueMicrotask)\b/);
      expect(source).not.toMatch(/\b(async|await)\b/);
      expect(source).not.toMatch(/\bPromise\b/);
    }
  });

  test('the scan sees code: the files it reads are not empty and do contain what they should', () => {
    expect(code('fake-chain')).toMatch(/class FakeChain/);
    expect(code('reconcile')).toMatch(/export function nextChainAction/);
    expect(code('signer')).toMatch(/class LocalKeySigner/);
    expect(code('null-wallet')).toMatch(/class NullWallet/);
    expect(code('chain-port')).toMatch(/export const JOB_KINDS/);
  });
});
