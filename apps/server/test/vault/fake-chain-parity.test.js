// FakeChain against the real PokerVault. The same random transactions go to a contract on anvil and to a
// FakeChain; after every one the two must agree on: the outcome (success, or the same revert name and
// arguments), the events it emitted, every table row and seat, every token balance, what is withdrawable
// and the vault's totalLocked. FakeChain is what every coordinator test runs against, so this is the test
// that keeps its answers the contract's answers.
//
// A seed is one random program over three tables. Guided steps walk a table through the happy path (create,
// deposit, start, hands, settle or exit, challenge, finalise) so deep states are reached; the others are
// random calls from random senders with faults in the states and signatures. Time is pinned: every
// transaction is mined at a chosen timestamp on both sides, and half of the window checks aim at the
// deadline's edge (deadline - 1, deadline, deadline + 1).
//
// Not modelled by FakeChain on purpose, so not exercised here: token approvals (the fake assumes everyone
// approved the vault), fee-on-transfer and paused tokens, the owner's ownership transfer, reentrancy.
//
//   PARITY_SEEDS=4 PARITY_STEPS=120 PARITY_SEED0=100 PARITY_GUIDED=0.6
import { expect, test } from 'bun:test';
import { hashState } from '@pgg/vault';
import { chainDescribe, deployVault, startAnvil, testAccount } from '@pgg/vault/testing';
import { decodeErrorResult, decodeEventLog, keccak256, toHex } from 'viem';
import { FakeChain } from '../../src/vault/fake-chain.js';

const SEEDS = Number(process.env.PARITY_SEEDS ?? 3);
const STEPS = Number(process.env.PARITY_STEPS ?? 120);
const SEED0 = Number(process.env.PARITY_SEED0 ?? 100);
const GUIDED = Number(process.env.PARITY_GUIDED ?? 0.6);
const MAX_RAKE_BPS = 137;
const EXIT_WINDOW = 3600;
const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;
const ZERO_HASH = `0x${'00'.repeat(32)}`;
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const STATUS_NAMES = ['None', 'Filling', 'Active', 'Exiting', 'Closed'];
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

// the events FakeChain models, with the fields it carries (Withdrawn and the admin events it does not)
const EVENT_FIELDS = {
  TableCreated: ['arbiter', 'maxPlayers', 'minDeposit', 'maxDeposit'],
  Deposited: ['player', 'amount', 'total', 'sessionKey'],
  SessionKeySet: ['player', 'sessionKey'],
  Left: ['player', 'amount'],
  Started: ['players'],
  Settled: ['nonce', 'rakePaid', 'rakeDelta', 'stayers'],
  ExitStarted: ['by', 'nonce', 'digest', 'deadline'],
  Challenged: ['by', 'nonce', 'digest', 'deadline'],
  ExitFinalized: ['nonce', 'rakePaid', 'rakeDelta'],
  Payout: ['to', 'amount', 'pushed'],
};

// mulberry32: a seed is a program, and a failure names its seed
function rngFor(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    pick: (list) => list[Math.floor(next() * list.length)],
    big: (lo, hi) => lo + BigInt(Math.floor(next() * Number(hi - lo + 1n))),
  };
}

// numbers, bigints and case differ between viem and FakeChain; what they say must not
const norm = (v) => {
  if (typeof v === 'bigint' || typeof v === 'number') return String(v);
  if (typeof v === 'string') return v.toLowerCase();
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)]));
  }
  return v;
};
const same = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
const show = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? `${x}n` : x));

// the same signature with s replaced by n - s and v flipped: valid maths, refused by the contract (low-s)
function highS(sig) {
  const s = BigInt(`0x${sig.slice(66, 130)}`);
  const v = Number.parseInt(sig.slice(130, 132), 16) === 27 ? 28 : 27;
  return `0x${sig.slice(2, 66)}${(SECP256K1_N - s).toString(16).padStart(64, '0')}${v.toString(16)}`;
}

const byAddress = (a, b) => (BigInt(a) < BigInt(b) ? -1 : 1);
const sortedAddresses = (list) => list.map((a) => a.toLowerCase()).sort(byAddress);

chainDescribe('FakeChain agrees with the real PokerVault', () => {
  test('random programs, step by step', async () => {
    const node = await startAnvil();
    try {
      const seen = await runPrograms(node);
      // the run must have reached the deep states, or agreeing says little
      for (const type of [
        'Deposited',
        'Started',
        'Settled',
        'ExitStarted',
        'Challenged',
        'ExitFinalized',
      ]) {
        expect(seen.events.get(type) ?? 0).toBeGreaterThan(0);
      }
      for (const error of [
        'WrongStatus',
        'NotArbiter',
        'NotFinal',
        'ExitWindowOpen',
        'BadRoster',
      ]) {
        expect(seen.reverts.get(error) ?? 0).toBeGreaterThan(0);
      }
    } finally {
      await node.stop();
    }
  }, 600_000);
});

async function runPrograms(node) {
  const deployed = await deployVault(node, { exitWindow: EXIT_WINDOW, maxRakeBps: MAX_RAKE_BPS });
  const { vault, token, vaultAbi, tokenAbi, arbiter, house, owner, deployer } = deployed;
  const client = node.publicClient;
  const relayer = await node.account('parity-relayer');
  const stranger = await node.account('parity-stranger');
  const players = [];
  for (let i = 0; i < 6; i++) players.push(await node.account(`parity-player-${i}`));
  const sessions = players.map((_, i) => testAccount(`parity-session-${i}`));
  const stray = testAccount('parity-stray-signer');
  const lower = (account) => account.address.toLowerCase();
  const short = (account) => lower(account).slice(0, 6);
  const domain = { chainId: node.chainId, verifyingContract: vault };
  const watched = [arbiter, relayer, stranger, house, owner, ...players].map(lower);
  watched.push(vault.toLowerCase());
  const decodeAbi = [...vaultAbi, ...tokenAbi];

  const vaultRead = (functionName, args = []) =>
    client.readContract({ address: vault, abi: vaultAbi, functionName, args });
  const tokenRead = (functionName, args = []) =>
    client.readContract({ address: token, abi: tokenAbi, functionName, args });
  const tokenSend = async (account, functionName, args) => {
    const hash = await node.walletFor(account).writeContract({
      address: token,
      abi: tokenAbi,
      functionName,
      args,
      gas: 3_000_000n,
    });
    await client.waitForTransactionReceipt({ hash });
  };

  for (const p of players) {
    await tokenSend(p, 'approve', [vault, 2n ** 256n - 1n]);
    await tokenSend(deployer, 'mint', [p.address, 50_000_000n]);
  }

  const seen = { events: new Map(), reverts: new Map() };
  const count = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

  for (let seed = SEED0; seed < SEED0 + SEEDS; seed++) {
    const program = await startProgram(seed);
    if (seed === SEED0) await program.edges();
    await program.run();
    await program.cleanUp();
  }
  return seen;

  async function startProgram(seed) {
    const rng = rngFor(seed);
    const tableIds = [0, 1, 2].map((i) => keccak256(toHex(`parity:${seed}:${i}`)));
    let time = Number((await client.getBlock()).timestamp) + 50;
    const fake = new FakeChain({
      chainId: node.chainId,
      vault,
      arbiter: arbiter.address,
      relayer: relayer.address,
      house: house.address,
      maxRakeBps: MAX_RAKE_BPS,
      exitWindowSec: EXIT_WINDOW,
      startTime: time,
    });
    // the fake starts from the real chain's books: balances now, and what earlier programs left in the vault
    for (const account of [arbiter, relayer, stranger, house, owner, ...players]) {
      const have = await tokenRead('balanceOf', [account.address]);
      if (have > 0n) fake.mint(account.address, have);
    }
    const carried = await tokenRead('balanceOf', [vault]);
    if (carried > 0n) fake.mint(vault, carried);
    expect(await vaultRead('totalLocked')).toBe(carried);

    const rosters = new Map(); // table -> the roster of its last start
    const exitStates = new Map(); // table -> the state its exit holds
    const pools = new Map(tableIds.map((id) => [id, []])); // table -> states that were signed (for stale replays)
    const log = [];
    const live = (id) => fake.live(id);
    const rosterOf = (id) => rosters.get(id) ?? sortedAddresses(players.map(lower));

    // ---------------------------------------------------------------- one transaction on both sides
    async function pinTime(target) {
      time = Math.max(time, target, Number((await client.getBlock()).timestamp));
      await node.testClient.setNextBlockTimestamp({ timestamp: BigInt(time) });
      if (time > fake.liveTime) fake.advanceTime(time - fake.liveTime);
    }

    async function realTx(account, functionName, args) {
      const hash = await node.walletFor(account).writeContract({
        address: vault,
        abi: vaultAbi,
        functionName,
        args,
        gas: 12_000_000n,
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status === 'success') {
        const events = [];
        for (const entry of receipt.logs) {
          if (entry.address.toLowerCase() !== vault.toLowerCase()) continue;
          let decoded;
          try {
            decoded = decodeEventLog({ abi: vaultAbi, data: entry.data, topics: entry.topics });
          } catch {
            continue;
          }
          if (EVENT_FIELDS[decoded.eventName])
            events.push({ type: decoded.eventName, ...decoded.args });
        }
        return { ok: true, events };
      }
      // the receipt of a revert carries no data: ask the node's tracer what the transaction said
      const trace = await client.request({
        method: 'debug_traceTransaction',
        params: [hash, { tracer: 'callTracer' }],
      });
      const data = trace.output ?? '0x';
      if (data === '0x') return { ok: false, error: 'Malformed', args: [] };
      try {
        const decoded = decodeErrorResult({ abi: decodeAbi, data });
        return { ok: false, error: decoded.errorName, args: decoded.args ?? [] };
      } catch {
        return { ok: false, error: `Unknown(${data.slice(0, 10)})`, args: [] };
      }
    }

    const eventOf = (e) => {
      const out = { type: e.type, tableKey: String(e.tableKey ?? e.tableId).toLowerCase() };
      for (const field of EVENT_FIELDS[e.type]) out[field] = e[field];
      return out;
    };

    /** op: { label, dt?, real(), fake(), tables? } -- run on both, then compare everything. */
    async function step(op) {
      await pinTime(time + (op.dt ?? rng.int(1, 40)));
      const realResult = await op.real();
      const fakeResult = op.fake();
      const fakeEvents = fake.pending.map(eventOf);
      fake.tick(); // delivers nothing to anyone, refreshes the cached view
      const events = realResult.ok ? realResult.events.map((e) => e.type) : [];
      log.push(
        `${op.label} @${time} real=${realResult.ok ? 'ok' : realResult.error} fake=${fakeResult.ok ? 'ok' : fakeResult.error} ev=${events.join('+')}`,
      );
      const fail = (why) => {
        throw new Error(
          `seed ${seed} step ${log.length}: ${why}\n  real ${show(realResult)}\n  fake ${show(fakeResult)}\n  last steps:\n    ${log.slice(-8).join('\n    ')}`,
        );
      };
      if (realResult.ok !== fakeResult.ok) fail('one succeeded and the other reverted');
      if (realResult.ok) {
        const realEvents = realResult.events.map(eventOf);
        if (!same(realEvents, fakeEvents)) {
          fail(`events differ:\n    real ${show(realEvents)}\n    fake ${show(fakeEvents)}`);
        }
        for (const e of realEvents) count(seen.events, e.type);
      } else {
        if (realResult.error !== fakeResult.error) fail('different revert');
        if (realResult.error !== 'Malformed' && !same(realResult.args, fakeResult.args)) {
          fail('different revert arguments');
        }
        count(seen.reverts, realResult.error);
      }
      await compareBooks(op.tables ?? tableIds, fail);
      return realResult;
    }

    async function compareBooks(ids, fail) {
      for (const id of ids) {
        const row = await vaultRead('tables', [id]);
        const table = live(id);
        const fakeRow = table
          ? TABLE_FIELDS.map((field) => table[field])
          : ['None', 0, 0, ZERO_ADDRESS, 0n, 0, 0n, 0n, 0n, 0n, ZERO_HASH, ZERO_HASH];
        TABLE_FIELDS.forEach((field, i) => {
          const real = field === 'status' ? STATUS_NAMES[row[i]] : row[i];
          if (!same(real, fakeRow[i])) {
            fail(
              `table ${id.slice(0, 8)} ${field}: real ${String(real)}, fake ${String(fakeRow[i])}`,
            );
          }
        });
        for (const p of players) {
          const [deposit, sessionKey] = await vaultRead('seats', [id, p.address]);
          const seat = table?.seats.get(lower(p));
          if (
            !same(deposit, seat?.deposit ?? 0n) ||
            !same(sessionKey, seat?.sessionKey ?? ZERO_ADDRESS)
          ) {
            fail(
              `seat ${id.slice(0, 8)} ${short(p)}: real ${deposit}/${sessionKey}, fake ${seat?.deposit ?? 0n}/${seat?.sessionKey ?? ZERO_ADDRESS}`,
            );
          }
        }
      }
      for (const account of watched) {
        const real = await tokenRead('balanceOf', [account]);
        if (real !== fake.balances.of(account)) {
          fail(
            `token balance of ${account.slice(0, 8)}: real ${real}, fake ${fake.balances.of(account)}`,
          );
        }
      }
      for (const p of players) {
        const real = await vaultRead('withdrawable', [p.address]);
        if (real !== fake.withdrawableOf(p.address)) {
          fail(`withdrawable of ${short(p)}: real ${real}, fake ${fake.withdrawableOf(p.address)}`);
        }
      }
      const locked = await vaultRead('totalLocked');
      if (locked !== fake.totalLocked + carried) {
        fail(`totalLocked: real ${locked}, fake ${fake.totalLocked + carried}`);
      }
    }

    // ---------------------------------------------------------------- states and signatures
    const sessionKeyOf = (id, address) =>
      live(id)?.seats.get(address.toLowerCase())?.sessionKey ?? null;
    const sessionAccount = (address) => sessions.find((s) => lower(s) === address.toLowerCase());

    // everyone signs with the key the contract holds for them (a stranger's key when it holds none)
    async function sign(id, state, roster, faults = {}) {
      const hash = hashState(state, domain);
      let arbiterSig = await arbiter.sign({ hash });
      const playerSigs = [];
      for (const address of roster) {
        const key = sessionKeyOf(id, address);
        playerSigs.push(await (key ? sessionAccount(key) : stray).sign({ hash }));
      }
      const broken = async (sig, kind) => {
        if (kind === 'stranger') return stray.sign({ hash });
        if (kind === 'short') return sig.slice(0, -2);
        if (kind === 'highS') return highS(sig);
        return `0x${'00'.repeat(65)}`;
      };
      if (faults.arbiter) arbiterSig = await broken(arbiterSig, faults.arbiter);
      if (faults.player !== undefined && playerSigs.length > 0) {
        const i = faults.player % playerSigs.length;
        playerSigs[i] = await broken(playerSigs[i], faults.playerKind);
      }
      if (faults.dropSig) playerSigs.pop();
      if (faults.addSig) playerSigs.push(playerSigs[0] ?? arbiterSig);
      return { arbiterSig, playerSigs };
    }

    // a next state for a table: conserving, rake under the cap, one nonce up (or more)
    function nextState(id, roster) {
      const t = live(id);
      const escrow = t?.escrow ?? 0n;
      const rakeDelta = escrow === 0n ? 0n : rng.big(0n, escrow > 50_000n ? 50_000n : escrow);
      let rest = escrow - rakeDelta;
      const balances = roster.map((_, i) => {
        const take = i === roster.length - 1 ? rest : rng.chance(0.15) ? 0n : rng.big(0n, rest);
        rest -= take;
        return take;
      });
      const rake = (t?.rakePaid ?? 0n) + rakeDelta;
      const cap = BigInt(MAX_RAKE_BPS);
      return {
        tableId: id,
        nonce: (t?.nonce ?? 0n) + 1n + BigInt(rng.int(0, 2)),
        isFinal: rng.chance(0.45),
        players: roster,
        balances,
        keep: roster.map(() => rng.chance(0.3)),
        rake,
        volume: (rake * 10_000n + cap - 1n) / cap + rng.big(0n, 1000n),
      };
    }

    // one fault, one time in eighteen rolls for each kind: the contract and the fake must refuse the same way
    function withFault(state, id) {
      const s = {
        ...state,
        players: [...state.players],
        balances: [...state.balances],
        keep: [...state.keep],
      };
      const faults = {};
      const chainNonce = live(id)?.nonce ?? 0n;
      switch (rng.int(0, 17)) {
        case 0:
          s.nonce = chainNonce;
          break;
        case 1:
          s.nonce = chainNonce > 0n ? chainNonce - 1n : 0n;
          break;
        case 2:
          s.players = s.players.slice(0, -1);
          s.balances = s.balances.slice(0, -1);
          s.keep = s.keep.slice(0, -1);
          break;
        case 3:
          if (s.players.length > 1) [s.players[0], s.players[1]] = [s.players[1], s.players[0]];
          break;
        case 4:
          s.players.push(lower(stranger));
          s.balances.push(0n);
          s.keep.push(false);
          break;
        case 5:
          s.balances[rng.int(0, s.balances.length - 1)] += 1n;
          break;
        case 6:
          s.rake = s.rake > 0n ? s.rake - 1n : 0n;
          break;
        case 7:
          s.volume = 0n;
          s.rake += 1n;
          s.balances[0] = s.balances[0] > 0n ? s.balances[0] - 1n : 0n;
          break;
        case 8:
          s.balances = s.balances.slice(1);
          break;
        case 9:
          s.keep.push(true);
          break;
        case 10:
          s.isFinal = !s.isFinal;
          break;
        case 11:
          faults.arbiter = rng.pick(['stranger', 'short', 'zero', 'highS']);
          break;
        case 12:
          faults.player = rng.int(0, 9);
          faults.playerKind = rng.pick(['stranger', 'short', 'zero', 'highS']);
          break;
        case 13:
          faults.dropSig = true;
          break;
        case 14:
          faults.addSig = true;
          break;
        case 15:
          s.tableId = rng.pick(tableIds);
          break;
        case 16:
          s.keep = s.keep.map(() => true);
          break;
        default:
          break;
      }
      return { state: s, faults };
    }

    const amountFor = (t) => {
      const lo = t?.minDeposit ?? 100n;
      const hi = t?.maxDeposit ?? 1_000_000n;
      switch (rng.int(0, 5)) {
        case 0:
          return 0n;
        case 1:
          return lo;
        case 2:
          return hi;
        case 3:
          return hi + 1n;
        case 4:
          return lo > 1n ? lo - 1n : lo;
        default:
          return rng.big(lo, hi < lo + 2_000_000n ? hi : lo + 2_000_000n);
      }
    };

    // a transaction aimed at the edge of the window of an exit in progress: deadline - 1, deadline, deadline + 1
    const aimAtDeadline = (t, chance = 0.45) =>
      t?.status === 'Exiting' && t.exitDeadline > time && rng.chance(chance)
        ? Math.max(1, t.exitDeadline - time + rng.int(-1, 1))
        : undefined;

    const memberOrArbiter = (t) =>
      rng.chance(0.5) ? arbiter : rng.pick(players.filter((p) => t.seats.has(lower(p))));

    // ---------------------------------------------------------------- guided happy paths
    async function guided(id, t, status) {
      const roster = rosterOf(id);
      if (status === 'None') {
        const args = [id, rng.int(2, 6), 100n, 1_000_000n];
        await step({
          label: 'G createTable',
          real: () => realTx(arbiter, 'createTable', args),
          fake: () =>
            fake.send(arbiter.address, 'createTable', {
              tableKey: id,
              maxPlayers: args[1],
              minDeposit: args[2],
              maxDeposit: args[3],
            }),
          tables: [id],
        });
        return true;
      }
      if (status === 'Filling') return guidedFilling(id, t);
      if (status !== 'Active' && status !== 'Exiting') return false;

      // a signed state above the chain's nonce; one time in three it carries a fault
      const prepared = async (isFinal, higher) => {
        let state = nextState(id, roster);
        state.isFinal = isFinal;
        state.nonce = t.nonce + BigInt(higher);
        state.keep = state.balances.map((b) => isFinal && b > 0n && rng.chance(0.55));
        let faults = {};
        if (rng.chance(0.33)) ({ state, faults } = withFault(state, id));
        const sigs = await sign(
          id,
          state,
          state.players.length > 0 ? state.players : roster,
          faults,
        );
        return { state, sigs };
      };
      const asBundle = (state, sigs) => ({ bundle: { state, ...sigs } });
      const pick = rng.int(0, 4);

      if (status === 'Active') {
        if (pick <= 1) {
          const { state, sigs } = await prepared(true, rng.int(1, 3));
          const sender = rng.pick([relayer, stranger, rng.pick(players)]);
          await step({
            label: `G settle nonce ${state.nonce} keep ${state.keep.filter(Boolean).length}/${state.keep.length}`,
            real: () => realTx(sender, 'settle', [state, sigs.arbiterSig, sigs.playerSigs]),
            fake: () => fake.send(sender.address, 'settle', asBundle(state, sigs)),
            tables: [id],
          });
          pools.get(id).push(state);
        } else if (pick <= 3) {
          const { state, sigs } = await prepared(rng.chance(0.15), rng.int(1, 3));
          const sender = memberOrArbiter(t);
          const result = await step({
            label: `G startExit nonce ${state.nonce} final ${state.isFinal}`,
            real: () => realTx(sender, 'startExit', [state, sigs.arbiterSig, sigs.playerSigs]),
            fake: () => fake.send(sender.address, 'startExit', asBundle(state, sigs)),
            tables: [id],
          });
          if (result.ok) exitStates.set(id, state);
          pools.get(id).push(state);
        } else {
          const sender = memberOrArbiter(t);
          const result = await step({
            label: 'G startExitFromDeposits',
            real: () => realTx(sender, 'startExitFromDeposits', [id, roster]),
            fake: () =>
              fake.send(sender.address, 'startExitFromDeposits', { tableKey: id, players: roster }),
            tables: [id],
          });
          if (result.ok) exitStates.set(id, depositStateOf(id, roster));
        }
        return true;
      }

      const deadline = t.exitDeadline;
      if (pick <= 1 && time + 2 < deadline) {
        const { state, sigs } = await prepared(rng.chance(0.2), rng.int(1, 3));
        const sender = rng.pick([relayer, stranger, arbiter]);
        const result = await step({
          label: `G challenge nonce ${state.nonce} final ${state.isFinal}`,
          dt: rng.chance(0.3) ? Math.max(1, deadline - time - rng.int(0, 1)) : undefined,
          real: () => realTx(sender, 'challenge', [state, sigs.arbiterSig, sigs.playerSigs]),
          fake: () => fake.send(sender.address, 'challenge', asBundle(state, sigs)),
          tables: [id],
        });
        if (result.ok) exitStates.set(id, state);
        return true;
      }
      if (pick === 2) {
        const { state, sigs } = await prepared(true, rng.int(1, 3));
        await step({
          label: `G settle during the exit, nonce ${state.nonce}`,
          dt: rng.chance(0.4) ? Math.max(1, deadline - time + rng.int(-1, 40)) : undefined,
          real: () => realTx(relayer, 'settle', [state, sigs.arbiterSig, sigs.playerSigs]),
          fake: () => fake.send(relayer.address, 'settle', asBundle(state, sigs)),
          tables: [id],
        });
        return true;
      }
      const held = exitStates.get(id);
      if (!held) return false;
      const sender = rng.pick([relayer, stranger]);
      await step({
        label: 'G finalizeExit',
        dt: Math.max(1, deadline - time + rng.int(0, 3)),
        real: () => realTx(sender, 'finalizeExit', [held]),
        fake: () => fake.send(sender.address, 'finalizeExit', { state: held }),
        tables: [id],
      });
      return true;
    }

    // what startExitFromDeposits puts up, rebuilt from the seats like a coordinator would
    function depositStateOf(id, roster) {
      const t = live(id);
      return {
        tableId: id,
        nonce: t.nonce,
        isFinal: false,
        players: roster,
        balances: roster.map((p) => t.seats.get(p)?.deposit ?? 0n),
        keep: roster.map(() => false),
        rake: t.rakePaid,
        volume: 0n,
      };
    }

    async function guidedFilling(id, t) {
      if (t.seated < 2 || rng.chance(0.45)) {
        const i = rng.int(0, players.length - 1);
        const p = players[i];
        const held = t.seats.get(lower(p))?.deposit ?? 0n;
        const room = t.maxDeposit - held;
        const lo = held === 0n ? t.minDeposit : 1n;
        if (room < 1n || lo > room) return false;
        const amount = rng.big(lo, room < lo + 200_000n ? room : lo + 200_000n);
        await step({
          label: `G deposit ${short(p)} ${amount}`,
          real: () => realTx(p, 'deposit', [id, amount, sessions[i].address]),
          fake: () => fake.deposit(id, p.address, amount, sessions[i].address),
        });
        return true;
      }
      const seated = sortedAddresses([...t.seats.keys()]);
      const result = await step({
        label: `G start ${seated.length}`,
        real: () => realTx(arbiter, 'start', [id, seated]),
        fake: () => fake.send(arbiter.address, 'start', { tableKey: id, players: seated }),
        tables: [id],
      });
      if (result.ok) rosters.set(id, seated);
      return true;
    }

    // ---------------------------------------------------------------- random calls
    async function random(id, t, status) {
      const i = rng.int(0, players.length - 1);
      const player = players[i];
      const kind = rng.pick(
        {
          None: [
            'createTable',
            'createTable',
            'createTable',
            'deposit',
            'misc',
            'settle',
            'startExit',
            'withdraw',
          ],
          Filling: [
            'deposit',
            'deposit',
            'deposit',
            'deposit',
            'setSessionKey',
            'leave',
            'start',
            'start',
            'start',
            'createTable',
            'settle',
            'startExit',
            'misc',
          ],
          Active: [
            'startExit',
            'startExit',
            'settle',
            'settle',
            'settle',
            'startExitFromDeposits',
            'startExitFromDeposits',
            'deposit',
            'leave',
            'start',
            'challenge',
            'finalizeExit',
            'misc',
            'setSessionKey',
          ],
          Exiting: [
            'challenge',
            'challenge',
            'challenge',
            'finalizeExit',
            'finalizeExit',
            'finalizeExit',
            'settle',
            'settle',
            'startExit',
            'startExitFromDeposits',
            'misc',
          ],
          Closed: [
            'createTable',
            'deposit',
            'settle',
            'finalizeExit',
            'challenge',
            'misc',
            'withdraw',
          ],
        }[status],
      );

      if (kind === 'misc') return misc(id, player);
      if (kind === 'withdraw') {
        await step({
          label: `withdraw ${short(player)}`,
          real: () => realTx(player, 'withdraw', [player.address]),
          fake: () => fake.withdraw(player.address, player.address),
        });
      } else if (kind === 'createTable') {
        const sender = rng.chance(0.8) ? arbiter : rng.pick([stranger, relayer]);
        const args = [
          rng.chance(0.1) ? ZERO_HASH : id,
          rng.pick([2, 2, 3, 4, 6, 6, 10, 0, 1, 11]),
          rng.pick([1n, 100n, 1000n, 0n, 5000n]),
          rng.pick([10_000n, 50_000n, 1_000_000n, 500n]),
        ];
        await step({
          label: `createTable by ${short(sender)} ${args.slice(1).join('/')}`,
          real: () => realTx(sender, 'createTable', args),
          fake: () =>
            fake.send(sender.address, 'createTable', {
              tableKey: args[0],
              maxPlayers: args[1],
              minDeposit: args[2],
              maxDeposit: args[3],
            }),
          tables: [id, args[0]],
        });
      } else if (kind === 'deposit') {
        const amount = amountFor(t);
        const key = rng.chance(0.07)
          ? ZERO_ADDRESS
          : sessions[(i + rng.int(0, 1)) % sessions.length].address;
        await step({
          label: `deposit ${short(player)} ${amount}`,
          real: () => realTx(player, 'deposit', [id, amount, key]),
          fake: () => fake.deposit(id, player.address, amount, key),
        });
      } else if (kind === 'setSessionKey') {
        const key = rng.chance(0.1) ? ZERO_ADDRESS : rng.pick(sessions).address;
        await step({
          label: `setSessionKey ${short(player)}`,
          real: () => realTx(player, 'setSessionKey', [id, key]),
          fake: () => fake.setSessionKey(id, player.address, key),
        });
      } else if (kind === 'leave') {
        await step({
          label: `leave ${short(player)}`,
          real: () => realTx(player, 'leave', [id]),
          fake: () => fake.leave(id, player.address),
        });
      } else if (kind === 'start') {
        await randomStart(id, t);
      } else if (kind === 'startExitFromDeposits') {
        let roster = rosterOf(id);
        if (rng.chance(0.15)) roster = roster.slice(1);
        const sender = rng.chance(0.6) ? arbiter : rng.pick([...players, stranger, relayer]);
        const result = await step({
          label: `startExitFromDeposits by ${short(sender)}`,
          real: () => realTx(sender, 'startExitFromDeposits', [id, roster]),
          fake: () =>
            fake.send(sender.address, 'startExitFromDeposits', { tableKey: id, players: roster }),
          tables: [id],
        });
        if (result.ok) exitStates.set(id, depositStateOf(id, roster));
      } else if (kind === 'finalizeExit') {
        let state = exitStates.get(id) ?? nextState(id, rosterOf(id));
        if (rng.chance(0.2))
          state = { ...state, balances: state.balances.map((b, k) => (k === 0 ? b + 1n : b)) };
        if (rng.chance(0.05)) state = { ...state, keep: [...state.keep, true] };
        const sender = rng.pick([relayer, stranger, arbiter, player]);
        await step({
          label: `finalizeExit by ${short(sender)}`,
          dt: aimAtDeadline(t, 0.6),
          real: () => realTx(sender, 'finalizeExit', [state]),
          fake: () => fake.send(sender.address, 'finalizeExit', { state }),
          tables: [id, state.tableId],
        });
      } else {
        await randomStateCall(kind, id, t, player);
      }
      return true;
    }

    async function randomStart(id, t) {
      const seated = t ? [...t.seats.keys()] : [];
      let roster = sortedAddresses(
        seated.length >= 2 && rng.chance(0.75)
          ? seated
          : players.map(lower).slice(0, rng.int(0, 6)),
      );
      if (rng.chance(0.08)) roster = [...roster].reverse();
      if (rng.chance(0.05) && roster.length > 0) roster = [...roster, roster[0]];
      const sender = rng.chance(0.85) ? arbiter : rng.pick([stranger, relayer, rng.pick(players)]);
      const result = await step({
        label: `start ${roster.length}`,
        real: () => realTx(sender, 'start', [id, roster]),
        fake: () => fake.send(sender.address, 'start', { tableKey: id, players: roster }),
        tables: [id],
      });
      if (result.ok) rosters.set(id, roster);
    }

    // settle, startExit and challenge from a random sender with a state that is often faulty, or stale, or replayed
    async function randomStateCall(kind, id, t, player) {
      let state = nextState(id, rosterOf(id));
      if (rng.chance(0.08)) state.nonce = t?.nonce ?? 0n;
      if (kind === 'settle' && rng.chance(0.75)) state.isFinal = true;
      if (kind !== 'settle' && rng.chance(0.85)) state.isFinal = rng.chance(0.15);
      let faults = {};
      if (rng.chance(0.4)) ({ state, faults } = withFault(state, id));
      const pool = pools.get(id);
      if (pool.length > 0 && rng.chance(0.15)) state = rng.pick(pool);
      const sigs = await sign(
        id,
        state,
        state.players.length > 0 ? state.players : rosterOf(id),
        faults,
      );
      const sender =
        kind === 'startExit' && rng.chance(0.55)
          ? arbiter
          : rng.pick([relayer, stranger, arbiter, player]);
      const result = await step({
        label: `${kind} nonce ${state.nonce} final ${state.isFinal} by ${short(sender)} (${Object.keys(faults).join(',') || 'clean'})`,
        dt: aimAtDeadline(t),
        real: () => realTx(sender, kind, [state, sigs.arbiterSig, sigs.playerSigs]),
        fake: () => fake.send(sender.address, kind, { bundle: { state, ...sigs } }),
        tables: [id, state.tableId],
      });
      if (result.ok) {
        pool.push(state);
        if (kind !== 'settle') exitStates.set(id, state);
      }
    }

    // pause, the owner changing the arbiter, a blacklisted payee, time passing, tokens appearing
    async function misc(id, player) {
      const m = rng.int(0, 5);
      if (m === 0) {
        const paused = await vaultRead('paused');
        if (paused ? rng.chance(0.6) : !rng.chance(0.2)) return true; // paused only now and then, and not for long
        await step({
          label: paused ? 'unpause' : 'pause',
          dt: 1,
          real: () => realTx(owner, paused ? 'unpause' : 'pause', []),
          fake: () => {
            fake.pause(!paused);
            return { ok: true };
          },
          tables: [id],
        });
      } else if (m === 1) {
        const who = rng.pick([arbiter, relayer, stranger]);
        await step({
          label: `setArbiter ${short(who)}`,
          dt: 1,
          real: () => realTx(owner, 'setArbiter', [who.address]),
          fake: () => {
            fake.setVaultArbiter(who.address);
            return { ok: true };
          },
          tables: [id],
        });
      } else if (m === 2) {
        const blocked = rng.chance(0.6);
        await step({
          label: `blacklist ${short(player)} ${blocked}`,
          dt: 1,
          real: async () => {
            await tokenSend(deployer, 'setBlocked', [player.address, blocked]);
            return { ok: true, events: [] };
          },
          fake: () => {
            fake.blacklist(player.address, blocked);
            return { ok: true };
          },
          tables: [id],
        });
      } else if (m === 3) {
        const jump = rng.pick([1, 59, 3599, 3600, 3601, 7200, 100_000]);
        await step({
          label: `time +${jump}`,
          dt: jump,
          real: async () => ({ ok: true, events: [] }),
          fake: () => ({ ok: true }),
          tables: [id],
        });
      } else if (m === 4) {
        // MockToken refuses to mint to a blocked account
        const amount = (await tokenRead('blocked', [player.address]))
          ? 0n
          : rng.big(0n, 5_000_000n);
        await step({
          label: `mint ${amount} to ${short(player)}`,
          dt: 1,
          real: async () => {
            await tokenSend(deployer, 'mint', [player.address, amount]);
            return { ok: true, events: [] };
          },
          fake: () => {
            fake.mint(player.address, amount);
            return { ok: true };
          },
          tables: [id],
        });
      } else {
        const payee = rng.pick([player, stranger, relayer]);
        await step({
          label: `withdraw ${short(player)} to ${short(payee)}`,
          real: () => realTx(player, 'withdraw', [payee.address]),
          fake: () => fake.withdraw(player.address, payee.address),
        });
      }
      return true;
    }

    return {
      // Fixed cases at the edges the random programs rarely hit: table parameters, deposit limits, the roster,
      // the pause, and the exit window to the second (deadline - 1, deadline, deadline + 1).
      async edges() {
        const edge = (name) => keccak256(toHex(`parity:edge:${seed}:${name}`));
        // what the REAL contract said to the steps since `from` (the fake was just shown to say the same): the
        // edges must hit the cases they are named for, not merely agree
        const outcomesSince = (from) => log.slice(from).map((line) => /real=(\S+)/.exec(line)[1]);
        const create = (id, maxPlayers, minDeposit, maxDeposit, sender = arbiter) =>
          step({
            label: `edge createTable ${maxPlayers}/${minDeposit}/${maxDeposit}`,
            dt: 1,
            real: () => realTx(sender, 'createTable', [id, maxPlayers, minDeposit, maxDeposit]),
            fake: () =>
              fake.send(sender.address, 'createTable', {
                tableKey: id,
                maxPlayers,
                minDeposit,
                maxDeposit,
              }),
            tables: [id],
          });
        const deposit = (id, i, amount, key = sessions[i].address) =>
          step({
            label: `edge deposit ${short(players[i])} ${amount}`,
            dt: 1,
            real: () => realTx(players[i], 'deposit', [id, amount, key]),
            fake: () => fake.deposit(id, players[i].address, amount, key),
            tables: [id],
          });
        const start = (id, list, label) =>
          step({
            label: `edge start ${label}`,
            dt: 1,
            real: () => realTx(arbiter, 'start', [id, list]),
            fake: () => fake.send(arbiter.address, 'start', { tableKey: id, players: list }),
            tables: [id],
          }).then((result) => {
            if (result.ok) rosters.set(id, list);
            return result;
          });

        // table parameters, one at a time, then the order of the checks
        let n = 0;
        let from = log.length;
        for (const [maxPlayers, min, max] of [
          [0, 1n, 10n],
          [1, 1n, 10n],
          [2, 1n, 10n],
          [10, 1n, 10n],
          [11, 1n, 10n],
          [255, 1n, 10n],
          [6, 0n, 10n],
          [6, 10n, 9n],
          [6, 10n, 10n],
          [6, 1n, 2n ** 256n - 1n],
        ]) {
          await create(edge(`params-${n++}`), maxPlayers, min, max);
        }
        await create(ZERO_HASH, 6, 1n, 10n);
        const again = edge('again');
        await create(again, 6, 1n, 10n);
        await create(again, 0, 0n, 0n); // TableExists before BadTableParams
        await create(edge('stranger'), 6, 1n, 10n, stranger); // NotArbiter before everything else
        await create(edge('relayer'), 6, 1n, 10n, relayer);
        expect(outcomesSince(from)).toEqual([
          ...['BadTableParams', 'BadTableParams', 'ok', 'ok', 'BadTableParams', 'BadTableParams'],
          ...['BadTableParams', 'BadTableParams', 'ok', 'ok', 'BadTableParams'],
          ...['ok', 'TableExists', 'NotArbiter', 'NotArbiter'],
        ]);

        // deposit limits and the order of the deposit checks
        const limits = edge('limits');
        await create(limits, 3, 100n, 1000n);
        from = log.length;
        await deposit(limits, 0, 0n); // ZeroAmount
        await deposit(limits, 0, 99n); // below the minimum
        await deposit(limits, 0, 1001n); // above the maximum
        await deposit(limits, 0, 100n, ZERO_ADDRESS); // BadSessionKey, before the range
        await deposit(limits, 0, 100n); // exactly the minimum
        await deposit(limits, 0, 1n); // a top-up below the minimum is fine
        await deposit(limits, 0, 899n); // exactly the maximum
        await deposit(limits, 0, 1n); // one above
        await deposit(limits, 1, 500n);
        await deposit(limits, 2, 500n);
        await deposit(limits, 3, 99n); // the range before the seat limit
        await deposit(limits, 3, 100n); // TableFull
        await deposit(limits, 1, 1n, sessions[5].address); // a top-up on a full table, with a new key
        expect(outcomesSince(from)).toEqual([
          ...['ZeroAmount', 'DepositOutOfRange', 'DepositOutOfRange', 'BadSessionKey', 'ok', 'ok'],
          ...['ok', 'DepositOutOfRange', 'ok', 'ok', 'DepositOutOfRange', 'TableFull', 'ok'],
        ]);
        from = log.length;
        const seated = sortedAddresses([0, 1, 2].map((i) => lower(players[i])));
        await start(limits, [], 'none');
        await start(limits, seated.slice(0, 1), 'one');
        await start(limits, seated.slice(0, 2), 'two of three');
        await start(limits, [...seated].reverse(), 'unsorted');
        await start(limits, [seated[0], seated[0], seated[1]], 'duplicate');
        await start(limits, [...seated.slice(0, 2), lower(players[3])], 'a stranger');
        await start(limits, seated, 'exact');
        await deposit(limits, 0, 1n); // WrongStatus once started
        expect(outcomesSince(from)).toEqual([...Array(6).fill('BadRoster'), 'ok', 'WrongStatus']);

        // the smallest table that can start, and one seat too few
        const pair = edge('pair');
        from = log.length;
        await create(pair, 2, 1n, 10n);
        await deposit(pair, 0, 5n);
        await start(pair, sortedAddresses([lower(players[0])]), 'one seated');
        await deposit(pair, 1, 5n);
        await start(pair, sortedAddresses([0, 1].map((i) => lower(players[i]))), 'pair');
        expect(outcomesSince(from)).toEqual(['ok', 'ok', 'BadRoster', 'ok', 'ok']);

        // the pause stops new tables, deposits and starts, and nothing else
        const paused = edge('paused');
        from = log.length;
        await create(paused, 6, 1n, 10n);
        await deposit(paused, 0, 5n);
        await step({
          label: 'edge pause',
          dt: 1,
          real: () => realTx(owner, 'pause', []),
          fake: () => {
            fake.pause(true);
            return { ok: true };
          },
          tables: [paused],
        });
        await create(edge('while-paused'), 0, 0n, 0n, stranger); // the pause is checked first
        await deposit(paused, 1, 5n);
        await step({
          label: 'edge leave while paused',
          dt: 1,
          real: () => realTx(players[0], 'leave', [paused]),
          fake: () => fake.leave(paused, players[0].address),
          tables: [paused],
        });
        await step({
          label: 'edge unpause',
          dt: 1,
          real: () => realTx(owner, 'unpause', []),
          fake: () => {
            fake.pause(false);
            return { ok: true };
          },
          tables: [paused],
        });
        expect(outcomesSince(from)).toEqual([
          'ok',
          'ok',
          'ok',
          'EnforcedPause',
          'EnforcedPause',
          'ok',
          'ok',
        ]);

        // the exit window to the second
        const window = edge('window');
        await create(window, 6, 100n, 1_000_000n);
        for (const i of [0, 1, 2]) await deposit(window, i, 1000n + BigInt(i));
        const roster = sortedAddresses([0, 1, 2].map((i) => lower(players[i])));
        await start(window, roster, 'window');
        const stateAt = (id, nonce, isFinal = false) => {
          const t = live(id);
          const deposits = roster.map((p) => t.seats.get(p).deposit);
          const moved = BigInt(nonce) * 10n;
          return {
            tableId: id,
            nonce: BigInt(nonce),
            isFinal,
            players: roster,
            balances: [deposits[0] - moved, deposits[1] + moved, deposits[2]],
            keep: roster.map(() => false),
            rake: 0n,
            volume: 100n,
          };
        };
        const send = async (kind, sender, state, dt, label) => {
          const sigs = await sign(window, state, roster);
          return step({
            label: `edge ${label}`,
            dt,
            real: () => realTx(sender, kind, [state, sigs.arbiterSig, sigs.playerSigs]),
            fake: () => fake.send(sender.address, kind, { bundle: { state, ...sigs } }),
            tables: [window],
          });
        };
        const finalize = (state, dt, label) =>
          step({
            label: `edge ${label}`,
            dt,
            real: () => realTx(relayer, 'finalizeExit', [state]),
            fake: () => fake.send(relayer.address, 'finalizeExit', { state }),
            tables: [window],
          });
        const [s1, s2, s3] = [stateAt(window, 1), stateAt(window, 2), stateAt(window, 3)];
        from = log.length;
        await send('startExit', arbiter, s1, 1, 'startExit s1');
        const first = live(window).exitDeadline;
        await send('challenge', relayer, s2, first - time, 'challenge s2 AT the deadline'); // still open
        const second = live(window).exitDeadline;
        await finalize(s2, second - time, 'finalizeExit AT the deadline'); // ExitWindowOpen
        await send('challenge', relayer, s3, second + 1 - time, 'challenge one second after'); // closed
        await finalize(s1, 1, 'finalizeExit with the replaced state'); // DigestMismatch
        await finalize(s2, 1, 'finalizeExit after the window'); // pays
        expect(outcomesSince(from)).toEqual([
          ...['ok', 'ok', 'ExitWindowOpen', 'ExitWindowClosed', 'DigestMismatch', 'ok'],
        ]);

        // settle is still valid in Exiting long after the deadline, until somebody finalises
        const late = edge('late');
        await create(late, 6, 100n, 1_000_000n);
        for (const i of [0, 1, 2]) await deposit(late, i, 1000n + BigInt(i));
        await start(late, roster, 'late');
        const lateState = (nonce, isFinal) => stateAt(late, nonce, isFinal);
        const lateSend = async (kind, sender, state, dt, label) => {
          const sigs = await sign(late, state, roster);
          return step({
            label: `edge ${label}`,
            dt,
            real: () => realTx(sender, kind, [state, sigs.arbiterSig, sigs.playerSigs]),
            fake: () => fake.send(sender.address, kind, { bundle: { state, ...sigs } }),
            tables: [late],
          });
        };
        from = log.length;
        await step({
          label: 'edge startExitFromDeposits by a stranger',
          dt: 1,
          real: () => realTx(stranger, 'startExitFromDeposits', [late, roster]),
          fake: () =>
            fake.send(stranger.address, 'startExitFromDeposits', {
              tableKey: late,
              players: roster,
            }),
          tables: [late],
        });
        await lateSend('startExit', players[0], lateState(1, false), 1, 'startExit by a member');
        const lateFinal = lateState(2, true);
        lateFinal.keep = [true, false, true];
        await lateSend('settle', stranger, lateFinal, 30 * 3600, 'settle long after the deadline');
        await start(late, [roster[0], roster[2]], 'the stayers'); // keep is by roster position
        expect(outcomesSince(from)).toEqual(['NotMember', 'ok', 'ok', 'ok']);
      },

      async run() {
        for (let n = 0; n < STEPS; n++) {
          const id = rng.pick(tableIds);
          const t = live(id);
          const status = t?.status ?? 'None';
          if (rng.chance(GUIDED) && (await guided(id, t, status))) continue;
          await random(id, t, status);
        }
      },

      // so the next program starts from a world with no pause, no blacklist, no withdrawals owed and the
      // arbiter in place: the next fake is built from the real chain's books
      async cleanUp() {
        const pin = () => pinTime(time + 1);
        for (const p of players) {
          await pin();
          await tokenSend(deployer, 'setBlocked', [p.address, false]);
        }
        if (await vaultRead('paused')) {
          await pin();
          await realTx(owner, 'unpause', []);
        }
        await pin();
        await realTx(owner, 'setArbiter', [arbiter.address]);
        for (const p of players) {
          if ((await vaultRead('withdrawable', [p.address])) === 0n) continue;
          await pin();
          await realTx(p, 'withdraw', [p.address]);
        }
      },
    };
  }
}
