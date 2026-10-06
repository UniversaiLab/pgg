// The VaultCoordinator against a FakeChain, a MemoryStore and simulated clients that judge every request with
// @pgg/vault against their own view (test/vault/harness.js). The honest lifecycle first: create, fill, claim,
// start, hands with one round each, a leave folded into the hand-end final, the settle, a second epoch; then
// the edges of each step.
import { describe, expect, test } from 'bun:test';
import { ERR, SERVER } from '@pgg/protocol/constants';
import { fromWire, hashState, signDigest } from '@pgg/vault';
import { makeJobKey } from '../../src/vault/chain-port.js';
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
