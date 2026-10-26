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
//
// Vault mode (docs/signing-layer.md section 4): with an injected `vault` (the table's VaultCoordinator)
// the money is escrowed on chain. Seats are claimed, never bought; nobody is ever removed by the actor
// (the contract cannot drop a roster member), so leavers, busted and absent players are only parked;
// chips leave only when the coordinator reports the chain paid them out (vaultHost.unseat); and no
// hand is dealt unless the coordinator's deal gate is open. Play tables have no vault and none of this
// code runs for them.

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

  #vault = null; // the VaultCoordinator of a vault table; null at a play table
  #vaultInfo = null; // { chainId, vault, maxRakeBps, exitWindowSec, arbiter } for the lobby summary
  #vaultHost = null;
  #held = null; // private vault messages held back until the public state they depend on is out

  /**
   * @param {{ cfg: object, bus: object, wallet: object, clock?: object,
   *   onChange?: () => void, onSeat?: (playerId: string, tableId: string | null) => void,
   *   vault?: object, vaultInfo?: object }} deps
   *   vault      the table's VaultCoordinator (vault tables only); attach `vaultHost` as its host
   *   vaultInfo  { chainId, vault, maxRakeBps, exitWindowSec, arbiter }: what the lobby shows of the vault
   */
  constructor({
    cfg,
    bus,
    wallet,
    clock = realClock,
    onChange = () => {},
    onSeat = () => {},
    createTable = defaultTable, // tests inject a faulty table to exercise recovery
    vault = null,
    vaultInfo = null,
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
    if (vault) {
      this.#vault = vault;
      this.#vaultInfo = vaultInfo;
      // What the coordinator may ask of this table (coordinator.js, `host`). A separate object, because
      // the coordinator's seatOf takes an address where the actor's own seatOf takes a player id.
      this.#vaultHost = Object.freeze({
        send: (playerId, msg) => this.#vaultSend(playerId, msg),
        publishStatus: () => this.#vaultStatus(),
        unseat: (address, info) => this.#vaultUnseat(address, info),
        scheduleStart: () => this.#scheduleStart(),
        rekey: (oldId, newId, address) => this.#rekey(oldId, newId, address),
        inHand: () => this.#table.inHand,
        seatOf: (address) => this.#entryByAddress(address)?.seat ?? null,
      });
    }
  }

  get id() {
    return this.#cfg.id;
  }

  get topic() {
    return `table:${this.#cfg.id}`;
  }

  /** True at a vault table (the Hub routes claim and sig only to these). */
  get isVault() {
    return this.#vault !== null;
  }

  /** The host to attach to this table's coordinator (runtime.attachHost); null at a play table. */
  get vaultHost() {
    return this.#vaultHost;
  }

  summary() {
    const c = this.#cfg;
    const summary = {
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
    if (this.#vault) {
      const vault = this.#vaultSummary();
      if (vault) summary.vault = vault;
    }
    return summary;
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
    if (this.#vault) return fail(ERR.VAULT_LOCKED, 'a vault seat is claimed, not bought');
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
    if (this.#vault) return this.#vaultLeave(playerId);
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
    if (this.#vault) return fail(ERR.VAULT_LOCKED, 'chips at a vault table come from the deposit');
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
    // after the table state: the epoch, the newest bundle, then the open signreq
    this.#vault?.onConnect(playerId);
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
    if (this.#vault) {
      // The contract cannot drop a roster member, so the seat stays: the player is only away, which
      // closes the deal gate until they are back (or the table stalls out, section 6).
      this.#vault.onDisconnect(playerId);
      this.#publish();
      return;
    }
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

  // ---- vault tables ------------------------------------------------------------------------

  /**
   * A member proves with the seat's session key which on-chain seat is theirs (section 3). The
   * coordinator decides who the members are; the actor gives a new member a seat, or moves the seat
   * an address already holds to this player id.
   */
  claim(player, { address, sig } = {}) {
    if (!this.#vault) return fail(ERR.NOT_VAULT_TABLE);
    const owner = this.#hold();
    try {
      const result = this.#vault.claim(player.id, { address, sig });
      if (!result?.ok) return result ?? fail(ERR.VAULT_LOCKED);
      return this.#seatMember(player, result);
    } finally {
      this.#release(owner);
    }
  }

  /** A member's signature for a signreq. */
  vaultSign(player, { nonce, digest, sig } = {}) {
    if (!this.#vault) return fail(ERR.NOT_VAULT_TABLE);
    if (!this.#entry(player.id)) return fail(ERR.NOT_SEATED);
    return this.#vault.sign(player.id, { nonce, digest, sig });
  }

  #seatMember(player, { address, chips }) {
    let entry = this.#entryByAddress(address);
    if (entry && entry.playerId !== player.id) this.#rekey(entry.playerId, player.id, address);
    if (entry) {
      entry.name = player.name;
      entry.connected = true;
      this.#cancelDrop(entry);
    } else {
      const seat = [...Array(this.#cfg.numSeats).keys()].find((s) => !this.#roster.has(s));
      // cannot happen while the vault's maxPlayers is numSeats; refuse rather than drop a member
      if (seat === undefined) return fail(ERR.TABLE_FULL);
      entry = {
        playerId: player.id,
        name: player.name,
        seat,
        address: String(address).toLowerCase(),
        chips, // the member's balance in the newest state (or the deposit before the epoch starts)
        status: 'waiting',
        connected: true,
        leaving: false,
        sitoutRequested: false,
        timeouts: 0,
        dropTimer: null,
      };
      this.#roster.set(seat, entry);
      this.#byPlayer.set(player.id, seat);
    }
    this.#bus.subscribe(player.id, this.topic);
    this.#bus.unsubscribe(player.id, LOBBY_TOPIC);
    this.#onSeat(player.id, this.id);
    this.#bus.send(player.id, { t: SERVER.SEATED, tableId: this.id, seat: entry.seat });
    if (!this.#table.inHand) this.#reconcile();
    this.#publish();
    this.#onChange();
    this.#scheduleStart();
    this.#sendCards(player.id);
    return ok({ seat: entry.seat });
  }

  // Leaving a vault table is a request: the coordinator folds it into the next final, and the chips
  // leave when the chain settles it. Nothing is refunded here.
  #vaultLeave(playerId) {
    const entry = this.#entry(playerId);
    if (!entry) return fail(ERR.NOT_SEATED);
    const owner = this.#hold();
    try {
      const result = this.#vault.requestLeave(playerId);
      if (!result?.ok) return result ?? fail(ERR.VAULT_LOCKED);
      entry.leaving = true;
      const dealtIn = this.#participants.includes(playerId);
      if (this.#table.inHand && entry.status === 'seated' && dealtIn) {
        this.#guard('leave', () => this.#autoActLeavers()); // folds now if it is their turn
      } else if (!this.#table.inHand) {
        this.#reconcile();
      }
      this.#publish();
      return ok({ head: String(result.head) });
    } finally {
      this.#release(owner);
    }
  }

  #entryByAddress(address) {
    const wanted = String(address).toLowerCase();
    for (const entry of this.#roster.values()) if (entry.address === wanted) return entry;
    return null;
  }

  // Private messages the coordinator sends while a claim or a leave is being handled wait until the
  // seat and the public state are out, so a client never gets a signreq for a table it has not seen.
  #hold() {
    if (this.#held !== null) return false;
    this.#held = [];
    return true;
  }

  #release(owner) {
    if (!owner) return;
    const held = this.#held;
    this.#held = null;
    for (const [playerId, msg] of held) this.#bus.send(playerId, msg);
  }

  #vaultSend(playerId, msg) {
    if (msg?.t === SERVER.EPOCH) this.#adoptEpochBase(msg);
    if (this.#held !== null) this.#held.push([playerId, msg]);
    else this.#bus.send(playerId, msg);
  }

  // The first state of an epoch is the chain's deposits. A member may have topped up after claiming
  // while the table was filling, so the stacks follow the genesis; otherwise the first hand's state
  // would not add up and the table would halt. Only while the genesis is still the newest state.
  #adoptEpochBase(msg) {
    if (this.#table.inHand) return;
    try {
      if (String(msg.state.nonce) !== this.#vault.publicView().nonce) return;
      let changed = false;
      msg.state.players.forEach((address, i) => {
        const entry = this.#entryByAddress(address);
        const chips = Number(BigInt(msg.state.balances[i]) / this.#cfg.chipUnit);
        if (!entry || this.#chipsOf(entry) === chips) return;
        if (entry.status === 'seated') {
          this.#table.standUp(entry.seat);
          entry.status = 'waiting';
        }
        entry.chips = chips;
        changed = true;
      });
      if (!changed) return;
      this.#reconcile();
      this.#publish();
    } catch (error) {
      console.error(`[table ${this.id}] could not adopt the epoch's stacks`, error);
    }
  }

  #vaultStatus() {
    if (this.#destroyed) return;
    this.#publish();
    this.#onChange();
  }

  // The chain paid this seat out (Settled, Left, or the table closed): only now do the chips leave.
  // A hand still in flight can no longer be signed into a state, so it is abandoned like an aborted
  // hand (everyone keeps the stack they started it with).
  #vaultUnseat(address, { reason = 'settled', chips = 0 } = {}) {
    const entry = this.#entryByAddress(address);
    if (this.#destroyed || !entry) return;
    if (this.#table.inHand) this.#abandonHand(`vault-${reason}`);
    this.#cancelDrop(entry);
    if (entry.status === 'seated' && this.#table.chipsAt(entry.seat) !== null) {
      this.#table.standUp(entry.seat);
    }
    this.#roster.delete(entry.seat);
    this.#byPlayer.delete(entry.playerId);
    this.#hole.delete(entry.playerId);
    // no BALANCE message: the payout is on chain, and the play-money balance is a different account
    this.#bus.send(entry.playerId, {
      t: SERVER.UNSEATED,
      tableId: this.id,
      reason,
      chips: Number(chips) || 0,
    });
    this.#bus.unsubscribe(entry.playerId, this.topic);
    this.#bus.subscribe(entry.playerId, LOBBY_TOPIC);
    this.#onSeat(entry.playerId, null);
    this.#publish();
    this.#onChange();
  }

  // A newer valid claim moved this seat to another player id (dev-login ids change on every login).
  #rekey(oldId, newId, address) {
    const entry = this.#entryByAddress(address);
    if (!entry || entry.playerId !== oldId || oldId === newId) return;
    entry.playerId = newId;
    this.#byPlayer.delete(oldId);
    this.#byPlayer.set(newId, entry.seat);
    const cards = this.#hole.get(oldId);
    this.#hole.delete(oldId);
    if (cards) this.#hole.set(newId, cards);
    this.#participants = this.#participants.map((id) => (id === oldId ? newId : id));
    this.#bus.unsubscribe(oldId, this.topic);
    this.#bus.subscribe(oldId, LOBBY_TOPIC);
    this.#onSeat(oldId, null);
    this.#onSeat(newId, this.id);
  }

  #abandonHand(reason) {
    this.#clearTurn();
    const { events } = this.#table.abortHand(reason);
    if (this.#fair.current) {
      this.#dealer.discard(this.#handNo);
      this.#fair.current = null;
    }
    this.#hole.clear();
    this.#participants = [];
    this.#publish(events);
  }

  // What the coordinator builds the hand's state from: every member's stack, the waiting and the
  // sitting out included (the engine's result.stacks covers only the seats it dealt in).
  #vaultSnapshot(handNo, result) {
    return {
      handNo,
      result: { pot: result.pot, rake: result.rake },
      entries: [...this.#roster.values()].map((entry) => ({
        address: entry.address,
        chips: this.#chipsOf(entry),
        leaving: entry.leaving,
        connected: entry.connected,
        status: entry.status,
        seat: entry.seat,
      })),
    };
  }

  #vaultSummary() {
    const tableKey = this.#vault.tableKey;
    const info = this.#vaultInfo;
    if (!tableKey || !info) return null;
    return {
      chainId: Number(info.chainId),
      vault: info.vault,
      tableKey,
      chipUnit: String(this.#cfg.chipUnit),
      maxRakeBps: Number(info.maxRakeBps),
      exitWindowSec: Number(info.exitWindowSec),
      arbiter: info.arbiter,
      // the lobby shows whether deposits are open (the contract takes them only while the table is filling)
      phase: this.#vault.phase,
    };
  }

  // Vault mode's #reconcile. Chips never leave here: a leaver, a busted player and anyone sitting out
  // are stood up from the engine and keep their stack in the roster entry, because they stay members
  // of the epoch (they sign its states, the final included) until the chain pays them (#vaultUnseat).
  #park() {
    let changed = false;
    for (const entry of this.#roster.values()) {
      if (entry.status === 'seated') {
        const chips = this.#table.chipsAt(entry.seat);
        if (chips === null || chips === 0 || entry.leaving || entry.sitoutRequested) {
          entry.chips = chips === null ? 0 : this.#table.standUp(entry.seat);
          entry.status = 'sitout';
          changed = true;
        }
      } else if (entry.status === 'waiting' && (entry.leaving || entry.chips === 0)) {
        entry.status = 'sitout';
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
    if (this.#vault) return this.#park();
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
    // the deal gate (S1): nothing is dealt while a round is open, a member is away or unclaimed, or
    // the epoch is ending; the coordinator calls scheduleStart again when it opens
    if (this.#vault && !this.#vault.canDeal()) return;
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
    if (this.#vault && !this.#vault.canDeal()) return; // the gate closed after the start was scheduled
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

    if (this.#vault) {
      // The state is built from the stacks before anyone is parked; the signreqs go out only after the
      // public state, because each client judges a signreq against the stacks it has seen (F8).
      this.#vault.onHandEnd(this.#vaultSnapshot(handNo, result));
      this.#reconcile();
      this.#publish();
      this.#vault.flush();
      this.#onChange();
      this.#scheduleStart();
      return;
    }

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
        ...(this.#vault ? { address: entry.address } : {}),
      };
    });
    const state = {
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
    if (this.#vault) state.vault = this.#vault.publicView();
    return state;
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
