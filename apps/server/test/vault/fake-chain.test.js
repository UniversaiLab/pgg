import { describe, expect, test } from 'bun:test';
import { buildNextState, hashState, rosterHash } from '@pgg/vault';
import { EVENT_TYPES, makeJob } from '../../src/vault/chain-port.js';
import { expectOk, FakeChain } from '../../src/vault/fake-chain.js';
import { addressFor, makeWorld, UNIT } from './fake-chain-world.js';

const ZERO_HASH = `0x${'00'.repeat(32)}`;
const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;
const MAX_UINT256 = 2n ** 256n - 1n;
const revert = (error, ...args) => ({ ok: false, error, args });
const ok = { ok: true };
const stranger = addressFor('stranger');

/** An Active table of three seats (deposits 1000 chips + dust each) and its epoch baseline. */
function active(options) {
  const w = makeWorld(options);
  const genesis = w.activate();
  return { w, g: genesis, chain: w.chain };
}
const arbiterOf = (w) => w.chain.info.arbiter;
const relayerOf = (w) => w.chain.info.relayer;
const typesOf = (events) => events.map((e) => e.type);
const failures = (chain) => chain.delivered.filter((e) => e.type === EVENT_TYPES.JobFailed);

describe('construction', () => {
  test('defaults: a chain with the contract-shaped info, frozen', () => {
    const chain = new FakeChain();
    expect(chain.info).toEqual({
      chainId: 31337,
      vault: '0x00000000000000000000000000000000000dead1',
      arbiter: '0x000000000000000000000000000000000000a2b1',
      relayer: '0x00000000000000000000000000000000005e1a01',
      maxRakeBps: 500,
      exitWindowSec: 3600,
    });
    expect(Object.isFrozen(chain.info)).toBe(true);
    expect(chain.chainTime()).toBe(1_700_000_000);
    expect(chain.table(`0x${'11'.repeat(32)}`)).toBeNull();
    expect(chain.seat(`0x${'11'.repeat(32)}`, stranger)).toBeNull();
  });

  test('refuses what the contract constructor refuses (BadConfig)', () => {
    expect(() => new FakeChain({ maxRakeBps: 501 })).toThrow(/BadConfig/);
    expect(() => new FakeChain({ maxRakeBps: -1 })).toThrow(/BadConfig/);
    expect(() => new FakeChain({ maxRakeBps: 2.5 })).toThrow(/BadConfig/);
    expect(() => new FakeChain({ exitWindowSec: 3599 })).toThrow(/BadConfig/);
    expect(() => new FakeChain({ exitWindowSec: 30 * 86_400 + 1 })).toThrow(/BadConfig/);
    expect(() => new FakeChain({ startTime: -1 })).toThrow(RangeError);
    expect(new FakeChain({ maxRakeBps: 500, exitWindowSec: 3600 }).info.exitWindowSec).toBe(3600);
    expect(new FakeChain({ maxRakeBps: 0, exitWindowSec: 30 * 86_400 }).info.exitWindowSec).toBe(
      30 * 86_400,
    );
  });

  test('a job needs a resolver, loudly', () => {
    const chain = new FakeChain();
    const job = makeJob('start', `0x${'11'.repeat(32)}`);
    chain.submit(job);
    expect(() => chain.tick()).toThrow(/no resolver/);
    expect(chain.queued).toEqual([job.key]); // nothing was consumed
    expect(() => {
      chain.resolver = {};
    }).toThrow(TypeError);
    expect(() => {
      chain.resolver = null;
    }).toThrow(TypeError);
  });

  test('never reads the wall clock or Math.random', () => {
    const realNow = Date.now;
    const realRandom = Math.random;
    Date.now = () => {
      throw new Error('Date.now');
    };
    Math.random = () => {
      throw new Error('Math.random');
    };
    try {
      const { w, g } = active();
      const s1 = w.hand(g);
      expectOk(w.chain.send(w.players[0], 'startExit', { bundle: w.bundle(s1) }));
      w.chain.advanceTime(3601);
      w.chain.tick();
      w.run('finalizeExit', { state: s1 });
      expect(w.chain.table(w.tableKey).status).toBe('Closed');
    } finally {
      Date.now = realNow;
      Math.random = realRandom;
    }
  });
});

describe('createTable', () => {
  test('the arbiter creates a table: Filling, its parameters, and a TableCreated event', () => {
    const w = makeWorld();
    const sink = [];
    w.chain.subscribe((e) => sink.push(e));
    const result = w.createTable({ maxPlayers: 4, minDeposit: 100n, maxDeposit: 5000n });
    expect(result.jobs).toEqual([
      expect.objectContaining({ kind: 'createTable', outcome: 'sent', sender: arbiterOf(w) }),
    ]);
    expect(w.chain.table(w.tableKey)).toEqual({
      status: 'Filling',
      nonce: 0n,
      escrow: 0n,
      rakePaid: 0n,
      rosterHash: ZERO_HASH,
      exitDeadline: 0,
      exitDigest: ZERO_HASH,
      arbiter: arbiterOf(w),
      seated: 0,
      maxPlayers: 4,
      minDeposit: 100n,
      maxDeposit: 5000n,
    });
    expect(sink).toEqual([
      {
        type: 'TableCreated',
        tableKey: w.tableKey,
        block: expect.any(Number),
        logIndex: 0,
        arbiter: arbiterOf(w),
        maxPlayers: 4,
        minDeposit: 100n,
        maxDeposit: 5000n,
      },
    ]);
  });

  test('only the vault arbiter: NotArbiter for anyone else, checked after the pause and before TableExists', () => {
    const w = makeWorld();
    const args = { tableKey: w.tableKey, maxPlayers: 3, minDeposit: 1n, maxDeposit: 10n };
    expect(w.chain.send(stranger, 'createTable', args)).toEqual(revert('NotArbiter'));
    expect(w.chain.send(relayerOf(w), 'createTable', args)).toEqual(revert('NotArbiter'));
    expect(w.chain.send(arbiterOf(w), 'createTable', args)).toEqual(ok);
    expect(w.chain.send(stranger, 'createTable', args)).toEqual(revert('NotArbiter'));
    expect(w.chain.send(arbiterOf(w), 'createTable', args)).toEqual(revert('TableExists'));
    w.chain.pause(true);
    expect(w.chain.send(stranger, 'createTable', args)).toEqual(revert('EnforcedPause'));
  });

  test('BadTableParams: zero id, fewer than 2 or more than 10 seats, zero or inverted deposits', () => {
    const w = makeWorld();
    const make = (patch) => ({
      tableKey: w.tableKey,
      maxPlayers: 6,
      minDeposit: 1n,
      maxDeposit: 10n,
      ...patch,
    });
    const send = (patch) => w.chain.send(arbiterOf(w), 'createTable', make(patch));
    expect(send({ tableKey: ZERO_HASH })).toEqual(revert('BadTableParams'));
    for (const maxPlayers of [0, 1, 11, 255]) {
      expect(send({ maxPlayers })).toEqual(revert('BadTableParams'));
    }
    expect(send({ minDeposit: 0n })).toEqual(revert('BadTableParams'));
    expect(send({ minDeposit: 11n })).toEqual(revert('BadTableParams'));
    expect(w.chain.live(w.tableKey)).toBeNull(); // nothing was created
    // the edges are fine
    expect(send({ maxPlayers: 2, minDeposit: 10n, maxDeposit: 10n })).toEqual(ok);
    const other = `0x${'77'.repeat(32)}`;
    expect(send({ tableKey: other, maxPlayers: 10 })).toEqual(ok);
  });

  test('the checks run in the contract order: TableExists before BadTableParams', () => {
    const w = makeWorld();
    w.createTable();
    expect(
      w.chain.send(arbiterOf(w), 'createTable', {
        tableKey: w.tableKey,
        maxPlayers: 0,
        minDeposit: 0n,
        maxDeposit: 0n,
      }),
    ).toEqual(revert('TableExists'));
  });

  test('arguments the ABI could not even encode are Malformed, not a contract error', () => {
    const w = makeWorld();
    const base = { tableKey: w.tableKey, maxPlayers: 6, minDeposit: 1n, maxDeposit: 10n };
    for (const patch of [
      { maxPlayers: 256 },
      { maxPlayers: -1 },
      { maxPlayers: 2.5 },
      { minDeposit: -1n },
      { maxDeposit: MAX_UINT256 + 1n },
      { tableKey: '0x12' },
      { tableKey: undefined },
    ]) {
      const result = w.chain.send(arbiterOf(w), 'createTable', { ...base, ...patch });
      expect(result.error).toBe('Malformed');
    }
  });

  test("after the owner rotates the vault arbiter the server's createTable is refused, as JobFailed", () => {
    const w = makeWorld();
    w.chain.setVaultArbiter(addressFor('new-arbiter'));
    w.createTable();
    expect(failures(w.chain)).toEqual([
      expect.objectContaining({ kind: 'createTable', error: 'NotArbiter', retryable: false }),
    ]);
    expect(w.chain.table(w.tableKey)).toBeNull();
  });
});

describe('deposit, setSessionKey, leave (Filling)', () => {
  const filling = (create = { maxPlayers: 3, minDeposit: 100n, maxDeposit: 5000n }) => {
    const w = makeWorld();
    w.createTable(create);
    for (const seat of w.seats) w.chain.mint(seat.wallet, 100_000n);
    return w;
  };
  const key = (w, i) => w.seats[i].session;

  test('a deposit seats the player: a Deposited event, escrow, seat, and the tokens move to the vault', () => {
    const w = filling();
    const [a] = w.seats;
    expect(w.chain.deposit(w.tableKey, a.wallet, 1000n, key(w, 0))).toEqual(ok);
    w.chain.tick();
    expect(w.chain.seat(w.tableKey, a.wallet)).toEqual({
      deposit: 1000n,
      sessionKey: key(w, 0),
      confirmed: true,
    });
    expect(w.chain.table(w.tableKey)).toMatchObject({ seated: 1, escrow: 1000n });
    expect(w.chain.balances.of(a.wallet)).toBe(99_000n);
    expect(w.chain.balances.vault).toBe(1000n);
    expect(w.chain.totalLocked).toBe(1000n);
    expect(w.chain.delivered.at(-1)).toMatchObject({
      type: 'Deposited',
      tableKey: w.tableKey,
      player: a.wallet,
      amount: 1000n,
      total: 1000n,
      sessionKey: key(w, 0),
    });
  });

  test('WrongStatus: no such table, and a table that is not Filling', () => {
    const w = makeWorld();
    w.chain.mint(w.players[0], 1000n);
    expect(w.chain.deposit(w.tableKey, w.players[0], 500n, key(w, 0))).toEqual(
      revert('WrongStatus', 0),
    );
    const { w: aw } = active();
    aw.chain.mint(aw.players[0], 1000n);
    expect(aw.chain.deposit(aw.tableKey, aw.players[0], 500n, aw.seats[0].session)).toEqual(
      revert('WrongStatus', 2),
    );
  });

  test('the checks run in the contract order', () => {
    const w = filling();
    const [a, b, c, d] = [0, 1, 2, 2].map((i) => w.seats[i]);
    const zero = ZERO_ADDRESS;
    // status first
    expect(w.chain.deposit(`0x${'99'.repeat(32)}`, a.wallet, 0n, zero)).toEqual(
      revert('WrongStatus', 0),
    );
    // then amount, then the session key, then the range
    expect(w.chain.deposit(w.tableKey, a.wallet, 0n, zero)).toEqual(revert('ZeroAmount'));
    expect(w.chain.deposit(w.tableKey, a.wallet, 50n, zero)).toEqual(revert('BadSessionKey'));
    expect(w.chain.deposit(w.tableKey, a.wallet, 50n, a.session)).toEqual(
      revert('DepositOutOfRange'),
    );
    expect(w.chain.deposit(w.tableKey, a.wallet, 5001n, a.session)).toEqual(
      revert('DepositOutOfRange'),
    );
    // the range before the seat limit
    for (const s of [a, b, c]) expectOk(w.chain.deposit(w.tableKey, s.wallet, 100n, s.session));
    const late = addressFor('late');
    w.chain.mint(late, 10_000n);
    expect(w.chain.deposit(w.tableKey, late, 99n, a.session)).toEqual(revert('DepositOutOfRange'));
    expect(w.chain.deposit(w.tableKey, late, 100n, a.session)).toEqual(revert('TableFull'));
    expect(d.wallet).toBe(c.wallet);
  });

  test('range limits are inclusive, and a top-up is judged on the total', () => {
    const w = filling();
    const [a] = w.seats;
    expect(w.chain.deposit(w.tableKey, a.wallet, 100n, a.session)).toEqual(ok); // min
    expect(w.chain.deposit(w.tableKey, a.wallet, 1n, a.session)).toEqual(ok); // a top-up below the minimum is fine
    expect(w.chain.deposit(w.tableKey, a.wallet, 4899n, a.session)).toEqual(ok); // total = max
    expect(w.chain.deposit(w.tableKey, a.wallet, 1n, a.session)).toEqual(
      revert('DepositOutOfRange'),
    );
    expect(w.chain.live(w.tableKey).seats.get(a.wallet).deposit).toBe(5000n);
    expect(w.chain.live(w.tableKey)).toMatchObject({ seated: 1, escrow: 5000n });
  });

  test('a total that overflows uint256 is Panic(0x11), before the range is looked at', () => {
    const w = makeWorld();
    w.createTable({ maxPlayers: 3, minDeposit: 1n, maxDeposit: MAX_UINT256 });
    const [a] = w.seats;
    w.chain.mint(a.wallet, MAX_UINT256);
    expect(w.chain.deposit(w.tableKey, a.wallet, MAX_UINT256 - 1n, a.session)).toEqual(ok);
    expect(w.chain.deposit(w.tableKey, a.wallet, 2n, a.session)).toEqual(revert('Panic', 0x11n));
    expect(w.chain.deposit(w.tableKey, a.wallet, 1n, a.session)).toEqual(ok); // exactly the maximum
    expect(w.chain.live(w.tableKey).seats.get(a.wallet).deposit).toBe(MAX_UINT256);
  });

  test('a top-up replaces the session key and does not take a second seat; a full table still accepts a top-up', () => {
    const w = filling();
    const [a, b, c] = w.seats;
    for (const s of [a, b, c]) expectOk(w.chain.deposit(w.tableKey, s.wallet, 200n, s.session));
    expect(w.chain.live(w.tableKey).seated).toBe(3);
    expect(w.chain.deposit(w.tableKey, a.wallet, 300n, b.session)).toEqual(ok);
    const row = w.chain.live(w.tableKey);
    expect(row.seated).toBe(3);
    expect(row.seats.get(a.wallet)).toEqual({
      deposit: 500n,
      sessionKey: b.session,
      confirmed: true,
    });
  });

  test('a poor player cannot deposit: the token says no, and nothing changes', () => {
    const w = filling();
    const [a] = w.seats;
    const poor = addressFor('poor');
    w.chain.mint(poor, 150n);
    const before = w.chain.block;
    expect(w.chain.deposit(w.tableKey, poor, 200n, a.session)).toEqual(
      revert('ERC20InsufficientBalance', poor, 150n, 200n),
    );
    expect(w.chain.block).toBe(before);
    expect(w.chain.live(w.tableKey)).toMatchObject({ seated: 0, escrow: 0n });
    expect(w.chain.balances.of(poor)).toBe(150n);
    expect(w.chain.invariants().ok).toBe(true);
  });

  test('autoMint funds a deposit that would otherwise fail', () => {
    const w = makeWorld({ chainOptions: { autoMint: true } });
    w.createTable();
    expect(w.chain.deposit(w.tableKey, w.players[0], 5000n * UNIT, w.seats[0].session)).toEqual(ok);
    expect(w.chain.balances.of(w.players[0])).toBe(0n);
    expect(w.chain.balances.minted).toBe(5000n * UNIT);
    expect(w.chain.balances.total).toBe(5000n * UNIT);
  });

  test('setSessionKey: only a seated player, while Filling, and never the zero key', () => {
    const w = filling();
    const [a, b] = w.seats;
    expect(w.chain.setSessionKey(w.tableKey, a.wallet, b.session)).toEqual(revert('NoSeat'));
    expectOk(w.chain.deposit(w.tableKey, a.wallet, 200n, a.session));
    expect(w.chain.setSessionKey(w.tableKey, a.wallet, ZERO_ADDRESS)).toEqual(
      revert('BadSessionKey'),
    );
    expect(w.chain.setSessionKey(`0x${'99'.repeat(32)}`, a.wallet, b.session)).toEqual(
      revert('WrongStatus', 0),
    );
    expect(w.chain.setSessionKey(w.tableKey, a.wallet, b.session)).toEqual(ok);
    w.chain.tick();
    expect(w.chain.seat(w.tableKey, a.wallet)).toMatchObject({
      deposit: 200n,
      sessionKey: b.session,
    });
    expect(w.chain.delivered.at(-1)).toMatchObject({
      type: 'SessionKeySet',
      player: a.wallet,
      sessionKey: b.session,
    });
  });

  test('leave returns the whole stake: Left, then Payout, and the seat is gone', () => {
    const w = filling();
    const [a, b] = w.seats;
    expectOk(w.chain.deposit(w.tableKey, a.wallet, 700n, a.session));
    expectOk(w.chain.deposit(w.tableKey, b.wallet, 300n, b.session));
    expect(w.chain.leave(w.tableKey, a.wallet)).toEqual(ok);
    w.chain.tick();
    expect(w.chain.balances.of(a.wallet)).toBe(100_000n);
    expect(w.chain.table(w.tableKey)).toMatchObject({ seated: 1, escrow: 300n });
    expect(w.chain.seat(w.tableKey, a.wallet)).toBeNull();
    const tail = w.chain.delivered.slice(-2);
    expect(tail[0]).toMatchObject({ type: 'Left', player: a.wallet, amount: 700n });
    expect(tail[1]).toMatchObject({ type: 'Payout', to: a.wallet, amount: 700n, pushed: true });
    expect(tail[1].block).toBe(tail[0].block);
    expect(tail[1].logIndex).toBe(tail[0].logIndex + 1);
    expect(w.chain.leave(w.tableKey, a.wallet)).toEqual(revert('NoSeat'));
    expect(w.chain.totalLocked).toBe(300n);
    expect(w.chain.invariants().ok).toBe(true);
  });

  test('leave is refused on a table that is not Filling', () => {
    const { w } = active();
    expect(w.chain.leave(w.tableKey, w.players[0])).toEqual(revert('WrongStatus', 2));
    expect(w.chain.leave(`0x${'99'.repeat(32)}`, w.players[0])).toEqual(revert('WrongStatus', 0));
  });

  test('a seat can be freed and taken again; the seat count follows', () => {
    const w = filling();
    const [a, b, c] = w.seats;
    for (const s of [a, b, c]) expectOk(w.chain.deposit(w.tableKey, s.wallet, 100n, s.session));
    const late = addressFor('late');
    w.chain.mint(late, 1000n);
    expect(w.chain.deposit(w.tableKey, late, 100n, a.session)).toEqual(revert('TableFull'));
    expectOk(w.chain.leave(w.tableKey, b.wallet));
    expect(w.chain.deposit(w.tableKey, late, 100n, a.session)).toEqual(ok);
    expect(w.chain.live(w.tableKey).seated).toBe(3);
  });

  test('addresses and keys may be given in any case', () => {
    const w = filling();
    const [a] = w.seats;
    const mixed = `0x${a.wallet.slice(2).replace(/[a-f]/g, (c) => c.toUpperCase())}`;
    expectOk(w.chain.deposit(w.tableKey.toUpperCase().replace('0X', '0x'), mixed, 200n, a.session));
    w.chain.tick();
    expect(w.chain.seat(w.tableKey.toUpperCase().replace('0X', '0x'), mixed)).toMatchObject({
      deposit: 200n,
    });
    expect(w.chain.table(w.tableKey.toUpperCase().replace('0X', '0x'))).toMatchObject({
      seated: 1,
    });
  });

  test('an unconfirmed deposit is visible with confirmed:false until setConfirmed and the next poll', () => {
    const w = filling();
    const [a] = w.seats;
    expectOk(w.chain.deposit(w.tableKey, a.wallet, 200n, a.session, { confirmed: false }));
    w.chain.tick();
    expect(w.chain.seat(w.tableKey, a.wallet)).toEqual({
      deposit: 200n,
      sessionKey: a.session,
      confirmed: false,
    });
    w.chain.setConfirmed(w.tableKey, a.wallet, true);
    expect(w.chain.seat(w.tableKey, a.wallet).confirmed).toBe(false); // the view moves with the poll
    w.chain.tick();
    expect(w.chain.seat(w.tableKey, a.wallet).confirmed).toBe(true);
    w.chain.setConfirmed(w.tableKey, a.wallet, false);
    w.chain.tick();
    expect(w.chain.seat(w.tableKey, a.wallet).confirmed).toBe(false);
    expect(() => w.chain.setConfirmed(w.tableKey, stranger, true)).toThrow(/no such seat/);
  });

  test('what seat() returns is a copy', () => {
    const w = filling();
    const [a] = w.seats;
    expectOk(w.chain.deposit(w.tableKey, a.wallet, 200n, a.session));
    w.chain.tick();
    const seat = w.chain.seat(w.tableKey, a.wallet);
    seat.deposit = 0n;
    expect(w.chain.seat(w.tableKey, a.wallet).deposit).toBe(200n);
    expect(Object.isFrozen(w.chain.table(w.tableKey))).toBe(true);
  });
});

describe('start', () => {
  const filled = () => {
    const w = makeWorld();
    w.createTable();
    w.depositAll();
    return w;
  };
  const start = (w, sender, players, tableKey = w.tableKey) =>
    w.chain.send(sender, 'start', { tableKey, players });

  test('freezes the roster: Active, the roster hash, and a Started event with the players', () => {
    const w = filled();
    const sink = [];
    w.chain.subscribe((e) => sink.push(e));
    expect(start(w, arbiterOf(w), w.players)).toEqual(ok);
    w.chain.tick();
    expect(w.chain.table(w.tableKey)).toMatchObject({
      status: 'Active',
      rosterHash: rosterHash(w.players),
      nonce: 0n,
    });
    expect(sink[0]).toMatchObject({ type: 'Started', tableKey: w.tableKey, players: w.players });
  });

  test("only the table's arbiter, and only for a Filling table (NotArbiter, then WrongStatus)", () => {
    const w = filled();
    for (const who of [relayerOf(w), stranger, w.players[0]]) {
      expect(start(w, who, w.players)).toEqual(revert('NotArbiter'));
    }
    expect(start(w, arbiterOf(w), w.players, `0x${'99'.repeat(32)}`)).toEqual(revert('NotArbiter')); // no table: its arbiter is the zero address
    expectOk(start(w, arbiterOf(w), w.players));
    expect(start(w, stranger, w.players)).toEqual(revert('NotArbiter'));
    expect(start(w, arbiterOf(w), w.players)).toEqual(revert('WrongStatus', 2));
  });

  test('BadRoster: exactly the seated set, sorted, distinct, at least two', () => {
    const w = filled();
    const [p0, p1, p2] = w.players;
    const bad = [
      [p0, p1], // one missing
      [p1, p2],
      [p0, p1, p2, stranger], // one extra
      [p2, p1, p0], // not ascending
      [p0, p0, p1], // duplicate
      [p0, p1, p1],
      [p0, p1, stranger], // right count, a stranger instead of p2
      [],
      [p0],
    ];
    for (const players of bad) {
      expect(start(w, arbiterOf(w), players)).toEqual(revert('BadRoster'));
    }
    expect(w.chain.live(w.tableKey).status).toBe('Filling');
    expect(start(w, arbiterOf(w), [ZERO_ADDRESS, p1, p2])).toEqual(revert('BadRoster'));
  });

  test('two seats are enough, and one is not', () => {
    const w = makeWorld({ names: ['alice', 'bob'] });
    w.createTable();
    w.chain.mint(w.players[0], 10_000n * UNIT);
    expectOk(w.chain.deposit(w.tableKey, w.players[0], UNIT, w.seats[0].session));
    expect(start(w, arbiterOf(w), [w.players[0]])).toEqual(revert('BadRoster'));
    w.chain.mint(w.players[1], 10_000n * UNIT);
    expectOk(w.chain.deposit(w.tableKey, w.players[1], UNIT, w.seats[1].session));
    expect(start(w, arbiterOf(w), w.players)).toEqual(ok);
  });

  test('the pause stops a start (retryable), and a start works again after unpause', () => {
    const w = filled();
    w.chain.pause(true);
    expect(start(w, arbiterOf(w), w.players)).toEqual(revert('EnforcedPause'));
    w.run('start', { players: w.players });
    expect(failures(w.chain).at(-1)).toMatchObject({
      kind: 'start',
      error: 'EnforcedPause',
      retryable: true,
    });
    w.chain.pause(false);
    expect(w.run('start', { players: w.players }).jobs[0].outcome).toBe('sent');
    expect(w.chain.table(w.tableKey).status).toBe('Active');
  });

  test('after start nobody can deposit or leave', () => {
    const w = filled();
    expectOk(start(w, arbiterOf(w), w.players));
    w.chain.mint(w.players[0], 1000n);
    expect(w.chain.deposit(w.tableKey, w.players[0], 500n, w.seats[0].session)).toEqual(
      revert('WrongStatus', 2),
    );
    expect(w.chain.leave(w.tableKey, w.players[0])).toEqual(revert('WrongStatus', 2));
  });

  test('roster addresses may be given in any case', () => {
    const w = filled();
    const upper = w.players.map((p) => `0x${p.slice(2).toUpperCase()}`);
    expect(start(w, arbiterOf(w), upper)).toEqual(ok);
  });
});

describe('settle', () => {
  const settleAs = (w, bundle, sender = relayerOf(w)) => w.chain.send(sender, 'settle', { bundle });

  test('a final state pays the leavers and the house and rolls the stayers over; the table is Filling', () => {
    const { w, g, chain } = active();
    const hand = w.hand(g, { winner: 0, loser: 1, amount: 100n, rake: 2n });
    const fin = w.final(hand, [true, false, true]);
    const sink = [];
    chain.subscribe((e) => sink.push(e));
    expect(settleAs(w, w.bundle(fin))).toEqual(ok);
    chain.tick();

    expect(chain.table(w.tableKey)).toEqual({
      status: 'Filling',
      nonce: 2n,
      escrow: fin.balances[0] + fin.balances[2],
      rakePaid: 2n * UNIT,
      rosterHash: ZERO_HASH,
      exitDeadline: 0,
      exitDigest: ZERO_HASH,
      arbiter: arbiterOf(w),
      seated: 2,
      maxPlayers: 6,
      minDeposit: UNIT,
      maxDeposit: 10_000_000n * UNIT,
    });
    // the leaver is paid out and unseated; the stayers keep their (new) balance as their deposit
    expect(chain.seat(w.tableKey, w.players[1])).toBeNull();
    expect(chain.balances.of(w.players[1])).toBe(fin.balances[1]);
    expect(chain.seat(w.tableKey, w.players[0])).toMatchObject({
      deposit: fin.balances[0],
      sessionKey: w.seats[0].session,
    });
    expect(chain.seat(w.tableKey, w.players[2])).toMatchObject({ deposit: fin.balances[2] });
    expect(chain.balances.house).toBe(2n * UNIT);
    expect(chain.balances.vault).toBe(fin.balances[0] + fin.balances[2]);
    expect(chain.invariants().ok).toBe(true);

    expect(sink.map((e) => e.type)).toEqual(['Settled', 'Payout', 'Payout']);
    expect(sink[0]).toMatchObject({
      nonce: 2n,
      rakePaid: 2n * UNIT,
      rakeDelta: 2n * UNIT,
      stayers: 2,
    });
    expect(sink[1]).toMatchObject({ to: w.players[1], amount: fin.balances[1], pushed: true });
    expect(sink[2]).toMatchObject({ to: chain.houseAddress, amount: 2n * UNIT, pushed: true });
    expect(new Set(sink.map((e) => e.block)).size).toBe(1); // one transaction, one block
    expect(sink.map((e) => e.logIndex)).toEqual([0, 1, 2]);
  });

  test('everyone leaving pays everyone in roster order; a zero balance gets no Payout; no rake, no house payout', () => {
    const w = makeWorld();
    const g = w.activate([UNIT * 10n, UNIT * 20n, UNIT * 30n]);
    const lost = w.hand(g, { winner: 0, loser: 1, amount: 20n, rake: 0n });
    const fin = w.final(lost, [false, false, false]);
    expect(fin.balances[1]).toBe(0n);
    const sink = [];
    w.chain.subscribe((e) => sink.push(e));
    expect(settleAs(w, w.bundle(fin))).toEqual(ok);
    w.chain.tick();
    expect(sink.filter((e) => e.type === 'Payout').map((e) => e.to)).toEqual([
      w.players[0],
      w.players[2],
    ]);
    expect(w.chain.table(w.tableKey)).toMatchObject({ status: 'Filling', seated: 0, escrow: 0n });
    expect(w.chain.invariants().ok).toBe(true);
  });

  test('every refusal of the contract, with its name and arguments', () => {
    const { w, g, chain } = active();
    const hand = w.hand(g);
    const fin = w.final(hand);
    const U256 = MAX_UINT256;

    // NotFinal is the first check
    expect(settleAs(w, w.bundle(hand))).toEqual(revert('NotFinal'));
    // a nonce that does not beat the table's
    expect(settleAs(w, w.bundle({ ...fin, nonce: 0n }))).toEqual(revert('StaleNonce', 0n, 0n));
    // the roster
    expect(
      settleAs(w, w.bundle({ ...fin, players: [w.players[0], w.players[1], stranger].sort() })),
    ).toEqual(revert('RosterMismatch'));
    // the rake cap: rake 1000 of volume 0
    expect(settleAs(w, w.bundle({ ...fin, rake: 1000n, volume: 0n }))).toEqual(
      revert('RakeTooHigh'),
    );
    // conservation
    const off = { ...fin, balances: [fin.balances[0] + 1n, fin.balances[1], fin.balances[2]] };
    const claimed = off.balances.reduce((a, c) => a + c, 0n) + fin.rake;
    expect(settleAs(w, w.bundle(off))).toEqual(
      revert('NotConserved', claimed, chain.live(w.tableKey).escrow),
    );
    // signatures: the arbiter first
    const strangerKey = w.partial(fin, { noArbiter: true });
    expect(settleAs(w, strangerKey)).toEqual(revert('BadSignature', U256));
    expect(settleAs(w, w.partial(fin, { skip: 1 }))).toEqual(revert('BadSignature', 1n));
    expect(settleAs(w, w.partial(fin, { skip: 0 }))).toEqual(revert('BadSignature', 0n));
    // arbiter checked before any player
    expect(
      settleAs(w, { ...w.partial(fin, { skip: 0 }), arbiterSig: strangerKey.arbiterSig }),
    ).toEqual(revert('BadSignature', U256));
    // lengths
    const full = w.bundle(fin);
    expect(settleAs(w, { ...full, playerSigs: full.playerSigs.slice(1) })).toEqual(
      revert('BadLength'),
    );
    // a signature that is not 65 bytes reverts inside ECDSA
    expect(settleAs(w, { ...full, arbiterSig: full.arbiterSig.slice(0, -2) })).toEqual(
      revert('ECDSAInvalidSignatureLength', 64n),
    );
    // nothing above changed anything
    expect(chain.table(w.tableKey)).toMatchObject({ status: 'Active', nonce: 0n });
  });

  test('BadKeep: a kept seat with nothing left, after the signatures', () => {
    const w = makeWorld();
    const g = w.activate([UNIT * 10n, UNIT * 20n, UNIT * 30n]);
    const broke = w.hand(g, { winner: 0, loser: 1, amount: 20n, rake: 0n });
    const bad = w.final(broke, [true, true, true]); // seat 1 has 0 and keeps
    expect(settleAs(w, w.bundle(bad))).toEqual(revert('BadKeep', 1n));
    expect(w.chain.table(w.tableKey).status).toBe('Active');
  });

  test('a Filling or Closed table cannot be settled: WrongStatus with its number', () => {
    const w = makeWorld();
    w.createTable();
    const fakeState = { ...w.baseline(), nonce: 5n, isFinal: true };
    expect(settleAs(w, w.bundle(fakeState))).toEqual(revert('WrongStatus', 1));
    expect(settleAs(w, w.bundle({ ...fakeState, tableId: `0x${'99'.repeat(32)}` }))).toEqual(
      revert('WrongStatus', 0),
    );
    const a = active();
    const s1 = a.w.hand(a.g);
    expectOk(a.chain.send(a.w.players[0], 'startExit', { bundle: a.w.bundle(s1) }));
    a.chain.advanceTime(3601);
    expectOk(a.chain.send(relayerOf(a.w), 'finalizeExit', { state: s1 }));
    expect(settleAs(a.w, a.w.bundle(a.w.final(s1)))).toEqual(revert('WrongStatus', 4));
  });

  test('the checks that need the Panic: an overflowing volume is Panic(0x11), not RakeTooHigh', () => {
    const { w, g } = active();
    const fin = { ...w.final(w.hand(g)), volume: MAX_UINT256 };
    expect(settleAs(w, w.bundle(fin))).toEqual(revert('Panic', 0x11n));
  });

  test("the rake cap is the vault's MAX_RAKE_BPS, exactly: rake * 10000 <= bps * volume", () => {
    for (const bps of [500, 300]) {
      const { w, g } = active({ chainOptions: { maxRakeBps: bps } });
      const withRake = (rake) =>
        buildNextState({
          prev: g,
          balances: [g.balances[0], g.balances[1] - rake, g.balances[2]],
          rakeDelta: rake,
          volumeDelta: 10_000n,
        });
      const limit = BigInt(bps); // bps / 10000 of a volume of 10000
      expect(
        w.chain.send(arbiterOf(w), 'startExit', { bundle: w.bundle(withRake(limit + 1n)) }),
      ).toEqual(revert('RakeTooHigh'));
      expect(
        w.chain.send(arbiterOf(w), 'startExit', { bundle: w.bundle(withRake(limit)) }),
      ).toEqual(ok);
    }
  });

  test('settle is valid while Exiting, before and after the deadline, until someone finalises', () => {
    for (const lateBy of [0, 1, 50_000]) {
      const { w, g, chain } = active();
      const s1 = w.hand(g);
      const fin = w.final(w.hand(s1));
      expectOk(chain.send(w.players[2], 'startExit', { bundle: w.bundle(s1) }));
      chain.advanceTime(3600 + lateBy);
      expect(settleAs(w, w.bundle(fin))).toEqual(ok);
      chain.tick();
      expect(chain.table(w.tableKey)).toMatchObject({
        status: 'Filling',
        nonce: fin.nonce,
        exitDigest: ZERO_HASH,
        exitDeadline: 0,
      });
    }
  });

  test('anyone may submit it: the sender is not checked', () => {
    const { w, g } = active();
    const fin = w.final(w.hand(g));
    expect(settleAs(w, w.bundle(fin), stranger)).toEqual(ok);
  });

  test('the next epoch: stayers carry over, rake and volume stay cumulative, and the house is paid only the new rake', () => {
    const w = makeWorld({ chainOptions: { maxRakeBps: 200 } });
    const g1 = w.activate();
    const first = w.hand(g1, { winner: 0, loser: 1, amount: 100n, rake: 3n, pot: 200n });
    const f1 = w.final(first, [true, true, true]);
    expectOk(w.chain.send(relayerOf(w), 'settle', { bundle: w.bundle(f1) }));
    w.chain.tick();
    expect(w.chain.table(w.tableKey)).toMatchObject({
      status: 'Filling',
      seated: 3,
      rakePaid: f1.rake,
    });
    expect(w.chain.balances.house).toBe(3n * UNIT);

    // the old roster stays seated, so the arbiter can start the next epoch straight away
    expect(w.start().jobs[0].outcome).toBe('sent');
    const g2 = w.baseline(f1.balances, { nonce: f1.nonce, rake: f1.rake, volume: f1.volume });
    const second = w.hand(g2, { winner: 2, loser: 0, amount: 100n, rake: 3n, pot: 200n });
    expect(second.rake).toBe(6n * UNIT);
    expect(second.volume).toBe(400n * UNIT);
    const f2 = w.final(second, [true, false, true]);
    const sink = [];
    w.chain.subscribe((e) => sink.push(e));
    expectOk(w.chain.send(relayerOf(w), 'settle', { bundle: w.bundle(f2) }));
    w.chain.tick();

    // cumulative rake in the state, only the difference to the house
    expect(sink[0]).toMatchObject({
      type: 'Settled',
      nonce: f2.nonce,
      rakePaid: 6n * UNIT,
      rakeDelta: 3n * UNIT,
      stayers: 2,
    });
    expect(sink.at(-1)).toMatchObject({
      type: 'Payout',
      to: w.chain.houseAddress,
      amount: 3n * UNIT,
    });
    expect(w.chain.balances.house).toBe(6n * UNIT);
    expect(w.chain.table(w.tableKey)).toMatchObject({
      status: 'Filling',
      nonce: f2.nonce,
      rakePaid: 6n * UNIT,
      seated: 2,
    });
    expect(w.chain.invariants().ok).toBe(true);
  });

  test('RakeTooHigh when the volume of the previous epoch is forgotten, RakeDecreased when the rake goes down', () => {
    const w = makeWorld({ chainOptions: { maxRakeBps: 200 } });
    const g1 = w.activate();
    const first = w.hand(g1, { winner: 0, loser: 1, amount: 100n, rake: 3n, pot: 200n });
    const f1 = w.final(first, [true, true, true]);
    expectOk(w.chain.send(relayerOf(w), 'settle', { bundle: w.bundle(f1) }));
    expectOk(w.chain.send(arbiterOf(w), 'start', { tableKey: w.tableKey, players: w.players }));

    const forgetful = w.hand(w.baseline(f1.balances, { nonce: f1.nonce, rake: f1.rake }), {
      winner: 2,
      loser: 0,
      amount: 100n,
      rake: 3n,
      pot: 200n,
    });
    expect(w.chain.send(arbiterOf(w), 'startExit', { bundle: w.bundle(forgetful) })).toEqual(
      revert('RakeTooHigh'),
    );
    const g2 = w.baseline(f1.balances, { nonce: f1.nonce, rake: f1.rake, volume: f1.volume });
    const down = { ...w.hand(g2), rake: f1.rake - 1n };
    expect(w.chain.send(arbiterOf(w), 'startExit', { bundle: w.bundle(down) })).toEqual(
      revert('RakeDecreased'),
    );
  });
});

describe('startExit', () => {
  const exitAs = (w, bundle, sender) => w.chain.send(sender, 'startExit', { bundle });

  test("a member starts an exit from a signed state: Exiting, the state's nonce and digest, a window from now", () => {
    const { w, g, chain } = active();
    const s1 = w.hand(g);
    chain.advanceTime(500);
    const sink = [];
    chain.subscribe((e) => sink.push(e));
    expect(exitAs(w, w.bundle(s1), w.players[2])).toEqual(ok);
    chain.tick();
    const deadline = chain.liveTime + 3600;
    expect(chain.table(w.tableKey)).toMatchObject({
      status: 'Exiting',
      nonce: 1n,
      exitDigest: w.digest(s1),
      exitDeadline: deadline,
      rosterHash: rosterHash(w.players), // unchanged
    });
    expect(sink).toEqual([
      expect.objectContaining({
        type: 'ExitStarted',
        by: w.players[2],
        nonce: 1n,
        digest: w.digest(s1),
        deadline,
      }),
    ]);
    expect(chain.chainTime()).toBe(chain.liveTime);
  });

  test('the arbiter may too; a stranger and the relayer may not (NotMember), checked before the state', () => {
    const { w, g } = active();
    const s1 = w.hand(g);
    const garbage = w.bundle({ ...s1, nonce: 0n }); // would be StaleNonce
    expect(exitAs(w, garbage, stranger)).toEqual(revert('NotMember'));
    expect(exitAs(w, garbage, relayerOf(w))).toEqual(revert('NotMember'));
    expect(exitAs(w, garbage, arbiterOf(w))).toEqual(revert('StaleNonce', 0n, 0n));
    expect(exitAs(w, w.bundle(s1), arbiterOf(w))).toEqual(ok);
  });

  test('WrongStatus comes first: not Active', () => {
    const w = makeWorld();
    w.createTable();
    const state = { ...w.baseline(), nonce: 1n };
    expect(exitAs(w, w.bundle(state), stranger)).toEqual(revert('WrongStatus', 1));
    expect(exitAs(w, w.bundle({ ...state, tableId: `0x${'99'.repeat(32)}` }), stranger)).toEqual(
      revert('WrongStatus', 0),
    );
    const { w: a, g } = active();
    expectOk(exitAs(a, a.bundle(a.hand(g)), arbiterOf(a)));
    expect(exitAs(a, a.bundle(a.hand(a.hand(g))), arbiterOf(a))).toEqual(revert('WrongStatus', 3));
  });

  test('a final state can be put up too (the contract does not forbid it): the exit then pays balances', () => {
    const { w, g } = active();
    const fin = w.final(w.hand(g));
    expect(exitAs(w, w.bundle(fin), w.players[0])).toEqual(ok);
    expect(w.chain.live(w.tableKey)).toMatchObject({ status: 'Exiting', nonce: 2n });
  });

  test('the state is judged like the contract judges it', () => {
    const { w, g } = active();
    const s1 = w.hand(g);
    const U256 = MAX_UINT256;
    expect(exitAs(w, w.partial(s1, { skip: 2 }), arbiterOf(w))).toEqual(revert('BadSignature', 2n));
    expect(exitAs(w, w.partial(s1, { noArbiter: true }), arbiterOf(w))).toEqual(
      revert('BadSignature', U256),
    );
    const bad = { ...s1, balances: [s1.balances[0] + 1n, s1.balances[1], s1.balances[2]] };
    expect(exitAs(w, w.bundle(bad), arbiterOf(w)).error).toBe('NotConserved');
    expect(exitAs(w, w.bundle({ ...s1, rake: s1.rake + UNIT * 100n }), arbiterOf(w)).error).toBe(
      'RakeTooHigh',
    );
    expect(w.chain.live(w.tableKey).status).toBe('Active');
  });

  test("the table keeps the arbiter it was created with, whatever the vault's arbiter is now", () => {
    const { w, g, chain } = active();
    chain.setVaultArbiter(addressFor('new-arbiter'));
    expect(exitAs(w, w.bundle(w.hand(g)), arbiterOf(w))).toEqual(ok);
  });

  test('the pause does not stop an exit', () => {
    const { w, g, chain } = active();
    chain.pause(true);
    expect(exitAs(w, w.bundle(w.hand(g)), w.players[0])).toEqual(ok);
  });

  // The premise of stallAction and of the reconciler's rollover rows: in the first round of epoch 2 the
  // chain's nonce IS the previous final's nonce, so that final can neither start an exit nor be settled again.
  test('after a rollover the previous final is not newer than the table: StaleNonce for startExit and for settle', () => {
    const w = makeWorld();
    const fin = w.final(w.hand(w.activate()), [true, true, true]);
    expectOk(w.chain.send(relayerOf(w), 'settle', { bundle: w.bundle(fin) }));
    expectOk(w.chain.send(arbiterOf(w), 'start', { tableKey: w.tableKey, players: w.players }));
    expect(w.chain.live(w.tableKey)).toMatchObject({ status: 'Active', nonce: fin.nonce });
    const stale = revert('StaleNonce', fin.nonce, fin.nonce);
    expect(exitAs(w, w.bundle(fin), arbiterOf(w))).toEqual(stale);
    expect(exitAs(w, w.bundle(fin), w.players[0])).toEqual(stale);
    expect(w.chain.send(relayerOf(w), 'settle', { bundle: w.bundle(fin) })).toEqual(stale);
    expect(w.chain.live(w.tableKey)).toMatchObject({ status: 'Active', nonce: fin.nonce });
  });
});

describe('startExitFromDeposits', () => {
  const exitFrom = (w, sender, players = w.players) =>
    w.chain.send(sender, 'startExitFromDeposits', { tableKey: w.tableKey, players });

  test("puts up the deposit state: its digest, the table's nonce kept, a window from now", () => {
    const { w, chain } = active();
    chain.advanceTime(77);
    const sink = [];
    chain.subscribe((e) => sink.push(e));
    expect(exitFrom(w, arbiterOf(w))).toEqual(ok);
    chain.tick();
    const digest = w.digest(w.depositState());
    expect(chain.table(w.tableKey)).toMatchObject({
      status: 'Exiting',
      nonce: 0n,
      exitDigest: digest,
      exitDeadline: chain.liveTime + 3600,
    });
    expect(sink[0]).toMatchObject({
      type: 'ExitStarted',
      by: arbiterOf(w),
      nonce: 0n,
      digest,
      deadline: chain.liveTime + 3600,
    });
  });

  test("the deposit state carries the table's nonce and rakePaid after a rollover, and volume 0", () => {
    const w = makeWorld();
    const g = w.activate();
    const hand = w.hand(g, { rake: 2n });
    const fin = w.final(hand, [true, true, true]);
    expectOk(w.chain.send(relayerOf(w), 'settle', { bundle: w.bundle(fin) }));
    expectOk(w.chain.send(arbiterOf(w), 'start', { tableKey: w.tableKey, players: w.players }));
    w.chain.tick();
    expect(exitFrom(w, w.players[1])).toEqual(ok);
    const expected = w.depositState(fin.balances, { nonce: fin.nonce, rake: fin.rake });
    expect(expected.volume).toBe(0n);
    expect(w.chain.live(w.tableKey)).toMatchObject({
      nonce: fin.nonce,
      exitDigest: hashState(expected, w.domain),
    });
    expect(w.chain.pending.at(-1)).toMatchObject({
      type: 'ExitStarted',
      by: w.players[1],
      nonce: fin.nonce,
      digest: hashState(expected, w.domain),
    });
  });

  test('WrongStatus, then NotMember, then RosterMismatch', () => {
    const w = makeWorld();
    w.createTable();
    w.depositAll();
    expect(exitFrom(w, stranger)).toEqual(revert('WrongStatus', 1));
    expectOk(w.chain.send(arbiterOf(w), 'start', { tableKey: w.tableKey, players: w.players }));
    expect(exitFrom(w, stranger)).toEqual(revert('NotMember'));
    expect(exitFrom(w, relayerOf(w))).toEqual(revert('NotMember'));
    for (const players of [
      w.players.slice(1),
      [...w.players].reverse(),
      [...w.players, stranger],
      [],
    ]) {
      expect(exitFrom(w, arbiterOf(w), players)).toEqual(revert('RosterMismatch'));
    }
    expect(exitFrom(w, w.players[0])).toEqual(ok);
    expect(exitFrom(w, w.players[0])).toEqual(revert('WrongStatus', 3));
  });
});

describe('challenge', () => {
  const challengeAs = (w, bundle, sender = relayerOf(w)) =>
    w.chain.send(sender, 'challenge', { bundle });

  test('a higher nonce replaces the exit and restarts the window', () => {
    const { w, g, chain } = active();
    const [s1, s2, s3] = [1, 2, 3].reduce((acc) => [...acc, w.hand(acc.at(-1) ?? g)], []);
    expectOk(chain.send(w.players[0], 'startExit', { bundle: w.bundle(s1) }));
    chain.advanceTime(1000);
    chain.tick();
    const sink = [];
    chain.subscribe((e) => sink.push(e));
    expect(challengeAs(w, w.bundle(s2))).toEqual(ok);
    chain.tick();
    expect(chain.table(w.tableKey)).toMatchObject({
      status: 'Exiting',
      nonce: 2n,
      exitDigest: w.digest(s2),
      exitDeadline: chain.liveTime + 3600,
    });
    expect(sink[0]).toMatchObject({
      type: 'Challenged',
      by: relayerOf(w),
      nonce: 2n,
      digest: w.digest(s2),
      deadline: chain.liveTime + 3600,
    });
    // and again
    chain.advanceTime(10);
    expect(challengeAs(w, w.bundle(s3), stranger)).toEqual(ok);
    expect(chain.live(w.tableKey).nonce).toBe(3n);
  });

  test('strictly higher: an equal or lower nonce is StaleNonce with both numbers', () => {
    const { w, g } = active();
    const [s1, s2] = [w.hand(g)].flatMap((s) => [s, w.hand(s)]);
    expectOk(w.chain.send(w.players[0], 'startExit', { bundle: w.bundle(s2) }));
    expect(challengeAs(w, w.bundle(s2))).toEqual(revert('StaleNonce', 2n, 2n));
    expect(challengeAs(w, w.bundle(s1))).toEqual(revert('StaleNonce', 1n, 2n));
  });

  test('the window: allowed up to and including the deadline, ExitWindowClosed one second later', () => {
    const { w, g, chain } = active();
    const s1 = w.hand(g);
    const s2 = w.hand(s1);
    expectOk(chain.send(w.players[0], 'startExit', { bundle: w.bundle(s1) }));
    const deadline = chain.live(w.tableKey).exitDeadline;
    chain.advanceTime(deadline - chain.liveTime - 1);
    expect(chain.liveTime).toBe(deadline - 1);
    expect(challengeAs(w, w.bundle(s2))).toEqual(ok); // the window restarts; do it again at the edge
    const second = chain.live(w.tableKey).exitDeadline;
    const s3 = w.hand(s2);
    chain.advanceTime(second - chain.liveTime);
    expect(chain.liveTime).toBe(second);
    expect(challengeAs(w, w.bundle(s3))).toEqual(ok); // exactly at the deadline: still open
    const third = chain.live(w.tableKey).exitDeadline;
    chain.advanceTime(third - chain.liveTime + 1);
    expect(challengeAs(w, w.bundle(w.hand(s3)))).toEqual(revert('ExitWindowClosed'));
  });

  test('checks run in order: WrongStatus, ExitWindowClosed, then the state', () => {
    const { w, g, chain } = active();
    const s1 = w.hand(g);
    expect(challengeAs(w, w.bundle(s1))).toEqual(revert('WrongStatus', 2));
    expectOk(chain.send(w.players[0], 'startExit', { bundle: w.bundle(s1) }));
    chain.advanceTime(3601);
    const junk = w.partial(w.hand(s1), { noArbiter: true });
    expect(challengeAs(w, junk)).toEqual(revert('ExitWindowClosed'));
  });

  test('a challenge can follow an exit from deposits', () => {
    const { w, g, chain } = active();
    expectOk(
      chain.send(arbiterOf(w), 'startExitFromDeposits', {
        tableKey: w.tableKey,
        players: w.players,
      }),
    );
    expect(challengeAs(w, w.bundle(w.hand(g)))).toEqual(ok);
    expect(chain.live(w.tableKey).nonce).toBe(1n);
  });

  test('a challenge is a real state: it is judged like any other', () => {
    const { w, g, chain } = active();
    const s1 = w.hand(g);
    expectOk(chain.send(w.players[0], 'startExit', { bundle: w.bundle(s1) }));
    const s2 = w.hand(s1);
    expect(challengeAs(w, w.partial(s2, { skip: 1 }))).toEqual(revert('BadSignature', 1n));
    expect(
      challengeAs(w, w.bundle({ ...s2, balances: [...s2.balances.slice(0, 2), 0n] })).error,
    ).toBe('NotConserved');
  });

  test('the pause does not stop a challenge', () => {
    const { w, g, chain } = active();
    const s1 = w.hand(g);
    expectOk(chain.send(w.players[0], 'startExit', { bundle: w.bundle(s1) }));
    chain.pause(true);
    expect(challengeAs(w, w.bundle(w.hand(s1)))).toEqual(ok);
  });
});

describe('finalizeExit', () => {
  const finalizeAs = (w, state, sender = relayerOf(w)) =>
    w.chain.send(sender, 'finalizeExit', { state });
  const exiting = () => {
    const a = active();
    const s1 = a.w.hand(a.g, { winner: 0, loser: 1, amount: 100n, rake: 2n });
    const s2 = a.w.hand(s1, { winner: 1, loser: 2, amount: 40n, rake: 1n });
    expectOk(a.chain.send(a.w.players[0], 'startExit', { bundle: a.w.bundle(s1) }));
    expectOk(a.chain.send(relayerOf(a.w), 'challenge', { bundle: a.w.bundle(s2) }));
    a.chain.tick();
    return { ...a, s1, s2 };
  };

  test('after the window, pays the state the exit holds and closes the table', () => {
    const { w, chain, s2 } = exiting();
    chain.advanceTime(3601);
    const sink = [];
    chain.subscribe((e) => sink.push(e));
    expect(finalizeAs(w, s2)).toEqual(ok);
    chain.tick();
    expect(chain.table(w.tableKey)).toEqual({
      status: 'Closed',
      nonce: 2n, // the contract leaves it
      escrow: 0n,
      rakePaid: s2.rake,
      rosterHash: ZERO_HASH,
      exitDeadline: 0,
      exitDigest: ZERO_HASH,
      arbiter: arbiterOf(w),
      seated: 0,
      maxPlayers: 6,
      minDeposit: UNIT,
      maxDeposit: 10_000_000n * UNIT,
    });
    w.seats.forEach((seat, i) => {
      expect(chain.balances.of(seat.wallet)).toBe(s2.balances[i]);
      expect(chain.seat(w.tableKey, seat.wallet)).toBeNull();
    });
    expect(chain.balances.house).toBe(s2.rake);
    expect(chain.balances.vault).toBe(0n);
    expect(chain.totalLocked).toBe(0n);
    expect(chain.invariants().ok).toBe(true);
    expect(sink.map((e) => e.type)).toEqual([
      'ExitFinalized',
      'Payout',
      'Payout',
      'Payout',
      'Payout',
    ]);
    expect(sink[0]).toMatchObject({ nonce: 2n, rakePaid: s2.rake, rakeDelta: s2.rake });
    expect(sink.slice(1, 4).map((e) => e.to)).toEqual(w.players);
    expect(sink[4]).toMatchObject({ to: chain.houseAddress, amount: s2.rake });
  });

  test('the window is a strict >: ExitWindowOpen at the deadline itself, fine one second after', () => {
    const { w, chain, s2 } = exiting();
    const deadline = chain.live(w.tableKey).exitDeadline;
    chain.advanceTime(deadline - chain.liveTime - 1);
    expect(finalizeAs(w, s2)).toEqual(revert('ExitWindowOpen'));
    chain.advanceTime(1);
    expect(chain.liveTime).toBe(deadline);
    expect(finalizeAs(w, s2)).toEqual(revert('ExitWindowOpen'));
    chain.advanceTime(1);
    expect(finalizeAs(w, s2)).toEqual(ok);
  });

  test('only the state the exit holds: DigestMismatch for the stale one, a changed one, a final flag', () => {
    const { w, chain, s1, s2 } = exiting();
    chain.advanceTime(3601);
    expect(finalizeAs(w, s1)).toEqual(revert('DigestMismatch')); // replaced by the challenge
    expect(
      finalizeAs(w, { ...s2, balances: [s2.balances[0] + 1n, ...s2.balances.slice(1)] }),
    ).toEqual(revert('DigestMismatch'));
    expect(finalizeAs(w, { ...s2, isFinal: true })).toEqual(revert('DigestMismatch'));
    expect(finalizeAs(w, { ...s2, volume: s2.volume + 1n })).toEqual(revert('DigestMismatch'));
    expect(chain.live(w.tableKey).status).toBe('Exiting');
  });

  test('checks run in order: WrongStatus, ExitWindowOpen, DigestMismatch', () => {
    const { w, g, chain } = active();
    const s1 = w.hand(g);
    expect(finalizeAs(w, s1)).toEqual(revert('WrongStatus', 2));
    expectOk(chain.send(w.players[0], 'startExit', { bundle: w.bundle(s1) }));
    expect(finalizeAs(w, w.hand(s1))).toEqual(revert('ExitWindowOpen'));
    chain.advanceTime(3601);
    expect(finalizeAs(w, w.hand(s1))).toEqual(revert('DigestMismatch'));
  });

  test('an exit from deposits pays every deposit back', () => {
    const { w, chain } = active();
    expectOk(
      chain.send(arbiterOf(w), 'startExitFromDeposits', {
        tableKey: w.tableKey,
        players: w.players,
      }),
    );
    chain.advanceTime(3601);
    const state = w.depositState();
    expect(finalizeAs(w, state)).toEqual(ok);
    chain.tick();
    w.seats.forEach((seat, i) => {
      expect(chain.balances.of(seat.wallet)).toBe(w.amounts[i]);
    });
    expect(chain.balances.house).toBe(0n);
    expect(chain.table(w.tableKey).status).toBe('Closed');
    expect(chain.delivered.filter((e) => e.type === 'ExitFinalized')[0].rakeDelta).toBe(0n);
  });

  test('anyone may finalise; a closed table is closed for good', () => {
    const { w, chain, s2 } = exiting();
    chain.advanceTime(3601);
    expect(finalizeAs(w, s2, stranger)).toEqual(ok);
    expect(finalizeAs(w, s2)).toEqual(revert('WrongStatus', 4));
    chain.mint(w.players[0], 1000n);
    expect(chain.deposit(w.tableKey, w.players[0], UNIT, w.seats[0].session)).toEqual(
      revert('WrongStatus', 4),
    );
    expect(
      chain.send(arbiterOf(w), 'createTable', {
        tableKey: w.tableKey,
        maxPlayers: 6,
        minDeposit: 1n,
        maxDeposit: 10n,
      }),
    ).toEqual(revert('TableExists'));
  });

  test('a state whose arrays are the wrong length just hashes to something else: DigestMismatch, never a crash', () => {
    const { w, chain, s2 } = exiting();
    chain.advanceTime(3601);
    for (const broken of [
      { ...s2, balances: s2.balances.slice(1) },
      { ...s2, keep: s2.keep.slice(1) },
      { ...s2, players: s2.players.slice(1) },
      { ...s2, balances: [...s2.balances, 0n] },
    ]) {
      expect(finalizeAs(w, broken)).toEqual(revert('DigestMismatch'));
    }
    expect(chain.live(w.tableKey).status).toBe('Exiting');
    expect(finalizeAs(w, s2)).toEqual(ok);
  });

  test('a state that cannot be decoded is Malformed', () => {
    const { w, chain } = exiting();
    chain.advanceTime(3601);
    expect(chain.send(relayerOf(w), 'finalizeExit', { state: { tableId: 'nope' } }).error).toBe(
      'Malformed',
    );
    expect(chain.send(relayerOf(w), 'finalizeExit', { state: undefined }).error).toBe('Malformed');
    expect(chain.send(relayerOf(w), 'finalizeExit', {}).error).toBe('Malformed');
  });

  test('the pause does not stop a finalise', () => {
    const { w, chain, s2 } = exiting();
    chain.advanceTime(3601);
    chain.pause(true);
    expect(finalizeAs(w, s2)).toEqual(ok);
  });
});

describe('payouts the token refuses', () => {
  test('a blocked recipient is credited as withdrawable, the others are still paid, and the books balance', () => {
    const { w, g, chain } = active();
    const fin = w.final(w.hand(g, { winner: 0, loser: 1, amount: 100n, rake: 2n }), [
      false,
      false,
      false,
    ]);
    chain.blacklist(w.players[1]);
    const sink = [];
    chain.subscribe((e) => sink.push(e));
    expectOk(chain.send(relayerOf(w), 'settle', { bundle: w.bundle(fin) }));
    chain.tick();
    const payouts = sink.filter((e) => e.type === 'Payout');
    expect(payouts.map((p) => [p.to, p.pushed])).toEqual([
      [w.players[0], true],
      [w.players[1], false],
      [w.players[2], true],
      [chain.houseAddress, true],
    ]);
    expect(chain.balances.of(w.players[1])).toBe(0n);
    expect(chain.withdrawableOf(w.players[1])).toBe(fin.balances[1]);
    expect(chain.totalLocked).toBe(fin.balances[1]);
    expect(chain.balances.vault).toBe(fin.balances[1]);
    expect(chain.invariants().ok).toBe(true);
  });

  test('withdraw: a blocked recipient reverts and changes nothing; once unblocked it pays out once', () => {
    const { w, g, chain } = active();
    const fin = w.final(w.hand(g), [false, false, false]);
    chain.blacklist(w.players[1]);
    expectOk(chain.send(relayerOf(w), 'settle', { bundle: w.bundle(fin) }));
    const owed = chain.withdrawableOf(w.players[1]);
    expect(owed).toBeGreaterThan(0n);

    expect(chain.withdraw(w.players[1], w.players[1])).toEqual(revert('Error', 'blacklisted'));
    expect(chain.withdrawableOf(w.players[1])).toBe(owed);
    expect(chain.totalLocked).toBe(owed);
    expect(chain.withdraw(w.players[0], w.players[0])).toEqual(revert('NothingToWithdraw'));

    chain.blacklist(w.players[1], false);
    expect(chain.withdraw(w.players[1], stranger)).toEqual(ok); // to any address the token accepts
    expect(chain.balances.of(stranger)).toBe(owed);
    expect(chain.withdrawableOf(w.players[1])).toBe(0n);
    expect(chain.totalLocked).toBe(0n);
    expect(chain.withdraw(w.players[1], stranger)).toEqual(revert('NothingToWithdraw'));
    expect(chain.invariants().ok).toBe(true);
  });

  test('a blocked depositor cannot deposit (the token refuses before the balance is looked at)', () => {
    const w = makeWorld();
    w.createTable();
    w.chain.blacklist(w.players[0]);
    expect(w.chain.deposit(w.tableKey, w.players[0], UNIT, w.seats[0].session)).toEqual(
      revert('Error', 'blacklisted'),
    ); // not even funded: the blacklist is checked first
  });

  test('a blocked leaver in Filling keeps a claim instead of failing the leave', () => {
    const w = makeWorld();
    w.createTable();
    w.depositAll();
    w.chain.blacklist(w.players[0]);
    expect(w.chain.leave(w.tableKey, w.players[0])).toEqual(ok);
    w.chain.tick();
    expect(w.chain.delivered.at(-1)).toMatchObject({ type: 'Payout', pushed: false });
    expect(w.chain.withdrawableOf(w.players[0])).toBe(w.amounts[0]);
  });
});

describe('the sender model', () => {
  test('create, start and the exits the server starts come from the arbiter account; settle, challenge, finalize from the relayer', () => {
    const w = makeWorld();
    w.createTable();
    w.depositAll();
    w.start();
    const g = w.baseline();
    const s1 = w.hand(g);
    const s2 = w.hand(s1);
    w.run('startExit', { bundle: w.bundle(s1) });
    w.run('challenge', { bundle: w.bundle(s2) });
    w.chain.advanceTime(3601);
    w.run('finalizeExit', { state: s2 });
    expect(w.chain.sent.map((s) => [s.kind, s.sender, s.ok])).toEqual([
      ['createTable', arbiterOf(w), true],
      ['start', arbiterOf(w), true],
      ['startExit', arbiterOf(w), true],
      ['challenge', relayerOf(w), true],
      ['finalizeExit', relayerOf(w), true],
    ]);

    const v = active();
    v.w.run('settle', { bundle: v.w.bundle(v.w.final(v.w.hand(v.g))) });
    expect(v.chain.sent.at(-1)).toMatchObject({ kind: 'settle', sender: relayerOf(v.w), ok: true });

    const d = active();
    d.w.run('startExitFromDeposits', { players: d.w.players });
    expect(d.chain.sent.at(-1)).toMatchObject({
      kind: 'startExitFromDeposits',
      sender: arbiterOf(d.w),
      ok: true,
    });
  });

  test("the arbiter's startExit and the relayer's challenge are accepted by the contract rules, not by the sender model alone", () => {
    // the relayer holds no seat and is not the table's arbiter: it could not start an exit
    const { w, g } = active();
    expect(w.chain.send(relayerOf(w), 'startExit', { bundle: w.bundle(w.hand(g)) })).toEqual(
      revert('NotMember'),
    );
  });
});

describe('jobs: the queue', () => {
  const declineAll = (w) => {
    for (const kind of [
      'createTable',
      'start',
      'settle',
      'startExit',
      'startExitFromDeposits',
      'challenge',
      'finalizeExit',
    ]) {
      w.resolver.decline(kind, 'not now');
    }
  };

  test('submit is idempotent by key while a job is queued, and says so', () => {
    const w = makeWorld();
    const job = makeJob('start', w.tableKey);
    expect(w.chain.submit(job)).toBe(true);
    expect(w.chain.submit({ ...job })).toBe(false);
    expect(w.chain.queued).toEqual([job.key]);
    declineAll(w);
    expect(w.chain.tick().jobs).toHaveLength(1);
  });

  test('a finished key can be submitted again (the reconciler is level-triggered)', () => {
    const w = makeWorld();
    declineAll(w);
    const job = makeJob('settle', w.tableKey);
    expect(w.chain.submit(job)).toBe(true);
    w.chain.tick();
    expect(w.chain.submit(job)).toBe(true);
    expect(w.chain.tick().jobs).toHaveLength(1);
    expect(w.chain.queued).toEqual([]);
  });

  test('different kinds on one table are different jobs, and the same kind on two tables too', () => {
    const w = makeWorld();
    declineAll(w);
    const other = `0x${'12'.repeat(32)}`;
    expect(w.chain.submit(makeJob('startExit', w.tableKey))).toBe(true);
    expect(w.chain.submit(makeJob('settle', w.tableKey))).toBe(true);
    expect(w.chain.submit(makeJob('settle', other))).toBe(true);
    expect(w.chain.queued).toHaveLength(3);
  });

  test('submit refuses anything that is not exactly { key, kind, tableKey, priority }', () => {
    const w = makeWorld();
    const job = makeJob('settle', w.tableKey);
    expect(() => w.chain.submit({ ...job, bundle: w.bundle(w.baseline()) })).toThrow(/bundle/);
    expect(() => w.chain.submit({ ...job, state: {} })).toThrow(/state/);
    expect(() => w.chain.submit({ ...job, priority: 1 })).toThrow(/priority/);
    expect(() => w.chain.submit({ ...job, key: 'x' })).toThrow(/key/);
    expect(() => w.chain.submit(null)).toThrow(TypeError);
    expect(w.chain.queued).toEqual([]);
  });

  test('a queued job is a copy: changing the object after submit changes nothing', () => {
    const w = makeWorld();
    declineAll(w);
    const job = makeJob('settle', w.tableKey);
    w.chain.submit(job);
    job.kind = 'challenge';
    expect(w.chain.tick().jobs[0].kind).toBe('settle');
  });

  test('runs by priority, highest first, and in submit order among equals', () => {
    const w = makeWorld();
    declineAll(w);
    const t = [1, 2, 3].map((i) => `0x${String(i).repeat(64)}`);
    const order = [
      makeJob('createTable', t[0]),
      makeJob('start', t[0]),
      makeJob('startExitFromDeposits', t[0]),
      makeJob('finalizeExit', t[0]),
      makeJob('startExit', t[0]),
      makeJob('settle', t[0]),
      makeJob('challenge', t[0]),
      makeJob('settle', t[2]),
      makeJob('settle', t[1]),
    ];
    for (const job of order) w.chain.submit(job);
    expect(w.chain.tick().jobs.map((j) => [j.kind, j.key.split(':')[1].slice(0, 4)])).toEqual([
      ['challenge', '0x11'],
      ['settle', '0x11'],
      ['settle', '0x33'],
      ['settle', '0x22'],
      ['finalizeExit', '0x11'],
      ['startExitFromDeposits', '0x11'],
      ['startExit', '0x11'],
      ['start', '0x11'],
      ['createTable', '0x11'],
    ]);
  });

  test('a higher-priority job decides the state a lower one sees: settle before start in the same poll', () => {
    const { w, g, chain } = active();
    const fin = w.final(w.hand(g), [true, true, true]);
    w.resolver.set('settle', { bundle: w.bundle(fin) });
    w.resolver.set('start', { players: w.players });
    chain.submit(makeJob('start', w.tableKey)); // submitted first, runs second
    chain.submit(makeJob('settle', w.tableKey));
    const { jobs } = chain.tick();
    expect(jobs.map((j) => [j.kind, j.outcome])).toEqual([
      ['settle', 'sent'],
      ['start', 'sent'],
    ]);
    expect(chain.table(w.tableKey).status).toBe('Active');
    expect(chain.table(w.tableKey).nonce).toBe(fin.nonce);
  });

  test('F3, F4: the resolver is asked when the job RUNS, with the job, and the newest bundle is the one sent', () => {
    const { w, g, chain } = active();
    const s1 = w.hand(g);
    const s2 = w.hand(s1);
    expectOk(chain.send(w.players[0], 'startExit', { bundle: w.bundle(s1) }));
    let current = w.bundle(s1);
    w.resolver.set('challenge', () => ({ bundle: current }));
    const job = makeJob('challenge', w.tableKey);
    const asked = w.resolver.calls.length;
    chain.submit(job);
    expect(w.resolver.calls).toHaveLength(asked); // not at submit
    current = w.bundle(s2); // the store moved on while the job waited
    chain.tick();
    expect(w.resolver.calls.slice(asked)).toEqual([job]);
    expect(chain.live(w.tableKey)).toMatchObject({ nonce: 2n, exitDigest: w.digest(s2) });
  });

  test('the resolver gets a copy of the job', () => {
    const w = makeWorld();
    const seen = [];
    w.chain.resolver = {
      prepare: (job) => {
        seen.push(job);
        job.kind = 'tampered';
        return { proceed: false, reason: 'x' };
      },
    };
    w.chain.submit(makeJob('start', w.tableKey));
    w.chain.tick();
    expect(w.chain.skipped[0].kind).toBe('start');
  });

  test('proceed:false is not an error: nothing sent, no event, the key is free, the reason is kept', () => {
    const { w, chain } = active();
    w.resolver.decline('settle', 'round still open');
    const before = chain.block;
    chain.submit(makeJob('settle', w.tableKey));
    const result = chain.tick();
    expect(result.jobs).toEqual([
      expect.objectContaining({ kind: 'settle', outcome: 'skipped', reason: 'round still open' }),
    ]);
    expect(chain.block).toBe(before);
    expect(chain.delivered.filter((e) => e.type === 'JobFailed')).toEqual([]);
    expect(chain.skipped).toEqual([
      { key: makeJob('settle', w.tableKey).key, kind: 'settle', reason: 'round still open' },
    ]);
    expect(chain.submit(makeJob('settle', w.tableKey))).toBe(true);
  });

  test('a resolver that throws gives a retryable JobFailed; one that answers nonsense a final one', () => {
    const w = makeWorld();
    const job = makeJob('start', w.tableKey);
    w.chain.resolver = {
      prepare: () => {
        throw new Error('store is locked');
      },
    };
    w.chain.submit(job);
    expect(w.chain.tick().jobs[0]).toMatchObject({ outcome: 'failed', error: 'PrepareFailed' });
    expect(failures(w.chain).at(-1)).toMatchObject({
      key: job.key,
      kind: 'start',
      error: 'PrepareFailed',
      retryable: true,
      args: ['store is locked'],
    });
    for (const nonsense of [undefined, null, {}, { proceed: 'yes' }, 5]) {
      w.chain.resolver = { prepare: () => nonsense };
      w.chain.submit(job);
      w.chain.tick();
      expect(failures(w.chain).at(-1)).toMatchObject({ error: 'PrepareFailed', retryable: false });
    }
  });

  test('a resolver that gives a bundle for another table is refused before anything is sent', () => {
    const { w, g, chain } = active();
    const other = `0x${'12'.repeat(32)}`;
    w.resolver.set('startExit', { bundle: w.bundle({ ...w.hand(g), tableId: other }) });
    const before = chain.block;
    chain.submit(makeJob('startExit', w.tableKey));
    chain.tick();
    expect(chain.block).toBe(before);
    expect(failures(chain).at(-1)).toMatchObject({ error: 'JobTableMismatch', retryable: false });
    expect(chain.live(w.tableKey).status).toBe('Active');
  });

  // The other table is real and in the state where the contract WOULD accept the foreign state, so the only
  // thing standing between the job and a transaction on the wrong table is the executor's own check.
  test('every kind that carries a state or bundle is refused when it is for another table, and that table is untouched', () => {
    const cases = [
      ['settle', (w, fin) => ({ bundle: w.bundle(fin) }), 'Active'],
      ['startExit', (w, _fin, s1) => ({ bundle: w.bundle(s1) }), 'Active'],
      ['challenge', (w, _fin, _s1, s2) => ({ bundle: w.bundle(s2) }), 'Exiting'],
      ['finalizeExit', (_w, _fin, s1) => ({ state: s1 }), 'Exiting'],
    ];
    for (const [kind, argsFor, otherStatus] of cases) {
      const { w, g, chain } = active();
      const other = `0x${'12'.repeat(32)}`;
      expectOk(
        chain.send(arbiterOf(w), 'createTable', {
          tableKey: other,
          maxPlayers: 6,
          minDeposit: UNIT,
          maxDeposit: 10_000_000n * UNIT,
        }),
      );
      w.seats.forEach((seat, i) => {
        chain.mint(seat.wallet, w.amounts[i]);
        expectOk(chain.deposit(other, seat.wallet, w.amounts[i], seat.session));
      });
      expectOk(chain.send(arbiterOf(w), 'start', { tableKey: other, players: w.players }));

      const foreign = (s) => ({ ...s, tableId: other });
      const s1 = foreign(w.hand(g));
      const s2 = foreign(w.hand(s1));
      const fin = foreign(w.final(s1));
      if (otherStatus === 'Exiting') {
        expectOk(chain.send(w.players[0], 'startExit', { bundle: w.bundle(s1) }));
        // challenge needs the window open on `other`, finalizeExit needs it closed
        if (kind === 'finalizeExit') chain.advanceTime(3601);
      }
      const before = {
        other: chain.live(other),
        table: chain.live(w.tableKey),
        block: chain.block,
      };

      w.resolver.set(kind, argsFor(w, fin, s1, s2));
      chain.submit(makeJob(kind, w.tableKey));
      expect(chain.tick().jobs[0]).toMatchObject({
        kind,
        outcome: 'failed',
        error: 'JobTableMismatch',
      });
      expect(failures(chain).at(-1)).toMatchObject({
        kind,
        tableKey: w.tableKey,
        error: 'JobTableMismatch',
        retryable: false,
        args: [other],
      });
      expect(chain.block).toBe(before.block);
      expect(chain.live(other)).toEqual(before.other);
      expect(chain.live(w.tableKey)).toEqual(before.table);
      expect(chain.sent.filter((s) => s.kind === kind)).toEqual([]);
    }
  });

  test('the job decides which table it acts on: a tableKey inside the resolver args is ignored', () => {
    const w = makeWorld();
    const other = `0x${'12'.repeat(32)}`;
    w.resolver.set('createTable', {
      tableKey: other,
      maxPlayers: 6,
      minDeposit: UNIT,
      maxDeposit: 100n * UNIT,
    });
    w.chain.submit(makeJob('createTable', w.tableKey));
    expect(w.chain.tick().jobs[0].outcome).toBe('sent');
    expect(w.chain.live(w.tableKey)).toMatchObject({ status: 'Filling' });
    expect(w.chain.live(other)).toBeNull();
  });

  test('a job submitted while a poll runs waits for the next poll; the running key cannot be submitted twice', () => {
    const w = makeWorld();
    const first = makeJob('start', w.tableKey);
    const second = makeJob('settle', w.tableKey);
    const answers = [];
    w.chain.resolver = {
      prepare: (job) => {
        if (job.kind === 'start') {
          answers.push(w.chain.submit(second), w.chain.submit(first));
        }
        return { proceed: false, reason: 'later' };
      },
    };
    w.chain.submit(first);
    expect(w.chain.tick().jobs.map((j) => j.kind)).toEqual(['start']);
    expect(answers).toEqual([true, false]);
    expect(w.chain.queued).toEqual([second.key]);
    expect(w.chain.tick().jobs.map((j) => j.kind)).toEqual(['settle']);
  });

  test('a sink that submits from an event is queued for the next poll, not run inside delivery', () => {
    const w = makeWorld();
    w.resolver.set('createTable', { maxPlayers: 6, minDeposit: UNIT, maxDeposit: 100n * UNIT });
    w.resolver.set('start', { players: w.players });
    w.chain.subscribe((event) => {
      if (event.type === 'TableCreated') w.chain.submit(makeJob('start', event.tableKey));
    });
    w.chain.submit(makeJob('createTable', w.tableKey));
    expect(w.chain.tick().jobs.map((j) => j.kind)).toEqual(['createTable']);
    expect(w.chain.queued).toEqual([makeJob('start', w.tableKey).key]);
    expect(w.chain.tick().jobs.map((j) => j.kind)).toEqual(['start']);
  });
});

describe('jobs: failures', () => {
  test('failNext: the next job of that kind fails before anything is sent, as a JobFailed with the flag', () => {
    const { w, g, chain } = active();
    const s1 = w.hand(g);
    chain.failNext('startExit', 'RpcTimeout', true);
    const before = chain.block;
    const result = w.run('startExit', { bundle: w.bundle(s1) });
    expect(result.jobs[0]).toMatchObject({ outcome: 'failed', error: 'RpcTimeout' });
    expect(chain.block).toBe(before);
    expect(chain.live(w.tableKey).status).toBe('Active');
    expect(failures(chain)).toEqual([
      {
        type: 'JobFailed',
        tableKey: w.tableKey,
        key: makeJob('startExit', w.tableKey).key,
        kind: 'startExit',
        error: 'RpcTimeout',
        retryable: true,
        args: [],
        block: chain.block,
        logIndex: expect.any(Number),
      },
    ]);
    // the retry goes through
    expect(w.run('startExit', { bundle: w.bundle(s1) }).jobs[0].outcome).toBe('sent');
  });

  test('failNext can say not retryable, is per kind, and queues several failures in order', () => {
    const { w, g, chain } = active();
    const s1 = w.hand(g);
    chain.failNext('startExit', 'First', false);
    chain.failNext('startExit', 'Second', true);
    chain.failNext('challenge', 'OtherKind', true);
    expect(w.run('startExit', { bundle: w.bundle(s1) }).jobs[0].error).toBe('First');
    expect(w.run('startExit', { bundle: w.bundle(s1) }).jobs[0].error).toBe('Second');
    expect(w.run('startExit', { bundle: w.bundle(s1) }).jobs[0].outcome).toBe('sent');
    expect(failures(chain).map((f) => [f.error, f.retryable])).toEqual([
      ['First', false],
      ['Second', true],
    ]);
    expect(() => chain.failNext('refund', 'x')).toThrow(RangeError);
  });

  test('failNext is not spent by a job the resolver declined', () => {
    const { w, g, chain } = active();
    chain.failNext('startExit', 'RpcTimeout');
    w.resolver.decline('startExit');
    chain.submit(makeJob('startExit', w.tableKey));
    expect(chain.tick().jobs[0].outcome).toBe('skipped');
    expect(w.run('startExit', { bundle: w.bundle(w.hand(g)) }).jobs[0].error).toBe('RpcTimeout');
  });

  test('a revert the contract gives is reported with its real name, arguments and retryable flag', () => {
    const { w, g, chain } = active();
    const s1 = w.hand(g);
    expectOk(chain.send(w.players[0], 'startExit', { bundle: w.bundle(s1) }));
    // a challenge with an equal nonce: StaleNonce(1, 1), final
    w.run('challenge', { bundle: w.bundle(s1) });
    expect(failures(chain).at(-1)).toMatchObject({
      kind: 'challenge',
      error: 'StaleNonce',
      args: [1n, 1n],
      retryable: false,
    });
    // a finalize inside the window: ExitWindowOpen, retryable
    w.run('finalizeExit', { state: s1 });
    expect(failures(chain).at(-1)).toMatchObject({
      kind: 'finalizeExit',
      error: 'ExitWindowOpen',
      retryable: true,
    });
    // a start on an Active table: WrongStatus(Exiting = 3)
    w.run('start', { players: w.players });
    expect(chain.sent.at(-1)).toMatchObject({
      kind: 'start',
      sender: arbiterOf(w),
      ok: false,
      error: 'WrongStatus',
    });
    expect(failures(chain).at(-1)).toMatchObject({
      kind: 'start',
      error: 'WrongStatus',
      args: [3],
      retryable: false,
    });
  });

  test('a reverted job does not mine a block or change anything', () => {
    const { w, g, chain } = active();
    const before = {
      block: chain.block,
      row: chain.live(w.tableKey),
      pending: chain.pending.length,
    };
    w.run('settle', { bundle: w.bundle(w.hand(g)) }); // NotFinal
    expect(chain.block).toBe(before.block);
    expect(chain.live(w.tableKey)).toEqual(before.row);
    expect(chain.pending).toEqual([]);
    expect(before.pending).toBe(0);
  });
});

describe('events', () => {
  test('are never delivered from submit, send or a read; only a tick delivers them', () => {
    const w = makeWorld();
    const sink = [];
    w.chain.subscribe((e) => sink.push(e));
    w.resolver.set('createTable', { maxPlayers: 6, minDeposit: UNIT, maxDeposit: 100n * UNIT });
    w.chain.submit(makeJob('createTable', w.tableKey));
    expect(sink).toEqual([]);
    w.chain.tick();
    expect(sink).toHaveLength(1);

    w.chain.mint(w.players[0], 100n * UNIT);
    w.chain.deposit(w.tableKey, w.players[0], UNIT, w.seats[0].session);
    w.chain.table(w.tableKey);
    w.chain.seat(w.tableKey, w.players[0]);
    w.chain.chainTime();
    w.chain.submit(makeJob('start', w.tableKey));
    expect(sink).toHaveLength(1);
    expect(w.chain.pending.map((e) => e.type)).toEqual(['Deposited']);
    expect(w.chain.tick().events).toBe(1);
    expect(sink.map((e) => e.type)).toEqual(['TableCreated', 'Deposited']);
    expect(w.chain.pending).toEqual([]);
    expect(w.chain.delivered).toEqual(sink);
  });

  test('come in order: (block, logIndex) strictly increases over everything delivered, one block per transaction', () => {
    const { w, g, chain } = active();
    const s1 = w.hand(g);
    const s2 = w.hand(s1);
    expectOk(chain.send(w.players[0], 'startExit', { bundle: w.bundle(s1) }));
    chain.failNext('challenge', 'RpcTimeout');
    w.run('challenge', { bundle: w.bundle(s2) });
    w.run('challenge', { bundle: w.bundle(s2) });
    chain.advanceTime(3601);
    w.run('finalizeExit', { state: s2 });
    chain.tick();

    const events = chain.delivered;
    for (let i = 1; i < events.length; i++) {
      const [a, b] = [events[i - 1], events[i]];
      expect(b.block > a.block || (b.block === a.block && b.logIndex > a.logIndex)).toBe(true);
    }
    // each real transaction has its own block; logIndex counts from 0 inside it
    const real = events.filter((e) => e.type !== 'JobFailed');
    const blocks = [...new Set(real.map((e) => e.block))];
    for (const block of blocks) {
      const inBlock = real.filter((e) => e.block === block);
      expect(inBlock.map((e) => e.logIndex)).toEqual(inBlock.map((_, i) => i));
    }
    expect(typesOf(events).filter((t) => t === 'JobFailed')).toHaveLength(1);
  });

  test('every block number is one above the last: a successful transaction mines one, a revert none', () => {
    const w = makeWorld();
    const start = w.chain.block;
    w.createTable();
    expect(w.chain.block).toBe(start + 1);
    expect(w.chain.send(stranger, 'createTable', {})).toMatchObject({ ok: false });
    expect(w.chain.block).toBe(start + 1);
    w.chain.advanceTime(5);
    expect(w.chain.block).toBe(start + 2);
    expect(w.chain.liveTime).toBe(1_700_000_005);
  });

  test('a JobFailed sorts after every real event delivered before it, even in the same block', () => {
    const w = makeWorld();
    w.createTable();
    w.createTable(); // TableExists
    const [created, failed] = w.chain.delivered;
    expect(created.type).toBe('TableCreated');
    expect(failed.type).toBe('JobFailed');
    expect(failed.block).toBe(created.block);
    expect(failed.logIndex).toBeGreaterThan(created.logIndex);
  });

  test('every event carries its tableKey, block and logIndex', () => {
    const { w, g, chain } = active();
    expectOk(chain.send(w.players[0], 'startExit', { bundle: w.bundle(w.hand(g)) }));
    chain.tick();
    for (const e of chain.delivered) {
      expect(e.tableKey).toBe(w.tableKey);
      expect(Number.isSafeInteger(e.block)).toBe(true);
      expect(Number.isSafeInteger(e.logIndex)).toBe(true);
      expect(Object.values(EVENT_TYPES)).toContain(e.type);
    }
  });

  test('unsubscribe stops delivery; one sink throwing does not starve the others, and the error is rethrown after', () => {
    const w = makeWorld();
    w.resolver.set('createTable', { maxPlayers: 6, minDeposit: UNIT, maxDeposit: 100n * UNIT });
    const seen = [];
    const off = w.chain.subscribe((e) => seen.push(['a', e.type]));
    w.chain.subscribe(() => {
      throw new Error('sink broke');
    });
    w.chain.subscribe((e) => seen.push(['c', e.type]));
    w.chain.submit(makeJob('createTable', w.tableKey));
    expect(() => w.chain.tick()).toThrow('sink broke');
    expect(seen).toEqual([
      ['a', 'TableCreated'],
      ['c', 'TableCreated'],
    ]);
    off();
    w.chain.mint(w.players[0], 100n * UNIT);
    w.chain.deposit(w.tableKey, w.players[0], UNIT, w.seats[0].session);
    expect(() => w.chain.tick()).toThrow('sink broke');
    expect(seen.filter(([who]) => who === 'a')).toHaveLength(1);
    expect(seen.filter(([who]) => who === 'c')).toHaveLength(2);
    expect(() => w.chain.subscribe('not a function')).toThrow(TypeError);
  });

  test('a handler may resubmit the job that just failed: its key is free before the events go out', () => {
    const w = makeWorld();
    const job = makeJob('start', w.tableKey);
    w.resolver.set('start', { players: w.players });
    w.chain.failNext('start', 'RpcTimeout', true);
    const answers = [];
    w.chain.subscribe((event) => {
      if (event.type === 'JobFailed' && event.retryable) answers.push(w.chain.submit(job));
    });
    w.chain.submit(job);
    w.chain.tick();
    expect(answers).toEqual([true]);
    expect(w.chain.queued).toEqual([job.key]);
  });

  test('a sink that was unsubscribed during a delivery gets nothing more from it', () => {
    const w = makeWorld();
    w.createTable();
    for (const p of w.players.slice(0, 2)) w.chain.mint(p, 100n * UNIT);
    const a = [];
    const b = [];
    let offB = () => {};
    w.chain.subscribe((e) => {
      a.push(e.player);
      offB();
    });
    offB = w.chain.subscribe((e) => b.push(e.player));
    w.seats.slice(0, 2).forEach((s) => {
      expectOk(w.chain.deposit(w.tableKey, s.wallet, UNIT, s.session));
    });
    w.chain.tick();
    expect(a).toEqual([w.players[0], w.players[1]]);
    expect(b).toEqual([]);
  });

  test('a sink added later sees only what is delivered after it joined', () => {
    const w = makeWorld();
    w.createTable();
    const late = [];
    w.chain.subscribe((e) => late.push(e.type));
    w.chain.mint(w.players[0], 100n * UNIT);
    w.chain.deposit(w.tableKey, w.players[0], UNIT, w.seats[0].session);
    w.chain.tick();
    expect(late).toEqual(['Deposited']);
  });

  test('tick() cannot be re-entered', () => {
    const w = makeWorld();
    w.createTable();
    w.chain.subscribe(() => w.chain.tick());
    w.chain.mint(w.players[0], 100n * UNIT);
    w.chain.deposit(w.tableKey, w.players[0], UNIT, w.seats[0].session);
    expect(() => w.chain.tick()).toThrow(/re-entered/);
  });
});

describe('the cached view, loseEvents and repair', () => {
  test('reads show the last poll, not the live chain', () => {
    const w = makeWorld();
    w.createTable();
    w.chain.mint(w.players[0], 100n * UNIT);
    expectOk(w.chain.deposit(w.tableKey, w.players[0], UNIT, w.seats[0].session));
    expect(w.chain.seat(w.tableKey, w.players[0])).toBeNull();
    expect(w.chain.table(w.tableKey).seated).toBe(0);
    expect(w.chain.live(w.tableKey).seated).toBe(1);
    w.chain.tick();
    expect(w.chain.seat(w.tableKey, w.players[0])).not.toBeNull();
    expect(w.chain.table(w.tableKey).seated).toBe(1);
  });

  test('chainTime is the clock at the last poll; the live clock moves at once and a job runs on it', () => {
    const { w, g, chain } = active();
    const start = chain.chainTime();
    chain.advanceTime(120);
    expect(chain.liveTime).toBe(start + 120);
    expect(chain.chainTime()).toBe(start);
    chain.tick();
    expect(chain.chainTime()).toBe(start + 120);
    chain.advanceTime(30);
    // a job executed now uses the live clock, whatever chainTime() says
    w.run('startExit', { bundle: w.bundle(w.hand(g)) });
    expect(chain.live(w.tableKey).exitDeadline).toBe(start + 150 + 3600);
    expect(chain.table(w.tableKey).exitDeadline).toBe(start + 150 + 3600); // the poll that ran the job refreshed
    expect(chain.chainTime()).toBe(start + 150);
  });

  test("the view is refreshed before the events are delivered: a handler sees at least its own event's state", () => {
    const w = makeWorld();
    const rows = [];
    w.chain.subscribe((e) => {
      if (e.type === 'TableCreated') rows.push(w.chain.table(e.tableKey)?.status);
    });
    w.createTable();
    expect(rows).toEqual(['Filling']);
  });

  test('advanceTime takes whole non-negative seconds', () => {
    const chain = new FakeChain();
    for (const bad of [-1, 1.5, '5', Number.NaN, 2 ** 60, undefined]) {
      expect(() => chain.advanceTime(bad)).toThrow(RangeError);
    }
    expect(() => chain.advanceTime(0)).not.toThrow();
  });

  test('loseEvents: a lost event is never delivered, its table stays stale until repair() re-reads it', () => {
    const w = makeWorld();
    w.createTable();
    w.chain.mint(w.players[0], 100n * UNIT);
    w.chain.loseEvents('Deposited');
    expectOk(w.chain.deposit(w.tableKey, w.players[0], UNIT, w.seats[0].session));
    expect(w.chain.tick().events).toBe(0);
    expect(w.chain.lost.map((e) => e.type)).toEqual(['Deposited']);
    expect(w.chain.delivered.some((e) => e.type === 'Deposited')).toBe(false);
    expect(w.chain.seat(w.tableKey, w.players[0])).toBeNull(); // the cache missed it
    expect(w.chain.live(w.tableKey).seated).toBe(1);

    w.chain.advanceTime(10);
    w.chain.tick();
    expect(w.chain.seat(w.tableKey, w.players[0])).toBeNull(); // a quiet poll does not repair it
    expect(w.chain.chainTime()).toBe(w.chain.liveTime); // but the clock still moves

    expect(w.chain.repair()).toEqual([w.tableKey]);
    expect(w.chain.seat(w.tableKey, w.players[0])).toMatchObject({ deposit: UNIT });
    expect(w.chain.repair()).toEqual([]); // nothing left to repair
  });

  test('a later event for the same table repairs the view as well', () => {
    const w = makeWorld();
    w.createTable();
    w.chain.mint(w.players[0], 100n * UNIT);
    w.chain.mint(w.players[1], 100n * UNIT);
    w.chain.loseEvents('Deposited');
    expectOk(w.chain.deposit(w.tableKey, w.players[0], UNIT, w.seats[0].session));
    w.chain.tick();
    expect(w.chain.seat(w.tableKey, w.players[0])).toBeNull();
    expectOk(w.chain.deposit(w.tableKey, w.players[1], UNIT, w.seats[1].session));
    w.chain.tick();
    expect(w.chain.seat(w.tableKey, w.players[0])).not.toBeNull();
    expect(w.chain.seat(w.tableKey, w.players[1])).not.toBeNull();
  });

  test('loseEvents takes a predicate and a count, and spends itself', () => {
    const w = makeWorld();
    w.createTable();
    for (const p of w.players) w.chain.mint(p, 100n * UNIT);
    w.chain.loseEvents((e) => e.type === 'Deposited' && e.player !== w.players[2], 2);
    for (const s of w.seats) expectOk(w.chain.deposit(w.tableKey, s.wallet, UNIT, s.session));
    w.chain.tick();
    expect(w.chain.lost.map((e) => e.player)).toEqual([w.players[0], w.players[1]]);
    expect(w.chain.delivered.filter((e) => e.type === 'Deposited').map((e) => e.player)).toEqual([
      w.players[2],
    ]);
    w.chain.deposit(w.tableKey, w.players[2], UNIT, w.seats[2].session);
    w.chain.tick();
    expect(w.chain.delivered.filter((e) => e.type === 'Deposited')).toHaveLength(2);
  });

  test('after repair() the table is no longer stale: a change with no event reaches the view at the next poll', () => {
    const w = makeWorld();
    w.createTable();
    w.chain.mint(w.players[0], 100n * UNIT);
    w.chain.loseEvents('Deposited');
    expectOk(w.chain.deposit(w.tableKey, w.players[0], UNIT, w.seats[0].session));
    w.chain.tick();
    w.chain.repair();
    w.chain.setConfirmed(w.tableKey, w.players[0], false);
    w.chain.tick();
    expect(w.chain.seat(w.tableKey, w.players[0]).confirmed).toBe(false);
  });

  test('repair() also refreshes the clock', () => {
    const chain = new FakeChain();
    chain.advanceTime(500);
    expect(chain.chainTime()).toBe(1_700_000_000);
    chain.repair();
    expect(chain.chainTime()).toBe(1_700_000_500);
  });
});

describe('the pause', () => {
  test('stops new money (createTable, deposit, start) and nothing that gets money out', () => {
    const { w, g, chain } = active();
    chain.pause(true);
    expect(chain.paused).toBe(true);
    chain.mint(w.players[0], 1000n);
    expect(chain.deposit(w.tableKey, w.players[0], 1n, w.seats[0].session)).toEqual(
      revert('EnforcedPause'),
    );
    const s1 = w.hand(g);
    const s2 = w.hand(s1);
    expectOk(chain.send(w.players[0], 'startExit', { bundle: w.bundle(s1) }));
    expectOk(chain.send(relayerOf(w), 'challenge', { bundle: w.bundle(s2) }));
    chain.advanceTime(3601);
    expectOk(chain.send(relayerOf(w), 'finalizeExit', { state: s2 }));
    chain.pause(false);
    expect(chain.paused).toBe(false);
    expect(chain.invariants().ok).toBe(true);
  });

  test('setSessionKey and leave, which are never paused, still work', () => {
    const w = makeWorld();
    w.createTable();
    w.depositAll();
    w.chain.pause(true);
    expect(w.chain.setSessionKey(w.tableKey, w.players[0], w.seats[1].session)).toEqual(ok);
    expect(w.chain.leave(w.tableKey, w.players[0])).toEqual(ok);
  });

  test('settle works while paused', () => {
    const { w, g, chain } = active();
    chain.pause(true);
    expect(chain.send(relayerOf(w), 'settle', { bundle: w.bundle(w.final(w.hand(g))) })).toEqual(
      ok,
    );
  });
});

describe('the books', () => {
  test('after any flow: the vault holds what it owes, escrow plus withdrawable, and tokens are never made or lost', () => {
    const w = makeWorld();
    const g = w.activate();
    const checks = [];
    const check = () => checks.push(w.chain.invariants());
    check();
    const s1 = w.hand(g, { winner: 0, loser: 1, amount: 100n, rake: 2n });
    const f1 = w.final(s1, [true, false, true]);
    expectOk(w.chain.send(relayerOf(w), 'settle', { bundle: w.bundle(f1) }));
    check();
    const late = addressFor('late');
    w.chain.mint(late, 5000n * UNIT);
    expectOk(w.chain.deposit(w.tableKey, late, 2000n * UNIT, w.seats[1].session));
    check();
    expectOk(w.chain.leave(w.tableKey, late));
    check();
    expectOk(w.chain.deposit(w.tableKey, w.players[1], UNIT, w.seats[1].session)); // paid out earlier
    check();
    for (const c of checks) {
      expect(c.ok).toBe(true);
      expect(c.vaultBalance).toBe(c.totalLocked);
      expect(c.totalLocked).toBe(c.escrowSum + c.withdrawableSum);
    }
    expect(w.chain.balances.total).toBe(w.chain.balances.minted);
  });

  test('invariants() notices a broken book', () => {
    const w = makeWorld();
    w.createTable();
    w.depositAll();
    expect(w.chain.invariants()).toMatchObject({ ok: true, seatsMatch: true });
    // tokens that appear in the vault without being owed are not solvent bookkeeping
    w.chain.mint(w.chain.info.vault, 5n);
    expect(w.chain.invariants().ok).toBe(false);
    expect(w.chain.invariants().vaultBalance).toBe(w.chain.totalLocked + 5n);
  });

  test("live() is the contract's storage, a copy, with the seats", () => {
    const { w, chain } = active();
    const live = chain.live(w.tableKey);
    expect(live.seats.size).toBe(3);
    live.seats.clear();
    expect(chain.live(w.tableKey).seats.size).toBe(3);
    expect(chain.live(`0x${'99'.repeat(32)}`)).toBeNull();
  });
});
