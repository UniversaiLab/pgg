// Building States. The server builds every state it proposes; clients and the watchtower build the deposit
// state (for an exit) or the epoch baseline (for the next hand) to compare against. Nothing here checks the
// money: run checkState on the result before it is proposed, because that is the check that knows the
// table's escrow.
import { compareAddress, normalizeAddress, normalizeState } from './state.js';

const allFalse = (n) => Array.from({ length: n }, () => false);

const amount = (value, field) => {
  if (typeof value === 'bigint') return value;
  if (Number.isSafeInteger(value)) return BigInt(value);
  throw new RangeError(`${field} must be a bigint`);
};

// One builder behind the three public names below. They differ only in which of nonce, rake and volume
// the caller must say out loud, because a silent default is how a rolled-over epoch lost its volume.
function baselineState({ tableId, players, deposits, nonce, rake, volume }) {
  if (!Array.isArray(deposits)) throw new RangeError('deposits must be an array');
  if (!Array.isArray(players)) throw new RangeError('players must be an array');
  return normalizeState({
    tableId,
    nonce: amount(nonce, 'nonce'),
    isFinal: false,
    players,
    balances: deposits.map((d, i) => amount(d, `deposits[${i}]`)),
    keep: allFalse(players.length),
    rake: amount(rake, 'rake'),
    volume: amount(volume, 'volume'),
  });
}

/**
 * The synthetic state `startExitFromDeposits` puts up, exactly as PokerVault builds it in `depositState`:
 * each player's balance is their deposit, nothing is final or kept, `nonce` and `rake` are the table's
 * current `nonce` and `rakePaid` (0 for a new table), and **volume is always 0**: the contract does not
 * store volume, so the exit digest has none. Use this to compare against, or finalise, an exit from
 * deposits. It is NOT the baseline for playing the next hand of a rolled-over epoch: that is epochBaseline.
 * `players` must already be the roster, strictly ascending, with `deposits[i]` belonging to `players[i]`.
 */
export function depositState({ tableId, players, deposits, nonce = 0n, rake = 0n, ...rest }) {
  if ('volume' in rest) throw new RangeError('depositState has no volume: it is always 0');
  return baselineState({ tableId, players, deposits, nonce, rake, volume: 0n });
}

/**
 * The state the FIRST hand of an epoch is built on, and the baseline a client checks it against. Rake and
 * volume are cumulative since the table was created, so after a rollover this carries both: `nonce` and
 * `rake` are the table's `nonce` and `rakePaid`, and `volume` is the volume of the final state that closed
 * the previous epoch. The vault does not store volume, so take it from the final bundle you hold (server
 * and clients keep it durably), never from a message the other side sends you. Leave it at 0 and the next
 * hand at 2% of its own pot is RakeTooHigh against the cumulative cap. `deposits[i]` is the balance of
 * `players[i]` (a stayer's balance from the final state, a new player's deposit). All three of nonce, rake
 * and volume are required, on purpose: 0n for a brand-new table, written out.
 */
export function epochBaseline({ tableId, players, deposits, nonce, rake, volume }) {
  for (const [name, value] of [
    ['nonce', nonce],
    ['rake', rake],
    ['volume', volume],
  ]) {
    if (value === undefined) {
      throw new RangeError(
        `${name} is required (cumulative since the table was created; 0n if new)`,
      );
    }
  }
  return baselineState({ tableId, players, deposits, nonce, rake, volume });
}

/**
 * The general form of the two above, kept so existing callers work: `volume` is optional and defaults to
 * 0n. Prefer depositState (exit digests) or epochBaseline (playing on): they say which one you mean.
 */
export function genesisState({ tableId, players, deposits, nonce = 0n, rake = 0n, volume = 0n }) {
  return baselineState({ tableId, players, deposits, nonce, rake, volume });
}

/**
 * The state after one more hand: nonce + 1, the same roster, `balances` as given (aligned to
 * `prev.players`), and rake and volume advanced by their deltas (they are cumulative since the table was
 * created). A final state carries `keep` (default: nobody stays, everyone is paid out); a state that is
 * not final always has keep all false, because the contract only reads it in settle.
 */
export function buildNextState({
  prev,
  balances,
  rakeDelta = 0n,
  volumeDelta = 0n,
  final = false,
  keep,
}) {
  const p = normalizeState(prev);
  const n = p.players.length;
  if (!Array.isArray(balances) || balances.length !== n) {
    throw new RangeError('balances must have one entry per player');
  }
  if (final && keep !== undefined && (!Array.isArray(keep) || keep.length !== n)) {
    throw new RangeError('keep must have one entry per player');
  }
  if (typeof final !== 'boolean') throw new RangeError('final must be a boolean');
  const rakeStep = amount(rakeDelta, 'rakeDelta');
  const volumeStep = amount(volumeDelta, 'volumeDelta');
  if (rakeStep < 0n) throw new RangeError('rakeDelta must not be negative');
  if (volumeStep < 0n) throw new RangeError('volumeDelta must not be negative');
  return normalizeState({
    tableId: p.tableId,
    nonce: p.nonce + 1n,
    isFinal: final,
    players: p.players,
    balances: balances.map((b, i) => amount(b, `balances[${i}]`)),
    keep: final && keep ? keep : allFalse(n),
    rake: p.rake + rakeStep,
    volume: p.volume + volumeStep,
  });
}

/**
 * Sort a roster of `{ address, ... }` objects ascending by address, the order the contract needs. Returns
 *   sorted    the same objects in state order
 *   order     order[j] = the index in the input of the object at state index j
 *   position  position[i] = the state index of input object i
 * so a caller can put seat i's chips at balances[position[i]] and read state index j back as
 * input[order[j]]. Addresses are compared as numbers in any case; a duplicate or invalid one throws.
 */
export function sortRoster(items) {
  if (!Array.isArray(items)) throw new RangeError('roster must be an array');
  const keyed = items.map((item, index) => ({
    item,
    index,
    address: normalizeAddress(item?.address, `roster[${index}].address`),
  }));
  keyed.sort((a, b) => compareAddress(a.address, b.address));
  for (let j = 1; j < keyed.length; j++) {
    if (keyed[j].address === keyed[j - 1].address) {
      throw new RangeError(`roster has a duplicate address ${keyed[j].address}`);
    }
  }
  const position = new Array(items.length);
  keyed.forEach((k, j) => {
    position[k.index] = j;
  });
  return { sorted: keyed.map((k) => k.item), order: keyed.map((k) => k.index), position };
}
