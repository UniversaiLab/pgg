import { describe, expect, test } from 'bun:test';
import { concat, encodePacked, keccak256, pad, toHex } from 'viem';
import { hashState } from '../src/eip712.js';
import { claimDigest, recoverClaim, signClaim, tableKeyFor, verifyClaim } from '../src/ids.js';
import { newPrivateKey, privateKeyToAddress } from '../src/sign.js';
import { makeWorld } from './fixtures.js';

const VAULT = '0x00000000000000000000000000000000000dead1';
const key = { chainId: 31337, vault: VAULT, serverId: 'pgg-1', generation: 3 };

describe('tableKeyFor', () => {
  test('is keccak256 of the documented string', () => {
    expect(tableKeyFor(key)).toBe(keccak256(toHex(`pgg:31337:${VAULT}:pgg-1:3`)));
    expect(tableKeyFor(key)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test('is deterministic and lowercases the vault', () => {
    expect(tableKeyFor(key)).toBe(tableKeyFor({ ...key }));
    expect(tableKeyFor({ ...key, vault: VAULT.toUpperCase().replace('0X', '0x') })).toBe(
      tableKeyFor(key),
    );
    expect(tableKeyFor({ ...key, generation: 3n })).toBe(tableKeyFor(key));
  });

  test('changes when any single input changes', () => {
    const base = tableKeyFor(key);
    const seen = new Set([base]);
    for (const patch of [
      { chainId: 137 },
      { vault: '0x00000000000000000000000000000000000dead2' },
      { serverId: 'pgg-2' },
      { serverId: 'PGG-1' },
      { generation: 4 },
      { generation: 0 },
    ]) {
      const other = tableKeyFor({ ...key, ...patch });
      expect(other).not.toBe(base);
      seen.add(other);
    }
    expect(seen.size).toBe(7);
  });

  test('refuses inputs that would make two tables share a key or are not names', () => {
    for (const patch of [
      { serverId: '' },
      { serverId: 'a:b' },
      { serverId: 5 },
      { generation: -1 },
      { generation: 1.5 },
      { generation: '3' },
      { generation: undefined },
      { vault: '0x1234' },
      { chainId: 0 },
      { chainId: '1' },
    ]) {
      expect(() => tableKeyFor({ ...key, ...patch })).toThrow(RangeError);
    }
  });
});

describe('claimDigest', () => {
  const claim = {
    domain: { chainId: 31337, verifyingContract: VAULT },
    tableKey: tableKeyFor(key),
    address: `0x${'ab'.repeat(20)}`,
    playerId: 'player-7',
  };

  test('is keccak256 of the documented byte layout', () => {
    const expected = keccak256(
      encodePacked(
        ['string', 'uint256', 'address', 'bytes32', 'address', 'string'],
        ['PGG claim v1', 31337n, VAULT, claim.tableKey, claim.address, 'player-7'],
      ),
    );
    expect(claimDigest(claim)).toBe(expected);
    // spelled out byte by byte as well, so the layout is pinned down independently of encodePacked
    const manual = keccak256(
      concat([
        toHex('PGG claim v1'),
        pad(toHex(31337), { size: 32 }),
        VAULT,
        claim.tableKey,
        claim.address,
        toHex('player-7'),
      ]),
    );
    expect(claimDigest(claim)).toBe(manual);
  });

  test('is deterministic and ignores address case', () => {
    expect(claimDigest(claim)).toBe(claimDigest({ ...claim }));
    expect(
      claimDigest({ ...claim, address: claim.address.toUpperCase().replace('0X', '0x') }),
    ).toBe(claimDigest(claim));
  });

  test('changes when any single input changes', () => {
    const base = claimDigest(claim);
    const variants = [
      { domain: { ...claim.domain, chainId: 1 } },
      {
        domain: {
          ...claim.domain,
          verifyingContract: '0x00000000000000000000000000000000000dead2',
        },
      },
      { tableKey: tableKeyFor({ ...key, generation: 4 }) },
      { address: `0x${'ac'.repeat(20)}` },
      { playerId: 'player-8' },
      { playerId: 'player-7 ' },
      { playerId: 'Player-7' },
    ];
    const digests = variants.map((v) => claimDigest({ ...claim, ...v }));
    for (const d of digests) expect(d).not.toBe(base);
    expect(new Set([base, ...digests]).size).toBe(variants.length + 1);
  });

  test('is never a State digest', () => {
    const world = makeWorld({ seed: 2 });
    expect(claimDigest(claim)).not.toBe(hashState(world.genesis, claim.domain));
  });

  test('refuses malformed inputs', () => {
    expect(() => claimDigest({ ...claim, tableKey: '0x12' })).toThrow(RangeError);
    expect(() => claimDigest({ ...claim, address: '0x12' })).toThrow(RangeError);
    expect(() => claimDigest({ ...claim, playerId: '' })).toThrow(RangeError);
    expect(() => claimDigest({ ...claim, playerId: 5 })).toThrow(RangeError);
    expect(() => claimDigest({ ...claim, domain: null })).toThrow(RangeError);
  });
});

describe('signClaim / recoverClaim / verifyClaim', () => {
  const sessionKey = newPrivateKey();
  const sessionAddress = privateKeyToAddress(sessionKey);
  const claim = {
    domain: { chainId: 31337, verifyingContract: VAULT },
    tableKey: tableKeyFor(key),
    address: `0x${'cd'.repeat(20)}`,
    playerId: 'p-1',
  };

  test('the signer is recovered, and only that key verifies', () => {
    const sig = signClaim(sessionKey, claim);
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
    expect(recoverClaim(claim, sig)).toBe(sessionAddress);
    expect(verifyClaim(claim, sig, sessionAddress)).toBe(true);
    expect(verifyClaim(claim, sig, sessionAddress.toUpperCase().replace('0X', '0x'))).toBe(true);
    expect(verifyClaim(claim, sig, privateKeyToAddress(newPrivateKey()))).toBe(false);
    expect(verifyClaim(claim, sig, null)).toBe(false);
    expect(verifyClaim(claim, sig, undefined)).toBe(false);
  });

  test('signing is deterministic', () => {
    expect(signClaim(sessionKey, claim)).toBe(signClaim(sessionKey, claim));
  });

  test('a signature does not carry over to another claim', () => {
    const sig = signClaim(sessionKey, claim);
    for (const patch of [
      { playerId: 'p-2' },
      { address: `0x${'ce'.repeat(20)}` },
      { tableKey: tableKeyFor({ ...key, generation: 9 }) },
      { domain: { ...claim.domain, chainId: 56 } },
    ]) {
      expect(verifyClaim({ ...claim, ...patch }, sig, sessionAddress)).toBe(false);
    }
  });

  test('a malformed signature recovers to nothing', () => {
    expect(recoverClaim(claim, '0x1234')).toBeNull();
    expect(recoverClaim(claim, 'nope')).toBeNull();
    expect(verifyClaim(claim, '0x1234', sessionAddress)).toBe(false);
  });
});
