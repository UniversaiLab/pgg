// A bundle is a State with every signature on it: the arbiter's and one per player, in roster order. It is
// the only thing that can be handed to PokerVault (startExit, challenge, settle), so servers and clients
// keep the newest one durably. The library never stores anything; it builds, checks and converts bundles.
//
//   bundle      { domain, state, arbiterSig, playerSigs }       internal (BigInt state)
//   wire bundle { domain, state: wire state, arbiterSig, playerSigs }   JSON-safe
import { UINT64_MAX } from './bytes.js';
import { checkSignatures } from './check.js';
import { domainsEqual, hashState, normalizeDomain } from './eip712.js';
import { fromWire, normalizeAddress, normalizeState, toWire } from './state.js';

const SIGNATURE = /^0x[0-9a-fA-F]{130}$/; // 65 bytes: r || s || v
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

/** What verifyBundle returns when the bundle is valid but is not the one `expect` asked for. */
export const EXPECT_ERRORS = Object.freeze(['WrongDomain', 'WrongTable', 'WrongRoster']);

const signature = (value, field) => {
  if (typeof value !== 'string' || !SIGNATURE.test(value)) {
    throw new RangeError(`${field} must be a 65-byte 0x signature`);
  }
  return value.toLowerCase();
};

function parseBundle(raw) {
  if (raw === null || typeof raw !== 'object') throw new RangeError('bundle must be an object');
  const state = normalizeState(raw.state);
  if (!Array.isArray(raw.playerSigs) || raw.playerSigs.length !== state.players.length) {
    const error = new RangeError('playerSigs must have one signature per player');
    error.code = 'BadLength';
    throw error;
  }
  return {
    domain: normalizeDomain(raw.domain),
    state,
    arbiterSig: signature(raw.arbiterSig, 'arbiterSig'),
    // Array.from visits holes (map would skip them and leave one in the bundle)
    playerSigs: Array.from(raw.playerSigs, (sig, i) => signature(sig, `playerSigs[${i}]`)),
  };
}

/**
 * Validate and canonicalise a bundle. This checks the shape only (65-byte signatures, one per player,
 * a valid State and domain); whether the signatures are the right ones is verifyBundle's job.
 */
export const makeBundle = ({ domain, state, arbiterSig, playerSigs }) =>
  parseBundle({ domain, state, arbiterSig, playerSigs });

/** The digest every signature in the bundle covers. */
export const bundleDigest = (bundle) => hashState(bundle.state, bundle.domain);

// `expect` is a caller's claim about which bundle it wants; a malformed one is a caller bug and throws, and
// so is a key that is present but undefined (a variable that was never set must not silently skip a check).
function readExpect(expect) {
  if (expect === undefined) return null;
  if (expect === null || typeof expect !== 'object')
    throw new TypeError('expect must be an object');
  const keys = Object.keys(expect);
  if (keys.length === 0 || keys.some((k) => !['domain', 'tableId', 'players'].includes(k))) {
    throw new TypeError('expect may only hold domain, tableId and players (at least one)');
  }
  for (const key of keys) {
    if (expect[key] === undefined) throw new TypeError(`expect.${key} is undefined`);
  }
  const out = {};
  if (keys.includes('domain')) out.domain = normalizeDomain(expect.domain);
  if (keys.includes('tableId')) {
    if (typeof expect.tableId !== 'string' || !BYTES32.test(expect.tableId)) {
      throw new RangeError('expect.tableId must be 32 bytes of 0x hex');
    }
    out.tableId = expect.tableId.toLowerCase();
  }
  if (keys.includes('players')) {
    if (!Array.isArray(expect.players)) throw new RangeError('expect.players must be an array');
    out.players = Array.from(expect.players, (p, i) => normalizeAddress(p, `expect.players[${i}]`));
  }
  return out;
}

/** The first way `b` differs from what was expected, as a verifyBundle result, or null. */
function unexpected(b, expect) {
  const wrong = (error, message) => ({ ok: false, error, args: [message] });
  if (expect.domain && !domainsEqual(b.domain, expect.domain)) {
    return wrong(
      'WrongDomain',
      `the bundle is for chain ${b.domain.chainId} vault ${b.domain.verifyingContract}`,
    );
  }
  if (expect.tableId && b.state.tableId !== expect.tableId) {
    return wrong('WrongTable', `the bundle is for table ${b.state.tableId}`);
  }
  const { players } = b.state;
  if (
    expect.players &&
    !(players.length === expect.players.length && players.every((p, i) => p === expect.players[i]))
  ) {
    return wrong('WrongRoster', 'the bundle is for another roster');
  }
  return null;
}

/**
 * Is every signature in `bundle` valid for the people who should have signed it? The digest is recomputed
 * from the state and domain, the arbiter's signature must recover to `arbiter`, and each player's to
 * `sessionKeyOf(player)` (called with lowercase addresses), checked in the contract's order with its
 * errors. A bad bundle is a result; a bad `arbiter`, `sessionKeyOf` or `expect` argument is a caller bug
 * and throws.
 *
 * `expect` is optional: `{ domain, tableId, players }`, any of them, each compared with what the bundle
 * claims about itself BEFORE the signatures are looked at. The signatures only prove the bundle is
 * consistent with its own domain and table, so a client that has no chain access (the browser) must pass
 * what it pinned, or a bundle that was legitimately signed for another chain, vault, table or roster (same
 * keys) verifies. A mismatch is { ok: false, error: 'WrongDomain' | 'WrongTable' | 'WrongRoster' }.
 *
 * It does not know the table's row, so it cannot say whether the state is newer or conserves the escrow:
 * that is checkState. Returns { ok: true, digest } or { ok: false, error, args }.
 */
export function verifyBundle(bundle, { arbiter, sessionKeyOf, expect }) {
  normalizeAddress(arbiter, 'arbiter'); // a bad argument is a caller bug, not a bad bundle
  if (typeof sessionKeyOf !== 'function') throw new TypeError('sessionKeyOf must be a function');
  const wanted = readExpect(expect);
  let b;
  try {
    b = parseBundle(bundle);
  } catch (error) {
    return { ok: false, error: error.code ?? 'Malformed', args: error.code ? [] : [error.message] };
  }
  const mismatch = wanted && unexpected(b, wanted);
  if (mismatch) return mismatch;
  const digest = bundleDigest(b);
  const bad = checkSignatures(digest, b.state, b, { arbiter, sessionKeyOf });
  return bad ?? { ok: true, digest };
}

/** Bundle -> JSON-safe bundle. */
export function bundleToWire(bundle) {
  const b = parseBundle(bundle);
  return {
    domain: b.domain,
    state: toWire(b.state),
    arbiterSig: b.arbiterSig,
    playerSigs: b.playerSigs,
  };
}

/** JSON-safe bundle -> bundle. Strict, like fromWire. */
export function bundleFromWire(wire) {
  if (wire === null || typeof wire !== 'object') throw new RangeError('bundle must be an object');
  return parseBundle({ ...wire, state: fromWire(wire.state) });
}

// A nonce as a BigInt. A bundle in wire form keeps it as a decimal string, and comparing those as text puts
// '10' below '9', so strings are converted, not compared. Anything else is refused: a nonce that is not
// plainly a number must not quietly decide which bundle is newer.
function nonceOf(bundle) {
  const nonce = bundle?.state?.nonce;
  let value;
  if (typeof nonce === 'bigint') value = nonce;
  else if (Number.isSafeInteger(nonce)) value = BigInt(nonce);
  else if (typeof nonce === 'string' && nonce.length <= 20 && DECIMAL.test(nonce))
    value = BigInt(nonce);
  if (value === undefined || value < 0n || value > UINT64_MAX) {
    throw new TypeError(
      'bundle.state.nonce must be a uint64 (bigint, safe integer or decimal string)',
    );
  }
  return value;
}

/**
 * True when `a` has a strictly higher nonce than `b` (and `b` may be missing). Nonce only: the caller has
 * already made sure both are for the same table and domain. Nonces are compared as numbers; a bigint, a
 * safe-integer number and a decimal string (the wire form) all work, anything else throws TypeError rather
 * than guess. Equal nonces with different digests are not "newer" either way: that is an alarm, see
 * bundleConflict.
 */
export function isNewer(a, b) {
  if (!a) return false;
  const nonce = nonceOf(a);
  if (!b) return true;
  return nonce > nonceOf(b);
}

/**
 * The alarm case: two bundles for the same table and domain with the SAME nonce and DIFFERENT digests.
 * An honest arbiter signs one state per nonce, so two fully signed states at one nonce mean a bug, a
 * restart that lost its record, or a key compromise. Returns { nonce, digests: [digestOfA, digestOfB] }
 * or null (different tables or domains, different nonces, or the very same state). Run it on bundles that
 * passed verifyBundle: two unverified blobs prove nothing. A value that is not a bundle throws RangeError.
 */
export function bundleConflict(a, b) {
  const x = parseBundle(a);
  const y = parseBundle(b);
  if (!domainsEqual(x.domain, y.domain) || x.state.tableId !== y.state.tableId) return null;
  if (x.state.nonce !== y.state.nonce) return null;
  const digests = [bundleDigest(x), bundleDigest(y)];
  return digests[0] === digests[1] ? null : { nonce: x.state.nonce, digests };
}
