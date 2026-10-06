// When does an epoch end, and who stays at the table (docs/signing-layer.md section 2)? Pure and
// table-driven: the coordinator hands in what it knows (chips, requests, ages it measured itself) and gets
// back a decision. No clock, no store, no chain here, so every rule is one line of a test table.
//
// An epoch ends with a FINAL state whose keep flags say who carries their balance into the next epoch:
//
//   keep[i] = chips_i > 0 && !leaving_i && !kicked_i
//
// Chips, not balance: dust alone (a deposit remainder below one chip) never keeps a seat, it is paid out
// (F9). The contract only refuses keep with a zero balance, and the clients refuse a kept seat below one
// chip unit (rule C2), so a dust-only keep would make the final unsignable.
//
// Reasons, and whether they wait for minEpochHands:
//   maintenance  forced     the epoch is older than maxEpochMs or longer than maxEpochHands, or the oldest
//                           session key is about to pass its policy age (F14: rotate BEFORE the arbiter
//                           would have to refuse a co-signature, never on one)
//   bust         forced     a member has no chips left: they can only stall the table from now on
//   drain        voluntary  the operator empties the table
//   leave        voluntary  a member asked to leave
//   idle         voluntary  a member sat out idleKickHands hands in a row while still connected
// A forced reason rotates at once; a voluntary one waits until the epoch has had minEpochHands hands, so a
// table does not pay a settle for every whim, unless fewer than two members could play on (then no hand
// would ever come). Whoever is leaving or kicked is out of ANY rotation that happens, whatever its reason,
// because the final is the only exit that costs nothing.

export const ROTATION_REASONS = Object.freeze(['maintenance', 'bust', 'drain', 'leave', 'idle']);
export const FORCED_REASONS = Object.freeze(['maintenance', 'bust']);

const isCount = (n) => Number.isSafeInteger(n) && n >= 0;
const isMs = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;

function readConfig(config) {
  if (config === null || typeof config !== 'object') throw new TypeError('config is required');
  const out = {};
  for (const field of ['minEpochHands', 'maxEpochHands', 'idleKickHands']) {
    if (!isCount(config[field])) throw new TypeError(`config.${field} must be a whole number`);
    out[field] = config[field];
  }
  for (const field of ['maxEpochMs', 'policyMaxMs', 'policyMarginMs']) {
    if (!isMs(config[field])) throw new TypeError(`config.${field} must be milliseconds`);
    out[field] = config[field];
  }
  return out;
}

// Map, plain object or nothing -> a lookup function. Ages the coordinator could not measure are absent.
function readAges(keyAges) {
  if (keyAges === undefined || keyAges === null) return () => undefined;
  if (keyAges instanceof Map) return (address) => keyAges.get(address);
  if (typeof keyAges === 'object') return (address) => keyAges[address];
  throw new TypeError('keyAges must be a Map or an object');
}

function readSet(list, field) {
  if (list === undefined || list === null) return new Set();
  if (list instanceof Set) return new Set([...list].map((a) => String(a).toLowerCase()));
  if (Array.isArray(list)) return new Set(list.map((a) => String(a).toLowerCase()));
  throw new TypeError(`${field} must be a Set or an array of addresses`);
}

/**
 * Milliseconds until the epoch must have rotated: min(maxEpochMs - epochAge, for every key policyMaxMs -
 * margin - keyAge). Zero or less means now. Infinity only when neither bound applies (no ages known and no
 * epoch age), which the coordinator never asks about.
 */
export function epochRemainingMs({ epochAgeMs, keyAges, addresses = [], config }) {
  const c = readConfig(config);
  const ageOf = readAges(keyAges);
  let remaining = Number.POSITIVE_INFINITY;
  if (isMs(epochAgeMs)) remaining = c.maxEpochMs - epochAgeMs;
  for (const address of addresses) {
    const age = ageOf(address);
    if (isMs(age)) remaining = Math.min(remaining, c.policyMaxMs - c.policyMarginMs - age);
  }
  return remaining;
}

/** True when this key is too old to start or stay in another epoch (its policy deadline has come). */
export function keyExpiring(age, config) {
  const c = readConfig(config);
  return isMs(age) && age >= c.policyMaxMs - c.policyMarginMs;
}

/**
 * Should the epoch end now, and who stays?
 *
 *   entries        [{ address, chips, leaving?, idleHands? }] in STATE order (one per roster member);
 *                  chips are whole chips (dust is not chips), idleHands the sit-out hands in a row while
 *                  connected
 *   handsInEpoch   hands played in this epoch, the one just ended included
 *   epochAgeMs     how long the epoch has run, or undefined when unknown
 *   keyAges        Map | object: address -> ms since that seat's session key was registered on chain
 *   drain          the operator wants the table emptied
 *   leaveRequests  addresses that asked to leave (besides entries[i].leaving)
 *   config         { minEpochHands, maxEpochHands, maxEpochMs, idleKickHands, policyMaxMs, policyMarginMs }
 *
 * Returns { rotate, reason, keep, kicked, leaving }: `keep` is in state order and is meaningful only when
 * `rotate` is true; `reason` is the first applicable one of ROTATION_REASONS (forced ones first), or null.
 * Throws TypeError on input it cannot read (a caller bug, never a state of the table).
 */
export function rotationDecision({
  entries,
  handsInEpoch,
  epochAgeMs,
  keyAges,
  drain = false,
  leaveRequests,
  config,
}) {
  const c = readConfig(config);
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new TypeError('entries must be a non-empty array');
  }
  if (!isCount(handsInEpoch)) throw new TypeError('handsInEpoch must be a whole number');
  if (typeof drain !== 'boolean') throw new TypeError('drain must be a boolean');
  const ageOf = readAges(keyAges);
  const asked = readSet(leaveRequests, 'leaveRequests');

  const seats = entries.map((entry, i) => {
    if (entry === null || typeof entry !== 'object' || typeof entry.address !== 'string') {
      throw new TypeError(`entries[${i}] must be { address, chips }`);
    }
    if (!isCount(entry.chips)) throw new TypeError(`entries[${i}].chips must be whole chips`);
    const idleHands = entry.idleHands ?? 0;
    if (!isCount(idleHands)) throw new TypeError(`entries[${i}].idleHands must be a whole number`);
    const address = entry.address.toLowerCase();
    return {
      address,
      chips: entry.chips,
      leaving: entry.leaving === true || asked.has(address),
      idle: c.idleKickHands > 0 && idleHands >= c.idleKickHands,
      keyExpired: keyExpiring(ageOf(address), c),
    };
  });

  const remaining = epochRemainingMs({
    epochAgeMs,
    keyAges,
    addresses: seats.map((s) => s.address),
    config: c,
  });
  const due = {
    maintenance: handsInEpoch >= c.maxEpochHands || remaining <= 0,
    bust: seats.some((s) => s.chips === 0),
    drain,
    leave: seats.some((s) => s.leaving),
    idle: seats.some((s) => s.idle),
  };
  const kicked = seats.filter((s) => drain || s.idle || s.keyExpired).map((s) => s.address);
  const leaving = seats.filter((s) => s.leaving).map((s) => s.address);
  const out = new Set([...kicked, ...leaving]);

  // The minimum only paces a table that can play on: once fewer than two members could still be dealt in
  // (everyone else is leaving, kicked or bust), no hand will ever reach it, and waiting would hold the
  // leavers until maintenance.
  const playable = seats.filter((s) => s.chips > 0 && !out.has(s.address)).length;
  const forced = FORCED_REASONS.find((reason) => due[reason]) ?? null;
  const voluntary =
    handsInEpoch >= c.minEpochHands || playable < 2
      ? (ROTATION_REASONS.find((reason) => !FORCED_REASONS.includes(reason) && due[reason]) ?? null)
      : null;
  const reason = forced ?? voluntary;

  return {
    rotate: reason !== null,
    reason,
    keep: seats.map((s) => s.chips > 0 && !out.has(s.address)),
    kicked,
    leaving,
  };
}
