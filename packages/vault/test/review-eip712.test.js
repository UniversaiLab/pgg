// Adversarial review of the hand-written EIP-712 encoder. The existing tests lean on random states; these
// use hand-picked states that sit on every boundary the encoding has (full-word bools, left padding of
// addresses, empty arrays, widest numbers), compare with TWO independent encoders (viem's hashTypedData and
// a plain abi.encode / encodePacked rebuild of the contract's _hashState), and read the type string out of
// PokerVault.sol itself instead of a copy of it.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { STATE_TYPES, VAULT_NAME, VAULT_VERSION } from '@pgg/protocol/vault';
import {
  concat,
  encodeAbiParameters,
  encodePacked,
  getTypesForEIP712Domain,
  hashDomain,
  hashTypedData,
  keccak256,
  toHex,
} from 'viem';
import {
  DOMAIN_TYPEHASH,
  domainSeparator,
  hashState,
  hashStruct,
  STATE_TYPE_STRING,
  STATE_TYPEHASH,
} from '../src/eip712.js';
import { makeRng, randomDomain, randomState, UINT64_MAX, UINT256_MAX } from './gen.js';

const SOL = readFileSync(new URL('../../../contracts/src/PokerVault.sol', import.meta.url), 'utf8');
const addr = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const word = (hex) => `0x${hex.repeat(32)}`;
const DOMAIN = { chainId: 31337, verifyingContract: '0x00000000000000000000000000000000000dead1' };

/** The digest through viem. Typed-data messages are not checked for roster order, so any State is fine. */
const viemDigest = (state, domain) =>
  hashTypedData({
    domain: {
      name: VAULT_NAME,
      version: VAULT_VERSION,
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract,
    },
    types: STATE_TYPES,
    primaryType: 'State',
    message: {
      ...state,
      players: state.players.map((p) => p.toLowerCase()),
    },
  });

/** The contract's _hashState, spelled out with viem's ABI encoder: no shared code with eip712.js. */
function soliditySpelling(state, domain) {
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint64' },
        { type: 'bool' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'uint256' },
      ],
      [
        keccak256(toHex(STATE_TYPE_STRING)),
        state.tableId,
        state.nonce,
        state.isFinal,
        keccak256(encodePacked(['address[]'], [state.players])),
        keccak256(encodePacked(['uint256[]'], [state.balances])),
        keccak256(encodePacked(['bool[]'], [state.keep])),
        state.rake,
        state.volume,
      ],
    ),
  );
  const separator = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
      ],
      [
        keccak256(
          toHex(
            'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)',
          ),
        ),
        keccak256(toHex('PGG PokerVault')),
        keccak256(toHex('1')),
        BigInt(domain.chainId),
        domain.verifyingContract,
      ],
    ),
  );
  return keccak256(concat(['0x1901', separator, structHash]));
}

const base = () => ({
  tableId: word('11'),
  nonce: 1n,
  isFinal: false,
  players: [addr(1n), addr(2n), addr(3n)],
  balances: [1n, 2n, 3n],
  keep: [false, false, false],
  rake: 0n,
  volume: 0n,
});

// States chosen to sit on a boundary of the encoding, not to look typical.
const nasty = {
  'everything zero except the roster': {
    ...base(),
    tableId: word('00'),
    nonce: 0n,
    balances: [0n, 0n, 0n],
  },
  'every number at its maximum': {
    ...base(),
    tableId: word('ff'),
    nonce: UINT64_MAX,
    isFinal: true,
    players: [addr((1n << 160n) - 3n), addr((1n << 160n) - 2n), addr((1n << 160n) - 1n)],
    balances: [UINT256_MAX, UINT256_MAX, UINT256_MAX],
    keep: [true, true, true],
    rake: UINT256_MAX,
    volume: UINT256_MAX,
  },
  'a bool true in the last slot only': { ...base(), keep: [false, false, true] },
  'a bool true in the first slot only, with isFinal': {
    ...base(),
    isFinal: true,
    keep: [true, false, false],
  },
  'addresses whose top bytes are zero and whose low byte is high': {
    ...base(),
    players: [addr(0xffn), addr(0x100n), addr(0xffffn)],
  },
  'addresses with the high bit set (a sign-extension trap)': {
    ...base(),
    players: [addr(1n << 159n), addr((1n << 159n) + 1n), addr((1n << 160n) - 1n)],
  },
  'nonce one below and exactly at 2^63': { ...base(), nonce: (1n << 63n) - 1n },
  'nonce exactly 2^63 (uint64 sign bit)': { ...base(), nonce: 1n << 63n },
  'balances that straddle 2^128': {
    ...base(),
    balances: [(1n << 128n) - 1n, 1n << 128n, (1n << 128n) + 1n],
  },
  'two players': {
    ...base(),
    players: [addr(1n), addr(2n)],
    balances: [5n, 6n],
    keep: [true, false],
  },
  'ten players': {
    ...base(),
    players: Array.from({ length: 10 }, (_, i) => addr(BigInt(i + 1) << 100n)),
    balances: Array.from({ length: 10 }, (_, i) => BigInt(i) * 10n ** 18n),
    keep: Array.from({ length: 10 }, (_, i) => i % 3 === 0),
  },
  // The contract hashes whatever it is given: states that other checks will reject must still hash alike.
  'empty arrays (the contract would hash them)': { ...base(), players: [], balances: [], keep: [] },
  'array lengths that disagree': { ...base(), balances: [1n], keep: [true, false, true, false] },
  'duplicate players': { ...base(), players: [addr(7n), addr(7n), addr(7n)] },
  'the zero address among the players': { ...base(), players: [addr(0n), addr(1n), addr(2n)] },
  'descending players': { ...base(), players: [addr(9n), addr(5n), addr(1n)] },
};

describe('the type string comes from the contract, not from a copy of it', () => {
  test('STATE_TYPE_STRING is the literal inside PokerVault.STATE_TYPEHASH', () => {
    const literal = SOL.match(/STATE_TYPEHASH\s*=\s*keccak256\(\s*"([^"]+)"\s*\)/);
    expect(literal).not.toBeNull();
    expect(STATE_TYPE_STRING).toBe(literal[1]);
    expect(STATE_TYPEHASH).toBe(keccak256(toHex(literal[1])));
  });

  test('the domain name and version are the ones the constructor passes to EIP712(...)', () => {
    const ctor = SOL.match(/EIP712\(\s*"([^"]*)"\s*,\s*"([^"]*)"\s*\)/);
    expect(ctor).not.toBeNull();
    expect([VAULT_NAME, VAULT_VERSION]).toEqual([ctor[1], ctor[2]]);
  });

  test('the field order in STATE_TYPES is the order of the Solidity struct', () => {
    const body = SOL.match(/struct State \{([^}]*)\}/)[1];
    const fields = [...body.matchAll(/^\s*([\w[\]]+)\s+(\w+);/gm)].map((m) => [m[1], m[2]]);
    expect(STATE_TYPES.State.map((f) => [f.type, f.name])).toEqual(fields);
  });

  test('the domain typehash is the standard four-field EIP712Domain', () => {
    expect(DOMAIN_TYPEHASH).toBe(
      keccak256(
        toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
      ),
    );
  });
});

describe('boundary states: library == viem == a plain abi.encode spelling of _hashState', () => {
  for (const [name, state] of Object.entries(nasty)) {
    test(name, () => {
      const mine = hashState(state, DOMAIN);
      expect(mine).toBe(viemDigest(state, DOMAIN));
      expect(mine).toBe(soliditySpelling(state, DOMAIN));
    });
  }

  test('the same holds under hostile domains: chain id at the edges, vault with zero and 0xff bytes', () => {
    const state = nasty['every number at its maximum'];
    const domains = [
      { chainId: 1, verifyingContract: addr(1n) },
      { chainId: 2 ** 31, verifyingContract: addr((1n << 160n) - 1n) },
      { chainId: 2 ** 32, verifyingContract: addr(1n << 159n) },
      {
        chainId: Number.MAX_SAFE_INTEGER,
        verifyingContract: addr(0xdead00000000000000000000000000000000beefn),
      },
      {
        chainId: 137n,
        verifyingContract: DOMAIN.verifyingContract.toUpperCase().replace('0X', '0x'),
      },
    ];
    for (const d of domains) {
      const asNumber = {
        ...d,
        chainId: Number(d.chainId),
        verifyingContract: d.verifyingContract.toLowerCase(),
      };
      expect(hashState(state, d)).toBe(soliditySpelling(state, asNumber));
      expect(hashState(state, d)).toBe(viemDigest(state, asNumber));
      const typed = {
        name: VAULT_NAME,
        version: VAULT_VERSION,
        chainId: asNumber.chainId,
        verifyingContract: asNumber.verifyingContract,
      };
      expect(domainSeparator(d)).toBe(
        hashDomain({
          domain: typed,
          types: { EIP712Domain: getTypesForEIP712Domain({ domain: typed }) },
        }),
      );
    }
  });

  test('1500 more seeded random states, now through the plain abi.encode spelling as well', () => {
    const rng = makeRng(0xbeef);
    for (let i = 0; i < 1500; i++) {
      const state = randomState(rng);
      const domain = randomDomain(rng);
      expect(hashState(state, domain)).toBe(soliditySpelling(state, domain));
    }
  });
});

describe('every input matters: change one thing, get another digest', () => {
  const d0 = hashState(base(), DOMAIN);
  const variants = {
    tableId: (s) => ({ ...s, tableId: word('12') }),
    'tableId last bit': (s) => ({ ...s, tableId: `0x${'11'.repeat(31)}10` }),
    nonce: (s) => ({ ...s, nonce: 2n }),
    isFinal: (s) => ({ ...s, isFinal: true }),
    'players[0]': (s) => ({ ...s, players: [addr(4n), s.players[1], s.players[2]] }),
    'players[2]': (s) => ({ ...s, players: [s.players[0], s.players[1], addr(4n)] }),
    'balances[0]': (s) => ({ ...s, balances: [2n, 2n, 3n] }),
    'balances[2]': (s) => ({ ...s, balances: [1n, 2n, 4n] }),
    'balances swapped': (s) => ({ ...s, balances: [2n, 1n, 3n] }),
    'keep[0]': (s) => ({ ...s, keep: [true, false, false] }),
    'keep[1]': (s) => ({ ...s, keep: [false, true, false] }),
    'keep[2]': (s) => ({ ...s, keep: [false, false, true] }),
    rake: (s) => ({ ...s, rake: 1n }),
    volume: (s) => ({ ...s, volume: 1n }),
    'one more player': (s) => ({
      ...s,
      players: [...s.players, addr(4n)],
      balances: [...s.balances, 0n],
      keep: [...s.keep, false],
    }),
  };
  for (const [name, change] of Object.entries(variants)) {
    test(name, () => {
      const changed = hashState(change(base()), DOMAIN);
      expect(changed).not.toBe(d0);
      expect(changed).toBe(soliditySpelling(change(base()), DOMAIN)); // and not just different: right
    });
  }

  test('chain id and vault address', () => {
    expect(hashState(base(), { ...DOMAIN, chainId: 31338 })).not.toBe(d0);
    expect(hashState(base(), { ...DOMAIN, verifyingContract: addr(0xdead2n) })).not.toBe(d0);
  });

  test('the structHash alone changes with every field, so a domain bug cannot hide a struct bug', () => {
    const s0 = hashStruct(base());
    for (const change of Object.values(variants)) expect(hashStruct(change(base()))).not.toBe(s0);
  });
});

describe('what hashStruct and hashState refuse', () => {
  const bad = (patch) => () => hashState({ ...base(), ...patch }, DOMAIN);

  test('numbers outside their type', () => {
    expect(bad({ nonce: UINT64_MAX + 1n })).toThrow(RangeError);
    expect(bad({ nonce: -1n })).toThrow(RangeError);
    expect(bad({ rake: UINT256_MAX + 1n })).toThrow(RangeError);
    expect(bad({ volume: -1n })).toThrow(RangeError);
    expect(bad({ balances: [1n, UINT256_MAX + 1n, 3n] })).toThrow(RangeError);
    expect(bad({ balances: [1n, -1n, 3n] })).toThrow(RangeError);
  });

  test('values that are not what the type says: a hash must never be computed from a coerced guess', () => {
    expect(bad({ isFinal: 1 })).toThrow(RangeError);
    expect(bad({ isFinal: 'true' })).toThrow(RangeError);
    expect(bad({ keep: [1, 0, 1] })).toThrow(RangeError);
    expect(bad({ keep: [false, 'false', false] })).toThrow(RangeError);
    expect(bad({ nonce: '1' })).toThrow(RangeError);
    expect(bad({ nonce: 1.5 })).toThrow(RangeError);
    expect(bad({ nonce: Number.NaN })).toThrow(RangeError);
    expect(bad({ nonce: 2 ** 53 })).toThrow(RangeError); // beyond the safe integers: already rounded
    expect(bad({ rake: undefined })).toThrow(RangeError);
    expect(bad({ players: undefined })).toThrow(RangeError);
    expect(bad({ players: 'abc' })).toThrow(RangeError);
    expect(bad({ tableId: `0x${'11'.repeat(31)}` })).toThrow(RangeError);
    expect(bad({ tableId: `0x${'11'.repeat(33)}` })).toThrow(RangeError);
    expect(bad({ tableId: '11'.repeat(32) })).toThrow(RangeError);
    expect(bad({ players: [addr(1n).slice(0, 41), addr(2n), addr(3n)] })).toThrow(RangeError);
    expect(bad({ players: [`${addr(1n)}00`, addr(2n), addr(3n)] })).toThrow(RangeError);
    expect(() => hashState(null, DOMAIN)).toThrow(RangeError);
  });

  test('a domain that cannot be the contract’s', () => {
    for (const chainId of [0, -1, 1.5, '1', Number.NaN, 2 ** 53, 2n ** 64n, null, undefined]) {
      expect(() => hashState(base(), { ...DOMAIN, chainId }), String(chainId)).toThrow(RangeError);
    }
    expect(() => hashState(base(), { ...DOMAIN, verifyingContract: addr(1n).slice(2) })).toThrow(
      RangeError,
    );
    expect(() => hashState(base(), null)).toThrow(RangeError);
  });

  test('inputs are never mutated and the result does not depend on whether they are frozen', () => {
    const deepFreeze = (o) => {
      for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
      return Object.freeze(o);
    };
    const frozen = deepFreeze(base());
    const frozenDomain = deepFreeze({ ...DOMAIN });
    expect(hashState(frozen, frozenDomain)).toBe(hashState(base(), DOMAIN));
    expect(frozen).toEqual(base());
  });

  test('a number that is a safe integer hashes like the same bigint', () => {
    expect(
      hashState({ ...base(), nonce: 5, balances: [1, 2, 3], rake: 7, volume: 9 }, DOMAIN),
    ).toBe(
      hashState({ ...base(), nonce: 5n, balances: [1n, 2n, 3n], rake: 7n, volume: 9n }, DOMAIN),
    );
  });
});

describe('STATE_TYPES is the single source: a child process changes it and the library follows', () => {
  const root = new URL('..', import.meta.url).pathname;
  const run = (script) => {
    const out = Bun.spawnSync([process.execPath, '-e', script], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(out.exitCode, new TextDecoder().decode(out.stderr)).toBe(0);
    return JSON.parse(new TextDecoder().decode(out.stdout));
  };
  // STATE_TYPES is frozen, so a child cannot edit it. It serves an edited COPY under the same specifier
  // instead (a Bun plugin), which is what "the library is driven by STATE_TYPES and nothing else" needs.
  const protocolFile = Bun.resolveSync('@pgg/protocol/vault', root);
  const withTypes = (edit) => `
    const real = await import(${JSON.stringify(protocolFile)});
    const types = { State: real.STATE_TYPES.State.map((f) => ({ ...f })) };
    ${edit}
    Bun.plugin({ setup(build) { build.module('@pgg/protocol/vault', () => ({ exports: { ...real, STATE_TYPES: types }, loader: 'object' })); } });
  `;
  const state = `{ tableId: '0x' + '11'.repeat(32), nonce: 1n, isFinal: true, players: ['0x' + '00'.repeat(19) + '01', '0x' + '00'.repeat(19) + '02'], balances: [1n, 2n], keep: [true, false], rake: 3n, volume: 4n }`;

  test('swapping two fields before eip712.js loads changes the type string, the typehash and the digest', () => {
    const swapped = run(`
      ${withTypes('[types.State[1], types.State[2]] = [types.State[2], types.State[1]];')}
      const E = await import('${root}src/eip712.js');
      const s = ${state};
      process.stdout.write(JSON.stringify({ type: E.STATE_TYPE_STRING, hash: E.STATE_TYPEHASH, digest: E.hashState(s, { chainId: 1, verifyingContract: '0x' + '00'.repeat(19) + '01' }) }));
    `);
    expect(swapped.type).toBe(
      'State(bytes32 tableId,bool isFinal,uint64 nonce,address[] players,uint256[] balances,bool[] keep,uint256 rake,uint256 volume)',
    );
    expect(swapped.hash).toBe(keccak256(toHex(swapped.type)));
    expect(swapped.hash).not.toBe(STATE_TYPEHASH);
    const untouched = run(`
      const E = await import('${root}src/eip712.js');
      const s = ${state};
      process.stdout.write(JSON.stringify({ digest: E.hashState(s, { chainId: 1, verifyingContract: '0x' + '00'.repeat(19) + '01' }) }));
    `);
    expect(swapped.digest).not.toBe(untouched.digest);
  });

  test('a field type the encoder cannot do is refused at load, not hashed wrongly', () => {
    const out = Bun.spawnSync(
      [
        process.execPath,
        '-e',
        `
        ${withTypes("types.State.push({ name: 'extra', type: 'bytes' });")}
        try { await import('${root}src/eip712.js'); process.stdout.write('loaded'); } catch (e) { process.stdout.write('refused: ' + e.message); }
      `,
      ],
      { cwd: root, stdout: 'pipe', stderr: 'pipe' },
    );
    expect(new TextDecoder().decode(out.stdout)).toMatch(
      /^refused: eip712\.js cannot encode bytes extra/,
    );
  });

  test('REVIEW GAP (nit, in @pgg/protocol): STATE_TYPES is a plain mutable object; changing it after eip712.js loaded makes hashStruct disagree with STATE_TYPEHASH', () => {
    // Fixed in packages/protocol/src/vault.js (outside this package): the table is frozen all the way down.
    const frozen = run(`
        import { STATE_TYPES } from '@pgg/protocol/vault';
        process.stdout.write(JSON.stringify({ outer: Object.isFrozen(STATE_TYPES), inner: Object.isFrozen(STATE_TYPES.State) }));
      `);
    expect(frozen).toEqual({ outer: true, inner: true });
  });
});
