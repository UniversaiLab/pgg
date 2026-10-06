// A MaliciousServer drives the real signer, ledger, rules and chain view through the attacks in
// docs/signing-layer.md section 8 and docs/trust-model.md (client rules C1 and C2, chain-pinned epochs F1, the
// ledger F8). For every attack: no signature leaves, the client's record of what it signed does not move, no
// storage write ever carries the signature the lie asked for, and the failure recorded is the one the spec names
// (blocking for equivocation; informational otherwise, so the honest state that follows is still signed). The
// honest run at the end proves the guards never stall a table that plays by the rules.
import { describe, expect, test } from 'bun:test';
import { buildNextState, epochBaseline } from '../src/build.js';
import { makeBundle } from '../src/bundle.js';
import { UINT64_MAX } from '../src/bytes.js';
import { STATUS } from '../src/check.js';
import { hashState } from '../src/eip712.js';
import { signDigest } from '../src/sign.js';
import { createSigner } from '../src/signer.js';
import { toWire } from '../src/state.js';
import {
  DOMAIN,
  honestRound,
  makeWorld,
  playHand,
  publish,
  Server,
  startedWorld,
  storedRecord,
  UNIT,
  VAULT,
} from './signer-world.js';

const OTHER_DOMAIN = Object.freeze({ chainId: 1, verifyingContract: VAULT });

/** The scripted server, plus the lies an honest one never tells. Each returns a message, nothing is checked. */
class MaliciousServer extends Server {
  /** The roster index of a client in state order. */
  at(client) {
    return this.roster.indexOf(client);
  }

  /** `state` with `chips` moved from one player's balance to another's (conservation still holds). */
  moveChips(state, from, to, chips) {
    const balances = [...state.balances];
    balances[this.at(from)] -= BigInt(chips) * UNIT;
    balances[this.at(to)] += BigInt(chips) * UNIT;
    return { ...state, balances };
  }

  /** A standalone state after the head with the stacks unchanged (no hand behind it). */
  standalone(over = {}) {
    return { ...buildNextState({ prev: this.head, balances: this.balances() }), ...over };
  }

  /** A fake epoch: the genesis an honest server would announce after the last bundle settled. */
  fakeEpochAfter(bundle) {
    const s = bundle.state;
    const genesis = epochBaseline({
      tableId: s.tableId,
      players: s.players,
      deposits: s.balances,
      nonce: s.nonce,
      rake: s.rake,
      volume: s.volume,
    });
    return this.epochMessage(genesis, { epoch: this.epoch + 1 });
  }
}

const hostileWorld = (seed, options = {}) =>
  startedWorld({ seed, ServerClass: MaliciousServer, ...options });

/**
 * Ask `client` to sign `req` and prove nothing was signed: the answer is not a signature, the record's `last`
 * is unchanged, and no storage write carries the signature over the requested state.
 */
function attempt(w, client, req) {
  const before = JSON.stringify(storedRecord(client.storage, w.tableKey).last);
  const writes = client.storage.calls.length;
  const answer = client.signer.handleSignReq(req, { ledger: client.ledger });
  expect(answer.action).not.toBe('send');
  expect(JSON.stringify(storedRecord(client.storage, w.tableKey).last)).toBe(before);
  let forbidden = null;
  try {
    forbidden = signDigest(client.sessionKey, hashState(req.state, DOMAIN)).slice(2);
  } catch {
    // a state that cannot even be hashed cannot have been signed
  }
  if (forbidden !== null) {
    for (const [name, , value] of client.storage.calls.slice(writes)) {
      if (name === 'setItem') expect(value.includes(forbidden)).toBe(false);
    }
  }
  return answer;
}

/** The failure on record, as the UI would show it. */
const failureOf = (w, client) => client.signer.failure(w.tableKey);

// One honest hand, then the attack. The hand gives every client a signed state and a stored bundle, so the
// attacks run against a table that is really in play.
async function inPlay(seed) {
  const w = await hostileWorld(seed);
  const [a, b] = w.clients;
  playHand(w, { winner: a, loser: b, amount: 50, rake: 1 });
  return w;
}

describe('sign requests a hostile server sends: nothing is signed', () => {
  // Each attack: build the lie (after any honest table messages it needs), the rule that must refuse it, and
  // the honest state for the same moment, which must still be signed afterwards (unless the failure blocks).
  const attacks = [
    {
      name: 'a lower nonce',
      rule: 'C1a',
      make: (w) => ({
        lie: w.server.standalone({ nonce: w.server.head.nonce - 1n }),
        handNo: null,
      }),
    },
    {
      name: 'a nonce jump to 2^64-1',
      rule: 'C1a',
      make: (w) => ({ lie: w.server.standalone({ nonce: UINT64_MAX }), handNo: null }),
    },
    {
      name: 'my balance altered by a hand nobody played',
      rule: 'C1b',
      make: (w) => {
        const [a, b] = w.clients;
        return { lie: w.server.moveChips(w.server.standalone(), a, b, 100), handNo: null };
      },
    },
    {
      name: 'my balance altered inside a real hand',
      rule: 'C1b',
      make: (w) => {
        const [a, b, c] = w.clients;
        const { tbl, state } = w.server.hand({ winner: b, loser: c, amount: 40, rake: 1 });
        publish(w, tbl);
        return { lie: w.server.moveChips(state, a, b, 5), honest: state, handNo: w.server.handNo };
      },
    },
    {
      name: "someone else's balance altered, mine intact (conservation holds, the stacks do not)",
      rule: 'C1b',
      make: (w) => {
        const [, b, c] = w.clients;
        const { tbl, state } = w.server.hand({ winner: b, loser: c, amount: 40, rake: 1 });
        publish(w, tbl);
        return { lie: w.server.moveChips(state, c, b, 5), honest: state, handNo: w.server.handNo };
      },
    },
    {
      name: 'rake that does not match the stacks (taken from the winner, so it still conserves)',
      rule: 'C1b',
      make: (w) => {
        const [, b, c] = w.clients;
        const { tbl, state } = w.server.hand({ winner: b, loser: c, amount: 40, rake: 1 });
        publish(w, tbl);
        const balances = [...state.balances];
        balances[w.server.at(b)] -= 3n * UNIT;
        const lie = { ...state, balances, rake: state.rake + 3n * UNIT };
        return { lie, honest: state, handNo: w.server.handNo };
      },
    },
    {
      name: 'chips that leave the table without being rake (conservation broken)',
      rule: 'C1c',
      make: (w) => {
        const [a] = w.clients;
        const lie = w.server.standalone();
        lie.balances = [...lie.balances];
        lie.balances[w.server.at(a)] -= UNIT;
        return { lie, handNo: null };
      },
    },
    {
      name: 'rake that goes down',
      rule: 'C1e',
      make: (w) => {
        const [a] = w.clients;
        const lie = w.server.standalone({ rake: w.server.head.rake - UNIT });
        lie.balances = [...lie.balances];
        lie.balances[w.server.at(a)] += UNIT;
        return { lie, handNo: null };
      },
    },
    {
      name: 'volume that goes down',
      rule: 'C1b',
      make: (w) => ({
        lie: w.server.standalone({ volume: w.server.head.volume - UNIT }),
        handNo: null,
      }),
    },
    {
      name: 'a keep flag on a state that is not final',
      rule: 'C2',
      make: (w) => {
        const honest = w.server.standalone();
        return {
          lie: { ...honest, keep: honest.keep.map((_, i) => i === 0) },
          honest,
          handNo: null,
        };
      },
    },
    {
      name: 'a final that keeps a bust player (dust alone never keeps a seat)',
      rule: 'C2',
      make: (w) => {
        const [a, b] = w.clients;
        const all = w.server.seatOf(b).chips;
        const { tbl, state } = w.server.hand({
          winner: a,
          loser: b,
          amount: all,
          rake: 1,
          final: true,
          keep: w.server.roster.map((c) => c !== b), // b busts in this hand
        });
        publish(w, tbl);
        expect(state.keep[w.server.at(b)]).toBe(false); // the honest fold pays the bust player out
        const keep = state.keep.map(() => true);
        return { lie: { ...state, keep }, honest: state, handNo: w.server.handNo };
      },
    },
    {
      name: 'a digest field that lies about the state',
      rule: 'C1d',
      make: (w) => {
        const honest = w.server.standalone();
        return { lie: honest, digest: `0x${'ab'.repeat(32)}`, honest, handNo: null };
      },
    },
    {
      name: 'a digest computed under another chain (wrong domain)',
      rule: 'C1d',
      make: (w) => {
        const honest = w.server.standalone();
        return { lie: honest, digest: hashState(honest, OTHER_DOMAIN), honest, handNo: null };
      },
    },
    {
      name: 'a request for an epoch that is over',
      rule: 'STALE-EPOCH',
      make: (w) => {
        const honest = w.server.standalone();
        return { lie: honest, epoch: w.server.epoch - 1, honest, handNo: null };
      },
    },
    {
      name: 'two different hand-end results for one hand (the server contradicts itself)',
      rule: 'LEDGER',
      make: (w) => {
        const [a, b] = w.clients;
        const { tbl, result, state } = w.server.hand({ winner: a, loser: b, amount: 20, rake: 1 });
        publish(w, tbl);
        const other = { ...result, rake: 0, pot: 2 };
        publish(w, w.server.tableMessage({ events: [{ type: 'hand-end', result: other }] }));
        return { lie: state, handNo: w.server.handNo, blocksHonest: true };
      },
    },
    {
      name: 'a hand-end result the shown stacks contradict',
      rule: 'LEDGER',
      make: (w) => {
        const [a, b] = w.clients;
        const { result, state } = w.server.hand({ winner: a, loser: b, amount: 20, rake: 1 });
        const stacks = [...result.stacks];
        stacks[w.server.seatOf(a).seat] += 7;
        publish(
          w,
          w.server.tableMessage({ events: [{ type: 'hand-end', result: { ...result, stacks } }] }),
        );
        return { lie: state, handNo: w.server.handNo, blocksHonest: true };
      },
    },
  ];

  for (const attack of attacks) {
    test(`${attack.name}: refused with ${attack.rule}, and the table goes on`, async () => {
      const w = await inPlay(31);
      const { lie, honest, handNo, digest, epoch, blocksHonest } = attack.make(w);
      const req = w.server.propose(lie, { handNo, digest, epoch });
      for (const client of w.clients) {
        const answer = attempt(w, client, req);
        expect(answer).toMatchObject({ action: 'refuse', rule: attack.rule });
        // a refusal is on record for the UI, but it does not block: only equivocation and friends do
        expect(failureOf(w, client)).toMatchObject({ kind: 'refused', blocking: false });
      }
      if (blocksHonest) return; // the server's own accounts of this hand disagree: nothing more is signed for it
      // the honest state for the same moment is still signed by everyone
      const next = honest ?? w.server.standalone();
      honestRound(w, next, { handNo });
    });
  }

  test('a different state at a nonce I signed: equivocation, and nothing is signed at this table again', async () => {
    const w = await inPlay(32);
    const [a, b, c] = w.clients;
    const { tbl, state } = w.server.hand({ winner: b, loser: c, amount: 30, rake: 1 });
    publish(w, tbl);
    const req = w.server.propose(state, { handNo: w.server.handNo });
    const signed = a.signer.handleSignReq(req, { ledger: a.ledger });
    expect(signed.action).toBe('send');
    // the same nonce again with the volume nudged: another digest for one economic state
    const twin = w.server.propose(
      { ...state, volume: state.volume + 1n },
      { handNo: w.server.handNo },
    );
    expect(attempt(w, a, twin)).toMatchObject({ action: 'refuse', rule: 'C1a' });
    expect(failureOf(w, a)).toMatchObject({ kind: 'equivocation', blocking: true });
    // from now on nothing is signed at this table, not even a re-send of the state it signed before
    expect(a.signer.handleSignReq(req, { ledger: a.ledger })).toMatchObject({
      action: 'refuse',
      rule: 'FAILED',
    });
    const after = w.server.standalone({ nonce: state.nonce + 1n });
    expect(attempt(w, a, w.server.propose(after, { handNo: null }))).toMatchObject({
      rule: 'FAILED',
    });
    // the failure survives a reload: a new signer over the same storage still refuses
    const reloaded = createSigner({ storage: a.storage, chainView: w.chain });
    expect(reloaded.failure(w.tableKey)).toMatchObject({ kind: 'equivocation', blocking: true });
    expect(reloaded.handleSignReq(req, { ledger: a.ledger })).toMatchObject({ rule: 'FAILED' });
  });

  test('a table still in a hand, or a seat with no address yet: wait, sign nothing, then sign once it is shown', async () => {
    const w = await inPlay(33);
    const [a, b] = w.clients;
    const { tbl, state } = w.server.hand({ winner: a, loser: b, amount: 20, rake: 1 });
    publish(w, w.server.tableMessage({ inHand: true }));
    const req = w.server.propose(state, { handNo: w.server.handNo });
    for (const client of w.clients) {
      expect(attempt(w, client, req)).toMatchObject({ action: 'wait', reason: 'mid-hand' });
    }
    const seats = w.server.seats.map((s) => (s.client === b ? { ...s, address: null } : s));
    publish(w, w.server.tableMessage({ seats }));
    for (const client of w.clients) {
      expect(attempt(w, client, req)).toMatchObject({ action: 'wait', reason: 'unknown-address' });
      expect(failureOf(w, client)).toBeNull(); // waiting is not a failure
    }
    publish(w, tbl);
    honestRound(w, state, { handNo: w.server.handNo });
  });
});

describe('finals: one per epoch, and nothing after it', () => {
  async function afterFinal(seed) {
    const w = await inPlay(seed);
    honestRound(w, w.server.finalState(w.server.keepFor()), { handNo: null, reason: 'drain' });
    return w;
  }

  test('a second final, a hand after the final, or a standalone state after it: C2, nothing signed', async () => {
    const w = await afterFinal(34);
    const [a, b] = w.clients;
    const lies = [
      w.server.finalState(w.server.keepFor()),
      w.server.standalone(),
      w.server.hand({ winner: a, loser: b, amount: 10, rake: 0 }).state,
    ];
    for (const lie of lies) {
      const req = w.server.propose(lie, { handNo: null });
      for (const client of w.clients) {
        expect(attempt(w, client, req)).toMatchObject({ action: 'refuse', rule: 'C2' });
      }
    }
  });

  test('a fake epoch after a signed final is refused until the chain shows the final settled', async () => {
    const w = await afterFinal(35);
    const fake = w.server.fakeEpochAfter(w.server.lastBundle);
    for (const client of w.clients) {
      expect(await client.signer.handleEpoch(fake, client.ctx())).toMatchObject({
        ok: false,
        rule: 'FINAL-LATCHED',
      });
    }
    // the same message once the chain really settled and started the next epoch: accepted
    w.server.settleOnChain();
    const real = w.server.startEpoch(w.clients);
    expect(real.state).toEqual(fake.state);
    for (const client of w.clients) {
      expect(await client.signer.handleEpoch(real, client.ctx())).toEqual({ ok: true });
    }
  });

  test('a server that withholds the final bundle: the signed final latches anyway, and the settle opens it', async () => {
    const w = await inPlay(37);
    const [a, b, c] = w.clients;
    const final = w.server.finalState(w.server.keepFor([c]));
    const req = w.server.propose(final, { handNo: null, reason: 'leave' });
    for (const client of w.clients)
      w.server.collect(client, client.signer.handleSignReq(req, { ledger: client.ledger }));
    w.server.bundle(); // every signature is in, but the bundle message is never sent
    const fake = w.server.fakeEpochAfter(w.server.lastBundle);
    for (const client of w.clients) {
      expect(await client.signer.handleEpoch(fake, client.ctx())).toMatchObject({
        ok: false,
        rule: 'FINAL-LATCHED',
      });
    }
    w.server.settleOnChain();
    for (const client of [a, b]) {
      const fresh = await w.chain.table(w.tableKey);
      expect(client.signer.settledObserved(w.tableKey, fresh.table)).toEqual({
        ok: true,
        cleared: true,
      });
    }
    // what each carries into the next epoch is the balance the final kept for it, so the next epoch pins
    const next = w.server.startEpoch([a, b]);
    for (const client of [a, b])
      expect(await client.signer.handleEpoch(next, client.ctx())).toEqual({ ok: true });
  });

  test('a lower nonce while a hand is running is refused at once, not waited on', async () => {
    const w = await inPlay(38);
    publish(w, w.server.tableMessage({ inHand: true }));
    const req = w.server.propose(w.server.standalone({ nonce: w.server.head.nonce - 1n }), {
      handNo: null,
    });
    for (const client of w.clients)
      expect(attempt(w, client, req)).toMatchObject({ action: 'refuse', rule: 'C1a' });
  });

  test('a fake epoch while the chain is not started yet (Filling after the settle) pins nothing', async () => {
    const w = await afterFinal(36);
    w.server.settleOnChain();
    const early = w.server.openEpoch(w.clients); // announced before start(): the chain is still Filling
    for (const client of w.clients) {
      expect(await client.signer.handleEpoch(early, client.ctx())).toMatchObject({
        ok: false,
        rule: 'status',
      });
      const record = storedRecord(client.storage, w.tableKey);
      expect(record.pinned.epoch).toBe(1);
    }
  });
});

describe('epoch messages a hostile server sends: nothing is pinned', () => {
  async function deposited(seed) {
    const w = makeWorld({ seed, ServerClass: MaliciousServer });
    for (const c of w.clients) w.depositFor(c);
    return w;
  }

  const pinnedEpoch = (w, client) => storedRecord(client.storage, w.tableKey).pinned;

  test('a roster missing a real depositor: the chain roster says otherwise', async () => {
    const w = await deposited(40);
    const [a, b, c] = w.clients;
    w.chain.start(w.tableKey, [a, b, c].map((x) => x.wallet).sort()); // the chain started all three
    const short = w.server.openEpoch([a, b]);
    for (const client of [a, b]) {
      expect(await client.signer.handleEpoch(short, client.ctx())).toMatchObject({
        ok: false,
        rule: 'roster',
      });
      expect(pinnedEpoch(w, client)).toBeNull();
    }
    expect(await c.signer.handleEpoch(short, c.ctx())).toMatchObject({
      ok: false,
      rule: 'NOT-MEMBER',
    });
  });

  test('another chain, another key for my seat, or my chips moved to another seat', async () => {
    const w = await deposited(41);
    const [a, b] = w.clients;
    const honest = w.server.startEpoch(w.clients);
    const wrongDomain = { ...honest, domain: OTHER_DOMAIN };
    expect(await a.signer.handleEpoch(wrongDomain, a.ctx())).toMatchObject({
      ok: false,
      rule: 'DOMAIN',
    });

    const keys = [...honest.sessionKeys];
    const ia = w.server.at(a);
    const ib = w.server.at(b);
    [keys[ia], keys[ib]] = [keys[ib], keys[ia]];
    expect(await a.signer.handleEpoch({ ...honest, sessionKeys: keys }, a.ctx())).toMatchObject({
      ok: false,
      rule: 'MY-KEY',
    });

    // the escrow still adds up, but 100 chips of mine sit on b's seat
    const moved = w.server.moveChips(w.server.genesis, a, b, 100);
    const stolen = w.server.epochMessage(moved);
    expect(await a.signer.handleEpoch(stolen, a.ctx())).toMatchObject({
      ok: false,
      rule: 'my-balance',
    });
    expect(await b.signer.handleEpoch(stolen, b.ctx())).toMatchObject({
      ok: false,
      rule: 'my-balance',
    });
    for (const client of [a, b]) expect(pinnedEpoch(w, client)).toBeNull();

    // the honest message after all that is still accepted
    for (const client of w.clients)
      expect(await client.signer.handleEpoch(honest, client.ctx())).toEqual({ ok: true });
  });

  test('no chain view: refused (UNPINNED) unless the app explicitly allows it, which is then a lasting warning', async () => {
    const w = makeWorld({ seed: 42, chainView: false, ServerClass: MaliciousServer });
    for (const c of w.clients) w.depositFor(c);
    const epoch = w.server.startEpoch(w.clients);
    const [a] = w.clients;
    expect(await a.signer.handleEpoch(epoch, a.ctx())).toMatchObject({
      ok: false,
      rule: 'UNPINNED',
    });
    expect(await a.signer.handleEpoch(epoch, a.ctx({ allowUnpinned: true }))).toEqual({
      ok: true,
      unpinned: true,
    });
    expect(failureOf(w, a)).toMatchObject({ kind: 'unpinned', blocking: false });
  });
});

describe('bundles a hostile server sends: nothing is stored', () => {
  test('a forged signature, another domain, a lower nonce, a replay: not stored, and the newest stays', async () => {
    const w = await inPlay(50);
    const [a, b] = w.clients;
    const first = w.server.lastBundle;
    playHand(w, { winner: b, loser: a, amount: 20, rake: 1 });
    const newest = w.server.lastBundle;
    const held = () => storedRecord(a.storage, w.tableKey).bundle.state.nonce;
    expect(held()).toBe(newest.state.nonce.toString());

    const forger = signDigest(`0x${'77'.repeat(32)}`, hashState(newest.state, DOMAIN));
    const next = w.server.standalone();
    const nextDigest = hashState(next, DOMAIN);
    const forged = makeBundle({
      domain: DOMAIN,
      state: next,
      arbiterSig: signDigest(w.arbiterKey, nextDigest),
      playerSigs: w.server.roster.map(() => forger),
    });
    expect(a.signer.acceptBundle(w.server.bundleMessage(forged))).toMatchObject({
      stored: false,
      reason: 'invalid',
    });

    const elsewhere = makeBundle({ ...newest, domain: OTHER_DOMAIN });
    expect(a.signer.acceptBundle(w.server.bundleMessage(elsewhere))).toMatchObject({
      stored: false,
    });
    expect(a.signer.acceptBundle(w.server.bundleMessage(first))).toMatchObject({
      stored: false,
      reason: 'not-newer',
    });
    expect(a.signer.acceptBundle(w.server.bundleMessage(newest))).toMatchObject({
      stored: false,
      reason: 'duplicate',
    });
    expect(held()).toBe(newest.state.nonce.toString());
    expect(failureOf(w, a)).toBeNull();
  });
});

describe('the honest table is never refused', () => {
  test('hands (watched, missed, aborted), a leave folded into a hand, the settle, and a second epoch', async () => {
    const w = await hostileWorld(60);
    const [a, b, c] = w.clients;
    playHand(w, { winner: a, loser: b, amount: 50, rake: 1 });
    playHand(w, { winner: c, loser: a, amount: 30, rake: 1 });

    // c misses the hand live (a dropped socket) and only sees the table afterwards: the pot is unknown to it
    const missed = w.server.hand({ winner: b, loser: c, amount: 25, rake: 1 });
    publish(w, missed.tbl, [a, b]);
    publish(w, w.server.tableMessage(), [c]);
    honestRound(w, missed.state, { handNo: w.server.handNo });

    // an aborted hand: nobody's stack moved, and the state that follows no hand is signed as it is
    honestRound(w, w.server.standalone(), { handNo: null, reason: 'hand' });

    // c presses Leave; the next hand ends the epoch with c paid out
    const left = c.signer.noteLeave(w.tableKey, w.server.head.nonce);
    expect(left.ok).toBe(true);
    const last = w.server.hand({
      winner: a,
      loser: b,
      amount: 10,
      rake: 1,
      final: true,
      keep: w.server.keepFor([c]),
    });
    publish(w, last.tbl);
    honestRound(w, last.state, { handNo: w.server.handNo });

    // the settle, seen on a fresh chain read, opens the latch; the next epoch is a and b
    w.server.settleOnChain();
    for (const client of w.clients) {
      const fresh = await w.chain.table(w.tableKey);
      expect(fresh.table.status).toBe(STATUS.Filling);
      expect(client.signer.settledObserved(w.tableKey, fresh.table)).toEqual({
        ok: true,
        cleared: true,
      });
    }
    const epoch2 = w.server.startEpoch([a, b]);
    for (const client of [a, b])
      expect(await client.signer.handleEpoch(epoch2, client.ctx())).toEqual({ ok: true });
    playHand(w, { winner: b, loser: a, amount: 40, rake: 1 });
    playHand(w, { winner: a, loser: b, amount: 15, rake: 0 });

    for (const client of w.clients) expect(failureOf(w, client)).toBeNull();
    const record = storedRecord(a.storage, w.tableKey);
    expect(BigInt(record.bundle.state.nonce)).toBe(w.server.head.nonce);
    expect(record.pinned.epoch).toBe(2);
    // the leaver keeps its record (it holds the final that paid it out) until the chain says it may go
    expect(storedRecord(c.storage, w.tableKey).last.isFinal).toBe(true);
    expect(toWire(w.server.head).nonce).toBe(record.last.nonce);
  });
});
