// The durable state behind the arbiter's double-sign guard. This file holds everything the two stores
// (MemoryStore for tests, SqliteStore for real) must agree on: the interface, the errors, how values are
// encoded, and every DECISION (is this reserve a repeat, a double sign or a regression? is this bundle
// newer?). The stores only move bytes in and out of storage, so the rules cannot drift between them, and
// the one shared contract suite (test/vault/store.contract.js) runs against both.
//
// Everything is synchronous: the TableActor never awaits. Token amounts, nonces, rake and volume are
// BigInt; they are stored as decimal TEXT and compared as numbers in code, never as text.
import {
  fromWire,
  makeBundle,
  normalizeAddress,
  normalizeState,
  toWire,
  UINT64_MAX,
  UINT256_MAX,
  verifyBundle,
} from '@pgg/vault';

/**
 * A vault table as the coordinator persists it. Fields not listed here are kept as they are.
 * @typedef {object} TableRecord
 * @property {string} tableKey
 * @property {string} [serverId]
 * @property {number|bigint} [generation]
 * @property {number|bigint} [epoch]
 * @property {string} [phase]
 * @property {unknown} [roster]
 * @property {object} pinned  chipUnit, blinds, rakeBps, numSeats: fixed for the life of a tableKey
 * @property {bigint} epochBaseNonce  nonce of the state that opened the current epoch; never decreases
 * @property {bigint} nonceHw  highest nonce ever reserved or adopted; never decreases
 * @property {bigint} rakeCum  cumulative rake of the highest state; never decreases
 * @property {bigint} volumeCum  cumulative volume of the highest state; never decreases
 * @property {bigint} rakePaid
 * @property {Record<string, bigint>} dust  token units that do not fill a chip, by address
 * @property {{block: bigint|number, logIndex: number}|null} lastAppliedEvent
 * @property {number} [updatedAt]
 */

/**
 * One chain action to run. The job carries no bundle or state: the executor reads the best one from the
 * store when it runs.
 * @typedef {object} Job
 * @property {string} key  unique; enqueueing it twice is a no-op
 * @property {string} kind
 * @property {string} tableKey
 * @property {number} priority  higher runs first
 * @property {'pending'|'sent'|'done'|'failed'} status
 * @property {string|null} txHash
 * @property {number} attempts
 * @property {string|null} error
 * @property {unknown} [data]  optional JSON-safe payload (bigints allowed)
 */

/**
 * @typedef {object} SignedState
 * @property {object} state  the internal State (bigint amounts)
 * @property {string} digest
 * @property {string|null} arbiterSig  null while reserved but not yet signed
 */

/**
 * A reserved state that has no complete bundle yet: the sign round in flight (or lost in a crash).
 * @typedef {SignedState & { nonce: bigint, playerSigs: Map<string, string> }} Round
 */

/**
 * @typedef {object} Alarm
 * @property {number} id
 * @property {string} kind  bundle-conflict, arbiter-sig-conflict or player-sig-conflict
 * @property {string} tableKey
 * @property {bigint} nonce
 * @property {unknown} detail
 * @property {number} count  how many times the same alarm was raised
 */

/**
 * The StateStore interface (docs/signing-layer.md section 4). Both stores implement exactly these.
 * Every method is synchronous. A refusal is a StoreError (or DoubleSignError) with a `code`; a bad
 * argument is a TypeError or RangeError and changes nothing.
 *
 *   transaction(fn)                  atomic, re-entrant (a nested call can fail alone), returns fn's
 *                                    result; fn must not be async
 *   loadTable(tableKey)              the record or null
 *   saveTable(record)                returns what was stored. Counters (nonceHw, rakeCum, volumeCum) only
 *                                    move forward, epochBaseNonce never goes back, `pinned` never changes
 *   listTables()                     every record, for boot
 *   reserve(tableKey, state, digest) the double-sign guard: true when stored, false on an exact repeat,
 *                                    DoubleSignError for another digest at a stored nonce. The table
 *                                    must have been saved, and `state.tableId` must be the tableKey
 *   attachArbiterSig(tableKey, nonce, sig)
 *   addPlayerSig(tableKey, nonce, address, sig)
 *                                    { stored, conflict }: a different signature is kept out and raises
 *                                    an alarm. The nonce must be reserved
 *   playerSigs(tableKey, nonce)      Map address -> sig, in roster order
 *   getSigned(tableKey, nonce)       SignedState or null
 *   latestSigned(tableKey, { anyEpoch })
 *                                    highest reserved state of the CURRENT epoch (nonce above
 *                                    epochBaseNonce), or of any epoch with { anyEpoch: true }
 *   openRound(tableKey)              Round: the highest reserved state of the current epoch that no
 *                                    saved bundle covers, even before the arbiter signed it, or null
 *   saveBundle(tableKey, bundle, verifyCtx)
 *                                    verifies first (verifyCtx = { arbiter, sessionKeyOf, expect:
 *                                    { domain, tableId, players } }, all three required). Returns
 *                                    { saved: true } or { saved: false, reason } with reason 'invalid'
 *                                    (plus error and args from verifyBundle), 'not-newer', 'conflict'
 *                                    (same nonce, other digest: also an alarm) or 'old-epoch'. A bundle
 *                                    nobody reserved is adopted: its state is stored too, so the
 *                                    arbiter can never sign another one at that nonce
 *   loadBundle(tableKey)             newest bundle of the current epoch or null
 *   loadFinalBundle(tableKey)        the last final bundle, kept after the epoch moves on, or null
 *   enqueueJob(job)                  true when a job was created, false when its key is held by a pending
 *                                    or sent job. A done or failed job gives up its key and is replaced
 *                                    by a fresh pending one (the same action is needed every epoch)
 *   getJob(key) / pendingJobs()      pendingJobs: everything not done, priority first, then insertion
 *   markJob(key, status, patch)      false for an unknown key; patch fields txHash, attempts, error
 *   getCursor() / setCursor(block)   chain cursor, null until set; setCursor is false (and ignored)
 *                                    when it would move backwards
 *   alarms(tableKey?)                equal-nonce-different-digest and signature conflicts
 *   close()                          every later call throws a StoreError with code 'closed'
 *
 * Both stores also have failAfterWrites(k, error) and writeCount (the crash-point hook, see the
 * stores); SqliteStore adds settings() and integrityCheck().
 *
 * @typedef {object} StateStore
 */

export const STORE_METHODS = Object.freeze([
  'transaction',
  'loadTable',
  'saveTable',
  'listTables',
  'reserve',
  'attachArbiterSig',
  'addPlayerSig',
  'playerSigs',
  'getSigned',
  'latestSigned',
  'openRound',
  'saveBundle',
  'loadBundle',
  'loadFinalBundle',
  'enqueueJob',
  'getJob',
  'pendingJobs',
  'markJob',
  'getCursor',
  'setCursor',
  'alarms',
]);

export const JOB_STATUSES = Object.freeze(['pending', 'sent', 'done', 'failed']);

/** A job in one of these states no longer holds its key: enqueueing the same key again starts a new job. */
export const JOB_FINISHED = Object.freeze(['done', 'failed']);

/** A store refusal. `code` says why, so callers branch on it instead of on message text. */
export class StoreError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/** A second, different digest was offered for a nonce that already has one. The caller must halt. */
export class DoubleSignError extends StoreError {
  constructor({ tableKey, nonce, stored, attempted }) {
    super(
      'double-sign',
      `table ${tableKey} already has digest ${stored} at nonce ${nonce}; refusing ${attempted}`,
    );
    this.name = 'DoubleSignError';
    this.tableKey = tableKey;
    this.nonce = nonce;
    this.stored = stored;
    this.attempted = attempted;
  }
}

// ---- values ---------------------------------------------------------------------------------------

const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const DIGEST = /^0x[0-9a-fA-F]{64}$/;
const SIGNED_DECIMAL = /^-?(0|[1-9][0-9]*)$/;
const BIGINT_TAG = '$bigint';
const MAX_DEPTH = 32;

export const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

export const isThenable = (value) =>
  value !== null &&
  (typeof value === 'object' || typeof value === 'function') &&
  typeof value.then === 'function';

export const maxOf = (a, b) => (a > b ? a : b);

/** A tableKey, lowercased so two spellings can never be two tables. */
export function keyOf(value, field = 'tableKey') {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.toLowerCase();
}

export function uintOf(value, max, field) {
  let v;
  if (typeof value === 'bigint') v = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) v = BigInt(value);
  else throw new TypeError(`${field} must be a bigint`);
  if (v < 0n || v > max) throw new RangeError(`${field} is out of range`);
  return v;
}

export const nonceOf = (value, field = 'nonce') => uintOf(value, UINT64_MAX, field);

export function digestOf(value, field = 'digest') {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    throw new RangeError(`${field} must be 32 bytes of 0x hex`);
  }
  return value.toLowerCase();
}

export function sigOf(value, field = 'signature') {
  if (typeof value !== 'string' || !SIGNATURE.test(value)) {
    throw new RangeError(`${field} must be a 65-byte 0x signature`);
  }
  return value.toLowerCase();
}

// JSON that keeps bigints exact: a bigint becomes { "$bigint": "123" }. Anything that JSON would silently
// change (undefined in an array, NaN, a Map, a Date, a class instance) is refused instead, and object keys
// are sorted so the stored text does not depend on insertion order.
function toPlain(value, path, depth) {
  if (depth > MAX_DEPTH) throw new RangeError(`${path} is nested too deeply`);
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) throw new RangeError(`${path} must be a finite number`);
      return value;
    case 'bigint':
      return { [BIGINT_TAG]: value.toString() };
    case 'object':
      break;
    default:
      throw new TypeError(`${path} cannot be stored (${typeof value})`);
  }
  if (Array.isArray(value)) {
    // Array.from visits holes as undefined, which toPlain refuses
    return Array.from(value, (item, i) => toPlain(item, `${path}[${i}]`, depth + 1));
  }
  if (!isPlainObject(value)) throw new TypeError(`${path} must be a plain object`);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (key === '__proto__' || key === BIGINT_TAG)
      throw new TypeError(`${path}.${key} is reserved`);
    if (value[key] !== undefined) out[key] = toPlain(value[key], `${path}.${key}`, depth + 1);
  }
  return out;
}

const revive = (_key, value) => {
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === BIGINT_TAG && SIGNED_DECIMAL.test(value[BIGINT_TAG])) {
      return BigInt(value[BIGINT_TAG]);
    }
  }
  return value;
};

/** Value -> JSON text, bigint-safe and canonical. Throws on anything JSON would silently alter. */
export const encodeJson = (value, field = 'value') =>
  JSON.stringify(toPlain(value, field, 0)) ?? 'null';

/** The inverse of encodeJson. Returns a fresh copy every time, so a caller can never alias stored data. */
export const decodeJson = (text) => JSON.parse(text, revive);

// ---- table records --------------------------------------------------------------------------------

function amountMap(value, field) {
  if (!isPlainObject(value)) throw new TypeError(`${field} must be an object`);
  const out = {};
  for (const [key, amount] of Object.entries(value)) {
    out[key] = uintOf(amount, UINT256_MAX, `${field}.${key}`);
  }
  return out;
}

function eventPosition(value) {
  if (value === null) return null;
  if (!isPlainObject(value))
    throw new TypeError('lastAppliedEvent must be { block, logIndex } or null');
  for (const field of ['block', 'logIndex']) {
    uintOf(value[field], UINT64_MAX, `lastAppliedEvent.${field}`);
  }
  return value;
}

/**
 * Split a record into the four counters the store guards (`hot`) and everything else (`body`). Missing
 * counters are 0 and missing dust is empty; fields the store does not know are kept untouched.
 */
export function parseTableRecord(record) {
  if (!isPlainObject(record)) throw new TypeError('table record must be an object');
  const { tableKey, epochBaseNonce, nonceHw, rakeCum, volumeCum, ...rest } = record;
  if (!isPlainObject(rest.pinned)) throw new TypeError('pinned must be an object');
  const hot = {
    epochBaseNonce: nonceOf(epochBaseNonce ?? 0n, 'epochBaseNonce'),
    nonceHw: nonceOf(nonceHw ?? 0n, 'nonceHw'),
    rakeCum: uintOf(rakeCum ?? 0n, UINT256_MAX, 'rakeCum'),
    volumeCum: uintOf(volumeCum ?? 0n, UINT256_MAX, 'volumeCum'),
  };
  const body = {
    ...rest,
    rakePaid: uintOf(rest.rakePaid ?? 0n, UINT256_MAX, 'rakePaid'),
    dust: amountMap(rest.dust ?? {}, 'dust'),
    lastAppliedEvent: eventPosition(rest.lastAppliedEvent ?? null),
  };
  return { tableKey: keyOf(tableKey), hot, body, bodyJson: encodeJson(body, 'record') };
}

/**
 * What saveTable stores, given what is stored. The counters only move forward (a record read before a
 * reserve and saved after it must not undo the reserve), the epoch base never moves back (nonces never
 * reset), the high-water mark is at least the epoch base, and `pinned` is frozen once the table exists.
 */
export function mergeTable(stored, parsed) {
  const { hot: incoming } = parsed;
  if (!stored) {
    const nonceHw = maxOf(incoming.nonceHw, incoming.epochBaseNonce);
    return { hot: { ...incoming, nonceHw }, bodyJson: parsed.bodyJson };
  }
  if (incoming.epochBaseNonce < stored.hot.epochBaseNonce) {
    throw new StoreError(
      'epoch-base-regression',
      `epochBaseNonce cannot go from ${stored.hot.epochBaseNonce} down to ${incoming.epochBaseNonce}`,
    );
  }
  if (encodeJson(decodeJson(stored.bodyJson).pinned) !== encodeJson(parsed.body.pinned)) {
    throw new StoreError('pinned-changed', `pinned config of ${parsed.tableKey} cannot change`);
  }
  const { epochBaseNonce } = incoming;
  return {
    hot: {
      epochBaseNonce,
      nonceHw: maxOf(maxOf(stored.hot.nonceHw, incoming.nonceHw), epochBaseNonce),
      rakeCum: maxOf(stored.hot.rakeCum, incoming.rakeCum),
      volumeCum: maxOf(stored.hot.volumeCum, incoming.volumeCum),
    },
    bodyJson: parsed.bodyJson,
  };
}

export const buildRecord = (tableKey, hot, bodyJson) => ({
  tableKey,
  ...decodeJson(bodyJson),
  epochBaseNonce: hot.epochBaseNonce,
  nonceHw: hot.nonceHw,
  rakeCum: hot.rakeCum,
  volumeCum: hot.volumeCum,
});

// ---- reserve --------------------------------------------------------------------------------------

/** Validate what reserve() is given and encode the state once, so a repeat can be compared byte for byte. */
export function parseReserve(tableKey, state, digest) {
  const key = keyOf(tableKey);
  const normal = normalizeState(state);
  if (normal.tableId !== key) {
    throw new StoreError('table-mismatch', `state is for table ${normal.tableId}, not ${key}`);
  }
  return {
    tableKey: key,
    state: normal,
    nonce: normal.nonce,
    digest: digestOf(digest),
    stateJson: JSON.stringify(toWire(normal)),
  };
}

/**
 * The whole double-sign rule, in order. `table` is { epochBaseNonce, nonceHw } or null; `existing` is
 * { digest, stateJson } stored at this nonce or null. Returns 'insert' or 'repeat', or throws.
 *
 * A second digest at a stored nonce is the one thing the arbiter must never do, so it is checked before
 * any other refusal. A nonce that was never reserved must also be above the high-water mark: a mark that
 * is ahead of the rows means states were adopted from a bundle, and anything at or below them may
 * already be signed elsewhere.
 */
export function decideReserve(input, table, existing) {
  if (!table) throw new StoreError('unknown-table', `unknown table ${input.tableKey}`);
  if (existing && existing.digest !== input.digest) {
    throw new DoubleSignError({
      tableKey: input.tableKey,
      nonce: input.nonce,
      stored: existing.digest,
      attempted: input.digest,
    });
  }
  if (input.nonce <= table.epochBaseNonce) {
    throw new StoreError(
      'below-epoch-base',
      `nonce ${input.nonce} is at or below the epoch base ${table.epochBaseNonce}`,
    );
  }
  if (existing) {
    if (existing.stateJson !== input.stateJson) {
      throw new StoreError(
        'state-mismatch',
        `nonce ${input.nonce} has this digest for another state`,
      );
    }
    return 'repeat';
  }
  if (input.nonce <= table.nonceHw) {
    throw new StoreError(
      'behind-high-water',
      `nonce ${input.nonce} was never reserved and is not above the high-water mark ${table.nonceHw}`,
    );
  }
  return 'insert';
}

/** The counters after `state` is stored: each only ever moves forward. */
export const advanceCounters = (hot, state) => ({
  nonceHw: maxOf(hot.nonceHw, state.nonce),
  rakeCum: maxOf(hot.rakeCum, state.rake),
  volumeCum: maxOf(hot.volumeCum, state.volume),
});

export const nextMax = (current, nonce) => (current === null || nonce > current ? nonce : current);

/** An existing signature against a new one for the same slot. */
export function decideSig(existing, incoming) {
  if (existing === null) return 'store';
  return existing === incoming ? 'same' : 'conflict';
}

export const sigResult = (verdict) => ({
  stored: verdict === 'store',
  conflict: verdict === 'conflict',
});

// ---- rounds ---------------------------------------------------------------------------------------

/** Nonce of the round in flight: the highest reserved state of this epoch that no bundle covers. */
export function openRoundNonce({ epochBaseNonce, maxSigned, latestBundleNonce }) {
  if (maxSigned === null || maxSigned <= epochBaseNonce) return null;
  if (latestBundleNonce !== null && latestBundleNonce >= maxSigned) return null;
  return maxSigned;
}

/** Nonce of latestSigned(): the highest reserved state, of this epoch unless `anyEpoch`. */
export function latestSignedNonce({ epochBaseNonce, maxSigned, anyEpoch }) {
  if (maxSigned === null) return null;
  return anyEpoch || maxSigned > epochBaseNonce ? maxSigned : null;
}

export const decodeSigned = (row) => ({
  state: fromWire(JSON.parse(row.stateJson)),
  digest: row.digest,
  arbiterSig: row.arbiterSig,
});

/** Player signatures in roster order, so a caller can build a bundle from them directly. */
export function orderSigs(state, byAddress) {
  const out = new Map();
  for (const player of state.players) {
    if (byAddress.has(player)) out.set(player, byAddress.get(player));
  }
  return out;
}

// ---- bundles --------------------------------------------------------------------------------------

/**
 * Check a bundle before anything is stored. `verifyCtx = { arbiter, sessionKeyOf, expect }` and `expect`
 * must name the domain, table and roster: without them a bundle legitimately signed for another table
 * with the same keys would verify. A bad context is a caller bug and throws; a bad bundle is a result.
 */
export function checkBundleForSave(tableKey, bundle, verifyCtx) {
  if (!isPlainObject(verifyCtx)) throw new TypeError('verifyCtx must be an object');
  const { arbiter, sessionKeyOf, expect } = verifyCtx;
  if (!isPlainObject(expect)) throw new TypeError('verifyCtx.expect must be an object');
  for (const field of ['domain', 'tableId', 'players']) {
    if (expect[field] === undefined) throw new TypeError(`verifyCtx.expect.${field} is required`);
  }
  if (keyOf(expect.tableId, 'expect.tableId') !== tableKey) {
    throw new TypeError('verifyCtx.expect.tableId must be the table being saved to');
  }
  const verdict = verifyBundle(bundle, { arbiter, sessionKeyOf, expect });
  if (!verdict.ok) {
    return {
      ok: false,
      result: { saved: false, reason: 'invalid', error: verdict.error, args: verdict.args },
    };
  }
  return { ok: true, bundle: makeBundle(bundle), digest: verdict.digest };
}

/**
 * Where a verified bundle goes. `signedDigest` is the digest stored at the bundle's nonce, if any; every
 * saved bundle also leaves its state in the signed rows, so that one comparison covers every earlier
 * bundle too. `latest` is { nonce } of the newest saved bundle or null.
 */
export function decideBundle({ nonce, digest, epochBaseNonce, signedDigest, latest }) {
  if (signedDigest !== null && signedDigest !== digest) {
    return { verdict: 'conflict', stored: signedDigest };
  }
  if (nonce <= epochBaseNonce) return { verdict: 'old-epoch' };
  if (latest !== null && nonce <= latest.nonce) return { verdict: 'not-newer' };
  return { verdict: 'save' };
}

export function bundleConflictAlarm(tableKey, nonce, stored, incoming) {
  return {
    key: `bundle-conflict:${tableKey}:${nonce}:${[stored, incoming].sort().join('/')}`,
    kind: 'bundle-conflict',
    tableKey,
    nonce,
    detail: { digests: [stored, incoming] },
  };
}

export function sigConflictAlarm(kind, tableKey, nonce, subject) {
  return {
    key: `${kind}:${tableKey}:${nonce}:${subject}`,
    kind,
    tableKey,
    nonce,
    detail: { subject },
  };
}

// ---- jobs and cursor ------------------------------------------------------------------------------

const JOB_FIELDS = new Set(['key', 'kind', 'tableKey', 'priority', 'data']);

export function parseJob(job) {
  if (!isPlainObject(job)) throw new TypeError('job must be an object');
  for (const field of Object.keys(job)) {
    if (!JOB_FIELDS.has(field)) throw new TypeError(`job.${field} is not a job field`);
  }
  for (const field of ['key', 'kind']) {
    if (typeof job[field] !== 'string' || job[field].length === 0) {
      throw new TypeError(`job.${field} must be a non-empty string`);
    }
  }
  const priority = job.priority ?? 0;
  if (!Number.isSafeInteger(priority)) throw new TypeError('job.priority must be an integer');
  return {
    key: job.key,
    kind: job.kind,
    tableKey: keyOf(job.tableKey, 'job.tableKey'),
    priority,
    dataJson: job.data === undefined ? null : encodeJson(job.data, 'job.data'),
  };
}

export const statusOf = (status) => {
  if (!JOB_STATUSES.includes(status)) throw new TypeError(`unknown job status ${String(status)}`);
  return status;
};

/** The fields markJob may change; only the ones present change. */
export function parsePatch(patch = {}) {
  if (!isPlainObject(patch)) throw new TypeError('patch must be an object');
  const out = {};
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (field === 'txHash' || field === 'error') {
      if (value !== null && typeof value !== 'string') {
        throw new TypeError(`patch.${field} must be a string or null`);
      }
    } else if (field === 'attempts') {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError('patch.attempts must be a non-negative integer');
      }
    } else {
      throw new TypeError(`patch.${field} is not a job field markJob can change`);
    }
    out[field] = value;
  }
  return out;
}

export function buildJob(row) {
  const job = {
    key: row.key,
    kind: row.kind,
    tableKey: row.tableKey,
    priority: row.priority,
    status: row.status,
    txHash: row.txHash,
    attempts: row.attempts,
    error: row.error,
  };
  if (row.dataJson !== null) job.data = decodeJson(row.dataJson);
  return job;
}

/** A cursor is a block number: a bigint or a safe integer, returned in the type it was given. */
export function cursorOf(value) {
  uintOf(value, UINT64_MAX, 'cursor');
  return value;
}

export const cursorBehind = (stored, next) => BigInt(next) < BigInt(stored);

/** The shape every public method's closed check throws. */
export const closedError = () => new StoreError('closed', 'the store is closed');

export const asAddress = (address) => normalizeAddress(address, 'address');
