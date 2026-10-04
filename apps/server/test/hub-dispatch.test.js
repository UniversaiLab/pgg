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

describe('claim: one table at a time, like join', () => {
  const alreadySeated = { t: SERVER.ERROR, code: ERR.ALREADY_SEATED, ref: 'claim' };

  test('a player seated at a play table cannot claim a vault table', () => {
    const vault = new RecordingActor(VAULT_TABLE, { isVault: true });
    const play = new RecordingActor(PLAY_TABLE);
    const h = harness({ actors: [vault, play], seatedAt: PLAY_TABLE });
    h.send(msg.claim);
    expect(h.ws.sent).toEqual([alreadySeated]);
    expect(callsOf(vault, play)).toEqual([]);
    expect(h.ws.data.strikes).toBe(0); // a refusal is not a protocol violation
  });

  test('nor can a player seated at another vault table', () => {
    const wanted = new RecordingActor(VAULT_TABLE, { isVault: true });
    const mine = new RecordingActor('vault-mine', { isVault: true });
    const h = harness({ actors: [wanted, mine], seatedAt: 'vault-mine' });
    h.send(msg.claim);
    expect(h.ws.sent).toEqual([alreadySeated]);
    expect(callsOf(wanted, mine)).toEqual([]);
  });

  test('claiming the table they already sit at still goes through, again and again', () => {
    // A reload or a reconnect proves the same seat again; the actor decides what that means.
    const vault = new RecordingActor(VAULT_TABLE, { isVault: true });
    const other = new RecordingActor('vault-2', { isVault: true });
    const h = harness({ actors: [vault, other], seatedAt: VAULT_TABLE });
    h.send(msg.claim);
    h.send(msg.claim);
    expect(vault.calls.map((c) => c.method)).toEqual(['claim', 'claim']);
    expect(other.calls).toEqual([]);
    expect(h.ws.sent).toEqual([]);
  });

  test('the actor registering the claimer in between makes the next claim a repeat, not a second seat', () => {
    const vault = new RecordingActor(VAULT_TABLE, { isVault: true });
    const h = harness({ actors: [vault] });
    h.send(msg.claim); // not seated anywhere yet
    h.registry.setSeat(PLAYER.id, VAULT_TABLE); // what the actor's onSeat does on a good claim
    h.send(msg.claim);
    expect(vault.calls.map((c) => c.method)).toEqual(['claim', 'claim']);
    expect(h.ws.sent).toEqual([]);
  });

  test('once they have left the other table the claim goes through', () => {
    const vault = new RecordingActor(VAULT_TABLE, { isVault: true });
    const play = new RecordingActor(PLAY_TABLE);
    const h = harness({ actors: [vault, play], seatedAt: PLAY_TABLE });
    h.send(msg.claim);
    expect(vault.calls).toEqual([]);
    h.registry.setSeat(PLAYER.id, null);
    h.send(msg.claim);
    expect(vault.calls.map((c) => c.method)).toEqual(['claim']);
    expect(h.errors().map((e) => e.code)).toEqual([ERR.ALREADY_SEATED]);
  });

  test('a claim for a table that is not a vault table is still not-vault-table, seated or not', () => {
    // The table is checked first, so the answer never depends on where the sender sits.
    const play = new RecordingActor(PLAY_TABLE);
    const other = new RecordingActor('play-2');
    const h = harness({ actors: [play, other], seatedAt: PLAY_TABLE });
    h.send({ ...msg.claim, tableId: PLAY_TABLE });
    h.send({ ...msg.claim, tableId: 'play-2' });
    h.send({ ...msg.claim, tableId: 'nowhere' });
    expect(h.errors().map((e) => e.code)).toEqual(Array(3).fill(ERR.NOT_VAULT_TABLE));
    expect(callsOf(play, other)).toEqual([]);
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
    // Room for exactly three of either (they cost SIGNATURE_COST each), and no refill.
    for (const type of [CLIENT.CLAIM, CLIENT.SIGN]) {
      const bucket = new TokenBucket({
        capacity: 3 * SIGNATURE_COST,
        refillPerSec: 0,
        now: () => 0,
      });
      const { actor, h } = vaultHarness({ bucket });
      for (let i = 0; i < 5; i++) h.send(type === CLIENT.CLAIM ? msg.claim : msg.sig);
      expect(actor.calls, type).toHaveLength(3);
      expect(
        h.errors().map((e) => e.code),
        type,
      ).toEqual([ERR.RATE_LIMITED, ERR.RATE_LIMITED]);
      expect(h.ws.data.strikes, type).toBe(2);
    }
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

describe('claim and sig cost more rate-limit tokens than anything else', () => {
  // The default per-connection limit (config.js) and the one the load scripts raise it to.
  const DEFAULT_LIMIT = { capacity: 40, refillPerSec: 20 };
  const LOAD_LIMIT = { capacity: 1000, refillPerSec: 1000 };

  /** A bucket that allows everything and only adds up what it was asked for. */
  const countingBucket = () => {
    const bucket = {
      taken: 0,
      take: (cost = 1) => {
        bucket.taken += cost;
        return true;
      },
    };
    return bucket;
  };

  /** A real bucket on a clock the test moves. */
  const clockedBucket = (limit) => {
    const clock = { now: 0 };
    return { clock, bucket: new TokenBucket({ ...limit, now: () => clock.now }) };
  };

  const vaultHarness = (bucket) => {
    const actor = new RecordingActor(VAULT_TABLE, { isVault: true });
    return { actor, h: harness({ actors: [actor], seatedAt: VAULT_TABLE, bucket }) };
  };

  const FLOODED = [
    [CLIENT.CLAIM, msg.claim],
    [CLIENT.SIGN, msg.sig],
  ];

  test('the price is set once, is an integer, and is well above a ping', () => {
    expect(Number.isInteger(SIGNATURE_COST)).toBe(true);
    // At 5 or more, a socket's burst holds at most 8 of them where it held 40 pings.
    expect(SIGNATURE_COST).toBeGreaterThanOrEqual(5);
    // Under the default capacity with room to spare, or a claim and a sig could never both be afforded.
    expect(SIGNATURE_COST * 2).toBeLessThanOrEqual(DEFAULT_LIMIT.capacity);
  });

  test('the configured limits are the ones this arithmetic assumes', () => {
    expect(loadConfig({}).rateLimit).toEqual(DEFAULT_LIMIT);
    // What loadtest.js and bots.js set (RATE_CAPACITY, RATE_REFILL).
    expect(loadConfig({ RATE_CAPACITY: '1000', RATE_REFILL: '1000' }).rateLimit).toEqual(
      LOAD_LIMIT,
    );
  });

  test('every message type is charged its price, and only claim and sig pay extra', () => {
    for (const type of Object.values(CLIENT)) {
      const sample = SAMPLES[type];
      const bucket = countingBucket();
      const actor = new RecordingActor(VAULT_TABLE, { isVault: true });
      const h = harness({
        actors: [actor],
        seatedAt: sample.seated ? VAULT_TABLE : null,
        bucket,
      });
      h.send(sample.message);
      const expected = type === CLIENT.CLAIM || type === CLIENT.SIGN ? SIGNATURE_COST : 1;
      expect(bucket.taken, type).toBe(expected);
    }
  });

  test('the same prices apply at a play table', () => {
    for (const type of Object.values(CLIENT)) {
      const sample = PLAY_SAMPLES[type];
      const bucket = countingBucket();
      const h = harness({
        actors: [new RecordingActor(PLAY_TABLE)],
        seatedAt: sample.seated ? PLAY_TABLE : null,
        bucket,
      });
      h.send(sample.message);
      const expected = type === CLIENT.CLAIM || type === CLIENT.SIGN ? SIGNATURE_COST : 1;
      expect(bucket.taken, type).toBe(expected);
    }
  });

  test('a malformed claim or sig costs one token: nothing is recovered for it', () => {
    const bucket = countingBucket();
    const { h } = vaultHarness(bucket);
    h.send({ ...msg.claim, sig: SIGNATURE.slice(0, -2) });
    h.send({ ...msg.sig, nonce: 12 });
    h.sendRaw('{"t":"sig"');
    h.sendRaw('not json');
    expect(bucket.taken).toBe(4);
  });

  for (const [type, message] of FLOODED) {
    test(`a flood of ${type} is rate limited after a few, then the sender is disconnected`, () => {
      const { bucket } = clockedBucket(DEFAULT_LIMIT);
      const { actor, h } = vaultHarness(bucket);
      const affordable = Math.floor(DEFAULT_LIMIT.capacity / SIGNATURE_COST);
      expect(affordable).toBeLessThanOrEqual(8);

      for (let i = 0; i < affordable; i++) h.send(message);
      expect(actor.calls).toHaveLength(affordable);
      expect(h.errors()).toEqual([]);

      // The next ones are refused with the existing strike logic: seven strikes are tolerated...
      for (let i = 1; i <= 7; i++) {
        h.send(message);
        expect(h.ws.data.strikes).toBe(i);
        expect(h.ws.closed).toBeNull();
      }
      expect(h.errors().map((e) => e.code)).toEqual(Array(7).fill(ERR.RATE_LIMITED));
      // ...and the eighth closes the socket with the rate-limit code.
      h.send(message);
      expect(h.ws.closed?.code).toBe(CLOSE.RATE_LIMITED);
      expect(actor.calls).toHaveLength(affordable); // none of the flood reached the actor
    });

    test(`${type} is paid for out of the same bucket, so waiting restores it`, () => {
      const { clock, bucket } = clockedBucket(DEFAULT_LIMIT);
      const { actor, h } = vaultHarness(bucket);
      const affordable = Math.floor(DEFAULT_LIMIT.capacity / SIGNATURE_COST);
      for (let i = 0; i < affordable; i++) h.send(message);
      const waitMs = (SIGNATURE_COST / DEFAULT_LIMIT.refillPerSec) * 1000;

      clock.now += waitMs - 100; // not yet a whole price
      h.send(message);
      expect(actor.calls).toHaveLength(affordable);
      expect(h.errors()).toHaveLength(1);

      clock.now += 200; // now past it, even counting the token the refused try still cost
      h.send(message);
      expect(actor.calls).toHaveLength(affordable + 1);
    });
  }

  test('a flood of valid claims or sigs does not push the price onto other connections', () => {
    // Each socket has its own bucket: one connection being limited changes nothing for another.
    const flooded = clockedBucket(DEFAULT_LIMIT);
    const calm = clockedBucket(DEFAULT_LIMIT);
    const a = vaultHarness(flooded.bucket);
    const b = vaultHarness(calm.bucket);
    for (let i = 0; i < 30; i++) a.h.send(msg.sig);
    b.h.send(msg.sig);
    expect(b.h.errors()).toEqual([]);
    expect(b.actor.calls).toHaveLength(1);
  });

  test('act, seed and ping are not slowed: a full burst of 40 each still goes through', () => {
    for (const type of [CLIENT.ACT, CLIENT.SEED, CLIENT.PING, CLIENT.SYNC, CLIENT.BACK]) {
      const { bucket } = clockedBucket(DEFAULT_LIMIT);
      const { h } = vaultHarness(bucket);
      for (let i = 0; i < DEFAULT_LIMIT.capacity; i++) h.send(SAMPLES[type].message);
      expect(h.errors(), type).toEqual([]);
      expect(h.ws.data.strikes, type).toBe(0);
      h.send(SAMPLES[type].message); // one more than the burst
      expect(
        h.errors().map((e) => e.code),
        type,
      ).toEqual([ERR.RATE_LIMITED]);
    }
  });

  test('play messages cost what they always cost, so what is left buys exactly one signature', () => {
    const { bucket } = clockedBucket(DEFAULT_LIMIT);
    const { actor, h } = vaultHarness(bucket);
    for (let i = 0; i < DEFAULT_LIMIT.capacity - SIGNATURE_COST; i++) h.send(msg.act);
    h.send(msg.sig);
    expect(h.errors()).toEqual([]);
    h.send(msg.sig);
    expect(h.errors().map((e) => e.code)).toEqual([ERR.RATE_LIMITED]);
    expect(actor.calls.filter((c) => c.method === 'vaultSign')).toHaveLength(1);
  });

  test('an honest client is never limited: a claim and a sync on connect, then a signature every hand', () => {
    const { clock, bucket } = clockedBucket(DEFAULT_LIMIT);
    const { actor, h } = vaultHarness(bucket);
    // Back to back on connect, then the pending signreq's answer straight after.
    h.send(msg.claim);
    h.send(msg.sync);
    h.send(msg.sig);
    // Ten minutes of 3 second hands: a signature, three actions and a seed, and a ping every 5 seconds.
    for (let hand = 0; hand < 200; hand++) {
      clock.now = hand * 3000;
      h.send(msg.sig);
      for (const type of [CLIENT.ACT, CLIENT.ACT, CLIENT.ACT, CLIENT.SEED]) {
        clock.now += 400;
        h.send(SAMPLES[type].message);
      }
      if (hand % 5 === 0) h.send(msg.ping);
    }
    expect(h.errors()).toEqual([]);
    expect(h.ws.data.strikes).toBe(0);
    expect(h.ws.closed).toBeNull();
    expect(actor.calls.filter((c) => c.method === 'vaultSign')).toHaveLength(201);
  });

  test('the limits the load scripts use leave room for signing bots', () => {
    const { bucket } = clockedBucket(LOAD_LIMIT);
    const { actor, h } = vaultHarness(bucket);
    for (let i = 0; i < 50; i++) {
      h.send(msg.claim);
      h.send(msg.sig);
    }
    expect(h.errors()).toEqual([]);
    expect(actor.calls).toHaveLength(100);
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

describe('the scripted test client runs onMessageHook after logging and validating', () => {
  // The Bot opens `new WebSocket(...)`; this stands in for it, so nothing listens on a port.
  class FakeWebSocket {
    static OPEN = 1;
    static last = null;
    readyState = 1;
    constructor(url) {
      this.url = url;
      FakeWebSocket.last = this;
    }
    send() {}
    close() {}
  }

  /** A connected bot over the fake socket; `deliver` hands it a message as if the server sent it. */
  async function withBot(run) {
    const real = globalThis.WebSocket;
    globalThis.WebSocket = FakeWebSocket;
    try {
      const bot = new Bot({ httpUrl: 'http://x', wsUrl: 'ws://x', name: 'tester' });
      const connecting = bot.connect();
      FakeWebSocket.last.onopen();
      await connecting;
      const deliver = (message) => FakeWebSocket.last.onmessage({ data: JSON.stringify(message) });
      await run(bot, deliver);
    } finally {
      globalThis.WebSocket = real;
    }
  }

  const GOOD = { t: SERVER.BALANCE, balance: 77 };
  const BAD = { t: SERVER.BALANCE, balance: 'lots' }; // fails the schema

  test('the hook sees the message already logged, and already marked invalid when it is', async () => {
    await withBot((bot, deliver) => {
      const seen = [];
      bot.onMessageHook = (msg) =>
        seen.push({
          logged: bot.log.at(-1) === msg,
          logLength: bot.log.length,
          invalid: bot.invalid.length,
        });
      deliver(GOOD);
      deliver(BAD);
      expect(seen).toEqual([
        { logged: true, logLength: 1, invalid: 0 },
        { logged: true, logLength: 2, invalid: 1 },
      ]);
    });
  });

  test('the hook gets every message once, in order', async () => {
    await withBot((bot, deliver) => {
      const seen = [];
      bot.onMessageHook = (msg) => seen.push(msg);
      for (const message of [GOOD, { t: SERVER.PONG, now: 1 }, BAD]) deliver(message);
      expect(seen).toEqual([GOOD, { t: SERVER.PONG, now: 1 }, BAD]);
      expect(bot.log).toEqual(seen);
    });
  });

  test('a hook that throws cannot drop a message, skip validation or stop the bot handling it', async () => {
    await withBot((bot, deliver) => {
      bot.onMessageHook = (msg) => {
        throw new Error(`hook failed on ${msg.t}`);
      };
      expect(() => deliver(BAD)).not.toThrow(); // what the socket's own handler would see
      expect(() => deliver(GOOD)).not.toThrow();
      expect(bot.log).toEqual([BAD, GOOD]);
      expect(bot.invalid.map((entry) => entry.msg)).toEqual([BAD]); // checked before the hook ran
      expect(bot.balance).toBe(77); // the bot's own handling still ran
      expect(bot.hookErrors.map((entry) => [entry.msg, entry.error.message])).toEqual([
        [BAD, 'hook failed on balance'],
        [GOOD, 'hook failed on balance'],
      ]);
    });
  });

  test('a hook that rejects is recorded too, not left as an unhandled rejection', async () => {
    await withBot(async (bot, deliver) => {
      bot.onMessageHook = async () => {
        throw new Error('async failure');
      };
      deliver(GOOD);
      await Promise.resolve();
      await Promise.resolve();
      expect(bot.log).toEqual([GOOD]);
      expect(bot.hookErrors.map((entry) => entry.error.message)).toEqual(['async failure']);
    });
  });

  test('without a hook nothing changes', async () => {
    await withBot((bot, deliver) => {
      deliver(GOOD);
      expect(bot.log).toEqual([GOOD]);
      expect(bot.hookErrors).toEqual([]);
    });
  });
});
