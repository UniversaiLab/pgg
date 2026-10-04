import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { PokerTable } from '@pgg/engine';
import { SERVER } from '@pgg/protocol/constants';
import { TableActor } from '../src/table-actor.js';
import { player, setup, totalChips } from './helpers.js';

// A table that behaves normally until armed, then throws a plain Error from one chosen method —
// the kind of "impossible" failure the actor must contain.
function faulty(failOn) {
  const control = { armed: false };
  const create = (cfg) => {
    const real = new PokerTable({
      tableId: cfg.id,
      numSeats: cfg.numSeats,
      smallBlind: cfg.smallBlind,
      bigBlind: cfg.bigBlind,
      rake: { bps: cfg.rakeBps, cap: cfg.rakeCap },
    });
    return new Proxy(real, {
      get(target, prop) {
        if (control.armed && prop === failOn) {
          control.armed = false;
          return () => {
            throw new Error('boom');
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  return { control, create };
}

function twoPlayers(failOn) {
  const env = setup();
  const { control, create } = faulty(failOn);
  const actor = new TableActor({
    cfg: env.cfg,
    bus: env.bus,
    wallet: env.wallet,
    clock: env.clock,
    createTable: create,
  });
  for (const n of [1, 2]) {
    env.wallet.open(`p${n}`);
    actor.join(player(n), { buyIn: 500 });
  }
  return { ...env, actor, control, issued: env.wallet.issued };
}

let errors;
beforeEach(() => {
  errors = spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errors.mockRestore());

const startHand = (env) => env.clock.advance(env.cfg.interHandMs);
const events = (env) => env.bus.events.map((e) => e.type);

describe('a failing engine aborts the hand instead of wedging the table', () => {
  test('failure while a player acts: everyone is refunded and play resumes', () => {
    const env = twoPlayers('act');
    startHand(env);
    const { state } = env.bus;
    const who = state.seats[state.toAct].playerId;
    env.control.armed = true;
    const result = env.actor.act(who, { handNo: state.handNo, action: 'call' });

    expect(result.ok).toBe(false);
    expect(errors).toHaveBeenCalled();
    expect(events(env)).toContain('hand-aborted');
    expect(env.bus.state.inHand).toBe(false);
    expect(env.bus.state.seats.map((s) => s?.chips)).toEqual([
      500,
      500,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(totalChips(env.wallet, env.actor)).toBe(env.issued);
    // The seed of a hand that never finished is never revealed.
    expect(env.bus.messagesTo('p1', SERVER.PROOF)).toHaveLength(0);

    startHand(env); // the table carries on with the next hand
    expect(env.bus.state).toMatchObject({ inHand: true, handNo: 2 });
  });

  test('failure inside the turn timer', () => {
    const env = twoPlayers('act');
    startHand(env);
    env.control.armed = true;
    env.clock.advance(env.cfg.turnMs);
    expect(events(env)).toContain('hand-aborted');
    expect(env.bus.state.inHand).toBe(false);
    expect(totalChips(env.wallet, env.actor)).toBe(env.issued);
    startHand(env);
    expect(env.bus.state.inHand).toBe(true);
  });

  test('failure while dealing', () => {
    const env = twoPlayers('startHand');
    env.control.armed = true;
    startHand(env);
    expect(errors).toHaveBeenCalled();
    expect(env.bus.state.inHand).toBe(false);
    expect(totalChips(env.wallet, env.actor)).toBe(env.issued);
    startHand(env); // retried
    expect(env.bus.state).toMatchObject({ inHand: true });
  });

  test('the table can keep playing many hands after a failure', () => {
    const env = twoPlayers('act');
    startHand(env);
    env.control.armed = true;
    env.clock.advance(env.cfg.turnMs);
    for (let i = 0; i < 5; i++) {
      startHand(env);
      while (env.bus.state.inHand) {
        const { toAct, seats, handNo, legal } = env.bus.state;
        const action = legal.actions.includes('check') ? 'check' : 'call';
        env.actor.act(seats[toAct].playerId, { handNo, action }); // the players actually play
      }
    }
    expect(env.bus.events.filter((e) => e.type === 'hand-end').length).toBe(5);
    expect(totalChips(env.wallet, env.actor)).toBe(env.issued);
  });
});
