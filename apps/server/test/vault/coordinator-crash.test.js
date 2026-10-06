// Crash points (docs/signing-layer.md section 5). For EVERY write of a full hand cycle, and of a cycle that
// ends the epoch with a final and its settle, the server dies right after that write: the old coordinator is
// gone (nothing after the crash point reaches it), a new one boots on the same store and chain, everyone
// re-claims, and the table must recover: never two digests at one nonce, an open round re-issued verbatim
// (stored signatures kept, those members not asked again), chips from the highest reserved state, a stored
// final settled, init() never throwing, and the next hand played and signed as usual.
import { describe, expect, test } from 'bun:test';
import { SERVER } from '@pgg/protocol/constants';
import { MemoryStore } from '../../src/vault/memory-store.js';
import { SqliteStore } from '../../src/vault/sqlite-store.js';
import { makeVaultWorld, UNIT } from './harness.js';

const DEPOSIT = 500;

// What the actor would call on a dead server: nothing happens, the gate is shut.
const deadCoordinator = (tableKey) => ({
  tableKey,
  phase: 'dead',
  canDeal: () => false,
  sign: () => ({ ok: false, code: 'dead' }),
  claim: () => ({ ok: false, code: 'dead' }),
  requestLeave: () => ({ ok: false, code: 'dead' }),
  onHandEnd() {},
  flush() {},
  tick() {},
  onConnect() {},
  onDisconnect() {},
  onChainEvent() {},
  publicView: () => null,
});

// The two cycles under test, from an Active epoch with one bundle (nonce 1).
const CYCLES = {
  hand: (w) => {
    const [alice, bob] = w.players;
    w.playHand({ winner: bob, loser: alice, amount: 25, rake: 1 });
  },
  final: (w) => {
    const [, bob, carol] = w.players;
    w.playHand({ winner: bob, loser: carol, amount: DEPOSIT, rake: 2 }); // carol busts: a final, then the settle
    w.settle();
  },
};

function makeWorld(storeKind) {
  const w = makeVaultWorld();
  if (storeKind === 'sqlite') w.store = new SqliteStore({ path: ':memory:' });
  else w.store = new MemoryStore();
  w.activate({ chips: DEPOSIT });
  const [alice, bob] = w.players;
  w.playHand({ winner: alice, loser: bob, amount: 40, rake: 1 });
  return w;
}

function writesIn(storeKind, cycle) {
  const w = makeWorld(storeKind);
  const before = w.store.writeCount;
  CYCLES[cycle](w);
  return w.store.writeCount - before;
}

/** Run `cycle` with the server dying right after write k. Returns { w, crashed, snapshot } after recovery. */
function crashAt(storeKind, cycle, k) {
  const w = makeWorld(storeKind);
  const real = w.coordinator;
  let crashed = false;
  w.store.failAfterWrites(k, () => {
    crashed = true;
    w.coordinator = deadCoordinator(real.tableKey);
    return new Error(`crash after write ${k}`);
  });
  CYCLES[cycle](w);
  w.store.failAfterWrites(null);
  // what the store holds at the moment of the crash
  const open = w.store.openRound(real.tableKey);
  const snapshot = {
    open: open && {
      nonce: open.nonce,
      digest: open.digest,
      signed: new Set(open.playerSigs.keys()),
    },
    highest: w.store.latestSigned(real.tableKey)?.state ?? null,
    sentBefore: w.host.sent.length,
    // the crashing call answered its caller with an error, and the dead server refused the rest: a real
    // crash answers nothing, so only what happens from the restart on is judged
    refusalsBefore: w.players.map((p) => p.client.refusals.length),
  };
  if (crashed) {
    // a restarted server: clients reconnect without a live view of whatever hand was in flight
    for (const p of w.players) p.client.watched = { rake: 0, pot: 0, missed: true };
    expect(() => w.restart()).not.toThrow();
    for (const p of w.players.filter((x) => x.atTable)) w.claim(p);
    w.settle();
  }
  return { w, crashed, snapshot };
}

function expectRecovered({ w, crashed, snapshot }) {
  const c = w.coordinator;
  expect(w.violations).toEqual([]); // never two digests at one nonce, as any client saw them
  w.players.forEach((p, i) => {
    expect(p.client.refusals.slice(snapshot.refusalsBefore[i])).toEqual([]);
  });
  // the store agrees with every proposal any client saw
  for (const proposal of w.proposals) {
    expect(w.store.getSigned(c.tableKey, proposal.nonce)?.digest ?? proposal.digest).toBe(
      proposal.digest,
    );
  }
  if (!crashed) return;
  expect(c.halt).toBeNull();
  if (snapshot.open) {
    // re-issued verbatim: the same digest, and members whose signature was stored are not asked again
    const after = w.host.sent.slice(snapshot.sentBefore);
    for (const p of w.players) {
      const asked = after.filter(
        (s) =>
          s.playerId === p.playerId &&
          s.msg.t === SERVER.SIGN_REQ &&
          BigInt(s.msg.state.nonce) === snapshot.open.nonce,
      );
      for (const s of asked) expect(s.msg.digest).toBe(snapshot.open.digest);
      if (snapshot.open.signed.has(p.wallet)) expect(asked).toEqual([]);
    }
  }
}

// After recovery the table plays on: the next hand is dealt (or, after a settle, the next epoch starts) and
// signed, and the money adds up.
function expectPlaysOn(w) {
  const c = w.coordinator;
  if (c.phase === 'filling') w.startEpoch();
  expect(c.phase).toBe('active');
  expect(c.canDeal()).toBe(true);
  const seated = w.seated;
  const before = w.bundles.length;
  expect(w.playHand({ winner: seated[0], loser: seated[1], amount: 5, rake: 0 })).toBe(true);
  expect(w.bundles.length).toBe(before + 1);
  const state = w.bundles.at(-1).bundle.state;
  const paid = w.host.unseats.reduce((sum, u) => sum + BigInt(u.chips) * UNIT, 0n);
  expect(state.balances.reduce((a, b) => a + b, 0n) + state.rake + paid).toBe(
    3n * BigInt(DEPOSIT) * UNIT,
  );
}

for (const storeKind of ['memory', 'sqlite']) {
  for (const cycle of Object.keys(CYCLES)) {
    describe(`${storeKind} store, ${cycle} cycle: the server dies after every write`, () => {
      const n = writesIn(storeKind, cycle);

      test(`the cycle makes enough writes to be worth enumerating (${n})`, () => {
        expect(n).toBeGreaterThanOrEqual(cycle === 'hand' ? 5 : 8);
      });

      for (let k = 1; k <= n; k++) {
        test(`crash after write ${k} of ${n}`, () => {
          const run = crashAt(storeKind, cycle, k);
          expect(run.crashed).toBe(true);
          expectRecovered(run);
          expectPlaysOn(run.w);
          expect(run.w.violations).toEqual([]);
        });
      }
    });
  }
}

describe('recovery details', () => {
  test('chips after a restart come from the highest reserved state, not the last bundle', () => {
    const w = makeWorld('memory');
    const [alice, bob, carol] = w.players;
    carol.client.mode = 'manual';
    w.playHand({ winner: bob, loser: alice, amount: 30, rake: 1 }); // reserved and signed by two, not all
    const reserved = w.store.latestSigned(w.coordinator.tableKey).state;
    expect(reserved.nonce).toBe(2n);
    w.restart();
    for (const p of w.players) {
      const claimed = w.claim(p);
      expect(BigInt(claimed.chips) * UNIT).toBe(
        reserved.balances[reserved.players.indexOf(p.wallet)] -
          (reserved.balances[reserved.players.indexOf(p.wallet)] % UNIT),
      );
    }
    carol.client.mode = 'auto';
    w.signHeld(carol);
    expect(w.bundles.at(-1).bundle.state.nonce).toBe(2n);
    expect(w.coordinator.canDeal()).toBe(true);
  });

  test('a round whose signatures were all stored but whose bundle was not saved is completed by init()', () => {
    const w = makeWorld('memory');
    const [alice, bob] = w.players;
    // the server dies inside the transaction that saves the bundle: every signature is stored, no bundle
    let armed = false;
    const save = w.store.saveBundle.bind(w.store);
    w.store.saveBundle = (...args) => {
      if (!armed) {
        armed = true;
        w.coordinator = deadCoordinator(w.coordinator.tableKey);
        throw new Error('crash in saveBundle');
      }
      return save(...args);
    };
    w.playHand({ winner: bob, loser: alice });
    expect(w.store.loadBundle(w.coordinator.tableKey).state.nonce).toBe(1n);
    delete w.store.saveBundle;
    w.restart();
    expect(w.store.loadBundle(w.coordinator.tableKey).state.nonce).toBe(2n);
    for (const p of w.players) w.claim(p);
    expect(w.coordinator.canDeal()).toBe(true);
  });

  test('a reservation that was never signed is signed on init with the same bytes (RFC 6979)', () => {
    const w = makeWorld('memory');
    const [alice, bob] = w.players;
    const attach = w.store.attachArbiterSig.bind(w.store);
    w.store.attachArbiterSig = () => {
      w.coordinator = deadCoordinator(w.coordinator.tableKey);
      throw new Error('crash before attach');
    };
    w.playHand({ winner: bob, loser: alice });
    const k = w.coordinator.tableKey;
    expect(w.store.getSigned(k, 2n)).toMatchObject({ arbiterSig: null });
    w.store.attachArbiterSig = attach;
    w.restart();
    const signed = w.store.getSigned(k, 2n);
    expect(signed.arbiterSig).toBe(w.signerFor(w.store).signReserved(k, 2n));
    for (const p of w.players) w.claim(p);
    w.settle();
    expect(w.bundles.at(-1).bundle).toMatchObject({ arbiterSig: signed.arbiterSig });
  });
});
