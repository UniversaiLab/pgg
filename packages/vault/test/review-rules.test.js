// Adversarial review of rules.js: what a hostile server can get out of an honest client (C1a-C1e, C2), the
// durable nonce record (decideSign), the deal gate (S1) and the co-sign age rule (S3).
//
// Each hostile request names the rule that must catch it. A decision the review took on a design question
// (for example "other players' balances moved but mine did not") says so in the test title and is justified
// against docs/trust-model.md in the comment above it.
//
// Titles starting with "REVIEW BUG" fail on purpose today (see the report); `test.todo` bodies are design gaps
// written as executable specs: run them with `bun test --todo` to see what they would assert.
import { describe, expect, test } from 'bun:test';
import { buildNextState, genesisState } from '../src/build.js';
import { makeBundle, verifyBundle } from '../src/bundle.js';
import { hashState } from '../src/eip712.js';
import {
  canDeal,
  clientShouldSign,
  dealBlocker,
  decideSign,
  serverMayCoSign,
} from '../src/rules.js';
import { privateKeyToAddress, signDigest } from '../src/sign.js';
import { makeWorld, UNIT } from './fixtures.js';
import { makeRng, UINT64_MAX, UINT256_MAX } from './gen.js';

const w = makeWorld({ seed: 4242 });
const ME = 1;
const base = w.genesis; // nonce 0
const seen = { deltas: [98, -100, 0], rake: 2, pot: 200 }; // seat 0 beats me (seat 1) for 100, 2 chips rake
const HAND = { winner: 0, loser: 1, amount: 100n * UNIT, rake: 2n * UNIT, pot: 200n * UNIT };
const hand = w.nextHand(base, HAND); // nonce 1
const digestOf = (state, domain = w.domain) => hashState(state, domain);
const record = (state, isFinal = false) => ({
  nonce: state.nonce,
  digest: digestOf(state),
  isFinal,
});
const view = (over = {}) => ({
  me: w.players[ME],
  domain: w.domain,
  tableId: w.tableId,
  roster: w.players,
  unit: UNIT,
  maxRakeBps: 500,
  baseline: base,
  last: null,
  intent: 'play',
  observed: seen,
  ...over,
});
const req = (state, over = {}) => ({ state, domain: w.domain, digest: digestOf(state), ...over });
const verdict = (state, v = {}, r = {}) => clientShouldSign(req(state, r), view(v));
const refusedBy = (rule) => expect.objectContaining({ ok: false, rule });
const withBalances = (state, balances) => ({ ...state, balances });
const shift = (state, from, to, amount) =>
  withBalances(
    state,
    state.balances.map((b, i) => (i === from ? b - amount : i === to ? b + amount : b)),
  );

describe('control: the honest request is signed', () => {
  test('so every refusal below is the hostile part and nothing else', () => {
    expect(verdict(hand)).toEqual({ ok: true });
  });
});

describe('a lower nonce, a same nonce, a replay', () => {
  const s2 = w.nextHand(hand, {
    winner: 2,
    loser: 0,
    amount: 10n * UNIT,
    rake: 0n,
    pot: 20n * UNIT,
  });
  const afterHand2 = { deltas: [-10, 0, 10], rake: 0, pot: 20 };

  test('C1a: the nonce I already signed, with different content', () => {
    const twin = w.nextHand(base, { ...HAND, winner: 2 }); // nonce 1, but seat 2 wins
    const r = verdict(twin, {
      last: record(hand),
      observed: { deltas: [0, -100, 98], rake: 2, pot: 200 },
    });
    expect(r).toEqual(refusedBy('C1a'));
    expect(r.detail).toMatch(/already signed/);
  });

  test('C1a: a nonce below the last one I signed, even with perfect content', () => {
    const r = verdict(hand, { baseline: base, last: record(s2), observed: seen });
    expect(r).toEqual(refusedBy('C1a'));
  });

  test('C1a: a nonce at or below the baseline, with no signing record at all', () => {
    expect(verdict(hand, { baseline: hand, observed: null })).toEqual(refusedBy('C1a'));
    expect(verdict({ ...base, nonce: 0n }, { baseline: base, observed: null })).toEqual(
      refusedBy('C1a'),
    );
    expect(verdict({ ...base, nonce: 0n }, { baseline: hand, observed: null })).toEqual(
      refusedBy('C1a'),
    );
  });

  test('a replay of the request I already signed gets the same yes, so the same signature can be resent', () => {
    expect(verdict(hand, { last: record(hand) })).toEqual({ ok: true });
    // the replay is answered even when everything I know has moved on
    expect(verdict(hand, { last: record(hand), baseline: hand, observed: null })).toEqual({
      ok: true,
    });
  });

  test('a replay of an OLDER request than the last one I signed is refused', () => {
    expect(verdict(hand, { last: record(s2), baseline: hand, observed: afterHand2 })).toEqual(
      refusedBy('C1a'),
    );
  });

  test('a replay from another table or epoch is caught by the pinned table id', () => {
    const elsewhere = { ...hand, tableId: `0x${'cd'.repeat(32)}` };
    expect(verdict(elsewhere)).toEqual(refusedBy('C1d'));
  });

  test('decideSign: every cell of (nonce below / equal / above) x (same / other digest) x (final or not)', () => {
    const d1 = `0x${'01'.repeat(32)}`;
    const d2 = `0x${'02'.repeat(32)}`;
    const cell = (nonce, digest, isFinal) =>
      decideSign({ req: { nonce, digest }, last: { nonce: 5n, digest: d1, isFinal } });
    for (const isFinal of [false, true]) {
      expect(cell(4n, d1, isFinal)).toBe('refuse-lower');
      expect(cell(4n, d2, isFinal)).toBe('refuse-lower');
      expect(cell(0n, d1, isFinal)).toBe('refuse-lower');
      expect(cell(5n, d1, isFinal)).toBe('repeat');
      expect(cell(5n, d2, isFinal)).toBe('refuse-equivocation');
    }
    expect(cell(6n, d1, false)).toBe('new');
    expect(cell(6n, d2, false)).toBe('new');
    expect(cell(6n, d2, true)).toBe('refuse-after-final');
    expect(cell(UINT64_MAX, d2, true)).toBe('refuse-after-final');
    expect(decideSign({ req: { nonce: 0n, digest: d1 }, last: null })).toBe('new');
    expect(decideSign({ req: { nonce: 0n, digest: d1 }, last: undefined })).toBe('new');
  });

  test('decideSign: digests compare without regard to case; numbers and bigints are the same nonce', () => {
    const d = `0x${'ab'.repeat(32)}`;
    expect(
      decideSign({
        req: { nonce: 5, digest: d.toUpperCase().replace('0X', '0x') },
        last: { nonce: 5n, digest: d, isFinal: false },
      }),
    ).toBe('repeat');
  });

  test('decideSign: a malformed argument throws instead of guessing a decision', () => {
    const d = `0x${'ab'.repeat(32)}`;
    for (const bad of [
      { req: { nonce: -1n, digest: d }, last: null },
      { req: { nonce: 1.5, digest: d }, last: null },
      { req: { nonce: '1', digest: d }, last: null },
      { req: { nonce: 1n, digest: '0x12' }, last: null },
      { req: { nonce: 1n, digest: d }, last: { nonce: 1n, digest: 'nope', isFinal: false } },
      { req: { nonce: 1n, digest: d }, last: { nonce: -1n, digest: d, isFinal: false } },
      { req: null, last: null },
      { req: undefined, last: null },
    ]) {
      expect(() => decideSign(bad)).toThrow(TypeError);
    }
  });

  test('decideSign: a truthy-but-not-true isFinal in the record still blocks (fail closed)', () => {
    const d1 = `0x${'01'.repeat(32)}`;
    const d2 = `0x${'02'.repeat(32)}`;
    for (const isFinal of [true, 1, 'false', 'yes', {}, []]) {
      expect(
        decideSign({ req: { nonce: 6n, digest: d2 }, last: { nonce: 5n, digest: d1, isFinal } }),
      ).toBe('refuse-after-final');
    }
  });
});

describe('a state after a final, and a final that is not mine to sign (C2)', () => {
  const final = buildNextState({
    prev: base,
    balances: base.balances,
    final: true,
    keep: [true, true, true],
  });
  const beyond = buildNextState({ prev: final, balances: base.balances });

  test('anything above a final I signed is refused as C2, however innocent it looks', () => {
    expect(
      verdict(beyond, { last: record(final, true), observed: null, intent: 'rotate' }),
    ).toEqual(refusedBy('C2'));
    expect(verdict(beyond, { last: record(final, true), observed: null, intent: 'play' })).toEqual(
      refusedBy('C2'),
    );
    expect(
      verdict({ ...beyond, nonce: UINT64_MAX }, { last: record(final, true), observed: null }),
    ).toEqual(refusedBy('C2'));
  });

  test('a different state at the final’s own nonce is an equivocation (C1a), the final itself is a repeat', () => {
    const rival = buildNextState({
      prev: base,
      balances: base.balances,
      final: true,
      keep: [false, false, false],
    });
    expect(rival.nonce).toBe(final.nonce);
    expect(verdict(rival, { last: record(final, true), observed: null, intent: 'rotate' })).toEqual(
      refusedBy('C1a'),
    );
    expect(verdict(final, { last: record(final, true), observed: null, intent: 'rotate' })).toEqual(
      { ok: true },
    );
  });

  test('a final state with intent "play" is refused; so is one that keeps my chips when I am leaving', () => {
    expect(verdict(final, { observed: null, intent: 'play' })).toEqual(refusedBy('C2'));
    expect(verdict(final, { observed: null, intent: 'leave' })).toEqual(refusedBy('C2')); // keep[me] is true
    const leaves = buildNextState({
      prev: base,
      balances: base.balances,
      final: true,
      keep: [true, false, true],
    });
    expect(verdict(leaves, { observed: null, intent: 'leave' })).toEqual({ ok: true });
  });

  test('a final state that keeps a seat with nothing left is refused here, because settle would revert (BadKeep)', () => {
    const drained = genesisState({
      tableId: w.tableId,
      players: w.players,
      deposits: [base.balances[0] + base.balances[2], base.balances[1], 0n],
    });
    const keepsEmpty = buildNextState({
      prev: drained,
      balances: drained.balances,
      final: true,
      keep: [true, true, true],
    });
    const r = verdict(keepsEmpty, { baseline: drained, observed: null, intent: 'rotate' });
    expect(r).toEqual(refusedBy('C2'));
    expect(r.detail).toMatch(/BadKeep/);
    const releasesEmpty = buildNextState({
      prev: drained,
      balances: drained.balances,
      final: true,
      keep: [true, true, false],
    });
    expect(verdict(releasesEmpty, { baseline: drained, observed: null, intent: 'rotate' })).toEqual(
      { ok: true },
    );
  });

  test('a final state carrying a hand’s result is fine for a leaver, and the hand is still checked', () => {
    const finalHand = buildNextState({
      prev: base,
      balances: hand.balances,
      rakeDelta: 2n * UNIT,
      volumeDelta: 200n * UNIT,
      final: true,
      keep: [true, false, true],
    });
    expect(verdict(finalHand, { intent: 'leave' })).toEqual({ ok: true });
    const stolen = {
      ...finalHand,
      balances: finalHand.balances.map((b, i) => (i === ME ? b - UNIT : i === 0 ? b + UNIT : b)),
    };
    expect(verdict(stolen, { intent: 'leave' })).toEqual(refusedBy('C1b'));
  });

  test('a final state from a previous epoch must not be left in the record: the new epoch seeds it as not final', () => {
    // README: "On a new epoch store { nonce: settledNonce, digest, isFinal: false }"
    expect(verdict(hand, { last: { nonce: 0n, digest: digestOf(base), isFinal: false } })).toEqual({
      ok: true,
    });
    expect(verdict(hand, { last: { nonce: 0n, digest: digestOf(base), isFinal: true } })).toEqual(
      refusedBy('C2'),
    );
  });
});

describe('who gets paid: the balances of the seats (C1b, C1c)', () => {
  // DECISION. trust-model.md rule 1 says "your balance equal to what you saw at the table, and the totals
  // conserved". The library goes further and checks EVERY seat against what the client saw. The review keeps
  // that: a state that moves chips between two OTHER seats cannot hurt this client (its own balance and the
  // total are pinned), but it is the clearest symptom of a server bug or a collusion, and every phone sees
  // all stacks at a poker table, so a refusal costs a stall only when the client missed a hand. The price is
  // liveness, never money: the stall exit pays out the last all-signed state.
  test('chips moved between two other seats, mine untouched: refused (C1b), naming a seat that is not mine', () => {
    const r = verdict(shift(hand, 0, 2, 5n * UNIT));
    expect(r).toEqual(refusedBy('C1b'));
    expect(r.detail).toMatch(/player 0/);
    expect(r.detail).not.toMatch(/player 1/);
  });

  test('my balance one chip too low or one token unit too low, the difference going to someone else', () => {
    expect(verdict(shift(hand, ME, 2, UNIT))).toEqual(refusedBy('C1b'));
    expect(verdict(shift(hand, ME, 2, 1n))).toEqual(refusedBy('C1b'));
    expect(verdict(shift(hand, 2, ME, 1n))).toEqual(refusedBy('C1b')); // too high is not fine either
  });

  test('money created or destroyed is caught by the coarse check first (C1c), whoever gets it', () => {
    const minted = withBalances(
      hand,
      hand.balances.map((b, i) => (i === 2 ? b + 1n : b)),
    );
    expect(verdict(minted)).toEqual(refusedBy('C1c'));
    const burned = withBalances(
      hand,
      hand.balances.map((b, i) => (i === 2 ? b - 1n : b)),
    );
    expect(verdict(burned)).toEqual(refusedBy('C1c'));
    // a little of it into the house: the rake grows by exactly what the seat loses, still wrong against the hand
    const toHouse = {
      ...hand,
      balances: hand.balances.map((b, i) => (i === 0 ? b - UNIT : b)),
      rake: hand.rake + UNIT,
    };
    expect(verdict(toHouse)).toEqual(refusedBy('C1b'));
  });

  test('a hand the client did not see: observed says nothing happened, the state says something did', () => {
    expect(verdict(hand, { observed: null })).toEqual(refusedBy('C1b'));
    expect(verdict(hand, { observed: { deltas: [0, 0, 0], rake: 0, pot: 0 } })).toEqual(
      refusedBy('C1b'),
    );
  });

  test('rake and volume must match the hand, whichever way they are off', () => {
    const rakeUp = {
      ...shift(hand, 0, 0, 0n),
      balances: hand.balances.map((b, i) => (i === 0 ? b - UNIT : b)),
      rake: hand.rake + UNIT,
    };
    const rakeDown = {
      ...hand,
      balances: hand.balances.map((b, i) => (i === 0 ? b + UNIT : b)),
      rake: hand.rake - UNIT,
    };
    expect(verdict(rakeUp)).toEqual(refusedBy('C1b'));
    expect(verdict(rakeDown)).toEqual(refusedBy('C1b'));
    expect(verdict({ ...hand, volume: hand.volume + UNIT })).toEqual(refusedBy('C1b'));
    expect(verdict({ ...hand, volume: hand.volume - UNIT })).toEqual(refusedBy('C1b'));
    expect(verdict({ ...hand, volume: hand.volume + 1n })).toEqual(refusedBy('C1b'));
  });

  test('an observed rake that disagrees with the observed deltas is refused on its own (the rake check is not redundant)', () => {
    // balances and conservation alone cannot tell: this state matches the deltas and the total exactly
    const r = verdict(hand, { observed: { deltas: [98, -100, 0], rake: 3, pot: 200 } });
    expect(r).toEqual(refusedBy('C1b'));
    expect(r.detail).toMatch(/rake/);
  });

  test('C1e: rake that went down, and rake above the vault’s cap', () => {
    const richBase = {
      ...base,
      rake: 10n * UNIT,
      volume: 1000n * UNIT,
      balances: base.balances.map((b, i) => (i === 0 ? b - 10n * UNIT : b)),
    };
    const down = {
      ...richBase,
      nonce: 1n,
      rake: 9n * UNIT,
      balances: richBase.balances.map((b, i) => (i === 0 ? b + UNIT : b)),
    };
    expect(
      verdict(down, { baseline: richBase, observed: { deltas: [1, 0, 0], rake: -1, pot: 0 } }),
    ).toEqual(refusedBy('C1e'));
    // 6% of volume with a 5% cap: the hand is 100 chips of pot, 6 of rake
    const greedy = w.nextHand(base, {
      winner: 0,
      loser: 1,
      amount: 50n * UNIT,
      rake: 6n * UNIT,
      pot: 100n * UNIT,
    });
    const r = verdict(greedy, { observed: { deltas: [44, -50, 0], rake: 6, pot: 100 } });
    expect(r).toEqual(refusedBy('C1e'));
    // exactly at the cap is fine
    const atCap = w.nextHand(base, {
      winner: 0,
      loser: 1,
      amount: 50n * UNIT,
      rake: 5n * UNIT,
      pot: 100n * UNIT,
    });
    expect(verdict(atCap, { observed: { deltas: [45, -50, 0], rake: 5, pot: 100 } })).toEqual({
      ok: true,
    });
  });
});

describe('the table, the roster and the domain are the pinned ones (C1d)', () => {
  test('another table id', () => {
    expect(verdict({ ...hand, tableId: `0x${'ee'.repeat(32)}` })).toEqual(refusedBy('C1d'));
  });

  test('a roster that drops, adds, swaps or reorders a seat', () => {
    const [a, b, c] = w.players;
    const extra = `0x${'f'.repeat(40)}`;
    const cases = {
      'drops the last seat': {
        players: [a, b],
        balances: hand.balances.slice(0, 2),
        keep: [false, false],
      },
      'drops me': {
        players: [a, c],
        balances: [hand.balances[0], hand.balances[2]],
        keep: [false, false],
      },
      'adds a seat': {
        players: [...w.players, extra],
        balances: [...hand.balances, 0n],
        keep: [false, false, false, false],
      },
      'swaps one seat for a stranger': { players: [a, b, extra] },
    };
    for (const [name, patch] of Object.entries(cases)) {
      expect(verdict({ ...hand, ...patch }), name).toEqual(refusedBy('C1d'));
    }
    // out of order is not even a State
    expect(verdict({ ...hand, players: [b, a, c] })).toEqual(refusedBy('MALFORMED'));
  });

  test('another chain id, another vault, in the request or only in the digest the server computed', () => {
    const otherChain = { chainId: 1, verifyingContract: w.domain.verifyingContract };
    const otherVault = { chainId: w.domain.chainId, verifyingContract: `0x${'1'.repeat(40)}` };
    for (const d of [otherChain, otherVault]) {
      expect(verdict(hand, {}, { domain: d, digest: digestOf(hand, d) })).toEqual(refusedBy('C1d')); // all of it consistent, but not mine
      expect(verdict(hand, {}, { domain: w.domain, digest: digestOf(hand, d) })).toEqual(
        refusedBy('C1d'),
      ); // honest domain, wrong digest
      expect(verdict(hand, {}, { domain: undefined, digest: digestOf(hand, d) })).toEqual(
        refusedBy('C1d'),
      ); // no domain, wrong digest
    }
    expect(verdict(hand, {}, { domain: null })).toEqual(refusedBy('C1d'));
    expect(
      verdict(
        hand,
        {},
        { domain: { chainId: '31337', verifyingContract: w.domain.verifyingContract } },
      ),
    ).toEqual(refusedBy('C1d'));
    expect(verdict(hand, {}, { digest: null })).toEqual(refusedBy('C1d'));
    expect(verdict(hand, {}, { digest: 12345 })).toEqual(refusedBy('C1d'));
    expect(verdict(hand, {}, { digest: `0x${'00'.repeat(32)}` })).toEqual(refusedBy('C1d'));
  });

  test('the vault address in another case is the same vault', () => {
    const shouting = {
      chainId: w.domain.chainId,
      verifyingContract: w.domain.verifyingContract.toUpperCase().replace('0X', '0x'),
    };
    expect(verdict(hand, {}, { domain: shouting })).toEqual({ ok: true });
    expect(verdict(hand, {}, { digest: digestOf(hand).toUpperCase().replace('0X', '0x') })).toEqual(
      { ok: true },
    );
  });

  test('the client signs the digest it computed itself, which differs from the request’s only if the server lied', () => {
    // with no `digest` in the request nothing can be compared, and the answer is still about the pinned domain
    expect(clientShouldSign({ state: hand }, view())).toEqual({ ok: true });
    const wrongDomainView = view({
      domain: { chainId: 1, verifyingContract: w.domain.verifyingContract },
    });
    // a client pinned to another chain computes another digest, so the server’s digest no longer matches
    expect(clientShouldSign(req(hand), wrongDomainView)).toEqual(refusedBy('C1d'));
  });
});

describe('requests that are not States, and views that are not usable', () => {
  test('the wire form, a partial state, and values of the wrong type are MALFORMED', () => {
    const raw = (state) => clientShouldSign({ state, domain: w.domain }, view());
    expect(raw({ ...hand, nonce: '1' })).toEqual(refusedBy('MALFORMED'));
    expect(raw({ ...hand, balances: hand.balances.map(String) })).toEqual(refusedBy('MALFORMED'));
    expect(raw({ ...hand, isFinal: 'false' })).toEqual(refusedBy('MALFORMED'));
    expect(raw({ ...hand, keep: [0, 0, 0] })).toEqual(refusedBy('MALFORMED'));
    expect(raw({ ...hand, players: undefined })).toEqual(refusedBy('MALFORMED'));
    expect(raw({ ...hand, nonce: UINT64_MAX + 1n })).toEqual(refusedBy('MALFORMED'));
    expect(raw({ ...hand, rake: UINT256_MAX + 1n })).toEqual(refusedBy('MALFORMED'));
    expect(raw(undefined)).toEqual(refusedBy('MALFORMED'));
    expect(clientShouldSign({}, view())).toEqual(refusedBy('MALFORMED'));
    expect(clientShouldSign(null, view())).toEqual(refusedBy('MALFORMED'));
    expect(clientShouldSign(undefined, view())).toEqual(refusedBy('MALFORMED'));
  });

  test('a broken view is VIEW, which is a refusal (fail closed), for every field', () => {
    const broken = {
      'no view': undefined,
      'me not on the roster': view({ me: `0x${'9'.repeat(40)}` }),
      'me malformed': view({ me: 'bob' }),
      'roster missing': view({ roster: undefined }),
      'roster shorter than the baseline': view({ roster: w.players.slice(0, 2) }),
      'baseline for another table': view({
        baseline: { ...base, tableId: `0x${'ab'.repeat(32)}` },
      }),
      'baseline not a state': view({ baseline: { nonce: 0n } }),
      'tableId malformed': view({ tableId: '0x12' }),
      'domain malformed': view({
        domain: { chainId: 0, verifyingContract: w.domain.verifyingContract },
      }),
      'unit zero': view({ unit: 0n }),
      'unit a number': view({ unit: 10000 }),
      'maxRakeBps fractional': view({ maxRakeBps: 2.5 }),
      'maxRakeBps negative': view({ maxRakeBps: -1 }),
      'maxRakeBps above 100%': view({ maxRakeBps: 10_001 }),
      'unknown intent': view({ intent: 'dance' }),
      'no intent': view({ intent: undefined }),
      'last malformed digest': view({ last: { nonce: 1n, digest: '0x12', isFinal: false } }),
      'last negative nonce': view({ last: { nonce: -1n, digest: digestOf(hand), isFinal: false } }),
      'deltas too short': view({ observed: { deltas: [1, 2], rake: 0, pot: 0 } }),
      'deltas fractional': view({ observed: { deltas: [1.5, 0, 0], rake: 0, pot: 0 } }),
      'deltas strings': view({ observed: { deltas: ['98', '-100', '0'], rake: 2, pot: 200 } }),
      'rake missing': view({ observed: { deltas: [98, -100, 0], pot: 200 } }),
      'pot missing': view({ observed: { deltas: [98, -100, 0], rake: 2 } }),
    };
    for (const [name, v] of Object.entries(broken)) {
      const r = clientShouldSign(req(hand), v);
      expect(r, name).toEqual(refusedBy('VIEW'));
    }
  });

  test('nothing the caller passes can make clientShouldSign throw: 3000 junk requests and views', () => {
    const rng = makeRng(1234);
    const junk = () =>
      rng.pick([
        undefined,
        null,
        0,
        1,
        -1,
        1.5,
        Number.NaN,
        Infinity,
        '',
        'x',
        `0x${'a'.repeat(64)}`,
        true,
        false,
        [],
        [1, 2, 3],
        {},
        { nonce: 1n },
        1n,
        -1n,
        2n ** 300n,
        Symbol('s'),
        () => 1,
        new Date(0),
        new Proxy(
          {},
          {
            get() {
              throw new Error('trap');
            },
          },
        ),
        {
          get state() {
            throw new Error('getter');
          },
        },
        Object.create(null),
      ]);
    const mutate = (obj) => {
      const out = { ...obj };
      const keys = Object.keys(out);
      for (let i = 0; i < 1 + rng.int(3); i++) out[rng.pick(keys)] = junk();
      return out;
    };
    for (let i = 0; i < 3000; i++) {
      const r = rng.bool()
        ? clientShouldSign(mutate(req(hand)), view())
        : clientShouldSign(req(hand), mutate(view()));
      expect(typeof r.ok).toBe('boolean');
      if (!r.ok) expect(typeof r.rule).toBe('string');
    }
  });

  test('inputs are not mutated, and frozen inputs work', () => {
    const deepFreeze = (o) => {
      for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
      return Object.freeze(o);
    };
    const r = deepFreeze(req(hand));
    const v = deepFreeze(view());
    const before = JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
    expect(clientShouldSign(r, v)).toEqual({ ok: true });
    expect(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))).toBe(before);
  });
});

describe('what an honest client would still sign: design questions, decided', () => {
  // DECISION. The unit is the chip: a balance may move only by whole chips times the unit, because the game
  // counts chips. Dust (the remainder of a deposit) never moves, and C1b makes a one-unit transfer a refusal.
  test('dust rides along: a balance that is not a multiple of the unit is fine while it does not change', () => {
    expect(hand.balances[ME] % UNIT).toBe(base.balances[ME] % UNIT);
    expect(verdict(hand)).toEqual({ ok: true });
  });

  test('a pure nonce bump (same balances) is signed when nothing happened at the table', () => {
    const bump = { ...base, nonce: 1n };
    expect(verdict(bump, { observed: null })).toEqual({ ok: true });
  });

  test('the rewind IS caught when the ledger reports every hand since the baseline (observed is cumulative)', () => {
    // I signed the state after hand 1 (nonce 1); it is not all-signed yet, so the baseline is still the
    // genesis. The server now asks for nonce 2 with the genesis balances, as if hand 1 never happened.
    const rewind = { ...base, nonce: 2n };
    const r = verdict(rewind, { last: record(hand), observed: seen });
    expect(r).toEqual(refusedBy('C1b'));
    expect(r.detail).toMatch(/player 0/);
  });

  test.todo('REVIEW GAP: the rewind must also be caught when `observed` only describes the latest hand (trust-model rule 1: "extends the last state you signed")', () => {
    // `last` is { nonce, digest, isFinal }: it has no balances, so the library cannot tell that this
    // request throws away a hand I already signed. Safe only if the caller's ledger reports ALL hands since
    // the baseline. Either document `observed` as cumulative since `baseline` (the README says "the hand I
    // watched"), or let `last` carry the signed state and take the higher of baseline and last as the base.
    const rewind = { ...base, nonce: 2n };
    const r = verdict(rewind, { last: record(hand), observed: null });
    expect(r.ok).toBe(false);
  });

  test.todo('REVIEW GAP: a request that extends a FINAL baseline is refused (baseline.isFinal is a view error)', () => {
    const final = buildNextState({ prev: base, balances: base.balances, final: true });
    const after = { ...final, nonce: 2n, isFinal: false };
    expect(verdict(after, { baseline: final, observed: null }).ok).toBe(false);
  });

  test.todo('REVIEW GAP: a nonce that jumps by 2^64-1 burns the whole nonce space with one honest signature', () => {
    // The state is otherwise correct (same balances), so nobody loses money, but no state can ever follow it
    // and no later state can ever challenge an exit from it. The arbiter may legitimately skip a few nonces
    // (a crash after reserve), so the bound has to be generous, but 2^64 - 1 is not a recovery gap.
    expect(verdict({ ...base, nonce: UINT64_MAX }, { observed: null }).ok).toBe(false);
  });

  test.todo('REVIEW GAP: a non-final state must carry keep all false (the contract reads keep only in settle)', () => {
    // keep flags in a non-final state are signed bytes with no meaning: they let the server mint many digests
    // for one economic state (state malleability), and `_depositState` / buildNextState never produce them.
    expect(verdict({ ...hand, keep: [true, false, true] }).ok).toBe(false);
  });

  test.todo('REVIEW GAP: observed.rake and observed.pot must not be negative', () => {
    // A negative pot lets the volume go DOWN. The contract allows it (it only tightens the cap), but no
    // hand has a negative pot: it can only come from a broken ledger, and fail-closed is the library's rule.
    const withVolume = { ...base, volume: 5n * UNIT };
    const r = clientShouldSign(
      req({ ...base, nonce: 1n, volume: 0n }),
      view({ baseline: withVolume, observed: { deltas: [0, 0, 0], rake: 0, pot: -5 } }),
    );
    expect(r.ok).toBe(false);
  });

  test.todo('REVIEW GAP: maxRakeBps above the contract’s own ceiling (500) is a view error', () => {
    // The vault constructor rejects maxRakeBps_ > 500, so a view claiming more is not read from a vault.
    expect(clientShouldSign(req(hand), view({ maxRakeBps: 10_000 })).ok).toBe(false);
  });

  test.todo('REVIEW GAP: intent "rotate" should require keep[me] to match "my balance is above zero"', () => {
    // Today a rotation may pay me out and remove me from the table (keep[me] false) although I never asked
    // to leave. No funds are lost (the payout goes to my own wallet), but it is an eviction on the server's say-so.
    const evict = buildNextState({
      prev: base,
      balances: base.balances,
      final: true,
      keep: [true, false, true],
    });
    expect(verdict(evict, { observed: null, intent: 'rotate' }).ok).toBe(false);
  });

  test.todo('REVIEW GAP: a yes should hand back the digest to sign, so the caller never signs the server’s copy', () => {
    const r = verdict(hand);
    expect(r.digest).toBe(digestOf(hand));
  });
});

describe('a hostile server against an honest client over many rounds', () => {
  // The client follows the documented protocol: it keeps the newest all-signed state as the baseline, writes
  // the signing record before it signs, and reports every hand since the baseline as `observed`. The server
  // has no signing power of its own; it proposes whatever it likes. Invariants checked after every round:
  //   - one digest per nonce, ever signed by the client
  //   - the nonce never goes back, and nothing is signed after a final
  //   - every state the client signs is, balance for balance, the true result of the hands it watched
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    test(`seed ${seed}`, () => {
      const rng = makeRng(seed * 7919);
      const world = makeWorld({ seed: 100 + seed, n: 3 });
      const me = 1;
      const truthDeltas = []; // hands since the baseline, in chips: [d0, d1, d2], rake, pot
      let baseline = world.genesis;
      let truth = world.genesis; // what the table really says right now (an honest server's state)
      let last = null;
      const signedByNonce = new Map();
      let highest = -1n;
      let finalSigned = false;
      let accepted = 0;

      const cumulative = () =>
        truthDeltas.reduce(
          (acc, h) => ({
            deltas: acc.deltas.map((d, i) => d + h.deltas[i]),
            rake: acc.rake + h.rake,
            pot: acc.pot + h.pot,
          }),
          { deltas: [0, 0, 0], rake: 0, pot: 0 },
        );
      const ask = (state, over = {}) => {
        const r = clientShouldSign(
          { state, domain: world.domain, digest: hashState(state, world.domain) },
          {
            me: world.players[me],
            domain: world.domain,
            tableId: world.tableId,
            roster: world.players,
            unit: UNIT,
            maxRakeBps: 500,
            baseline,
            last,
            intent: 'play',
            observed: cumulative(),
            ...over,
          },
        );
        return r;
      };

      for (let step = 0; step < 250; step++) {
        // the table plays a hand now and then; the client watches it
        if (rng.bool(0.5) && !finalSigned) {
          const from = rng.int(3);
          const to = (from + 1 + rng.int(2)) % 3;
          const chips = 1 + rng.int(40);
          const rake = chips >= 20 ? rng.int(2) : 0; // at most 1/40 of the pot, under the 5% cap
          const bal = truth.balances;
          if (bal[from] >= BigInt(chips) * UNIT) {
            const deltas = [0, 0, 0];
            deltas[from] -= chips;
            deltas[to] += chips - rake;
            truthDeltas.push({ deltas, rake, pot: chips * 2 });
            truth = buildNextState({
              prev: truth,
              balances: bal.map((b, i) => b + BigInt(deltas[i]) * UNIT),
              rakeDelta: BigInt(rake) * UNIT,
              volumeDelta: BigInt(chips * 2) * UNIT,
            });
          }
        }

        const nextNonce = (highest < baseline.nonce ? baseline.nonce : BigInt(highest)) + 1n;
        // what the server proposes this round
        const choice = rng.int(12);
        let proposal = { ...truth, nonce: nextNonce };
        if (choice === 1) proposal = { ...proposal, nonce: nextNonce + BigInt(rng.int(3)) };
        if (choice === 2)
          proposal = { ...proposal, nonce: BigInt(Math.max(0, Number(highest) - rng.int(3))) };
        if (choice === 3)
          proposal = {
            ...proposal,
            balances: proposal.balances.map((b, i) =>
              i === me ? b - UNIT : i === 0 ? b + UNIT : b,
            ),
          };
        if (choice === 4)
          proposal = {
            ...proposal,
            balances: proposal.balances.map((b, i) =>
              i === 0 ? b - UNIT : i === 2 ? b + UNIT : b,
            ),
          };
        if (choice === 5)
          proposal = {
            ...proposal,
            rake: proposal.rake + UNIT,
            balances: proposal.balances.map((b, i) => (i === 2 ? b - UNIT : b)),
          };
        if (choice === 6) proposal = { ...proposal, volume: proposal.volume + UNIT };
        if (choice === 7) proposal = { ...proposal, tableId: `0x${'ee'.repeat(32)}` };
        if (choice === 8) proposal = { ...proposal, isFinal: true, keep: [true, true, true] };
        if (choice === 9)
          proposal = {
            ...proposal,
            players: proposal.players.slice(0, 2),
            balances: proposal.balances.slice(0, 2),
            keep: [false, false],
          };
        if (choice === 10 && signedByNonce.size > 0) {
          // replay an old request, or its twin with a different keep flag
          const [n] = [...signedByNonce.keys()].slice(-1);
          proposal = { ...proposal, nonce: n };
        }
        if (choice === 11)
          proposal = {
            ...proposal,
            nonce: nextNonce,
            balances: proposal.balances.map((b, i) =>
              i === me ? b + UNIT : i === 0 ? b - UNIT : b,
            ),
          };

        const intent = proposal.isFinal ? rng.pick(['play', 'rotate', 'leave']) : 'play';
        let result;
        try {
          result = ask(proposal, { intent });
        } catch (error) {
          throw new Error(
            `clientShouldSign threw at step ${step}, choice ${choice}: ${error.message}`,
          );
        }
        if (!result.ok) continue;

        // the client says yes: check what that means
        const digest = hashState(proposal, world.domain);
        const known = signedByNonce.get(proposal.nonce);
        if (known !== undefined) {
          expect(known, `a second digest at nonce ${proposal.nonce} (choice ${choice})`).toBe(
            digest,
          );
        } else {
          expect(finalSigned, 'a state signed after a final').toBe(false);
          expect(proposal.nonce > BigInt(highest), 'the nonce went back').toBe(true);
          signedByNonce.set(proposal.nonce, digest);
          highest = proposal.nonce;
          last = { nonce: proposal.nonce, digest, isFinal: proposal.isFinal };
          if (proposal.isFinal) finalSigned = true;
          accepted++;
          // the money: this state is exactly the truth the client watched (balances, rake and volume)
          const sameMoney =
            proposal.balances.every((b, i) => b === truth.balances[i]) &&
            proposal.rake === truth.rake &&
            proposal.volume === truth.volume;
          expect(
            sameMoney,
            `signed money that is not the table's (choice ${choice}, step ${step})`,
          ).toBe(true);
          // the baseline advances when the round completes (all signed): do it half the time
          if (rng.bool(0.6)) {
            baseline = proposal;
            truthDeltas.length = 0;
            if (proposal.isFinal) break;
          }
        }
      }
      expect(accepted).toBeGreaterThan(0);
    });
  }
});

describe('S1: the deal gate', () => {
  const good = (() => {
    const state = w.nextHand(base);
    const digest = digestOf(state);
    return makeBundle({
      domain: w.domain,
      state,
      arbiterSig: signDigest(w.arbiterKey, digest),
      playerSigs: w.sessionKeys.map((k) => signDigest(k, digest)),
    });
  })();
  const members = (n = 3) => Array.from({ length: n }, () => ({ claimed: true, online: true }));
  const open = (over = {}) => ({
    active: true,
    roundOpen: false,
    head: 1n,
    bundle: good,
    members: members(),
    ...over,
  });
  const verifyArgs = { arbiter: w.arbiter, sessionKeyOf: w.sessionKeyOf };

  test('control: all conditions met', () => {
    expect(dealBlocker(open())).toBeNull();
    expect(canDeal(open())).toBe(true);
    expect(dealBlocker(open({ verify: verifyArgs }))).toBeNull();
  });

  test('every condition, alone, blocks, with the documented reason', () => {
    const cases = [
      [{ active: false }, 'not-active'],
      [{ roundOpen: true }, 'round-open'],
      [{ members: [{ claimed: false, online: true }, ...members(2)] }, 'member-not-claimed'],
      [{ members: [...members(2), { claimed: true, online: false }] }, 'member-offline'],
      [{ bundle: null }, 'no-bundle'],
      [{ bundle: undefined }, 'no-bundle'],
      [{ head: 2n }, 'bundle-not-head'],
      [{ head: 0n }, 'bundle-not-head'],
      [{ head: 1 }, null], // a number head is the same nonce
      [{ members: members(2) }, 'bundle-incomplete'], // 3 signers in the bundle, 2 members at the table
      [{ bundle: { ...good, arbiterSig: '0x' } }, 'bundle-incomplete'],
      [{ bundle: { ...good, playerSigs: good.playerSigs.slice(1) } }, 'bundle-incomplete'],
      [
        { bundle: { ...good, playerSigs: [...good.playerSigs.slice(0, 2), ''] } },
        'bundle-incomplete',
      ],
      [{ bundle: { ...good, state: { ...good.state, isFinal: true } } }, 'bundle-final'],
    ];
    for (const [patch, reason] of cases) {
      const got = dealBlocker(open(patch));
      expect(got?.reason ?? null, JSON.stringify(Object.keys(patch))).toBe(reason);
    }
  });

  test('the first match wins, in the documented order', () => {
    expect(dealBlocker(open({ active: false, roundOpen: true, bundle: null }))?.reason).toBe(
      'not-active',
    );
    expect(dealBlocker(open({ roundOpen: true, bundle: null }))?.reason).toBe('round-open');
    expect(
      dealBlocker(
        open({ members: [{ claimed: false, online: false }, ...members(2)], bundle: null }),
      )?.reason,
    ).toBe('member-not-claimed');
  });

  test('before the first hand of an epoch there is nothing to wait for (head is null)', () => {
    expect(dealBlocker(open({ head: null, bundle: null }))).toBeNull();
    expect(dealBlocker(open({ head: null, bundle: good }))).toBeNull();
    expect(dealBlocker(open({ head: null, roundOpen: true }))?.reason).toBe('round-open');
  });

  test('anything that is not strictly true counts as no (claimed, online, active, roundOpen)', () => {
    for (const bad of [1, 'true', 'yes', {}, [], null, undefined]) {
      expect(
        canDeal(open({ members: [{ claimed: bad, online: true }, ...members(2)] })),
        `claimed ${String(bad)}`,
      ).toBe(false);
      expect(
        canDeal(open({ members: [{ claimed: true, online: bad }, ...members(2)] })),
        `online ${String(bad)}`,
      ).toBe(false);
      expect(canDeal(open({ active: bad })), `active ${String(bad)}`).toBe(false);
    }
    for (const bad of [0, 'false', null, undefined, {}]) {
      expect(canDeal(open({ roundOpen: bad })), `roundOpen ${String(bad)}`).toBe(false);
    }
    expect(canDeal(open({ members: [] }))).toBe(false);
    expect(canDeal(open({ members: [{ claimed: true, online: true }] }))).toBe(false); // a table needs two
    expect(canDeal(open({ members: 'abc' }))).toBe(false);
    expect(canDeal(null)).toBe(false);
    expect(canDeal(undefined)).toBe(false);
    expect(canDeal({})).toBe(false);
    expect(canDeal(5)).toBe(false);
  });

  test('a head that cannot be a nonce is a no', () => {
    for (const head of [-1n, 1.5, '1', Number.NaN, {}, [], true]) {
      expect(canDeal(open({ head })), String(head)).toBe(false);
    }
  });

  test('with `verify`, a bundle with a forged, swapped or foreign signature is a no (bundle-invalid)', () => {
    const swapped = {
      ...good,
      playerSigs: [good.playerSigs[1], good.playerSigs[0], good.playerSigs[2]],
    };
    expect(dealBlocker(open({ bundle: swapped, verify: verifyArgs }))?.reason).toBe(
      'bundle-invalid',
    );
    const forged = { ...good, arbiterSig: good.playerSigs[0] };
    expect(dealBlocker(open({ bundle: forged, verify: verifyArgs }))?.reason).toBe(
      'bundle-invalid',
    );
    const wrongArbiter = {
      arbiter: privateKeyToAddress(`0x${'12'.repeat(32)}`),
      sessionKeyOf: w.sessionKeyOf,
    };
    expect(dealBlocker(open({ verify: wrongArbiter }))?.reason).toBe('bundle-invalid');
    expect(
      dealBlocker(open({ verify: { arbiter: w.arbiter, sessionKeyOf: () => null } }))?.reason,
    ).toBe('bundle-invalid');
    // a verify argument that is itself broken fails closed rather than skipping the check
    expect(canDeal(open({ verify: { arbiter: 'nope', sessionKeyOf: w.sessionKeyOf } }))).toBe(
      false,
    );
    expect(canDeal(open({ verify: { arbiter: w.arbiter, sessionKeyOf: 'nope' } }))).toBe(false);
    expect(canDeal(open({ verify: 'yes' }))).toBe(false);
  });

  test('REVIEW BUG: a view without `head` must not open the gate (an omitted field is not "no hand yet")', () => {
    // `head: bigint | null` is documented. `undefined` (a typo, a missing property) is treated like null, so
    // the gate opens without looking at the bundle, the opposite of "anything unexpected is a no".
    const view = { active: true, roundOpen: false, members: members(), bundle: null };
    expect(canDeal(view)).toBe(false);
    const noHeadKey = open();
    delete noHeadKey.head;
    expect(canDeal(noHeadKey)).toBe(false);
  });

  test.todo('REVIEW GAP: without `verify`, a bundle of 65 zero bytes per signature opens the gate', () => {
    // dealBlocker only checks that the signatures LOOK complete unless the caller also passes `verify`.
    // S1 is "the last state has every signature": a gate that can be opened by junk should either require
    // `verify` or say in its name that it does not verify.
    const junk = {
      ...good,
      arbiterSig: `0x${'00'.repeat(65)}`,
      playerSigs: good.playerSigs.map(() => `0x${'00'.repeat(65)}`),
    };
    expect(canDeal(open({ bundle: junk }))).toBe(false);
  });

  test('without `verify` the gate does not look at who signed (documented), but verifyBundle does', () => {
    const junk = { ...good, arbiterSig: `0x${'00'.repeat(65)}` };
    expect(canDeal(open({ bundle: junk }))).toBe(true); // the documented limit of the cheap form
    expect(verifyBundle(junk, verifyArgs).ok).toBe(false);
  });

  test('a bundle that is the head but belongs to another table passes the gate (the gate has no table to compare)', () => {
    // documented here so nobody assumes otherwise: the coordinator must only ever hand it its own table's bundle
    const other = { ...good, state: { ...good.state, tableId: `0x${'ee'.repeat(32)}` } };
    expect(canDeal(open({ bundle: other }))).toBe(true);
  });
});

describe('S3: the co-sign age rule', () => {
  test('boundaries: equal is allowed, one over is not, zero and zero is allowed', () => {
    expect(serverMayCoSign({ sessionKeyAgeMs: 0, policyMaxMs: 0 })).toBe(true);
    expect(serverMayCoSign({ sessionKeyAgeMs: 100, policyMaxMs: 100 })).toBe(true);
    expect(serverMayCoSign({ sessionKeyAgeMs: 101, policyMaxMs: 100 })).toBe(false);
    expect(serverMayCoSign({ sessionKeyAgeMs: 99.5, policyMaxMs: 100 })).toBe(true);
    expect(serverMayCoSign({ sessionKeyAgeMs: 12 * 3600_000, policyMaxMs: 12 * 3600_000 })).toBe(
      true,
    );
  });

  test('anything that is not a finite non-negative number is a no', () => {
    for (const bad of [
      -1,
      Number.NaN,
      Infinity,
      -Infinity,
      '5',
      5n,
      null,
      undefined,
      {},
      [],
      true,
    ]) {
      expect(
        serverMayCoSign({ sessionKeyAgeMs: bad, policyMaxMs: 100 }),
        `age ${String(bad)}`,
      ).toBe(false);
      expect(serverMayCoSign({ sessionKeyAgeMs: 5, policyMaxMs: bad }), `max ${String(bad)}`).toBe(
        false,
      );
    }
    expect(serverMayCoSign()).toBe(false);
    expect(serverMayCoSign({})).toBe(false);
  });

  test.todo('REVIEW GAP (nit): a null argument is a no, not an exception (the predicates are documented as never throwing)', () => {
    expect(serverMayCoSign(null)).toBe(false);
  });
});
