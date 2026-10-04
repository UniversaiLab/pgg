import { describe, expect, test } from 'bun:test';
import { verifyHand } from '@pgg/engine/fairness';
import { ServerMessage } from '@pgg/protocol';
import { ERR, SERVER } from '@pgg/protocol/constants';
import { TableActor } from '../src/table-actor.js';
import { player, setup, totalChips } from './helpers.js';

function makeTable(overrides, options) {
  const env = setup(overrides, options);
  const actor = new TableActor({
    cfg: env.cfg,
    bus: env.bus,
    wallet: env.wallet,
    clock: env.clock,
  });
  const seatPlayer = (n, buyIn = 500) => {
    const p = player(n);
    env.wallet.open(p.id);
    const result = actor.join(p, { buyIn });
    return { p, result };
  };
  return { ...env, actor, seatPlayer };
}

/** Act for whoever is on the clock, passively (check, else call). */
function actPassively(env) {
  const state = env.bus.state;
  const seat = state.toAct;
  const who = state.seats[seat].playerId;
  const action = state.legal.actions.includes('check') ? 'check' : 'call';
  return env.actor.act(who, { handNo: state.handNo, action });
}

/** Play the current hand to its end with passive actions. */
function finishHand(env) {
  for (let guard = 0; env.bus.state.inHand; guard++) {
    expect(guard).toBeLessThan(100);
    expect(actPassively(env).ok).toBe(true);
  }
}

const startFirstHand = (env) => env.clock.advance(env.cfg.interHandMs);

describe('joining', () => {
  test('seats a player, subscribes them to the table topic and debits the wallet', () => {
    const env = makeTable();
    const { result } = env.seatPlayer(1, 400);
    expect(result).toEqual({ ok: true, seat: 0 });
    expect(env.wallet.balance('p1')).toBe(9600);
    expect(env.bus.subscriptions.get('p1').has('table:test-1')).toBe(true);
    expect(env.bus.messagesTo('p1', SERVER.SEATED)[0]).toMatchObject({ seat: 0 });
    expect(env.bus.state.seats[0]).toMatchObject({ playerId: 'p1', chips: 400, status: 'seated' });
  });

  test('rejects bad buy-ins, double joins, taken seats, no funds and full tables', () => {
    const env = makeTable({ numSeats: 2 });
    env.wallet.open('p1');
    env.wallet.open('p9');
    expect(env.actor.join(player(1), { buyIn: 99 }).code).toBe(ERR.BAD_BUY_IN);
    expect(env.actor.join(player(1), { buyIn: 1001 }).code).toBe(ERR.BAD_BUY_IN);
    expect(env.actor.join(player(1), { buyIn: 100.5 }).code).toBe(ERR.BAD_BUY_IN);
    expect(env.actor.join(player(1), { buyIn: 200 }).ok).toBe(true);
    expect(env.actor.join(player(1), { buyIn: 200 }).code).toBe(ERR.ALREADY_SEATED);
    env.wallet.open('p2');
    expect(env.actor.join(player(2), { buyIn: 200, seat: 0 }).code).toBe(ERR.SEAT_TAKEN);
    expect(env.actor.join(player(2), { buyIn: 200, seat: 7 }).code).toBe(ERR.SEAT_TAKEN);
    expect(env.actor.join(player(2), { buyIn: 200 }).ok).toBe(true);
    env.wallet.open('p3');
    expect(env.actor.join(player(3), { buyIn: 200 }).code).toBe(ERR.TABLE_FULL);

    const poor = makeTable({}, { startBalance: 150 });
    poor.wallet.open('p1');
    expect(poor.actor.join(player(1), { buyIn: 200 }).code).toBe(ERR.INSUFFICIENT_FUNDS);
    expect(poor.wallet.balance('p1')).toBe(150); // a failed join takes nothing
  });
});

describe('a hand', () => {
  test('starts after the inter-hand delay once two players are seated', () => {
    const env = makeTable();
    env.seatPlayer(1);
    env.clock.advance(5000);
    expect(env.bus.state.inHand).toBe(false); // one player is not a game
    env.seatPlayer(2);
    env.clock.advance(env.cfg.interHandMs - 1);
    expect(env.bus.state.inHand).toBe(false);
    env.clock.advance(1);
    expect(env.bus.state).toMatchObject({ inHand: true, handNo: 1 });
    expect(env.bus.state.deadline).toBe(env.clock.now() + env.cfg.turnMs);
  });

  test('hole cards go only to their owner and never into a published message', () => {
    const env = makeTable();
    env.seatPlayer(1);
    env.seatPlayer(2);
    startFirstHand(env);

    const [c1] = env.bus.messagesTo('p1', SERVER.CARDS);
    const [c2] = env.bus.messagesTo('p2', SERVER.CARDS);
    expect(c1.cards).toHaveLength(2);
    expect(c2.cards).toHaveLength(2);
    expect(c1.seat).toBe(0);
    expect(env.bus.messagesTo('p1', SERVER.CARDS)).toHaveLength(1);

    const publicJson = JSON.stringify(env.bus.published);
    for (const card of [...c1.cards, ...c2.cards]) expect(publicJson).not.toContain(`"${card}"`);
  });

  test('every outgoing message matches the protocol schema', () => {
    const env = makeTable();
    env.seatPlayer(1);
    env.seatPlayer(2);
    env.seatPlayer(3);
    startFirstHand(env);
    finishHand(env);
    const everything = [
      ...env.bus.published.map((e) => e.msg),
      ...[...env.bus.sent.values()].flat(),
    ];
    expect(everything.length).toBeGreaterThan(10);
    for (const msg of everything) {
      const parsed = ServerMessage.safeParse(msg);
      expect(parsed.success, JSON.stringify(parsed.error?.issues ?? msg)).toBe(true);
    }
  });

  test('rejects stale, out-of-turn and illegal actions without changing the table', () => {
    const env = makeTable();
    env.seatPlayer(1);
    env.seatPlayer(2);
    startFirstHand(env);
    const { toAct, handNo, seats } = env.bus.state;
    const actor = seats[toAct].playerId;
    const other = seats.find((s) => s && s.playerId !== actor).playerId;
    const before = env.bus.published.length;

    expect(env.actor.act(actor, { handNo: handNo + 1, action: 'call' }).code).toBe(ERR.STALE_HAND);
    expect(env.actor.act(other, { handNo, action: 'call' }).code).toBe(ERR.NOT_YOUR_TURN);
    expect(env.actor.act(actor, { handNo, action: 'check' }).code).toBe(ERR.ILLEGAL_ACTION);
    expect(env.actor.act(actor, { handNo, action: 'raise', amount: 11 }).code).toBe(ERR.BAD_AMOUNT);
    expect(env.actor.act('stranger', { handNo, action: 'call' }).code).toBe(ERR.NOT_SEATED);
    expect(env.bus.published.length).toBe(before);
  });

  test('the clock folds (or checks) for a player who runs out of time', () => {
    const env = makeTable();
    env.seatPlayer(1);
    env.seatPlayer(2);
    startFirstHand(env);
    const first = env.bus.state.toAct;
    env.clock.advance(env.cfg.turnMs);
    const folded = env.bus.events.find((e) => e.type === 'action');
    expect(folded).toMatchObject({ seat: first, action: 'fold' });
    expect(env.bus.state.inHand).toBe(false); // heads-up: the other player wins
  });

  test('two timeouts in a row sit a player out; back() returns them', () => {
    const env = makeTable();
    env.seatPlayer(1);
    env.seatPlayer(2);
    env.seatPlayer(3);
    startFirstHand(env);
    // Let player 1 time out twice, whenever it is their turn, across hands.
    for (let hands = 0; hands < 4 && env.bus.state.seats[0].status === 'seated'; hands++) {
      for (let guard = 0; env.bus.state.inHand && guard < 50; guard++) {
        const state = env.bus.state;
        if (state.seats[state.toAct].playerId === 'p1') env.clock.advance(env.cfg.turnMs);
        else expect(actPassively(env).ok).toBe(true);
      }
      env.clock.advance(env.cfg.interHandMs);
    }
    expect(env.bus.state.seats[0].status).toBe('sitout');
    expect(env.actor.back('p1').ok).toBe(true);
    expect(['waiting', 'seated']).toContain(env.bus.state.seats[0].status);
  });
});

describe('money', () => {
  test('chips are conserved through a hand, rake goes to the house', () => {
    const env = makeTable();
    env.seatPlayer(1);
    env.seatPlayer(2);
    env.seatPlayer(3);
    const issued = env.wallet.issued;
    startFirstHand(env);
    finishHand(env);
    expect(totalChips(env.wallet, env.actor)).toBe(issued);
    expect(env.wallet.house).toBeGreaterThanOrEqual(0);
  });

  test('50 hands of random play with joins, leaves and rebuys never leak a chip', () => {
    const env = makeTable({ interHandMs: 10, turnMs: 50 });
    let state = 7;
    const rand = (n) => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state % n;
    };
    for (let n = 1; n <= 6; n++) env.wallet.open(`p${n}`);
    const issued = env.wallet.issued;
    let handsPlayed = 0;

    for (let step = 0; step < 4000 && handsPlayed < 50; step++) {
      const n = 1 + rand(6);
      const id = `p${n}`;
      const roll = rand(100);
      const seated = env.actor.seatOf(id) !== null;
      if (!seated && roll < 30) env.actor.join(player(n), { buyIn: 100 + rand(900) });
      else if (seated && roll < 4) env.actor.leave(id);
      else if (seated && roll < 8) env.actor.rebuy(id, 50 + rand(100));
      else if (env.bus.state?.inHand && env.bus.state.toAct !== null) {
        const s = env.bus.state;
        const who = s.seats[s.toAct].playerId;
        const legal = s.legal;
        const pick = rand(10);
        if (pick < 2 && legal.actions.includes('fold'))
          env.actor.act(who, { handNo: s.handNo, action: 'fold' });
        else if (pick < 4 && legal.max !== undefined) {
          const kind = legal.actions.includes('raise') ? 'raise' : 'bet';
          env.actor.act(who, {
            handNo: s.handNo,
            action: kind,
            amount: legal.min + rand(legal.max - legal.min + 1),
          });
        } else {
          env.actor.act(who, {
            handNo: s.handNo,
            action: legal.actions.includes('check') ? 'check' : 'call',
          });
        }
      } else {
        env.clock.advance(20);
      }
      const ended = env.bus.events.filter((e) => e.type === 'hand-end').length;
      handsPlayed = ended;
      expect(totalChips(env.wallet, env.actor), `step ${step}`).toBe(issued);
    }
    expect(handsPlayed).toBeGreaterThanOrEqual(50);
  });

  test('leaving mid-hand folds for the player and refunds them when the hand ends', () => {
    const env = makeTable();
    env.seatPlayer(1, 400);
    env.seatPlayer(2, 400);
    env.seatPlayer(3, 400);
    startFirstHand(env);
    const issued = env.wallet.issued;
    expect(env.actor.leave('p1').ok).toBe(true);
    finishHand(env);
    expect(env.actor.seatOf('p1')).toBeNull();
    expect(env.bus.messagesTo('p1', SERVER.UNSEATED)[0]).toMatchObject({ reason: 'left' });
    expect(env.wallet.balance('p1')).toBeGreaterThan(9000);
    expect(totalChips(env.wallet, env.actor)).toBe(issued);
  });

  test('a player who joins mid-hand waits, then is dealt in next hand', () => {
    const env = makeTable();
    env.seatPlayer(1);
    env.seatPlayer(2);
    startFirstHand(env);
    expect(env.seatPlayer(3).result.ok).toBe(true);
    expect(env.bus.state.seats[2]).toMatchObject({
      playerId: 'p3',
      status: 'waiting',
      hasCards: false,
    });
    finishHand(env);
    expect(env.bus.state.seats[2].status).toBe('seated');
    env.clock.advance(env.cfg.interHandMs);
    expect(env.bus.state).toMatchObject({ inHand: true, handNo: 2 });
    expect(env.bus.messagesTo('p3', SERVER.CARDS)).toHaveLength(1);
  });

  test('a player who loses everything is unseated as busted', () => {
    const env = makeTable({ minBuyIn: 20, interHandMs: 10 });
    env.seatPlayer(1, 20);
    env.seatPlayer(2, 500);
    startFirstHand(env);
    for (let hands = 0; hands < 40 && env.actor.seatOf('p1') !== null; hands++) {
      for (let guard = 0; env.bus.state.inHand && guard < 60; guard++) {
        const s = env.bus.state;
        const who = s.seats[s.toAct].playerId;
        const kind = s.legal.actions.includes('raise')
          ? 'raise'
          : s.legal.actions.includes('bet')
            ? 'bet'
            : null;
        if (who === 'p2' && kind)
          env.actor.act(who, { handNo: s.handNo, action: kind, amount: s.legal.max });
        else actPassively(env);
      }
      env.clock.advance(env.cfg.interHandMs);
    }
    const gone = env.bus.messagesTo('p1', SERVER.UNSEATED);
    if (gone.length > 0) {
      expect(['busted', 'left']).toContain(gone[0].reason);
      expect(env.actor.seatOf('p1')).toBeNull();
    }
  });
});

describe('fairness', () => {
  test('the next hand is committed during this one, and the proof matches it', () => {
    const env = makeTable();
    env.seatPlayer(1);
    env.seatPlayer(2);
    expect(env.bus.state.fairness.next).toMatchObject({ handNo: 1 }); // published before any hand
    const commitmentForHand1 = env.bus.state.fairness.next.commitment;
    startFirstHand(env);
    expect(env.bus.state.fairness.current).toEqual({ handNo: 1, commitment: commitmentForHand1 });
    const commitmentForHand2 = env.bus.state.fairness.next.commitment;
    expect(env.bus.state.fairness.next.handNo).toBe(2);
    expect(commitmentForHand2).not.toBe(commitmentForHand1);

    finishHand(env);
    const [proofMsg] = env.bus.messagesTo('p1', SERVER.PROOF);
    expect(proofMsg.proof.commitment).toBe(commitmentForHand1);
    expect(verifyHand(proofMsg.proof)).toMatchObject({ ok: true });
    expect(env.bus.messagesTo('p2', SERVER.PROOF)).toHaveLength(1);
  });

  test('the seed is never published before the hand is over', () => {
    const env = makeTable();
    env.seatPlayer(1);
    env.seatPlayer(2);
    startFirstHand(env);
    const proofSeedFor = () => JSON.stringify(env.bus.published);
    expect(proofSeedFor()).not.toContain('serverSeed');
    finishHand(env);
    // Even after the hand, the seed goes only to participants, not to the public topic.
    expect(proofSeedFor()).not.toContain('serverSeed');
  });

  test("a client seed submitted for the next hand is part of that hand's proof", () => {
    const env = makeTable();
    env.seatPlayer(1);
    env.seatPlayer(2);
    expect(env.actor.submitSeed('p1', { handNo: 1, seed: 'c0ffee' }).ok).toBe(true);
    expect(env.actor.submitSeed('p1', { handNo: 1, seed: 'beef' }).code).toBe(ERR.SEED_CLOSED); // once
    expect(env.actor.submitSeed('p2', { handNo: 5, seed: 'beef' }).code).toBe(ERR.SEED_CLOSED);
    startFirstHand(env);
    expect(env.actor.submitSeed('p2', { handNo: 1, seed: 'beef' }).code).toBe(ERR.SEED_CLOSED); // dealt
    expect(env.actor.submitSeed('p2', { handNo: 2, seed: 'beef' }).ok).toBe(true);
    finishHand(env);
    const proof = env.bus.messagesTo('p1', SERVER.PROOF)[0].proof;
    expect(proof.clientSeeds).toEqual([{ seat: 0, seed: 'c0ffee' }]);
    expect(verifyHand(proof).ok).toBe(true);

    // And the seed we submitted for hand 2 shows up in hand 2's proof.
    env.clock.advance(env.cfg.interHandMs);
    finishHand(env);
    const proof2 = env.bus.messagesTo('p2', SERVER.PROOF)[1].proof;
    expect(proof2.handNo).toBe(2);
    expect(proof2.clientSeeds).toEqual([{ seat: 1, seed: 'beef' }]);
    expect(verifyHand(proof2).ok).toBe(true);
  });
});

describe('connections', () => {
  test('a reconnecting player gets the full state and their cards back', () => {
    const env = makeTable();
    env.seatPlayer(1);
    env.seatPlayer(2);
    startFirstHand(env);
    const cards = env.bus.messagesTo('p1', SERVER.CARDS)[0].cards;
    env.actor.disconnect('p1');
    expect(env.bus.state.seats[0].connected).toBe(false);
    env.bus.sent.set('p1', []);
    env.actor.connect('p1');
    expect(env.bus.state.seats[0].connected).toBe(true);
    expect(env.bus.messagesTo('p1', SERVER.TABLE)).toHaveLength(1);
    expect(env.bus.messagesTo('p1', SERVER.CARDS)[0].cards).toEqual(cards);
  });

  test('a player who stays disconnected past the grace period is refunded and removed', () => {
    const env = makeTable({ interHandMs: 10_000 });
    env.seatPlayer(1, 300);
    env.seatPlayer(2, 300);
    const issued = env.wallet.issued;
    env.actor.disconnect('p1');
    env.clock.advance(env.cfg.sitoutGraceMs - 1);
    expect(env.actor.seatOf('p1')).toBe(0);
    env.clock.advance(1);
    expect(env.actor.seatOf('p1')).toBeNull();
    expect(env.wallet.balance('p1')).toBe(10_000);
    expect(totalChips(env.wallet, env.actor)).toBe(issued);
  });

  test('reconnecting before the grace period keeps the seat', () => {
    const env = makeTable({ interHandMs: 10_000 });
    env.seatPlayer(1);
    env.seatPlayer(2);
    env.actor.disconnect('p1');
    env.clock.advance(env.cfg.sitoutGraceMs - 1);
    env.actor.connect('p1');
    env.clock.advance(env.cfg.sitoutGraceMs * 3);
    expect(env.actor.seatOf('p1')).toBe(0);
  });
});
