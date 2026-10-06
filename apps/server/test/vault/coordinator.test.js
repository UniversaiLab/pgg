// The VaultCoordinator against a FakeChain, a MemoryStore and simulated clients that judge every request with
// @pgg/vault against their own view (test/vault/harness.js). The honest lifecycle first: create, fill, claim,
// start, hands with one round each, a leave folded into the hand-end final, the settle, a second epoch; then
// the edges of each step.
import { describe, expect, test } from 'bun:test';
import { ERR, SERVER } from '@pgg/protocol/constants';
import { fromWire, hashState, signDigest } from '@pgg/vault';
import { makeJobKey } from '../../src/vault/chain-port.js';
import { DoubleSignError } from '../../src/vault/store.js';
import { makeVaultWorld, UNIT } from './harness.js';

const noRefusals = (w) => {
  for (const p of w.players) expect(p.client.refusals).toEqual([]);
  expect(w.violations).toEqual([]);
};
const sentTo = (w, player, type) =>
  w.host.sent.filter((s) => s.playerId === player.playerId && s.msg.t === type).map((s) => s.msg);
const lastBundle = (w) => w.bundles.at(-1)?.bundle ?? null;

describe('the honest lifecycle', () => {
  test('create, fill, claim, hold, start: an Active epoch whose genesis every client checked against the chain', () => {
    const w = makeVaultWorld();
    const c = w.boot();
    expect(c.phase).toBe('creating');
    expect(w.store.pendingJobs().map((j) => j.kind)).toEqual(['createTable']);
    w.settle();
    expect(c.phase).toBe('filling');
    expect(w.chain.table(c.tableKey)).toMatchObject({
      status: 'Filling',
      maxPlayers: 6,
      minDeposit: 100n * UNIT,
    });

    for (const p of w.players) w.deposit(p, 500, { dust: 7n });
    w.chainTick();
    for (const p of w.players)
      expect(w.claim(p)).toEqual({ ok: true, address: p.wallet, chips: 500 });
    expect(c.phase).toBe('filling'); // startHoldMs has not passed since the table filled
    w.tick(w.cfg.policy.startHoldMs - 1);
    w.settle();
    expect(c.phase).toBe('filling');
    w.startEpoch();
    expect(c.phase).toBe('active');
    expect(c.publicView()).toEqual({
      epoch: 1,
      phase: 'active',
      nonce: '0',
      awaiting: [],
      deadline: null,
    });
    for (const p of w.players) {
      expect(p.client.epoch?.number).toBe(1);
      expect(p.client.epoch.state.balances[p.client.epoch.state.players.indexOf(p.wallet)]).toBe(
        500n * UNIT + 7n,
      );
    }
    expect(c.canDeal()).toBe(true);
    noRefusals(w);
  });

  test('every hand is one round: signreq to every member, the gate shut until the bundle, bundle(n) before signreq(n+1)', () => {
    const w = makeVaultWorld();
    const c = w.activate({ dust: [1n, 2n, 3n] });
    const [alice, bob, carol] = w.players;
    carol.client.mode = 'manual'; // carol signs only when told: the round stays open meanwhile
    expect(w.playHand({ winner: alice, loser: bob, amount: 40, rake: 1 })).toBe(true);
    expect(c.canDeal()).toBe(false);
    expect(c.publicView()).toMatchObject({ nonce: '1', awaiting: [carol.seat] });
    expect(c.publicView().deadline).toBe(w.clock.now() + w.cfg.policy.signTimeoutMs);
    expect(w.playHand({ winner: bob, loser: alice })).toBe(false); // nothing is dealt while a round is open
    w.signHeld(carol);
    expect(c.canDeal()).toBe(true);
    carol.client.mode = 'auto';
    for (let i = 0; i < 4; i++)
      expect(
        w.playHand({
          winner: w.players[i % 3],
          loser: w.players[(i + 1) % 3],
          amount: 10 + i,
          rake: 1,
        }),
      ).toBe(true);

    const states = w.bundles.map((b) => b.bundle.state);
    expect(states.map((s) => s.nonce)).toEqual([1n, 2n, 3n, 4n, 5n]);
    for (const p of w.players) {
      // per member: the bundle for n arrives before the request for n+1
      const order = w.host.sent
        .filter((s) => s.playerId === p.playerId)
        .map((s) => `${s.msg.t}:${s.msg.state?.nonce}`);
      for (let n = 1; n < 5; n++) {
        expect(order.indexOf(`${SERVER.BUNDLE}:${n}`)).toBeLessThan(
          order.indexOf(`${SERVER.SIGN_REQ}:${n + 1}`),
        );
      }
    }
    // balances are chips x unit + the dust kept apart; rake and volume are cumulative
    const last = states.at(-1);
    for (const p of w.players) {
      const i = last.players.indexOf(p.wallet);
      expect(last.balances[i]).toBe(BigInt(p.chips) * UNIT + BigInt(w.players.indexOf(p) + 1));
    }
    expect(last.rake).toBe(5n * UNIT);
    expect(last.volume).toBe((80n + 20n + 22n + 24n + 26n) * UNIT);
    noRefusals(w);
  });

  test('a leave rides in the next hand-end state as a final; the settle pays the leaver and a second epoch starts', () => {
    const w = makeVaultWorld();
    const c = w.activate({ chips: [500, 400, 300] });
    const [alice, bob, carol] = w.players;
    for (let i = 0; i < 3; i++) w.playHand({ winner: alice, loser: bob, amount: 20, rake: 1 });
    expect(c.requestLeave(carol.playerId)).toEqual({ ok: true, head: 3n });
    carol.leaving = true;
    carol.client.intent = 'leave';
    carol.client.leaveAckNonce = 3n;
    expect(c.canDeal()).toBe(false); // the rotation is due: no hand, the final goes out instead
    w.settle();
    const final = lastBundle(w).state;
    expect(final).toMatchObject({ nonce: 4n, isFinal: true });
    expect(final.keep[final.players.indexOf(carol.wallet)]).toBe(false);
    expect(final.keep.filter(Boolean)).toHaveLength(2);
    // settled on chain: the leaver is unseated with every chip, the stayers carry theirs over
    w.settle();
    expect(w.chain.table(c.tableKey)).toMatchObject({ status: 'Filling', nonce: 4n });
    expect(w.host.unseats).toEqual([{ address: carol.wallet, reason: 'settled', chips: 300 }]);
    expect(c.phase).toBe('filling');
    expect(w.chain.seat(c.tableKey, alice.wallet).deposit).toBe(
      final.balances[final.players.indexOf(alice.wallet)],
    );

    // epoch 2: the stayers are kept members; after the hold the table starts again at the final's nonce
    w.startEpoch();
    expect(c.phase).toBe('active');
    expect(c.publicView()).toMatchObject({ epoch: 2, nonce: '4' }); // no head in a new epoch
    for (const p of [alice, bob]) expect(p.client.epoch.number).toBe(2);
    expect(alice.client.epoch.state).toMatchObject({
      nonce: 4n,
      rake: final.rake,
      volume: final.volume,
    });
    expect(w.playHand({ winner: bob, loser: alice, amount: 15, rake: 1 })).toBe(true);
    const first = lastBundle(w).state;
    expect(first).toMatchObject({
      nonce: 5n,
      isFinal: false,
      players: [alice.wallet, bob.wallet].sort(),
    });
    expect(first.rake).toBe(final.rake + UNIT);
    expect(first.volume).toBe(final.volume + 30n * UNIT);
    noRefusals(w);
  });

  test('a rotation asked for between hands is a standalone final with the balances unchanged', () => {
    const w = makeVaultWorld();
    const c = w.activate();
    const [alice, bob] = w.players;
    for (let i = 0; i < 3; i++) w.playHand({ winner: alice, loser: bob, amount: 10 });
    const before = lastBundle(w).state;
    bob.client.intent = 'leave';
    bob.client.leaveAckNonce = before.nonce;
    bob.leaving = true;
    c.requestLeave(bob.playerId);
    w.pump();
    const final = lastBundle(w).state;
    expect(final).toMatchObject({
      nonce: before.nonce + 1n,
      isFinal: true,
      balances: before.balances,
      rake: before.rake,
      volume: before.volume,
    });
    expect(sentTo(w, bob, SERVER.SIGN_REQ).at(-1)).toMatchObject({ reason: 'leave', handNo: null });
    // nothing more is proposed in this epoch, and nothing is dealt
    expect(c.canDeal()).toBe(false);
    w.tick(60_000);
    expect(lastBundle(w).state.nonce).toBe(final.nonce);
    expect(w.proposals.at(-1).nonce).toBe(final.nonce);
    noRefusals(w);
  });

  test('a leave before minEpochHands waits for the minimum, then goes out as a final', () => {
    const w = makeVaultWorld();
    const c = w.activate();
    const [alice, bob, carol] = w.players;
    w.playHand({ winner: alice, loser: bob });
    carol.client.intent = 'leave';
    carol.client.leaveAckNonce = 1n;
    expect(c.requestLeave(carol.playerId)).toEqual({ ok: true, head: 1n });
    expect(c.canDeal()).toBe(true);
    w.playHand({ winner: bob, loser: alice });
    expect(lastBundle(w).state.isFinal).toBe(false);
    carol.leaving = true;
    w.playHand({ winner: bob, loser: alice }); // the third hand: the leave is folded into its state
    expect(lastBundle(w).state).toMatchObject({ nonce: 3n, isFinal: true });
    noRefusals(w);
  });

  test('a bust is folded at once (forced) and the bust player is paid their dust', () => {
    const w = makeVaultWorld();
    const c = w.activate({ chips: [100, 100, 100], dust: [0n, 5n, 0n] });
    const [alice, bob] = w.players;
    w.playHand({ winner: alice, loser: bob, amount: 100, rake: 2 });
    const final = lastBundle(w).state;
    const i = final.players.indexOf(bob.wallet);
    expect(final).toMatchObject({ nonce: 1n, isFinal: true });
    expect(final.keep[i]).toBe(false);
    expect(final.balances[i]).toBe(5n); // dust alone never keeps a seat; it is paid out
    w.settle();
    expect(w.host.unseats).toEqual([{ address: bob.wallet, reason: 'settled', chips: 0 }]);
    expect(c.phase).toBe('filling');
    noRefusals(w);
  });
  test('a restart between epochs: the hold runs again and the table starts (it used to wait for ever)', () => {
    const w = makeVaultWorld();
    const c = w.activate({ chips: [100, 100, 100] });
    const [alice, bob] = w.players;
    w.playHand({ winner: alice, loser: bob, amount: 100 }); // bob busts: final, settle, filling
    w.settle();
    expect(c.phase).toBe('filling');
    w.restart();
    for (const p of w.seated) w.claim(p);
    w.startEpoch();
    expect(w.coordinator.phase).toBe('active');
    expect(w.coordinator.publicView().epoch).toBe(2);
  });
});

describe('the deal gate (S1)', () => {
  test('closed while a member is offline or unclaimed, open when everyone is back', () => {
    const w = makeVaultWorld();
    const c = w.activate();
    const [, bob] = w.players;
    w.disconnect(bob);
    expect(c.canDeal()).toBe(false);
    expect(c.publicView().awaiting).toEqual([bob.seat]);
    w.connect(bob);
    expect(c.canDeal()).toBe(true);
    // after a restart nobody is claimed: the gate stays shut until all have claimed again
    w.restart();
    expect(w.coordinator.canDeal()).toBe(false);
    for (const p of w.players) w.claim(p);
    expect(w.coordinator.canDeal()).toBe(true);
  });

  test('the actor is told when the gate opens', () => {
    const w = makeVaultWorld();
    w.activate();
    const before = w.host.starts;
    const [alice, bob, carol] = w.players;
    carol.client.mode = 'manual';
    w.playHand({ winner: alice, loser: bob });
    expect(w.host.starts).toBe(before);
    w.signHeld(carol);
    expect(w.host.starts).toBeGreaterThan(before);
  });
});

describe('claims (section 3)', () => {
  test('cheap checks first: a missing seat, an unconfirmed deposit (retryable), a bad signature, a stranger', () => {
    const w = makeVaultWorld();
    const c = w.boot();
    const [alice, bob, carol] = w.players;
    expect(
      c.claim(alice.playerId, { address: alice.wallet, sig: w.claimSig(alice) }),
    ).toMatchObject({
      ok: false,
      code: ERR.CLAIM_PENDING, // the table is still being created
    });
    w.settle();
    expect(w.claim(alice)).toMatchObject({ ok: false, code: ERR.BAD_CLAIM }); // no seat yet
    w.deposit(alice, 200);
    w.deposit(bob, 200, { confirmed: false });
    w.chainTick();
    expect(w.claim(bob)).toMatchObject({ ok: false, code: ERR.CLAIM_PENDING });
    expect(
      w.claim(alice, { sig: w.claimSig(alice, alice.playerId, carol.sessionKey) }),
    ).toMatchObject({
      ok: false,
      code: ERR.BAD_CLAIM,
    });
    expect(w.claim(alice, { sig: w.claimSig(alice, 'someone-else') })).toMatchObject({
      code: ERR.BAD_CLAIM,
    });
    expect(c.claim(alice.playerId, { address: 'nope', sig: w.claimSig(alice) })).toMatchObject({
      code: ERR.BAD_CLAIM,
    });
    expect(w.claim(alice)).toMatchObject({ ok: true, chips: 200 });
    // one player id holds one seat at a table
    w.deposit(carol, 200);
    w.chainTick();
    expect(
      c.claim(alice.playerId, { address: carol.wallet, sig: w.claimSig(carol, alice.playerId) }),
    ).toMatchObject({
      code: ERR.BAD_CLAIM,
    });
  });

  test('a newer claim from another player id re-keys the seat (and is rate limited per address)', () => {
    const w = makeVaultWorld();
    const c = w.activate();
    const [alice] = w.players;
    const old = alice.playerId;
    expect(w.claim(alice, { playerId: 'p-alice-2' })).toMatchObject({ ok: true });
    expect(w.host.rekeys).toEqual([{ oldId: old, newId: 'p-alice-2', address: alice.wallet }]);
    // the old id is no longer a member
    expect(
      c.sign(old, { nonce: '1', digest: `0x${'00'.repeat(32)}`, sig: `0x${'00'.repeat(65)}` }),
    ).toMatchObject({
      code: ERR.NOT_SEATED,
    });
    for (let i = 3; i < 3 + w.cfg.policy.rebindLimit - 1; i++)
      expect(w.claim(alice, { playerId: `p-alice-${i}` }).ok).toBe(true);
    expect(w.claim(alice, { playerId: 'p-alice-x' })).toMatchObject({
      ok: false,
      code: ERR.RATE_LIMITED,
    });
    w.tick(w.cfg.policy.rebindWindowMs);
    expect(w.claim(alice, { playerId: 'p-alice-x' }).ok).toBe(true);
  });

  test('in an epoch only roster members claim, with the epoch key; a stranger who deposits later is refused', () => {
    const w = makeVaultWorld({ names: ['alice', 'bob', 'carol', 'dave'] });
    const c = w.activate({ who: w.players.slice(0, 3) });
    const dave = w.player('dave');
    expect(c.phase).toBe('active');
    expect(w.chain.deposit(c.tableKey, dave.wallet, 200n * UNIT, dave.session).ok).toBe(false); // Active: no deposits
    expect(w.claim(dave)).toMatchObject({ ok: false, code: ERR.BAD_CLAIM });
  });
});

describe('signatures', () => {
  test('late, repeated and unknown-nonce signatures; a wrong signer is bad-signature', () => {
    const w = makeVaultWorld();
    const c = w.activate();
    const [alice, bob, carol] = w.players;
    carol.client.mode = 'manual';
    w.playHand({ winner: alice, loser: bob });
    const req = carol.client.held[0];
    const digest = req.digest;
    const forged = w.claimSig(alice); // any 65 bytes that are not carol's signature of the digest
    expect(c.sign(carol.playerId, { nonce: '1', digest, sig: forged })).toMatchObject({
      code: ERR.BAD_SIGNATURE,
    });
    expect(c.sign(carol.playerId, { nonce: '9', digest, sig: forged })).toMatchObject({
      code: ERR.BAD_SIGNATURE,
    });
    expect(c.sign(carol.playerId, { nonce: 'x', digest, sig: forged })).toMatchObject({
      code: ERR.BAD_SIGNATURE,
    });
    expect(c.sign('nobody', { nonce: '1', digest, sig: forged })).toMatchObject({
      code: ERR.NOT_SEATED,
    });
    w.signHeld(carol);
    expect(c.canDeal()).toBe(true);
    // a repeat after the round closed is a silent success
    const sig = signDigest(carol.sessionKey, digest);
    expect(c.sign(carol.playerId, { nonce: '1', digest, sig })).toEqual({ ok: true });
    expect(hashState(fromWire(req.state), w.domain)).toBe(digest);
  });
});

describe('jobs and phases', () => {
  test('saveBundle, the settling phase and the settle job are one step; the settle job is done once the chain shows it', () => {
    const w = makeVaultWorld();
    const c = w.activate({ chips: [100, 100, 100] });
    const [alice, bob] = w.players;
    w.playHand({ winner: alice, loser: bob, amount: 100 }); // bob busts: a final
    expect(c.phase).toBe('settling');
    const key = makeJobKey('settle', c.tableKey);
    expect(w.store.getJob(key)).toMatchObject({ status: 'pending' });
    w.settle();
    expect(w.store.getJob(key).status).toBe('done');
    expect(c.phase).toBe('filling');
  });
});

describe('stalls and stall exits (section 6)', () => {
  const P = (w) => w.cfg.policy;

  test('a silent member: soft deadline, resends to connected members only, then startExit with the newest bundle', () => {
    const w = makeVaultWorld();
    const c = w.activate();
    const [alice, bob, carol] = w.players;
    w.playHand({ winner: alice, loser: bob, amount: 30, rake: 1 }); // bundle 1
    carol.client.mode = 'manual';
    w.playHand({ winner: bob, loser: alice, amount: 10 }); // round 2 stays open
    expect(sentTo(w, carol, SERVER.SIGN_REQ).filter((m) => m.state.nonce === '2')).toHaveLength(1);
    w.tick(P(w).resendMs[0]);
    expect(sentTo(w, carol, SERVER.SIGN_REQ).filter((m) => m.state.nonce === '2')).toHaveLength(2);
    w.disconnect(carol);
    w.tick(P(w).resendMs[1] - P(w).resendMs[0]);
    expect(sentTo(w, carol, SERVER.SIGN_REQ).filter((m) => m.state.nonce === '2')).toHaveLength(2); // offline: no resend
    expect(c.phase).toBe('active');
    w.tick(P(w).signTimeoutMs - P(w).resendMs[1]);
    expect(c.phase).toBe('stalled');
    w.tick(P(w).stallExitMs - 1);
    expect(w.chain.table(c.tableKey).status).toBe('Active');
    w.tick(1);
    w.settle();
    const row = w.chain.table(c.tableKey);
    expect(row).toMatchObject({ status: 'Exiting', nonce: 1n });
    expect(row.exitDigest).toBe(hashState(w.bundles[0].bundle.state, w.domain));
    expect(c.phase).toBe('exiting');
    expect(c.canDeal()).toBe(false);
  });

  test('a late signature while a member is still away: the newer bundle challenges the exit, which then pays it out', () => {
    const w = makeVaultWorld();
    const c = w.activate();
    const [alice, bob, carol] = w.players;
    w.playHand({ winner: alice, loser: bob, amount: 30, rake: 1 });
    carol.client.mode = 'manual';
    w.playHand({ winner: bob, loser: alice, amount: 10 });
    w.tick(P(w).signTimeoutMs + P(w).stallExitMs);
    w.settle();
    expect(w.chain.table(c.tableKey)).toMatchObject({ status: 'Exiting', nonce: 1n });
    w.disconnect(alice); // so the table cannot recover: the exit runs its course
    carol.client.mode = 'auto';
    w.signHeld(carol);
    w.settle();
    const raised = w.bundles.at(-1).bundle.state;
    expect(raised).toMatchObject({ nonce: 2n, isFinal: false });
    expect(w.chain.table(c.tableKey)).toMatchObject({ status: 'Exiting', nonce: 2n });
    expect(w.chain.table(c.tableKey).exitDigest).toBe(hashState(raised, w.domain));
    w.advanceChain(w.chain.info.exitWindowSec + 1);
    w.settle();
    for (const p of w.players) {
      const u = w.host.unseats.find((x) => x.address === p.wallet);
      expect(u).toMatchObject({ reason: 'closed' });
      expect(BigInt(u.chips) * UNIT).toBe(raised.balances[raised.players.indexOf(p.wallet)]);
    }
  });

  test('every member back inside the window: exit recovery proposes a final keeping everyone, and settles it', () => {
    const w = makeVaultWorld();
    const c = w.activate();
    const [alice, bob, carol] = w.players;
    w.playHand({ winner: alice, loser: bob, amount: 30, rake: 1 });
    carol.client.mode = 'manual';
    w.playHand({ winner: bob, loser: alice, amount: 10 });
    w.tick(P(w).signTimeoutMs + P(w).stallExitMs);
    w.settle();
    expect(c.phase).toBe('exiting');
    carol.client.mode = 'auto';
    w.signHeld(carol);
    w.settle();
    const final = lastBundle(w).state;
    expect(final).toMatchObject({ nonce: 3n, isFinal: true, keep: [true, true, true] });
    expect(sentTo(w, alice, SERVER.SIGN_REQ).at(-1).reason).toBe('exit-recovery');
    w.settle();
    expect(w.chain.table(c.tableKey)).toMatchObject({ status: 'Filling', nonce: 3n });
    expect(c.phase).toBe('filling');
    expect(w.host.unseats).toEqual([]);
    noRefusals(w);
  });

  test('a late signature before the exit job is sent stops the exit (the guard re-reads the record)', () => {
    const w = makeVaultWorld();
    const c = w.activate();
    const [alice, bob, carol] = w.players;
    w.playHand({ winner: alice, loser: bob });
    carol.client.mode = 'manual';
    w.playHand({ winner: bob, loser: alice });
    w.tick(P(w).signTimeoutMs + P(w).stallExitMs); // the stall exit is decided and queued, not yet mined
    expect(w.chain.queued.length).toBeGreaterThan(0);
    carol.client.mode = 'auto';
    w.signHeld(carol);
    w.chainTick();
    expect(w.chain.table(c.tableKey).status).toBe('Active');
    expect(c.phase).toBe('active');
    expect(c.canDeal()).toBe(true);
  });

  test('a stall in the first round of an epoch exits from the deposits, and the closed table moves to a new generation', () => {
    const w = makeVaultWorld();
    const c = w.activate({ chips: [300, 200, 100], dust: [0n, 9n, 0n] });
    const [alice, bob, carol] = w.players;
    const firstKey = c.tableKey;
    carol.client.mode = 'manual';
    w.playHand({ winner: alice, loser: bob });
    w.tick(P(w).signTimeoutMs + P(w).stallExitMs);
    w.settle();
    expect(w.chain.table(firstKey)).toMatchObject({ status: 'Exiting', nonce: 0n });
    expect(c.phase).toBe('exiting');
    // nobody signs: after the window the deposit state is paid out and the table is Closed
    w.advanceChain(w.chain.info.exitWindowSec + 1);
    w.settle();
    expect(w.chain.table(firstKey).status).toBe('Closed');
    expect(w.host.unseats.map((u) => [u.address, u.reason, u.chips]).sort()).toEqual(
      [
        [alice.wallet, 'closed', 300],
        [bob.wallet, 'closed', 200],
        [carol.wallet, 'closed', 100],
      ].sort(),
    );
    expect(w.chain.balances.of(bob.wallet)).toBeGreaterThanOrEqual(200n * UNIT + 9n);
    // generation 2: a new tableKey, created from scratch
    expect(c.tableKey).not.toBe(firstKey);
    expect(c.phase).toBe('filling');
    expect(w.chain.table(c.tableKey)).toMatchObject({ status: 'Filling' });
  });

  test('a member away between hands closes the gate; after absentGraceMs the table is stalled, then it exits', () => {
    const w = makeVaultWorld();
    const c = w.activate();
    const [alice, bob] = w.players;
    w.playHand({ winner: alice, loser: bob });
    w.disconnect(bob);
    w.tick(P(w).absentGraceMs - 1);
    expect(c.phase).toBe('active');
    w.tick(1);
    expect(c.phase).toBe('stalled');
    // back in time: active again, nothing happens
    w.connect(bob);
    w.tick(1);
    expect(c.phase).toBe('active');
    w.disconnect(bob);
    w.tick(P(w).absentGraceMs + P(w).stallExitMs);
    w.settle();
    expect(w.chain.table(c.tableKey)).toMatchObject({ status: 'Exiting', nonce: 1n });
  });
});

describe('halts', () => {
  test('a snapshot the coordinator cannot read halts the table and never throws', () => {
    for (const snapshot of [
      null,
      { handNo: 1, result: { pot: 1, rake: 2 }, entries: [] },
      { handNo: -1, result: { pot: 0, rake: 0 }, entries: [] },
      {
        handNo: 1,
        result: { pot: 2, rake: 0 },
        entries: [{ address: `0x${'aa'.repeat(20)}`, chips: 1.5 }],
      },
    ]) {
      const w = makeVaultWorld();
      const c = w.activate();
      expect(() => c.onHandEnd(snapshot)).not.toThrow();
      expect(c.phase).toBe('halted');
      expect(c.canDeal()).toBe(false);
    }
    const w = makeVaultWorld();
    const c = w.activate();
    const snap = w.snapshot({ pot: 0 });
    snap.entries.pop(); // a member is missing from the snapshot
    c.onHandEnd(snap);
    expect(c.halt).toMatchObject({ cause: 'bad-snapshot', fatal: true });
  });

  test('chips that appear from nowhere are not signed: not-conserved is fatal and persists across a restart', () => {
    const w = makeVaultWorld();
    const c = w.activate();
    const [alice] = w.players;
    alice.chips += 50;
    c.onHandEnd(w.snapshot({ pot: 0 }));
    expect(c.halt).toMatchObject({ cause: 'not-conserved', fatal: true });
    expect(w.proposals).toHaveLength(0);
    w.restart();
    expect(w.coordinator.halt).toMatchObject({ cause: 'not-conserved' });
  });

  test('a hand ending while a round is open, or after a final, halts instead of proposing', () => {
    const w = makeVaultWorld();
    const c = w.activate();
    const [alice, bob, carol] = w.players;
    carol.client.mode = 'manual';
    w.playHand({ winner: alice, loser: bob });
    c.onHandEnd(w.snapshot({ pot: 0 }));
    expect(c.halt).toMatchObject({ cause: 'hand-while-round-open' });
  });

  test('a double-sign refusal from the store is fatal, nothing is sent, and the halt survives a restart', () => {
    const w = makeVaultWorld();
    const c = w.activate();
    const [alice, bob] = w.players;
    w.store.reserve = (tableKey, state) => {
      throw new DoubleSignError({
        tableKey,
        nonce: state.nonce,
        stored: `0x${'11'.repeat(32)}`,
        attempted: `0x${'22'.repeat(32)}`,
      });
    };
    expect(() => w.playHand({ winner: alice, loser: bob })).not.toThrow();
    expect(c.halt).toMatchObject({ cause: 'double-sign', fatal: true });
    expect(w.proposals).toHaveLength(0);
    delete w.store.reserve;
    w.restart();
    expect(w.coordinator.halt).toMatchObject({ cause: 'double-sign' });
  });

  // A cached row that is wrong until the adapter re-reads it (repair): the proposal is retried once.
  function staleRow(w, { fixedByReread }) {
    const real = w.chain.table.bind(w.chain);
    let stale = true;
    w.chain.table = (k) => (stale ? { ...real(k), rosterHash: `0x${'00'.repeat(32)}` } : real(k));
    w.chain.repair = () => {
      if (fixedByReread) stale = false;
    };
  }

  test('a stale chain view gets one re-read and one retry, then the state is proposed', () => {
    const w = makeVaultWorld();
    const c = w.activate();
    const [alice, bob] = w.players;
    staleRow(w, { fixedByReread: true });
    w.playHand({ winner: alice, loser: bob });
    expect(c.halt).toMatchObject({ cause: 'stale-chain-cache', fatal: false });
    expect(w.proposals).toHaveLength(0);
    w.tick(w.cfg.policy.retryDelayMs);
    expect(c.halt).toBeNull();
    expect(w.proposals.map((p) => p.nonce)).toEqual([1n]);
    expect(lastBundle(w).state.nonce).toBe(1n);
    noRefusals(w);
  });

  test('a view still wrong after the re-read: check-failed, fatal, nothing signed', () => {
    const w = makeVaultWorld();
    const c = w.activate();
    const [alice, bob] = w.players;
    staleRow(w, { fixedByReread: false });
    w.playHand({ winner: alice, loser: bob });
    w.tick(w.cfg.policy.retryDelayMs);
    expect(c.halt).toMatchObject({ cause: 'check-failed', fatal: true });
    expect(w.proposals).toHaveLength(0);
  });

  test('resuming a table under another chip unit is refused: pinned-changed, claims locked', () => {
    const w = makeVaultWorld();
    w.activate();
    w.cfg.chipUnit = UNIT * 10n;
    w.restart();
    expect(w.coordinator.halt).toMatchObject({ cause: 'pinned-changed' });
    expect(w.claim(w.players[0])).toMatchObject({ ok: false, code: ERR.VAULT_LOCKED });
  });

  test('a paused vault: the start fails, is retried with back-off, and succeeds once unpaused', () => {
    const w = makeVaultWorld();
    const c = w.boot();
    w.settle();
    for (const p of w.players) w.deposit(p, 200);
    w.chainTick();
    for (const p of w.players) w.claim(p);
    w.chain.pause(true);
    w.startEpoch();
    expect(c.phase).toBe('filling');
    expect(c.halt).toBeNull();
    w.chain.pause(false);
    w.tick(w.cfg.policy.maxBackoffMs);
    w.settle();
    w.tick(w.cfg.policy.startHoldMs);
    w.settle();
    expect(c.phase).toBe('active');
  });
});

describe('gaps the mutation check found', () => {
  test("a seat whose session key is the arbiter's, or another seat's, cannot be claimed", () => {
    const w = makeVaultWorld();
    const c = w.boot();
    w.settle();
    const [alice, bob, carol] = w.players;
    expect(w.chain.deposit(c.tableKey, alice.wallet, 200n * UNIT, w.arbiter).ok).toBe(true);
    expect(w.chain.deposit(c.tableKey, bob.wallet, 200n * UNIT, carol.session).ok).toBe(true);
    w.deposit(carol, 200);
    w.chainTick();
    expect(w.claim(alice, { sig: w.claimSig(alice, alice.playerId, w.arbiterKey) })).toMatchObject({
      ok: false,
      code: ERR.BAD_CLAIM,
    });
    expect(w.claim(bob, { sig: w.claimSig(bob, bob.playerId, carol.sessionKey) })).toMatchObject({
      ok: false,
      code: ERR.BAD_CLAIM,
    });
  });

  test('a key past its policy age in one jump: the server refuses to co-sign anything (S3) and halts', () => {
    const w = makeVaultWorld();
    const c = w.activate();
    const [alice, bob] = w.players;
    w.playHand({ winner: alice, loser: bob });
    w.advanceChain(w.cfg.policy.policyMaxMs / 1000 + 1);
    w.tick(1);
    expect(c.halt).toMatchObject({ cause: 'key-expired', fatal: true });
    expect(w.proposals.map((p) => p.nonce)).toEqual([1n]);
  });

  test('a key about to expire keeps the table from starting an epoch with it', () => {
    const w = makeVaultWorld();
    const c = w.boot();
    w.settle();
    for (const p of w.players) w.deposit(p, 200);
    w.chainTick();
    for (const p of w.players) w.claim(p);
    w.advanceChain((w.cfg.policy.policyMaxMs - w.cfg.policy.policyMarginMs) / 1000);
    w.startEpoch();
    // not started at all (an epoch that started would rotate the old keys out at once and look the same)
    expect(c.phase).toBe('filling');
    expect(c.publicView().epoch).toBe(0);
    expect(w.proposals).toEqual([]);
    expect(w.chain.table(c.tableKey)).toMatchObject({ status: 'Filling', nonce: 0n });
  });

  test('after a restart in filling the start hold is honoured again, then the table starts', () => {
    const w = makeVaultWorld();
    w.boot();
    w.settle();
    for (const p of w.players) w.deposit(p, 200);
    w.chainTick();
    w.restart();
    for (const p of w.players) w.claim(p);
    w.tick(w.cfg.policy.startHoldMs - 1);
    w.settle();
    expect(w.coordinator.phase).toBe('filling');
    w.tick(1);
    w.settle();
    expect(w.coordinator.phase).toBe('active');
  });

  test('a leave asked while the final settles is honoured in the next epoch', () => {
    const w = makeVaultWorld();
    const c = w.activate({ chips: [100, 100, 100] });
    const [alice, bob, carol] = w.players;
    w.playHand({ winner: alice, loser: bob, amount: 100 }); // bob busts: a final keeping alice and carol
    expect(c.phase).toBe('settling');
    expect(c.requestLeave(carol.playerId).ok).toBe(true); // too late for this final
    carol.client.intent = 'leave';
    carol.client.leaveAckNonce = 1n;
    w.settle();
    expect(c.phase).toBe('filling');
    // epoch 2 starts with alice and carol; carol still wants out and alice cannot play alone, so the epoch
    // ends at once with a standalone final that pays carol, and it settles
    w.startEpoch();
    const final = lastBundle(w).state;
    expect(final).toMatchObject({
      nonce: 2n,
      isFinal: true,
      players: [alice.wallet, carol.wallet].sort(),
    });
    expect(final.keep[final.players.indexOf(carol.wallet)]).toBe(false);
    expect(final.keep[final.players.indexOf(alice.wallet)]).toBe(true);
    expect(w.chain.table(c.tableKey)).toMatchObject({ status: 'Filling', nonce: 2n, seated: 1 });
    expect(w.host.unseats.map((u) => u.address)).toEqual([bob.wallet, carol.wallet]);
    noRefusals(w);
  });

  test('exit recovery never keeps a seat that went bust during the exit (dust alone keeps nothing)', () => {
    const w = makeVaultWorld();
    const c = w.activate({ chips: [100, 100, 100], dust: [0n, 3n, 0n] });
    const [alice, bob, carol] = w.players;
    w.playHand({ winner: alice, loser: carol, amount: 10 });
    carol.client.mode = 'manual';
    w.playHand({ winner: carol, loser: alice, amount: 5 });
    w.tick(w.cfg.policy.signTimeoutMs + w.cfg.policy.stallExitMs);
    w.settle();
    expect(c.phase).toBe('exiting');
    w.disconnect(alice); // no recovery yet
    carol.client.mode = 'auto';
    w.signHeld(carol);
    w.settle();
    // a hand that was in flight ends during the exit: bob loses everything to carol; its state is proposed as it is
    const take = bob.chips;
    bob.chips = 0;
    carol.chips += take;
    for (const p of w.seated) if (p.connected) p.client.watched.pot += take * 2;
    alice.client.watched.missed = true;
    c.onHandEnd(w.snapshot({ pot: take * 2 }));
    c.flush();
    w.pump();
    w.connect(alice);
    w.settle();
    const final = lastBundle(w).state;
    expect(final.isFinal).toBe(true);
    expect(final.keep[final.players.indexOf(bob.wallet)]).toBe(false);
    expect(final.balances[final.players.indexOf(bob.wallet)]).toBe(3n);
    noRefusals(w);
  });
});
