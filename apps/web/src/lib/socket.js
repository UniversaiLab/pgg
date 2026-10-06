// A WebSocket that reconnects by itself and measures round-trip time and clock skew (the turn
// timer is drawn from the SERVER's deadline, so the client needs to know how far off its own clock is).
// Everything environmental is injectable, so tests run it with a fake socket and fake timers.
//
// Phones freeze background pages: timers stop, and the back-off can leave a returning player waiting for
// seconds. When the page becomes visible again (or is restored from the back/forward cache, or the network
// comes back) a closed socket reconnects at once. At a vault table that matters: the open signreq is re-sent
// on reconnect, and a quick answer keeps the table out of a stall.

import { CLIENT, CLOSE, SERVER } from '@pgg/protocol/constants';

const PING_EVERY_MS = 15_000;

export class GameSocket {
  #makeUrl;
  #WebSocketImpl;
  #timers;
  #random;
  #now;
  #onMessage;
  #onStatus;
  #ws = null;
  #attempt = 0;
  #wanted = false;
  #retry = null;
  #pinger = null;
  #pingSentAt = 0;
  #doc;
  #win;
  #listening = false;
  rtt = 0;
  skew = 0; // serverTime - clientTime, in ms

  constructor({
    url,
    onMessage,
    onStatus,
    WebSocketImpl = globalThis.WebSocket,
    timers = {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (id) => clearInterval(id),
    },
    random = Math.random,
    now = Date.now,
    doc = globalThis.document,
    win = globalThis.window,
  }) {
    this.#makeUrl = typeof url === 'function' ? url : () => url;
    this.#onMessage = onMessage;
    this.#onStatus = onStatus;
    this.#WebSocketImpl = WebSocketImpl;
    this.#timers = timers;
    this.#random = random;
    this.#now = now;
    this.#doc = doc ?? null;
    this.#win = win ?? null;
  }

  get open() {
    return this.#ws?.readyState === 1;
  }

  /** Server time as the client estimates it. */
  serverNow() {
    return this.#now() + this.skew;
  }

  connect() {
    this.#wanted = true;
    this.#listen(true);
    this.#open();
  }

  close() {
    this.#wanted = false;
    this.#listen(false);
    this.#stopTimers();
    this.#ws?.close(1000);
    this.#ws = null;
    this.#onStatus('idle');
  }

  /** @returns {boolean} false if the message could not be sent right now */
  send(message) {
    if (!this.open) return false;
    this.#ws.send(JSON.stringify(message));
    return true;
  }

  #open() {
    if (this.#ws) return;
    this.#onStatus(this.#attempt === 0 ? 'connecting' : 'reconnecting');
    const ws = new this.#WebSocketImpl(this.#makeUrl());
    this.#ws = ws;
    ws.onopen = () => {
      this.#attempt = 0;
      this.#onStatus('open');
      this.#ping();
      this.#pinger = this.#timers.setInterval(() => this.#ping(), PING_EVERY_MS);
    };
    ws.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return; // not ours; ignore rather than crash the UI
      }
      if (message.t === SERVER.PONG) this.#onPong(message);
      else this.#onMessage(message);
    };
    ws.onclose = (event) => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#stopTimers();
      if (!this.#wanted) return;
      if (event.code === CLOSE.REPLACED) {
        this.#wanted = false;
        this.#listen(false);
        this.#onStatus('replaced'); // another tab or device took this session over
        return;
      }
      if (event.code === CLOSE.UNAUTHORIZED) {
        this.#wanted = false;
        this.#listen(false);
        this.#onStatus('unauthorized');
        return;
      }
      this.#schedule();
    };
    ws.onerror = () => {}; // onclose always follows and does the work
  }

  // Back in front, restored, or online again: a socket waiting out its back-off reconnects now.
  #wake = () => {
    if (!this.#wanted || this.#ws) return;
    if (this.#doc?.visibilityState === 'hidden') return;
    if (this.#retry !== null) this.#timers.clearTimeout(this.#retry);
    this.#retry = null;
    this.#attempt = 0;
    this.#open();
  };

  #listen(on) {
    if (on === this.#listening) return;
    this.#listening = on;
    const method = on ? 'addEventListener' : 'removeEventListener';
    this.#doc?.[method]?.('visibilitychange', this.#wake);
    this.#win?.[method]?.('pageshow', this.#wake);
    this.#win?.[method]?.('online', this.#wake);
  }

  #schedule() {
    this.#onStatus('reconnecting');
    const base = Math.min(8000, 400 * 2 ** this.#attempt);
    const delay = Math.round(base * (0.8 + this.#random() * 0.4));
    this.#attempt += 1;
    this.#retry = this.#timers.setTimeout(() => {
      this.#retry = null;
      if (this.#wanted) this.#open();
    }, delay);
  }

  #ping() {
    this.#pingSentAt = this.#now();
    this.send({ t: CLIENT.PING, n: this.#pingSentAt });
  }

  #onPong(message) {
    const received = this.#now();
    this.rtt = Math.max(0, received - this.#pingSentAt);
    // Assume the reply took half the round trip to reach us.
    const measured = message.now - (this.#pingSentAt + this.rtt / 2);
    this.skew = this.skew === 0 ? measured : Math.round(this.skew * 0.7 + measured * 0.3);
  }

  #stopTimers() {
    if (this.#retry !== null) this.#timers.clearTimeout(this.#retry);
    if (this.#pinger !== null) this.#timers.clearInterval(this.#pinger);
    this.#retry = null;
    this.#pinger = null;
  }
}
