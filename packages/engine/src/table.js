// PokerTable: a server-side wrapper that uses poker-ts ONLY as a betting state machine.
//
//   poker-ts decides: whose turn it is, which actions and bet sizes are legal, when a street ends.
//   We decide:        who sits where and with how many chips, the dealer button, the deck order
//                     (so hands are committable and verifiable), the pots, the winners, the rake,
//                     and every stack after the hand.
//
// Why so little is left to poker-ts: 1.5.0 mishandles settlement (see settle.js and
// docs/architecture.md), and its showdown() contains loops that never terminate on some inputs
// (observed as a frozen server). So a fresh poker-ts table is built for every hand and thrown away
// afterwards, and showdown() is never called.
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
  #forcedBets;

  #stacks; // seat -> chips, or null for an empty seat. Authoritative between hands.
  #button = null; // seat of the most recent dealer button

  #poker = null; // a poker-ts table, alive only for the hand in progress
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
  #ledger = { handsPlayed: 0, potVolume: 0, rakeTaken: 0, aborted: 0 };

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
    this.#forcedBets = { ante, bigBlind, smallBlind };
    this.#stacks = new Array(numSeats).fill(null);
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

  /** Seat on the clock, or null between decisions. Cheaper than building a snapshot. */
  get toAct() {
    return this.#inHand && this.#poker.isBettingRoundInProgress()
      ? this.#poker.playerToAct()
      : null;
  }

  /**
   * Every chip at this table, including the ones in play. Constant between hands and throughout one
   * (rake leaves only at settlement), so it is the thing to assert on after every action.
   *
   * Stacks are untouched while a hand runs (poker-ts holds the in-hand chips), so this is simply their
   * sum. It is deliberately not read from poker-ts's seats and pots: after a fold on a later street
   * poker-ts parks the folder's bet where neither `seats()` nor `pots()` shows it until the betting
   * round is collected. poker-ts's own books are cross-checked where they are complete, at the end of
   * every betting round (`#checkCollected`) and again at settlement.
   */
  totalChips() {
    return sum(this.#stacks.map((chips) => chips ?? 0));
  }

  /** Chips held by a seat (not counting bets already on the felt), or null if the seat is empty. */
  chipsAt(seat) {
    this.#assertSeat(seat);
    if (this.#inHand) return this.#poker.seats()[seat]?.stack ?? null;
    return this.#stacks[seat];
  }

  /** Running totals; Milestone 2 signs these into the escrow state. */
  ledger() {
    return { ...this.#ledger };
  }

  #installDeckHooks(poker) {
    const deck = poker._table?._deck;
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
    if (this.#stacks[seat] !== null) throw new IllegalActionError('seat-taken');
    this.#stacks[seat] = buyIn;
  }

  /** Remove a player between hands and return the chips they leave with. */
  standUp(seat) {
    this.#assertIdle('stand up');
    this.#assertSeat(seat);
    const chips = this.#stacks[seat];
    if (chips === null) throw new IllegalActionError('seat-empty');
    this.#stacks[seat] = null;
    return chips;
  }

  /** Add chips to a seated player between hands (rebuy / top-up). */
  topUp(seat, chips) {
    this.#assertIdle('top up');
    this.#assertSeat(seat);
    assertChips(chips, 'chips');
    if (this.#stacks[seat] === null) throw new IllegalActionError('seat-empty');
    this.#stacks[seat] += chips;
  }

  /** Seats holding chips: the ones that can be dealt in. */
  playableSeats() {
    return this.#stacks.flatMap((chips, seat) => (chips !== null && chips > 0 ? [seat] : []));
  }

  /** Seated players with no chips left. */
  bustedSeats() {
    return this.#stacks.flatMap((chips, seat) => (chips === 0 ? [seat] : []));
  }

  canStartHand() {
    return !this.#inHand && this.playableSeats().length >= 2;
  }

  // The seat after the previous button that has chips, wrapping; the first such seat for hand one.
  #nextButton(playable) {
    if (this.#button === null) return playable[0];
    return playable.find((seat) => seat > this.#button) ?? playable[0];
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

    // Seats left with no chips are removed explicitly so the caller sees it.
    for (const seat of this.bustedSeats()) this.#stacks[seat] = null;
    const playable = this.playableSeats();

    const poker = new Poker.Table(this.#forcedBets, this.#numSeats);
    for (const seat of playable) poker.sitDown(seat, this.#stacks[seat]);
    this.#installDeckHooks(poker);

    this.#plannedDeck = deck;
    this.#deckOrder = [...deck];
    this.#drawLog = [];
    this.#handNo = handNo;
    this.#folded.clear();
    this.#events = [];
    this.#boardLength = 0;
    this.#startStacks = this.#stacks.map((chips) => chips ?? 0);
    this.#dealtIn = new Set(playable);
    const button = this.#nextButton(playable);
    try {
      poker.startHand(button);
    } finally {
      this.#plannedDeck = null;
    }
    this.#poker = poker;
    this.#button = button;
    this.#inHand = true;
    this.#events.push({ type: 'hand-start', handNo, button, seats: playable });
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

  /**
   * Cancel the hand in progress and give every player back what they started it with. For use
   * when something that should be impossible has happened: refunding is always safe, whereas
   * guessing at a settlement is not.
   * @returns {{ events: object[] }}
   */
  abortHand(reason = 'aborted') {
    if (!this.#inHand) return { events: [] };
    // #stacks is untouched during a hand (poker-ts holds the in-hand chips), so dropping the
    // poker-ts table is all it takes to restore everyone's stack.
    this.#poker = null;
    this.#inHand = false;
    this.#ledger.aborted += 1;
    this.#lastHand = null;
    return { events: [{ type: 'hand-aborted', handNo: this.#handNo, reason }] };
  }

  #advance() {
    const poker = this.#poker;
    while (poker.isHandInProgress() && !poker.isBettingRoundInProgress()) {
      poker.endBettingRound();
      this.#checkCollected();
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

  // Everything each seat has put in so far this hand: the stack it started with less what it still
  // holds (stacks only fall during betting). This is exact at every moment, which poker-ts's own
  // pots and bets are not: a folded bet is parked out of sight until the round is collected.
  #contributions(players) {
    return players.map((player, seat) => (player ? this.#startStacks[seat] - player.stack : 0));
  }

  // Between betting rounds every bet has been collected, so poker-ts's books must add up exactly.
  // If they do not, something is wrong inside poker-ts and the caller aborts and refunds the hand.
  #checkCollected() {
    const poker = this.#poker;
    const held = sum(poker.seats().map((player) => (player ? player.totalChips : 0)));
    const pots = sum(poker.pots().map((pot) => pot.size));
    if (held + pots !== sum(this.#startStacks)) {
      throw new Error('poker-ts chip accounting broke between betting rounds');
    }
  }

  // The betting is over. Everything from here is ours: poker-ts is only read, never asked to pay.
  #settle() {
    const poker = this.#poker;
    // seats() is the complete live view (folded and all-in players included); handPlayers() omits
    // anyone who can no longer act, so it cannot serve as a baseline.
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
    const button = poker.button();

    const contributions = this.#contributions(before);
    const potTotal = sum(contributions);
    if (potTotal !== sum(poker.pots().map((pot) => pot.size))) {
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
    const finalStacks = before.map((player, seat) =>
      player ? player.stack + settled.payouts[seat] - shares[seat] : 0,
    );
    if (sum(finalStacks) + rake !== sum(this.#startStacks)) {
      throw new Error('chip conservation violated');
    }

    // Seats that played keep their place even at zero (the caller removes busted players); empty
    // seats stay empty.
    this.#stacks = this.#stacks.map((chips, seat) => (chips === null ? null : finalStacks[seat]));
    this.#poker = null;
    this.#inHand = false;

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
    };

    this.#ledger.handsPlayed += 1;
    this.#ledger.potVolume += potTotal;
    this.#ledger.rakeTaken += rake;
    this.#lastHand = { handNo: this.#handNo, dealt: [...this.#drawLog], result };
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
    const players = inHand
      ? poker.seats() // live and complete; see the note in #settle
      : this.#stacks.map((chips) => (chips === null ? null : { stack: chips, betSize: 0 }));
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
        // poker-ts reports a range even when neither bet nor raise is legal (a short stack facing a
        // bigger bet can only call or fold); only expose it when it can be used.
        ...(chipRange && (actions.includes('bet') || actions.includes('raise'))
          ? { min: chipRange.min, max: chipRange.max }
          : {}),
      };
    }

    return {
      tableId: this.#tableId,
      handNo: this.#handNo,
      inHand,
      button: this.#button,
      toAct,
      round: inHand ? poker.roundOfBetting() : null,
      board: inHand ? poker.communityCards().map(fromFacade) : (this.#lastHand?.result.board ?? []),
      pot: inHand ? sum(this.#contributions(players)) : 0,
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
