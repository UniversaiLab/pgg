// The coordinator side of the chain-port contract: resolver.prepare(job) turns a job, which carries no
// bundle and no state (F3, F4), into the arguments of a transaction at the moment it is about to be sent.
// It reads the store and a fresh chain view itself, so a job queued minutes ago sends what the store holds
// NOW, and it refuses (proceed: false) whenever the transaction would be pointless or wrong:
//
//   createTable             the table record exists, the chain has no such table
//   start                   phase 'starting'; the chain row is Filling and its seats are EXACTLY the stored
//                           roster, every seat confirmed, session keys distinct and none the arbiter's
//   settle                  Active or Exiting; the current epoch's final bundle, or the previous epoch's
//                           final when a reorg took its settle away; checkSettle passes on the chain view
//   challenge               Exiting; the current bundle is newer than the exit, not final, and the window
//                           is open by more than challengeMarginSec of CHAIN time
//   startExit               the stall guard; the current bundle is newer than the chain and not final
//   startExitFromDeposits   the stall guard; no bundle of this epoch is newer than the chain
//   finalizeExit            Exiting, the window has passed on chain time, and a stored state hashes to the
//                           exit's digest (the current bundle, the signed state at the exit's nonce, or
//                           the deposit state), checked before it is sent
//
// The stall guard (section 4) re-checks what the coordinator decided, from the store: the table record
// still carries `stallExit` for this kind (the coordinator clears it in the same transaction that ends the
// stall), the chain is still Active, and the round that stalled is still open. A late signature that lands
// between the decision and the send therefore stops the exit.
//
// Bookkeeping: a job runs only while the store holds it as 'pending'. Going ahead marks it 'sent'; declining
// marks it 'failed' with the reason, which frees its key so the level-triggered reconciler can ask again.
import {
  checkSettle,
  checkState,
  depositState,
  hashState,
  normalizeAddress,
  rosterHash,
  tableFromChain,
} from '@pgg/vault';
import { JOB_KINDS, statusName, TABLE_STATUS } from './chain-port.js';

const no = (reason) => ({ proceed: false, reason });
const go = (args) => ({ proceed: true, args });
const wire = (bundle) => ({
  state: bundle.state,
  arbiterSig: bundle.arbiterSig,
  playerSigs: [...bundle.playerSigs],
});

export class JobResolver {
  #store;
  #chain;
  #domain;
  #margin;

  /**
   * @param {{ store: object, chain: object, challengeMarginSec: number }} options
   */
  constructor({ store, chain, challengeMarginSec }) {
    if (!store || typeof store.getJob !== 'function') throw new TypeError('store is required');
    if (!chain || typeof chain.table !== 'function') throw new TypeError('chain is required');
    if (!Number.isSafeInteger(challengeMarginSec) || challengeMarginSec < 0) {
      throw new TypeError('challengeMarginSec must be a whole number of seconds');
    }
    this.#store = store;
    this.#chain = chain;
    this.#domain = { chainId: chain.info.chainId, verifyingContract: chain.info.vault };
    this.#margin = challengeMarginSec;
  }

  prepare(job) {
    const stored = this.#store.getJob(job.key);
    if (stored?.status !== 'pending') return no('not-pending');
    const decision = this.decide(job);
    if (decision.proceed) {
      this.#store.markJob(job.key, 'sent', { attempts: stored.attempts + 1 });
    } else {
      this.#store.markJob(job.key, 'failed', { error: `skipped: ${decision.reason}` });
    }
    return decision;
  }

  /** The decision alone, without touching the job's bookkeeping. */
  decide({ kind, tableKey }) {
    const record = this.#store.loadTable(tableKey);
    if (!record) return no('unknown-table');
    const raw = this.#chain.table(tableKey);
    const row = raw ? { ...raw, status: statusName(raw.status) } : null;
    switch (kind) {
      case JOB_KINDS.createTable:
        return this.#createTable(record, row);
      case JOB_KINDS.start:
        return this.#start(tableKey, record, row);
      case JOB_KINDS.settle:
        return this.#settle(tableKey, row);
      case JOB_KINDS.challenge:
        return this.#challenge(tableKey, row);
      case JOB_KINDS.startExit:
        return this.#startExit(tableKey, record, row);
      case JOB_KINDS.startExitFromDeposits:
        return this.#startExitFromDeposits(tableKey, record, row);
      case JOB_KINDS.finalizeExit:
        return this.#finalizeExit(tableKey, record, row);
      default:
        return no(`unknown kind ${kind}`);
    }
  }

  #ctx(tableKey, row) {
    return {
      domain: this.#domain,
      maxRakeBps: this.#chain.info.maxRakeBps,
      sessionKeyOf: (player) => this.#chain.seat(tableKey, player)?.sessionKey ?? null,
      table: tableFromChain(row),
    };
  }

  #createTable(record, row) {
    if (row) return no('table-exists');
    if (record.phase !== 'creating') return no(`phase ${record.phase}`);
    const { limits, pinned } = record;
    if (!limits || typeof limits.minDeposit !== 'bigint' || typeof limits.maxDeposit !== 'bigint') {
      return no('no-limits');
    }
    return go({
      maxPlayers: pinned.numSeats,
      minDeposit: limits.minDeposit,
      maxDeposit: limits.maxDeposit,
    });
  }

  #start(tableKey, record, row) {
    if (record.phase !== 'starting') return no(`phase ${record.phase}`);
    if (!row || row.status !== TABLE_STATUS.Filling) return no('not-filling');
    const players = Array.isArray(record.roster) ? record.roster : [];
    if (players.length < 2) return no('roster-too-small');
    if (row.seated !== players.length) return no('seats-changed');
    const arbiter = normalizeAddress(row.arbiter);
    const keys = new Set();
    for (let i = 0; i < players.length; i++) {
      if (i > 0 && !(players[i] > players[i - 1])) return no('roster-not-sorted');
      const seat = this.#chain.seat(tableKey, players[i]);
      if (!seat || seat.deposit <= 0n) return no('seat-missing');
      if (seat.confirmed === false) return no('seat-unconfirmed');
      const key = normalizeAddress(seat.sessionKey);
      // one key on two seats, or the arbiter's own key, would let one signature count twice
      if (key === arbiter || keys.has(key)) return no('session-key-shared');
      keys.add(key);
    }
    return go({ players: [...players] });
  }

  #settle(tableKey, row) {
    if (!row || (row.status !== TABLE_STATUS.Active && row.status !== TABLE_STATUS.Exiting)) {
      return no('not-settleable');
    }
    const current = this.#store.loadBundle(tableKey);
    const previous = this.#store.loadFinalBundle(tableKey);
    let bundle = null;
    if (current?.state.isFinal && current.state.nonce > row.nonce) bundle = current;
    else if (previous && previous.state.nonce > row.nonce) bundle = previous;
    if (!bundle) return no('no-final-above-chain');
    const verdict = checkSettle(bundle.state, bundle, this.#ctx(tableKey, row));
    if (!verdict.ok) return no(`would revert ${verdict.error}`);
    return go({ bundle: wire(bundle) });
  }

  #challenge(tableKey, row) {
    if (!row || row.status !== TABLE_STATUS.Exiting) return no('not-exiting');
    const bundle = this.#store.loadBundle(tableKey);
    if (!bundle || bundle.state.nonce <= row.nonce) return no('nothing-newer');
    if (bundle.state.isFinal) return no('final-is-settled-not-challenged');
    if (this.#chain.chainTime() + this.#margin >= row.exitDeadline) return no('window-closing');
    const verdict = checkState(bundle.state, bundle, this.#ctx(tableKey, row));
    if (!verdict.ok) return no(`would revert ${verdict.error}`);
    return go({ bundle: wire(bundle) });
  }

  // What the coordinator decided, re-read from the store: still wanted for this kind, chain still Active,
  // and the round that stalled (if one did) still open.
  #stallGuard(kind, tableKey, record, row) {
    const stall = record.stallExit;
    if (!stall || stall.kind !== kind) return 'no-stall';
    if (!row || row.status !== TABLE_STATUS.Active) return 'not-active';
    if (stall.nonce !== null && stall.nonce !== undefined) {
      const open = this.#store.openRound(tableKey);
      if (!open || open.nonce !== BigInt(stall.nonce)) return 'round-completed';
    }
    return null;
  }

  #startExit(tableKey, record, row) {
    const blocked = this.#stallGuard(JOB_KINDS.startExit, tableKey, record, row);
    if (blocked) return no(blocked);
    const bundle = this.#store.loadBundle(tableKey);
    if (!bundle || bundle.state.nonce <= row.nonce) return no('nothing-newer');
    if (bundle.state.isFinal) return no('final-is-settled-not-exited');
    const verdict = checkState(bundle.state, bundle, this.#ctx(tableKey, row));
    if (!verdict.ok) return no(`would revert ${verdict.error}`);
    return go({ bundle: wire(bundle) });
  }

  #startExitFromDeposits(tableKey, record, row) {
    const blocked = this.#stallGuard(JOB_KINDS.startExitFromDeposits, tableKey, record, row);
    if (blocked) return no(blocked);
    const bundle = this.#store.loadBundle(tableKey);
    if (bundle && bundle.state.nonce > row.nonce) return no('bundle-newer-than-deposits');
    const players = Array.isArray(record.roster) ? [...record.roster] : [];
    if (players.length < 2 || rosterHash(players) !== row.rosterHash) return no('roster-mismatch');
    return go({ players });
  }

  #finalizeExit(tableKey, record, row) {
    if (!row || row.status !== TABLE_STATUS.Exiting) return no('not-exiting');
    if (this.#chain.chainTime() <= row.exitDeadline) return no('window-open');
    const target = row.exitDigest.toLowerCase();
    for (const state of this.#candidates(tableKey, record, row)) {
      if (hashState(state, this.#domain) === target) return go({ state });
    }
    return no('no-state-for-exit-digest');
  }

  // The states an exit can hold, in the order section 4 gives: the current bundle, the signed state at the
  // exit's nonce, the deposit state (rebuilt from the seats while the chain still has them).
  *#candidates(tableKey, record, row) {
    const bundle = this.#store.loadBundle(tableKey);
    if (bundle) yield bundle.state;
    const signed = this.#store.getSigned(tableKey, row.nonce);
    if (signed) yield signed.state;
    const players = Array.isArray(record.roster) ? record.roster : [];
    if (players.length >= 2) {
      const seats = players.map((p) => this.#chain.seat(tableKey, p));
      if (seats.every((seat) => seat && seat.deposit > 0n)) {
        yield depositState({
          tableId: tableKey,
          players,
          deposits: seats.map((seat) => seat.deposit),
          nonce: row.nonce,
          rake: row.rakePaid,
        });
      }
    }
  }
}
