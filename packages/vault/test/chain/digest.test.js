// The library against the real PokerVault on anvil: the digest, the deposit state, and a first look at
// checkState/checkSettle next to the contract's own reverts. (The signature and state fuzz is in
// signatures.test.js; the broad equivalence property test lives in its own file.)
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { buildNextState } from '../../src/build.js';
import { checkSettle, checkState } from '../../src/check.js';
import { domainSeparator, hashState, STATE_TYPEHASH } from '../../src/eip712.js';
import { statesEqual } from '../../src/state.js';
import { chainDescribe } from '../../testing/index.js';
import { makeRng, randomState, UINT256_MAX } from '../gen.js';
import { setupEpoch } from './setup.js';

chainDescribe('library vs the real PokerVault', () => {
  let env;

  beforeAll(async () => {
    env = await setupEpoch();
  }, 60_000); // about forty transactions on anvil: slow on a busy machine
  afterAll(async () => {
    await env?.node.stop();
  });

  test("the domain separator and typehash are the contract's", async () => {
    expect(domainSeparator(env.domain)).toBe(await env.read('domainSeparator'));
    expect(STATE_TYPEHASH).toBe(await env.read('STATE_TYPEHASH'));
  });

  test('hashState equals PokerVault.stateDigest for 120 random states', async () => {
    const rng = makeRng(2024);
    for (let i = 0; i < 120; i++) {
      const state = randomState(rng);
      expect(hashState(state, env.domain)).toBe(await env.read('stateDigest', [state]));
    }
  });

  test('genesisState is the state the contract builds in depositState', async () => {
    const onChain = await env.read('depositState', [env.tableId, env.genesis.players]);
    expect(
      statesEqual(env.genesis, {
        tableId: onChain.tableId,
        nonce: onChain.nonce,
        isFinal: onChain.isFinal,
        players: [...onChain.players],
        balances: [...onChain.balances],
        keep: [...onChain.keep],
        rake: onChain.rake,
        volume: onChain.volume,
      }),
    ).toBe(true);
  });

  test('checkState agrees with the contract on a good state, then on the first error of mutated ones', async () => {
    const good = env.goodState();
    const sigs = await env.sign(good);
    const alice = env.roster[0].wallet;
    const { ctx, submit, revertOf, sign } = env;

    expect(checkState(good, sigs, ctx)).toMatchObject({ ok: true });
    expect(await revertOf('startExit', submit(good, sigs), alice)).toBeNull();

    const mutations = [
      ['stale nonce', { ...good, nonce: 0n }],
      ['short balances', { ...good, balances: good.balances.slice(1) }],
      [
        'reordered roster',
        {
          ...good,
          players: [...good.players].reverse(),
          balances: [...good.balances].reverse(),
          keep: [...good.keep].reverse(),
        },
      ],
      ['rake too high', { ...good, rake: good.rake + 40_000_000n, volume: good.volume }],
      ['not conserved', { ...good, balances: good.balances.map((b, i) => (i === 2 ? b + 1n : b)) }],
    ];
    for (const [name, state] of mutations) {
      const mine = checkState(state, await sign(state), ctx);
      const theirs = await revertOf('startExit', submit(state, await sign(state)), alice);
      expect(mine.ok, name).toBe(false);
      expect({ error: mine.error, args: mine.args }, name).toEqual(theirs);
    }

    // Solidity's checked arithmetic: each of these is a Panic(0x11) on chain, and checkState says so
    const huge = 1n << 255n;
    const overflows = [
      ['rake * 10000 overflows', { ...good, rake: UINT256_MAX / 10_000n + 1n, volume: 1n }],
      ['maxRakeBps * volume overflows', { ...good, rake: 0n, volume: UINT256_MAX / 500n + 1n }],
      ['the balance sum overflows', { ...good, rake: 0n, volume: 0n, balances: [huge, huge, 0n] }],
    ];
    for (const [name, state] of overflows) {
      const mine = checkState(state, await sign(state), ctx);
      const theirs = await revertOf('startExit', submit(state, await sign(state)), alice);
      expect({ error: mine.error, args: mine.args }, name).toEqual({
        error: 'Panic',
        args: [0x11n],
      });
      expect(theirs, name).toEqual({ error: 'Panic', args: [0x11n] });
    }

    // signatures: a wrong arbiter, a wrong player, a malformed one
    const wrongArbiter = { ...sigs, arbiterSig: sigs.playerSigs[0] };
    const wrongPlayer = { ...sigs, playerSigs: [sigs.playerSigs[1], ...sigs.playerSigs.slice(1)] };
    const shortSig = { ...sigs, playerSigs: [sigs.playerSigs[0], '0x1234', sigs.playerSigs[2]] };
    for (const [name, s] of [
      ['arbiter', wrongArbiter],
      ['player', wrongPlayer],
      ['short', shortSig],
    ]) {
      const mine = checkState(good, s, ctx);
      expect(mine.ok, name).toBe(false);
      expect({ error: mine.error, args: mine.args }, name).toEqual(
        await revertOf('startExit', submit(good, s), alice),
      );
    }
  });

  test('a final state: checkSettle accepts it and settle pays out accordingly', async () => {
    const { genesis, ctx, roster, deployed, tableId } = env;
    const final = buildNextState({
      prev: genesis,
      balances: genesis.balances.map((b, i) =>
        i === 0 ? b + 29_000_000n : i === 1 ? b - 30_000_000n : b,
      ),
      rakeDelta: 1_000_000n,
      volumeDelta: 60_000_000n,
      final: true,
      keep: [true, false, true],
    });
    const sigs = await env.sign(final);
    expect(checkSettle(final, sigs, ctx)).toMatchObject({ ok: true });
    expect(checkSettle({ ...final, keep: [true, true, true] }, sigs, ctx).error).toBe(
      'BadSignature',
    );

    await env.write(roster[2].wallet, deployed.vault, deployed.vaultAbi, 'settle', [
      final,
      sigs.arbiterSig,
      sigs.playerSigs,
    ]);
    const table = await env.read('tables', [tableId]);
    expect(table[0]).toBe(1); // Filling again
    expect(table[8]).toBe(final.balances[0] + final.balances[2]); // only the stayers' chips remain
    expect(table[9]).toBe(1_000_000n); // rake paid
  });
});
