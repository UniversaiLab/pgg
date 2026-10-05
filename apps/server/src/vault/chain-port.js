// The seam between the vault code (coordinator, watchtower) and a chain. FakeChain (tests) and ViemChain
// (anvil, real chains) both implement it, so the coordinator is written and tested once against the fake and
// then pointed at the real thing. Everything the actor side calls is synchronous: chain I/O happens in the
// background and comes back as events or as a changed cached view (docs/signing-layer.md section 4).
//
// A JOB is only { key, kind, tableKey, priority } (F3, F4). It carries NO bundle and NO state: the bundle that
// matters is whichever one the store holds at the moment the transaction is built, and a job that was queued
// minutes ago must not send a stale one. At execution time the adapter calls the injected RESOLVER, which the
// coordinator side supplies:
//
//   resolver.prepare(job) -> { proceed: false, reason } | { proceed: true, args }
//
// `args` holds what the kind needs, as plain fields:
//
//   createTable             { maxPlayers, minDeposit, maxDeposit }
//   start                   { players }          the exact sorted roster, lowercase addresses
//   startExitFromDeposits   { players }          the roster as `Started` carried it
//   settle | startExit | challenge   { bundle }  { state, arbiterSig, playerSigs } as @pgg/vault makeBundle builds it
//   finalizeExit            { state }            the State whose digest equals the table's exitDigest
//
// prepare() must be synchronous and read the store and a fresh chain view itself. { proceed: false } is not an
// error: no transaction is sent, no event is emitted, and the key is released so the reconciler may submit the
// job again on its next (level-triggered) evaluation. The resolver owns the job's bookkeeping in the store.
import { STATUS } from '@pgg/vault';

/**
 * @typedef {{ key: string, kind: string, tableKey: string, priority: number }} Job
 * @typedef {{ proceed: false, reason: string } | { proceed: true, args: object }} Prepared
 * @typedef {{ prepare: (job: Job) => Prepared }} Resolver  supplied by the coordinator side
 * @typedef {{ type: string, tableKey: string, block: number, logIndex: number }} ChainEvent
 *   plus the fields of its type, see EVENT_TYPES
 * @typedef {{ status: string, nonce: bigint, escrow: bigint, rakePaid: bigint, rosterHash: string,
 *   exitDeadline: number, exitDigest: string, arbiter: string, seated: number, maxPlayers: number,
 *   minDeposit: bigint, maxDeposit: bigint }} TableRow
 * @typedef {{ deposit: bigint, sessionKey: string, confirmed: boolean }} SeatRow
 * @typedef {{ chainId: number, vault: string, arbiter: string, relayer: string, maxRakeBps: number,
 *   exitWindowSec: number }} ChainInfo
 * @typedef {{
 *   info: ChainInfo,
 *   table: (tableKey: string) => TableRow | null,
 *   seat: (tableKey: string, address: string) => SeatRow | null,
 *   chainTime: () => number,
 *   submit: (job: Job) => boolean,
 *   subscribe: (sink: (event: ChainEvent) => void) => () => void,
 * }} ChainPort
 */

/** The seven things the server asks a chain to do. The value of each key is its own name. */
export const JOB_KINDS = Object.freeze({
  createTable: 'createTable',
  start: 'start',
  settle: 'settle',
  startExit: 'startExit',
  startExitFromDeposits: 'startExitFromDeposits',
  challenge: 'challenge',
  finalizeExit: 'finalizeExit',
});

const KINDS = new Set(Object.values(JOB_KINDS));

/**
 * Which job runs first when several are queued: a HIGHER number runs first. challenge > settle >
 * finalizeExit > startExit = startExitFromDeposits > start > createTable. A challenge has a deadline that
 * nobody can extend, a settle frees funds, and a table that is still being created can always wait.
 */
export const JOB_PRIORITY = Object.freeze({
  [JOB_KINDS.challenge]: 6,
  [JOB_KINDS.settle]: 5,
  [JOB_KINDS.finalizeExit]: 4,
  [JOB_KINDS.startExit]: 3,
  [JOB_KINDS.startExitFromDeposits]: 3,
  [JOB_KINDS.start]: 2,
  [JOB_KINDS.createTable]: 1,
});

/**
 * Which funded account sends each kind (F6). The arbiter account is the table's arbiter on chain, so it alone
 * can create, start and (as arbiter) start the stall exit. settle, challenge and finalizeExit are
 * permissionless, so they go out from a separate relayer account and the arbiter key stays out of the
 * transaction path for them.
 */
export const JOB_SENDER = Object.freeze({
  [JOB_KINDS.createTable]: 'arbiter',
  [JOB_KINDS.start]: 'arbiter',
  [JOB_KINDS.startExit]: 'arbiter',
  [JOB_KINDS.startExitFromDeposits]: 'arbiter',
  [JOB_KINDS.settle]: 'relayer',
  [JOB_KINDS.challenge]: 'relayer',
  [JOB_KINDS.finalizeExit]: 'relayer',
});

/**
 * What a chain tells its subscribers. Every event is { type, tableKey, block, logIndex, ...fields } and the
 * fields follow the contract's event arguments:
 *
 *   TableCreated  { arbiter, maxPlayers, minDeposit, maxDeposit }
 *   Deposited     { player, amount, total, sessionKey }
 *   SessionKeySet { player, sessionKey }
 *   Left          { player, amount }
 *   Started       { players }
 *   Settled       { nonce, rakePaid, rakeDelta, stayers }
 *   ExitStarted   { by, nonce, digest, deadline }
 *   Challenged    { by, nonce, digest, deadline }
 *   ExitFinalized { nonce, rakePaid, rakeDelta }
 *   Payout        { to, amount, pushed }
 *   JobFailed     { key, kind, error, retryable, args? }     SYNTHETIC: not a log, see below
 *
 * Amounts, nonces and rake are bigint; addresses lowercase; `deadline` is chain seconds (a number).
 *
 * Events come from the adapter's poll timer, never from inside submit() or a read. Delivery is in order: for
 * any two events (block, logIndex) is strictly increasing. JobFailed is not a chain log: it carries the latest
 * block and a logIndex above every log delivered for that block, so it sorts after everything the consumer has
 * seen. `error` is the contract's own name when the contract said no (StaleNonce, WrongStatus, ...) and
 * `retryable` says whether the same job can succeed later without anything else changing.
 */
export const EVENT_TYPES = Object.freeze({
  TableCreated: 'TableCreated',
  Deposited: 'Deposited',
  SessionKeySet: 'SessionKeySet',
  Left: 'Left',
  Started: 'Started',
  Settled: 'Settled',
  ExitStarted: 'ExitStarted',
  Challenged: 'Challenged',
  ExitFinalized: 'ExitFinalized',
  Payout: 'Payout',
  JobFailed: 'JobFailed',
});

/** PokerVault.Status by name. `chain.table()` returns null for None, so a row is Filling or later. */
export const TABLE_STATUS = Object.freeze({
  None: 'None',
  Filling: 'Filling',
  Active: 'Active',
  Exiting: 'Exiting',
  Closed: 'Closed',
});

const STATUS_BY_NUMBER = Object.keys(STATUS);

/** A status as its name. Takes the name, or the contract's number (number or bigint); anything else throws. */
export function statusName(status) {
  if (typeof status === 'string' && Object.hasOwn(TABLE_STATUS, status)) return status;
  const n = typeof status === 'bigint' ? Number(status) : status;
  if (Number.isInteger(n) && STATUS_BY_NUMBER[n] !== undefined) return STATUS_BY_NUMBER[n];
  throw new RangeError(`not a table status: ${String(status)}`);
}

/**
 * The idempotency key of a job: 'chain-action:' + tableKey + ':' + kind.
 *
 * DECISION. The spec says "one action in flight per table", and the first sketch keyed jobs by table alone.
 * That would let a queued startExit swallow the settle (or challenge) the reconciler asks for next, because
 * the second submit would look like a duplicate. So the key carries the kind: the queue de-duplicates the SAME
 * action for a table, and a different action for that table is never dropped. "One action in flight" is then
 * kept by two other things: the reconciler returns at most one action per table per evaluation, and every job
 * re-reads the chain right before it sends (and, in a real adapter, simulates), so a queued job that has
 * become pointless ends as a skipped or failed job instead of a reverted transaction.
 *
 * A key is held only while its job is queued or running. Once the job has finished (sent, failed or skipped)
 * the same key may be submitted again: the reconciler is level-triggered and must be able to retry a
 * transaction that was reorged away or a job that failed retryably.
 */
export function makeJobKey(kind, tableKey) {
  if (!KINDS.has(kind)) throw new RangeError(`unknown job kind: ${String(kind)}`);
  if (typeof tableKey !== 'string' || tableKey === '' || tableKey.includes(':')) {
    throw new RangeError('tableKey must be a non-empty string without ":"');
  }
  return `chain-action:${tableKey}:${kind}`;
}

/** { key, kind, tableKey, priority } for a kind and a table: the only shape a job ever has. */
export function makeJob(kind, tableKey) {
  return { key: makeJobKey(kind, tableKey), kind, tableKey, priority: JOB_PRIORITY[kind] };
}

const JOB_FIELDS = ['key', 'kind', 'tableKey', 'priority'];
const BYTES32 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Throws unless `job` is exactly { key, kind, tableKey, priority } with a bytes32 tableKey, the key
 * makeJobKey builds and the priority JOB_PRIORITY gives. Extra fields are refused, bundle and state above
 * all (F3, F4): a job that could carry its own payload would be sent as it was queued, not as the store has
 * it now. Returns the job.
 */
export function assertJob(job) {
  if (job === null || typeof job !== 'object') throw new TypeError('job must be an object');
  const extra = Object.keys(job).filter((k) => !JOB_FIELDS.includes(k));
  if (extra.length > 0) {
    throw new TypeError(
      `a job is only { key, kind, tableKey, priority }; remove: ${extra.join(', ')} (bundles and states are resolved at execution time)`,
    );
  }
  if (!KINDS.has(job.kind)) throw new TypeError(`unknown job kind: ${String(job.kind)}`);
  if (typeof job.tableKey !== 'string' || !BYTES32.test(job.tableKey)) {
    throw new TypeError('job.tableKey must be 32 bytes of lowercase 0x hex');
  }
  if (job.key !== makeJobKey(job.kind, job.tableKey)) {
    throw new TypeError(`job.key must be ${makeJobKey(job.kind, job.tableKey)}`);
  }
  if (job.priority !== JOB_PRIORITY[job.kind]) {
    throw new TypeError(`job.priority for ${job.kind} must be ${JOB_PRIORITY[job.kind]}`);
  }
  return job;
}

/** Sort comparator: the job that should run first sorts first (a higher priority number first). */
export const compareJobs = (a, b) => b.priority - a.priority;

/** Sort comparator for events by (block, logIndex). */
export function comparePosition(a, b) {
  if (a.block !== b.block) return a.block < b.block ? -1 : 1;
  if (a.logIndex !== b.logIndex) return a.logIndex < b.logIndex ? -1 : 1;
  return 0;
}

// Reverts that go away on their own: the owner unpauses, the chain clock passes the deadline. Everything
// else the contract says (StaleNonce, WrongStatus, BadSignature...) is about the state of the table, and the
// same transaction would say it again, so it is an alarm and not a retry.
const RETRYABLE_REVERTS = new Set(['EnforcedPause', 'ExitWindowOpen']);

/** Would the same job succeed later without anything else changing? Only for a contract revert's name. */
export const isRetryableRevert = (error) => RETRYABLE_REVERTS.has(error);

const isFn = (value) => typeof value === 'function';

/**
 * Throws a TypeError listing everything that is wrong when `chain` is not shaped like a ChainPort, and
 * returns it otherwise. Shape only: it does not call submit or subscribe.
 *
 *   chain.info                        { chainId, vault, arbiter, relayer, maxRakeBps, exitWindowSec }
 *   chain.table(tableKey)             null | { status, nonce, escrow, rakePaid, rosterHash, exitDeadline,
 *                                       exitDigest, arbiter, seated, maxPlayers, minDeposit, maxDeposit }
 *                                     status is a TABLE_STATUS name; nonce, escrow, rakePaid, minDeposit and
 *                                     maxDeposit are bigint; exitDeadline is chain seconds. A cached read: a
 *                                     periodic re-read repairs a missed event.
 *   chain.seat(tableKey, address)     null | { deposit, sessionKey, confirmed }   deposit is bigint;
 *                                     confirmed is false while the deposit is below confirmation depth
 *   chain.chainTime()                 latest known block timestamp in seconds. Contract deadlines are judged
 *                                     against this and never against Date.now().
 *   chain.submit(job)                 queue a job; idempotent by job.key while the job is queued or running.
 *                                     Returns true when queued, false for a duplicate. Never sends anything
 *                                     itself and never delivers an event.
 *   chain.subscribe(sink)             sink(event) is called from the poll timer, in order; returns an
 *                                     unsubscribe function. An adapter MAY take { after: { block, logIndex } }
 *                                     as a second argument to replay missed events (FakeChain does not need it).
 */
export function assertChainPort(chain) {
  const problems = [];
  if (chain === null || typeof chain !== 'object') {
    throw new TypeError('ChainPort must be an object');
  }
  const info = chain.info;
  if (info === null || typeof info !== 'object') {
    problems.push('info must be an object');
  } else {
    if (!Number.isSafeInteger(info.chainId) || info.chainId <= 0) {
      problems.push('info.chainId must be a positive safe integer');
    }
    for (const field of ['vault', 'arbiter', 'relayer']) {
      if (typeof info[field] !== 'string' || !ADDRESS.test(info[field])) {
        problems.push(`info.${field} must be a 20-byte 0x address`);
      }
    }
    if (!Number.isInteger(info.maxRakeBps) || info.maxRakeBps < 0 || info.maxRakeBps > 500) {
      problems.push('info.maxRakeBps must be an integer from 0 to 500');
    }
    if (!Number.isSafeInteger(info.exitWindowSec) || info.exitWindowSec <= 0) {
      problems.push('info.exitWindowSec must be a positive safe integer');
    }
  }
  for (const method of ['table', 'seat', 'chainTime', 'submit', 'subscribe']) {
    if (!isFn(chain[method])) problems.push(`${method} must be a function`);
  }
  if (problems.length > 0) throw new TypeError(`not a ChainPort: ${problems.join('; ')}`);
  return chain;
}
