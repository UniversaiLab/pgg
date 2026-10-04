// checkState / checkSettle: PokerVault._verify (and settle) rewritten in JS, check for check, in the
// contract's order and with the contract's error names. The server runs it before it proposes a state, the
// watchtower before it submits a challenge, and the equivalence test on anvil compares its first error with
// the real contract's revert for thousands of mutated states. Keep it in lockstep with PokerVault.sol:
//
//   _verify:  StaleNonce, BadLength, RosterMismatch, RakeDecreased, RakeTooHigh, NotConserved,
//             then the arbiter signature (BadSignature(2^256-1)), then each player (BadSignature(i)).
//             Any signature may instead revert with an OpenZeppelin ECDSA error (see sign.js).
//   settle:   NotFinal, WrongStatus, _verify, BadKeep.
//
// Solidity 0.8 arithmetic is checked, so `rake * 10_000`, `maxRakeBps * volume` and the balance sum revert
// with Panic(0x11) when they overflow uint256. Those states can only come from a hostile or broken signer,
// but they must not be reported as RakeTooHigh or NotConserved.
import { keccakHex, UINT256_MAX, utf8 } from './bytes.js';
import { hashState, normalizeDomain } from './eip712.js';
import { tryRecoverSigner } from './sign.js';
import { decodeState, normalizeAddress, rosterHash } from './state.js';

/** PokerVault.Status, as the contract's `tables(id).status` returns it. */
export const STATUS = Object.freeze({ None: 0, Filling: 1, Active: 2, Exiting: 3, Closed: 4 });

/**
 * PokerVault.RAKE_BPS_CEILING: the constructor refuses a MAX_RAKE_BPS above it, so no vault caps rake
 * higher. test/rake-ceiling.test.js compares this number with the contract source.
 */
export const RAKE_BPS_CEILING = 500;

const ARBITER_INDEX = UINT256_MAX; // BadSignature(type(uint256).max) means the arbiter
const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;

const entry = (source, name, params = []) =>
  Object.freeze({
    name,
    source,
    params,
    signature: `${name}(${params.map(([, type]) => type).join(',')})`,
    // Malformed is ours, not the chain's: an ABI decode failure reverts with no data.
    selector:
      source === 'js'
        ? null
        : keccakHex(utf8(`${name}(${params.map(([, type]) => type).join(',')})`)).slice(0, 10),
  });

/**
 * Every error checkState can return, with where it comes from, its parameters, its canonical signature
 * and its 4-byte selector. `args` in a result are typed like viem decodes the revert: uint as bigint,
 * the Status enum as a number, bytes32 as a hex string.
 */
export const ERRORS = Object.freeze({
  StaleNonce: entry('PokerVault', 'StaleNonce', [
    ['given', 'uint64'],
    ['current', 'uint64'],
  ]),
  BadLength: entry('PokerVault', 'BadLength'),
  RosterMismatch: entry('PokerVault', 'RosterMismatch'),
  RakeDecreased: entry('PokerVault', 'RakeDecreased'),
  RakeTooHigh: entry('PokerVault', 'RakeTooHigh'),
  NotConserved: entry('PokerVault', 'NotConserved', [
    ['claimed', 'uint256'],
    ['escrow', 'uint256'],
  ]),
  BadSignature: entry('PokerVault', 'BadSignature', [['index', 'uint256']]),
  NotFinal: entry('PokerVault', 'NotFinal'),
  WrongStatus: entry('PokerVault', 'WrongStatus', [['actual', 'uint8']]),
  BadKeep: entry('PokerVault', 'BadKeep', [['index', 'uint256']]),
  ECDSAInvalidSignature: entry('OpenZeppelin ECDSA', 'ECDSAInvalidSignature'),
  ECDSAInvalidSignatureLength: entry('OpenZeppelin ECDSA', 'ECDSAInvalidSignatureLength', [
    ['length', 'uint256'],
  ]),
  ECDSAInvalidSignatureS: entry('OpenZeppelin ECDSA', 'ECDSAInvalidSignatureS', [['s', 'bytes32']]),
  Panic: entry('solidity', 'Panic', [['code', 'uint256']]),
  Malformed: entry('js', 'Malformed', [['reason', 'string']]),
});

const fail = (error, args = []) => ({ ok: false, error, args });
const panic = () => fail('Panic', [0x11n]);

const HEX_BYTES = /^0x([0-9a-fA-F]{2})*$/;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;

function big(value, field) {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new RangeError(`${field} must be a non-negative bigint`);
}

function toStatus(status) {
  const n = typeof status === 'string' ? STATUS[status] : status;
  if (!Number.isInteger(n) || n < 0 || n > 4)
    throw new RangeError('ctx.table.status is not a Status');
  return n;
}

/** The pieces of ctx the checks read, validated. A bad ctx is a caller bug and throws. */
function readContext(ctx, { needStatus = false, needKeys = false } = {}) {
  const t = ctx?.table;
  if (!t) throw new TypeError('ctx.table is required');
  if (needStatus && t.status === undefined) {
    throw new TypeError('ctx.table.status is required for checkSettle');
  }
  if (needKeys && typeof ctx.sessionKeyOf !== 'function') {
    throw new TypeError('ctx.sessionKeyOf must be a function when signatures are checked');
  }
  if (typeof t.rosterHash !== 'string' || !HEX32.test(t.rosterHash)) {
    throw new RangeError('ctx.table.rosterHash must be 32 bytes of 0x hex');
  }
  return {
    domain: normalizeDomain(ctx.domain),
    maxRakeBps: big(ctx.maxRakeBps, 'ctx.maxRakeBps'),
    sessionKeyOf: ctx.sessionKeyOf,
    table: {
      status: t.status === undefined ? undefined : toStatus(t.status),
      nonce: big(t.nonce, 'ctx.table.nonce'),
      escrow: big(t.escrow, 'ctx.table.escrow'),
      rakePaid: big(t.rakePaid, 'ctx.table.rakePaid'),
      rosterHash: t.rosterHash.toLowerCase(),
      arbiter: normalizeAddress(t.arbiter, 'ctx.table.arbiter'),
    },
  };
}

/**
 * The table row of PokerVault.tables(id) as checkState wants it. Takes what viem returns (an array in
 * the contract's field order) or an object with the contract's field names.
 */
export function tableFromChain(row) {
  const names = [
    'status',
    'maxPlayers',
    'seated',
    'arbiter',
    'nonce',
    'exitDeadline',
    'minDeposit',
    'maxDeposit',
    'escrow',
    'rakePaid',
    'rosterHash',
    'exitDigest',
  ];
  const get = (name) => (Array.isArray(row) ? row[names.indexOf(name)] : row[name]);
  return {
    status: get('status'),
    nonce: get('nonce'),
    escrow: get('escrow'),
    rakePaid: get('rakePaid'),
    rosterHash: get('rosterHash'),
    arbiter: get('arbiter'),
  };
}

function readSigs(sigs) {
  const ok =
    sigs &&
    typeof sigs.arbiterSig === 'string' &&
    HEX_BYTES.test(sigs.arbiterSig) &&
    Array.isArray(sigs.playerSigs) &&
    sigs.playerSigs.every((sig) => typeof sig === 'string' && HEX_BYTES.test(sig));
  return ok ? sigs : null;
}

const keyOrZero = (sessionKeyOf, player) => {
  try {
    const key = sessionKeyOf(player);
    return key ? normalizeAddress(key) : ZERO_ADDRESS;
  } catch {
    return ZERO_ADDRESS;
  }
};

/**
 * The signature half of _verify: the arbiter first, then every player in roster order. A malformed
 * signature reverts inside ECDSA before the comparison, so it is reported in place of BadSignature.
 * Returns null when all signatures are good, else the failure. Shared with verifyBundle.
 */
export function checkSignatures(digest, state, sigs, { arbiter, sessionKeyOf }) {
  const signer = tryRecoverSigner(digest, sigs.arbiterSig);
  if (!signer.address) return fail(signer.error, signer.args);
  if (signer.address !== normalizeAddress(arbiter)) return fail('BadSignature', [ARBITER_INDEX]);
  for (let i = 0; i < state.players.length; i++) {
    const recovered = tryRecoverSigner(digest, sigs.playerSigs[i]);
    if (!recovered.address) return fail(recovered.error, recovered.args);
    if (recovered.address !== keyOrZero(sessionKeyOf, state.players[i])) {
      return fail('BadSignature', [BigInt(i)]);
    }
  }
  return null;
}

/** _verify on a decoded state. `sigs` is null to skip the signature steps. */
function verify(s, sigs, ctx) {
  const t = ctx.table;
  if (s.nonce <= t.nonce) return fail('StaleNonce', [s.nonce, t.nonce]);
  const n = s.players.length;
  if (s.balances.length !== n || s.keep.length !== n || (sigs && sigs.playerSigs.length !== n)) {
    return fail('BadLength');
  }
  if (rosterHash(s.players) !== t.rosterHash) return fail('RosterMismatch');

  if (s.rake < t.rakePaid) return fail('RakeDecreased');
  const scaledRake = s.rake * 10_000n;
  const cap = ctx.maxRakeBps * s.volume;
  if (scaledRake > UINT256_MAX || cap > UINT256_MAX) return panic();
  if (scaledRake > cap) return fail('RakeTooHigh');

  let claimed = s.rake - t.rakePaid;
  for (const balance of s.balances) claimed += balance;
  if (claimed > UINT256_MAX) return panic(); // the running sum only grows, so this is the loop's overflow
  if (claimed !== t.escrow) return fail('NotConserved', [claimed, t.escrow]);

  const digest = hashState(s, ctx.domain);
  if (sigs) {
    const bad = checkSignatures(digest, s, sigs, {
      arbiter: t.arbiter,
      sessionKeyOf: ctx.sessionKeyOf,
    });
    if (bad) return bad;
  }
  return { ok: true, digest };
}

function decode(state) {
  try {
    return { s: decodeState(state) };
  } catch (error) {
    return { bad: fail('Malformed', [error.message]) };
  }
}

function prepare(state, sigs, ctx, options) {
  const decoded = decode(state);
  if (decoded.bad) return decoded;
  const context = readContext(ctx, { ...options, needKeys: sigs != null });
  if (sigs == null) return { s: decoded.s, context, sigs: null };
  const parsed = readSigs(sigs);
  if (!parsed)
    return { bad: fail('Malformed', ['signatures must be 0x hex: arbiterSig and playerSigs']) };
  return { s: decoded.s, context, sigs: parsed };
}

/**
 * Would PokerVault._verify accept this state? Returns { ok: true, digest } or { ok: false, error, args }
 * with the first error the contract would revert with (names in ERRORS).
 *
 *   state  a State (types and ranges are checked, the rest is the contract's job)
 *   sigs   { arbiterSig, playerSigs } as hex, or null to skip the signature steps (before signing)
 *   ctx    { domain, maxRakeBps, sessionKeyOf(playerAddress) -> sessionKey | null  (called with LOWERCASE
 *            addresses),
 *            table: { nonce, escrow, rakePaid, rosterHash, arbiter } }   (see tableFromChain)
 *
 * It does not look at the table's status: startExit needs Active, challenge needs Exiting and an open
 * window, and those are the caller's to check. A malformed ctx throws; a malformed state is a result.
 */
export function checkState(state, sigs, ctx) {
  const p = prepare(state, sigs, ctx);
  if (p.bad) return p.bad;
  return verify(p.s, p.sigs, p.context);
}

/**
 * Would PokerVault.settle accept this state? The same as checkState with settle's own checks around it:
 * NotFinal, then WrongStatus unless the table is Active or Exiting (ctx.table.status is required), then
 * _verify, then BadKeep for a kept seat with nothing left.
 */
export function checkSettle(state, sigs, ctx) {
  const p = prepare(state, sigs, ctx, { needStatus: true });
  if (p.bad) return p.bad;
  const { s, context } = p;
  if (!s.isFinal) return fail('NotFinal');
  const status = context.table.status;
  if (status !== STATUS.Active && status !== STATUS.Exiting) return fail('WrongStatus', [status]);
  const result = verify(s, p.sigs, context);
  if (!result.ok) return result;
  for (let i = 0; i < s.players.length; i++) {
    if (s.keep[i] && s.balances[i] === 0n) return fail('BadKeep', [BigInt(i)]);
  }
  return result;
}
