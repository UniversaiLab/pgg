// Property test: the JavaScript checkState / checkSettle / hashState accept and reject exactly what the real
// PokerVault accepts and rejects, with the same FIRST error (name and arguments).
//
// How: one anvil with the real contract and a table in every status (helpers.js). The chain is never
// changed inside the loop: every case is an eth_call (simulateContract) from an account the contract lets
// call it, so thousands of cases cost seconds. Cases are seeded valid States signed with the real session
// keys and arbiter, then faults applied one at a time, in every pair (one order), and several at once
// (gen-states.js).
// For each case the library's answer is compared with the contract's revert, decoded by viem.
//
// A counter records which errors were actually reached, and the last test fails if any error in the
// ERRORS catalogue never was, so this test cannot pass by never exercising a check.
//
//   PGG_EQUIV_SEED=<n>   different cases;   PGG_EQUIV_SCALE=<n>   n times as many random cases
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { checkSettle, checkState, ERRORS } from '../../src/check.js';
import { domainSeparator, hashState, STATE_TYPEHASH } from '../../src/eip712.js';
import { chainDescribe } from '../../testing/index.js';
import { makeRng, randomState, UINT256_MAX } from '../gen.js';
import {
  applyMutation,
  applySigFault,
  expectedFor,
  LATE,
  MUTATIONS,
  materialize,
  multiFault,
  newPlan,
  planLabel,
  SIG_FAULTS,
  validState,
} from './gen-states.js';
import { setupWorld } from './helpers.js';

const SEED = Number(process.env.PGG_EQUIV_SEED ?? 20260604);
const SCALE = Math.max(1, Number(process.env.PGG_EQUIV_SCALE ?? 1));
const CONCURRENCY = 32;
const SLOW = 180_000; // ms: a test here is thousands of RPC calls

/** Which (table, entry point) pairs a case may use. challenge needs an Exiting table, startExit an Active one. */
const COMBOS = [
  ['active3', 'startExit'],
  ['active2', 'startExit'],
  ['active10', 'startExit'],
  ['rolled', 'startExit'],
  ['exiting', 'challenge'],
  ['active3', 'settle'],
  ['active2', 'settle'],
  ['active10', 'settle'],
  ['rolled', 'settle'],
  ['exiting', 'settle'],
];
const allows = (mutation, entry) => !mutation.entries || mutation.entries.includes(entry);
const usableCombos = (mutation) => COMBOS.filter(([, entry]) => allows(mutation, entry));

const SIGNATURE_ERRORS = new Set([
  'BadSignature',
  'ECDSAInvalidSignature',
  'ECDSAInvalidSignatureLength',
  'ECDSAInvalidSignatureS',
]);
const WRONG_KEY = ['wrong.stranger', 'wrong.seat', 'wrong.arbiterKey', 'otherDigest'];

const show = (value) =>
  JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? `${v}n` : v), 2);

/** Run `fn` over `items`, `size` at a time, keeping the order of results. */
async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

const sameArgs = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Does the library's answer say what the contract's revert says? A revert with no data at all is the ABI
 * decoder refusing the calldata, which is the library's `Malformed` (it carries a reason, not arguments).
 */
function agree(js, chain) {
  if (chain === null) return js.ok === true;
  if (js.ok) return false;
  if (js.error === 'Malformed') return chain.error === 'EmptyRevert';
  return js.error === chain.error && sameArgs(js.args, chain.args);
}

chainDescribe('checkState / checkSettle / hashState against the real PokerVault', () => {
  let world;
  let startBlock;
  const tally = {
    cases: 0,
    accepted: 0,
    digests: 0,
    names: new Map(), // error name -> times the library and the contract agreed on it
    byEntry: new Map(), // `${entry}:${name}` -> times
    wrongStatus: new Set(), // statuses settle answered WrongStatus for
    badSignature: new Set(), // BadSignature indexes reached (2^256-1 is the arbiter)
  };

  beforeAll(async () => {
    world = await setupWorld();
    startBlock = await world.blockNumber();
  }, 120_000);
  afterAll(async () => {
    await world?.stop();
  });

  /**
   * Sign and run every case (a list of { label, table, entry, plan, expects? }) against the library and the
   * contract. Returns the problems: `diverged` (the library and the contract disagree), `unexpected`
   * (a single fault did not get the answer the generator promised, so the generator is wrong) and
   * `digest` (hashState differs from stateDigest).
   */
  async function run(cases, { mustAccept = false } = {}) {
    const problems = { diverged: [], unexpected: [], digest: [], accepted: 0 };

    async function compare(c, state, sigs) {
      const check = c.entry === 'settle' ? checkSettle : checkState;
      let js;
      try {
        js = check(state, sigs, c.table.ctx);
      } catch (error) {
        js = { ok: false, error: `threw ${error.message}`, args: [] };
      }
      const [chain, chainDigest] = await Promise.all([
        world.outcome(c.entry, state, sigs),
        world.read('stateDigest', [state]),
      ]);
      const label = `${c.label} ${planLabel(c.plan)}`;

      tally.cases++;
      tally.digests++;
      const mine = hashState(state, world.domain);
      if (mine !== chainDigest) {
        problems.diverged.push({ label, digest: { js: mine, chain: chainDigest } });
      }
      if (js.ok && js.digest !== chainDigest) {
        problems.digest.push({ label, js: js.digest, chain: chainDigest });
      }

      // without signatures (what the server runs before it proposes a state): the contract's answer up to the
      // signature checks. A signature error, or acceptance, means everything before them passed; settle's
      // BadKeep comes after the signatures, so it may show here while the contract stops at a bad signature.
      if (sigs.playerSigs.length === state.players.length) {
        const early = check(state, null, c.table.ctx);
        const signatureStage = chain === null || SIGNATURE_ERRORS.has(chain.error);
        let fine;
        if (!signatureStage) fine = agree(early, chain);
        else if (early.ok) fine = early.digest === chainDigest;
        else fine = chain !== null && c.entry === 'settle' && early.error === 'BadKeep';
        if (!fine) {
          problems.diverged.push({
            label,
            mode: 'without signatures',
            js: early.ok ? 'ok' : { error: early.error, args: early.args },
            chain: chain ?? 'ok',
          });
        }
      }

      if (!agree(js, chain)) {
        problems.diverged.push({
          label,
          js: js.ok ? 'ok' : { error: js.error, args: js.args },
          chain: chain ?? 'ok',
        });
        return;
      }
      const name = chain === null ? 'ok' : js.error === 'Malformed' ? 'Malformed' : chain.error;
      if (name === 'ok') {
        tally.accepted++;
        problems.accepted++;
      } else {
        tally.names.set(name, (tally.names.get(name) ?? 0) + 1);
      }
      const key = `${c.entry}:${name}`;
      tally.byEntry.set(key, (tally.byEntry.get(key) ?? 0) + 1);
      if (name === 'WrongStatus' && c.entry === 'settle') tally.wrongStatus.add(chain.args[0]);
      if (name === 'BadSignature') tally.badSignature.add(chain.args[0]);

      if (mustAccept && chain !== null) {
        problems.unexpected.push({ label, chain, why: 'must be accepted' });
      }
      if (c.expects && !c.expects.includes(name)) {
        problems.unexpected.push({ label, got: name, expected: c.expects });
      }
    }

    await pool(cases, CONCURRENCY, async (c) => {
      const built = await materialize(c.plan, {
        sign: (ref, hash) => world.signRef(c.table, ref, hash),
        domain: world.domain,
      });
      await compare(c, built.state, { arbiterSig: built.arbiterSig, playerSigs: built.playerSigs });
    });
    return problems;
  }

  const noProblems = (problems) => {
    expect(
      problems.diverged,
      `library and contract disagree:\n${show(problems.diverged.slice(0, 5))}`,
    ).toEqual([]);
    expect(problems.digest, `digest differs:\n${show(problems.digest.slice(0, 5))}`).toEqual([]);
    expect(
      problems.unexpected,
      `generator surprise:\n${show(problems.unexpected.slice(0, 5))}`,
    ).toEqual([]);
  };

  /** A valid base for a table and entry point. */
  const base = (rng, tableName, entry) => {
    const table = world.tables[tableName];
    return newPlan(table, entry, validState(rng, table, { final: entry === 'settle' }));
  };
  const caseOf = (label, plan) => ({ label, table: plan.table, entry: plan.entry, plan });

  // -------------------------------------------------------------------------------------------------------

  test(
    'the fixture tables are in the status they are named for, and the contract says so',
    async () => {
      const want = {
        active3: 2,
        active2: 2,
        active10: 2,
        rolled: 2,
        filling: 1,
        exiting: 3,
        closed: 4,
        none: 0,
      };
      for (const [name, status] of Object.entries(want)) {
        expect(world.tables[name].status, name).toBe(status);
      }
      expect(world.tables.rolled.ctx.table.nonce).toBe(7n);
      expect(world.tables.rolled.ctx.table.rakePaid).toBe(2_500_000n);
      expect(world.tables.exiting.ctx.table.nonce).toBe(3n);
      expect(Object.values(world.tables).map((t) => t.players.length)).toEqual([
        3, 2, 10, 4, 3, 3, 2, 3,
      ]);

      // startExit needs Active and challenge needs Exiting; checkState deliberately does not model that (it is
      // the entry point's job), so this is the contract alone, to prove the fixtures really are what they say
      const rng = makeRng(SEED);
      for (const [name, entry, status] of [
        ['filling', 'startExit', 1],
        ['exiting', 'startExit', 3],
        ['closed', 'startExit', 4],
        ['none', 'startExit', 0],
        ['active3', 'challenge', 2],
        ['filling', 'challenge', 1],
      ]) {
        const plan = base(rng, name, entry);
        const built = await materialize(plan, {
          sign: (ref, hash) => world.signRef(plan.table, ref, hash),
          domain: world.domain,
        });
        const chain = await world.outcome(entry, built.state, built);
        expect(chain, `${entry} on ${name}`).toEqual({ error: 'WrongStatus', args: [status] });
      }
    },
    SLOW,
  );

  test(
    'hashState, domainSeparator and the typehash equal the contract, for 400 random states',
    async () => {
      expect(domainSeparator(world.domain)).toBe(await world.read('domainSeparator'));
      expect(STATE_TYPEHASH).toBe(await world.read('STATE_TYPEHASH'));
      const rng = makeRng(SEED ^ 0xd16e57);
      const states = Array.from({ length: 400 * SCALE }, () => randomState(rng));
      // the edge values on top of the random ones
      states.push(
        { ...states[0], nonce: (1n << 64n) - 1n, rake: UINT256_MAX, volume: UINT256_MAX },
        { ...states[1], balances: states[1].balances.map(() => UINT256_MAX) },
        { ...states[2], nonce: 0n, isFinal: false, rake: 0n, volume: 0n },
      );
      const wrong = [];
      await pool(states, CONCURRENCY, async (state, i) => {
        const chain = await world.read('stateDigest', [state]);
        const mine = hashState(state, world.domain);
        if (mine !== chain) wrong.push({ i, mine, chain });
        tally.digests++;
      });
      expect(wrong, show(wrong.slice(0, 3))).toEqual([]);
    },
    SLOW,
  );

  test(
    'valid states: the contract accepts them and the library says ok with the contract digest',
    async () => {
      const rng = makeRng(SEED ^ 0x7a11d);
      const cases = [];
      for (const [tableName, entry] of COMBOS) {
        for (let i = 0; i < 40 * SCALE; i++) {
          cases.push(caseOf(`valid #${i}`, base(rng, tableName, entry)));
        }
      }
      const problems = await run(cases, { mustAccept: true });
      noProblems(problems);
      expect(problems.accepted).toBe(cases.length);
    },
    SLOW,
  );

  test(
    'one fault at a time: the same error, and the one the fault is meant to cause',
    async () => {
      const rng = makeRng(SEED ^ 0x51f9);
      const reps = 14 * SCALE;
      const cases = [];
      const applied = new Map();
      for (const mutation of MUTATIONS) {
        const usable = usableCombos(mutation);
        for (let rep = 0; rep < reps; rep++) {
          const [tableName, entry] = usable[rep % usable.length];
          for (let attempt = 0; attempt < 8; attempt++) {
            const plan = base(rng, tableName, entry);
            if (!applyMutation(plan, mutation, rng)) continue;
            applied.set(mutation.name, (applied.get(mutation.name) ?? 0) + 1);
            cases.push({
              ...caseOf(`${mutation.name} #${rep}`, plan),
              expects: expectedFor(mutation, plan),
            });
            break;
          }
        }
      }
      // a fault that never fit anywhere would test nothing
      for (const mutation of MUTATIONS) {
        expect(
          applied.get(mutation.name) ?? 0,
          `${mutation.name} was applied`,
        ).toBeGreaterThanOrEqual(3);
      }
      noProblems(await run(cases));
    },
    SLOW,
  );

  test(
    'every signature slot with every kind of signature fault',
    async () => {
      const rng = makeRng(SEED ^ 0x5197);
      const cases = [];
      const every = Object.keys(SIG_FAULTS);
      for (const [tableName, entry] of COMBOS) {
        const n = world.tables[tableName].players.length;
        for (const target of ['arbiter', ...Array.from({ length: n }, (_, i) => i)]) {
          // every kind in every slot, except on the 10-seat table (a recovery per slot makes it slow):
          // there the wrong-key faults hit every slot and a few random kinds are added to each
          const kinds =
            n > 5 ? [...WRONG_KEY, ...Array.from({ length: 4 }, () => rng.pick(every))] : every;
          for (const kind of kinds) {
            for (let rep = 0; rep < SCALE; rep++) {
              const plan = base(rng, tableName, entry);
              if (!applySigFault(plan, kind, target, rng)) continue;
              cases.push({
                ...caseOf(`${kind}@${target}`, plan),
                expects: SIG_FAULTS[kind].expects,
              });
            }
          }
        }
      }
      expect(cases.length).toBeGreaterThan(700);
      noProblems(await run(cases));
    },
    SLOW,
  );

  test(
    'two bad signatures: the arbiter first, then the lowest player index, whatever the kinds',
    async () => {
      const rng = makeRng(SEED ^ 0x2b4d);
      const kinds = Object.keys(SIG_FAULTS);
      const cases = [];
      for (let i = 0; i < 200 * SCALE; i++) {
        const [tableName, entry] = rng.pick(COMBOS);
        const plan = base(rng, tableName, entry);
        const slots = ['arbiter', ...plan.state.players.map((_, k) => k)];
        const first = rng.pick(slots);
        const second = rng.pick(slots.filter((s) => s !== first));
        applySigFault(plan, rng.pick(kinds), first, rng);
        applySigFault(plan, rng.pick(kinds), second, rng);
        cases.push(caseOf(`two signatures #${i}`, plan));
      }
      noProblems(await run(cases));
    },
    SLOW,
  );

  test(
    'every pair of faults: the first check that fails wins, as on chain',
    async () => {
      const rng = makeRng(SEED ^ 0xa1a1);
      const cases = [];
      let turn = 0;
      for (const [a, first] of MUTATIONS.entries()) {
        for (const second of MUTATIONS.slice(a)) {
          // the order of the checks does not depend on the table's size, and a 10-seat state is slow to check
          const usable = COMBOS.filter(
            ([name, entry]) => name !== 'active10' && allows(first, entry) && allows(second, entry),
          );
          if (usable.length === 0) continue; // e.g. a settle-only fault with a startExit-only one
          for (let rep = 0; rep < SCALE; rep++, turn++) {
            // some faults only fit one table (only `rolled` has rake paid), so try the tables in turn
            const tries = usable.length * 2;
            for (let k = 0; k < tries; k++) {
              const [tableName, entry] = usable[(turn + k) % usable.length];
              const plan = base(rng, tableName, entry);
              if (!applyMutation(plan, first, rng) || !applyMutation(plan, second, rng)) continue;
              cases.push(caseOf(`pair #${cases.length}`, plan));
              break;
            }
          }
        }
      }
      expect(cases.length).toBeGreaterThan(1500);
      noProblems(await run(cases));
    },
    SLOW,
  );

  test(
    'several faults at once, drawn at random, the later checks favoured',
    async () => {
      const rng = makeRng(SEED ^ 0xfa17);
      const cases = [];
      for (let i = 0; i < 600 * SCALE; i++) {
        const [tableName, entry] = rng.pick(COMBOS);
        const plan = base(rng, tableName, entry);
        multiFault(plan, rng, rng.bool(0.6) ? LATE : MUTATIONS, 2 + rng.int(3));
        cases.push(caseOf(`multi #${i}`, plan));
      }
      noProblems(await run(cases));
    },
    SLOW,
  );

  test(
    'settle on a table that is Filling, Closed or unknown: NotFinal first, then WrongStatus(status)',
    async () => {
      const rng = makeRng(SEED ^ 0x57a7);
      const cases = [];
      const settleFaults = MUTATIONS.filter((m) => !m.entries || m.entries.includes('settle'));
      for (const tableName of ['filling', 'closed', 'none']) {
        for (let i = 0; i < 40 * SCALE; i++) {
          const plan = base(rng, tableName, 'settle');
          const final = rng.bool(0.7);
          plan.state.isFinal = final;
          if (rng.bool(0.5)) multiFault(plan, rng, settleFaults, 1 + rng.int(2));
          plan.state.isFinal = final; // a fault may have flipped it; this test is about the first two checks
          const expects = final ? ['WrongStatus'] : ['NotFinal'];
          cases.push({ ...caseOf(`${tableName} #${i}`, plan), expects });
        }
      }
      noProblems(await run(cases));
      for (const status of [0, 1, 4]) {
        expect(tally.wrongStatus.has(status), `WrongStatus(${status}) reached through settle`).toBe(
          true,
        );
      }
    },
    SLOW,
  );

  test(
    'settle: BadKeep names the first kept seat with nothing left, and only when there is one',
    async () => {
      const rng = makeRng(SEED ^ 0x6ee9);
      const tables = ['active3', 'active2', 'active10', 'rolled', 'exiting'];
      const cases = [];
      for (let i = 0; i < 150 * SCALE; i++) {
        const plan = base(rng, rng.pick(tables), 'settle');
        const s = plan.state;
        // empty some seats into their neighbours (the sum is unchanged) and keep seats at random
        s.balances.forEach((balance, j) => {
          if (!rng.bool(0.4)) return;
          s.balances[(j + 1) % s.balances.length] += balance;
          s.balances[j] = 0n;
        });
        s.keep = s.keep.map(() => rng.bool(0.6));
        plan.faults.push('keep.random');
        const broken = s.keep.some((kept, j) => kept && s.balances[j] === 0n);
        cases.push({ ...caseOf(`keep #${i}`, plan), expects: broken ? ['BadKeep'] : ['ok'] });
      }
      noProblems(await run(cases));
    },
    SLOW,
  );

  test(
    'a state that cannot be ABI-encoded: Malformed here, a revert with no data on chain',
    async () => {
      // The ABI decoder validates a value when the contract reads it, so each bad word below is only
      // reached once everything the contract reads before it is fine; the rest of the state is valid.
      const word = (n) => n.toString(16).padStart(64, '0');
      const tupleStart = (data) => 10 + 2 * Number.parseInt(data.slice(10, 74), 16);
      const setWord = (data, at, value) => data.slice(0, at) + word(value) + data.slice(at + 64);
      const arrayStart = (data, field) => {
        const start = tupleStart(data);
        return (
          start + 2 * Number.parseInt(data.slice(start + 64 * field, start + 64 * field + 64), 16)
        );
      };
      const dirty = `0x${'ff'.repeat(12)}`;
      const cases = [
        {
          name: 'nonce 2^64',
          state: (s) => ({ ...s, nonce: 1n << 64n }),
          patch: (d) => setWord(d, tupleStart(d) + 64, 1n << 64n),
        },
        {
          name: 'nonce 2^64 + 99',
          state: (s) => ({ ...s, nonce: (1n << 64n) + 99n }),
          patch: (d) => setWord(d, tupleStart(d) + 64, (1n << 64n) + 99n),
        },
        {
          name: 'nonce 2^256-1',
          state: (s) => ({ ...s, nonce: UINT256_MAX }),
          patch: (d) => setWord(d, tupleStart(d) + 64, UINT256_MAX),
        },
        {
          name: 'isFinal is 2',
          state: (s) => ({ ...s, isFinal: 2 }),
          patch: (d) => setWord(d, tupleStart(d) + 128, 2n),
        },
        {
          name: 'a keep flag is 2',
          state: (s) => ({ ...s, keep: s.keep.map((k, i) => (i === 1 ? 2 : k)) }),
          patch: (d) => setWord(d, arrayStart(d, 5) + 64 * 2, 2n),
        },
        {
          name: 'an address with bits above 160',
          state: (s) => ({
            ...s,
            players: s.players.map((p, i) => (i === 0 ? dirty + p.slice(2) : p)),
          }),
          patch: (d) => {
            const at = arrayStart(d, 3) + 64;
            return d.slice(0, at) + 'ff'.repeat(12) + d.slice(at + 24);
          },
        },
      ];
      const rng = makeRng(SEED ^ 0xba5e);
      let compared = 0;
      for (const m of cases) {
        for (const [tableName, entry] of COMBOS) {
          const plan = base(rng, tableName, entry);
          const built = await materialize(plan, {
            sign: (ref, hash) => world.signRef(plan.table, ref, hash),
            domain: world.domain,
          });
          const sigs = { arbiterSig: built.arbiterSig, playerSigs: built.playerSigs };
          const bad = m.state(built.state);
          const check = entry === 'settle' ? checkSettle : checkState;
          const js = check(bad, sigs, plan.table.ctx);
          const chain = await world.rawOutcome(entry, built.state, sigs, m.patch);
          const label = `${m.name} on ${tableName}/${entry}`;
          expect(js, label).toMatchObject({ ok: false, error: 'Malformed' });
          expect(chain, label).toEqual({ error: 'EmptyRevert', args: [] });
          tally.cases++;
          tally.names.set('Malformed', (tally.names.get('Malformed') ?? 0) + 1);
          compared++;
        }
      }
      expect(compared).toBe(cases.length * COMBOS.length);
    },
    SLOW,
  );

  test('every error in the ERRORS catalogue was reached, and the chain was never changed', async () => {
    const missing = Object.keys(ERRORS).filter((name) => !tally.names.has(name));
    expect(missing, `never exercised: ${missing}; saw ${[...tally.names.keys()]}`).toEqual([]);
    for (const name of ['NotFinal', 'WrongStatus', 'BadKeep']) {
      expect(tally.byEntry.get(`settle:${name}`) ?? 0, `settle:${name}`).toBeGreaterThan(0);
    }
    // the arbiter, and every player slot of the largest table
    expect(tally.badSignature.has(UINT256_MAX), 'BadSignature(arbiter)').toBe(true);
    for (let i = 0; i < 10; i++)
      expect(tally.badSignature.has(BigInt(i)), `BadSignature(${i})`).toBe(true);
    expect(tally.cases).toBeGreaterThanOrEqual(1500);
    expect(tally.accepted).toBeGreaterThan(500);

    // no transaction was sent after set-up, so every case saw the same chain
    expect(await world.blockNumber()).toBe(startBlock);
    for (const table of Object.values(world.tables)) {
      expect(await world.rowOf(table), table.name).toEqual(table.ctx.table);
    }

    const rows = [...tally.names].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name}=${n}`);
    console.log(
      `[equivalence] ${tally.cases} cases against the contract (${tally.accepted} accepted, ${tally.digests} digests compared), seed ${SEED}\n` +
        `[equivalence] ${rows.join(' ')}`,
    );
  });
});
