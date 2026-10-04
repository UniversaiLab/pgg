// The State the arbiter and every player sign, in two shapes:
//
//   internal  { tableId, nonce, isFinal, players, balances, keep, rake, volume }
//             tableId '0x' + 64 lowercase hex; nonce, balances, rake, volume are BigInt; players are
//             lowercase '0x' addresses, strictly ascending by value; keep is a boolean per player.
//   wire      the same, with nonce, balances, rake and volume as DECIMAL STRINGS so it survives JSON.
//
// Every check here throws a RangeError whose message starts with the field it is about, so a log line says
// what was wrong without a stack trace. The contract itself would only revert with no reason on most of
// these (ABI decoding), which is why the library is the one to say it.
import { addressWord, concat, keccakHex, UINT64_MAX, UINT256_MAX } from './bytes.js';

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 10; // PokerVault.MAX_PLAYERS

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const MAX_DECIMAL_DIGITS = 78; // 2^256 - 1 has 78 digits; refuse longer strings before parsing them

/** Lowercase '0x' + 40 hex. Accepts any case on input, throws RangeError on anything else. */
export function normalizeAddress(address, field = 'address') {
  if (typeof address !== 'string' || !ADDRESS.test(address)) {
    throw new RangeError(`${field} must be a 20-byte 0x address`);
  }
  return address.toLowerCase();
}

/** -1, 0 or 1 by numeric value (same-length lowercase hex compares the same as the numbers do). */
export function compareAddress(a, b) {
  const x = normalizeAddress(a);
  const y = normalizeAddress(b);
  if (x === y) return 0;
  return x < y ? -1 : 1;
}

/** True when each address is above the one before it (so they are distinct and sorted). */
export function isStrictlyAscending(addresses) {
  for (let i = 1; i < addresses.length; i++) {
    if (compareAddress(addresses[i - 1], addresses[i]) >= 0) return false;
  }
  return true;
}

/**
 * keccak256 of the players with every address padded to 32 bytes: exactly what the contract stores as
 * `rosterHash` (keccak256(abi.encodePacked(address[])) pads array elements to 32 bytes).
 */
export function rosterHash(players) {
  return keccakHex(concat(players.map((p) => addressWord(normalizeAddress(p, 'players')))));
}

function uint(value, bits, field) {
  let v;
  if (typeof value === 'bigint') v = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) v = BigInt(value);
  else throw new RangeError(`${field} must be a bigint`);
  const max = bits === 64 ? UINT64_MAX : UINT256_MAX;
  if (v < 0n || v > max) throw new RangeError(`${field} is out of range for uint${bits}`);
  return v;
}

function list(value, field) {
  if (!Array.isArray(value)) throw new RangeError(`${field} must be an array`);
  return value;
}

function parse(raw, strict) {
  if (raw === null || typeof raw !== 'object') throw new RangeError('state must be an object');
  if (typeof raw.tableId !== 'string' || !BYTES32.test(raw.tableId)) {
    throw new RangeError('tableId must be 32 bytes of 0x hex');
  }
  if (typeof raw.isFinal !== 'boolean') throw new RangeError('isFinal must be a boolean');
  const state = {
    tableId: raw.tableId.toLowerCase(),
    nonce: uint(raw.nonce, 64, 'nonce'),
    isFinal: raw.isFinal,
    players: list(raw.players, 'players').map((p, i) => normalizeAddress(p, `players[${i}]`)),
    balances: list(raw.balances, 'balances').map((b, i) => uint(b, 256, `balances[${i}]`)),
    keep: list(raw.keep, 'keep').map((k, i) => {
      if (typeof k !== 'boolean') throw new RangeError(`keep[${i}] must be a boolean`);
      return k;
    }),
    rake: uint(raw.rake, 256, 'rake'),
    volume: uint(raw.volume, 256, 'volume'),
  };
  if (!strict) return state;

  const n = state.players.length;
  if (n < MIN_PLAYERS || n > MAX_PLAYERS) {
    throw new RangeError(`players must have ${MIN_PLAYERS} to ${MAX_PLAYERS} entries`);
  }
  if (state.balances.length !== n) throw new RangeError('balances must have one entry per player');
  if (state.keep.length !== n) throw new RangeError('keep must have one entry per player');
  if (BigInt(state.players[0]) === 0n)
    throw new RangeError('players[0] must not be the zero address');
  for (let i = 1; i < n; i++) {
    if (state.players[i] <= state.players[i - 1]) {
      throw new RangeError(`players[${i}] must be above players[${i - 1}] (strictly ascending)`);
    }
  }
  return state;
}

/**
 * What the contract's ABI decoder would accept and no more: right types and ranges (uint64 nonce, uint256
 * amounts, bytes32 tableId, 20-byte addresses), but NOT the rules the contract checks itself (array
 * lengths, roster order, player count). checkState uses it so that a state with a bad roster gets the
 * contract's error for it instead of an exception. Everything else should use normalizeState.
 */
export const decodeState = (raw) => parse(raw, false);

/**
 * Validate and canonicalise a State (lowercase addresses and tableId, BigInt numbers; a safe-integer
 * number is accepted for a number field). Throws RangeError naming the field: tableId not 32 bytes,
 * nonce beyond uint64, an amount beyond uint256, a bad address, arrays of different lengths, fewer than 2
 * or more than 10 players, players not strictly ascending. Returns a new object; the input is untouched.
 */
export const normalizeState = (raw) => parse(raw, true);

/** Internal State -> JSON-safe State (nonce, balances, rake and volume as decimal strings). */
export function toWire(state) {
  const s = normalizeState(state);
  return {
    tableId: s.tableId,
    nonce: s.nonce.toString(),
    isFinal: s.isFinal,
    players: s.players,
    balances: s.balances.map(String),
    keep: s.keep,
    rake: s.rake.toString(),
    volume: s.volume.toString(),
  };
}

function decimal(value, field) {
  if (typeof value !== 'string' || value.length > MAX_DECIMAL_DIGITS || !DECIMAL.test(value)) {
    throw new RangeError(`${field} must be a decimal string`);
  }
  return BigInt(value);
}

/**
 * Wire State -> internal State. Strict on purpose: a number must be a string of digits with no sign, no
 * whitespace, no leading zero ('0' alone is fine), no '0x' and no decimal point; a JSON number is refused
 * even if it is an integer, because above 2^53 it has already lost digits.
 */
export function fromWire(wire) {
  if (wire === null || typeof wire !== 'object') throw new RangeError('state must be an object');
  return normalizeState({
    tableId: wire.tableId,
    nonce: decimal(wire.nonce, 'nonce'),
    isFinal: wire.isFinal,
    players: wire.players,
    balances: list(wire.balances, 'balances').map((b, i) => decimal(b, `balances[${i}]`)),
    keep: wire.keep,
    rake: decimal(wire.rake, 'rake'),
    volume: decimal(wire.volume, 'volume'),
  });
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const lower = (list) => list.map((item) => item.toLowerCase());

/** Field-for-field equality of two internal States. Never throws; anything that is not a State is false. */
export function statesEqual(a, b) {
  try {
    return (
      a.tableId.toLowerCase() === b.tableId.toLowerCase() &&
      a.nonce === b.nonce &&
      a.isFinal === b.isFinal &&
      sameList(lower(a.players), lower(b.players)) &&
      sameList(a.balances, b.balances) &&
      sameList(a.keep, b.keep) &&
      a.rake === b.rake &&
      a.volume === b.volume
    );
  } catch {
    return false;
  }
}
