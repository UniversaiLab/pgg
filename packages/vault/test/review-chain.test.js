// Review: the library against the REAL PokerVault on anvil, aimed at the places the existing chain tests do
// not reach: signatures built to sit on the edge of ECDSA (a recovered public key at infinity, an r that is a
// curve x-coordinate above the group order, s exactly at n/2), the order in which two bad signatures are
// reported, Solidity's checked arithmetic at its exact boundaries on a table that really holds 2^256 - 1
// tokens, settle in every table status, a rolled-over epoch, and a seat whose session key is the arbiter's.
//
// Needs Foundry: PATH=/opt/foundry:$PATH PGG_REQUIRE_CHAIN_TESTS=1 bun test packages/vault/test/review-chain.test.js
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ContractFunctionRevertedError, keccak256, toHex } from 'viem';
import { buildNextState, genesisState, sortRoster } from '../src/build.js';
import { checkSettle, checkState, tableFromChain } from '../src/check.js';
import { hashState } from '../src/eip712.js';
import { fromHex, privateKeyToAddress, signDigest } from '../src/sign.js';
import { chainDescribe, deployVault, startAnvil } from '../testing/index.js';
import { UINT64_MAX, UINT256_MAX } from './gen.js';

const ORDER = secp256k1.Point.CURVE().n;
const FIELD = secp256k1.Point.CURVE().p;
const HALF = ORDER >> 1n;
const word = (n) => n.toString(16).padStart(64, '0');
const join = (r, s, v) => `0x${word(r)}${word(s)}${v.toString(16).padStart(2, '0')}`;
const mod = (a, m) => ((a % m) + m) % m;
const inverse = (a, m) => {
  let [r0, r1, s0, s1] = [mod(a, m), m, 1n, 0n];
  while (r1) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  return mod(s0, m);
};
const key = (name) => keccak256(toHex(`review-chain:${name}`));
const id = (name) => keccak256(toHex(`review-chain-table:${name}`));
const UNIT = 10_000n;
setDefaultTimeout(120_000);

chainDescribe('review: the library against the real PokerVault', () => {
  let node;
  let deployed;
  let domain;

  const read = (functionName, args = [], world = deployed) =>
    node.publicClient.readContract({
      address: world.vault,
      abi: world.vaultAbi,
      functionName,
      args,
    });
  const wait = (hash) => node.publicClient.waitForTransactionReceipt({ hash });
  const write = async (account, address, abi, functionName, args) => {
    const receipt = await wait(
      await node.walletFor(account).writeContract({ address, abi, functionName, args }),
    );
    if (receipt.status !== 'success') throw new Error(`${functionName} reverted`);
    return receipt;
  };
  const vaultWrite = (account, functionName, args, world = deployed) =>
    write(account, world.vault, world.vaultAbi, functionName, args);

  /** The first revert `functionName` would hit, as { error, args }, or null if it would succeed. */
  const revertOf = async (functionName, args, account, world = deployed) => {
    try {
      await node.publicClient.simulateContract({
        address: world.vault,
        abi: world.vaultAbi,
        functionName,
        args,
        account,
      });
      return null;
    } catch (error) {
      const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
      if (!reverted?.data) return { error: 'unknown', args: [String(error.shortMessage ?? error)] };
      return { error: reverted.data.errorName, args: reverted.data.args ?? [] };
    }
  };

  /**
   * One table, created, funded and started in `world` (a deployVault result with a `domain`; the default is
   * the shared vault). `seats` is [{ name, deposit, session?, sessionAddress? }]: `session` is the seat's
   * session private key (default: derived from the names), `sessionAddress` overrides the address that is
   * registered on chain. Returns what a test needs to build states, sign them and ask the contract.
   */
  async function openTable(
    tableName,
    seats,
    { maxDeposit = 10n ** 30n, tableId = id(tableName), start = true, world = deployed } = {},
  ) {
    const worldDomain = world.domain;
    await vaultWrite(world.arbiter, 'createTable', [tableId, 6, 1n, maxDeposit], world);
    const full = [];
    for (const seat of seats) {
      const wallet = await node.account(seat.name);
      const sessionKey = seat.session ?? key(`session:${tableName}:${seat.name}`);
      await write(wallet, world.token, world.tokenAbi, 'mint', [wallet.address, seat.deposit]);
      await write(wallet, world.token, world.tokenAbi, 'approve', [world.vault, UINT256_MAX]);
      await vaultWrite(
        wallet,
        'deposit',
        [tableId, seat.deposit, seat.sessionAddress ?? privateKeyToAddress(sessionKey)],
        world,
      );
      full.push({ ...seat, wallet, address: wallet.address.toLowerCase(), sessionKey });
    }
    const { sorted } = sortRoster(full);
    if (start) {
      await vaultWrite(world.arbiter, 'start', [tableId, sorted.map((s) => s.address)], world);
    }
    const players = sorted.map((s) => s.address);
    const sessionKeys = new Map();
    for (const seat of sorted) {
      const onChain = await read('seats', [tableId, seat.address], world);
      sessionKeys.set(seat.address, onChain[1].toLowerCase());
    }
    const tableRow = async () => tableFromChain(await read('tables', [tableId], world));
    const ctx = async () => ({
      domain: worldDomain,
      maxRakeBps: await read('MAX_RAKE_BPS', [], world),
      sessionKeyOf: (address) => sessionKeys.get(address) ?? null,
      table: await tableRow(),
    });
    const sign = async (state, { player = (seat) => seat.sessionKey, arbiter = true } = {}) => {
      const digest = hashState(state, worldDomain);
      return {
        arbiterSig: arbiter ? await world.arbiter.sign({ hash: digest }) : undefined,
        playerSigs: sorted.map((seat) => signDigest(player(seat), digest)),
      };
    };
    return { tableId, seats: sorted, players, ctx, tableRow, sign, sessionKeys, world };
  }

  /** checkState (or checkSettle) and the contract's own simulation of the same call, side by side. */
  async function sameAsContract(table, state, sigs, label, { fn = 'startExit', caller } = {}) {
    const ctx = await table.ctx();
    const mine = fn === 'settle' ? checkSettle(state, sigs, ctx) : checkState(state, sigs, ctx);
    const theirs = await revertOf(
      fn,
      [state, sigs.arbiterSig, sigs.playerSigs],
      caller ?? table.seats[0].wallet,
      table.world,
    );
    expect(mine.ok ? null : { error: mine.error, args: mine.args }, label).toEqual(theirs);
    return theirs?.error ?? 'ok';
  }

  beforeAll(async () => {
    node = await startAnvil();
    deployed = await deployVault(node, { arbiter: await node.account('review-arbiter') });
    domain = { chainId: node.chainId, verifyingContract: deployed.vault };
    deployed.domain = domain;
  }, 60_000);
  afterAll(async () => {
    await node?.stop();
  });

  // ---------------------------------------------------------------------------------------------------
  describe('the digest of states the contract will hash but no one should sign', () => {
    const addr = (n) => `0x${n.toString(16).padStart(40, '0')}`;
    const T = `0x${'11'.repeat(32)}`;
    const states = {
      'empty arrays': {
        tableId: T,
        nonce: 0n,
        isFinal: false,
        players: [],
        balances: [],
        keep: [],
        rake: 0n,
        volume: 0n,
      },
      'lengths that disagree': {
        tableId: T,
        nonce: 5n,
        isFinal: true,
        players: [addr(1n), addr(2n), addr(3n)],
        balances: [1n],
        keep: [true, false, true, false, true],
        rake: 1n,
        volume: 2n,
      },
      'zero and duplicate players': {
        tableId: T,
        nonce: 5n,
        isFinal: false,
        players: [addr(0n), addr(7n), addr(7n)],
        balances: [1n, 2n, 3n],
        keep: [false, true, false],
        rake: 0n,
        volume: 0n,
      },
      'descending players': {
        tableId: T,
        nonce: 9n,
        isFinal: false,
        players: [addr(9n), addr(5n), addr(1n)],
        balances: [1n, 2n, 3n],
        keep: [false, false, false],
        rake: 0n,
        volume: 0n,
      },
      'eleven players': {
        tableId: T,
        nonce: UINT64_MAX,
        isFinal: true,
        players: Array.from({ length: 11 }, (_, i) => addr(BigInt(i + 1) << 80n)),
        balances: Array.from({ length: 11 }, (_, i) => UINT256_MAX - BigInt(i)),
        keep: Array.from({ length: 11 }, (_, i) => i % 2 === 0),
        rake: UINT256_MAX,
        volume: UINT256_MAX,
      },
      'bits that sign-extend': {
        tableId: `0x${'ff'.repeat(32)}`,
        nonce: 1n << 63n,
        isFinal: true,
        players: [addr(1n << 159n), addr((1n << 160n) - 1n)],
        balances: [1n << 255n, 1n << 128n],
        keep: [true, true],
        rake: 1n << 255n,
        volume: 1n << 128n,
      },
    };
    for (const [name, state] of Object.entries(states)) {
      test(`${name}: hashState == PokerVault.stateDigest`, async () => {
        expect(hashState(state, domain)).toBe(await read('stateDigest', [state]));
      });
    }
  });

  // ---------------------------------------------------------------------------------------------------
  describe('signatures on the edge of ECDSA, in the arbiter slot and in a player slot', () => {
    let table;
    let state;
    let digest;
    let valid;

    beforeAll(async () => {
      table = await openTable('ecdsa', [
        { name: 'ann', deposit: 1_000_000_000n },
        { name: 'bob', deposit: 1_000_000_000n },
        { name: 'cat', deposit: 1_000_000_000n },
      ]);
      const ctx = await table.ctx();
      const genesis = genesisState({
        tableId: table.tableId,
        players: table.players,
        deposits: [1_000_000_000n, 1_000_000_000n, 1_000_000_000n],
      });
      state = buildNextState({
        prev: genesis,
        balances: [1_049_000_000n, 950_000_000n, 1_000_000_000n],
        rakeDelta: 1_000_000n,
        volumeDelta: 100_000_000n,
      });
      digest = hashState(state, domain);
      valid = await table.sign(state);
      expect(checkState(state, valid, ctx).ok).toBe(true);
      expect(
        await revertOf(
          'startExit',
          [state, valid.arbiterSig, valid.playerSigs],
          table.seats[0].wallet,
        ),
      ).toBeNull();
    });

    /** A signature over `digest` whose recovered public key is the point at infinity: ecrecover has nothing to return. */
    const infinitySignature = (k) => {
      const R = secp256k1.Point.BASE.multiply(k);
      const r = R.x % ORDER;
      let s = mod(BigInt(digest) * inverse(k, ORDER), ORDER);
      let parity = Number(R.y & 1n);
      if (s > HALF) {
        s = ORDER - s;
        parity ^= 1;
      }
      return join(r, s, 27 + parity);
    };

    /** r values that are x-coordinates of curve points but lie at or above the group order (so ecrecover rejects them). */
    const highX = () => {
      const found = [];
      for (let x = ORDER; found.length < 2 && x < FIELD; x++) {
        try {
          secp256k1.Point.fromBytes(fromHex(`0x02${word(x)}`));
          found.push(x);
        } catch {
          // not on the curve
        }
      }
      return found;
    };

    const parts = (sig) => ({
      r: BigInt(`0x${sig.slice(2, 66)}`),
      s: BigInt(`0x${sig.slice(66, 130)}`),
      v: Number.parseInt(sig.slice(130, 132), 16),
    });
    const variants = () => {
      const p = parts(valid.arbiterSig);
      const mid = { r: p.r, v: p.v };
      return {
        'recovers to the point at infinity (k = 12345)': infinitySignature(12345n),
        'recovers to the point at infinity (k = 2^200 + 7)': infinitySignature((1n << 200n) + 7n),
        'r is an x-coordinate on the curve but at or above the order (1)': join(
          highX()[0],
          p.s,
          p.v,
        ),
        'r is an x-coordinate on the curve but at or above the order (2)': join(
          highX()[1],
          p.s,
          27,
        ),
        's == n/2 exactly (not high; goes to ecrecover)': join(mid.r, HALF, mid.v),
        's == n/2 + 1 (the smallest high s)': join(mid.r, HALF + 1n, mid.v),
        's == n - 1': join(mid.r, ORDER - 1n, mid.v),
        's == 1': join(mid.r, 1n, mid.v),
        's == 0': join(mid.r, 0n, mid.v),
        'r == 0': join(0n, p.s, p.v),
        'r == 1': join(1n, p.s, p.v),
        'r == n - 1': join(ORDER - 1n, p.s, p.v),
        'r == n': join(ORDER, p.s, p.v),
        'r == 2^256 - 1': join(UINT256_MAX, p.s, p.v),
        'v == 0': join(p.r, p.s, 0),
        'v == 1': join(p.r, p.s, 1),
        'v == 2': join(p.r, p.s, 2),
        'v == 26': join(p.r, p.s, 26),
        'v == 29': join(p.r, p.s, 29),
        'v == 255': join(p.r, p.s, 255),
        'the other parity of v': join(p.r, p.s, p.v === 27 ? 28 : 27),
        'the malleable twin': join(p.r, ORDER - p.s, p.v === 27 ? 28 : 27),
        'high s and a bad v together': join(p.r, ORDER - p.s, 0),
        'all zero (65 bytes)': `0x${'00'.repeat(65)}`,
        'all ff (65 bytes)': `0x${'ff'.repeat(65)}`,
        empty: '0x',
        '1 byte': '0x1b',
        '64 bytes (EIP-2098 compact form)': valid.arbiterSig.slice(0, 2 + 128),
        '66 bytes': `${valid.arbiterSig}00`,
        '129 bytes': `${valid.arbiterSig}${'00'.repeat(64)}`,
        '32 bytes': valid.arbiterSig.slice(0, 2 + 64),
      };
    };

    test('every variant, as the arbiter’s signature: the same first error as the contract', async () => {
      const seen = new Set();
      for (const [name, sig] of Object.entries(variants())) {
        seen.add(
          await sameAsContract(
            table,
            state,
            { arbiterSig: sig, playerSigs: valid.playerSigs },
            `arbiter: ${name}`,
          ),
        );
      }
      // the construction really did reach every ECDSA error the contract has
      for (const e of [
        'ECDSAInvalidSignature',
        'ECDSAInvalidSignatureLength',
        'ECDSAInvalidSignatureS',
        'BadSignature',
      ]) {
        expect(seen.has(e), `never reached ${e}`).toBe(true);
      }
    });

    test('every variant, as the third player’s signature', async () => {
      for (const [name, sig] of Object.entries(variants())) {
        const playerSigs = [valid.playerSigs[0], valid.playerSigs[1], sig];
        await sameAsContract(
          table,
          state,
          { arbiterSig: valid.arbiterSig, playerSigs },
          `player 2: ${name}`,
        );
      }
    });

    test('the infinity-point signatures are really rejected by ecrecover itself, not by a side check', async () => {
      const sig = infinitySignature(12345n);
      const { r, s, v } = parts(sig);
      const out = await node.publicClient.call({
        to: '0x0000000000000000000000000000000000000001',
        data: `0x${digest.slice(2)}${word(BigInt(v))}${word(r)}${word(s)}`,
      });
      expect(out.data ?? '0x').toBe('0x'); // the precompile returns nothing
      expect(s <= HALF).toBe(true);
    });

    test('which error is reported when two slots are bad: arbiter first, then players in order', async () => {
      const lengthBad = '0x1234';
      const highS = join(parts(valid.arbiterSig).r, HALF + 1n, 27);
      const zeroV = join(parts(valid.arbiterSig).r, parts(valid.arbiterSig).s, 0);
      const stranger = signDigest(key('stranger'), digest);
      const cases = {
        'arbiter wrong signer, player 0 malformed': {
          arbiterSig: stranger,
          playerSigs: [lengthBad, valid.playerSigs[1], valid.playerSigs[2]],
        },
        'arbiter malformed, player 0 wrong signer': {
          arbiterSig: lengthBad,
          playerSigs: [stranger, valid.playerSigs[1], valid.playerSigs[2]],
        },
        'player 0 wrong signer, player 1 malformed': {
          arbiterSig: valid.arbiterSig,
          playerSigs: [stranger, lengthBad, valid.playerSigs[2]],
        },
        'player 0 malformed, player 1 wrong signer': {
          arbiterSig: valid.arbiterSig,
          playerSigs: [lengthBad, stranger, valid.playerSigs[2]],
        },
        'player 0 high s, player 1 length': {
          arbiterSig: valid.arbiterSig,
          playerSigs: [highS, lengthBad, valid.playerSigs[2]],
        },
        'player 1 zero v, player 2 high s': {
          arbiterSig: valid.arbiterSig,
          playerSigs: [valid.playerSigs[0], zeroV, highS],
        },
        'all three players bad, three different ways': {
          arbiterSig: valid.arbiterSig,
          playerSigs: [stranger, highS, lengthBad],
        },
        'arbiter good, players swapped': {
          arbiterSig: valid.arbiterSig,
          playerSigs: [valid.playerSigs[1], valid.playerSigs[0], valid.playerSigs[2]],
        },
        'a player’s signature in the arbiter slot': {
          arbiterSig: valid.playerSigs[0],
          playerSigs: valid.playerSigs,
        },
        'the arbiter’s signature in a player slot': {
          arbiterSig: valid.arbiterSig,
          playerSigs: [valid.playerSigs[0], valid.arbiterSig, valid.playerSigs[2]],
        },
      };
      for (const [name, sigs] of Object.entries(cases))
        await sameAsContract(table, state, sigs, name);
    });

    test('the wrong NUMBER of player signatures is BadLength, ahead of every other check', async () => {
      for (const playerSigs of [
        [],
        valid.playerSigs.slice(1),
        [...valid.playerSigs, valid.playerSigs[0]],
      ]) {
        expect(
          await sameAsContract(
            table,
            state,
            { arbiterSig: '0x', playerSigs },
            `${playerSigs.length} sigs`,
          ),
        ).toBe('BadLength');
      }
      // and it comes after a stale nonce, before a bad roster
      const stale = { ...state, nonce: 0n };
      expect(
        await sameAsContract(
          table,
          stale,
          { arbiterSig: valid.arbiterSig, playerSigs: [] },
          'stale and short',
        ),
      ).toBe('StaleNonce');
      const wrongRoster = { ...state, players: [...state.players].reverse() };
      expect(
        await sameAsContract(
          table,
          wrongRoster,
          { arbiterSig: valid.arbiterSig, playerSigs: [] },
          'bad roster, no sigs',
        ),
      ).toBe('BadLength');
    });

    test('a digest above the group order: the real ecrecover and the library recover the same signer', async () => {
      const big = `0x${'ff'.repeat(32)}`; // 2^256 - 1 > n
      const sk = key('big-digest');
      const sig = signDigest(sk, big);
      const { r, s, v } = parts(sig);
      const out = await node.publicClient.call({
        to: '0x0000000000000000000000000000000000000001',
        data: `0x${big.slice(2)}${word(BigInt(v))}${word(r)}${word(s)}`,
      });
      expect(`0x${out.data.slice(-40)}`).toBe(privateKeyToAddress(sk));
    });
  });

  // ---------------------------------------------------------------------------------------------------
  describe('checked arithmetic at its exact boundaries, on a table that really holds 2^256 - 1 tokens', () => {
    const M = UINT256_MAX;
    const A = 1n << 255n;
    const B = A - 1n; // A + B == 2^256 - 1
    let table;
    let nonceBase;

    beforeAll(async () => {
      // its own vault and token: the token's total supply has to be able to reach 2^256 - 1
      const world = await deployVault(node, { arbiter: deployed.arbiter });
      world.domain = { chainId: node.chainId, verifyingContract: world.vault };
      table = await openTable(
        'huge',
        [
          { name: 'hugo', deposit: A },
          { name: 'ivy', deposit: B },
        ],
        { maxDeposit: M, world },
      );
      nonceBase = (await table.tableRow()).nonce;
    });

    const stateWith = (patch) => ({
      tableId: table.tableId,
      nonce: nonceBase + 1n,
      isFinal: false,
      players: table.players,
      balances: [0n, 0n],
      keep: [false, false],
      rake: 0n,
      volume: 0n,
      ...patch,
    });
    const check = async (state, label) =>
      sameAsContract(table, state, await table.sign(state), label);

    test('the escrow really is 2^256 - 1', async () => {
      expect((await table.tableRow()).escrow).toBe(M);
    });

    test('balances that add up to exactly the escrow are accepted; one more is a Panic, not NotConserved', async () => {
      expect(await check(stateWith({ balances: [A, B] }), 'exact')).toBe('ok');
      expect(await check(stateWith({ balances: [B, A] }), 'exact, swapped')).toBe('ok');
      expect(await check(stateWith({ balances: [A, A] }), 'one over')).toBe('Panic');
      expect(await check(stateWith({ balances: [M, M] }), 'max + max')).toBe('Panic');
      expect(await check(stateWith({ balances: [M, 1n] }), 'max + 1')).toBe('Panic');
      expect(await check(stateWith({ balances: [A, B - 1n] }), 'one short')).toBe('NotConserved');
      expect(await check(stateWith({ balances: [M, 0n] }), 'all to one seat')).toBe('ok');
    });

    test('the rake multiplication: 10_000 * rake at and above 2^256, and maxRakeBps * volume', async () => {
      const bps = 500n;
      const maxRake = M / 10_000n; // largest rake whose product with 10_000 still fits
      const maxVolume = M / bps; // largest volume whose product with maxRakeBps still fits
      // a legal-looking state with an astronomical rake: the balances give up exactly that much
      const rich = (rake, volume) => stateWith({ rake, volume, balances: [M - rake, 0n] });
      expect(await check(rich(maxRake, maxVolume), 'both at their largest fitting values')).toBe(
        'ok',
      );
      expect(await check(rich(maxRake + 1n, maxVolume), 'rake * 10000 overflows')).toBe('Panic');
      expect(await check(rich(maxRake, maxVolume + 1n), '500 * volume overflows')).toBe('Panic');
      expect(await check(rich(maxRake + 1n, maxVolume + 1n), 'both overflow')).toBe('Panic');
      expect(await check(rich(1n, M), 'volume 2^256 - 1')).toBe('Panic');
      expect(await check(rich(M, 0n), 'rake 2^256 - 1')).toBe('Panic');
      expect(
        await check(stateWith({ rake: 0n, volume: M, balances: [A, B] }), 'huge volume, no rake'),
      ).toBe('Panic');
    });

    test('RakeTooHigh at the exact cap: rake * 10_000 == maxRakeBps * volume is allowed, one more is not', async () => {
      for (const [rake, volume] of [
        [5n, 100n],
        [50n, 1000n],
        [1n, 20n],
        [123_456_789n, 2_469_135_780n],
      ]) {
        expect(
          await check(
            stateWith({ rake, volume, balances: [M - rake, 0n] }),
            `${rake}/${volume} at the cap`,
          ),
        ).toBe('ok');
        expect(
          await check(
            stateWith({ rake: rake + 1n, volume, balances: [M - rake - 1n, 0n] }),
            `${rake + 1n}/${volume} over`,
          ),
        ).toBe('RakeTooHigh');
        expect(
          await check(
            stateWith({ rake, volume: volume - 1n, balances: [M - rake, 0n] }),
            `${rake}/${volume - 1n} volume short`,
          ),
        ).toBe('RakeTooHigh');
      }
      expect(
        await check(
          stateWith({ rake: 1n, volume: 0n, balances: [M - 1n, 0n] }),
          'rake with no volume',
        ),
      ).toBe('RakeTooHigh');
    });

    test('the order of the cheap checks when several fail at once, with the biggest numbers', async () => {
      // stale nonce beats a Panic; a Panic in the cap beats NotConserved
      expect(
        await check(stateWith({ nonce: nonceBase, balances: [A, A], rake: M }), 'stale + panic'),
      ).toBe('StaleNonce');
      expect(
        await check(
          stateWith({ balances: [0n, 0n], rake: M, volume: M }),
          'cap panic before conservation',
        ),
      ).toBe('Panic');
      expect(
        await check(stateWith({ balances: [0n, 0n], rake: 0n, volume: 0n }), 'conservation only'),
      ).toBe('NotConserved');
      expect(
        await check(
          stateWith({ players: [...table.players].reverse(), balances: [A, A], rake: M }),
          'roster before everything numeric',
        ),
      ).toBe('RosterMismatch');
      expect(
        await check(
          stateWith({ keep: [false], balances: [A, A], rake: M }),
          'length before roster',
        ),
      ).toBe('BadLength');
    });

    test('a nonce at 2^64 - 1 is accepted by both, and the next one cannot exist', async () => {
      expect(await check(stateWith({ nonce: UINT64_MAX, balances: [A, B] }), 'max nonce')).toBe(
        'ok',
      );
      expect(() =>
        buildNextState({
          prev: stateWith({ nonce: UINT64_MAX, balances: [A, B] }),
          balances: [A, B],
        }),
      ).toThrow(/nonce/);
    });
  });

  // ---------------------------------------------------------------------------------------------------
  describe('a vault whose cap is 0 bps', () => {
    test('any rake at all is RakeTooHigh, whatever the volume; no rake with any volume is fine', async () => {
      const zeroVault = await deployVault(node, { arbiter: deployed.arbiter, maxRakeBps: 0 });
      const arbiter = deployed.arbiter;
      const tableId = id('zero-bps');
      const call = (account, address, abi, fn, args) => write(account, address, abi, fn, args);
      await call(arbiter, zeroVault.vault, zeroVault.vaultAbi, 'createTable', [
        tableId,
        6,
        1n,
        10n ** 30n,
      ]);
      const names = ['zed', 'yan'];
      const seats = [];
      for (const name of names) {
        const wallet = await node.account(name);
        const session = key(`zero:${name}`);
        await call(wallet, zeroVault.token, zeroVault.tokenAbi, 'mint', [
          wallet.address,
          5_000_000n,
        ]);
        await call(wallet, zeroVault.token, zeroVault.tokenAbi, 'approve', [
          zeroVault.vault,
          UINT256_MAX,
        ]);
        await call(wallet, zeroVault.vault, zeroVault.vaultAbi, 'deposit', [
          tableId,
          5_000_000n,
          privateKeyToAddress(session),
        ]);
        seats.push({ wallet, address: wallet.address.toLowerCase(), session });
      }
      const { sorted } = sortRoster(seats);
      await call(arbiter, zeroVault.vault, zeroVault.vaultAbi, 'start', [
        tableId,
        sorted.map((s) => s.address),
      ]);
      const players = sorted.map((s) => s.address);
      const zeroDomain = { chainId: node.chainId, verifyingContract: zeroVault.vault };
      const row = tableFromChain(
        await node.publicClient.readContract({
          address: zeroVault.vault,
          abi: zeroVault.vaultAbi,
          functionName: 'tables',
          args: [tableId],
        }),
      );
      const ctx = {
        domain: zeroDomain,
        maxRakeBps: await node.publicClient.readContract({
          address: zeroVault.vault,
          abi: zeroVault.vaultAbi,
          functionName: 'MAX_RAKE_BPS',
        }),
        sessionKeyOf: (address) =>
          privateKeyToAddress(sorted.find((s) => s.address === address).session),
        table: row,
      };
      expect(ctx.maxRakeBps).toBe(0);
      const gen = genesisState({ tableId, players, deposits: [5_000_000n, 5_000_000n] });
      const attempts = {
        'no rake, no volume': buildNextState({ prev: gen, balances: [5_000_000n, 5_000_000n] }),
        'no rake, a lot of volume': buildNextState({
          prev: gen,
          balances: [6_000_000n, 4_000_000n],
          volumeDelta: UINT256_MAX / 2n,
        }),
        'one unit of rake, a lot of volume': buildNextState({
          prev: gen,
          balances: [5_999_999n, 4_000_000n],
          rakeDelta: 1n,
          volumeDelta: UINT256_MAX / 2n,
        }),
        'one unit of rake, volume at the maximum': buildNextState({
          prev: gen,
          balances: [5_999_999n, 4_000_000n],
          rakeDelta: 1n,
          volumeDelta: UINT256_MAX,
        }),
      };
      const expected = {
        'no rake, no volume': 'ok',
        'no rake, a lot of volume': 'ok',
        'one unit of rake, a lot of volume': 'RakeTooHigh',
        'one unit of rake, volume at the maximum': 'RakeTooHigh',
      };
      for (const [name, state] of Object.entries(attempts)) {
        const digest = hashState(state, zeroDomain);
        const sigs = {
          arbiterSig: await arbiter.sign({ hash: digest }),
          playerSigs: sorted.map((s) => signDigest(s.session, digest)),
        };
        const mine = checkState(state, sigs, ctx);
        let theirs = null;
        try {
          await node.publicClient.simulateContract({
            address: zeroVault.vault,
            abi: zeroVault.vaultAbi,
            functionName: 'startExit',
            args: [state, sigs.arbiterSig, sigs.playerSigs],
            account: sorted[0].wallet,
          });
        } catch (error) {
          const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
          theirs = { error: reverted.data.errorName, args: reverted.data.args ?? [] };
        }
        expect(mine.ok ? null : { error: mine.error, args: mine.args }, name).toEqual(theirs);
        expect(theirs?.error ?? 'ok', name).toBe(expected[name]);
      }
    }, 60_000);
  });

  // ---------------------------------------------------------------------------------------------------
  describe('checkSettle against settle, in every table status', () => {
    const DEPOSIT = 1_000_000n * UNIT;
    const seatsOf = (prefix) =>
      ['p', 'q', 'r'].map((n) => ({ name: `${prefix}-${n}`, deposit: DEPOSIT }));
    const finalFor = (table, patch = {}) =>
      buildNextState({
        prev: genesisState({
          tableId: table.tableId,
          players: table.players,
          deposits: [DEPOSIT, DEPOSIT, DEPOSIT],
        }),
        balances: [DEPOSIT, DEPOSIT, DEPOSIT],
        final: true,
        keep: [true, true, true],
        ...patch,
      });
    const caller = async () => node.account('settle-caller');

    test('Active: NotFinal, BadKeep (first empty kept seat), and a good final', async () => {
      const table = await openTable('settle-active', seatsOf('sa'));
      const settler = await caller();
      const same = async (state, label) =>
        sameAsContract(table, state, await table.sign(state), label, {
          fn: 'settle',
          caller: settler,
        });
      const prev = genesisState({
        tableId: table.tableId,
        players: table.players,
        deposits: [DEPOSIT, DEPOSIT, DEPOSIT],
      });
      expect(await same(buildNextState({ prev, balances: prev.balances }), 'not final')).toBe(
        'NotFinal',
      );
      expect(await same(finalFor(table), 'good final, all stay')).toBe('ok');
      expect(
        await same(finalFor(table, { keep: [false, false, false] }), 'good final, all leave'),
      ).toBe('ok');
      expect(await same(finalFor(table, { keep: [true, false, true] }), 'mixed')).toBe('ok');
      const empty = (i) =>
        [DEPOSIT, DEPOSIT, DEPOSIT].map((b, j) =>
          j === i ? 0n : b + (j === (i + 1) % 3 ? DEPOSIT : 0n),
        );
      expect(
        await same(
          finalFor(table, { balances: empty(0), keep: [true, true, true] }),
          'seat 0 empty and kept',
        ),
      ).toBe('BadKeep');
      expect(
        await same(
          finalFor(table, { balances: empty(2), keep: [true, true, true] }),
          'seat 2 empty and kept',
        ),
      ).toBe('BadKeep');
      expect(
        await same(
          finalFor(table, { balances: empty(1), keep: [true, false, true] }),
          'seat 1 empty and released',
        ),
      ).toBe('ok');
      // two empty kept seats: the FIRST is reported
      const two = [3n * DEPOSIT, 0n, 0n];
      const r = await same(
        finalFor(table, { balances: two, keep: [true, true, true] }),
        'seats 1 and 2 empty and kept',
      );
      expect(r).toBe('BadKeep');
      const mine = checkSettle(
        finalFor(table, { balances: two, keep: [true, true, true] }),
        await table.sign(finalFor(table, { balances: two, keep: [true, true, true] })),
        await table.ctx(),
      );
      expect(mine.args).toEqual([1n]);
      // a verification failure beats BadKeep
      const dead = finalFor(table, { balances: two, keep: [true, true, true] });
      const sigs = await table.sign(dead);
      expect(
        await sameAsContract(
          table,
          dead,
          { ...sigs, playerSigs: [sigs.playerSigs[1], sigs.playerSigs[0], sigs.playerSigs[2]] },
          'bad sig and bad keep',
          { fn: 'settle', caller: settler },
        ),
      ).toBe('BadSignature');
    });

    test('Filling and None: WrongStatus with the status number, after NotFinal', async () => {
      const filling = await openTable('settle-filling', seatsOf('sf'), { start: false });
      const settler = await caller();
      const state = {
        tableId: filling.tableId,
        nonce: 1n,
        isFinal: true,
        players: filling.players,
        balances: [DEPOSIT, DEPOSIT, DEPOSIT],
        keep: [false, false, false],
        rake: 0n,
        volume: 0n,
      };
      const sigs = {
        arbiterSig: await deployed.arbiter.sign({ hash: hashState(state, domain) }),
        playerSigs: ['0x', '0x', '0x'],
      };
      const row = await filling.tableRow();
      expect(row.status).toBe(1);
      const ctx = { domain, maxRakeBps: 500, sessionKeyOf: () => null, table: row };
      const mine = checkSettle(state, sigs, ctx);
      const theirs = await revertOf('settle', [state, sigs.arbiterSig, sigs.playerSigs], settler);
      expect({ error: mine.error, args: mine.args }).toEqual(theirs);
      expect(theirs).toEqual({ error: 'WrongStatus', args: [1] });
      // not final first
      const notFinal = { ...state, isFinal: false };
      expect(checkSettle(notFinal, sigs, ctx).error).toBe('NotFinal');
      expect(
        (await revertOf('settle', [notFinal, sigs.arbiterSig, sigs.playerSigs], settler)).error,
      ).toBe('NotFinal');
      // a table that does not exist
      const ghost = { ...state, tableId: id('does-not-exist') };
      const ghostRow = tableFromChain(await read('tables', [ghost.tableId]));
      expect(ghostRow.status).toBe(0);
      const ghostMine = checkSettle(ghost, sigs, { ...ctx, table: ghostRow });
      const ghostTheirs = await revertOf(
        'settle',
        [ghost, sigs.arbiterSig, sigs.playerSigs],
        settler,
      );
      expect({ error: ghostMine.error, args: ghostMine.args }).toEqual(ghostTheirs);
      expect(ghostTheirs).toEqual({ error: 'WrongStatus', args: [0] });
    });

    test('Exiting is allowed (a final state can still settle a pending exit); Closed is WrongStatus(4)', async () => {
      const table = await openTable('settle-exiting', seatsOf('se'));
      const settler = await caller();
      const prev = genesisState({
        tableId: table.tableId,
        players: table.players,
        deposits: [DEPOSIT, DEPOSIT, DEPOSIT],
      });
      const hand = buildNextState({
        prev,
        balances: [DEPOSIT + 5n * UNIT, DEPOSIT - 5n * UNIT, DEPOSIT],
      });
      const handSigs = await table.sign(hand);
      await vaultWrite(table.seats[0].wallet, 'startExit', [
        hand,
        handSigs.arbiterSig,
        handSigs.playerSigs,
      ]);
      expect((await table.tableRow()).status).toBe(3);

      const final = buildNextState({
        prev: hand,
        balances: hand.balances,
        final: true,
        keep: [true, true, false],
      });
      expect(
        await sameAsContract(table, final, await table.sign(final), 'settle while exiting', {
          fn: 'settle',
          caller: settler,
        }),
      ).toBe('ok');
      // a stale one is still a stale one
      const stale = { ...final, nonce: hand.nonce };
      expect(
        await sameAsContract(table, stale, await table.sign(stale), 'stale while exiting', {
          fn: 'settle',
          caller: settler,
        }),
      ).toBe('StaleNonce');

      // close it for good: wait out the window, finalize
      await node.advance(3601);
      await vaultWrite(settler, 'finalizeExit', [hand]);
      const row = await table.tableRow();
      expect(row.status).toBe(4);
      const closed = await sameAsContract(
        table,
        final,
        await table.sign(final),
        'settle after close',
        { fn: 'settle', caller: settler },
      );
      expect(closed).toBe('WrongStatus');
    }, 60_000);
  });

  // ---------------------------------------------------------------------------------------------------
  describe('a rolled-over epoch: the baseline README.md tells the server to build', () => {
    test('REVIEW BUG: a hand on the genesisState baseline is RakeTooHigh on chain; carrying the volume makes it legal', async () => {
      const DEP = 1_000n * 100n * UNIT; // 100,000 chips each
      const table = await openTable('rollover', [
        { name: 'rolla', deposit: DEP },
        { name: 'rollb', deposit: DEP },
        { name: 'rollc', deposit: DEP },
      ]);
      const settler = await node.account('settle-caller');

      // epoch 1: one big hand, 2% rake (20,000 token units... 1,000 chips on a pot of 50,000), then a final state, everyone stays
      const g1 = genesisState({
        tableId: table.tableId,
        players: table.players,
        deposits: [DEP, DEP, DEP],
      });
      const pot = 50_000n * UNIT;
      const rake = pot / 50n; // 2%
      const hand1 = buildNextState({
        prev: g1,
        balances: [DEP + (pot / 2n - rake), DEP - pot / 2n, DEP],
        rakeDelta: rake,
        volumeDelta: pot,
      });
      const final1 = buildNextState({
        prev: hand1,
        balances: hand1.balances,
        final: true,
        keep: [true, true, true],
      });
      expect(
        await sameAsContract(table, final1, await table.sign(final1), 'epoch 1 final', {
          fn: 'settle',
          caller: settler,
        }),
      ).toBe('ok');
      await vaultWrite(settler, 'settle', [final1, ...Object.values(await table.sign(final1))]);

      // epoch 2: everyone is still seated with their balance; the arbiter starts it again
      await vaultWrite(deployed.arbiter, 'start', [table.tableId, table.players]);
      const row = await table.tableRow();
      expect(row.status).toBe(2);
      expect(row.nonce).toBe(final1.nonce);
      expect(row.rakePaid).toBe(rake);

      // the baseline exactly as README.md describes it for a rolled-over epoch: { nonce, rake } and nothing else
      const g2 = genesisState({
        tableId: table.tableId,
        players: table.players,
        deposits: final1.balances,
        nonce: row.nonce,
        rake: row.rakePaid,
      });
      const pot2 = 2_000n * UNIT;
      const rake2 = pot2 / 50n;
      const next = (volume) => ({
        ...buildNextState({
          prev: g2,
          balances: [
            g2.balances[0] + (pot2 / 2n - rake2),
            g2.balances[1] - pot2 / 2n,
            g2.balances[2],
          ],
          rakeDelta: rake2,
          volumeDelta: pot2,
        }),
        ...(volume === undefined ? {} : { volume }),
      });
      const asBuilt = next();
      expect(asBuilt.volume).toBe(pot2); // volume restarted at zero
      expect(
        await sameAsContract(
          table,
          asBuilt,
          await table.sign(asBuilt),
          'a 2% hand on the README baseline',
        ),
      ).toBe('RakeTooHigh');

      // the same hand with the cumulative volume of the whole table (epoch 1 + this hand) is legal
      const carried = next(final1.volume + pot2);
      expect(
        await sameAsContract(
          table,
          carried,
          await table.sign(carried),
          'the same hand, volume carried',
        ),
      ).toBe('ok');
      // and the baseline the library hands out cannot say so: there is no way to ask genesisState for it
      const asked = genesisState({
        tableId: table.tableId,
        players: table.players,
        deposits: final1.balances,
        nonce: row.nonce,
        rake: row.rakePaid,
        volume: final1.volume,
      });
      expect(asked.volume).toBe(final1.volume);
    }, 60_000);
  });

  // ---------------------------------------------------------------------------------------------------
  describe('a seat whose session key is the arbiter’s address, and two seats sharing a session key', () => {
    test('the contract takes the arbiter’s signature for that seat, and so does the library; shared keys likewise', async () => {
      const arbiterAddress = deployed.arbiter.address;
      const sharedKey = key('shared-session');
      const table = await openTable('odd-keys', [
        { name: 'odd-a', deposit: 5_000_000n, sessionAddress: arbiterAddress },
        { name: 'odd-b', deposit: 5_000_000n, session: sharedKey },
        { name: 'odd-c', deposit: 5_000_000n, session: sharedKey },
      ]);
      const gen = genesisState({
        tableId: table.tableId,
        players: table.players,
        deposits: [5_000_000n, 5_000_000n, 5_000_000n],
      });
      const state = buildNextState({ prev: gen, balances: [5_100_000n, 4_900_000n, 5_000_000n] });
      const digest = hashState(state, domain);
      const arbiterSig = await deployed.arbiter.sign({ hash: digest });
      const shared = signDigest(sharedKey, digest);
      // slots: the arbiter-keyed seat gets the ARBITER's signature, the two shared-key seats get one signature each
      const playerSigs = table.seats.map((seat) => (seat.sessionAddress ? arbiterSig : shared));
      expect(table.seats.filter((s) => s.sessionAddress)).toHaveLength(1);
      expect(
        await sameAsContract(
          table,
          state,
          { arbiterSig, playerSigs },
          'arbiter signs as a player; one key signs for two seats',
        ),
      ).toBe('ok');
      // without the arbiter's signature in that slot, the seat is unsigned
      const wrong = table.seats.map((seat) => (seat.sessionAddress ? shared : shared));
      expect(
        await sameAsContract(
          table,
          state,
          { arbiterSig, playerSigs: wrong },
          'the arbiter-keyed seat given a shared-key signature',
        ),
      ).toBe('BadSignature');
    }, 60_000);
  });
});
