// The coordinator simulation (coordinator-sim.test.js runs it over many seeds). A deterministic simulation: many seeds of random schedules (hands, busts, leaves, drops and returns,
// re-claims under new player ids, late and refused signatures, clock and chain time, crash-restarts) against
// the coordinator, a FakeChain and simulated clients. After every step the invariants of the plan are checked:
//
//   every proposed state conserves against its epoch's genesis   one digest per nonce, ever
//   nonces only rise, across restarts                            every usable bundle passes checkState on chain
//   the deal gate never opens while a round is open              rake and volume carry over between epochs
//   at the end every table is wound down and nothing stays locked in the vault
import { expect } from 'bun:test';
import { SERVER } from '@pgg/protocol/constants';
import { checkState, fromWire, tableFromChain } from '@pgg/vault';
import { makeVaultWorld } from './harness.js';

const STEPS = 40;

// mulberry32: small, seeded, good enough to pick actions
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (p) => next() < p,
  };
}

const ACTIONS = [
  ['hand', 6],
  ['bigHand', 1],
  ['leave', 1],
  ['drop', 1],
  ['back', 2],
  ['reclaim', 1],
  ['holdSigs', 1],
  ['releaseSigs', 2],
  ['refuseSigs', 0.3],
  ['tick', 2],
  ['longTick', 0.4],
  ['chain', 2],
  ['exitWindow', 0.3],
  ['restart', 0.4],
  ['join', 2],
];
const TOTAL = ACTIONS.reduce((a, [, w]) => a + w, 0);

function pickAction(r) {
  let x = r.next() * TOTAL;
  for (const [name, weight] of ACTIONS) {
    x -= weight;
    if (x < 0) return name;
  }
  return 'hand';
}

export function simulate(seed) {
  const r = rng(seed);
  const w = makeVaultWorld({ names: ['alice', 'bob', 'carol', 'dave'] });
  const geneses = new Map(); // `${tableKey}:${epoch}` -> genesis state, from the epoch messages sent
  const seenSent = { n: 0 };
  let lastNonce = -1n;
  let tableKey = null;
  const checked = { bundles: 0, gates: 0 };
  const log = [];

  const deposit = (p, chips) => {
    w.deposit(p, chips, { dust: BigInt(r.int(0, 3)) });
  };
  // Sign what a "manual" client held back. A real socket delivers in order, so a client never sees a request
  // for nonce n after it signed n+1; held copies it has moved past since are dropped, not refused.
  const release = (p) => {
    const last = p.client.last?.nonce ?? -1n;
    p.client.held = p.client.held.filter((m) => BigInt(m.state.nonce) >= last);
    if (p.client.held.length > 0) w.signHeld(p);
  };
  const claimAll = () => {
    for (const p of w.players) {
      if (p.atTable || w.chain.seat(w.tableKey, p.wallet)) w.claim(p);
    }
  };

  function invariants(label) {
    const c = w.coordinator;
    // a closed table moves to a new generation: the clients start over there
    if (c.tableKey !== tableKey) {
      if (tableKey !== null) {
        for (const p of w.players) {
          p.client.reset();
          p.client.finalSigned = null;
          p.client.expectedBalance = null;
        }
      }
      tableKey = c.tableKey;
    }
    // what the server sent since the last check
    for (const { msg } of w.host.sent.slice(seenSent.n)) {
      if (msg.t === SERVER.EPOCH) {
        const genesis = fromWire(msg.state);
        const key = `${genesis.tableId}:${msg.epoch}`;
        const known = geneses.get(key);
        if (known) expect(known).toEqual(genesis); // one genesis per epoch
        geneses.set(key, genesis);
        // rake and volume carry over from the final that settled the previous epoch (F7)
        const final = w.bundles
          .map((b) => b.bundle.state)
          .find((s) => s.tableId === genesis.tableId && s.nonce === genesis.nonce && s.isFinal);
        if (final) {
          expect(genesis.rake).toBe(final.rake);
          expect(genesis.volume).toBe(final.volume);
        }
      } else if (msg.t === SERVER.SIGN_REQ) {
        const state = fromWire(msg.state);
        const genesis = geneses.get(`${state.tableId}:${msg.epoch}`);
        expect(genesis).toBeDefined();
        const total = (s) => s.balances.reduce((a, b) => a + b, 0n) + s.rake;
        expect(total(state)).toBe(total(genesis)); // conserved within the epoch
        expect(state.players).toEqual(genesis.players);
      }
    }
    seenSent.n = w.host.sent.length;
    // one digest per nonce, nonces only rise (first sight order)
    expect(w.violations).toEqual([]);
    for (const p of w.proposals.slice(-5)) if (p.nonce > lastNonce) lastNonce = p.nonce;
    const firstSeen = w.proposals.map((p) => p.nonce);
    for (let i = 1; i < firstSeen.length; i++) {
      if (firstSeen[i] <= firstSeen[i - 1])
        throw new Error(
          `seed ${seed} ${label}: nonce went back ${firstSeen[i - 1]} -> ${firstSeen[i]}`,
        );
    }
    // the newest bundle of the current epoch is what the contract would accept right now
    const row = w.chain.table(c.tableKey);
    const bundle = w.store.loadBundle(c.tableKey);
    if (
      row &&
      bundle &&
      (row.status === 'Active' || row.status === 'Exiting') &&
      bundle.state.nonce > row.nonce
    ) {
      const verdict = checkState(bundle.state, bundle, {
        domain: w.domain,
        maxRakeBps: w.chain.info.maxRakeBps,
        sessionKeyOf: (player) => w.chain.seat(c.tableKey, player)?.sessionKey ?? null,
        table: tableFromChain(row),
      });
      expect(verdict).toMatchObject({ ok: true });
      checked.bundles += 1;
    }
    // S1: an open gate means an Active epoch with no open round
    if (c.canDeal()) {
      expect(c.phase).toBe('active');
      expect(w.store.openRound(c.tableKey)).toBeNull();
      checked.gates += 1;
    }
    // honest clients never refuse anything (only the scripted refusers do)
    for (const p of w.players) {
      const bad = p.client.refusals.filter((x) => x.rule !== 'mode' && x.code !== 'not-seated');
      if (bad.length > 0)
        throw new Error(
          `seed ${seed} ${label}: ${p.name} refused ${JSON.stringify(bad, (_, v) => (typeof v === 'bigint' ? `${v}` : v))}` +
            (process.env.SIM_DEBUG
              ? `\nLOG ${log.join(' ')}\nSENT ${w.host.sent
                  .filter((x) => x.playerId === p.playerId || x.msg.t === 'epoch')
                  .map(
                    (x) =>
                      `${x.msg.t}:${x.msg.state?.nonce}:${x.msg.reason ?? ''}:${x.playerId.slice(0, 8)}`,
                  )
                  .join(' ')}\nALARMS ${JSON.stringify(w.coordinator.alarms)}`
              : ''),
        );
    }
  }

  const step = (name) => {
    log.push(name);
    const c = w.coordinator;
    const seated = w.seated;
    switch (name) {
      case 'hand':
      case 'bigHand': {
        if (seated.length < 2 || !c.canDeal()) return;
        const winner = r.pick(seated);
        const loser = r.pick(seated.filter((p) => p !== winner));
        if (loser.chips === 0) return;
        const amount = name === 'bigHand' ? loser.chips : r.int(1, Math.min(loser.chips, 60));
        w.playHand({ winner, loser, amount, rake: r.int(0, Math.min(2, amount)) });
        return;
      }
      case 'leave': {
        const p = seated.length > 0 ? r.pick(seated) : null;
        if (!p || p.leaving) return;
        const ack = c.requestLeave(p.playerId);
        if (!ack.ok) return;
        p.leaving = true;
        p.client.intent = 'leave';
        p.client.leaveAckNonce = BigInt(ack.head);
        w.pump();
        return;
      }
      case 'drop': {
        const p = seated.filter((x) => x.connected);
        if (p.length > 0) w.disconnect(r.pick(p));
        return;
      }
      case 'back': {
        const p = w.players.filter((x) => x.atTable && !x.connected);
        if (p.length === 0) return;
        const who = r.pick(p);
        who.connected = true;
        w.claim(who); // a reconnect claims again: the server resends the epoch, the bundle and any request
        return;
      }
      case 'reclaim': {
        const p = seated.length > 0 ? r.pick(seated) : null;
        if (p) w.claim(p, { playerId: `${p.name}-${r.int(1, 1e6)}` });
        return;
      }
      case 'holdSigs': {
        const p = seated.length > 0 ? r.pick(seated) : null;
        if (p && p.client.mode === 'auto') p.client.mode = 'manual';
        return;
      }
      case 'releaseSigs':
        for (const p of w.players) {
          if (p.client.mode !== 'auto') {
            p.client.mode = 'auto';
            if (p.connected) release(p);
            else p.client.held.length = 0;
          }
        }
        return;
      case 'refuseSigs': {
        const p = seated.length > 0 ? r.pick(seated) : null;
        if (p) p.client.mode = 'refuse';
        return;
      }
      case 'tick':
        w.tick(r.int(1, 40) * 1000);
        return;
      case 'longTick':
        w.tick(w.cfg.policy.signTimeoutMs + w.cfg.policy.stallExitMs + w.cfg.policy.absentGraceMs);
        w.settle();
        return;
      case 'chain':
        w.settle();
        if (r.chance(0.5)) w.advanceChain(r.int(1, 600));
        return;
      case 'exitWindow':
        w.advanceChain(w.chain.info.exitWindowSec + 1);
        w.settle();
        return;
      case 'restart':
        for (const p of w.players) p.client.watched = { rake: 0, pot: 0, missed: true };
        w.restart();
        for (const p of w.players) if (p.atTable && p.connected) w.claim(p);
        return;
      case 'join': {
        if (c.phase !== 'filling') return;
        for (const p of w.players) {
          if (!p.atTable && !w.chain.seat(c.tableKey, p.wallet) && r.chance(0.7)) {
            p.leaving = false;
            p.client.intent = 'play';
            p.client.leaveAckNonce = null;
            p.client.mode = 'auto';
            p.connected = true;
            deposit(p, r.int(100, 600));
          }
        }
        w.chainTick();
        claimAll();
        w.startEpoch();
        return;
      }
      default:
        throw new Error(`unknown action ${name}`);
    }
  };

  // start: three of the four deposit and play
  w.boot();
  w.settle();
  for (const p of w.players.slice(0, 3)) deposit(p, r.int(200, 600));
  w.chainTick();
  claimAll();
  w.startEpoch();
  invariants('start');

  for (let i = 0; i < STEPS; i++) {
    const name = pickAction(r);
    try {
      step(name);
      invariants(`step ${i} ${name}`);
    } catch (error) {
      error.message = `seed ${seed}, step ${i} (${log.slice(-8).join(' ')}): ${error.message}`;
      throw error;
    }
  }

  // wind down: everyone signs and comes back, everyone leaves, and the chain runs until the table is done
  for (const p of w.players) {
    p.client.mode = 'auto';
    if (p.atTable) {
      p.connected = true;
      w.claim(p);
      release(p);
    }
  }
  for (let round = 0; round < 12; round++) {
    const c = w.coordinator;
    for (const p of w.seated) {
      // asked every round: a request is idempotent, and a new epoch may have started since
      const ack = c.requestLeave(p.playerId);
      if (ack.ok) {
        p.leaving = true;
        p.client.intent = 'leave';
        p.client.leaveAckNonce ??= BigInt(ack.head);
      }
    }
    w.pump();
    // a depositor left alone in Filling cannot be paid by the server: they leave() on chain themselves
    if (c.phase === 'filling') {
      for (const p of w.seated) {
        if (w.chain.seat(c.tableKey, p.wallet)) {
          w.chain.leave(c.tableKey, p.wallet);
          w.chainTick();
        }
      }
    }
    w.tick(w.cfg.policy.signTimeoutMs + w.cfg.policy.stallExitMs + w.cfg.policy.absentGraceMs);
    w.settle();
    w.advanceChain(w.chain.info.exitWindowSec + 1);
    w.settle();
    if (w.seated.length === 0) break;
  }
  invariants('wind-down');
  if (w.seated.length > 0) {
    const c = w.coordinator;
    const row = w.chain.table(c.tableKey);
    const big = (_, v) => (typeof v === 'bigint' ? `${v}` : v);
    throw new Error(
      `seed ${seed}: not wound down: ${JSON.stringify(
        {
          phase: c.phase,
          halt: c.halt,
          view: c.publicView(),
          row: row && { status: row.status, nonce: row.nonce, exitDeadline: row.exitDeadline },
          chainTime: w.chain.chainTime(),
          seated: w.seated.map((p) => [p.name, p.chips, p.connected, p.client.mode, p.leaving]),
          proposals: w.proposals.slice(-3).map((x) => [x.nonce, x.state.isFinal]),
          bundles: w.bundles.slice(-3).map((b) => [b.bundle.state.nonce, b.bundle.state.isFinal]),
          jobs: w.store.pendingJobs().map((j) => [j.kind, j.status, j.error]),
          alarms: c.alarms.slice(-6),
          log: log.slice(-12),
        },
        big,
      )}`,
    );
  }
  // nothing stays locked: the vault holds no tokens, and every token ever minted for a deposit is back with
  // a player or with the house as rake
  expect(w.chain.balances.vault).toBe(0n);
  const paid = w.players.reduce((sum, p) => sum + w.chain.balances.of(p.wallet), 0n);
  expect(paid + w.chain.balances.house).toBe(w.chain.balances.minted);
  return { checked, steps: log.length };
}
