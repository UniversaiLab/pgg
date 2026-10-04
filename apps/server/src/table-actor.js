// A TableActor owns one table: the engine, the dealer, who is sitting where, and the timers.
// Nothing else touches them, so every state change is serialised by construction (one synchronous
// handler at a time) and the table can later move to its own worker without changing this file.
//
// The actor never talks to sockets. It uses two injected things:
//   bus   { publish(topic, msg), send(playerId, msg), subscribe(playerId, topic), unsubscribe(...) }
//   clock { now(), setTimeout(fn, ms), clearTimeout(handle) }
// so tests can run it with a fake clock and an in-memory bus.
//
// Money: chips for a seat live in the engine while it is `seated`, and in the roster entry while it
// is `waiting` (joined mid-hand) or `sitout`. Wallet <-> table transfers happen only in join(),
// rebuy() and #remove(), which keeps the conservation invariant easy to check.

import { CommitRevealDealer, IllegalActionError, PokerTable } from '@pgg/engine';
import { ERR, SERVER } from '@pgg/protocol/constants';

const ENGINE_ERRORS = {
  'not-your-turn': ERR.NOT_YOUR_TURN,
  'illegal-action': ERR.ILLEGAL_ACTION,
  'bad-amount': ERR.BAD_AMOUNT,
  'no-action-pending': ERR.STALE_HAND,
};

export const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

export const LOBBY_TOPIC = 'lobby';

const defaultTable = (cfg) =>
  new PokerTable({
    tableId: cfg.id,
    numSeats: cfg.numSeats,
    smallBlind: cfg.smallBlind,
    bigBlind: cfg.bigBlind,
    rake: { bps: cfg.rakeBps, cap: cfg.rakeCap },
  });

const fail = (code, msg) => ({ ok: false, code, msg });
const ok = (extra = {}) => ({ ok: true, ...extra });

export class TableActor {
  #cfg;
  #bus;
  #wallet;
  #clock;
  #onChange;
  #onSeat;
  #table;
  #dealer;

  #roster = new Map(); // seat -> entry
  #byPlayer = new Map(); // playerId -> seat
  #hole = new Map(); // playerId -> [card, card] for the hand in progress
  #participants = []; // playerIds dealt into the hand in progress

  #handNo = 0; // hand in progress, or the last one played
  #nextHandNo = 1;
  #fair = { current: null, next: null };
  #seq = 0;
  #deadline = null;
  #turnTimer = null;
  #startTimer = null;
  #destroyed = false;

  /**
   * @param {{ cfg: object, bus: object, wallet: object, clock?: object,
   *   onChange?: () => void, onSeat?: (playerId: string, tableId: string | null) => void }} deps
   */
  constructor({
    cfg,
    bus,
    wallet,
    clock = realClock,
    onChange = () => {},
    onSeat = () => {},
    createTable = defaultTable, // tests inject a faulty table to exercise recovery
  }) {
    this.#cfg = cfg;
    this.#bus = bus;
    this.#wallet = wallet;
    this.#clock = clock;
    this.#onChange = onChange;
    this.#onSeat = onSeat;
    this.#table = createTable(cfg);
    this.#dealer = new CommitRevealDealer({ tableId: cfg.id });
    // Publish the first commitment immediately so players can contribute client seeds to hand 1.
    this.#fair.next = this.#dealer.commit(this.#nextHandNo);
  }

  get id() {
    return this.#cfg.id;
  }

  get topic() {
    return `table:${this.#cfg.id}`;
  }

  summary() {
    const c = this.#cfg;
    return {
      id: c.id,
      name: c.name,
      smallBlind: c.smallBlind,
      bigBlind: c.bigBlind,
      minBuyIn: c.minBuyIn,
      maxBuyIn: c.maxBuyIn,
      numSeats: c.numSeats,
      occupied: this.#roster.size,
      rakeBps: c.rakeBps,
    };
  }

  seatOf(playerId) {
    return this.#byPlayer.get(playerId) ?? null;
  }

  /**
   * Every chip at this table, including bets and pots mid-hand and the chips of players who are
   * waiting or sitting out (for conservation checks).
   */
  chipsOnTable() {
    let total = this.#table.totalChips();
    for (const entry of this.#roster.values()) {
      if (entry.status !== 'seated') total += entry.chips;
    }
    return total;
  }

  destroy() {
    this.#destroyed = true;
    this.#clearTurn();
    if (this.#startTimer !== null) this.#clock.clearTimeout(this.#startTimer);
    this.#startTimer = null;
  }

  // ---- commands from players ---------------------------------------------------------------

  join(player, { buyIn, seat }) {
    const c = this.#cfg;
    if (this.#byPlayer.has(player.id)) return fail(ERR.ALREADY_SEATED);
    if (!Number.isSafeInteger(buyIn) || buyIn < c.minBuyIn || buyIn > c.maxBuyIn) {
      return fail(ERR.BAD_BUY_IN, `buy-in must be ${c.minBuyIn}-${c.maxBuyIn}`);
    }
    let chosen = seat;
    if (chosen === undefined) {
      chosen = [...Array(c.numSeats).keys()].find((s) => !this.#roster.has(s));
      if (chosen === undefined) return fail(ERR.TABLE_FULL);
    } else if (chosen >= c.numSeats) {
      return fail(ERR.SEAT_TAKEN);
    } else if (this.#roster.has(chosen)) {
      return fail(ERR.SEAT_TAKEN);
    }
    if (!this.#wallet.debit(player.id, buyIn)) return fail(ERR.INSUFFICIENT_FUNDS);

    this.#roster.set(chosen, {
      playerId: player.id,
      name: player.name,
      seat: chosen,
      chips: buyIn, // meaningful while not `seated`
      status: 'waiting',
      connected: true,
      leaving: false,
      sitoutRequested: false,
      timeouts: 0,
      dropTimer: null,
    });
    this.#byPlayer.set(player.id, chosen);
    this.#bus.subscribe(player.id, this.topic);
    this.#bus.unsubscribe(player.id, LOBBY_TOPIC); // a seated player is not looking at the lobby
    this.#onSeat(player.id, this.id);
    this.#bus.send(player.id, { t: SERVER.SEATED, tableId: this.id, seat: chosen });

    if (!this.#table.inHand) this.#reconcile();
    this.#publish();
    this.#scheduleStart();
    this.#sendCards(player.id);
    return ok({ seat: chosen });
  }

  leave(playerId) {
    const entry = this.#entry(playerId);
    if (!entry) return fail(ERR.NOT_SEATED);
    const dealtIn = this.#participants.includes(playerId);
    if (this.#table.inHand && entry.status === 'seated' && dealtIn) {
      entry.leaving = true; // chips come back when the hand ends; fold now if it is their turn
      this.#guard('leave', () => this.#autoActLeavers());
      this.#publish();
    } else {
      this.#remove(entry, 'left');
      this.#publish();
    }
    return ok();
  }

  act(playerId, { handNo, action, amount }) {
    const entry = this.#entry(playerId);
    if (entry?.status !== 'seated') return fail(ERR.NOT_SEATED);
    if (!this.#table.inHand || handNo !== this.#handNo) return fail(ERR.STALE_HAND);
    let events;
    try {
      ({ events } = this.#table.act(entry.seat, action, amount));
    } catch (error) {
      if (error instanceof IllegalActionError) {
        return fail(ENGINE_ERRORS[error.code] ?? ERR.ILLEGAL_ACTION, error.message);
      }
      this.#recover('act', error);
      return fail(ERR.STALE_HAND, 'the hand was cancelled');
    }
    entry.timeouts = 0;
    entry.sitoutRequested = false; // acting for yourself cancels a pending sit-out
    this.#guard('act', () => this.#afterEngine(events));
    return ok();
  }

  /** A player's contribution to the next hand's deck. Must arrive before that hand is dealt. */
  submitSeed(playerId, { handNo, seed }) {
    const entry = this.#entry(playerId);
    if (!entry) return fail(ERR.NOT_SEATED);
    if (handNo !== this.#fair.next?.handNo) return fail(ERR.SEED_CLOSED);
    try {
      this.#dealer.submitClientSeed(handNo, entry.seat, seed);
      return ok();
    } catch {
      return fail(ERR.SEED_CLOSED);
    }
  }

  rebuy(playerId, amount) {
    const entry = this.#entry(playerId);
    if (!entry) return fail(ERR.NOT_SEATED);
    const current = this.#chipsOf(entry);
    if (current + amount > this.#cfg.maxBuyIn)
      return fail(ERR.BAD_BUY_IN, 'over the maximum buy-in');
    const dealtIn = this.#participants.includes(playerId);
    if (this.#table.inHand && entry.status === 'seated' && dealtIn) {
      return fail(ERR.REBUY_NOT_ALLOWED, 'between hands only');
    }
    if (!this.#wallet.debit(playerId, amount)) return fail(ERR.INSUFFICIENT_FUNDS);
    if (entry.status === 'seated') this.#table.topUp(entry.seat, amount);
    else entry.chips += amount;
    this.#publish();
    this.#scheduleStart();
    return ok();
  }

  /** Return from sitting out. */
  back(playerId) {
    const entry = this.#entry(playerId);
    if (!entry) return fail(ERR.NOT_SEATED);
    entry.sitoutRequested = false;
    entry.timeouts = 0;
    if (entry.status === 'sitout') entry.status = 'waiting';
    if (!this.#table.inHand) this.#reconcile();
    this.#publish();
    this.#scheduleStart();
    return ok();
  }

  /** A socket for this player (re)connected: resubscribe it and send everything it needs. */
  connect(playerId) {
    const entry = this.#entry(playerId);
    if (!entry) return;
    entry.connected = true;
    this.#cancelDrop(entry);
    this.#bus.subscribe(playerId, this.topic);
    this.#bus.send(playerId, { t: SERVER.SEATED, tableId: this.id, seat: entry.seat });
    this.#sendFullState(playerId);
    this.#publish();
  }

  /**
   * The player's socket closed. They keep their seat (turn timers fold for them) for a grace
   * period, then are removed and refunded so chips never sit at a table for an absent player.
   */
  disconnect(playerId) {
    const entry = this.#entry(playerId);
    if (!entry) return;
    entry.connected = false;
    this.#cancelDrop(entry);
    entry.dropTimer = this.#clock.setTimeout(() => this.#onDrop(playerId), this.#cfg.sitoutGraceMs);
    this.#publish();
  }

  #cancelDrop(entry) {
    if (entry.dropTimer) this.#clock.clearTimeout(entry.dropTimer);
    entry.dropTimer = null;
  }

  #onDrop(playerId) {
    const entry = this.#entry(playerId);
    if (this.#destroyed || !entry || entry.connected) return;
    entry.dropTimer = null;
    const dealtIn = this.#participants.includes(playerId);
    if (this.#table.inHand && entry.status === 'seated' && dealtIn) {
      entry.leaving = true; // removed (and refunded) when the hand ends
      this.#guard('drop', () => this.#autoActLeavers());
    } else {
      this.#remove(entry, 'timeout');
    }
    this.#publish();
  }

  /** Resend the full table state and this player's cards (client noticed a gap in `seq`). */
  sync(playerId) {
    if (!this.#entry(playerId)) return fail(ERR.NOT_SEATED);
    this.#sendFullState(playerId);
    return ok();
  }

  // ---- internals ---------------------------------------------------------------------------

  #entry(playerId) {
    const seat = this.#byPlayer.get(playerId);
    return seat === undefined ? null : this.#roster.get(seat);
  }

  #chipsOf(entry) {
    if (entry.status !== 'seated') return entry.chips;
    return this.#table.chipsAt(entry.seat) ?? 0;
  }

  #sendFullState(playerId) {
    this.#bus.send(playerId, {
      t: SERVER.TABLE,
      tableId: this.id,
      seq: this.#seq,
      state: this.#state(),
      events: [],
    });
    this.#sendCards(playerId);
  }

  #sendCards(playerId) {
    const cards = this.#hole.get(playerId);
    const entry = this.#entry(playerId);
    if (cards && entry && this.#table.inHand) {
      this.#bus.send(playerId, {
        t: SERVER.CARDS,
        tableId: this.id,
        handNo: this.#handNo,
        seat: entry.seat,
        cards,
      });
    }
  }

  // Take a player out of the roster, returning their chips to the wallet. Idle engine only for
  // seated players (the engine cannot unseat someone mid-hand).
  #remove(entry, reason) {
    this.#cancelDrop(entry);
    let chips = entry.chips;
    if (entry.status === 'seated') {
      chips = this.#table.chipsAt(entry.seat) ?? 0;
      if (this.#table.chipsAt(entry.seat) !== null) this.#table.standUp(entry.seat);
    }
    this.#wallet.credit(entry.playerId, chips);
    this.#roster.delete(entry.seat);
    this.#byPlayer.delete(entry.playerId);
    this.#hole.delete(entry.playerId);
    this.#bus.send(entry.playerId, { t: SERVER.UNSEATED, tableId: this.id, reason, chips });
    this.#bus.send(entry.playerId, {
      t: SERVER.BALANCE,
      balance: this.#wallet.balance(entry.playerId),
    });
    this.#bus.unsubscribe(entry.playerId, this.topic);
    this.#bus.subscribe(entry.playerId, LOBBY_TOPIC);
    this.#onSeat(entry.playerId, null);
  }

  // Bring the engine's seating in line with the roster. Only legal between hands.
  // Returns true if anything changed.
  #reconcile() {
    if (this.#table.inHand) throw new Error('reconcile during a hand');
    let changed = false;
    const busted = new Set(this.#table.bustedSeats());

    for (const entry of [...this.#roster.values()]) {
      if (entry.status === 'seated') {
        const gone = this.#table.chipsAt(entry.seat) === null;
        if (entry.leaving) {
          this.#remove(entry, 'left');
          changed = true;
        } else if (gone || busted.has(entry.seat)) {
          this.#remove(entry, 'busted');
          changed = true;
        } else if (entry.sitoutRequested) {
          entry.chips = this.#table.standUp(entry.seat);
          entry.status = 'sitout';
          changed = true;
        }
      } else if (entry.status === 'waiting' && entry.leaving) {
        this.#remove(entry, 'left');
        changed = true;
      }
    }

    for (const entry of this.#roster.values()) {
      if (entry.status === 'waiting' && !entry.sitoutRequested) {
        this.#table.sitDown(entry.seat, entry.chips);
        entry.chips = 0;
        entry.status = 'seated';
        changed = true;
      }
    }
    if (changed) this.#onChange();
    return changed;
  }

  #scheduleStart() {
    if (this.#destroyed || this.#startTimer !== null || this.#table.inHand) return;
    const playable = [...this.#roster.values()].filter(
      (e) => e.status !== 'sitout' && !e.leaving && this.#chipsOf(e) > 0,
    ).length;
    if (playable < 2) return;
    this.#startTimer = this.#clock.setTimeout(() => {
      this.#startTimer = null;
      this.#startHand();
    }, this.#cfg.interHandMs);
  }

  #startHand() {
    if (this.#destroyed || this.#table.inHand) return;
    this.#guard('start', () => this.#dealHand());
  }

  #dealHand() {
    this.#reconcile();
    if (!this.#table.canStartHand()) {
      this.#publish();
      return;
    }

    const handNo = this.#nextHandNo;
    const deck = this.#dealer.deal(handNo);
    this.#fair.current = this.#fair.next;
    this.#nextHandNo += 1;
    this.#fair.next = this.#dealer.commit(this.#nextHandNo); // published during this hand
    this.#handNo = handNo;

    const { events } = this.#table.startHand({ deck, handNo });
    this.#participants = [];
    this.#hole.clear();
    for (const seat of this.#table.playableSeats()) {
      const entry = this.#roster.get(seat);
      if (!entry) continue;
      this.#participants.push(entry.playerId);
      const cards = this.#table.snapshot(seat).seats[seat]?.cards;
      if (cards) this.#hole.set(entry.playerId, cards);
    }
    for (const playerId of this.#participants) this.#sendCards(playerId);
    this.#afterEngine(events);
  }

  // Everything that follows an engine step: settle the hand if it ended, otherwise arm the clock.
  #afterEngine(events) {
    this.#clearTurn();
    const ended = events.find((e) => e.type === 'hand-end');
    if (ended) {
      this.#publish(events);
      this.#onHandEnd(ended.result);
      return;
    }
    if (this.#autoActLeavers(events)) return;
    this.#armTurn();
    this.#publish(events);
  }

  // A leaving or repeatedly-timed-out player on the clock acts immediately instead of making the
  // table wait. Returns true if it took an action (which re-enters #afterEngine).
  #autoActLeavers(carried = []) {
    const seat = this.#table.toAct;
    if (seat === null) return false;
    const entry = this.#roster.get(seat);
    if (!entry || !(entry.leaving || entry.timeouts >= 2)) return false;
    const forced = this.#table.timeoutAction();
    const { events } = this.#table.act(seat, entry.leaving ? 'fold' : forced.action);
    this.#afterEngine([...carried, ...events]);
    return true;
  }

  #armTurn() {
    const seat = this.#table.toAct;
    if (seat === null) {
      this.#deadline = null;
      return;
    }
    this.#deadline = this.#clock.now() + this.#cfg.turnMs;
    this.#turnTimer = this.#clock.setTimeout(() => this.#onTurnTimeout(seat), this.#cfg.turnMs);
  }

  #clearTurn() {
    if (this.#turnTimer !== null) this.#clock.clearTimeout(this.#turnTimer);
    this.#turnTimer = null;
    this.#deadline = null;
  }

  #onTurnTimeout(seat) {
    this.#turnTimer = null;
    if (this.#destroyed || this.#table.toAct !== seat) return; // stale timer
    const entry = this.#roster.get(seat);
    const forced = this.#table.timeoutAction();
    if (entry) {
      entry.timeouts += 1;
      if (entry.timeouts >= 2) entry.sitoutRequested = true;
    }
    this.#guard('timeout', () => {
      const { events } = this.#table.act(seat, forced.action);
      this.#afterEngine(events);
    });
  }

  // ---- recovery ----------------------------------------------------------------------------

  #guard(label, fn) {
    try {
      return fn();
    } catch (error) {
      this.#recover(label, error);
      return undefined;
    }
  }

  // Something that should be impossible happened. Refunding the hand is always safe; trying to
  // carry on from an unknown state is not. Every player gets back what they started the hand
  // with, the table keeps running, and the failure is logged for the operator.
  #recover(label, error) {
    console.error(`[table ${this.id}] ${label} failed; aborting the hand`, error);
    try {
      this.#clearTurn();
      const handNo = this.#handNo;
      const { events } = this.#table.abortHand(`internal-error:${label}`);
      if (this.#fair.current) {
        this.#dealer.discard(handNo); // a hand that never finished has no proof to show
        this.#fair.current = null;
      }
      this.#hole.clear();
      this.#participants = [];
      this.#reconcile();
      this.#publish(events);
      this.#onChange();
      this.#scheduleStart();
    } catch (nested) {
      console.error(`[table ${this.id}] recovery failed`, nested);
    }
  }

  #onHandEnd(result) {
    const handNo = this.#handNo;
    this.#wallet.creditHouse(result.rake);

    // Reveal the seed to the players who were in the hand, with the cards actually dealt.
    this.#dealer.complete(handNo);
    const proof = { ...this.#dealer.reveal(handNo), dealt: this.#table.lastHand().dealt };
    for (const playerId of this.#participants) {
      this.#bus.send(playerId, { t: SERVER.PROOF, tableId: this.id, handNo, proof });
    }
    this.#fair.current = null;
    this.#hole.clear();
    this.#participants = [];

    this.#reconcile();
    this.#publish();
    this.#onChange();
    this.#scheduleStart();
  }

  // ---- state ------------------------------------------------------------------------------

  // Public table state: identical for every viewer, so it is serialised once and published to the
  // topic. It never carries hole cards; those travel privately as `cards` messages. `snapshot()`
  // is taken for the seat on the clock only to read its legal actions, and its `cards` are never
  // copied out.
  #state() {
    const snap = this.#table.snapshot(this.#table.toAct);
    const seats = Array.from({ length: this.#cfg.numSeats }, (_, seat) => {
      const entry = this.#roster.get(seat);
      if (!entry) return null;
      const live = entry.status === 'seated' ? snap.seats[seat] : null;
      return {
        seat,
        playerId: entry.playerId,
        name: entry.name,
        chips: live ? live.chips : entry.chips,
        bet: live ? live.bet : 0,
        folded: live ? live.folded : false,
        allIn: live ? live.allIn : false,
        hasCards: live ? live.hasCards : false,
        status: entry.status,
        connected: entry.connected,
      };
    });
    return {
      tableId: this.id,
      name: this.#cfg.name,
      handNo: this.#handNo || null,
      inHand: snap.inHand,
      button: snap.button,
      toAct: snap.toAct,
      round: snap.round,
      board: snap.board,
      pot: snap.pot,
      seats,
      legal: snap.legal,
      deadline: this.#deadline,
      fairness: { current: this.#fair.current, next: this.#fair.next },
    };
  }

  #publish(events = []) {
    this.#seq += 1;
    this.#bus.publish(this.topic, {
      t: SERVER.TABLE,
      tableId: this.id,
      seq: this.#seq,
      state: this.#state(),
      events,
    });
  }
}
