// A bundle is a State with every signature on it: the arbiter's and one per player, in roster order. It is
// the only thing that can be handed to PokerVault (startExit, challenge, settle), so servers and clients
// keep the newest one durably. The library never stores anything; it builds, checks and converts bundles.
//
//   bundle      { domain, state, arbiterSig, playerSigs }       internal (BigInt state)
//   wire bundle { domain, state: wire state, arbiterSig, playerSigs }   JSON-safe
import { checkSignatures } from './check.js';
import { hashState, normalizeDomain } from './eip712.js';
import { fromWire, normalizeAddress, normalizeState, toWire } from './state.js';

const SIGNATURE = /^0x[0-9a-fA-F]{130}$/; // 65 bytes: r || s || v

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
    playerSigs: raw.playerSigs.map((sig, i) => signature(sig, `playerSigs[${i}]`)),
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

/**
 * Is every signature in `bundle` valid for the people who should have signed it? The digest is recomputed
 * from the state and domain, the arbiter's signature must recover to `arbiter`, and each player's to
 * `sessionKeyOf(player)`, checked in the contract's order with its errors. A bad bundle is a result; a bad
 * `arbiter` or `sessionKeyOf` argument is a caller bug and throws.
 * It does not know the table, so it cannot say whether the state is newer or conserves the escrow: that
 * is checkState. Returns { ok: true, digest } or { ok: false, error, args }.
 */
export function verifyBundle(bundle, { arbiter, sessionKeyOf }) {
  normalizeAddress(arbiter, 'arbiter'); // a bad argument is a caller bug, not a bad bundle
  if (typeof sessionKeyOf !== 'function') throw new TypeError('sessionKeyOf must be a function');
  let b;
  try {
    b = parseBundle(bundle);
  } catch (error) {
    return { ok: false, error: error.code ?? 'Malformed', args: error.code ? [] : [error.message] };
  }
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

/**
 * True when `a` has a strictly higher nonce than `b` (and `b` may be missing). Nonce only: the caller has
 * already made sure both are for the same table and domain. Equal nonces with different digests are not
 * "newer" either way; that is an alarm, not an update.
 */
export function isNewer(a, b) {
  if (!a) return false;
  if (!b) return true;
  return a.state.nonce > b.state.nonce;
}
