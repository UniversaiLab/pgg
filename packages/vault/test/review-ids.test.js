// Adversarial review of ids.js: can two different (chain, vault, server, generation) tuples or two different
// claims share a key or a digest, does the case of an address matter, and is a claim signature bound to
// everything it says.
//
// `test.todo` bodies are findings written as executable specs (`bun test --todo` runs them); the ones that
// were fixed are ordinary tests now.
import { describe, expect, test } from 'bun:test';
import { concat, keccak256, toHex } from 'viem';
import { hashState } from '../src/eip712.js';
import { claimDigest, recoverClaim, signClaim, tableKeyFor, verifyClaim } from '../src/ids.js';
import { newPrivateKey, privateKeyToAddress, signDigest } from '../src/sign.js';
import { makeWorld } from './fixtures.js';

const VAULT = '0x00000000000000000000000000000000000dead1';
const TABLE = `0x${'ab'.repeat(32)}`;
const ADDRESS = '0x1111111111111111111111111111111111111111';
const DOMAIN = { chainId: 31337, verifyingContract: VAULT };
const key = (over = {}) =>
  tableKeyFor({ chainId: 31337, vault: VAULT, serverId: 'pgg-1', generation: 1, ...over });
const claim = (over = {}) => ({
  domain: DOMAIN,
  tableKey: TABLE,
  address: ADDRESS,
  playerId: 'p-1',
  ...over,
});
const SESSION = `0x${'42'.repeat(32)}`;
const SESSION_ADDRESS = privateKeyToAddress(SESSION);

describe('tableKeyFor', () => {
  test('is exactly keccak256 of the documented string (so the server and a bot cannot disagree)', () => {
    expect(key()).toBe(keccak256(toHex(`pgg:31337:${VAULT}:pgg-1:1`)));
  });

  test('every component matters', () => {
    const base = key();
    const others = [
      key({ chainId: 1 }),
      key({ chainId: 31338 }),
      key({ vault: '0x00000000000000000000000000000000000dead2' }),
      key({ serverId: 'pgg-2' }),
      key({ serverId: 'pgg-1 ' }),
      key({ serverId: 'PGG-1' }),
      key({ generation: 2 }),
      key({ generation: 0 }),
      key({ generation: 10 }),
    ];
    expect(new Set([base, ...others]).size).toBe(others.length + 1);
  });

  test('the vault address is case-insensitive, and the chain id / generation may be a number or a bigint', () => {
    expect(key({ vault: VAULT.toUpperCase().replace('0X', '0x') })).toBe(key());
    expect(key({ chainId: 31337n })).toBe(key());
    expect(key({ generation: 1n })).toBe(key());
    expect(key({ generation: -0 })).toBe(key({ generation: 0 }));
  });

  test('no two different tuples collide on the delimiter: brute force over awkward server ids', () => {
    // fields are joined with ":"; serverId may not contain one, and the other fields never do, so the
    // string can be split back into exactly one tuple. Enumerate tuples whose joined strings would collide
    // if serverId could swallow a neighbour.
    const serverIds = [
      'a',
      '1',
      '12',
      '0x',
      'pgg',
      'pgg1',
      'x1',
      '1x',
      '٣',
      'é',
      'é'.normalize('NFD'),
      ' ',
      '\n',
      '\u0000',
      'a'.repeat(300),
    ];
    const seen = new Map();
    for (const chainId of [1, 12, 31337]) {
      for (const serverId of serverIds) {
        for (const generation of [0, 1, 12, 123]) {
          const k = key({ chainId, serverId, generation });
          const label = JSON.stringify([
            chainId,
            serverId.length > 20 ? 'long' : serverId,
            generation,
          ]);
          expect(seen.has(k), `${label} collides with ${seen.get(k)}`).toBe(false);
          seen.set(k, label);
        }
      }
    }
  });

  test('a serverId with a colon is refused (it would let one tuple impersonate another)', () => {
    expect(() => key({ serverId: 'a:1' })).toThrow(RangeError);
    expect(() => key({ serverId: ':' })).toThrow(RangeError);
    expect(() => key({ serverId: 'pgg:31337' })).toThrow(RangeError);
    expect(() => key({ serverId: '' })).toThrow(RangeError);
    // the full-width colon is a different character and is not a delimiter, so it cannot confuse the split
    expect(key({ serverId: 'a：1' })).not.toBe(key({ serverId: 'a', generation: 1 }));
  });

  test('inputs that are not what they should be', () => {
    for (const serverId of [undefined, null, 5, {}, ['a'], Symbol('a')])
      expect(() => key({ serverId })).toThrow(RangeError);
    for (const generation of [-1, 1.5, Number.NaN, '1', null, undefined, 2 ** 53, -1n, Infinity]) {
      expect(() => key({ generation }), String(generation)).toThrow(RangeError);
    }
    for (const chainId of [0, -1, 1.5, '1', null, undefined])
      expect(() => key({ chainId })).toThrow(RangeError);
    for (const vault of [undefined, null, '0x12', VAULT.slice(2), `${VAULT}00`])
      expect(() => key({ vault })).toThrow(RangeError);
  });

  test('REVIEW GAP (nit): two serverIds that differ only in lone surrogates must not share a key', () => {
    // TextEncoder replaces a lone surrogate with U+FFFD, so '\ud800', '\ud801' and '�' all hash to the
    // same bytes and therefore the same on-chain table id. A serverId is operator configuration, so this is
    // not exploitable by a player, but a canonicalisation hole in an id is cheap to close (isWellFormed()).
    const ids = ['\ud800', '\ud801', '�'];
    const keys = ids.map((serverId) => {
      try {
        return key({ serverId });
      } catch {
        return `refused:${serverId.charCodeAt(0)}`;
      }
    });
    expect(new Set(keys).size).toBe(ids.length);
    // the fix refuses the ill-formed ones (a RangeError naming the field) and still accepts well-formed ones
    for (const serverId of ['\ud800', '\udc00', 'a\ud800b', '\udc00\ud800', '\ud800\ud800']) {
      expect(() => key({ serverId }), JSON.stringify(serverId)).toThrow(
        /serverId must be well-formed/,
      );
    }
    expect(key({ serverId: '\ud83c\udccf' })).toMatch(/^0x[0-9a-f]{64}$/); // a surrogate PAIR is fine
    expect(key({ serverId: '�' })).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('claimDigest', () => {
  test('is exactly the documented concatenation (domain-separated by the "PGG claim v1" prefix)', () => {
    const expected = keccak256(
      concat([
        toHex('PGG claim v1'),
        `0x${(31337).toString(16).padStart(64, '0')}`,
        VAULT,
        TABLE,
        ADDRESS,
        toHex('p-1'),
      ]),
    );
    expect(claimDigest(claim())).toBe(expected);
  });

  test('every field matters', () => {
    const base = claimDigest(claim());
    const others = [
      claimDigest(claim({ domain: { chainId: 1, verifyingContract: VAULT } })),
      claimDigest(
        claim({
          domain: {
            chainId: 31337,
            verifyingContract: '0x00000000000000000000000000000000000dead2',
          },
        }),
      ),
      claimDigest(claim({ tableKey: `0x${'ac'.repeat(32)}` })),
      claimDigest(claim({ address: '0x1111111111111111111111111111111111111112' })),
      claimDigest(claim({ playerId: 'p-2' })),
      claimDigest(claim({ playerId: 'p-10' })),
      claimDigest(claim({ playerId: 'p-' })),
      claimDigest(claim({ playerId: 'P-1' })),
      claimDigest(claim({ playerId: 'p-1 ' })),
    ];
    expect(new Set([base, ...others]).size).toBe(others.length + 1);
  });

  test('the case of the addresses and the table key does not change the digest', () => {
    const shout = (h) => `0x${h.slice(2).toUpperCase()}`;
    expect(
      claimDigest(
        claim({
          domain: { chainId: 31337n, verifyingContract: shout(VAULT) },
          tableKey: shout(TABLE),
          address: shout(ADDRESS),
        }),
      ),
    ).toBe(claimDigest(claim()));
  });

  test('the playerId is case-sensitive and byte-exact, so it cannot be spoofed by case or whitespace', () => {
    const ids = [
      'alice',
      'Alice',
      'ALICE',
      'alice ',
      ' alice',
      'alice\n',
      'alice\u0000',
      'alicé',
      'alicé',
    ];
    const digests = new Set(ids.map((playerId) => claimDigest(claim({ playerId }))));
    expect(digests.size).toBe(ids.length);
  });

  test('no two claims share a preimage: fixed-width fields first, the id last', () => {
    // If the id could start where the address ends, moving the last address byte into the id would collide.
    const seen = new Map();
    const addresses = [
      ADDRESS,
      '0x1111111111111111111111111111111111111122',
      '0x1111111111111111111111111111111111112211',
    ];
    const ids = ['22', '2211', '11', '1122', 'x', '\u0022', '0x22', '"22"'];
    for (const address of addresses) {
      for (const playerId of ids) {
        const d = claimDigest(claim({ address, playerId }));
        expect(seen.has(d), `${address} ${playerId} collides with ${seen.get(d)}`).toBe(false);
        seen.set(d, `${address} ${playerId}`);
      }
    }
    expect(seen.size).toBe(addresses.length * ids.length);
  });

  test('a claim digest can never be a state digest, and signing one does not sign the other', () => {
    // the preimage of a state digest starts with 0x1901; a claim's starts with the ASCII prefix
    const w = makeWorld({ seed: 3 });
    const stateDigest = hashState(w.genesis, w.domain);
    const sig = signClaim(SESSION, claim());
    expect(claimDigest(claim())).not.toBe(stateDigest);
    // the claim signature recovers to the session key for the claim and to something else for a state digest
    expect(recoverClaim(claim(), sig)).toBe(SESSION_ADDRESS);
    expect(signDigest(SESSION, stateDigest)).not.toBe(sig);
  });

  test('an empty id, a non-string id, a bad table key or address are refused', () => {
    for (const playerId of ['', undefined, null, 5, {}, ['a']])
      expect(() => claimDigest(claim({ playerId }))).toThrow(RangeError);
    for (const tableKey of [undefined, '0x12', TABLE.slice(2), `${TABLE}00`, 5])
      expect(() => claimDigest(claim({ tableKey }))).toThrow(RangeError);
    for (const address of [undefined, '0x12', ADDRESS.slice(2), `${ADDRESS}00`, 5])
      expect(() => claimDigest(claim({ address }))).toThrow(RangeError);
    for (const domain of [
      undefined,
      null,
      { chainId: 0, verifyingContract: VAULT },
      { chainId: 1 },
    ]) {
      expect(() => claimDigest(claim({ domain }))).toThrow(RangeError);
    }
  });

  test('a very long id still hashes (no limit is enforced; the server must cap what it accepts)', () => {
    expect(claimDigest(claim({ playerId: 'x'.repeat(1_000_000) }))).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test('REVIEW GAP (nit): two player ids that differ only in lone surrogates must not share a digest', () => {
    // a lone surrogate used to collapse to U+FFFD and collide with the real U+FFFD; now it is refused
    expect(() => claimDigest(claim({ playerId: 'p\ud800' }))).toThrow(
      /playerId must be well-formed/,
    );
    expect(() => claimDigest(claim({ playerId: '\udc00p' }))).toThrow(RangeError);
    expect(claimDigest(claim({ playerId: 'p�' }))).toMatch(/^0x[0-9a-f]{64}$/);
    expect(claimDigest(claim({ playerId: 'p\ud83c\udccf' }))).not.toBe(
      claimDigest(claim({ playerId: 'p�' })),
    );
    // nothing signs or verifies a claim whose id is ill formed either
    expect(() => signClaim(SESSION, claim({ playerId: 'p\ud800' }))).toThrow(RangeError);
    expect(() => recoverClaim(claim({ playerId: 'p\ud800' }), `0x${'11'.repeat(65)}`)).toThrow(
      RangeError,
    );
  });
});

describe('signClaim, recoverClaim, verifyClaim', () => {
  const sig = signClaim(SESSION, claim());

  test('a claim verifies for its session key and for nobody else', () => {
    expect(verifyClaim(claim(), sig, SESSION_ADDRESS)).toBe(true);
    expect(verifyClaim(claim(), sig, SESSION_ADDRESS.toUpperCase().replace('0X', '0x'))).toBe(true);
    expect(verifyClaim(claim(), sig, privateKeyToAddress(newPrivateKey()))).toBe(false);
    expect(verifyClaim(claim(), sig, ADDRESS)).toBe(false);
  });

  test('a claim signature is bound to every field of the claim it was made for', () => {
    const others = [
      claim({ domain: { chainId: 1, verifyingContract: VAULT } }),
      claim({
        domain: { chainId: 31337, verifyingContract: '0x00000000000000000000000000000000000dead2' },
      }),
      claim({ tableKey: `0x${'ac'.repeat(32)}` }),
      claim({ address: '0x1111111111111111111111111111111111111112' }),
      claim({ playerId: 'p-2' }),
    ];
    for (const other of others) {
      expect(verifyClaim(other, sig, SESSION_ADDRESS)).toBe(false);
      expect(recoverClaim(other, sig)).not.toBe(SESSION_ADDRESS);
    }
  });

  test('a missing, zero, empty or malformed session key never verifies', () => {
    for (const sessionKey of [null, undefined, '', `0x${'00'.repeat(20)}`, '0x12', 'nope']) {
      expect(verifyClaim(claim(), sig, sessionKey), String(sessionKey)).toBe(false);
    }
  });

  test('a bad signature never verifies and never throws: wrong length, high s, bad v, zeros, junk', () => {
    const ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const r = sig.slice(2, 66);
    const s = BigInt(`0x${sig.slice(66, 130)}`);
    const v = Number.parseInt(sig.slice(130, 132), 16);
    const hex = (n) => n.toString(16).padStart(64, '0');
    const bads = [
      sig.slice(0, -2),
      `${sig}00`,
      `0x${r}${hex(ORDER - s)}${(v === 27 ? 28 : 27).toString(16)}`, // the malleable twin
      `0x${r}${sig.slice(66, 130)}00`,
      `0x${r}${sig.slice(66, 130)}1d`,
      `0x${'00'.repeat(65)}`,
      '0x',
      '',
      'junk',
      null,
      undefined,
      5,
    ];
    for (const bad of bads) {
      expect(recoverClaim(claim(), bad), String(bad)).toBeNull();
      expect(verifyClaim(claim(), bad, SESSION_ADDRESS), String(bad)).toBe(false);
    }
  });

  test('a claim for an invalid claim throws (a caller error) rather than answering', () => {
    expect(() => recoverClaim(claim({ playerId: '' }), sig)).toThrow(RangeError);
    expect(() => verifyClaim(claim({ address: 'x' }), sig, SESSION_ADDRESS)).toThrow(RangeError);
  });

  test('signing is deterministic, so a resent claim carries the same bytes', () => {
    expect(signClaim(SESSION, claim())).toBe(sig);
  });

  test('REVIEW GAP (nit): verifyClaim with a session key that is not a string answers false instead of throwing', () => {
    expect(verifyClaim(claim(), sig, 12345)).toBe(false);
    for (const junk of [undefined, null, 5n, {}, [], true, Symbol('k'), () => SESSION_ADDRESS]) {
      expect(verifyClaim(claim(), sig, junk), String(typeof junk)).toBe(false);
    }
    expect(verifyClaim(claim(), sig, SESSION_ADDRESS)).toBe(true);
  });

  test('replay: nothing in a claim is fresh, so a captured claim verifies again (identity only, never funds)', () => {
    // documented here so the SIWE step knows what it must replace: there is no nonce, timestamp or server
    // challenge in the digest. The claim names the playerId, so a replay can only re-assert a binding the
    // session key already made; it cannot move a state, a seat or any money.
    expect(verifyClaim(claim(), sig, SESSION_ADDRESS)).toBe(true);
    expect(verifyClaim(claim(), sig, SESSION_ADDRESS)).toBe(true);
  });
});
