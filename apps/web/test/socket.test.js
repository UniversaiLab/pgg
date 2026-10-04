import { beforeEach, describe, expect, test } from 'bun:test';
import { GameSocket } from '../src/lib/socket.js';

class FakeWebSocket {
  static instances = [];
  readyState = 0;
  sent = [];
  constructor(url) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000) {
    this.readyState = 3;
    this.closedWith = code;
  }
  // test controls
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(message) {
    this.onmessage?.({ data: typeof message === 'string' ? message : JSON.stringify(message) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

class FakeTimers {
  now = 0;
  #queue = [];
  #id = 0;
  setTimeout = (fn, ms) => this.#add(fn, ms, false);
  setInterval = (fn, ms) => this.#add(fn, ms, true);
  clearTimeout = (id) => {
    this.#queue = this.#queue.filter((t) => t.id !== id);
  };
  clearInterval = this.clearTimeout;
  #add(fn, ms, repeat) {
    const timer = { id: ++this.#id, at: this.now + ms, fn, repeat, ms };
    this.#queue.push(timer);
    return timer.id;
  }
  get pending() {
    return this.#queue.length;
  }
  advance(ms) {
    const end = this.now + ms;
    for (;;) {
      const due = this.#queue.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.now = due.at;
      if (due.repeat) due.at += due.ms;
      else this.#queue = this.#queue.filter((t) => t.id !== due.id);
      due.fn();
    }
    this.now = end;
  }
}

function make(options = {}) {
  const timers = new FakeTimers();
  const messages = [];
  const statuses = [];
  const socket = new GameSocket({
    url: () => 'ws://x/ws?token=t',
    onMessage: (m) => messages.push(m),
    onStatus: (s) => statuses.push(s),
    WebSocketImpl: FakeWebSocket,
    timers,
    random: () => 0.5, // jitter factor 1.0
    now: () => timers.now,
    ...options,
  });
  return { socket, timers, messages, statuses };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
});
const last = () => FakeWebSocket.instances.at(-1);

describe('GameSocket', () => {
  test('connects, reports status, delivers messages and answers nothing it did not ask', () => {
    const { socket, messages, statuses } = make();
    socket.connect();
    expect(statuses).toEqual(['connecting']);
    expect(last().url).toBe('ws://x/ws?token=t');
    last().open();
    expect(statuses).toEqual(['connecting', 'open']);
    last().receive({ t: 'lobby', tables: [] });
    last().receive('not json{');
    expect(messages).toEqual([{ t: 'lobby', tables: [] }]);
  });

  test('send reports whether the message went out', () => {
    const { socket } = make();
    expect(socket.send({ t: 'ping' })).toBe(false);
    socket.connect();
    expect(socket.send({ t: 'leave' })).toBe(false); // still connecting
    last().open();
    expect(socket.send({ t: 'leave' })).toBe(true);
    expect(last().sent.at(-1)).toEqual({ t: 'leave' });
  });

  test('measures round trip and clock skew from pongs, and does not pass them on', () => {
    const { socket, timers, messages } = make();
    socket.connect();
    timers.now = 1000;
    last().open(); // sends ping with n = 1000
    expect(last().sent[0]).toEqual({ t: 'ping', n: 1000 });
    timers.now = 1040; // 40 ms round trip
    last().receive({ t: 'pong', n: 1000, now: 5020 }); // server clock is 4000 ms ahead
    expect(socket.rtt).toBe(40);
    expect(socket.skew).toBe(4000);
    expect(socket.serverNow()).toBe(1040 + 4000);
    expect(messages).toEqual([]);
  });

  test('pings again on an interval', () => {
    const { socket, timers } = make();
    socket.connect();
    last().open();
    timers.advance(15_000);
    timers.advance(15_000);
    expect(last().sent.filter((m) => m.t === 'ping')).toHaveLength(3);
  });

  test('reconnects with growing, capped backoff and resets after a successful open', () => {
    const { socket, timers, statuses } = make();
    socket.connect();
    last().open();
    const delays = [];
    for (let i = 0; i < 7; i++) {
      const before = FakeWebSocket.instances.length;
      last().drop();
      expect(statuses.at(-1)).toBe('reconnecting');
      let waited = 0;
      while (FakeWebSocket.instances.length === before) {
        timers.advance(100);
        waited += 100;
      }
      delays.push(waited);
    }
    expect(delays).toEqual([400, 800, 1600, 3200, 6400, 8000, 8000]);
    last().open(); // a good connection resets the schedule
    last().drop();
    const before = FakeWebSocket.instances.length;
    timers.advance(400);
    expect(FakeWebSocket.instances.length).toBe(before + 1);
  });

  test('close() is final: no reconnect, timers cleared', () => {
    const { socket, timers, statuses } = make();
    socket.connect();
    last().open();
    socket.close();
    expect(statuses.at(-1)).toBe('idle');
    expect(timers.pending).toBe(0);
    timers.advance(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  test('being replaced by another session or rejected stops reconnecting', () => {
    for (const [code, status] of [
      [4000, 'replaced'],
      [4001, 'unauthorized'],
    ]) {
      FakeWebSocket.instances = [];
      const { socket, timers, statuses } = make();
      socket.connect();
      last().open();
      last().drop(code);
      timers.advance(60_000);
      expect(statuses.at(-1)).toBe(status);
      expect(FakeWebSocket.instances).toHaveLength(1);
    }
  });

  test('a stale close event from an old socket does not disturb the new one', () => {
    const { socket, timers } = make();
    socket.connect();
    const old = last();
    old.open();
    old.drop();
    timers.advance(400);
    const fresh = last();
    fresh.open();
    old.onclose?.({ code: 1006 }); // late event from the previous socket
    timers.advance(10_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(socket.open).toBe(true);
  });
});
