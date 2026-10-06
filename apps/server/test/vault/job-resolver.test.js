// The resolver turns a job (which carries no bundle and no state, F3/F4) into transaction arguments at the
// moment it runs, from what the store holds NOW and a fresh chain view, and declines whatever would be
// pointless or would revert. The chain is a real FakeChain moved through the world's TestResolver; the
// JobResolver under test only reads it (decide) or runs a job through it (prepare inside tick).
import { describe, expect, test } from 'bun:test';
import { hashState } from '@pgg/vault';
import { makeJob } from '../../src/vault/chain-port.js';
import { JobResolver } from '../../src/vault/job-resolver.js';
import { MemoryStore } from '../../src/vault/memory-store.js';
import { makeWorld, UNIT } from './fake-chain-world.js';

const MARGIN = 60;

function setup(options) {
  const w = makeWorld(options);
  const store = new MemoryStore();
  const key = w.tableKey;
  store.saveTable({
    tableKey: key,
    phase: 'creating',
    pinned: { numSeats: 6, chipUnit: UNIT, rakeBps: 200 },
    limits: { minDeposit: UNIT, maxDeposit: 10_000_000n * UNIT },
    roster: null,
  });
  const resolver = new JobResolver({ store, chain: w.chain, challengeMarginSec: MARGIN });
  const verifyCtx = {
    arbiter: w.arbiter,
    sessionKeyOf: (p) => w.seats.find((s) => s.wallet === p)?.session ?? null,
    expect: { domain: w.domain, tableId: key, players: w.players },
  };
  return {
    w,
    store,
    resolver,
    key,
    decide: (kind) => resolver.decide({ kind, tableKey: key }),
    set: (patch) => store.saveTable({ ...store.loadTable(key), ...patch }),
    save(state) {
      const bundle = w.bundle(state);
      expect(store.saveBundle(key, bundle, verifyCtx)).toEqual({ saved: true });
      return bundle;
    },
    row: () => w.chain.table(key),
  };
}

// An Active table with two hands played: { s0 (genesis), s1, s2 } (nothing stored yet).
function active(t) {
  const s0 = t.w.activate();
  t.set({ phase: 'active', roster: t.w.players });
  const s1 = t.w.hand(s0, { winner: 0, loser: 1 });
  const s2 = t.w.hand(s1, { winner: 2, loser: 0 });
  return { s0, s1, s2 };
}

function exiting(t, from) {
  t.w.run('startExit', { bundle: t.w.bundle(from) });
  expect(t.row().status).toBe('Exiting');
}

const expectNo = (decision, reason) => expect(decision).toEqual({ proceed: false, reason });

describe('prepare: job bookkeeping', () => {
  test('a job runs only while the store holds it pending; going ahead marks it sent, declining marks it failed', () => {
    const t = setup();
    const job = makeJob('createTable', t.key);
    expectNo(t.resolver.prepare(job), 'not-pending');
    expect(t.store.enqueueJob(job)).toBe(true);
    const decision = t.resolver.prepare(job);
    expect(decision.proceed).toBe(true);
    expect(t.store.getJob(job.key)).toMatchObject({ status: 'sent', attempts: 1 });
    expectNo(t.resolver.prepare(job), 'not-pending'); // a re-submit of a sent job sends nothing twice

    const start = makeJob('start', t.key);
    t.store.enqueueJob(start);
    expectNo(t.resolver.prepare(start), 'phase creating');
    expect(t.store.getJob(start.key)).toMatchObject({
      status: 'failed',
      error: 'skipped: phase creating',
    });
    expect(t.store.enqueueJob(start)).toBe(true); // a failed job frees its key for the reconciler
  });

  test('through the chain: the FakeChain calls prepare at execution time and sends what it returns', () => {
    const t = setup();
    t.w.chain.resolver = t.resolver;
    const job = makeJob('createTable', t.key);
    t.store.enqueueJob(job);
    t.w.chain.submit(job);
    t.w.chain.tick();
    expect(t.row()).toMatchObject({ status: 'Filling', maxPlayers: 6, minDeposit: UNIT });
    expect(t.store.getJob(job.key).status).toBe('sent');
  });

  test('an unknown table or kind is declined, and the constructor checks its arguments', () => {
    const t = setup();
    expectNo(
      t.resolver.decide({ kind: 'createTable', tableKey: `0x${'ee'.repeat(32)}` }),
      'unknown-table',
    );
    expectNo(t.decide('selfdestruct'), 'unknown kind selfdestruct');
    expect(
      () => new JobResolver({ store: t.store, chain: t.w.chain, challengeMarginSec: -1 }),
    ).toThrow(TypeError);
    expect(() => new JobResolver({ store: null, chain: t.w.chain, challengeMarginSec: 1 })).toThrow(
      TypeError,
    );
    expect(() => new JobResolver({ store: t.store, chain: {}, challengeMarginSec: 1 })).toThrow(
      TypeError,
    );
  });
});

describe('createTable and start', () => {
  test('createTable: once, from the record, while creating', () => {
    const t = setup();
    expect(t.decide('createTable')).toEqual({
      proceed: true,
      args: { maxPlayers: 6, minDeposit: UNIT, maxDeposit: 10_000_000n * UNIT },
    });
    t.set({ limits: null });
    expectNo(t.decide('createTable'), 'no-limits');
    t.set({ limits: { minDeposit: UNIT, maxDeposit: UNIT * 2n }, phase: 'filling' });
    expectNo(t.decide('createTable'), 'phase filling');
    t.w.createTable();
    expectNo(t.decide('createTable'), 'table-exists');
  });

  test('start: the exact sorted roster of confirmed seats with distinct keys, none the arbiter', () => {
    const t = setup();
    t.set({ phase: 'starting', roster: t.w.players });
    expectNo(t.decide('start'), 'not-filling');
    t.w.createTable();
    t.w.depositAll();
    expect(t.decide('start')).toEqual({ proceed: true, args: { players: t.w.players } });
    t.set({ roster: t.w.players.slice(0, 2) });
    expectNo(t.decide('start'), 'seats-changed');
    t.set({ roster: [...t.w.players].reverse() });
    expectNo(t.decide('start'), 'roster-not-sorted');
    t.set({ roster: t.w.players.slice(0, 1) });
    expectNo(t.decide('start'), 'roster-too-small');
    t.set({ phase: 'filling', roster: t.w.players });
    expectNo(t.decide('start'), 'phase filling');
  });

  // one seat deposits with `session` (another seat's key, the arbiter's) or unconfirmed
  for (const [name, reason, deposit] of [
    [
      'a session key shared by two seats',
      'session-key-shared',
      (w) => ({ session: w.seats[0].session }),
    ],
    ["the arbiter's own key on a seat", 'session-key-shared', (w) => ({ session: w.arbiter })],
    ['an unconfirmed deposit', 'seat-unconfirmed', () => ({ confirmed: false })],
  ]) {
    test(`start refuses ${name}`, () => {
      const t = setup();
      t.set({ phase: 'starting', roster: t.w.players });
      t.w.createTable();
      const odd = deposit(t.w);
      t.w.seats.forEach((seat, i) => {
        t.w.chain.mint(seat.wallet, t.w.amounts[i]);
        const last = i === t.w.seats.length - 1;
        t.w.chain.deposit(
          t.key,
          seat.wallet,
          t.w.amounts[i],
          last && odd.session ? odd.session : seat.session,
          {
            confirmed: !(last && odd.confirmed === false),
          },
        );
      });
      t.w.chain.tick();
      expectNo(t.decide('start'), reason);
    });
  }
});

describe('settle', () => {
  test("the current epoch's final above the chain nonce, sent as it is stored, and it settles", () => {
    const t = setup();
    const { s1 } = active(t);
    expectNo(t.decide('settle'), 'no-final-above-chain');
    t.save(s1);
    expectNo(t.decide('settle'), 'no-final-above-chain'); // a final, not just any bundle
    const final = t.w.final(s1, [true, false, true]);
    const stored = t.save(final);
    const decision = t.decide('settle');
    expect(decision.proceed).toBe(true);
    expect(decision.args.bundle).toEqual({
      state: final,
      arbiterSig: stored.arbiterSig,
      playerSigs: stored.playerSigs,
    });
    t.w.chain.resolver = t.resolver;
    const job = makeJob('settle', t.key);
    t.store.enqueueJob(job);
    t.w.chain.submit(job);
    t.w.chain.tick();
    expect(t.row()).toMatchObject({ status: 'Filling', nonce: final.nonce });
    expectNo(t.decide('settle'), 'not-settleable');
  });

  test("the previous epoch's final when the current epoch holds none above the chain (a reorg took the settle)", () => {
    const t = setup();
    const { s1 } = active(t);
    const final = t.w.final(s1);
    t.save(final);
    t.set({ epochBaseNonce: final.nonce }); // the store moved on to the next epoch
    expect(t.store.loadBundle(t.key)).toBeNull();
    expect(t.decide('settle').args.bundle.state).toEqual(final);
  });

  test('a stored final the vault would refuse is not sent (checkSettle on the chain view first)', () => {
    const t = setup();
    const { s0 } = active(t);
    // 50 chips of rake on a 10-chip pot: far above the vault's rake cap
    const greedy = t.w.hand(s0, { winner: 0, loser: 1, amount: 100n, rake: 50n, pot: 10n });
    t.save(t.w.final(greedy));
    expect(t.decide('settle')).toMatchObject({
      proceed: false,
      reason: expect.stringMatching(/^would revert /),
    });
  });
});

describe('exits: challenge, finalizeExit', () => {
  test('challenge with the newer bundle while the window is open by more than the margin (chain time)', () => {
    const t = setup();
    const { s1, s2 } = active(t);
    expectNo(t.decide('challenge'), 'not-exiting');
    t.save(s1);
    exiting(t, s1);
    expectNo(t.decide('challenge'), 'nothing-newer');
    const newer = t.save(s2);
    expect(t.decide('challenge')).toEqual({
      proceed: true,
      args: { bundle: { state: s2, arbiterSig: newer.arbiterSig, playerSigs: newer.playerSigs } },
    });
    const left = t.row().exitDeadline - t.w.chain.chainTime();
    t.w.chain.advanceTime(left - MARGIN - 1);
    t.w.chain.tick();
    expect(t.decide('challenge').proceed).toBe(true);
    t.w.chain.advanceTime(1); // now + margin == deadline: too close to land in time
    t.w.chain.tick();
    expectNo(t.decide('challenge'), 'window-closing');
  });

  test('a final bundle is settled, never used to challenge', () => {
    const t = setup();
    const { s1 } = active(t);
    t.save(s1);
    exiting(t, s1);
    t.save(t.w.final(s1));
    expectNo(t.decide('challenge'), 'final-is-settled-not-challenged');
  });

  test('finalizeExit after the window, with the stored state whose digest the exit holds', () => {
    const t = setup();
    const { s1, s2 } = active(t);
    t.save(s1);
    exiting(t, s1);
    expectNo(t.decide('finalizeExit'), 'window-open');
    t.w.chain.advanceTime(t.row().exitDeadline - t.w.chain.chainTime());
    t.w.chain.tick();
    expectNo(t.decide('finalizeExit'), 'window-open'); // equal is still open: strictly after
    t.w.chain.advanceTime(1);
    t.w.chain.tick();
    expect(t.decide('finalizeExit')).toEqual({ proceed: true, args: { state: s1 } });
    // a newer bundle stored late does not change what the exit holds: the candidates are searched by digest
    t.save(s2);
    expect(t.decide('finalizeExit')).toEqual({ proceed: true, args: { state: s1 } });
  });

  test('finalizeExit finds a signed (not all-signed) state at the exit nonce, or the deposit state', () => {
    const t = setup();
    const { s1 } = active(t);
    exiting(t, s1); // a member exited with a state the server only reserved
    t.w.chain.advanceTime(10_000_000);
    t.w.chain.tick();
    expectNo(t.decide('finalizeExit'), 'no-state-for-exit-digest');
    t.store.reserve(t.key, s1, hashState(s1, t.w.domain));
    expect(t.decide('finalizeExit')).toEqual({ proceed: true, args: { state: s1 } });

    const d = setup();
    active(d);
    d.w.run('startExitFromDeposits', { players: d.w.players });
    d.w.chain.advanceTime(10_000_000);
    d.w.chain.tick();
    expect(d.decide('finalizeExit')).toEqual({
      proceed: true,
      args: { state: d.w.depositState() },
    });
  });
});

describe('stall exits: the guard re-reads what the coordinator decided', () => {
  test('startExit only while the record still asks for it, the chain is Active and the stalled round is open', () => {
    const t = setup();
    const { s1, s2 } = active(t);
    t.save(s1);
    expectNo(t.decide('startExit'), 'no-stall');
    t.set({ stallExit: { kind: 'startExitFromDeposits', nonce: null } });
    expectNo(t.decide('startExit'), 'no-stall');
    t.set({ stallExit: { kind: 'startExit', nonce: null } });
    expect(t.decide('startExit').args.bundle.state).toEqual(s1);

    // the round at nonce 2 stalled; while it is open the exit goes ahead with the newest ALL-signed state
    t.store.reserve(t.key, s2, hashState(s2, t.w.domain));
    t.set({ stallExit: { kind: 'startExit', nonce: '2' } });
    expect(t.decide('startExit').args.bundle.state).toEqual(s1);
    // a late signature completed the round between the decision and the send: no exit
    t.save(s2);
    expectNo(t.decide('startExit'), 'round-completed');
  });

  test('startExit needs a bundle newer than the chain and not final; Exiting is not Active', () => {
    const t = setup();
    const { s1 } = active(t);
    t.set({ stallExit: { kind: 'startExit', nonce: null } });
    expectNo(t.decide('startExit'), 'nothing-newer');
    t.save(t.w.final(s1));
    expectNo(t.decide('startExit'), 'final-is-settled-not-exited');
    exiting(t, s1);
    expectNo(t.decide('startExit'), 'not-active');
  });

  test('startExitFromDeposits only when no bundle of this epoch is newer, and for the roster the chain froze', () => {
    const t = setup();
    const { s1 } = active(t);
    t.set({ stallExit: { kind: 'startExitFromDeposits', nonce: null } });
    expect(t.decide('startExitFromDeposits')).toEqual({
      proceed: true,
      args: { players: t.w.players },
    });
    t.set({ roster: t.w.players.slice(1) });
    expectNo(t.decide('startExitFromDeposits'), 'roster-mismatch');
    t.set({ roster: t.w.players });
    t.save(s1);
    expectNo(t.decide('startExitFromDeposits'), 'bundle-newer-than-deposits');
  });
});
