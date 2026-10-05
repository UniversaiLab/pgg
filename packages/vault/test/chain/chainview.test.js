// chainview.js against the real PokerVault on anvil: the hand-written calldata and decoders read exactly what
// viem reads, the JSON-RPC view works over a real HTTP node, and the epoch checks (F1) accept the real genesis
// and refuse every lie, including the lying server after a signed final, across a real settle and start.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { buildNextState, epochBaseline } from '../../src/build.js';
import {
  chainShowsSettled,
  createRpcChainView,
  decodeSeat,
  decodeTableRow,
  encodeSeatsCall,
  encodeTablesCall,
  verifyEpochAgainstChain,
} from '../../src/chainview.js';
import { STATUS } from '../../src/check.js';
import { chainDescribe } from '../../testing/index.js';
import { setupEpoch } from './setup.js';

const TABLE_FIELDS = [
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

chainDescribe('chainview vs the real PokerVault on anvil', () => {
  let env;
  let view;
  let epoch;
  const mine = 1; // my seat

  beforeAll(async () => {
    env = await setupEpoch();
    view = createRpcChainView({ rpcUrl: env.node.rpcUrl, vault: env.deployed.vault });
    epoch = {
      domain: env.domain,
      state: env.genesis,
      sessionKeys: env.roster.map((seat) => seat.session.address),
      arbiter: env.deployed.arbiter.address.toLowerCase(),
    };
  }, 60_000);
  afterAll(async () => {
    await env?.node.stop();
  });

  const players = () => env.roster.map((seat) => seat.address);

  // read the table and every roster seat through the view, the way the web controller will
  async function readChain(tableKey = env.tableId) {
    const table = await view.table(tableKey);
    const seats = await Promise.all(players().map((address) => view.seat(tableKey, address)));
    expect(table.ok, table.error).toBe(true);
    for (const seat of seats) expect(seat.ok, seat.error).toBe(true);
    return { chainTable: table.table, chainSeats: seats.map((seat) => seat.seat) };
  }
  const verify = async (patch = {}, tableKey = env.tableId) => {
    const chain = await readChain(tableKey);
    return verifyEpochAgainstChain({
      epoch,
      tableKey,
      ...chain,
      myAddress: env.roster[mine].address,
      myExpectedBalance: env.genesis.balances[mine],
      ...patch,
    });
  };

  test('table() returns exactly what viem reads, field for field, and decodeTableRow agrees on raw calldata', async () => {
    const viaViem = await env.read('tables', [env.tableId]);
    const result = await view.table(env.tableId);
    expect(result.ok).toBe(true);
    TABLE_FIELDS.forEach((field, k) => {
      const expected = field === 'arbiter' ? viaViem[k].toLowerCase() : viaViem[k];
      expect(result.table[field], field).toEqual(expected);
    });
    expect(result.table.status).toBe(STATUS.Active);
    expect(result.table.seated).toBe(3);
    expect(result.table.escrow).toBe(env.genesis.balances.reduce((a, b) => a + b, 0n));
    // the same bytes, straight from the node, through our encoder and decoder
    const raw = await env.node.publicClient.call({
      to: env.deployed.vault,
      data: encodeTablesCall(env.tableId),
    });
    expect(decodeTableRow(raw.data)).toEqual(result.table);
  });

  test('seat() returns exactly what viem reads for every seat; a stranger and an unknown table have none', async () => {
    for (const seat of env.roster) {
      const [deposit, sessionKey] = await env.read('seats', [env.tableId, seat.address]);
      const result = await view.seat(env.tableId, seat.address);
      expect(result).toEqual({
        ok: true,
        seat: { deposit, sessionKey: sessionKey.toLowerCase() },
      });
      expect(result.seat.sessionKey).toBe(seat.session.address);
    }
    const stranger = `0x${'77'.repeat(20)}`;
    expect(await view.seat(env.tableId, stranger)).toEqual({ ok: true, seat: null });
    expect(await view.seat(`0x${'ab'.repeat(32)}`, env.roster[0].address)).toEqual({
      ok: true,
      seat: null,
    });
    const raw = await env.node.publicClient.call({
      to: env.deployed.vault,
      data: encodeSeatsCall(env.tableId, stranger),
    });
    expect(decodeSeat(raw.data)).toBeNull();
  });

  test('a table that was never created has no row (status None, all zero), which the view reports as null', async () => {
    const key = `0x${'ab'.repeat(32)}`;
    expect(await view.table(key)).toEqual({ ok: true, table: null });
    const raw = await env.node.publicClient.call({
      to: env.deployed.vault,
      data: encodeTablesCall(key),
    });
    expect(decodeTableRow(raw.data)).toMatchObject({ status: 0, nonce: 0n, escrow: 0n, seated: 0 });
  });

  test('a pinned address with no code, or the wrong contract, is { ok: false }, never a guess', async () => {
    const empty = createRpcChainView({ rpcUrl: env.node.rpcUrl, vault: `0x${'12'.repeat(20)}` });
    const noCode = await empty.table(env.tableId);
    expect(noCode.ok).toBe(false);
    expect(noCode.error).toMatch(/12 words/);
    const token = createRpcChainView({ rpcUrl: env.node.rpcUrl, vault: env.deployed.token });
    expect((await token.table(env.tableId)).ok).toBe(false);
    expect((await token.seat(env.tableId, env.roster[0].address)).ok).toBe(false);
  });

  test('a node that is not there answers { ok: false } on every method', async () => {
    const dead = createRpcChainView({
      rpcUrl: 'http://127.0.0.1:1',
      vault: env.deployed.vault,
      timeoutMs: 2000,
    });
    expect((await dead.table(env.tableId)).ok).toBe(false);
    expect((await dead.seat(env.tableId, env.roster[0].address)).ok).toBe(false);
    expect((await dead.blockTimestamp()).ok).toBe(false);
  });

  test('the real genesis is accepted, for every seat as "me", with the keys and balances the deposits made', async () => {
    for (let i = 0; i < 3; i++) {
      const result = await verify({
        myAddress: env.roster[i].address,
        myExpectedBalance: env.genesis.balances[i],
      });
      expect(result, `seat ${i}`).toEqual({ ok: true });
    }
    // deposits carry dust (not a multiple of any chip unit) and the check is exact to the unit anyway
    expect(env.genesis.balances.some((b) => b % 10_000n !== 0n)).toBe(true);
  });

  test('every lie about the epoch is refused against the real chain, by the rule that names it', async () => {
    const real = await readChain();
    const attempt = (patch) =>
      verifyEpochAgainstChain({
        epoch,
        tableKey: env.tableId,
        ...real,
        myAddress: env.roster[mine].address,
        myExpectedBalance: env.genesis.balances[mine],
        ...patch,
      });
    const stolenKey = `0x${'99'.repeat(20)}`;
    const lies = {
      'table-id': { tableKey: `0x${'ab'.repeat(32)}` },
      status: { chainTable: null },
      nonce: { epoch: { ...epoch, state: { ...env.genesis, nonce: 1n } } },
      roster: {
        epoch: {
          ...epoch,
          state: {
            ...env.genesis,
            players: [...env.genesis.players.slice(0, 2), `0x${'ff'.repeat(20)}`],
          },
        },
        myAddress: env.roster[0].address,
        myExpectedBalance: env.genesis.balances[0],
      },
      escrow: {
        epoch: {
          ...epoch,
          state: {
            ...env.genesis,
            balances: env.genesis.balances.map((b, i) => (i === 0 ? b + 1n : b)),
          },
        },
      },
      arbiter: { epoch: { ...epoch, arbiter: env.roster[0].address } },
      'session-key': {
        epoch: { ...epoch, sessionKeys: [stolenKey, ...epoch.sessionKeys.slice(1)] },
      },
      'my-balance': { myExpectedBalance: env.genesis.balances[mine] + 1n },
      deposit: {
        epoch: {
          ...epoch,
          state: {
            ...env.genesis,
            balances: env.genesis.balances.map((b, i) => (i === 0 ? b - 7n : i === 2 ? b + 7n : b)),
          },
        },
      },
    };
    for (const [rule, patch] of Object.entries(lies)) {
      expect(attempt(patch), rule).toEqual(expect.objectContaining({ ok: false, rule }));
    }
    // a roster member whose seat on the chain is empty (a table where somebody left) is a session-key refusal
    expect(attempt({ chainSeats: [null, ...real.chainSeats.slice(1)] })).toEqual(
      expect.objectContaining({ ok: false, rule: 'session-key' }),
    );
  });

  test('F1 end to end: a signed final, a lying server, a real settle, a real start, and the new epoch', async () => {
    const genesis = env.genesis;
    // a hand, and the final state of the epoch folded into it: everyone stays
    const final = buildNextState({
      prev: genesis,
      balances: genesis.balances.map((b, i) =>
        i === 0 ? b + 49_000_000n : i === 1 ? b - 50_000_000n : b,
      ),
      rakeDelta: 1_000_000n,
      volumeDelta: 100_000_000n,
      final: true,
      keep: [true, true, true],
    });
    const sigs = await env.sign(final);
    const nextGenesis = (patch = {}) =>
      epochBaseline({
        tableId: env.tableId,
        players: players(),
        deposits: final.balances,
        nonce: final.nonce,
        rake: final.rake,
        volume: final.volume,
        ...patch,
      });
    const nextEpoch = (state) => ({ ...epoch, state });
    const myAfter = final.balances[mine];

    // 1. I signed the final; nothing has been settled. The chain still shows the OLD epoch.
    let chain = await readChain();
    expect(chain.chainTable.status).toBe(STATUS.Active);
    expect(chainShowsSettled({ chainTable: chain.chainTable, final })).toBe(false);
    // the server announces the next epoch (same roster, the final's nonce, the balances I signed): the
    // chain does not agree, so it is refused until the chain shows the settle
    const early = await verify({
      epoch: nextEpoch(nextGenesis()),
      myExpectedBalance: myAfter,
    });
    expect(early).toEqual(expect.objectContaining({ ok: false, rule: 'nonce' }));
    // a fake epoch that moves my chips elsewhere is refused too, by the first rule it breaks
    const robbed = nextGenesis({
      deposits: final.balances.map((b, i) =>
        i === mine ? 0n : i === 0 ? b + final.balances[mine] : b,
      ),
    });
    expect((await verify({ epoch: nextEpoch(robbed), myExpectedBalance: myAfter })).ok).toBe(false);
    // replaying the old genesis matches the chain, so only the latch stops it: not settled
    expect(await verify()).toEqual({ ok: true });
    expect(chainShowsSettled({ chainTable: chain.chainTable, final })).toBe(false);

    // 2. Anyone settles the final on chain. The vault is Filling at the final nonce, rake paid.
    await env.write(
      env.roster[0].wallet,
      env.deployed.vault,
      env.deployed.vaultAbi,
      'settle',
      env.submit(final, sigs),
    );
    chain = await readChain();
    expect(chain.chainTable).toMatchObject({
      status: STATUS.Filling,
      nonce: final.nonce,
      rakePaid: final.rake,
      seated: 3,
    });
    expect(chainShowsSettled({ chainTable: chain.chainTable, final })).toBe(true);
    // the old genesis is stale now; the new one is acceptable as Filling only when the caller says so
    expect(await verify({ myExpectedBalance: env.genesis.balances[mine] })).toEqual(
      expect.objectContaining({ ok: false, rule: 'status' }),
    );
    expect(await verify({ epoch: nextEpoch(nextGenesis()), myExpectedBalance: myAfter })).toEqual(
      expect.objectContaining({ ok: false, rule: 'status' }),
    );
    expect(
      await verify({
        epoch: nextEpoch(nextGenesis()),
        myExpectedBalance: myAfter,
        allowFilling: true,
      }),
    ).toEqual({ ok: true, filling: true });
    // a stuffed or short table does not pass while Filling either: this epoch says 3 seats, the table has 3
    expect(
      (
        await verify({
          epoch: nextEpoch(nextGenesis()),
          myExpectedBalance: myAfter,
          allowFilling: true,
        })
      ).filling,
    ).toBe(true);

    // 3. The arbiter starts the next epoch: Active at the final nonce with the roster hash set.
    await env.write(env.deployed.arbiter, env.deployed.vault, env.deployed.vaultAbi, 'start', [
      env.tableId,
      players(),
    ]);
    chain = await readChain();
    expect(chain.chainTable).toMatchObject({ status: STATUS.Active, nonce: final.nonce });
    expect(chainShowsSettled({ chainTable: chain.chainTable, final })).toBe(true);
    expect(await verify({ epoch: nextEpoch(nextGenesis()), myExpectedBalance: myAfter })).toEqual({
      ok: true,
    });
    // with the balances I signed, and not with a unit moved between two other seats
    const shifted = nextGenesis({
      deposits: final.balances.map((b, i) => (i === 0 ? b - 1n : i === 2 ? b + 1n : b)),
    });
    expect(await verify({ epoch: nextEpoch(shifted), myExpectedBalance: myAfter })).toEqual(
      expect.objectContaining({ ok: false, rule: 'deposit' }),
    );
    // and the OLD genesis is refused for good (nonce 0 against a table at the final nonce)
    expect(await verify({ myExpectedBalance: env.genesis.balances[mine] })).toEqual(
      expect.objectContaining({ ok: false, rule: 'nonce' }),
    );
  }, 60_000);

  test('blockTimestamp() is the latest block time and moves when the chain does', async () => {
    const latest = await env.node.publicClient.getBlock();
    const first = await view.blockTimestamp();
    expect(first).toEqual({ ok: true, timestamp: latest.timestamp });
    await env.node.advance(3601);
    const second = await view.blockTimestamp();
    expect(second.ok).toBe(true);
    expect(second.timestamp - first.timestamp).toBeGreaterThanOrEqual(3601n);
    const now = await env.node.publicClient.getBlock();
    expect(second.timestamp).toBe(now.timestamp);
  }, 30_000);
});
