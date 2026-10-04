import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { STATE_TYPES, stateTypedData } from '@pgg/protocol/vault';
import { getTypesForEIP712Domain, hashDomain, hashTypedData, keccak256, toHex } from 'viem';
import {
  DOMAIN_TYPEHASH,
  domainSeparator,
  domainsEqual,
  hashState,
  hashStruct,
  normalizeDomain,
  STATE_TYPE_STRING,
  STATE_TYPEHASH,
} from '../src/eip712.js';
import {
  makeRng,
  randomDomain,
  randomRoster,
  randomState,
  UINT64_MAX,
  UINT256_MAX,
} from './gen.js';

const vector = JSON.parse(
  readFileSync(new URL('../../../contracts/test/vectors/state.json', import.meta.url), 'utf8'),
);
const vectorDomain = { chainId: vector.chainId, verifyingContract: vector.vault };

const viemDigest = (state, domain) => hashTypedData(stateTypedData(state, domain));

describe('contract vector (checked by the Foundry tests too)', () => {
  test('type string and typehash', () => {
    expect(STATE_TYPE_STRING).toBe(
      'State(bytes32 tableId,uint64 nonce,bool isFinal,address[] players,uint256[] balances,bool[] keep,uint256 rake,uint256 volume)',
    );
    expect(STATE_TYPEHASH).toBe(vector.stateTypehash);
    expect(STATE_TYPEHASH).toBe(keccak256(toHex(STATE_TYPE_STRING)));
  });

  test('domain separator', () => {
    expect(domainSeparator(vectorDomain)).toBe(vector.domainSeparator);
  });

  test('digest, from the mixed-case addresses and plain numbers the vector file holds', () => {
    expect(hashState(vector.state, vectorDomain)).toBe(vector.digest);
  });

  test('the digest does not depend on the case of the addresses', () => {
    const upper = {
      ...vector.state,
      tableId: vector.state.tableId.toUpperCase().replace('0X', '0x'),
      players: vector.state.players.map((p) => `0x${p.slice(2).toUpperCase()}`),
    };
    const d = {
      chainId: vector.chainId,
      verifyingContract: vector.vault.toUpperCase().replace('0X', '0x'),
    };
    expect(hashState(upper, d)).toBe(vector.digest);
  });
});

describe('domain', () => {
  test('domainTypehash is the standard EIP712Domain with the four fields the contract uses', () => {
    expect(DOMAIN_TYPEHASH).toBe(
      keccak256(
        toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
      ),
    );
  });

  test('domainSeparator equals viem for 100 random domains', () => {
    const rng = makeRng(7);
    for (let i = 0; i < 100; i++) {
      const d = randomDomain(rng);
      const typed = stateTypedData(randomState(rng), d);
      const expected = hashDomain({
        domain: typed.domain,
        types: { EIP712Domain: getTypesForEIP712Domain({ domain: typed.domain }) },
      });
      expect(domainSeparator(d)).toBe(expected);
    }
  });

  test('normalizeDomain lowercases, takes bigint chain ids, and rejects bad ones', () => {
    expect(normalizeDomain({ chainId: 137n, verifyingContract: `0x${'AB'.repeat(20)}` })).toEqual({
      chainId: 137,
      verifyingContract: `0x${'ab'.repeat(20)}`,
    });
    for (const chainId of [0, -1, 1.5, '1', 2 ** 53, null, undefined]) {
      expect(() => normalizeDomain({ chainId, verifyingContract: vector.vault })).toThrow(
        RangeError,
      );
    }
    expect(() => normalizeDomain({ chainId: 1, verifyingContract: '0x1234' })).toThrow(RangeError);
    expect(() => normalizeDomain(null)).toThrow(RangeError);
  });

  test('domainsEqual compares chain and contract only, ignoring case, and never throws', () => {
    const a = { chainId: 1, verifyingContract: `0x${'ab'.repeat(20)}` };
    expect(domainsEqual(a, { chainId: 1n, verifyingContract: `0x${'AB'.repeat(20)}` })).toBe(true);
    expect(domainsEqual(a, { ...a, chainId: 2 })).toBe(false);
    expect(domainsEqual(a, { ...a, verifyingContract: `0x${'ac'.repeat(20)}` })).toBe(false);
    expect(domainsEqual(a, null)).toBe(false);
  });
});

describe('hashState equals viem hashTypedData', () => {
  test('on 600 seeded random states with 2 to 10 players', () => {
    const rng = makeRng(20240601);
    for (let i = 0; i < 600; i++) {
      const state = randomState(rng);
      const domain = randomDomain(rng);
      expect(hashState(state, domain)).toBe(viemDigest(state, domain));
    }
  });

  test('on edge values: nonce 2^64-1, amounts 2^256-1, zeros, 2 and 10 players', () => {
    const rng = makeRng(99);
    const domain = { chainId: 56, verifyingContract: rng.hex(20) };
    for (const n of [2, 10]) {
      const players = randomRoster(rng, n);
      const all = (value) => players.map(() => value);
      const states = [
        {
          tableId: rng.hex(32),
          nonce: UINT64_MAX,
          isFinal: true,
          players,
          balances: all(UINT256_MAX),
          keep: all(true),
          rake: UINT256_MAX,
          volume: UINT256_MAX,
        },
        {
          tableId: `0x${'00'.repeat(32)}`,
          nonce: 0n,
          isFinal: false,
          players,
          balances: all(0n),
          keep: all(false),
          rake: 0n,
          volume: 0n,
        },
        {
          tableId: `0x${'ff'.repeat(32)}`,
          nonce: 1n,
          isFinal: false,
          players,
          balances: players.map((_, i) => (i % 2 ? 0n : UINT256_MAX)),
          keep: players.map((_, i) => i % 2 === 0),
          rake: 1n,
          volume: 1n,
        },
      ];
      for (const state of states) expect(hashState(state, domain)).toBe(viemDigest(state, domain));
    }
  });

  test('hashStruct equals the struct hash inside the vector digest', () => {
    // digest = keccak(0x1901 || domainSeparator || structHash), so rebuilding it from our pieces must work
    const rebuilt = keccak256(
      `0x1901${vector.domainSeparator.slice(2)}${hashStruct(vector.state).slice(2)}`,
    );
    expect(rebuilt).toBe(vector.digest);
  });

  test('changing any one field, or the domain, changes the digest', () => {
    const rng = makeRng(5);
    const base = randomState(rng, { players: 4 });
    const domain = { chainId: 1, verifyingContract: rng.hex(20) };
    const digest = hashState(base, domain);
    const swap = (list, i, value) => list.map((x, j) => (j === i ? value : x));
    const variants = {
      tableId: { ...base, tableId: rng.hex(32) },
      nonce: { ...base, nonce: base.nonce ^ 1n },
      isFinal: { ...base, isFinal: !base.isFinal },
      players: { ...base, players: swap(base.players, 3, `0x${'ff'.repeat(20)}`) },
      'balances[0]': { ...base, balances: swap(base.balances, 0, base.balances[0] ^ 1n) },
      'balances[3]': { ...base, balances: swap(base.balances, 3, base.balances[3] ^ 1n) },
      'keep[2]': { ...base, keep: swap(base.keep, 2, !base.keep[2]) },
      rake: { ...base, rake: base.rake ^ 1n },
      volume: { ...base, volume: base.volume ^ 1n },
    };
    for (const [name, variant] of Object.entries(variants)) {
      expect(hashState(variant, domain), name).not.toBe(digest);
    }
    expect(hashState(base, { ...domain, chainId: 2 })).not.toBe(digest);
    expect(hashState(base, { ...domain, verifyingContract: rng.hex(20) })).not.toBe(digest);
  });

  test('hashes states that the contract would reject later, since the contract hashes whatever it gets', () => {
    // unsorted roster and mismatched array lengths still hash (checkState reports them in order)
    const rng = makeRng(11);
    const state = randomState(rng, { players: 3 });
    const odd = {
      ...state,
      players: [...state.players].reverse(),
      balances: state.balances.slice(1),
    };
    expect(typeof hashState(odd, vectorDomain)).toBe('string');
  });

  test('refuses what cannot be encoded', () => {
    const rng = makeRng(3);
    const ok = randomState(rng, { players: 2 });
    const bad = [
      { ...ok, nonce: UINT64_MAX + 1n },
      { ...ok, nonce: -1n },
      { ...ok, rake: UINT256_MAX + 1n },
      { ...ok, balances: [UINT256_MAX + 1n, 0n] },
      { ...ok, tableId: '0x1234' },
      { ...ok, players: [ok.players[0], '0x1234'] },
      { ...ok, keep: [1, 0] },
      { ...ok, isFinal: 'yes' },
      { ...ok, volume: 1.5 },
    ];
    for (const state of bad) expect(() => hashState(state, vectorDomain)).toThrow(RangeError);
  });

  test('the encoder follows STATE_TYPES: every field of the protocol type is hashed', () => {
    expect(STATE_TYPES.State.map((f) => f.name)).toEqual([
      'tableId',
      'nonce',
      'isFinal',
      'players',
      'balances',
      'keep',
      'rake',
      'volume',
    ]);
  });
});
