// The durable signer: the session key is on disk before its address is handed out, every signature is on
// disk before it is returned, one nonce never gets two digests, a final latches the table until the chain
// shows it settled, bundles are kept only when they verify and are newer, and a record that is torn,
// edited or unreadable fails closed. Storage fakes prove the order (a write that throws or does not stick
// means no signature at all).
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeFunctionData, encodeAbiParameters } from 'viem';
import { pokerVaultAbi } from '../src/abi.js';
import { buildNextState, epochBaseline } from '../src/build.js';
import { makeBundle } from '../src/bundle.js';
import { createRpcChainView } from '../src/chainview.js';
import { STATUS } from '../src/check.js';
import { hashState } from '../src/eip712.js';
import { verifyClaim } from '../src/ids.js';
import * as vault from '../src/index.js';
import { privateKeyToAddress, recoverSigner, signDigest } from '../src/sign.js';
import { createSigner, FAILURE_KINDS, RECORD_PREFIX } from '../src/signer.js';
import { toWire } from '../src/state.js';
import {
  DOMAIN,
  honestRound,
  makeWorld,
  memoryStorage,
  playHand,
  publish,
  startedWorld,
  storedRecord,
  UNIT,
} from './signer-world.js';

const SIG_HEX = /0x[0-9a-f]{130}/;
const json = (value) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? `${v}n` : v));
const sigOf = (client, state) => signDigest(client.sessionKey, hashState(state, DOMAIN));
const setItems = (storage) => storage.calls.filter(([name]) => name === 'setItem').length;
const keyOfTable = (w) => RECORD_PREFIX + w.tableKey;

// a world after one honest hand: alice won 50 from bob
async function afterOneHand(seed = 11) {
  const w = await startedWorld({ seed });
  const [a, b] = w.clients;
  playHand(w, { winner: a, loser: b, amount: 50, rake: 1 });
  return w;
}

// the next hand's state and request, published to every ledger but not yet signed by anyone
function nextRequest(w, hand) {
  const { tbl, state } = w.server.hand(hand);
  publish(w, tbl);
  return { state, req: w.server.propose(state) };
}

describe('createSigner', () => {
  test('storage needs getItem, setItem and removeItem; the chain view table() and seat()', () => {
    const storage = memoryStorage();
    expect(() => createSigner()).toThrow(TypeError);
    expect(() => createSigner({ storage: null })).toThrow(TypeError);
    for (const name of ['getItem', 'setItem', 'removeItem']) {
      expect(() => createSigner({ storage: { ...storage, [name]: undefined } })).toThrow(TypeError);
    }
    expect(() => createSigner({ storage, chainView: {} })).toThrow(TypeError);
    expect(() => createSigner({ storage, chainView: { table() {} } })).toThrow(TypeError);
    expect(() => createSigner({ storage, newKey: 'k' })).toThrow(TypeError);
    expect(() => createSigner({ storage, now: 5 })).toThrow(TypeError);
    expect(() => createSigner({ storage, chainView: { table() {}, seat() {} } })).not.toThrow();
  });

  test('the index exports the signer and the ledger', () => {
    expect(vault.createSigner).toBe(createSigner);
    expect(vault.FAILURE_KINDS).toBe(FAILURE_KINDS);
    expect(vault.RECORD_PREFIX).toBe('pgg.vault.v1.');
    expect(typeof vault.createLedger).toBe('function');
    expect(vault.LEDGER_BLOCKERS['mid-hand']).toBe('wait');
    expect(Object.isFrozen(FAILURE_KINDS)).toBe(true);
  });
});

describe('ensureSessionKey: the key is on disk before its address exists for anyone', () => {
  test('one setItem, read back, then the address; the record has the documented shape', () => {
    const w = makeWorld({ seed: 2 });
    const [a] = w.clients;
    const signer = createSigner({
      storage: a.storage,
      newKey: () => a.sessionKey,
      now: () => 1234,
    });
    const made = signer.ensureSessionKey(w.tableKey, {
      wallet: a.wallet,
      domain: DOMAIN,
      unit: UNIT,
    });
    expect(made).toEqual({ ok: true, address: a.sessionAddress, created: true });
    // the write came first, then a read-back of the very same text, and nothing after
    const calls = a.storage.calls.map(([name, key]) => [name, key]);
    expect(calls).toEqual([
      ['getItem', keyOfTable(w)],
      ['setItem', keyOfTable(w)],
      ['getItem', keyOfTable(w)],
    ]);
    expect(storedRecord(a.storage, w.tableKey)).toEqual({
      v: 1,
      tableKey: w.tableKey,
      sessionKey: a.sessionKey,
      address: a.sessionAddress,
      wallet: a.wallet,
      domain: DOMAIN,
      unit: '10000',
      roster: null,
      deposit: null,
      last: null,
      bundle: null,
      pinned: null,
      epochClosed: false,
      leaveAckNonce: null,
      failures: [],
      createdAt: 1234,
    });
    expect(privateKeyToAddress(storedRecord(a.storage, w.tableKey).sessionKey)).toBe(made.address);
  });

  test('a second call returns the same key and writes nothing; the key is never replaced', () => {
    const w = makeWorld({ seed: 2 });
    const [a] = w.clients;
    const first = a.signer.ensureSessionKey(w.tableKey);
    const writes = setItems(a.storage);
    const other = createSigner({ storage: a.storage, newKey: () => `0x${'11'.repeat(32)}` });
    expect(other.ensureSessionKey(w.tableKey)).toEqual({ ...first, created: false });
    expect(setItems(a.storage)).toBe(writes);
    expect(createdAtOf(a)).toBeNull(); // no clock injected: no timestamp
  });

  test('a write that throws, or that does not stick, hands out no address', () => {
    for (const mode of ['failSet', 'dropWrites']) {
      const w = makeWorld({ seed: 2 });
      const [a] = w.clients;
      a.storage.modes[mode] = true;
      const made = a.signer.ensureSessionKey(w.tableKey);
      expect(made).toMatchObject({ ok: false, kind: 'storage' });
      expect(made.address).toBeUndefined();
      expect(json(made)).not.toContain(a.sessionAddress.slice(2));
      expect(a.signer.failure(w.tableKey)).toMatchObject({ kind: 'storage', blocking: false });
      // once storage works again the same key is made and the warning clears
      a.storage.modes[mode] = false;
      expect(a.signer.ensureSessionKey(w.tableKey)).toMatchObject({ ok: true, created: true });
      expect(a.signer.failure(w.tableKey)).toBeNull();
    }
  });

  test('storage that cannot be read is not "no record": no key is minted over it', () => {
    const w = makeWorld({ seed: 2 });
    const [a] = w.clients;
    a.storage.modes.failGet = true;
    expect(a.signer.ensureSessionKey(w.tableKey)).toMatchObject({ ok: false, kind: 'storage' });
    expect(setItems(a.storage)).toBe(0);
    expect(a.signer.failure(w.tableKey)).toMatchObject({ kind: 'storage' });
  });

  test('a record whose key is missing or unreadable is a lost key: reported, never replaced, never rewritten', () => {
    const variants = [
      (r) => {
        delete r.sessionKey;
      },
      (r) => {
        r.sessionKey = 'not a key';
      },
      (r) => {
        r.sessionKey = `0x${'00'.repeat(32)}`; // zero is not a secp256k1 key
      },
      (r) => {
        r.sessionKey = `0x${'ff'.repeat(32)}`; // above the curve order
      },
    ];
    for (const spoil of variants) {
      const w = makeWorld({ seed: 2 });
      const [a] = w.clients;
      a.signer.ensureSessionKey(w.tableKey);
      const record = storedRecord(a.storage, w.tableKey);
      spoil(record);
      a.storage.map.set(keyOfTable(w), JSON.stringify(record));
      const writes = setItems(a.storage);
      expect(a.signer.ensureSessionKey(w.tableKey)).toMatchObject({ ok: false, kind: 'lost-key' });
      expect(setItems(a.storage)).toBe(writes);
      expect(a.signer.failure(w.tableKey)).toMatchObject({ kind: 'lost-key', blocking: true });
    }
  });

  test('a wiped storage while the chain shows my seat: lost key, and the marker keeps saying so', () => {
    const w = makeWorld({ seed: 2 });
    const [a] = w.clients;
    const chainSeat = { deposit: 5n, sessionKey: a.sessionAddress };
    expect(a.signer.ensureSessionKey(w.tableKey, { chainSeat })).toMatchObject({
      ok: false,
      kind: 'lost-key',
    });
    // later, without the chain fact, it still refuses to mint a replacement
    expect(a.signer.ensureSessionKey(w.tableKey)).toMatchObject({ ok: false, kind: 'lost-key' });
    expect(a.signer.failure(w.tableKey)).toMatchObject({ kind: 'lost-key', blocking: true });
    expect(storedRecord(a.storage, w.tableKey).sessionKey).toBeNull();
    // no seat on the chain (null) is a fresh start
    const w2 = makeWorld({ seed: 3 });
    expect(w2.clients[0].signer.ensureSessionKey(w2.tableKey, { chainSeat: null })).toMatchObject({
      ok: true,
      created: true,
    });
  });

  test('a torn record is corrupt, and is left as it is', () => {
    const w = makeWorld({ seed: 2 });
    const [a] = w.clients;
    a.signer.ensureSessionKey(w.tableKey);
    const raw = a.storage.map.get(keyOfTable(w));
    a.storage.map.set(keyOfTable(w), raw.slice(0, raw.length - 9));
    expect(a.signer.ensureSessionKey(w.tableKey)).toMatchObject({ ok: false, kind: 'corrupt' });
    expect(a.storage.map.get(keyOfTable(w))).toBe(raw.slice(0, raw.length - 9));
  });

  test('another wallet cannot take over a key; bad arguments are caller bugs', () => {
    const w = makeWorld({ seed: 2 });
    const [a, b] = w.clients;
    a.signer.ensureSessionKey(w.tableKey, { wallet: a.wallet });
    expect(a.signer.ensureSessionKey(w.tableKey, { wallet: b.wallet })).toMatchObject({
      ok: false,
      kind: 'other-wallet',
    });
    expect(() => a.signer.ensureSessionKey('0x12')).toThrow(TypeError);
    expect(() => b.signer.ensureSessionKey(w.tableKey, { unit: 5 })).toThrow(TypeError);
    const broken = createSigner({ storage: memoryStorage(), newKey: () => 'nope' });
    expect(() => broken.ensureSessionKey(w.tableKey)).toThrow(TypeError);
  });
});

function createdAtOf(client) {
  return JSON.parse([...client.storage.map.values()][0]).createdAt;
}

describe('handleSignReq: on disk before it is returned', () => {
  test('an honest request: the signature is over the client digest, and the record holds it before the return', async () => {
    const w = await afterOneHand();
    const [a, b] = w.clients;
    const { state, req } = nextRequest(w, { winner: b, loser: a, amount: 20, rake: 0 });
    const before = a.storage.calls.length;
    const answer = a.signer.handleSignReq(req, { ledger: a.ledger });
    const digest = hashState(state, DOMAIN);
    expect(answer).toEqual({ action: 'send', nonce: state.nonce, digest, sig: sigOf(a, state) });
    expect(recoverSigner(digest, answer.sig)).toBe(a.sessionAddress);
    // exactly one write, carrying the signature, then its read-back: nothing else happened after it
    const during = a.storage.calls.slice(before);
    const writes = during.filter(([name]) => name === 'setItem');
    expect(writes).toHaveLength(1);
    expect(writes[0][2]).toContain(answer.sig);
    expect(during.at(-1)).toEqual(['getItem', keyOfTable(w)]);
    expect(storedRecord(a.storage, w.tableKey).last).toEqual({
      nonce: state.nonce.toString(),
      digest,
      sig: answer.sig,
      isFinal: false,
      state: toWire(state),
    });
  });

  test('a write that throws: no signature leaves, nothing is recorded, and storage is reported', async () => {
    const w = await afterOneHand();
    const [a, b] = w.clients;
    const { state, req } = nextRequest(w, { winner: b, loser: a, amount: 20, rake: 0 });
    const lastBefore = storedRecord(a.storage, w.tableKey).last;
    a.storage.modes.failSet = true;
    const answer = a.signer.handleSignReq(req, { ledger: a.ledger });
    expect(answer).toMatchObject({ action: 'refuse', rule: 'STORAGE' });
    expect(json(answer)).not.toMatch(SIG_HEX);
    expect(json(answer)).not.toContain(sigOf(a, state).slice(2, 40));
    expect(storedRecord(a.storage, w.tableKey).last).toEqual(lastBefore);
    expect(a.signer.failure(w.tableKey)).toMatchObject({ kind: 'storage', blocking: false });
    // storage back: the same request now signs, with the very bytes it would have had
    a.storage.modes.failSet = false;
    expect(a.signer.handleSignReq(req, { ledger: a.ledger })).toMatchObject({
      action: 'send',
      sig: sigOf(a, state),
    });
    expect(a.signer.failure(w.tableKey)).toBeNull();
  });

  test('a write that silently does not stick, or cannot be read back, is no signature either', async () => {
    for (const spoil of ['dropWrites', 'readBack']) {
      const w = await afterOneHand();
      const [a, b] = w.clients;
      const { req } = nextRequest(w, { winner: b, loser: a, amount: 20, rake: 0 });
      if (spoil === 'dropWrites') a.storage.modes.dropWrites = true;
      else {
        const setItem = a.storage.setItem.bind(a.storage);
        a.storage.setItem = (k, v) => {
          setItem(k, v);
          a.storage.modes.failGet = true; // the disk went away right after the write
        };
      }
      const answer = a.signer.handleSignReq(req, { ledger: a.ledger });
      expect(answer).toMatchObject({ action: 'refuse', rule: 'STORAGE' });
      expect(json(answer)).not.toMatch(SIG_HEX);
    }
  });

  test('the same nonce and digest again: the identical signature, and no new write', async () => {
    const w = await afterOneHand();
    const [a, b] = w.clients;
    const { req } = nextRequest(w, { winner: b, loser: a, amount: 20, rake: 0 });
    const first = a.signer.handleSignReq(req, { ledger: a.ledger });
    const writes = setItems(a.storage);
    // even mid-hand, and from a fresh signer on the same storage (a reload)
    publish(w, w.server.tableMessage({ inHand: true }));
    const reloaded = createSigner({ storage: a.storage, chainView: w.chain });
    expect(reloaded.handleSignReq(req, { ledger: a.ledger })).toEqual(first);
    expect(a.signer.handleSignReq(req, { ledger: a.ledger })).toEqual(first);
    expect(setItems(a.storage)).toBe(writes);
  });

  test('a different digest at a signed nonce: refused, and a persistent equivocation that stops all signing', async () => {
    const w = await afterOneHand();
    const [a, b] = w.clients;
    const { state, req } = nextRequest(w, { winner: b, loser: a, amount: 20, rake: 0 });
    a.signer.handleSignReq(req, { ledger: a.ledger });
    const other = { ...state, volume: state.volume + UNIT };
    const answer = a.signer.handleSignReq(w.server.propose(other), { ledger: a.ledger });
    expect(answer).toMatchObject({ action: 'refuse', rule: 'C1a' });
    expect(json(answer)).not.toContain(sigOf(a, other).slice(2, 40));
    const failure = a.signer.failure(w.tableKey);
    expect(failure).toMatchObject({ kind: 'equivocation', blocking: true, nonce: state.nonce });
    // on disk: a reload still knows
    expect(createSigner({ storage: a.storage }).failure(w.tableKey)).toMatchObject({
      kind: 'equivocation',
    });
    // and nothing is signed for this table any more, not even the honest next state
    expect(a.signer.handleSignReq(req, { ledger: a.ledger })).toMatchObject({
      action: 'refuse',
      rule: 'FAILED',
    });
  });

  test('a lower nonce is refused and recorded, but does not stop an honest table', async () => {
    const w = await afterOneHand();
    const [a, b] = w.clients;
    const old = w.server.lastBundle.state;
    const { req } = nextRequest(w, { winner: b, loser: a, amount: 20, rake: 0 });
    a.signer.handleSignReq(req, { ledger: a.ledger });
    const lower = { ...old, nonce: old.nonce - 1n, volume: old.volume + 1n };
    expect(a.signer.handleSignReq(w.server.propose(lower), { ledger: a.ledger })).toMatchObject({
      action: 'refuse',
      rule: 'C1a',
    });
    expect(a.signer.failure(w.tableKey)).toMatchObject({
      kind: 'refused',
      rule: 'C1a',
      blocking: false,
    });
  });

  test('the digest signed is the one the client computed: a lying digest field is refused, a missing one is fine', async () => {
    const w = await afterOneHand();
    const [a, b] = w.clients;
    const { state } = nextRequest(w, { winner: b, loser: a, amount: 20, rake: 0 });
    const decoy = hashState({ ...state, volume: state.volume + 1n }, DOMAIN);
    const lying = w.server.propose(state, { digest: decoy });
    expect(a.signer.handleSignReq(lying, { ledger: a.ledger })).toMatchObject({
      action: 'refuse',
      rule: 'C1d',
    });
    const { digest: _gone, ...bare } = w.server.propose(state);
    const answer = a.signer.handleSignReq(bare, { ledger: a.ledger });
    expect(answer.digest).toBe(hashState(state, DOMAIN));
    expect(recoverSigner(answer.digest, answer.sig)).toBe(a.sessionAddress);
  });

  test('records are per table: a high nonce at one table says nothing about another', async () => {
    const w1 = await afterOneHand(11);
    const a1 = w1.clients[0];
    playHand(w1, { winner: a1, loser: w1.clients[1], amount: 5, rake: 0 });
    // the same browser storage holds a second table
    const w2 = await startedWorld({ seed: 12 });
    const a2 = w2.clients[0];
    for (const [k, v] of a1.storage.map) a2.storage.map.set(k, v);
    playHand(w2, { winner: a2, loser: w2.clients[1], amount: 5, rake: 0 });
    expect(storedRecord(a2.storage, w2.tableKey).last.nonce).toBe('1');
    expect(storedRecord(a2.storage, w1.tableKey).last.nonce).toBe('2');
  });

  test('wait, not refuse: no epoch pinned yet, a later epoch than the pinned one, a hand still running', async () => {
    const w = makeWorld({ seed: 4 });
    for (const c of w.clients) w.depositFor(c);
    const epoch = w.server.startEpoch(w.clients);
    const [a, b] = w.clients;
    const { state } = w.server.hand({ winner: a, loser: b });
    const req = w.server.propose(state);
    expect(a.signer.handleSignReq(req, { ledger: a.ledger })).toMatchObject({
      action: 'wait',
      reason: 'no-epoch',
    });
    await a.signer.handleEpoch(epoch, a.ctx());
    expect(a.signer.handleSignReq({ ...req, epoch: 2 }, { ledger: a.ledger })).toMatchObject({
      action: 'wait',
      reason: 'epoch-not-pinned',
    });
    publish(w, w.server.tableMessage({ inHand: true }));
    expect(a.signer.handleSignReq(req, { ledger: a.ledger })).toMatchObject({
      action: 'wait',
      reason: 'mid-hand',
    });
    expect(a.signer.failure(w.tableKey)).toBeNull(); // waiting is not a failure
    publish(w, w.server.tableMessage());
    expect(a.signer.handleSignReq(req, { ledger: a.ledger })).toMatchObject({ action: 'send' });
  });

  test('refusals around the request itself: malformed, no key, other table, older epoch, no ledger', async () => {
    const w = await afterOneHand();
    const [a, b] = w.clients;
    const { req } = nextRequest(w, { winner: b, loser: a, amount: 20, rake: 0 });
    const ledger = a.ledger;
    expect(a.signer.handleSignReq(null, { ledger })).toMatchObject({ rule: 'MALFORMED' });
    expect(
      a.signer.handleSignReq({ ...req, state: { ...req.state, nonce: 3 } }, { ledger }),
    ).toMatchObject({
      rule: 'MALFORMED',
    });
    expect(a.signer.handleSignReq({ ...req, epoch: '1' }, { ledger })).toMatchObject({
      rule: 'MALFORMED',
    });
    expect(a.signer.handleSignReq({ ...req, epoch: 0 }, { ledger })).toMatchObject({
      rule: 'STALE-EPOCH',
    });
    expect(a.signer.handleSignReq(req, { ledger, tableKey: `0x${'ab'.repeat(32)}` })).toMatchObject(
      {
        rule: 'C1d',
      },
    );
    const stranger = createSigner({ storage: memoryStorage() });
    expect(stranger.handleSignReq(req, { ledger })).toMatchObject({
      action: 'refuse',
      rule: 'NO-KEY',
    });
    expect(a.signer.handleSignReq(req, {})).toMatchObject({ action: 'refuse', rule: 'VIEW' });
    expect(a.signer.handleSignReq(req)).toMatchObject({ action: 'refuse', rule: 'VIEW' });
    // a ledger that blows up fails closed; one that reports a permanent problem is a refusal
    const throwing = {
      observedStatus: () => {
        throw new Error('boom');
      },
    };
    expect(a.signer.handleSignReq(req, { ledger: throwing })).toMatchObject({ rule: 'INTERNAL' });
    const permanent = {
      observedStatus: () => ({
        ok: false,
        reason: 'conflict',
        detail: 'two results',
        permanent: true,
      }),
    };
    expect(a.signer.handleSignReq(req, { ledger: permanent })).toMatchObject({
      action: 'refuse',
      rule: 'LEDGER',
    });
    expect(a.signer.failure(w.tableKey)).toMatchObject({ kind: 'refused' });
    // none of that signed anything: the honest request still does
    expect(a.signer.handleSignReq(req, { ledger })).toMatchObject({ action: 'send' });
  });

  test('a request for a table this device holds an unreadable record for: refused with the record state', async () => {
    const w = await afterOneHand();
    const [a, b] = w.clients;
    const { req } = nextRequest(w, { winner: b, loser: a, amount: 20, rake: 0 });
    a.storage.modes.failGet = true;
    expect(a.signer.handleSignReq(req, { ledger: a.ledger })).toMatchObject({
      action: 'refuse',
      rule: 'STORAGE',
    });
  });
});

describe('a corrupted or partly written record fails closed', () => {
  // each spoils the stored JSON of a record that holds a signed state, a bundle and a pinned epoch
  const spoilers = {
    'torn in the middle': (raw) => raw.slice(0, Math.floor(raw.length / 2)),
    'not an object': () => '[1,2,3]',
    'another version': (raw) => raw.replace('"v":1', '"v":2'),
    'another table': (raw, w) => raw.replaceAll(w.tableKey.slice(2), 'ab'.repeat(32)),
    'last.sig is not this key': (raw) => {
      const r = JSON.parse(raw);
      r.last.sig = signDigest(`0x${'22'.repeat(32)}`, r.last.digest);
      return JSON.stringify(r);
    },
    'last.digest does not match last.state': (raw) => {
      const r = JSON.parse(raw);
      r.last.state.volume = `${BigInt(r.last.state.volume) + 1n}`;
      return JSON.stringify(r);
    },
    'last.nonce does not match last.state': (raw) => {
      const r = JSON.parse(raw);
      r.last.nonce = '9';
      return JSON.stringify(r);
    },
    'the address is not the key': (raw) => {
      const r = JSON.parse(raw);
      r.address = `0x${'33'.repeat(20)}`;
      return JSON.stringify(r);
    },
    'a latch with no final behind it': (raw) => {
      const r = JSON.parse(raw);
      r.epochClosed = true;
      return JSON.stringify(r);
    },
    'a pinned roster that is not the genesis roster': (raw) => {
      const r = JSON.parse(raw);
      r.roster = [...r.roster].reverse();
      return JSON.stringify(r);
    },
    'a unit of zero': (raw) => raw.replace('"unit":"10000"', '"unit":"0"'),
    'a bundle for another domain': (raw) => {
      const r = JSON.parse(raw);
      r.bundle.domain = { ...r.bundle.domain, chainId: 1 };
      return JSON.stringify(r);
    },
    'failures that are not failures': (raw) => {
      const r = JSON.parse(raw);
      r.failures = [{ kind: 'nothing', detail: 'x', rule: null, nonce: null }];
      return JSON.stringify(r);
    },
    'a stored value that is not text': () => 42,
  };

  for (const [name, spoil] of Object.entries(spoilers)) {
    test(name, async () => {
      const w = await afterOneHand();
      const [a, b] = w.clients;
      const { req } = nextRequest(w, { winner: b, loser: a, amount: 20, rake: 0 });
      const key = keyOfTable(w);
      const spoiled = spoil(a.storage.map.get(key), w, a);
      a.storage.map.set(key, spoiled);
      const writes = setItems(a.storage);
      const answer = a.signer.handleSignReq(req, { ledger: a.ledger });
      expect(answer).toMatchObject({ action: 'refuse', rule: 'CORRUPT' });
      expect(json(answer)).not.toMatch(SIG_HEX);
      expect(a.signer.failure(w.tableKey)).toMatchObject({ kind: 'corrupt', blocking: true });
      expect(a.signer.acceptBundle(w.server.bundleMessage(w.server.lastBundle))).toMatchObject({
        stored: false,
        reason: 'corrupt',
      });
      expect(await a.signer.handleEpoch(w.epochMessage, a.ctx())).toMatchObject({
        rule: 'CORRUPT',
      });
      expect(a.signer.restore(w.tableKey)).toMatchObject({ ok: false, kind: 'corrupt' });
      // the evidence is left as it was
      expect(setItems(a.storage)).toBe(writes);
      expect(a.storage.map.get(key)).toBe(spoiled);
    });
  }
});

describe('handleEpoch: pinned only when the chain agrees', () => {
  test('a pinned epoch records the roster, my genesis balance and the pinned facts', async () => {
    const w = await startedWorld({ seed: 5 });
    const [a] = w.clients;
    const record = a.signer.restore(w.tableKey).record;
    expect(record.pinned).toMatchObject({
      epoch: 1,
      arbiter: w.arbiter,
      maxRakeBps: 500,
      unpinned: false,
    });
    expect(record.pinned.genesis).toEqual(w.server.genesis);
    expect(record.roster).toEqual(w.server.genesis.players);
    expect(record.deposit).toBe(a.deposit);
    expect(record).toMatchObject({ wallet: a.wallet, domain: DOMAIN, unit: UNIT });
    expect(record.sessionKey).toBeUndefined(); // restore never hands out the private key
    expect(json(record)).not.toContain(a.sessionKey.slice(2));
  });

  test('the same epoch again is a no-op without a chain read; the same number with other facts is refused', async () => {
    const w = await startedWorld({ seed: 5 });
    const [a] = w.clients;
    const reads = w.chain.reads;
    expect(await a.signer.handleEpoch(w.epochMessage, a.ctx())).toEqual({
      ok: true,
      unchanged: true,
    });
    expect(w.chain.reads).toBe(reads);
    const other = { ...w.epochMessage, arbiter: `0x${'44'.repeat(20)}` };
    expect(await a.signer.handleEpoch(other, a.ctx())).toMatchObject({
      ok: false,
      rule: 'EPOCH-CHANGED',
    });
    const keys = { ...w.epochMessage, sessionKeys: [...w.epochMessage.sessionKeys].reverse() };
    expect(await a.signer.handleEpoch(keys, a.ctx())).toMatchObject({ ok: false });
  });

  test('older epochs, and a genesis below the newest nonce held, are refused', async () => {
    const w = await afterOneHand(6);
    const [a] = w.clients;
    expect(await a.signer.handleEpoch({ ...w.epochMessage, epoch: 0 }, a.ctx())).toMatchObject({
      rule: 'STALE-EPOCH',
    });
    // a "new" epoch replaying the genesis I already signed past
    expect(await a.signer.handleEpoch({ ...w.epochMessage, epoch: 2 }, a.ctx())).toMatchObject({
      rule: 'STALE-EPOCH',
    });
  });

  test('who I am: on the roster, with my own key, under the pinned domain, table, wallet and unit', async () => {
    const w = makeWorld({ seed: 7 });
    for (const c of w.clients) w.depositFor(c);
    const epoch = w.server.startEpoch(w.clients);
    const [a, b] = w.clients;
    const keys = [...epoch.sessionKeys];
    const me = w.server.genesis.players.indexOf(a.wallet);
    keys[me] = b.sessionAddress;
    const cases = [
      [{ ...epoch, sessionKeys: keys }, a.ctx(), 'MY-KEY'],
      [{ ...epoch, domain: { ...DOMAIN, chainId: 1 } }, a.ctx(), 'DOMAIN'],
      [epoch, a.ctx({ domain: { ...DOMAIN, chainId: 1 } }), 'DOMAIN'],
      [epoch, a.ctx({ tableKey: `0x${'ab'.repeat(32)}` }), 'TABLE'],
      [epoch, a.ctx({ unit: UNIT * 2n }), 'PINNED'],
      [epoch, a.ctx({ wallet: `0x${'55'.repeat(20)}` }), 'PINNED'],
    ];
    for (const [message, ctx, rule] of cases) {
      expect(await a.signer.handleEpoch(message, ctx), rule).toMatchObject({ ok: false, rule });
    }
    const outsider = createSigner({ storage: memoryStorage(), chainView: w.chain });
    expect(await outsider.handleEpoch(epoch, a.ctx())).toMatchObject({ rule: 'NO-KEY' });
    // a member who is not on this epoch's roster
    const stranger = w.addClient('zed', 10n * UNIT);
    stranger.signer.ensureSessionKey(w.tableKey);
    expect(await stranger.signer.handleEpoch(epoch, stranger.ctx())).toMatchObject({
      rule: 'NOT-MEMBER',
    });
    // and none of that pinned anything
    expect(a.signer.restore(w.tableKey).record.pinned).toBeNull();
  });

  test('a malformed message or a broken ctx is refused, never thrown', async () => {
    const w = makeWorld({ seed: 7 });
    for (const c of w.clients) w.depositFor(c);
    const epoch = w.server.startEpoch(w.clients);
    const [a] = w.clients;
    const finalGenesis = { ...epoch, state: { ...epoch.state, isFinal: true } };
    const keepGenesis = {
      ...epoch,
      state: { ...epoch.state, keep: epoch.state.keep.map(() => true) },
    };
    for (const message of [
      null,
      { ...epoch, epoch: -1 },
      { ...epoch, state: { ...epoch.state, nonce: 0 } },
      { ...epoch, sessionKeys: epoch.sessionKeys.slice(1) },
      { ...epoch, arbiter: 'x' },
      finalGenesis,
      keepGenesis,
    ]) {
      expect(await a.signer.handleEpoch(message, a.ctx())).toMatchObject({
        ok: false,
        rule: 'MALFORMED',
      });
    }
    for (const ctx of [
      null,
      a.ctx({ wallet: undefined }),
      a.ctx({ unit: 10_000 }),
      a.ctx({ maxRakeBps: 501 }),
      a.ctx({ maxRakeBps: 2.5 }),
      a.ctx({ myDeposit: -1n }),
      a.ctx({ myDeposit: 5 }),
      a.ctx({ allowFilling: 'yes' }),
      a.ctx({ allowUnpinned: 1 }),
      a.ctx({ tableKey: 'x' }),
    ]) {
      expect(await a.signer.handleEpoch(epoch, ctx)).toMatchObject({ ok: false, rule: 'VIEW' });
    }
  });

  test('an unreachable or broken chain view is CHAIN-READ (retry), never a pass', async () => {
    const w = makeWorld({ seed: 7 });
    for (const c of w.clients) w.depositFor(c);
    const epoch = w.server.startEpoch(w.clients);
    const [a] = w.clients;
    w.chain.down = true;
    expect(await a.signer.handleEpoch(epoch, a.ctx())).toMatchObject({
      ok: false,
      rule: 'CHAIN-READ',
    });
    w.chain.down = false;
    const views = [
      {
        table: async () => ({ ok: true, table: null }),
        seat: async () => ({ ok: false, error: 'x' }),
      },
      { table: async () => undefined, seat: async () => ({ ok: true, seat: null }) },
      {
        table: async () => {
          throw new Error('reset');
        },
        seat: async () => ({ ok: true, seat: null }),
      },
      { table: () => ({ ok: true, table: null }), seat: () => null },
    ];
    for (const view of views) {
      const signer = createSigner({ storage: a.storage, chainView: view });
      expect(await signer.handleEpoch(epoch, a.ctx())).toMatchObject({
        ok: false,
        rule: 'CHAIN-READ',
      });
    }
    expect(await a.signer.handleEpoch(epoch, a.ctx())).toEqual({ ok: true });
  });

  test('the chain disagrees: the rule verifyEpochAgainstChain names', async () => {
    const w = makeWorld({ seed: 7 });
    for (const c of w.clients) w.depositFor(c);
    const epoch = w.server.startEpoch(w.clients);
    const [a, b] = w.clients;
    const moved = { ...epoch.state, balances: [...epoch.state.balances] };
    const me = w.server.genesis.players.indexOf(a.wallet);
    const them = w.server.genesis.players.indexOf(b.wallet);
    moved.balances[me] = `${BigInt(moved.balances[me]) - UNIT}`;
    moved.balances[them] = `${BigInt(moved.balances[them]) + UNIT}`;
    expect(await a.signer.handleEpoch({ ...epoch, state: moved }, a.ctx())).toMatchObject({
      ok: false,
      rule: 'my-balance',
    });
    // my own deposit record binds too, when the record has none yet
    expect(await b.signer.handleEpoch(epoch, b.ctx({ myDeposit: b.deposit + 1n }))).toMatchObject({
      rule: 'my-balance',
    });
    expect(await b.signer.handleEpoch(epoch, b.ctx({ myDeposit: b.deposit }))).toEqual({
      ok: true,
    });
  });

  test('the record moved on while the chain was read: RETRY, nothing pinned', async () => {
    const w = makeWorld({ seed: 7 });
    for (const c of w.clients) w.depositFor(c);
    const epoch = w.server.startEpoch(w.clients);
    const [a] = w.clients;
    const view = {
      table: async (key) => {
        a.signer.noteLeave(w.tableKey, null); // another handler wrote in between
        return w.chain.table(key);
      },
      seat: (key, p) => w.chain.seat(key, p),
    };
    const signer = createSigner({ storage: a.storage, chainView: view });
    expect(await signer.handleEpoch(epoch, a.ctx())).toMatchObject({ ok: false, rule: 'RETRY' });
    expect(signer.restore(w.tableKey).record.pinned).toBeNull();
  });

  test('a Filling table passes under allowFilling but pins nothing; Active then pins', async () => {
    const w = makeWorld({ seed: 8 });
    for (const c of w.clients) w.depositFor(c);
    const [a, b] = w.clients;
    const epoch = w.server.openEpoch(w.clients); // the message before start() is mined
    expect(await a.signer.handleEpoch(epoch, a.ctx())).toMatchObject({ ok: false, rule: 'status' });
    expect(await a.signer.handleEpoch(epoch, a.ctx({ allowFilling: true }))).toEqual({
      ok: true,
      filling: true,
    });
    expect(a.signer.restore(w.tableKey).record.pinned).toBeNull();
    const { state } = w.server.hand({ winner: a, loser: b });
    expect(a.signer.handleSignReq(w.server.propose(state), { ledger: a.ledger })).toMatchObject({
      action: 'wait',
      reason: 'no-epoch',
    });
    w.chain.start(w.tableKey, w.server.genesis.players);
    expect(await a.signer.handleEpoch(epoch, a.ctx({ allowFilling: true }))).toEqual({ ok: true });
  });

  test('without a chain view: refused unless allowed; allowed means a persistent warning and the first epoch only', async () => {
    const w = makeWorld({ seed: 9, chainView: false });
    for (const c of w.clients) w.depositFor(c);
    const epoch = w.server.startEpoch(w.clients);
    const [a, b, c] = w.clients;
    expect(await a.signer.handleEpoch(epoch, a.ctx())).toMatchObject({
      ok: false,
      rule: 'UNPINNED',
    });
    expect(a.signer.restore(w.tableKey).record.pinned).toBeNull();
    expect(await a.signer.handleEpoch(epoch, a.ctx({ allowUnpinned: true }))).toEqual({
      ok: true,
      unpinned: true,
    });
    expect(a.signer.failure(w.tableKey)).toMatchObject({ kind: 'unpinned', blocking: false });
    expect(a.signer.restore(w.tableKey).record.pinned.unpinned).toBe(true);
    // my own deposit still binds
    expect(
      await b.signer.handleEpoch(epoch, b.ctx({ allowUnpinned: true, myDeposit: b.deposit - 1n })),
    ).toMatchObject({ rule: 'my-balance' });
    for (const x of [b, c]) await x.signer.handleEpoch(epoch, x.ctx({ allowUnpinned: true }));
    // it signs (the warning is not blocking) ...
    playHand(w, { winner: a, loser: b, amount: 10, rake: 0 });
    // ... but nothing but the chain can end an epoch, so a second one is refused
    const next = { ...epoch, epoch: 2, state: toWire({ ...w.server.head, isFinal: false }) };
    expect(await a.signer.handleEpoch(next, a.ctx({ allowUnpinned: true }))).toMatchObject({
      ok: false,
      rule: 'UNPINNED',
    });
  });

  test('a write failure while pinning is reported and pins nothing', async () => {
    const w = makeWorld({ seed: 7 });
    for (const c of w.clients) w.depositFor(c);
    const epoch = w.server.startEpoch(w.clients);
    const [a] = w.clients;
    const setItem = a.storage.setItem.bind(a.storage);
    a.storage.setItem = (k, v) => {
      a.storage.modes.failSet = true;
      setItem(k, v);
    };
    expect(await a.signer.handleEpoch(epoch, a.ctx())).toMatchObject({
      ok: false,
      rule: 'STORAGE',
    });
    a.storage.setItem = setItem;
    a.storage.modes.failSet = false;
    expect(a.signer.restore(w.tableKey).record.pinned).toBeNull();
  });
});

describe('acceptBundle: kept only when it verifies against the pinned epoch and is newer', () => {
  test('an honest bundle is stored; a lower one, the same one, or an older epoch one is not', async () => {
    const w = await afterOneHand(13);
    const [a, b] = w.clients;
    const first = w.server.lastBundle;
    playHand(w, { winner: b, loser: a, amount: 10, rake: 0 });
    const second = w.server.lastBundle;
    expect(a.signer.restore(w.tableKey).record.bundle).toEqual(second);
    expect(a.signer.acceptBundle(w.server.bundleMessage(first))).toMatchObject({
      stored: false,
      reason: 'not-newer',
    });
    expect(a.signer.acceptBundle(w.server.bundleMessage(second))).toMatchObject({
      stored: false,
      reason: 'duplicate',
    });
    expect(a.signer.restore(w.tableKey).record.bundle).toEqual(second);
  });

  test('every signature must verify against the PINNED keys and arbiter, for this table, domain and roster', async () => {
    const w = await afterOneHand(13);
    const [a, b] = w.clients;
    const { state } = nextRequest(w, { winner: b, loser: a, amount: 10, rake: 0 });
    const all = (key) =>
      w.server.roster.map((c) => signDigest(key ?? c.sessionKey, hashState(state, DOMAIN)));
    const digest = hashState(state, DOMAIN);
    const good = {
      domain: DOMAIN,
      state,
      arbiterSig: signDigest(w.arbiterKey, digest),
      playerSigs: w.server.roster.map((c) => signDigest(c.sessionKey, digest)),
    };
    const forger = `0x${'66'.repeat(32)}`;
    const cases = {
      'an arbiter that is not the pinned one': { ...good, arbiterSig: signDigest(forger, digest) },
      'a player key that is not on the chain': { ...good, playerSigs: all(forger) },
      'a signature over another state': {
        ...good,
        playerSigs: good.playerSigs.map((s, i) =>
          i === 0 ? sigOf(w.server.roster[0], { ...state, volume: 1n }) : s,
        ),
      },
    };
    for (const [name, bundle] of Object.entries(cases)) {
      // the message even names the forger's keys: they are ignored
      const message = w.server.bundleMessage(makeBundle(bundle), {
        sessionKeys: w.server.roster.map(() => privateKeyToAddress(forger)),
      });
      expect(a.signer.acceptBundle(message), name).toMatchObject({
        stored: false,
        reason: 'invalid',
      });
    }
    // another domain: refused before any signature is read
    const elsewhere = { chainId: 1, verifyingContract: DOMAIN.verifyingContract };
    const d2 = hashState(state, elsewhere);
    const foreign = makeBundle({
      domain: elsewhere,
      state,
      arbiterSig: signDigest(w.arbiterKey, d2),
      playerSigs: w.server.roster.map((c) => signDigest(c.sessionKey, d2)),
    });
    expect(a.signer.acceptBundle(w.server.bundleMessage(foreign))).toMatchObject({
      stored: false,
      reason: 'invalid',
      detail: expect.stringContaining('WrongDomain'),
    });
    expect(a.signer.acceptBundle(w.server.bundleMessage(makeBundle(good)))).toMatchObject({
      stored: true,
    });
  });

  test('equal nonce, different digest: a blocking conflict alarm, and the first one is kept', async () => {
    const w = await afterOneHand(13);
    const [a] = w.clients;
    const held = w.server.lastBundle;
    // all keys sign another state at the same nonce (a server that lost its record and a client that did too)
    const twin = { ...held.state, volume: held.state.volume + UNIT };
    const digest = hashState(twin, DOMAIN);
    const bundle = makeBundle({
      domain: DOMAIN,
      state: twin,
      arbiterSig: signDigest(w.arbiterKey, digest),
      playerSigs: w.server.roster.map((c) => signDigest(c.sessionKey, digest)),
    });
    expect(a.signer.acceptBundle(w.server.bundleMessage(bundle))).toMatchObject({
      stored: false,
      reason: 'conflict',
    });
    expect(a.signer.failure(w.tableKey)).toMatchObject({ kind: 'bundle-conflict', blocking: true });
    expect(a.signer.restore(w.tableKey).record.bundle).toEqual(held);
  });

  test('a bundle at a nonce where my key signed something else (my record says so) is a conflict too', async () => {
    const w = await afterOneHand(13);
    const [a, b] = w.clients;
    const { state, req } = nextRequest(w, { winner: b, loser: a, amount: 10, rake: 0 });
    a.signer.handleSignReq(req, { ledger: a.ledger });
    const twin = { ...state, volume: state.volume + UNIT };
    const digest = hashState(twin, DOMAIN);
    const bundle = makeBundle({
      domain: DOMAIN,
      state: twin,
      arbiterSig: signDigest(w.arbiterKey, digest),
      playerSigs: w.server.roster.map((c) => signDigest(c.sessionKey, digest)),
    });
    expect(a.signer.acceptBundle(w.server.bundleMessage(bundle))).toMatchObject({
      reason: 'conflict',
    });
    expect(a.signer.failure(w.tableKey)).toMatchObject({ kind: 'bundle-conflict' });
  });

  test('a verified bundle above my own record raises the high-water mark (my key signed it)', async () => {
    const w = await afterOneHand(13);
    const [a, b] = w.clients;
    // a record restored from an old copy: it misses the state it signed last
    const old = a.storage.map.get(keyOfTable(w));
    playHand(w, { winner: b, loser: a, amount: 10, rake: 0 });
    a.storage.map.set(keyOfTable(w), old);
    const bundle = w.server.lastBundle;
    expect(a.signer.acceptBundle(w.server.bundleMessage(bundle))).toEqual({
      stored: true,
      nonce: bundle.state.nonce,
      final: false,
    });
    const last = a.signer.restore(w.tableKey).record.last;
    expect(last).toMatchObject({
      nonce: bundle.state.nonce,
      isFinal: false,
      sig: sigOf(a, bundle.state),
    });
    // so a different digest at that nonce is now equivocation, not a fresh signature
    const twin = { ...bundle.state, volume: bundle.state.volume + 1n };
    expect(a.signer.handleSignReq(w.server.propose(twin), { ledger: a.ledger })).toMatchObject({
      rule: 'C1a',
    });
  });

  test("an all-signed bundle of an older epoch with the same roster is not this epoch's newest", async () => {
    const w = await startedWorld({ seed: 14 });
    const [a, b, c] = w.clients;
    playHand(w, { winner: a, loser: b, amount: 10, rake: 0 });
    const old = w.server.lastBundle;
    honestRound(w, w.server.finalState(w.server.keepFor()), { handNo: null, reason: 'drain' });
    w.server.settleOnChain();
    const epoch2 = w.server.startEpoch([a, b, c]);
    // carol's record lost every bundle (a restored copy), then she pins epoch 2
    const record = storedRecord(c.storage, w.tableKey);
    record.bundle = null;
    c.storage.map.set(keyOfTable(w), JSON.stringify(record));
    c.signer.settledObserved(w.tableKey, w.chain.row(w.tableKey));
    expect(await c.signer.handleEpoch(epoch2, c.ctx())).toEqual({ ok: true });
    expect(c.signer.acceptBundle(w.server.bundleMessage(old))).toMatchObject({
      stored: false,
      reason: 'stale',
    });
    expect(c.signer.restore(w.tableKey).record.bundle).toBeNull();
  });

  test('malformed, unknown table, no epoch, other table, storage: reasons, not exceptions', async () => {
    const w = await afterOneHand(13);
    const [a] = w.clients;
    const message = w.server.bundleMessage(w.server.lastBundle);
    expect(a.signer.acceptBundle(null)).toMatchObject({ stored: false, reason: 'malformed' });
    expect(a.signer.acceptBundle({ ...message, playerSigs: ['0x00'] })).toMatchObject({
      reason: 'malformed',
    });
    expect(a.signer.acceptBundle(message, { tableKey: `0x${'ab'.repeat(32)}` })).toMatchObject({
      reason: 'other-table',
    });
    expect(createSigner({ storage: memoryStorage() }).acceptBundle(message)).toMatchObject({
      reason: 'none',
    });
    const fresh = makeWorld({ seed: 13 });
    fresh.clients[0].signer.ensureSessionKey(fresh.tableKey);
    expect(fresh.clients[0].signer.acceptBundle(message)).toMatchObject({ reason: 'no-epoch' });
    playHand(w, { winner: a, loser: w.clients[1], amount: 1, rake: 0 });
    const next = w.server.lastBundle;
    const w2 = await afterOneHand(13);
    w2.clients[0].storage.modes.failSet = true;
    expect(w2.clients[0].signer.acceptBundle(w.server.bundleMessage(next))).toMatchObject({
      stored: false,
      reason: 'storage',
    });
  });
});

describe('finals, the latch, and settledObserved', () => {
  async function afterFinal(keep) {
    const w = await afterOneHand(15);
    honestRound(w, w.server.finalState(keep ?? w.server.keepFor()), {
      handNo: null,
      reason: 'drain',
    });
    return w;
  }

  test('a signed final latches: nothing higher is signed, the final itself is re-sent identically', async () => {
    const w = await afterFinal();
    const [a, b] = w.clients;
    const final = w.server.lastBundle.state;
    expect(a.signer.restore(w.tableKey).record.epochClosed).toBe(true);
    const after = buildNextState({ prev: final, balances: final.balances });
    expect(a.signer.handleSignReq(w.server.propose(after), { ledger: a.ledger })).toMatchObject({
      action: 'refuse',
      rule: 'C2',
    });
    expect(a.signer.handleSignReq(w.server.propose(final), { ledger: a.ledger })).toMatchObject({
      action: 'send',
      sig: sigOf(a, final),
    });
    expect(b.signer.restore(w.tableKey).record.epochClosed).toBe(true);
  });

  test('settledObserved opens the latch only when the chain shows the final settled', async () => {
    const w = await afterFinal();
    const [a] = w.clients;
    const final = w.server.lastBundle.state;
    const active = w.chain.row(w.tableKey);
    expect(a.signer.settledObserved(w.tableKey, active)).toMatchObject({
      ok: false,
      reason: 'not-settled',
    });
    expect(a.signer.settledObserved(w.tableKey, null)).toMatchObject({
      ok: false,
      reason: 'not-settled',
    });
    const exiting = { ...active, status: STATUS.Exiting, nonce: final.nonce };
    expect(a.signer.settledObserved(w.tableKey, exiting)).toMatchObject({ ok: false });
    expect(a.signer.restore(w.tableKey).record.epochClosed).toBe(true);
    w.server.settleOnChain();
    expect(a.signer.settledObserved(w.tableKey, w.chain.row(w.tableKey))).toEqual({
      ok: true,
      cleared: true,
    });
    const record = a.signer.restore(w.tableKey).record;
    expect(record.epochClosed).toBe(false);
    // what I take into the next epoch is what the final kept for me
    expect(record.deposit).toBe(final.balances[final.players.indexOf(a.wallet)]);
    expect(a.signer.settledObserved(w.tableKey, w.chain.row(w.tableKey))).toEqual({
      ok: true,
      cleared: false,
    });
    // the old epoch stays closed: only a newly pinned epoch signs again
    const after = buildNextState({ prev: final, balances: final.balances });
    expect(a.signer.handleSignReq(w.server.propose(after), { ledger: a.ledger })).toMatchObject({
      rule: 'C2',
    });
  });

  test('a final that pays me out leaves nothing to carry; storage failure is reported', async () => {
    const w0 = await afterOneHand(15);
    const c = w0.clients[2];
    const w = w0;
    honestRound(w, w.server.finalState(w.server.keepFor([c])), { handNo: null, reason: 'leave' });
    w.server.settleOnChain();
    c.storage.modes.failSet = true;
    expect(c.signer.settledObserved(w.tableKey, w.chain.row(w.tableKey))).toMatchObject({
      ok: false,
      reason: 'storage',
    });
    c.storage.modes.failSet = false;
    expect(c.signer.settledObserved(w.tableKey, w.chain.row(w.tableKey))).toEqual({
      ok: true,
      cleared: true,
    });
    expect(c.signer.restore(w.tableKey).record.deposit).toBeNull();
    expect(
      createSigner({ storage: memoryStorage() }).settledObserved(w.tableKey, null),
    ).toMatchObject({
      ok: false,
      reason: 'none',
    });
  });

  test('a final bundle latches too, even when my own record of signing it was lost', async () => {
    const w = await afterOneHand(15);
    const [a] = w.clients;
    const old = a.storage.map.get(keyOfTable(w));
    honestRound(w, w.server.finalState(w.server.keepFor()), { handNo: null, reason: 'drain' });
    a.storage.map.set(keyOfTable(w), old);
    expect(a.signer.acceptBundle(w.server.bundleMessage(w.server.lastBundle))).toMatchObject({
      stored: true,
      final: true,
    });
    expect(a.signer.restore(w.tableKey).record).toMatchObject({ epochClosed: true });
  });
});

describe('noteLeave: the leave intent, bounded by my own records', () => {
  test('the server ack is taken, but never more than one state past the newest I hold; the first press wins', async () => {
    const w = await afterOneHand(16);
    const [a, b, c] = w.clients;
    expect(a.signer.noteLeave(w.tableKey, 1n)).toEqual({ ok: true, leaveAckNonce: 1n });
    expect(a.signer.noteLeave(w.tableKey, 5)).toEqual({
      ok: true,
      leaveAckNonce: 1n,
      already: true,
    });
    expect(b.signer.noteLeave(w.tableKey, '99')).toEqual({ ok: true, leaveAckNonce: 2n });
    expect(c.signer.noteLeave(w.tableKey, null)).toEqual({ ok: true, leaveAckNonce: 1n });
    expect(storedRecord(b.storage, w.tableKey).leaveAckNonce).toBe('2');
    expect(() => a.signer.noteLeave(w.tableKey, -1)).toThrow(TypeError);
    expect(() => a.signer.noteLeave(w.tableKey, 'x')).toThrow(TypeError);
    const fresh = makeWorld({ seed: 16 }).clients[0];
    fresh.signer.ensureSessionKey(w.tableKey);
    expect(fresh.signer.noteLeave(w.tableKey, 4n)).toEqual({ ok: true, leaveAckNonce: 1n });
    expect(createSigner({ storage: memoryStorage() }).noteLeave(w.tableKey, 1n)).toMatchObject({
      ok: false,
      reason: 'none',
    });
  });

  test('after Leave: a final keeping me is refused above the ack and signed at or below it', async () => {
    const w = await afterOneHand(16);
    const [a, b] = w.clients;
    a.signer.noteLeave(w.tableKey, w.server.head.nonce + 1n); // a hand-end state was in flight
    // the in-flight hand ends with someone else's rotation folded in: it keeps me, and I sign it
    const { tbl, state } = w.server.hand({
      winner: a,
      loser: b,
      amount: 10,
      rake: 0,
      final: true,
      keep: w.server.keepFor(),
    });
    publish(w, tbl);
    expect(a.signer.handleSignReq(w.server.propose(state), { ledger: a.ledger })).toMatchObject({
      action: 'send',
    });
    // one state later the same keep would be refused: covered in hostile.test.js with a fresh epoch
  });

  test('a write failure is reported', async () => {
    const w = await afterOneHand(16);
    const [a] = w.clients;
    a.storage.modes.failSet = true;
    expect(a.signer.noteLeave(w.tableKey, 1n)).toMatchObject({ ok: false, reason: 'storage' });
  });
});

describe("forget: only on the chain's word, after the exit window", () => {
  test('refused unless both facts are true; then the record is gone', async () => {
    const w = await afterOneHand(17);
    const [a] = w.clients;
    for (const facts of [
      undefined,
      {},
      { chainShowsDone: true },
      { exitWindowPassed: true },
      { chainShowsDone: 'yes', exitWindowPassed: true },
    ]) {
      expect(a.signer.forget(w.tableKey, facts).ok).toBe(false);
      expect(a.storage.map.has(keyOfTable(w))).toBe(true);
    }
    expect(a.signer.forget(w.tableKey, { chainShowsDone: true })).toEqual({
      ok: false,
      reason: 'too-early',
    });
    expect(a.signer.forget(w.tableKey, { exitWindowPassed: true })).toEqual({
      ok: false,
      reason: 'chain-not-done',
    });
    expect(a.signer.forget(w.tableKey, { chainShowsDone: true, exitWindowPassed: true })).toEqual({
      ok: true,
    });
    expect(a.storage.map.has(keyOfTable(w))).toBe(false);
    expect(a.signer.restore(w.tableKey)).toEqual({ ok: true, record: null });
  });

  test('a storage that will not delete is reported', async () => {
    const w = await afterOneHand(17);
    const [a] = w.clients;
    const facts = { chainShowsDone: true, exitWindowPassed: true };
    a.storage.removeItem = () => {};
    expect(a.signer.forget(w.tableKey, facts)).toMatchObject({ ok: false, reason: 'storage' });
    a.storage.removeItem = () => {
      throw new Error('denied');
    };
    expect(a.signer.forget(w.tableKey, facts)).toMatchObject({ ok: false, reason: 'storage' });
  });

  test('no server message deletes anything: the record survives every message type', async () => {
    const w = await afterOneHand(17);
    const [a] = w.clients;
    const raw = a.storage.map.get(keyOfTable(w));
    const removals = () => a.storage.calls.filter(([name]) => name === 'removeItem').length;
    await a.signer.handleEpoch({ ...w.epochMessage, epoch: 9, state: null }, a.ctx());
    a.signer.handleSignReq({ t: 'signreq', state: null }, { ledger: a.ledger });
    a.signer.acceptBundle({ t: 'bundle' });
    expect(removals()).toBe(0);
    expect(a.storage.map.get(keyOfTable(w))).toBe(raw);
  });
});

describe('failure(): the worst thing on record', () => {
  test('null when clean; blocking kinds outrank informational ones; kinds lists all', async () => {
    const w = await afterOneHand(18);
    const [a, b] = w.clients;
    expect(a.signer.failure(w.tableKey)).toBeNull();
    const { state, req } = nextRequest(w, { winner: b, loser: a, amount: 5, rake: 0 });
    // a refusal (wrong digest field) first, then an equivocation
    a.signer.handleSignReq(w.server.propose(state, { digest: `0x${'00'.repeat(32)}` }), {
      ledger: a.ledger,
    });
    expect(a.signer.failure(w.tableKey)).toMatchObject({
      kind: 'refused',
      rule: 'C1d',
      blocking: false,
    });
    a.signer.handleSignReq(req, { ledger: a.ledger });
    a.signer.handleSignReq(w.server.propose({ ...state, volume: state.volume + 1n }), {
      ledger: a.ledger,
    });
    expect(a.signer.failure(w.tableKey)).toMatchObject({
      kind: 'equivocation',
      blocking: true,
      kinds: ['refused', 'equivocation'],
    });
    expect(Object.keys(FAILURE_KINDS)).toEqual([
      'lost-key',
      'corrupt',
      'equivocation',
      'bundle-conflict',
      'storage',
      'refused',
      'unpinned',
    ]);
  });

  test('repeated refusals are recorded once, and the list stays short but keeps every blocking failure', async () => {
    const w = await afterOneHand(18);
    const [a, b] = w.clients;
    const { state } = nextRequest(w, { winner: b, loser: a, amount: 5, rake: 0 });
    const lie = w.server.propose(state, { digest: `0x${'00'.repeat(32)}` });
    a.signer.handleSignReq(lie, { ledger: a.ledger });
    a.signer.handleSignReq(lie, { ledger: a.ledger });
    expect(storedRecord(a.storage, w.tableKey).failures).toHaveLength(1);
    // twenty different refused proposals: the list is capped at 16
    for (let i = 1; i <= 20; i++) {
      a.signer.handleSignReq(w.server.propose({ ...state, nonce: state.nonce + BigInt(i) }), {
        ledger: a.ledger,
      });
    }
    const failures = storedRecord(a.storage, w.tableKey).failures;
    expect(failures.length).toBe(16);
    expect(failures.at(-1).nonce).toBe(`${state.nonce + 20n}`);
    // a blocking failure still gets in: the oldest refusal makes room for it
    a.signer.handleSignReq(w.server.propose(state), { ledger: a.ledger });
    a.signer.handleSignReq(w.server.propose({ ...state, volume: 1n }), { ledger: a.ledger });
    const capped = storedRecord(a.storage, w.tableKey).failures;
    expect(capped).toHaveLength(16);
    expect(capped.at(-1)).toMatchObject({ kind: 'equivocation' });
    expect(capped[0].nonce).toBe(`${state.nonce + 6n}`);
    expect(a.signer.failure(w.tableKey)).toMatchObject({ kind: 'equivocation' });
  });

  test('a list full of blocking failures drops the newest alarm rather than any of them', async () => {
    const w = await afterOneHand(18);
    const [a] = w.clients;
    const record = storedRecord(a.storage, w.tableKey);
    record.failures = Array.from({ length: 16 }, (_, i) => ({
      kind: 'bundle-conflict',
      rule: null,
      detail: `#${i}`,
      nonce: `${100 + i}`,
    }));
    a.storage.map.set(keyOfTable(w), JSON.stringify(record));
    // one more alarm: all keys signed a twin of the held bundle
    const held = w.server.lastBundle.state;
    const twin = { ...held, volume: held.volume + UNIT };
    const digest = hashState(twin, DOMAIN);
    const bundle = makeBundle({
      domain: DOMAIN,
      state: twin,
      arbiterSig: signDigest(w.arbiterKey, digest),
      playerSigs: w.server.roster.map((c) => signDigest(c.sessionKey, digest)),
    });
    expect(a.signer.acceptBundle(w.server.bundleMessage(bundle))).toMatchObject({
      reason: 'conflict',
    });
    const after = storedRecord(a.storage, w.tableKey).failures;
    expect(after.map((f) => f.detail)).toEqual(record.failures.map((f) => f.detail));
  });
});

describe('signClaim', () => {
  test('a claim signed with the session key verifies against the session address; the key never leaves', async () => {
    const w = await startedWorld({ seed: 19 });
    const [a] = w.clients;
    const claim = a.signer.signClaim(w.tableKey, { playerId: 'p-1' });
    expect(claim).toMatchObject({ ok: true, address: a.sessionAddress });
    const facts = { domain: DOMAIN, tableKey: w.tableKey, address: a.wallet, playerId: 'p-1' };
    expect(verifyClaim(facts, claim.sig, a.sessionAddress)).toBe(true);
    expect(
      a.signer.signClaim(w.tableKey, { playerId: 'p-1', domain: { ...DOMAIN, chainId: 1 } }),
    ).toMatchObject({
      ok: false,
      kind: 'other-domain',
    });
    expect(
      a.signer.signClaim(w.tableKey, { playerId: 'p-1', wallet: w.clients[1].wallet }),
    ).toMatchObject({
      ok: false,
      kind: 'other-wallet',
    });
    // before the first epoch the caller names the domain and wallet
    const fresh = makeWorld({ seed: 19 });
    const f = fresh.clients[0];
    f.signer.ensureSessionKey(fresh.tableKey);
    const early = f.signer.signClaim(fresh.tableKey, {
      playerId: 'p',
      domain: DOMAIN,
      wallet: f.wallet,
    });
    expect(
      verifyClaim(
        { ...facts, tableKey: fresh.tableKey, address: f.wallet, playerId: 'p' },
        early.sig,
        f.sessionAddress,
      ),
    ).toBe(true);
    expect(
      createSigner({ storage: memoryStorage() }).signClaim(fresh.tableKey, { playerId: 'p' }),
    ).toMatchObject({
      ok: false,
      kind: 'none',
    });
  });
});

describe('the signer over a real createRpcChainView (a fake node that answers eth_call)', () => {
  // The node answers tables() and seats() from the FakeChainView's state, ABI-encoded by viem, so the
  // signer is exercised through the very decoder a browser uses.
  const outputs = (name) =>
    pokerVaultAbi.find((e) => e.type === 'function' && e.name === name).outputs;
  const FIELDS = [
    'status',
    'maxPlayers',
    'seated',
    'arbiter',
    'nonce',
    'exitDeadline',
    'minDeposit',
    'maxDeposit',
    'escrow',
    'rakePaid',
    'rosterHash',
    'exitDigest',
  ];

  function nodeFor(chain) {
    return async (_url, init) => {
      const { id, params } = JSON.parse(init.body);
      const call = decodeFunctionData({ abi: pokerVaultAbi, data: params[0].data });
      let result;
      if (call.functionName === 'tables') {
        const row = chain.tables.get(call.args[0]);
        result = encodeAbiParameters(
          outputs('tables'),
          FIELDS.map((f) =>
            row
              ? row[f]
              : f === 'arbiter'
                ? `0x${'00'.repeat(20)}`
                : f.endsWith('Hash') || f === 'exitDigest'
                  ? `0x${'00'.repeat(32)}`
                  : 0,
          ),
        );
      } else {
        const seat = chain.seats.get(`${call.args[0]}:${call.args[1].toLowerCase()}`);
        result = encodeAbiParameters(outputs('seats'), [
          seat?.deposit ?? 0n,
          seat?.sessionKey ?? `0x${'00'.repeat(20)}`,
        ]);
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ jsonrpc: '2.0', id, result }),
      };
    };
  }

  test('pins an epoch, signs a hand, and refuses a replayed genesis after a final until the chain settles', async () => {
    const w = makeWorld({ seed: 20 });
    const rpc = createRpcChainView({
      rpcUrl: 'http://node.invalid',
      vault: DOMAIN.verifyingContract,
      fetch: nodeFor(w.chain),
    });
    for (const c of w.clients) {
      c.signer = createSigner({ storage: c.storage, chainView: rpc, newKey: () => c.sessionKey });
      w.depositFor(c);
    }
    const epoch = w.server.startEpoch(w.clients);
    for (const c of w.clients)
      expect(await c.signer.handleEpoch(epoch, c.ctx())).toEqual({ ok: true });
    const [a, b] = w.clients;
    playHand(w, { winner: a, loser: b, amount: 30, rake: 1 });
    honestRound(w, w.server.finalState(w.server.keepFor()), { handNo: null, reason: 'drain' });
    const fake = {
      ...epoch,
      epoch: 2,
      state: toWire(
        epochBaseline({
          tableId: w.tableKey,
          players: w.server.genesis.players,
          deposits: w.server.lastBundle.state.balances,
          nonce: w.server.lastBundle.state.nonce,
          rake: w.server.lastBundle.state.rake,
          volume: w.server.lastBundle.state.volume,
        }),
      ),
    };
    expect(await a.signer.handleEpoch(fake, a.ctx())).toMatchObject({
      ok: false,
      rule: 'FINAL-LATCHED',
    });
    w.server.settleOnChain();
    const real = w.server.startEpoch(w.clients);
    expect(real.state).toEqual(fake.state);
    expect(await a.signer.handleEpoch(real, a.ctx())).toEqual({ ok: true });
  });
});

describe('README: the signer example is the code that runs', () => {
  test('README.md contains a runnable signer example, and it does what its comments say', async () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const start = readme.indexOf('```js\n// Signer example');
    expect(start).toBeGreaterThan(0);
    const code = readme.slice(start + 6, readme.indexOf('```', start + 6));
    const src = new URL('../src/index.js', import.meta.url).pathname;
    const dir = mkdtempSync(join(tmpdir(), 'pgg-signer-example-'));
    const file = join(dir, 'example.js');
    writeFileSync(file, code.replace("from '@pgg/vault'", `from ${JSON.stringify(src)}`));
    const { main } = await import(file);
    const r = await main();
    expect(r.key).toMatchObject({ ok: true, created: true });
    expect(r.pinned).toEqual({ ok: true });
    expect(r.signed).toMatchObject({ action: 'send' });
    expect(r.again).toEqual(r.signed);
    expect(r.stored).toMatchObject({ stored: true });
    expect(r.lie).toMatchObject({ action: 'refuse', rule: 'C1b' });
    expect(r.twin).toMatchObject({ action: 'refuse', rule: 'C1a' });
    expect(r.failure).toMatchObject({ kind: 'equivocation', blocking: true });
    expect(r.recorded).toBe(true);
  });
});
