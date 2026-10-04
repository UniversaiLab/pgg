// PokerTable: a server-side wrapper around poker-ts that
//   - deals from a deck order we supply (so hands are committable and verifiable),
//   - validates turn order and bet sizes before touching poker-ts,
//   - drives the betting loop to the next decision, and settles each hand with rake,
//   - checks that no chip is created or destroyed.
//
// Chips are integers. Callers map them to token units (for example 1 chip = 1 micro-USDC).
// `amount` for bet/raise is the TOTAL bet for the round ("raise to"), exactly as poker-ts defines it.
//
// poker-ts keeps its deck private, so deck control reaches into `_table._deck`. poker-ts is pinned
// to an exact version, the hook fails loudly if the shape changes, and test/table.test.js asserts
// the dealt cards match the supplied deck.

import Poker from 'poker-ts';
import { CANONICAL_DECK, DECK_SIZE, isCardCode, RANKS, SUITS } from './fairness.js';
import { allocateRake, computeRake } from './rake.js';
import { settlePots } from './settle.js';

const STREETS = { 3: 'flop', 4: 'turn', 5: 'river' };
const CANONICAL_SET = new Set(CANONICAL_DECK);

const fromInternal = (card) => `${RANKS[card.rank]}${SUITS[card.suit]}`;
const fromFacade = (card) => `${card.rank}${card.suit[0]}`;
const sum = (values) => values.reduce((total, value) => total + value, 0);

export class IllegalActionError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'IllegalActionError';
    this.code = code;
  }
}

function assertChips(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}

export class PokerTable {
  #tableId;
  #numSeats;
  #rake;
  #poker;
  #plannedDeck = null;
  #deckOrder = [];
  #drawLog = [];
  #inHand = false;
  #handNo = null;
  #folded = new Set();
  #dealtIn = new Set();
  #startStacks = [];
  #boardLength = 0;
  #events = [];
  #lastHand = null;
  #ledger = { handsPlayed: 0, potVolume: 0, rakeTaken: 0, repairs: 0 };

  /**
   * @param {{ tableId: string, numSeats?: number, smallBlind: number, bigBlind: number,
   *   ante?: number, rake?: { bps: number, cap?: number, noFlopNoDrop?: boolean } }} options
   */
  constructor({ tableId, numSeats = 6, smallBlind, bigBlind, ante = 0, rake = { bps: 0 } }) {
    if (typeof tableId !== 'string' || tableId.length === 0)
      throw new TypeError('tableId required');
    if (!Number.isInteger(numSeats) || numSeats < 2 || numSeats > 10) {
      throw new RangeError('numSeats must be 2-10');
    }
    assertChips(smallBlind, 'smallBlind');
    assertChips(bigBlind, 'bigBlind');
    assertChips(ante, 'ante');
    if (bigBlind < smallBlind || bigBlind === 0) throw new RangeError('invalid blinds');
    computeRake({ pot: 0, sawFlop: true, ...rake }); // validate the rake config up front

    this.#tableId = tableId;
    this.#numSeats = numSeats;
    this.#rake = rake;
    this.#poker = new Poker.Table({ ante, bigBlind, smallBlind }, numSeats);
    this.#installDeckHooks();
  }

  get tableId() {
    return this.#tableId;
  }

  get numSeats() {
    return this.#numSeats;
  }

  get inHand() {
    return this.#inHand;
  }

  /** Running totals; Milestone 2 signs these into the escrow state. */
  ledger() {
    return { ...this.#ledger };
  }

  #installDeckHooks() {
    const deck = this.#poker._table?._deck;
    const ok =
      deck &&
      typeof deck.draw === 'function' &&
      typeof deck.shuffle === 'function' &&
      deck.length === DECK_SIZE;
    if (!ok) {
      throw new Error('poker-ts internals changed: cannot take over deck dealing (is it pinned?)');
    }
    const draw = deck.draw.bind(deck);
    deck.draw = () => {
      const card = draw();
      this.#drawLog.push(fromInternal(card));
      return card;
    };
    deck.shuffle = () => this.#arrangeDeck(deck);
  }

  // poker-ts draws from the END of its deck array, so draw #i must sit at index 51 - i.
  #arrangeDeck(deck) {
    if (!this.#plannedDeck) throw new Error('no deck supplied: use startHand({ deck })');
    // Plain loop: Deck extends Array, so deck.map() would call `new Deck(n)` and break.
    const byCode = new Map();
    for (let i = 0; i < deck.length; i++) byCode.set(fromInternal(deck[i]), deck[i]);
    if (byCode.size !== DECK_SIZE) throw new Error('poker-ts deck is not 52 distinct cards');
    for (let i = 0; i < DECK_SIZE; i++) deck[DECK_SIZE - 1 - i] = byCode.get(this.#plannedDeck[i]);
  }

  // ---- seating -----------------------------------------------------------------------------

  sitDown(seat, buyIn) {
    this.#assertIdle('sit down');
    this.#assertSeat(seat);
    assertChips(buyIn, 'buyIn');
    if (buyIn === 0) throw new RangeError('buyIn must be positive');
    if (this.#poker.seats()[seat]) throw new IllegalActionError('seat-taken');
    this.#poker.sitDown(seat, buyIn);
  }

  /** Remove a player between hands and return the chips they leave with. */
  standUp(seat) {
    this.#assertIdle('stand up');
    this.#assertSeat(seat);
    const player = this.#poker.seats()[seat];
    if (!player) throw new IllegalActionError('seat-empty');
    this.#poker.standUp(seat);
    return player.stack;
  }

  /** Add chips to a seated player between hands (rebuy / top-up). */
  topUp(seat, chips) {
    const stack = this.standUp(seat);
    this.sitDown(seat, stack + chips);
  }

  /** Seats holding chips: the ones that can be dealt in. */
  playableSeats() {
    return this.#poker
      .seats()
      .flatMap((player, seat) => (player && player.stack > 0 ? [seat] : []));
  }

  /** Seated players with no chips left (poker-ts would silently drop them at the next deal). */
  bustedSeats() {
    return this.#poker
      .seats()
      .flatMap((player, seat) => (player && player.stack === 0 ? [seat] : []));
  }

  canStartHand() {
    return !this.#inHand && this.playableSeats().length >= 2;
  }

  // ---- hand lifecycle ----------------------------------------------------------------------

  /**
   * Begin a hand using `deck` (52 card codes in draw order, e.g. from CommitRevealDealer.deal()).
   * @returns {{ events: object[] }}
   */
  startHand({ deck, handNo }) {
    this.#assertIdle('start a hand');
    if (!this.canStartHand()) throw new IllegalActionError('not-enough-players');
    if (!Number.isSafeInteger(handNo) || handNo < 0) throw new RangeError('invalid handNo');
    if (
      !Array.isArray(deck) ||
      deck.length !== DECK_SIZE ||
      !deck.every(isCardCode) ||
      new Set(deck).size !== DECK_SIZE ||
      !deck.every((code) => CANONICAL_SET.has(code))
    ) {
      throw new TypeError('deck must be 52 distinct valid card codes');
    }

    // Busted seats are removed explicitly so the caller sees it, not poker-ts silently.
    for (const seat of this.bustedSeats()) this.#poker.standUp(seat);

    this.#plannedDeck = deck;
    this.#deckOrder = [...deck];
    this.#drawLog = [];
    this.#handNo = handNo;
    this.#folded.clear();
    this.#events = [];
    this.#boardLength = 0;
    this.#startStacks = this.#poker.seats().map((player) => (player ? player.stack : 0));
    this.#dealtIn = new Set(this.playableSeats());
    try {
      this.#poker.startHand();
    } finally {
      this.#plannedDeck = null;
    }
    this.#inHand = true;
    this.#events.push({
      type: 'hand-start',
      handNo,
      button: this.#poker.button(),
      seats: this.#poker.handPlayers().flatMap((p, seat) => (p ? [seat] : [])),
    });
    this.#advance();
    return { events: this.#takeEvents() };
  }

  /**
   * Apply a player action. Throws IllegalActionError (with a stable `code`) for anything illegal;
   * a rejected action never changes table state.
   * @returns {{ events: object[] }}
   */
  act(seat, action, amount) {
    if (!this.#inHand || !this.#poker.isBettingRoundInProgress()) {
      throw new IllegalActionError('no-action-pending');
    }
    if (seat !== this.#poker.playerToAct()) throw new IllegalActionError('not-your-turn');
    const legal = this.#poker.legalActions();
    if (!legal.actions.includes(action)) throw new IllegalActionError('illegal-action');

    let size;
    if (action === 'bet' || action === 'raise') {
      const { min, max } = legal.chipRange;
      if (!Number.isSafeInteger(amount) || amount < min || amount > max) {
        throw new IllegalActionError('bad-amount', `amount must be an integer ${min}-${max}`);
      }
      size = amount;
    }

    this.#poker.actionTaken(action, size);
    if (action === 'fold') this.#folded.add(seat);
    this.#events.push({
      type: 'action',
      seat,
      action,
      ...(size === undefined ? {} : { amount: size }),
    });
    this.#advance();
    return { events: this.#takeEvents() };
  }

  /** What the clock should do when a player runs out of time: check if free, else fold. */
  timeoutAction() {
    if (!this.#inHand || !this.#poker.isBettingRoundInProgress()) return null;
    const { actions } = this.#poker.legalActions();
    return {
      seat: this.#poker.playerToAct(),
      action: actions.includes('check') ? 'check' : 'fold',
    };
  }

  #advance() {
    const poker = this.#poker;
    while (poker.isHandInProgress() && !poker.isBettingRoundInProgress()) {
      poker.endBettingRound();
      const board = poker.communityCards();
      if (board.length > this.#boardLength) {
        this.#boardLength = board.length;
        this.#events.push({
          type: 'street',
          round: STREETS[board.length],
          board: board.map(fromFacade),
        });
      }
      if (poker.areBettingRoundsCompleted()) {
        this.#settle();
        return;
      }
    }
  }

  // The hand is over: settle it ourselves (see settle.js for why), let poker-ts close its state
  // machine, then make the table's stacks match our settlement.
  #settle() {
    const poker = this.#poker;
    // seats() is the complete live view (folded and all-in players included); handPlayers() omits
    // anyone who can no longer act, so it cannot serve as a baseline. Copy: showdown mutates.
    const before = poker.seats().map((player) => (player ? { ...player } : null));
    const board = poker.communityCards().map(fromFacade);
    const live = [...this.#dealtIn].filter((seat) => !this.#folded.has(seat));
    if (live.length > 1 && board.length < 5) {
      // poker-ts forgets all-in players in the pots of later streets, then concludes nobody is
      // left to contest the pot and skips the rest of the board. Deal it ourselves from the same
      // committed deck, so the run-out is still covered by the fairness proof.
      const known = board.length;
      const next = this.#deckOrder.slice(this.#drawLog.length, this.#drawLog.length + 5 - known);
      board.push(...next);
      this.#drawLog.push(...next);
      for (const length of [3, 4, 5]) {
        if (known < length && length <= board.length) {
          this.#events.push({
            type: 'street',
            round: STREETS[length],
            board: board.slice(0, length),
          });
        }
      }
      this.#boardLength = board.length;
    }
    const holeCards = poker.holeCards();
    const enginePots = poker.pots();
    const button = poker.button();

    // Everything a seat has put in so far (stacks only fall during betting; bets are collected).
    const contributions = before.map((player, seat) =>
      player ? this.#startStacks[seat] - player.stack : 0,
    );
    const potTotal = sum(contributions);
    if (potTotal !== sum(enginePots.map((pot) => pot.size))) {
      throw new Error('contribution accounting disagrees with poker-ts pots');
    }

    const hole = new Map();
    for (const seat of this.#dealtIn) {
      if (!this.#folded.has(seat) && holeCards[seat])
        hole.set(seat, holeCards[seat].map(fromFacade));
    }
    const settled = settlePots({ contributions, folded: this.#folded, hole, board, button });

    const rake = computeRake({ pot: potTotal, sawFlop: board.length >= 3, ...this.#rake });
    const shares = allocateRake(settled.payouts, rake);
    const desired = before.map((player, seat) =>
      player ? player.stack + settled.payouts[seat] - shares[seat] : 0,
    );
    if (sum(desired) + rake !== sum(this.#startStacks))
      throw new Error('chip conservation violated');

    poker.showdown(); // ends poker-ts's hand; the stacks it computes are only a cross-check
    const engineWinners = poker.winners().map((pot) => pot.map(([seat]) => seat));
    const engineStacks = poker.seats().map((player) => (player ? player.stack : 0));

    // Make the table match our settlement. A seat poker-ts dropped as "busted" but who actually
    // won chips is seated again.
    let repaired = false;
    for (let seat = 0; seat < desired.length; seat++) {
      if (engineStacks[seat] !== desired[seat] + shares[seat] || shares[seat] > 0) {
        if (engineStacks[seat] !== desired[seat] + shares[seat]) repaired = true;
        if (poker.seats()[seat]) poker.standUp(seat);
        if (desired[seat] > 0) poker.sitDown(seat, desired[seat]);
      }
    }
    if (repaired) this.#ledger.repairs += 1;

    const finalStacks = poker.seats().map((player) => (player ? player.stack : 0));
    if (
      finalStacks.some((chips, seat) => chips !== desired[seat]) ||
      sum(finalStacks) + rake !== sum(this.#startStacks)
    ) {
      throw new Error('chip conservation violated');
    }

    const contenders = [...new Set(settled.pots.flatMap((pot) => pot.eligible))].sort(
      (a, b) => a - b,
    );
    const result = {
      handNo: this.#handNo,
      board,
      pot: potTotal,
      rake,
      pots: settled.pots,
      // What each player received from the pot, before and after rake.
      payouts: settled.payouts.flatMap((amount, seat) =>
        amount > 0 ? [{ seat, gross: amount, rake: shares[seat], net: amount - shares[seat] }] : [],
      ),
      // Only a real showdown turns cards face up; a fold-out reveals nothing.
      reveals:
        contenders.length > 1 ? contenders.map((seat) => ({ seat, cards: hole.get(seat) })) : [],
      stacks: finalStacks,
      // Seats left with no chips; the caller decides between rebuy and standing them up.
      busted: finalStacks.flatMap((chips, seat) => (before[seat] && chips === 0 ? [seat] : [])),
      // How poker-ts settled the same hand, kept so tests and operators can see disagreements.
      audit: { repaired, enginePots, engineWinners, engineStacks },
    };

    this.#ledger.handsPlayed += 1;
    this.#ledger.potVolume += potTotal;
    this.#ledger.rakeTaken += rake;
    this.#lastHand = { handNo: this.#handNo, dealt: [...this.#drawLog], result };
    this.#inHand = false;
    this.#events.push({ type: 'hand-end', result });
  }

  #takeEvents() {
    const events = this.#events;
    this.#events = [];
    return events;
  }

  // ---- views -------------------------------------------------------------------------------

  /**
   * Table state as one seat may see it. Only `forSeat`'s own hole cards are included; pass null
   * for a spectator view. Safe to serialise and send to that seat's socket.
   */
  snapshot(forSeat = null) {
    const poker = this.#poker;
    const inHand = this.#inHand;
    const players = poker.seats(); // live and complete; see the note in #settle
    const betting = inHand && poker.isBettingRoundInProgress();
    const toAct = betting ? poker.playerToAct() : null;
    const hole = inHand ? poker.holeCards() : [];
    const live = (seat) => inHand && this.#dealtIn.has(seat) && !this.#folded.has(seat);
    const maxBet = Math.max(0, ...players.map((p, seat) => (p && live(seat) ? p.betSize : 0)));

    const seats = players.map((player, seat) => {
      if (!player) return null;
      return {
        seat,
        chips: player.stack,
        bet: inHand ? player.betSize : 0,
        folded: inHand && this.#folded.has(seat),
        allIn: live(seat) && player.stack === 0,
        cards: seat === forSeat && live(seat) && hole[seat] ? hole[seat].map(fromFacade) : null,
        hasCards: live(seat),
      };
    });

    let legal = null;
    if (betting && forSeat !== null && forSeat === toAct) {
      const { actions, chipRange } = poker.legalActions();
      const me = players[forSeat];
      legal = {
        actions,
        toCall: Math.min(me.stack, Math.max(0, maxBet - me.betSize)),
        ...(chipRange ? { min: chipRange.min, max: chipRange.max } : {}),
      };
    }

    return {
      tableId: this.#tableId,
      handNo: this.#handNo,
      inHand,
      button: inHand ? poker.button() : null,
      toAct,
      round: inHand ? poker.roundOfBetting() : null,
      board: inHand ? poker.communityCards().map(fromFacade) : (this.#lastHand?.result.board ?? []),
      pot: inHand
        ? sum(poker.pots().map((pot) => pot.size)) + sum(players.map((p) => (p ? p.betSize : 0)))
        : 0,
      seats,
      legal,
    };
  }

  /** The last finished hand: cards drawn in order plus the result. Pair with Dealer.reveal(). */
  lastHand() {
    return this.#lastHand;
  }

  // ---- guards ------------------------------------------------------------------------------

  #assertIdle(what) {
    if (this.#inHand)
      throw new IllegalActionError('hand-in-progress', `cannot ${what} during a hand`);
  }

  #assertSeat(seat) {
    if (!Number.isInteger(seat) || seat < 0 || seat >= this.#numSeats) {
      throw new RangeError(`seat must be 0-${this.#numSeats - 1}`);
    }
  }
}
