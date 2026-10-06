// What this client SAW at the table, in the form clientShouldSign compares a proposal with (docs/signing-layer.md
// section 8, F8). It is built from the CURRENT PUBLIC TABLE STATE, not from replayed hand events: a client that
// reconnects, or backgrounds the page for a minute, has no event history but still sees every stack. So
//
//   delta_i = chips shown_i - floor(base.balances_i / unit)        what each roster seat won or lost since the base
//   rake    = - sum(delta_i)                                       chips that left the table
//   pot     = the live hand-end result of the hand the proposal    exact only when that hand was watched live
//             names, else null
//
// The base is a State (the last state this client signed, or the epoch's baseline): the signer picks it. Dust
// never moves in a hand, so flooring the base balance to whole chips makes it cancel out.
//
// The pot is matched to the hand the proposal is for (signreq.handNo), never to "the last hand shown": a
// standalone final (a rotation between hands) follows no hand, and comparing its volume with the previous
// hand's pot would refuse an honest rotation. The hand number only picks which pot the volume is compared with,
// so a lie about it costs nothing: volume is self-attested and buys rake headroom, never money.
//
// The ledger never throws on what the server sends (a malformed table message just makes it forget what it
// knew), and it says "I do not know" rather than guess: an unknown address, a hand still in progress, or two
// accounts of the same hand that disagree.
import { normalizeAddress } from './state.js';

const MAX_RESULTS = 32; // enough to span every hand a sign round can straddle; older ones are dropped
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

/**
 * Why observedStatus answered no, and whether waiting can fix it. A "wait" reason (no table state yet, a hand
 * in progress, an address not shown yet) goes away by itself when the next table message arrives; a
 * "permanent" one (the server's own accounts disagree, or show chips that cannot exist) does not, so the
 * signer refuses instead of waiting for it.
 */
export const LEDGER_BLOCKERS = Object.freeze({
  'no-table': 'wait',
  'mid-hand': 'wait',
  'unknown-address': 'wait',
  'bad-seat': 'permanent',
  'duplicate-address': 'permanent',
  'stacks-exceed-base': 'permanent',
  conflict: 'permanent',
});

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// A hand-end result as the engine emits it: { handNo, pot, rake, stacks (chips per seat), busted (seats) }.
// Anything else is not trusted as a live account of the hand.
function readResult(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const { handNo, pot, rake, stacks, busted = [] } = raw;
  if (!isCount(handNo) || !isCount(pot) || !isCount(rake)) return null;
  if (!Array.isArray(stacks) || !stacks.every(isCount)) return null;
  if (!Array.isArray(busted) || !busted.every(isCount)) return null;
  return { handNo, pot, rake, stacks: [...stacks], busted: [...busted] };
}

// The public table state reduced to what the checks read. Throws on a shape that is not a table state.
function readTable(state) {
  if (state === null || typeof state !== 'object' || !Array.isArray(state.seats)) {
    throw new RangeError('state.seats must be an array');
  }
  const byAddress = new Map();
  const duplicates = new Set();
  let betting = false;
  state.seats.forEach((seat, index) => {
    if (seat === null || seat === undefined) return;
    if (typeof seat !== 'object') throw new RangeError('a seat must be an object or null');
    // a bet is chips on the table that are not in the stack yet: if one is out, the stacks are not final
    if (seat.bet !== undefined && seat.bet !== 0) betting = true;
    let address = null;
    if (seat.address !== undefined && seat.address !== null) {
      try {
        address = normalizeAddress(seat.address);
      } catch {
        address = null; // an unreadable address is an unknown one
      }
    }
    if (address === null) return;
    if (byAddress.has(address)) duplicates.add(address);
    else byAddress.set(address, { index, chips: isCount(seat.chips) ? seat.chips : null });
  });
  return {
    // only an explicit false counts: a missing or odd inHand is "a hand may be running"
    quiet: state.inHand === false && !betting,
    handNo: isCount(state.handNo) ? state.handNo : null,
    epoch: isCount(state.vault?.epoch) ? state.vault.epoch : null,
    byAddress,
    duplicates,
  };
}

const asNumber = (value) =>
  value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value;

/**
 * @param {{ unit: bigint, tableId?: string }} options
 *   unit     token base units per chip (the one pinned when the player deposited)
 *   tableId  when given, table messages for any other (game) table are ignored
 */
export function createLedger({ unit, tableId } = {}) {
  if (typeof unit !== 'bigint' || unit <= 0n) throw new TypeError('unit must be a bigint above 0');
  if (tableId !== undefined && typeof tableId !== 'string') {
    throw new TypeError('tableId must be a string');
  }
  let table = null; // the newest public table state, reduced; null until one arrives (or after a bad one)
  const results = new Map(); // `${epoch}:${handNo}` -> the FIRST live hand-end result seen for that hand
  const conflicts = new Map(); // `${kind}:${epoch}:${handNo}` -> { kind, epoch, handNo, detail }

  const keyOf = (epoch, handNo) => `${epoch}:${handNo}`;
  const flag = (kind, epoch, handNo, detail) => {
    const key = `${kind}:${keyOf(epoch, handNo)}`;
    if (!conflicts.has(key)) conflicts.set(key, { kind, epoch, handNo, detail });
  };

  function ingest(raw, epoch) {
    const result = readResult(raw);
    if (!result) return { ok: false, reason: 'malformed' };
    const key = keyOf(epoch, result.handNo);
    const first = results.get(key);
    if (!first) {
      results.set(key, result);
      if (results.size > MAX_RESULTS) results.delete(results.keys().next().value);
      return { ok: true, stored: true };
    }
    const same =
      first.pot === result.pot &&
      first.rake === result.rake &&
      sameList(first.stacks, result.stacks) &&
      sameList(first.busted, result.busted);
    if (same) return { ok: true, stored: false };
    // first seen wins: the second account is kept out, and the disagreement is on record
    flag('hand-end', epoch, result.handNo, `two different results for hand ${result.handNo}`);
    return { ok: true, stored: false, conflict: true };
  }

  const blocked = (reason, detail) => ({
    ok: false,
    reason,
    detail,
    permanent: LEDGER_BLOCKERS[reason] === 'permanent',
  });

  // The live result of `handNo`, checked against the stacks it left behind. null when the hand was not
  // watched live (or the table shows another hand); a blocked() answer when the two accounts disagree.
  function liveResult(handNo, seats, rake) {
    if (!isCount(handNo) || table.handNo !== handNo) return null;
    const key = keyOf(table.epoch, handNo);
    if (conflicts.has(`hand-end:${key}`)) {
      return blocked('conflict', `the server gave two different results for hand ${handNo}`);
    }
    const result = results.get(key);
    if (!result) return null;
    // A seat the engine dealt in shows exactly the stack the result gave it, a busted one shows 0. A seat
    // with 0 in the result that did not bust was not in the hand (waiting, sitting out), so it is skipped.
    for (const seat of seats) {
      const stack = result.stacks[seat.index];
      const played = (stack !== undefined && stack > 0) || result.busted.includes(seat.index);
      if (played && stack !== seat.chips) {
        flag('stacks', table.epoch, handNo, `seat ${seat.index} differs from the result`);
        return blocked(
          'conflict',
          `the hand-end result and the stacks disagree on seat ${seat.index}`,
        );
      }
    }
    if (BigInt(result.rake) !== rake) {
      flag('rake', table.epoch, handNo, `the result took ${result.rake}, the stacks lost ${rake}`);
      return blocked(
        'conflict',
        `the hand-end result took ${result.rake} chips of rake, the stacks lost ${rake}`,
      );
    }
    return { ok: true, pot: result.pot };
  }

  const ledger = {
    /**
     * Take in one `tbl` message: the public seats (address, chips) and whether a hand is running. Any
     * hand-end events it carries are recorded too. A message that is not a table state makes the ledger forget
     * the last one, because stale stacks are worse than none. Returns { ok: true } or { ok: false, reason }.
     */
    observeTable(message) {
      try {
        if (tableId !== undefined && message?.tableId !== tableId) {
          return { ok: false, reason: 'other-table' };
        }
        table = readTable(message?.state);
      } catch {
        table = null;
        return { ok: false, reason: 'malformed' };
      }
      if (Array.isArray(message.events)) {
        for (const event of message.events) {
          if (event?.type === 'hand-end') ingest(event.result, table.epoch);
        }
      }
      return { ok: true };
    },

    /**
     * Record a hand-end result the client watched live: `{ type: 'hand-end', result: { handNo, pot, rake,
     * stacks, busted } }`, keyed by (epoch, handNo); `epoch` defaults to the one the newest table message
     * carried. The first result for a hand wins; an identical repeat is ignored; a different one is a
     * conflict. Returns { ok: true, stored, conflict? } or { ok: false, reason: 'malformed' }.
     */
    observeEvent(event, epoch = table?.epoch ?? null) {
      if (event === null || typeof event !== 'object' || event.type !== 'hand-end') {
        return { ok: false, reason: 'malformed' };
      }
      return ingest(event.result, epoch);
    },

    /** The disagreements seen so far: [{ kind, epoch, handNo, detail }]. They never clear. */
    conflicts: () => [...conflicts.values()],

    /**
     * observedFor with the reason: { ok: true, observed } or { ok: false, reason, detail, permanent }, reason
     * one of LEDGER_BLOCKERS. `base` is the State the proposal is judged against, `roster` the seats'
     * addresses in state order (they must be the base's players), `handNo` the hand the proposal says it is
     * for (signreq.handNo; null or absent for a state that follows no hand). A bad `base` or `roster` is a
     * caller bug and throws TypeError.
     */
    observedStatus({ base, roster, handNo = null } = {}) {
      if (!Array.isArray(roster) || roster.length === 0) {
        throw new TypeError('roster must be a non-empty array of addresses');
      }
      const wanted = roster.map((a, i) => normalizeAddress(a, `roster[${i}]`));
      if (
        !base ||
        !Array.isArray(base.balances) ||
        base.balances.length !== wanted.length ||
        !base.balances.every((b) => typeof b === 'bigint' && b >= 0n) ||
        !Array.isArray(base.players) ||
        base.players.some((p, i) => p !== wanted[i])
      ) {
        throw new TypeError('base must be the State of exactly this roster');
      }
      if (!table) return blocked('no-table', 'no table state has been seen yet');
      if (!table.quiet)
        return blocked('mid-hand', 'a hand is in progress, the stacks are not final');

      const deltas = [];
      const seats = [];
      for (let i = 0; i < wanted.length; i++) {
        const address = wanted[i];
        if (table.duplicates.has(address)) {
          return blocked('duplicate-address', `${address} is shown on two seats`);
        }
        const seat = table.byAddress.get(address);
        if (!seat) return blocked('unknown-address', `no seat shows ${address}`);
        if (seat.chips === null)
          return blocked('bad-seat', `the chips of ${address} are unreadable`);
        seats.push(seat);
        deltas.push(BigInt(seat.chips) - base.balances[i] / unit);
      }
      const rake = -deltas.reduce((a, b) => a + b, 0n);
      // chips cannot appear at a table: a rake below zero means the stacks are not what the base held
      if (rake < 0n) {
        return blocked('stacks-exceed-base', `the stacks hold ${-rake} more chips than the base`);
      }
      const live = liveResult(handNo, seats, rake);
      if (live && !live.ok) return live;
      return {
        ok: true,
        observed: {
          deltas: deltas.map(asNumber),
          rake: asNumber(rake),
          pot: live ? live.pot : null,
        },
      };
    },

    /**
     * What happened at the table since `base`, in chips: { deltas (state order), rake, pot } where pot is a
     * number only when the named hand was watched live (else null: only the stacks are known). Null when it
     * cannot be said: a hand in progress, a roster address no seat shows, or the server's accounts disagree
     * (observedStatus says which).
     */
    observedFor(args) {
      const status = ledger.observedStatus(args);
      return status.ok ? status.observed : null;
    },
  };
  return ledger;
}
