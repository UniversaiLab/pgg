// A scripted WebSocket client used by the end-to-end tests and the load script.
// It speaks the real protocol, validates every message the server sends against the schema, and
// plays on its own with a seeded strategy so runs are repeatable.

import { ServerMessage } from '@pgg/protocol';
import { CLIENT, SERVER } from '@pgg/protocol/constants';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(condition, { timeout = 10_000, every = 5, what = 'condition' } = {}) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}

export class Bot {
  constructor({
    httpUrl,
    wsUrl,
    name,
    seed = 1,
    validate = true,
    aggression = 25,
    thinkMs = 0,
    rejoin = null,
  }) {
    this.httpUrl = httpUrl;
    this.wsUrl = wsUrl;
    this.name = name;
    this.validate = validate;
    this.aggression = aggression;
    this.thinkMs = thinkMs; // pause before acting, like a person (and under the rate limit)
    this.rejoin = rejoin; // { tableId, buyIn }: sit back down after busting
    this.rng = seed;
    this.log = [];
    this.invalid = [];
    this.state = null;
    this.hole = new Map(); // handNo -> [card, card]
    this.proofs = [];
    this.errors = [];
    this.balance = null;
    this.seat = null;
    this.tableId = null;
    this.autoplay = false;
    this.closeCode = null;
    this.latencies = [];
    this.handsEnded = 0;
    this.busts = 0;
    this.actionsSent = 0;
    this.#pending = null;
    this.lastActed = null;
  }

  #pending;

  #rand(n) {
    this.rng = (this.rng * 1103515245 + 12345) % 2147483648;
    return this.rng % n;
  }

  async login(token) {
    const response = await fetch(`${this.httpUrl}/api/dev-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(token ? { token } : { name: this.name }),
    });
    if (!response.ok) throw new Error(`login failed: ${response.status}`);
    const body = await response.json();
    this.token = body.token;
    this.id = body.player.id;
    this.balance = body.player.balance;
    return body;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.closeCode = null;
      this.ws = new WebSocket(`${this.wsUrl}?token=${encodeURIComponent(this.token)}`);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (event) =>
        reject(new Error(`websocket error: ${event.message ?? 'failed'}`));
      this.ws.onmessage = (event) => this.#onMessage(JSON.parse(event.data));
      this.ws.onclose = (event) => {
        this.closeCode = event.code;
      };
    });
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(message) {
    this.ws.send(JSON.stringify(message));
  }

  join(tableId, buyIn, seat) {
    this.send({ t: CLIENT.JOIN, tableId, buyIn, ...(seat === undefined ? {} : { seat }) });
  }

  async leave() {
    this.autoplay = false;
    this.rejoin = null;
    if (!this.connected || this.tableId === null) return;
    this.send({ t: CLIENT.LEAVE });
    await until(() => this.tableId === null, {
      what: `${this.name} to be unseated`,
      timeout: 15_000,
    });
  }

  close() {
    this.autoplay = false;
    this.ws?.close();
  }

  #onMessage(msg) {
    this.onMessageHook?.(msg);
    this.log.push(msg);
    if (this.validate) {
      const parsed = ServerMessage.safeParse(msg);
      if (!parsed.success) this.invalid.push({ msg, issues: parsed.error.issues });
    }
    switch (msg.t) {
      case SERVER.WELCOME:
        this.balance = msg.player.balance;
        if (msg.seated) {
          this.tableId = msg.seated.tableId;
          this.seat = msg.seated.seat;
        }
        break;
      case SERVER.SEATED:
        this.tableId = msg.tableId;
        this.seat = msg.seat;
        break;
      case SERVER.UNSEATED:
        this.tableId = null;
        this.seat = null;
        this.state = null;
        this.unseatedReason = msg.reason;
        if (msg.reason === 'busted' && this.rejoin && this.autoplay) {
          this.busts += 1;
          setTimeout(() => this.connected && this.join(this.rejoin.tableId, this.rejoin.buyIn), 5);
        }
        break;
      case SERVER.BALANCE:
        this.balance = msg.balance;
        break;
      case SERVER.CARDS:
        this.hole.set(msg.handNo, msg.cards);
        break;
      case SERVER.PROOF:
        this.proofs.push(msg.proof);
        break;
      case SERVER.ERROR:
        this.errors.push(msg);
        break;
      case SERVER.TABLE:
        this.#onTable(msg);
        break;
    }
  }

  #onTable(msg) {
    this.state = msg.state;
    for (const event of msg.events) {
      if (event.type === 'hand-end') this.handsEnded += 1;
      if (this.#pending && event.type === 'action' && event.seat === this.seat) {
        this.latencies.push(performance.now() - this.#pending);
        this.#pending = null;
      }
    }
    if (this.autoplay) this.#maybeAct(msg);
  }

  #maybeAct(msg) {
    const { state } = msg;
    const mine = state.toAct !== null && state.seats[state.toAct]?.playerId === this.id;
    const key = `${state.handNo}:${msg.seq}`;
    if (!mine || this.lastActed === key) return;
    this.lastActed = key;
    const legal = state.legal;
    const roll = this.#rand(100);
    let action = legal.actions.includes('check') ? 'check' : 'call';
    let amount;
    if (roll < 8 && legal.actions.includes('fold') && legal.toCall > 0) {
      action = 'fold';
    } else if (
      roll < this.aggression &&
      (legal.actions.includes('raise') || legal.actions.includes('bet'))
    ) {
      action = legal.actions.includes('raise') ? 'raise' : 'bet';
      amount = legal.min + this.#rand(Math.min(legal.max - legal.min, state.pot + 1) + 1);
    }
    const send = () => {
      // A newer table message means the situation changed while we were "thinking".
      if (!this.autoplay || !this.connected || this.state !== state) return;
      this.#pending = performance.now();
      this.actionsSent += 1;
      this.send({
        t: CLIENT.ACT,
        handNo: state.handNo,
        action,
        ...(amount === undefined ? {} : { amount }),
      });
    };
    if (this.thinkMs > 0) setTimeout(send, this.thinkMs);
    else send();
  }
}
