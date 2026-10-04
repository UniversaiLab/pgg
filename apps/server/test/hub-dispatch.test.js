// Drives the Hub through its real websocket handlers with a fake socket, so no port or timer is
// needed. The table actors are recording fakes: what is under test is routing, refusals, and that
// the validation, rate limit and strikes still sit in front of every message type. The scripted test
// client (bot.js) is checked at the end, against a fake WebSocket, for the same reason: no port needed.

import { describe, expect, test } from 'bun:test';
import { ClientMessage } from '@pgg/protocol';
import { CLIENT, CLOSE, ERR, LIMITS, SERVER } from '@pgg/protocol/constants';
import { loadConfig } from '../src/config.js';
import { Hub, SIGNATURE_COST } from '../src/hub.js';
import { TokenBucket } from '../src/ratelimit.js';
import { Registry } from '../src/registry.js';
import { Bot } from './bot.js';

// ---- fakes ----------------------------------------------------------------------------------

/** Records every command the hub gives it and answers with `result`. */
class RecordingActor {
  calls = [];

  constructor(id, { isVault, result = { ok: true } } = {}) {
    this.id = id;
    if (isVault !== undefined) this.isVault = isVault; // a play table has no such property at all
    this.result = result;
  }

  #record(method, args) {
    this.calls.push({ method, args: structuredClone(args) });
    return this.result;
  }

  join = (...args) => this.#record('join', args);
  leave = (...args) => this.#record('leave', args);
  act = (...args) => this.#record('act', args);
  submitSeed = (...args) => this.#record('submitSeed', args);
  rebuy = (...args) => this.#record('rebuy', args);
  back = (...args) => this.#record('back', args);
  sync = (...args) => this.#record('sync', args);
  claim = (...args) => this.#record('claim', args);
  vaultSign = (...args) => this.#record('vaultSign', args);

  // Called by the hub on connect and for the lobby; not commands.
  connect() {}
  disconnect() {}
  seatOf() {
    return 0;
  }
  summary() {
    return { id: this.id };
  }
}

/** The part of a Bun ServerWebSocket the hub touches. */
function fakeSocket(player, bucket) {
  const ws = {
    data: { player, bucket, strikes: 0 },
    sent: [],
    closed: null,
    send: (raw) => ws.sent.push(JSON.parse(raw)),
    close: (code, reason) => {
      ws.closed = { code, reason };
    },
    getBufferedAmount: () => 0,
    subscribe() {},
    unsubscribe() {},
  };
  return ws;
}

const PLAYER = Object.freeze({ id: 'p1', name: 'Ann' });
const VAULT_TABLE = 'vault-1';
const PLAY_TABLE = 'play-1';

/**
 * A hub with the given actors, and one connected player. `seatedAt` puts the player at a table the
 * way an actor does through `onSeat`.
 */
function harness({
  schema,
  actors,
  seatedAt = null,
  bucket = new TokenBucket({ capacity: 1000, refillPerSec: 1000 }),
}) {
  const registry = new Registry();
  for (const actor of actors) registry.add(actor);
  const hub = new Hub({ wallet: { balance: () => 4321 }, registry, schema });
  const ws = fakeSocket(PLAYER, bucket);
  hub.handlers.open(ws);
  ws.sent.length = 0; // the welcome message is not what these tests look at
  if (seatedAt !== null) registry.setSeat(PLAYER.id, seatedAt);
  return {
    hub,
    ws,
    registry,
    send: (message) => hub.handlers.message(ws, JSON.stringify(message)),
    sendRaw: (raw) => hub.handlers.message(ws, raw),
    errors: () => ws.sent.filter((m) => m.t === SERVER.ERROR),
  };
}

const callsOf = (...actors) => actors.flatMap((actor) => actor.calls);

// ---- one minimal valid message per CLIENT type ---------------------------------------------

const ADDRESS = `0x${'ab'.repeat(20)}`;
const SIGNATURE = `0x${'cd'.repeat(65)}`;
const DIGEST = `0x${'ef'.repeat(32)}`;

const msg = {
  join: { t: CLIENT.JOIN, tableId: VAULT_TABLE, buyIn: 100 },
  leave: { t: CLIENT.LEAVE },
  act: { t: CLIENT.ACT, handNo: 3, action: 'raise', amount: 40 },
  seed: { t: CLIENT.SEED, handNo: 3, seed: 'abcd' },
  rebuy: { t: CLIENT.REBUY, amount: 50 },
  back: { t: CLIENT.BACK },
  sync: { t: CLIENT.SYNC },
  ping: { t: CLIENT.PING, n: 9 },
  claim: { t: CLIENT.CLAIM, tableId: VAULT_TABLE, address: ADDRESS, sig: SIGNATURE },
  sig: { t: CLIENT.SIGN, nonce: '12', digest: DIGEST, sig: SIGNATURE },
};

/**
 * `seated`: whether the player sits at the table first. `calls`: what the actor must be asked, as
 * [method, ...args] (none for ping, which the hub answers itself). `sends`: the `t` of every
 * message the player gets back, in order, on success.
 *
 * Add a message type to CLIENT and this table must grow with it, or the coverage test fails.
 */
const SAMPLES = {
  [CLIENT.JOIN]: {
    message: msg.join,
    seated: false,
    calls: [['join', PLAYER, msg.join]],
    sends: [SERVER.BALANCE],
  },
  [CLIENT.LEAVE]: {
    message: msg.leave,
    seated: true,
    calls: [['leave', PLAYER.id]],
    sends: [SERVER.BALANCE],
  },
  [CLIENT.ACT]: { message: msg.act, seated: true, calls: [['act', PLAYER.id, msg.act]], sends: [] },
  [CLIENT.SEED]: {
    message: msg.seed,
    seated: true,
    calls: [['submitSeed', PLAYER.id, msg.seed]],
    sends: [],
  },
  [CLIENT.REBUY]: {
    message: msg.rebuy,
    seated: true,
    calls: [['rebuy', PLAYER.id, 50]],
    sends: [SERVER.BALANCE],
  },
  [CLIENT.BACK]: { message: msg.back, seated: true, calls: [['back', PLAYER.id]], sends: [] },
  [CLIENT.SYNC]: { message: msg.sync, seated: true, calls: [['sync', PLAYER.id]], sends: [] },
  [CLIENT.PING]: { message: msg.ping, seated: false, calls: [], sends: [SERVER.PONG] },
  [CLIENT.CLAIM]: {
    message: msg.claim,
    seated: false,
    calls: [['claim', PLAYER, { tableId: VAULT_TABLE, address: ADDRESS, sig: SIGNATURE }]],
    sends: [],
  },
  [CLIENT.SIGN]: {
    message: msg.sig,
    seated: true,
    calls: [['vaultSign', PLAYER, { nonce: '12', digest: DIGEST, sig: SIGNATURE }]],
    sends: [],
  },
};

describe('every client message type is dispatched', () => {
  test('SAMPLES covers every CLIENT value, and only those', () => {
    const missing = Object.values(CLIENT).filter((type) => !(type in SAMPLES));
    const stale = Object.keys(SAMPLES).filter((type) => !Object.values(CLIENT).includes(type));
    expect({ missing, stale }).toEqual({ missing: [], stale: [] });
  });

  for (const type of Object.values(CLIENT)) {
    describe(type, () => {
      const sample = SAMPLES[type];

      test('has a valid sample of its own type', () => {
        expect(sample).toBeDefined();
        expect(sample.message.t).toBe(type);
        const parsed = ClientMessage.safeParse(sample.message);
        expect(parsed.error?.issues).toBeUndefined();
        expect(parsed.data).toEqual(sample.message);
      });

      test('reaches its handler, and nothing else is called or refused', () => {
        // A vault actor accepts every command, so a type that is routed wrongly shows up as the
        // wrong method, and one that is not routed shows up as the error it was answered with.
        const actor = new RecordingActor(VAULT_TABLE, { isVault: true });
        const bystander = new RecordingActor('bystander', { isVault: true });
        const h = harness({
          actors: [actor, bystander],
          seatedAt: sample.seated ? VAULT_TABLE : null,
        });

        h.send(sample.message);

        expect(h.errors()).toEqual([]);
        expect(actor.calls.map(({ method, args }) => [method, ...args])).toEqual(sample.calls);
        expect(bystander.calls).toEqual([]);
        expect(h.ws.sent.map((m) => m.t)).toEqual(sample.sends);
        expect(h.ws.closed).toBeNull();
      });
    });
  }
});

// The same ten messages sent to a PLAY table, which must behave exactly as it did before vault tables
// existed: every play command reaches its actor, and claim and sig are the only refusals. `sent` is the
// whole of what the player gets back.
const PLAY_JOIN = { ...msg.join, tableId: PLAY_TABLE };
const BALANCE_REPLY = { t: SERVER.BALANCE, balance: 4321 };
const NOT_VAULT_REPLY = (ref) => ({ t: SERVER.ERROR, code: ERR.NOT_VAULT_TABLE, ref });

const PLAY_SAMPLES = {
  [CLIENT.JOIN]: {
    message: PLAY_JOIN,
    seated: false,
    calls: [['join', PLAYER, PLAY_JOIN]],
    sent: [BALANCE_REPLY],
  },
  [CLIENT.LEAVE]: {
    message: msg.leave,
    seated: true,
    calls: [['leave', PLAYER.id]],
    sent: [BALANCE_REPLY],
  },
  [CLIENT.ACT]: { message: msg.act, seated: true, calls: [['act', PLAYER.id, msg.act]], sent: [] },
  [CLIENT.SEED]: {
    message: msg.seed,
    seated: true,
    calls: [['submitSeed', PLAYER.id, msg.seed]],
    sent: [],
  },
  [CLIENT.REBUY]: {
    message: msg.rebuy,
    seated: true,
    calls: [['rebuy', PLAYER.id, 50]],
    sent: [BALANCE_REPLY],
  },
  [CLIENT.BACK]: { message: msg.back, seated: true, calls: [['back', PLAYER.id]], sent: [] },
  [CLIENT.SYNC]: { message: msg.sync, seated: true, calls: [['sync', PLAYER.id]], sent: [] },
  [CLIENT.PING]: {
    message: msg.ping,
    seated: false,
    calls: [],
    sent: [{ t: SERVER.PONG, n: 9, now: expect.any(Number) }],
  },
  [CLIENT.CLAIM]: {
    message: { ...msg.claim, tableId: PLAY_TABLE },
    seated: false,
    calls: [],
    sent: [NOT_VAULT_REPLY('claim')],
  },
  [CLIENT.SIGN]: { message: msg.sig, seated: true, calls: [], sent: [NOT_VAULT_REPLY('sig')] },
};

describe('every client message type at a play table', () => {
  test('PLAY_SAMPLES covers every CLIENT value, and only those', () => {
    const missing = Object.values(CLIENT).filter((type) => !(type in PLAY_SAMPLES));
    const stale = Object.keys(PLAY_SAMPLES).filter((type) => !Object.values(CLIENT).includes(type));
    expect({ missing, stale }).toEqual({ missing: [], stale: [] });
  });

  // A play table has no isVault property today; a later one may carry isVault: false. Both are play.
  for (const [label, options] of [
    ['with no isVault property', {}],
    ['with isVault: false', { isVault: false }],
  ]) {
    for (const type of Object.values(CLIENT)) {
      test(`${type} ${label}`, () => {
        const sample = PLAY_SAMPLES[type];
        expect(sample.message.t).toBe(type);
        expect(ClientMessage.safeParse(sample.message).success).toBe(true);

        const play = new RecordingActor(PLAY_TABLE, options);
        const bystander = new RecordingActor('bystander', options);
        const h = harness({
          actors: [play, bystander],
          seatedAt: sample.seated ? PLAY_TABLE : null,
        });

        h.send(sample.message);

        expect(play.calls.map(({ method, args }) => [method, ...args])).toEqual(sample.calls);
        expect(bystander.calls).toEqual([]);
        expect(h.ws.sent).toEqual(sample.sent);
        expect(h.ws.closed).toBeNull();
        expect(h.ws.data.strikes).toBe(0); // a refusal is an answer, not a protocol violation
      });
    }
  }
});

describe('a message the schema accepts but nothing routes', () => {
  test('is refused with bad-message instead of being dropped', () => {
    // The real schema stops unknown types first, so let anything through to reach the default.
    const actor = new RecordingActor(VAULT_TABLE, { isVault: true });
    const h = harness({
      actors: [actor],
      seatedAt: VAULT_TABLE,
      schema: { parse: (value) => value },
    });
    h.send({ t: 'mystery' });
    expect(h.ws.sent).toEqual([
      { t: SERVER.ERROR, code: ERR.BAD_MESSAGE, msg: 'message not handled', ref: 'mystery' },
    ]);
    expect(actor.calls).toEqual([]);
    expect(h.ws.data.strikes).toBe(0); // the fault is the server's, not the sender's
  });

  test('the real schema still stops an unknown type, with a strike', () => {
    const h = harness({ actors: [new RecordingActor(VAULT_TABLE, { isVault: true })] });
    h.send({ t: 'mystery' });
    expect(h.errors().map((e) => e.code)).toEqual([ERR.BAD_MESSAGE]);
    expect(h.ws.data.strikes).toBe(1);
  });
});

describe('claim', () => {
  test('goes to the table it names, whether or not the player sits anywhere', () => {
    const named = new RecordingActor(VAULT_TABLE, { isVault: true });
    const other = new RecordingActor('vault-2', { isVault: true });
    const h = harness({ actors: [other, named] });
    h.send(msg.claim);
    expect(named.calls.map((c) => c.method)).toEqual(['claim']);
    expect(other.calls).toEqual([]);
  });

  test('hands the actor exactly tableId, address and sig', () => {
    const actor = new RecordingActor(VAULT_TABLE, { isVault: true });
    harness({ actors: [actor] }).send(msg.claim);
    expect(actor.calls[0].args[1]).toEqual({
      tableId: VAULT_TABLE,
      address: ADDRESS,
      sig: SIGNATURE,
    });
  });

  test('relays the actor refusal with its code, text and a ref', () => {
    const actor = new RecordingActor(VAULT_TABLE, {
      isVault: true,
      result: { ok: false, code: ERR.BAD_CLAIM, msg: 'no seat for that address' },
    });
    const h = harness({ actors: [actor] });
    h.send(msg.claim);
    expect(h.ws.sent).toEqual([
      { t: SERVER.ERROR, code: 'bad-claim', msg: 'no seat for that address', ref: 'claim' },
    ]);
    expect(h.ws.data.strikes).toBe(0); // a refusal is not a protocol violation
  });

  test('a play table refuses it with not-vault-table, and the actor never hears of it', () => {
    const play = new RecordingActor(PLAY_TABLE); // no isVault at all, as TableActor is today
    const h = harness({ actors: [play] });
    h.send({ ...msg.claim, tableId: PLAY_TABLE });
    expect(h.ws.sent).toEqual([{ t: SERVER.ERROR, code: ERR.NOT_VAULT_TABLE, ref: 'claim' }]);
    expect(play.calls).toEqual([]);
  });

  test('an unknown table gets the same answer, so table names cannot be probed', () => {
    const h = harness({ actors: [new RecordingActor(VAULT_TABLE, { isVault: true })] });
    h.send({ ...msg.claim, tableId: 'nowhere' });
    expect(h.ws.sent).toEqual([{ t: SERVER.ERROR, code: ERR.NOT_VAULT_TABLE, ref: 'claim' }]);
  });

  test('only isVault === true counts', () => {
    for (const isVault of [false, 1, 'true', {}, null]) {
      const actor = new RecordingActor(VAULT_TABLE, { isVault });
      const h = harness({ actors: [actor] });
      h.send(msg.claim);
      expect(h.errors().map((e) => e.code)).toEqual([ERR.NOT_VAULT_TABLE]);
      expect(actor.calls).toEqual([]);
    }
  });
});

describe('sig', () => {
  test('goes to the table the player sits at, never another vault table', () => {
    const mine = new RecordingActor('vault-mine', { isVault: true });
    const other = new RecordingActor('vault-other', { isVault: true });
    const h = harness({ actors: [other, mine], seatedAt: 'vault-mine' });
    h.send(msg.sig);
    expect(mine.calls.map((c) => c.method)).toEqual(['vaultSign']);
    expect(other.calls).toEqual([]);
  });

  test('hands the actor exactly nonce, digest and sig', () => {
    const actor = new RecordingActor(VAULT_TABLE, { isVault: true });
    harness({ actors: [actor], seatedAt: VAULT_TABLE }).send(msg.sig);
    expect(actor.calls[0].args).toEqual([PLAYER, { nonce: '12', digest: DIGEST, sig: SIGNATURE }]);
  });

  test('an accepted signature gets no reply, and a duplicate is just as quiet', () => {
    const actor = new RecordingActor(VAULT_TABLE, { isVault: true });
    const h = harness({ actors: [actor], seatedAt: VAULT_TABLE });
    h.send(msg.sig);
    h.send(msg.sig);
    expect(actor.calls).toHaveLength(2); // the actor decides what a duplicate means
    expect(h.ws.sent).toEqual([]);
  });

  test('relays the actor refusal with its code, text and a ref', () => {
    const actor = new RecordingActor(VAULT_TABLE, {
      isVault: true,
      result: { ok: false, code: ERR.BAD_SIGNATURE, msg: 'not the session key' },
    });
    const h = harness({ actors: [actor], seatedAt: VAULT_TABLE });
    h.send(msg.sig);
    expect(h.ws.sent).toEqual([
      { t: SERVER.ERROR, code: 'bad-signature', msg: 'not the session key', ref: 'sig' },
    ]);
    expect(h.ws.data.strikes).toBe(0);
  });

  test('a player at a play table is refused with not-vault-table', () => {
    const play = new RecordingActor(PLAY_TABLE);
    const h = harness({ actors: [play], seatedAt: PLAY_TABLE });
    h.send(msg.sig);
    expect(h.ws.sent).toEqual([{ t: SERVER.ERROR, code: ERR.NOT_VAULT_TABLE, ref: 'sig' }]);
    expect(play.calls).toEqual([]);
  });

  test('a player who sits nowhere is refused with not-seated, and no actor hears of it', () => {
    const vault = new RecordingActor(VAULT_TABLE, { isVault: true });
    const play = new RecordingActor(PLAY_TABLE);
    const h = harness({ actors: [vault, play] });
    h.send(msg.sig);
    expect(h.ws.sent).toEqual([{ t: SERVER.ERROR, code: ERR.NOT_SEATED, ref: 'sig' }]);
    expect(callsOf(vault, play)).toEqual([]);
  });
});

describe('the existing guards still sit in front of the new messages', () => {
  const vaultHarness = (options) => {
    const actor = new RecordingActor(VAULT_TABLE, { isVault: true });
    return { actor, h: harness({ actors: [actor], seatedAt: VAULT_TABLE, ...options }) };
  };

  test('malformed claim and sig messages are struck and never routed', () => {
    const { actor, h } = vaultHarness();
    const bad = [
      { ...msg.claim, address: ADDRESS.toUpperCase().replace('0X', '0x') },
      { ...msg.claim, sig: SIGNATURE.slice(0, -2) },
      { ...msg.claim, extra: true },
      { ...msg.sig, nonce: 12 },
      { ...msg.sig, nonce: '012' },
      { ...msg.sig, digest: `0x${'ef'.repeat(31)}` },
      { ...msg.sig, tableId: VAULT_TABLE },
    ];
    for (const message of bad) h.send(message);
    h.sendRaw('{"t":"claim"');
    expect(h.errors().map((e) => e.code)).toEqual(Array(bad.length + 1).fill(ERR.BAD_MESSAGE));
    expect(h.ws.data.strikes).toBe(bad.length + 1);
    expect(actor.calls).toEqual([]);
  });

  test('eight bad vault messages disconnect the sender, as for any other message', () => {
    const { h } = vaultHarness();
    for (let i = 0; i < 7; i++) h.send({ ...msg.sig, nonce: -1 });
    expect(h.ws.closed).toBeNull();
    h.send({ ...msg.sig, nonce: -1 });
    expect(h.ws.closed?.code).toBe(CLOSE.RATE_LIMITED);
  });

  test('the rate limit counts claim and sig', () => {
    const bucket = new TokenBucket({ capacity: 3, refillPerSec: 0, now: () => 0 });
    const { actor, h } = vaultHarness({ bucket });
    for (let i = 0; i < 5; i++) h.send(msg.sig);
    expect(actor.calls).toHaveLength(3);
    expect(h.errors().map((e) => e.code)).toEqual([ERR.RATE_LIMITED, ERR.RATE_LIMITED]);
    expect(h.ws.data.strikes).toBe(2);
  });

  test('a message over the size limit closes the socket, before it is parsed', () => {
    const { actor, h } = vaultHarness();
    h.sendRaw(JSON.stringify({ ...msg.claim, tableId: 'x'.repeat(LIMITS.maxMessageBytes) }));
    expect(h.ws.closed?.code).toBe(CLOSE.TOO_LARGE);
    expect(actor.calls).toEqual([]);
  });

  test('the largest valid claim and sig are within the limit and are routed', () => {
    // JSON turns each of these control characters into six, the worst case for a table id.
    const longId = '\u0001'.repeat(LIMITS.maxTableIdLength);
    const actor = new RecordingActor(longId, { isVault: true });
    const h = harness({ actors: [actor], seatedAt: longId });
    const claim = {
      t: CLIENT.CLAIM,
      tableId: longId,
      address: `0x${'ff'.repeat(20)}`,
      sig: `0x${'ff'.repeat(65)}`,
    };
    const sig = {
      t: CLIENT.SIGN,
      nonce: (2n ** 64n - 1n).toString(),
      digest: `0x${'ff'.repeat(32)}`,
      sig: `0x${'ff'.repeat(65)}`,
    };
    h.send(claim);
    h.send(sig);
    expect(h.ws.closed).toBeNull();
    expect(h.ws.sent).toEqual([]);
    expect(actor.calls.map((c) => c.method)).toEqual(['claim', 'vaultSign']);
  });
});

describe('play-money messages are unchanged', () => {
  test('a command from an unseated player is refused with not-seated, as before', () => {
    const play = new RecordingActor(PLAY_TABLE);
    const h = harness({ actors: [play] });
    for (const type of [
      CLIENT.LEAVE,
      CLIENT.ACT,
      CLIENT.SEED,
      CLIENT.REBUY,
      CLIENT.BACK,
      CLIENT.SYNC,
    ]) {
      h.send(SAMPLES[type].message);
    }
    expect(h.errors().map((e) => [e.code, e.ref])).toEqual([
      [ERR.NOT_SEATED, 'leave'],
      [ERR.NOT_SEATED, 'act'],
      [ERR.NOT_SEATED, 'seed'],
      [ERR.NOT_SEATED, 'rebuy'],
      [ERR.NOT_SEATED, 'back'],
      [ERR.NOT_SEATED, 'sync'],
    ]);
    expect(play.calls).toEqual([]);
  });

  test('join still checks for a seat and a table before asking the actor', () => {
    const play = new RecordingActor(PLAY_TABLE);
    const h = harness({ actors: [play] });
    h.send({ ...msg.join, tableId: 'nowhere' });
    expect(h.errors().map((e) => e.code)).toEqual([ERR.UNKNOWN_TABLE]);
    h.registry.setSeat(PLAYER.id, PLAY_TABLE);
    h.send({ ...msg.join, tableId: PLAY_TABLE });
    expect(h.errors().map((e) => e.code)).toEqual([ERR.UNKNOWN_TABLE, ERR.ALREADY_SEATED]);
    expect(play.calls).toEqual([]);
  });

  test('a play actor still receives the play commands', () => {
    const play = new RecordingActor(PLAY_TABLE);
    const h = harness({ actors: [play], seatedAt: PLAY_TABLE });
    h.send(msg.act);
    h.send(msg.sync);
    expect(play.calls.map((c) => c.method)).toEqual(['act', 'sync']);
    expect(h.ws.sent).toEqual([]);
  });
});
