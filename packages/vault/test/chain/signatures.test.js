// A fuzz of what checkState says against what the real PokerVault does with the same bytes: mutated
// signatures (every way ECDSA can reject one) and mutated states (several faults at once, so the order of
// the checks is tested). Seeded, so a failure replays. The first error and its arguments must be identical.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { buildNextState, genesisState } from '../../src/build.js';
import { checkState, tableFromChain } from '../../src/check.js';
import { signDigest } from '../../src/sign.js';
import { chainDescribe } from '../../testing/index.js';
import { makeRng, UINT256_MAX } from '../gen.js';
import { setupEpoch } from './setup.js';

// Each case is an RPC round trip to anvil, so a fuzz takes seconds on a quiet machine and many times that
// on a busy one: bun's 5 s default is a flake, not a bound.
const FUZZ_TIMEOUT_MS = 60_000;
const ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HALF = ORDER >> 1n;
const dec = (x) => (x > 0n ? x - 1n : 0n);
const hex = (n) => n.toString(16).padStart(64, '0');
const parts = (sig) => ({
  r: BigInt(`0x${sig.slice(2, 66)}`),
  s: BigInt(`0x${sig.slice(66, 130)}`),
  v: Number.parseInt(sig.slice(130, 132), 16),
});
const join = ({ r, s, v }) => `0x${hex(r)}${hex(s)}${v.toString(16).padStart(2, '0')}`;

chainDescribe('checkState vs the real PokerVault: fuzz', () => {
  let env;
  beforeAll(async () => {
    env = await setupEpoch();
  }, FUZZ_TIMEOUT_MS); // about forty transactions on anvil
  afterAll(async () => {
    await env?.node.stop();
  });

  const same = async (state, sigs, label, ctx = env.ctx) => {
    const mine = checkState(state, sigs, ctx);
    const theirs = await env.revertOf('startExit', env.submit(state, sigs), env.roster[0].wallet);
    const summary = mine.ok ? null : { error: mine.error, args: mine.args };
    expect(summary, label).toEqual(theirs);
    return theirs?.error ?? 'ok';
  };

  test(
    '300 mutated signatures: the same error as the contract, and every ECDSA error is reached',
    async () => {
      const rng = makeRng(31337);
      const good = env.goodState();
      const valid = await env.sign(good);
      const foreign = signDigest(`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`);
      const seen = new Set();

      const mutate = (sig) => {
        const p = parts(sig);
        const random256 = () => rng.bigint(256);
        switch (rng.int(13)) {
          case 0:
            return rng.hex(rng.int(80));
          case 1:
            return join({ ...p, v: rng.pick([0, 1, 2, 26, 29, 30, 255]) });
          case 2:
            return join({
              ...p,
              s: rng.pick([
                0n,
                1n,
                HALF,
                HALF + 1n,
                ORDER - 1n,
                ORDER,
                ORDER + 1n,
                UINT256_MAX,
                random256(),
              ]),
            });
          case 3:
            return join({
              ...p,
              r: rng.pick([
                0n,
                1n,
                2n,
                3n,
                ORDER - 1n,
                ORDER,
                ORDER + 1n,
                UINT256_MAX,
                random256(),
              ]),
            });
          case 4:
            return join({ r: p.r, s: ORDER - p.s, v: p.v === 27 ? 28 : 27 }); // the malleable twin
          case 5: {
            const bytes = sig.slice(2).match(/../g);
            const i = rng.int(65);
            bytes[i] = ((Number.parseInt(bytes[i], 16) ^ (1 << rng.int(8))) & 0xff)
              .toString(16)
              .padStart(2, '0');
            return `0x${bytes.join('')}`;
          }
          case 6:
            return sig.slice(0, sig.length - 2 * (1 + rng.int(65)));
          case 7:
            return `${sig}${rng.hex(1 + rng.int(8)).slice(2)}`;
          case 8:
            return foreign;
          case 9:
            return `0x${'00'.repeat(65)}`;
          case 10:
            return join({ ...p, v: p.v === 27 ? 28 : 27 });
          case 11:
            return join({ r: random256(), s: (random256() % HALF) + 1n, v: rng.pick([27, 28]) });
          default:
            return sig;
        }
      };

      for (let i = 0; i < 300; i++) {
        const sigs = { arbiterSig: valid.arbiterSig, playerSigs: [...valid.playerSigs] };
        const touches = 1 + rng.int(2);
        for (let t = 0; t < touches; t++) {
          const at = rng.int(4); // 0 = arbiter, 1..3 = players; always mutated from the valid signature
          if (at === 0) sigs.arbiterSig = mutate(valid.arbiterSig);
          else sigs.playerSigs[at - 1] = mutate(valid.playerSigs[at - 1]);
        }
        seen.add(await same(good, sigs, `signature case ${i}`));
      }
      for (const name of [
        'ok',
        'BadSignature',
        'ECDSAInvalidSignature',
        'ECDSAInvalidSignatureLength',
        'ECDSAInvalidSignatureS',
      ]) {
        expect(seen.has(name), `never reached ${name}; saw ${[...seen]}`).toBe(true);
      }
    },
    FUZZ_TIMEOUT_MS,
  );

  test(
    '300 mutated states with valid signatures: faults pile up, the first one wins, as on chain',
    async () => {
      const rng = makeRng(424242);
      const good = env.goodState();
      const seen = new Set();
      const tweak = [
        (s) => ({ ...s, nonce: rng.pick([0n, 1n, 2n, (1n << 64n) - 1n]) }),
        (s) => ({ ...s, balances: s.balances.slice(0, 2 + rng.int(2) - 1) }),
        (s) => ({ ...s, keep: [...s.keep, false] }),
        (s) => ({ ...s, players: [...s.players].reverse() }),
        (s) => ({
          ...s,
          players: s.players.slice(1),
          balances: s.balances.slice(1),
          keep: s.keep.slice(1),
        }),
        (s) => ({
          ...s,
          rake: rng.pick([0n, dec(s.rake), s.rake + 1n, s.rake * 100n, UINT256_MAX]),
        }),
        (s) => ({
          ...s,
          volume: rng.pick([0n, 1n, s.volume * 2n, UINT256_MAX, UINT256_MAX / 500n + 1n]),
        }),
        (s) => ({ ...s, balances: s.balances.map((b, i) => (i === rng.int(3) ? b + 1n : b)) }),
        (s) => ({ ...s, balances: s.balances.map((b, i) => (i === rng.int(3) ? 0n : b)) }),
        (s) => ({ ...s, balances: [1n << 255n, 1n << 255n, ...s.balances.slice(2)] }),
        (s) => ({ ...s, isFinal: !s.isFinal }),
      ];
      for (let i = 0; i < 300; i++) {
        let state = good;
        const faults = rng.int(4); // 0 = a valid state
        for (let f = 0; f < faults; f++) state = rng.pick(tweak)(state);
        // sometimes sign the mutated state, sometimes keep the signatures of the good one
        const sigs = rng.bool(0.7) ? await env.sign(state) : await env.sign(good);
        seen.add(await same(state, sigs, `state case ${i}`));
      }
      for (const name of [
        'ok',
        'StaleNonce',
        'BadLength',
        'RosterMismatch',
        'RakeTooHigh',
        'NotConserved',
        'BadSignature',
        'Panic',
      ]) {
        expect(seen.has(name), `never reached ${name}; saw ${[...seen]}`).toBe(true);
      }
    },
    FUZZ_TIMEOUT_MS,
  );

  test(
    'a rolled-over epoch (rake already paid, nonce above zero): RakeDecreased and the relative rake',
    async () => {
      const { genesis, roster, deployed, tableId, ctx, write, read } = env;
      // epoch 1 ends cooperatively with everybody staying and 1 token of rake paid out
      const final = buildNextState({
        prev: genesis,
        balances: genesis.balances.map((b, i) =>
          i === 0 ? b + 29_000_000n : i === 1 ? b - 30_000_000n : b,
        ),
        rakeDelta: 1_000_000n,
        volumeDelta: 60_000_000n,
        final: true,
        keep: [true, true, true],
      });
      const sigs = await env.sign(final);
      await write(roster[0].wallet, deployed.vault, deployed.vaultAbi, 'settle', [
        final,
        sigs.arbiterSig,
        sigs.playerSigs,
      ]);
      await write(deployed.arbiter, deployed.vault, deployed.vaultAbi, 'start', [
        tableId,
        roster.map((p) => p.address),
      ]);
      const table = tableFromChain(await read('tables', [tableId]));
      expect(table.rakePaid).toBe(1_000_000n);
      expect(table.nonce).toBe(final.nonce);
      const ctx2 = { ...ctx, table };
      const start = genesisState({
        tableId,
        players: genesis.players,
        deposits: final.balances,
        nonce: table.nonce,
        rake: table.rakePaid,
      });
      // the contract's own deposit state for the new epoch is exactly this
      const onChain = await read('depositState', [tableId, genesis.players]);
      expect([...onChain.balances]).toEqual(start.balances);
      expect(onChain.rake).toBe(start.rake);
      expect(onChain.nonce).toBe(start.nonce);

      const next = buildNextState({
        prev: start,
        balances: start.balances.map((b, i) =>
          i === 2 ? b + 10_000_000n : i === 0 ? b - 10_000_000n : b,
        ),
        rakeDelta: 0n,
        volumeDelta: 20_000_000n,
      });
      const nextSigs = await env.sign(next);
      const seen = new Set();
      seen.add(await same(next, nextSigs, 'valid in epoch 2', ctx2));

      const rng = makeRng(99);
      const tweaks = [
        (s) => ({
          ...s,
          rake: rng.pick([
            0n,
            dec(s.rake),
            s.rake + 1n,
            dec(s.rake - 500_000n),
            s.rake + 40_000_000n,
          ]),
        }),
        (s) => ({ ...s, volume: rng.pick([0n, 1n, dec(s.volume), s.volume * 3n]) }),
        (s) => ({ ...s, nonce: rng.pick([0n, dec(s.nonce), s.nonce]) }),
        (s) => ({ ...s, balances: s.balances.map((b, i) => (i === rng.int(3) ? b + 1n : b)) }),
      ];
      for (let i = 0; i < 120; i++) {
        let state = next;
        for (let f = 1 + rng.int(2); f > 0; f--) state = rng.pick(tweaks)(state);
        seen.add(await same(state, await env.sign(state), `epoch 2 case ${i}`, ctx2));
      }
      for (const name of ['ok', 'RakeDecreased', 'StaleNonce', 'NotConserved', 'RakeTooHigh']) {
        expect(seen.has(name), `never reached ${name}; saw ${[...seen]}`).toBe(true);
      }
    },
    FUZZ_TIMEOUT_MS,
  );
});
