import { SERVER } from '@pgg/protocol/constants';
import { PlayMoneyWallet } from '../src/wallet.js';

/** Deterministic clock: timers only fire when the test calls advance(). */
export class FakeClock {
  t = 1_700_000_000_000;
  #timers = [];
  #nextId = 0;

  now() {
    return this.t;
  }

  setTimeout(fn, ms) {
    const id = ++this.#nextId;
    this.#timers.push({ id, at: this.t + ms, fn });
    return id;
  }

  clearTimeout(id) {
    this.#timers = this.#timers.filter((timer) => timer.id !== id);
  }

  get pending() {
    return this.#timers.length;
  }

  advance(ms) {
    const end = this.t + ms;
    for (;;) {
      const due = this.#timers
        .filter((timer) => timer.at <= end)
        .sort((a, b) => a.at - b.at || a.id - b.id);
      if (due.length === 0) break;
      const next = due[0];
      this.#timers = this.#timers.filter((timer) => timer.id !== next.id);
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}

/** Records everything the actor emits. Messages are cloned, as if they had crossed the wire. */
export class FakeBus {
  published = [];
  sent = new Map();
  subscriptions = new Map();

  publish(topic, msg) {
    this.published.push({ topic, msg: JSON.parse(JSON.stringify(msg)) });
  }

  send(playerId, msg) {
    if (!this.sent.has(playerId)) this.sent.set(playerId, []);
    this.sent.get(playerId).push(JSON.parse(JSON.stringify(msg)));
  }

  subscribe(playerId, topic) {
    if (!this.subscriptions.has(playerId)) this.subscriptions.set(playerId, new Set());
    this.subscriptions.get(playerId).add(topic);
  }

  unsubscribe(playerId, topic) {
    this.subscriptions.get(playerId)?.delete(topic);
  }

  /** Latest public table message. */
  get latest() {
    return this.published.findLast((entry) => entry.msg.t === SERVER.TABLE)?.msg;
  }

  get state() {
    return this.latest?.state;
  }

  messagesTo(playerId, type) {
    return (this.sent.get(playerId) ?? []).filter((msg) => msg.t === type);
  }

  /** All events published so far, flattened. */
  get events() {
    return this.published.flatMap((entry) =>
      entry.msg.t === SERVER.TABLE ? entry.msg.events : [],
    );
  }
}

export const CFG = Object.freeze({
  id: 'test-1',
  name: 'Test 5/10',
  numSeats: 6,
  smallBlind: 5,
  bigBlind: 10,
  minBuyIn: 100,
  maxBuyIn: 1000,
  rakeBps: 300,
  rakeCap: 30,
  turnMs: 1000,
  interHandMs: 100,
  sitoutGraceMs: 5000,
});

export const player = (n) => ({ id: `p${n}`, name: `Player ${n}` });

export function setup(overrides = {}, { startBalance = 10_000 } = {}) {
  const clock = new FakeClock();
  const bus = new FakeBus();
  const wallet = new PlayMoneyWallet({ startBalance });
  return { clock, bus, wallet, cfg: { ...CFG, ...overrides } };
}

/** Sum of all chips in the system; must always equal wallet.issued. */
export function totalChips(wallet, ...actors) {
  return wallet.held + actors.reduce((sum, actor) => sum + actor.chipsOnTable(), 0);
}
