// The client's durable signer: the one place a browser (or a test bot) keeps its session key and decides what
// that key signs (docs/signing-layer.md sections 5 and 8, docs/trust-model.md "Rules the clients must follow").
//
// One record per table, under 'pgg.vault.v1.' + tableKey, written as ONE JSON blob with ONE setItem, so a
// crash leaves either the old record or the new one, and anything else (a torn or edited blob) fails closed.
// What the record holds is what the rules need and nothing the server could change:
//
//   sessionKey     written BEFORE its address is handed out, so it exists before any deposit can; never replaced
//   last           { nonce, digest, sig, isFinal, state }: the newest state this key signed, written BEFORE the
//                  signature is returned. A monotone high-water mark for the table: the same digest gets the
//                  same bytes again, another digest at that nonce is equivocation, anything lower is refused
//   bundle         the newest all-signed state, kept only when every signature verifies against the pinned
//                  roster, keys, domain and table, and its nonce is higher
//   pinned         the epoch genesis, accepted only after the chain agreed with it (F1)
//   epochClosed    the latch set by a final; only a fresh chain read that shows it settled clears it
//   failures       what went wrong, kept until the record is forgotten (the UI shows it, it is never a toast)
//
// Storage is injected ({ getItem, setItem, removeItem }, synchronous, like the browser's), and every call is
// wrapped: a read that throws is not "no record" (that would mint a second key), and a write that throws or
// does not stick means no signature leaves. Time and randomness are injected too (newKey, now).
import { bundleConflict, bundleFromWire, bundleToWire, verifyBundle } from './bundle.js';
import { chainShowsSettled, verifyEpochAgainstChain } from './chainview.js';
import { RAKE_BPS_CEILING } from './check.js';
import { domainsEqual, hashState, normalizeDomain } from './eip712.js';
import { signClaim } from './ids.js';
import { clientShouldSign, decideSign } from './rules.js';
import { newPrivateKey, privateKeyToAddress, recoverSigner, signDigest } from './sign.js';
import { fromWire, normalizeAddress, statesEqual, toWire } from './state.js';

/** Records live at RECORD_PREFIX + tableKey (lowercase 0x hex). */
export const RECORD_PREFIX = 'pgg.vault.v1.';

/**
 * Every failure the signer reports. The blocking ones stop all signing for that table for good (the stall exit
 * still pays everyone from the last all-signed state); the others are shown and kept, but do not stop an
 * honest table.
 */
export const FAILURE_KINDS = Object.freeze({
  'lost-key':
    'a record (or a seat on the chain) exists but the session key is missing or unreadable; a new one is never made',
  corrupt: 'the stored record cannot be read or contradicts itself; nothing is signed from it',
  equivocation: 'the server asked for a different state at a nonce this key had already signed',
  'bundle-conflict':
    'two fully signed states at one nonce, or one at a nonce where this key signed another: a bug, a lost record or a stolen key',
  storage: 'storage refused a read or a write; nothing was signed that is not on disk',
  refused: 'the server proposed a state that broke a rule; it was not signed',
  unpinned:
    'the epoch was accepted without a chain view, so a lying server cannot be told from an honest one',
});

const BLOCKING = new Set(['lost-key', 'corrupt', 'equivocation', 'bundle-conflict']);
const SEVERITY = Object.keys(FAILURE_KINDS);
const MAX_FAILURES = 16;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;

const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const messageOf = (error) => String(error?.message ?? error).slice(0, 200);
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const nullable = (value, read) => (value === null || value === undefined ? null : read(value));

function tableKeyOf(value) {
  if (typeof value !== 'string' || !HEX32.test(value)) {
    throw new TypeError('tableKey must be 32 bytes of 0x hex');
  }
  return value.toLowerCase();
}

function decimal(value, field) {
  if (typeof value !== 'string' || !DECIMAL.test(value)) {
    throw new RangeError(`${field} must be a decimal string`);
  }
  return BigInt(value);
}

// a nonce from the caller: bigint, safe integer or decimal string
function nonceArg(value, field) {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (isCount(value)) return BigInt(value);
  if (typeof value === 'string' && DECIMAL.test(value)) return BigInt(value);
  throw new TypeError(`${field} must be a non-negative nonce`);
}

// ---- the record ------------------------------------------------------------------------------------------

function encodeRecord(rec) {
  const str = (value) => (value === null ? null : value.toString());
  return JSON.stringify({
    v: 1,
    tableKey: rec.tableKey,
    sessionKey: rec.sessionKey,
    address: rec.address,
    wallet: rec.wallet,
    domain: rec.domain,
    unit: str(rec.unit),
    roster: rec.roster,
    deposit: str(rec.deposit),
    last: rec.last && {
      nonce: rec.last.nonce.toString(),
      digest: rec.last.digest,
      sig: rec.last.sig,
      isFinal: rec.last.isFinal,
      state: toWire(rec.last.state),
    },
    bundle: rec.bundle && bundleToWire(rec.bundle),
    pinned: rec.pinned && {
      epoch: rec.pinned.epoch,
      genesis: toWire(rec.pinned.genesis),
      sessionKeys: rec.pinned.sessionKeys,
      arbiter: rec.pinned.arbiter,
      maxRakeBps: rec.pinned.maxRakeBps,
      unpinned: rec.pinned.unpinned,
    },
    epochClosed: rec.epochClosed,
    leaveAckNonce: str(rec.leaveAckNonce),
    failures: rec.failures.map((f) => ({ ...f, nonce: str(f.nonce) })),
    createdAt: rec.createdAt,
  });
}

function readFailure(raw, i) {
  if (raw === null || typeof raw !== 'object' || !SEVERITY.includes(raw.kind)) {
    throw new RangeError(`failures[${i}] is not a failure`);
  }
  if (typeof raw.detail !== 'string' || (raw.rule !== null && typeof raw.rule !== 'string')) {
    throw new RangeError(`failures[${i}] is not a failure`);
  }
  return {
    kind: raw.kind,
    rule: raw.rule,
    detail: raw.detail,
    nonce: nullable(raw.nonce, (n) => decimal(n, `failures[${i}].nonce`)),
  };
}

// Everything but the key. Throws RangeError on anything a record this module wrote could not contain.
function readBody(data, tableKey, sessionKey, address) {
  if (data.address !== address) throw new RangeError('address is not the session key address');
  const wallet = nullable(data.wallet, (w) => normalizeAddress(w, 'wallet'));
  const domain = nullable(data.domain, normalizeDomain);
  const unit = nullable(data.unit, (u) => decimal(u, 'unit'));
  if (unit === 0n) throw new RangeError('unit must be above 0');
  const roster = nullable(data.roster, (r) => {
    if (!Array.isArray(r)) throw new RangeError('roster must be an array');
    return r.map((p, i) => normalizeAddress(p, `roster[${i}]`));
  });
  const deposit = nullable(data.deposit, (d) => decimal(d, 'deposit'));
  const last = nullable(data.last, (l) => {
    if (domain === null)
      throw new RangeError('a signed state needs the domain it was signed under');
    const state = fromWire(l.state);
    const nonce = decimal(l.nonce, 'last.nonce');
    if (state.tableId !== tableKey || state.nonce !== nonce || state.isFinal !== l.isFinal) {
      throw new RangeError('last does not describe last.state');
    }
    const digest = hashState(state, domain);
    if (l.digest !== digest) throw new RangeError('last.digest is not the digest of last.state');
    if (
      typeof l.sig !== 'string' ||
      !SIGNATURE.test(l.sig) ||
      recoverSigner(digest, l.sig) !== address
    ) {
      throw new RangeError("last.sig is not this key's signature of last.digest");
    }
    return { nonce, digest, sig: l.sig.toLowerCase(), isFinal: l.isFinal, state };
  });
  const bundle = nullable(data.bundle, (b) => {
    const parsed = bundleFromWire(b);
    if (
      parsed.state.tableId !== tableKey ||
      domain === null ||
      !domainsEqual(parsed.domain, domain)
    ) {
      throw new RangeError('the bundle is for another table or domain');
    }
    return parsed;
  });
  const pinned = nullable(data.pinned, (p) => {
    const genesis = fromWire(p.genesis);
    if (!isCount(p.epoch) || genesis.tableId !== tableKey)
      throw new RangeError('pinned is unreadable');
    if (!Array.isArray(p.sessionKeys) || p.sessionKeys.length !== genesis.players.length) {
      throw new RangeError('pinned.sessionKeys must have one key per player');
    }
    if (!Number.isInteger(p.maxRakeBps) || p.maxRakeBps < 0 || p.maxRakeBps > RAKE_BPS_CEILING) {
      throw new RangeError('pinned.maxRakeBps is out of range');
    }
    if (typeof p.unpinned !== 'boolean') throw new RangeError('pinned.unpinned must be a boolean');
    if (wallet === null || unit === null || domain === null || roster === null) {
      throw new RangeError('a pinned epoch needs the wallet, unit, domain and roster');
    }
    if (!sameList(roster, genesis.players) || !roster.includes(wallet)) {
      throw new RangeError('the roster is not the pinned genesis roster');
    }
    return {
      epoch: p.epoch,
      genesis,
      sessionKeys: p.sessionKeys.map((k, i) => normalizeAddress(k, `pinned.sessionKeys[${i}]`)),
      arbiter: normalizeAddress(p.arbiter, 'pinned.arbiter'),
      maxRakeBps: p.maxRakeBps,
      unpinned: p.unpinned,
    };
  });
  if (typeof data.epochClosed !== 'boolean') throw new RangeError('epochClosed must be a boolean');
  if (!Array.isArray(data.failures) || data.failures.length > MAX_FAILURES) {
    throw new RangeError('failures must be a short array');
  }
  const createdAt = nullable(data.createdAt, (t) => {
    if (!Number.isFinite(t)) throw new RangeError('createdAt must be a number');
    return t;
  });
  const rec = {
    tableKey,
    sessionKey,
    address,
    wallet,
    domain,
    unit,
    roster,
    deposit,
    last,
    bundle,
    pinned,
    epochClosed: data.epochClosed,
    leaveAckNonce: nullable(data.leaveAckNonce, (n) => decimal(n, 'leaveAckNonce')),
    failures: data.failures.map(readFailure),
    createdAt,
  };
  // the latch is set by a final this record holds; a latch with no final behind it cannot be cleared honestly
  if (rec.epochClosed && finalOf(rec) === null) throw new RangeError('epochClosed without a final');
  return rec;
}

// { status: 'ok', rec } | { status: 'lost-key' | 'corrupt', detail }
function decodeRecord(raw, tableKey) {
  const corrupt = (detail) => ({ status: 'corrupt', detail });
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return corrupt('the record is not JSON (a torn write?)');
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return corrupt('the record is not an object');
  }
  if (data.v !== 1) return corrupt('the record has an unknown version');
  if (data.tableKey !== tableKey) return corrupt('the record is for another table');
  let sessionKey;
  let address;
  try {
    if (typeof data.sessionKey !== 'string' || !HEX32.test(data.sessionKey)) {
      throw new RangeError('no key');
    }
    sessionKey = data.sessionKey.toLowerCase();
    address = privateKeyToAddress(sessionKey);
  } catch {
    return { status: 'lost-key', detail: 'the session key is missing or unreadable' };
  }
  try {
    return { status: 'ok', rec: readBody(data, tableKey, sessionKey, address) };
  } catch (error) {
    return corrupt(messageOf(error));
  }
}

// The final that latched the epoch: the one I signed, else an all-signed one I hold.
function finalOf(rec) {
  if (rec.last?.isFinal) return rec.last.state;
  if (rec.bundle?.state.isFinal) return rec.bundle.state;
  return null;
}

// The highest nonce this record knows of (signed, all-signed, or the pinned genesis), or null.
function highWater(rec) {
  let high = null;
  for (const n of [rec.last?.nonce, rec.bundle?.state.nonce, rec.pinned?.genesis.nonce]) {
    if (n !== undefined && (high === null || n > high)) high = n;
  }
  return high;
}

// After the chain showed the final settled: the latch opens, and what I take into the next epoch is the
// balance the final kept for me (none if it paid me out).
function clearLatch(rec, final) {
  const me = final.players.indexOf(rec.wallet);
  const kept = me >= 0 && final.keep[me];
  return { ...rec, epochClosed: false, deposit: kept ? final.balances[me] : null };
}

function withFailure(rec, failure) {
  const same = (f) =>
    f.kind === failure.kind && f.rule === failure.rule && f.nonce === failure.nonce;
  if (rec.failures.some(same)) return rec;
  let failures = [...rec.failures];
  if (failures.length >= MAX_FAILURES) {
    // keep every blocking failure: the oldest informational one makes room
    const spare = failures.findIndex((f) => !BLOCKING.has(f.kind));
    if (spare < 0) return rec;
    failures = failures.filter((_, i) => i !== spare);
  }
  return { ...rec, failures: [...failures, { ...failure, detail: failure.detail.slice(0, 200) }] };
}

// ---- inputs ----------------------------------------------------------------------------------------------

function readEpochMessage(message) {
  if (message === null || typeof message !== 'object')
    throw new RangeError('epoch must be an object');
  if (!isCount(message.epoch)) throw new RangeError('epoch must be a whole number');
  const state = fromWire(message.state);
  if (state.isFinal || state.keep.some(Boolean)) {
    throw new RangeError('a genesis is not final and keeps nobody');
  }
  if (!Array.isArray(message.sessionKeys) || message.sessionKeys.length !== state.players.length) {
    throw new RangeError('sessionKeys must have one key per player');
  }
  return {
    epoch: message.epoch,
    state,
    domain: normalizeDomain(message.domain),
    sessionKeys: message.sessionKeys.map((k, i) => normalizeAddress(k, `sessionKeys[${i}]`)),
    arbiter: normalizeAddress(message.arbiter, 'arbiter'),
  };
}

function readEpochContext(ctx) {
  if (ctx === null || typeof ctx !== 'object') throw new RangeError('ctx must be an object');
  if (typeof ctx.unit !== 'bigint' || ctx.unit <= 0n)
    throw new RangeError('unit must be a bigint above 0');
  const { maxRakeBps } = ctx;
  if (!Number.isInteger(maxRakeBps) || maxRakeBps < 0 || maxRakeBps > RAKE_BPS_CEILING) {
    throw new RangeError(`maxRakeBps must be an integer from 0 to ${RAKE_BPS_CEILING}`);
  }
  const myDeposit = nullable(ctx.myDeposit, (d) => {
    if (typeof d !== 'bigint' || d < 0n)
      throw new RangeError('myDeposit must be a non-negative bigint');
    return d;
  });
  for (const flag of ['allowFilling', 'allowUnpinned']) {
    if (ctx[flag] !== undefined && typeof ctx[flag] !== 'boolean') {
      throw new RangeError(`${flag} must be a boolean`);
    }
  }
  return {
    wallet: normalizeAddress(ctx.wallet, 'wallet'),
    domain: normalizeDomain(ctx.domain),
    unit: ctx.unit,
    maxRakeBps,
    myDeposit,
    allowFilling: ctx.allowFilling === true,
    allowUnpinned: ctx.allowUnpinned === true,
    tableKey: nullable(ctx.tableKey, tableKeyOf),
  };
}

const sameEpoch = (pinned, epoch) =>
  statesEqual(pinned.genesis, epoch.state) &&
  sameList(pinned.sessionKeys, epoch.sessionKeys) &&
  pinned.arbiter === epoch.arbiter;

// ---- the signer ------------------------------------------------------------------------------------------

/**
 * @param {{ storage, chainView?, newKey?, now? }} options
 *   storage    { getItem(key), setItem(key, value), removeItem(key) }, synchronous (the browser's storage, or a
 *              fake). Every call is wrapped; a failure is reported, never swallowed.
 *   chainView  { table(tableKey), seat(tableKey, address) } as createRpcChainView returns it, built from an RPC
 *              URL and vault address PINNED IN THE APP BUILD. Without one, epochs are refused unless the
 *              caller explicitly allows an unpinned one (and the record then carries a persistent warning).
 *   newKey     () -> 0x private key (default newPrivateKey); injectable so tests are repeatable
 *   now        optional () -> number, only to stamp createdAt
 */
export function createSigner({
  storage,
  chainView = null,
  newKey = newPrivateKey,
  now = null,
} = {}) {
  if (storage === null || typeof storage !== 'object') throw new TypeError('storage is required');
  for (const name of ['getItem', 'setItem', 'removeItem']) {
    if (typeof storage[name] !== 'function')
      throw new TypeError(`storage.${name} must be a function`);
  }
  if (chainView !== null) {
    if (typeof chainView !== 'object' || typeof chainView.table !== 'function') {
      throw new TypeError('chainView must have table() and seat()');
    }
    if (typeof chainView.seat !== 'function')
      throw new TypeError('chainView must have table() and seat()');
  }
  if (typeof newKey !== 'function') throw new TypeError('newKey must be a function');
  if (now !== null && typeof now !== 'function') throw new TypeError('now must be a function');

  const cache = new Map(); // tableKey -> { raw, result }: one decode per distinct stored blob
  const transient = new Map(); // tableKey -> the last storage failure, until a write succeeds again

  const storageFailure = (tableKey, detail) => {
    transient.set(tableKey, { kind: 'storage', rule: null, detail, nonce: null });
    return { ok: false, detail };
  };

  // { status: 'none' } | { status: 'ok', rec, raw } | { status: 'storage' | 'corrupt' | 'lost-key', detail }
  function load(tableKey) {
    let raw;
    try {
      raw = storage.getItem(RECORD_PREFIX + tableKey);
    } catch (error) {
      const detail = `reading the record failed: ${messageOf(error)}`;
      storageFailure(tableKey, detail);
      return { status: 'storage', detail };
    }
    if (raw === null || raw === undefined) return { status: 'none' };
    if (typeof raw !== 'string')
      return { status: 'corrupt', detail: 'the stored value is not text' };
    const cached = cache.get(tableKey);
    if (cached?.raw === raw) return cached.result;
    const result = { ...decodeRecord(raw, tableKey), raw };
    cache.set(tableKey, { raw, result });
    return result;
  }

  // One setItem, then read it back: a write that threw, or did not stick, is a failure the caller must act on.
  function save(tableKey, rec) {
    const key = RECORD_PREFIX + tableKey;
    const raw = typeof rec === 'string' ? rec : encodeRecord(rec);
    try {
      storage.setItem(key, raw);
    } catch (error) {
      return storageFailure(tableKey, `writing the record failed: ${messageOf(error)}`);
    }
    let back;
    try {
      back = storage.getItem(key);
    } catch (error) {
      return storageFailure(tableKey, `reading the record back failed: ${messageOf(error)}`);
    }
    if (back !== raw) return storageFailure(tableKey, 'the record did not stick');
    transient.delete(tableKey);
    return { ok: true };
  }

  // Best effort: a failure is worth keeping, but not worth failing the answer that reports it.
  function note(rec, failure) {
    const next = withFailure(rec, failure);
    if (next !== rec) save(rec.tableKey, next);
  }

  const unusable = (loaded) =>
    loaded.status === 'none'
      ? { rule: 'NO-KEY', detail: 'there is no session key for this table on this device' }
      : { rule: loaded.status.toUpperCase(), detail: loaded.detail };

  const blockingFailure = (rec) => rec.failures.find((f) => BLOCKING.has(f.kind)) ?? null;

  // ---- sign requests -------------------------------------------------------------------------------------

  const refuse = (rule, detail) => ({ action: 'refuse', rule, detail });
  const wait = (reason, detail) => ({ action: 'wait', reason, detail });

  function signRequest(message, ctx) {
    let state;
    try {
      state = fromWire(message?.state);
    } catch (error) {
      return refuse('MALFORMED', messageOf(error));
    }
    const tableKey = state.tableId;
    if (ctx.tableKey !== undefined && tableKeyOf(ctx.tableKey) !== tableKey) {
      return refuse('C1d', 'the request is for another table');
    }
    const loaded = load(tableKey);
    if (loaded.status !== 'ok') {
      const { rule, detail } = unusable(loaded);
      return refuse(rule, detail);
    }
    const rec = loaded.rec;
    const failed = blockingFailure(rec);
    if (failed) return refuse('FAILED', `${failed.kind}: ${failed.detail}`);
    if (rec.pinned === null) {
      return wait('no-epoch', 'no epoch of this table has been checked against the chain yet');
    }
    const refused = (rule, detail) => {
      note(rec, { kind: 'refused', rule, detail, nonce: state.nonce });
      return refuse(rule, detail);
    };
    if (!isCount(message.epoch)) return refused('MALFORMED', 'epoch must be a whole number');
    if (message.epoch > rec.pinned.epoch) {
      return wait(
        'epoch-not-pinned',
        `epoch ${message.epoch} has not been checked against the chain`,
      );
    }
    if (message.epoch < rec.pinned.epoch) {
      return refused(
        'STALE-EPOCH',
        `epoch ${message.epoch} is over; ${rec.pinned.epoch} is pinned`,
      );
    }

    // The nonce record first, so a lower nonce or a second digest is refused (and an identical request
    // answered) whatever the table is doing.
    const { genesis } = rec.pinned;
    const digest = hashState(state, rec.domain);
    let last = null;
    if (rec.last !== null) {
      // A state signed in an earlier epoch is at or below this genesis: the chain settled that epoch
      // before it was pinned, so its final flag ended with it.
      last =
        rec.last.nonce > genesis.nonce
          ? rec.last
          : { nonce: rec.last.nonce, digest: rec.last.digest, isFinal: false };
    }
    const decision = decideSign({ req: { nonce: state.nonce, digest }, last });
    if (decision === 'repeat') {
      return { action: 'send', nonce: state.nonce, digest, sig: rec.last.sig };
    }
    if (decision === 'refuse-equivocation') {
      const detail = `nonce ${state.nonce} was signed with digest ${last.digest}; the server now asks for ${digest}`;
      note(rec, { kind: 'equivocation', rule: 'C1a', detail, nonce: state.nonce });
      return refuse('C1a', detail);
    }
    if (decision === 'refuse-lower') {
      return refused('C1a', `nonce ${state.nonce} is below ${last.nonce}, already signed`);
    }
    if (decision === 'refuse-after-final') {
      return refused(
        'C2',
        `a final state was signed at nonce ${last.nonce}; nothing may follow it`,
      );
    }

    // The bundle is the baseline only once it is past this genesis (an older one belongs to a settled epoch;
    // the pinned genesis is never below a bundle held, so a newer one was verified against this roster).
    const baseline =
      rec.bundle !== null && rec.bundle.state.nonce > genesis.nonce ? rec.bundle.state : genesis;
    const base = last?.state && last.nonce > baseline.nonce ? last.state : baseline;
    if (typeof ctx.ledger?.observedStatus !== 'function') {
      return refuse('VIEW', 'a ledger is needed to compare the proposal with the table');
    }
    const seen = ctx.ledger.observedStatus({
      base,
      roster: genesis.players,
      handNo: isCount(message.handNo) ? message.handNo : null,
    });
    if (!seen.ok) {
      if (seen.permanent) return refused('LEDGER', `${seen.reason}: ${seen.detail}`);
      return wait(seen.reason, seen.detail);
    }
    const view = {
      me: rec.wallet,
      domain: rec.domain,
      tableId: tableKey,
      roster: genesis.players,
      unit: rec.unit,
      maxRakeBps: rec.pinned.maxRakeBps,
      baseline,
      last,
      intent: rec.leaveAckNonce === null ? 'play' : 'leave',
      leaveAckNonce: rec.leaveAckNonce,
      observed: seen.observed,
    };
    // my balance at the genesis comes from my own records (checked against the chain when it was pinned)
    if (baseline === genesis && rec.deposit !== null) view.myBalance = rec.deposit;
    const verdict = clientShouldSign({ state, digest: message.digest }, view);
    if (!verdict.ok) return refused(verdict.rule, verdict.detail);

    // Sign the digest computed here, never the one the server sent; on disk before it leaves.
    const sig = signDigest(rec.sessionKey, verdict.digest);
    const next = {
      ...rec,
      last: { nonce: state.nonce, digest: verdict.digest, sig, isFinal: state.isFinal, state },
      // decideSign refused everything above a final, so the latch is open here and a final closes it
      epochClosed: state.isFinal,
    };
    const saved = save(tableKey, next);
    if (!saved.ok) {
      return refuse('STORAGE', `not signed: the record could not be written (${saved.detail})`);
    }
    return { action: 'send', nonce: state.nonce, digest: verdict.digest, sig };
  }

  // ---- epochs --------------------------------------------------------------------------------------------

  const no = (rule, detail) => ({ ok: false, rule, detail });

  // The synchronous half: who I am in this epoch, and whether it may replace what is pinned.
  function precheck(loaded, epoch, facts) {
    if (loaded.status !== 'ok') {
      const { rule, detail } = unusable(loaded);
      return { verdict: no(rule, detail) };
    }
    const { rec } = loaded;
    const failed = blockingFailure(rec);
    if (failed) return { verdict: no('FAILED', `${failed.kind}: ${failed.detail}`) };
    // what the record already knows was pinned when the key was made (or at the first epoch)
    const differs = (value, same) => value !== null && !same(value);
    if (
      differs(rec.wallet, (w) => w === facts.wallet) ||
      differs(rec.domain, (d) => domainsEqual(d, facts.domain)) ||
      differs(rec.unit, (u) => u === facts.unit)
    ) {
      return {
        verdict: no('PINNED', 'the wallet, domain or unit is not the one this key was made for'),
      };
    }
    const me = epoch.state.players.indexOf(facts.wallet);
    if (me < 0) return { verdict: no('NOT-MEMBER', 'my wallet is not on the epoch roster') };
    if (epoch.sessionKeys[me] !== rec.address) {
      return { verdict: no('MY-KEY', 'the epoch gives my seat a session key that is not mine') };
    }
    if (rec.pinned !== null) {
      if (epoch.epoch < rec.pinned.epoch) {
        return { verdict: no('STALE-EPOCH', `epoch ${epoch.epoch} is older than the pinned one`) };
      }
      if (epoch.epoch === rec.pinned.epoch) {
        return sameEpoch(rec.pinned, epoch)
          ? { verdict: { ok: true, unchanged: true } }
          : { verdict: no('EPOCH-CHANGED', 'this epoch was announced before with other facts') };
      }
    }
    const high = highWater(rec);
    if (high !== null && epoch.state.nonce < high) {
      return {
        verdict: no(
          'STALE-EPOCH',
          `the genesis nonce ${epoch.state.nonce} is below ${high}, already held`,
        ),
      };
    }
    return { rec, me };
  }

  function pin(rec, epoch, facts, me, unpinned) {
    return {
      ...rec,
      wallet: facts.wallet,
      domain: facts.domain,
      unit: facts.unit,
      roster: epoch.state.players,
      deposit: epoch.state.balances[me],
      pinned: {
        epoch: epoch.epoch,
        genesis: epoch.state,
        sessionKeys: epoch.sessionKeys,
        arbiter: epoch.arbiter,
        maxRakeBps: facts.maxRakeBps,
        unpinned,
      },
    };
  }

  async function readChain(tableKey, players) {
    try {
      const [table, ...seats] = await Promise.all([
        chainView.table(tableKey),
        ...players.map((p) => chainView.seat(tableKey, p)),
      ]);
      if (table?.ok !== true) return { ok: false, error: `table: ${table?.error ?? 'no answer'}` };
      const bad = seats.find((s) => s?.ok !== true);
      if (bad !== undefined) return { ok: false, error: `seat: ${bad?.error ?? 'no answer'}` };
      return { ok: true, table: table.table, seats: seats.map((s) => s.seat) };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  async function adoptEpoch(message, ctx) {
    let epoch;
    try {
      epoch = readEpochMessage(message);
    } catch (error) {
      return no('MALFORMED', messageOf(error));
    }
    let facts;
    try {
      facts = readEpochContext(ctx);
    } catch (error) {
      return no('VIEW', messageOf(error));
    }
    const tableKey = epoch.state.tableId;
    if (facts.tableKey !== null && facts.tableKey !== tableKey) {
      return no('TABLE', 'the epoch is for another table');
    }
    if (!domainsEqual(epoch.domain, facts.domain)) {
      return no(
        'DOMAIN',
        'the epoch is for another chain or vault than the one this app is built for',
      );
    }
    const first = load(tableKey);
    const pre = precheck(first, epoch, facts);
    if (pre.verdict) return pre.verdict;

    if (chainView === null) {
      if (!facts.allowUnpinned) {
        return no('UNPINNED', 'no chain view: the epoch cannot be checked against the chain');
      }
      // Nothing but the chain can say an epoch ended, so without it only a table's first epoch is taken.
      if (pre.rec.pinned !== null) {
        return no(
          'UNPINNED',
          'without a chain view only the first epoch of a table can be accepted',
        );
      }
      const expected = pre.rec.deposit ?? facts.myDeposit;
      if (expected !== null && epoch.state.balances[pre.me] !== expected) {
        return no(
          'my-balance',
          `the epoch gives you ${epoch.state.balances[pre.me]}, you deposited ${expected}`,
        );
      }
      const warned = withFailure(pin(pre.rec, epoch, facts, pre.me, true), {
        kind: 'unpinned',
        rule: 'UNPINNED',
        detail: `epoch ${epoch.epoch} was not checked against the chain`,
        nonce: epoch.state.nonce,
      });
      const saved = save(tableKey, warned);
      return saved.ok ? { ok: true, unpinned: true } : no('STORAGE', saved.detail);
    }

    const chain = await readChain(tableKey, epoch.state.players);
    if (!chain.ok) return no('CHAIN-READ', chain.error);
    // The record may have moved on while the chain was read (a signature, a bundle): start again then.
    const again = load(tableKey);
    if (again.status !== 'ok' || again.raw !== first.raw) {
      return no('RETRY', 'the record changed while the chain was read; check the epoch again');
    }
    let rec = pre.rec;
    let opened = false;
    if (rec.epochClosed) {
      // F1: a final I signed latches the table until a FRESH chain read shows it settled. A server that
      // replays a genesis (even the current one, which matches the chain) is refused here.
      const final = finalOf(rec);
      if (!chainShowsSettled({ chainTable: chain.table, final })) {
        return no(
          'FINAL-LATCHED',
          `the final at nonce ${final.nonce} is not settled on the chain yet`,
        );
      }
      rec = clearLatch(rec, final);
      opened = true;
    }
    const verdict = verifyEpochAgainstChain({
      epoch,
      tableKey,
      chainTable: chain.table,
      chainSeats: chain.seats,
      myAddress: facts.wallet,
      myExpectedBalance: rec.deposit ?? facts.myDeposit ?? chain.seats[pre.me]?.deposit ?? 0n,
      allowFilling: facts.allowFilling,
    });
    if (!verdict.ok || verdict.filling) {
      // a Filling pass does not pin the roster (start() sets it): ask again once the table is Active
      if (opened) {
        const saved = save(tableKey, rec);
        if (!saved.ok) return no('STORAGE', saved.detail);
      }
      return verdict.ok ? { ok: true, filling: true } : no(verdict.rule, verdict.detail);
    }
    const saved = save(tableKey, pin(rec, epoch, facts, pre.me, false));
    return saved.ok ? { ok: true } : no('STORAGE', saved.detail);
  }

  // ---- bundles -------------------------------------------------------------------------------------------

  function storeBundle(message, ctx) {
    const skip = (reason, detail) => ({ stored: false, reason, detail });
    let bundle;
    try {
      bundle = bundleFromWire({
        domain: message?.domain,
        state: message?.state,
        arbiterSig: message?.arbiterSig,
        playerSigs: message?.playerSigs,
      });
    } catch (error) {
      return skip('malformed', messageOf(error));
    }
    const tableKey = bundle.state.tableId;
    if (ctx.tableKey !== undefined && tableKeyOf(ctx.tableKey) !== tableKey) {
      return skip('other-table', 'the bundle is for another table');
    }
    const loaded = load(tableKey);
    if (loaded.status !== 'ok') return skip(loaded.status, unusable(loaded).detail);
    const { rec } = loaded;
    if (rec.pinned === null) return skip('no-epoch', 'no epoch is pinned to verify it against');
    const { genesis, sessionKeys, arbiter } = rec.pinned;
    // the keys and the arbiter come from the epoch the chain confirmed, never from this message
    const keyOf = new Map(genesis.players.map((p, i) => [p, sessionKeys[i]]));
    const check = verifyBundle(bundle, {
      arbiter,
      sessionKeyOf: (p) => keyOf.get(p) ?? null,
      expect: { domain: rec.domain, tableId: tableKey, players: genesis.players },
    });
    if (!check.ok) return skip('invalid', `${check.error} ${check.args.join(' ')}`.trim());
    const { nonce } = bundle.state;

    // My key is on every verified bundle. Another digest at a nonce my key signed, or at a bundle's nonce,
    // means two fully signed states at one nonce: alarm, keep the first.
    const conflict =
      (rec.last?.nonce === nonce && rec.last.digest !== check.digest) ||
      (rec.bundle !== null && bundleConflict(bundle, rec.bundle) !== null);
    if (conflict) {
      const detail = `two fully signed states at nonce ${nonce}`;
      note(rec, { kind: 'bundle-conflict', rule: null, detail, nonce });
      return skip('conflict', detail);
    }
    if (rec.bundle !== null && nonce <= rec.bundle.state.nonce) {
      return skip(nonce === rec.bundle.state.nonce ? 'duplicate' : 'not-newer', `nonce ${nonce}`);
    }
    if (nonce <= genesis.nonce) return skip('stale', `nonce ${nonce} is from a settled epoch`);
    const next = { ...rec, bundle };
    if (rec.last === null || nonce > rec.last.nonce) {
      // my key signed it, so it is part of the high-water mark even if my own record of it was lost
      const me = genesis.players.indexOf(rec.wallet);
      next.last = {
        nonce,
        digest: check.digest,
        sig: bundle.playerSigs[me],
        isFinal: bundle.state.isFinal,
        state: bundle.state,
      };
    }
    if (bundle.state.isFinal) next.epochClosed = true;
    const saved = save(tableKey, next);
    if (!saved.ok) return skip('storage', saved.detail);
    return { stored: true, nonce, final: bundle.state.isFinal };
  }

  // ---- the API -------------------------------------------------------------------------------------------

  return {
    /**
     * The session key's address for this table, creating the key if there is none. The key is written (and
     * read back) BEFORE the address is returned, so it exists before any deposit can. An existing key is
     * never replaced; a record whose key is unreadable is `lost-key`, and so is "no record" when the caller
     * passes `chainSeat` from a fresh chain read showing this wallet already has a seat there (a wiped
     * storage): a replacement would not match the chain, and the stall exit still returns the funds.
     *   opts { wallet?, domain?, unit?, chainSeat? }  facts to remember from the start (all optional)
     * -> { ok: true, address, created } | { ok: false, kind, detail }
     */
    ensureSessionKey(tableKey, opts = {}) {
      const key = tableKeyOf(tableKey);
      const wallet = nullable(opts.wallet, (w) => normalizeAddress(w, 'wallet'));
      const domain = nullable(opts.domain, normalizeDomain);
      const unit = nullable(opts.unit, (u) => {
        if (typeof u !== 'bigint' || u <= 0n) throw new TypeError('unit must be a bigint above 0');
        return u;
      });
      const loaded = load(key);
      if (loaded.status === 'ok') {
        if (wallet !== null && loaded.rec.wallet !== null && wallet !== loaded.rec.wallet) {
          return {
            ok: false,
            kind: 'other-wallet',
            detail: 'this table key belongs to another wallet',
          };
        }
        return { ok: true, address: loaded.rec.address, created: false };
      }
      if (loaded.status !== 'none')
        return { ok: false, kind: loaded.status, detail: loaded.detail };
      if (opts.chainSeat !== undefined && opts.chainSeat !== null) {
        const detail =
          'the chain shows a seat for this wallet, but this device holds no key for it';
        save(key, JSON.stringify({ v: 1, tableKey: key, sessionKey: null, lost: detail }));
        return { ok: false, kind: 'lost-key', detail };
      }
      const sessionKey = String(newKey()).toLowerCase();
      if (!HEX32.test(sessionKey)) throw new TypeError('newKey must return 32 bytes of 0x hex');
      const address = privateKeyToAddress(sessionKey);
      const saved = save(key, {
        tableKey: key,
        sessionKey,
        address,
        wallet,
        domain,
        unit,
        roster: null,
        deposit: null,
        last: null,
        bundle: null,
        pinned: null,
        epochClosed: false,
        leaveAckNonce: null,
        failures: [],
        createdAt: now === null ? null : now(),
      });
      if (!saved.ok) return { ok: false, kind: 'storage', detail: saved.detail };
      return { ok: true, address, created: true };
    },

    /**
     * What is stored for this table, without the private key: { ok: true, record } (record null when there is
     * none) or { ok: false, kind, detail } when it cannot be read (storage, corrupt, lost-key).
     */
    restore(tableKey) {
      const loaded = load(tableKeyOf(tableKey));
      if (loaded.status === 'none') return { ok: true, record: null };
      if (loaded.status !== 'ok') return { ok: false, kind: loaded.status, detail: loaded.detail };
      const { sessionKey: _private, ...record } = loaded.rec;
      return { ok: true, record };
    },

    /**
     * Sign a claim (identity only, never funds) with this table's session key: the proof the server checks
     * against seats(tableKey, wallet).sessionKey. -> { ok: true, sig, address } | { ok: false, kind, detail }
     */
    signClaim(tableKey, { playerId, domain, wallet } = {}) {
      const key = tableKeyOf(tableKey);
      const loaded = load(key);
      if (loaded.status !== 'ok') {
        return { ok: false, kind: loaded.status, detail: unusable(loaded).detail };
      }
      const { rec } = loaded;
      const d = rec.domain ?? normalizeDomain(domain);
      const address = rec.wallet ?? normalizeAddress(wallet, 'wallet');
      if (domain !== undefined && !domainsEqual(d, domain)) {
        return { ok: false, kind: 'other-domain', detail: 'the domain is not the one pinned' };
      }
      if (wallet !== undefined && normalizeAddress(wallet, 'wallet') !== address) {
        return { ok: false, kind: 'other-wallet', detail: 'the wallet is not the one pinned' };
      }
      const sig = signClaim(rec.sessionKey, { domain: d, tableKey: key, address, playerId });
      return { ok: true, sig, address: rec.address };
    },

    /**
     * An `epoch` message (wire form). Checked against the chain through the chain view (F1) and against this
     * record: my seat and key, the high-water mark (a genesis below a nonce already held is refused), and the
     * final latch (cleared only when the same fresh chain read shows the final settled).
     *   ctx { wallet, domain (pinned in the app), unit, maxRakeBps, myDeposit?, allowFilling?, allowUnpinned?,
     *         tableKey? }
     * -> { ok: true } (pinned) | { ok: true, unchanged: true } | { ok: true, filling: true } (not pinned: ask
     *    again once Active) | { ok: true, unpinned: true } | { ok: false, rule, detail }. Never throws.
     */
    async handleEpoch(message, ctx = {}) {
      try {
        return await adoptEpoch(message, ctx);
      } catch (error) {
        return no('INTERNAL', messageOf(error)); // fail closed
      }
    },

    /**
     * A `signreq` message (wire form). Synchronous. ctx { ledger, tableKey? }.
     * -> { action: 'send', nonce, digest, sig }   the record is on disk; send exactly these
     *  | { action: 'refuse', rule, detail }        never signed; rules are clientShouldSign's plus NO-KEY,
     *                                              FAILED, STALE-EPOCH, LEDGER, STORAGE, MALFORMED, INTERNAL
     *  | { action: 'wait', reason, detail }        the ledger or the epoch is not ready: ask again on the next
     *                                              table or epoch message
     */
    handleSignReq(message, ctx = {}) {
      try {
        return signRequest(message, ctx ?? {});
      } catch (error) {
        return refuse('INTERNAL', messageOf(error)); // fail closed
      }
    },

    /**
     * A `bundle` message (wire form). Stored only if every signature verifies against the pinned epoch (its
     * keys, arbiter, roster, table and domain) and its nonce is higher than the one held. Equal nonce and a
     * different digest is a blocking `bundle-conflict`. -> { stored: true, nonce, final } | { stored: false,
     * reason, detail }. Never throws.
     */
    acceptBundle(message, ctx = {}) {
      try {
        return storeBundle(message, ctx ?? {});
      } catch (error) {
        return { stored: false, reason: 'internal', detail: messageOf(error) };
      }
    },

    /**
     * I pressed Leave. `headNonce` is the head the server acknowledged (null: nothing proposed yet). A final
     * that keeps me is then refused unless its nonce is at or below the recorded value, which is bounded by
     * my own records: at most one state past the newest I hold can have been in flight. The first press is
     * kept. -> { ok: true, leaveAckNonce, already? } | { ok: false, reason, detail }
     */
    noteLeave(tableKey, headNonce) {
      const key = tableKeyOf(tableKey);
      const ack = headNonce === null ? null : nonceArg(headNonce, 'headNonce');
      const loaded = load(key);
      if (loaded.status !== 'ok')
        return { ok: false, reason: loaded.status, detail: loaded.detail };
      const { rec } = loaded;
      if (rec.leaveAckNonce !== null) {
        return { ok: true, leaveAckNonce: rec.leaveAckNonce, already: true };
      }
      const held = highWater(rec) ?? 0n;
      const leaveAckNonce = ack === null ? held : ack < held + 1n ? ack : held + 1n;
      const saved = save(key, { ...rec, leaveAckNonce });
      return saved.ok
        ? { ok: true, leaveAckNonce }
        : { ok: false, reason: 'storage', detail: saved.detail };
    },

    /**
     * Pass a FRESH chain read of tables(tableKey). Opens the final latch only when chainShowsSettled says the
     * final I hold is settled; a server message never does. -> { ok: true, cleared } | { ok: false, reason }
     */
    settledObserved(tableKey, chainTable) {
      const key = tableKeyOf(tableKey);
      const loaded = load(key);
      if (loaded.status !== 'ok')
        return { ok: false, reason: loaded.status, detail: loaded.detail };
      const { rec } = loaded;
      if (!rec.epochClosed) return { ok: true, cleared: false };
      const final = finalOf(rec);
      if (!chainShowsSettled({ chainTable, final })) {
        return {
          ok: false,
          reason: 'not-settled',
          detail: `the final at nonce ${final.nonce} is not settled`,
        };
      }
      const saved = save(key, clearLatch(rec, final));
      return saved.ok
        ? { ok: true, cleared: true }
        : { ok: false, reason: 'storage', detail: saved.detail };
    },

    /**
     * The worst failure on record for this table, or null: { kind, rule, detail, nonce, blocking, kinds } with
     * `kinds` every kind seen. Blocking kinds stop all signing for the table (see FAILURE_KINDS).
     */
    failure(tableKey) {
      const key = tableKeyOf(tableKey);
      const loaded = load(key);
      const list = [];
      if (['corrupt', 'lost-key', 'storage'].includes(loaded.status)) {
        list.push({ kind: loaded.status, rule: null, detail: loaded.detail, nonce: null });
      }
      if (loaded.status === 'ok') list.push(...loaded.rec.failures);
      if (transient.has(key)) list.push(transient.get(key));
      if (list.length === 0) return null;
      const rank = (f) => SEVERITY.indexOf(f.kind);
      const worst = list.reduce((a, b) => (rank(b) < rank(a) ? b : a));
      return {
        ...worst,
        blocking: BLOCKING.has(worst.kind),
        kinds: [...new Set(list.map((f) => f.kind))],
      };
    },

    /**
     * Delete this table's record. Only when the caller's OWN fresh chain read shows the table done (Closed,
     * or settled with no seat of mine left) AND the exit window has passed since; never on a server message.
     * -> { ok: true } | { ok: false, reason, detail? }
     */
    forget(tableKey, { chainShowsDone, exitWindowPassed } = {}) {
      const key = tableKeyOf(tableKey);
      if (chainShowsDone !== true) return { ok: false, reason: 'chain-not-done' };
      if (exitWindowPassed !== true) return { ok: false, reason: 'too-early' };
      try {
        storage.removeItem(RECORD_PREFIX + key);
        const left = storage.getItem(RECORD_PREFIX + key);
        if (left !== null && left !== undefined) {
          return { ok: false, reason: 'storage', detail: 'the record is still there' };
        }
      } catch (error) {
        return { ok: false, reason: 'storage', detail: messageOf(error) };
      }
      cache.delete(key);
      transient.delete(key);
      return { ok: true };
    },
  };
}
