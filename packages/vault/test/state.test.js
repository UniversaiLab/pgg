import { describe, expect, test } from 'bun:test';
import { encodePacked, keccak256 } from 'viem';
import {
  compareAddress,
  decodeState,
  fromWire,
  isStrictlyAscending,
  normalizeAddress,
  normalizeState,
  rosterHash,
  statesEqual,
  toWire,
} from '../src/state.js';
import { makeRng, randomState, UINT64_MAX, UINT256_MAX } from './gen.js';

const A = `0x${'00'.repeat(19)}01`;
const B = `0x${'00'.repeat(19)}02`;
const C = `0x${'00'.repeat(19)}03`;
const good = () => ({
  tableId: `0x${'ab'.repeat(32)}`,
  nonce: 5n,
  isFinal: false,
  players: [A, B, C],
  balances: [100n, 200n, 300n],
  keep: [false, false, false],
  rake: 10n,
  volume: 1000n,
});

describe('addresses', () => {
  test('normalizeAddress lowercases any case and refuses everything else', () => {
    expect(normalizeAddress(`0x${'AbCd'.repeat(10)}`)).toBe(`0x${'abcd'.repeat(10)}`);
    for (const bad of [
      '0x12',
      `0x${'g'.repeat(40)}`,
      `${'ab'.repeat(20)}`,
      `0x${'ab'.repeat(21)}`,
      5,
      null,
    ]) {
      expect(() => normalizeAddress(bad)).toThrow(RangeError);
    }
    expect(() => normalizeAddress('0x12', 'players[2]')).toThrow(/players\[2\]/);
  });

  test('compareAddress orders by numeric value, whatever the case', () => {
    // 'F' < 'a' as characters, but 0xF… > 0xa… as numbers
    const high = `0xF${'0'.repeat(39)}`;
    const low = `0xa${'0'.repeat(39)}`;
    expect(compareAddress(high, low)).toBe(1);
    expect(compareAddress(low, high)).toBe(-1);
    expect(compareAddress(high, high.toLowerCase())).toBe(0);
  });

  test('isStrictlyAscending rejects duplicates and wrong order', () => {
    expect(isStrictlyAscending([A, B, C])).toBe(true);
    expect(isStrictlyAscending([A])).toBe(true);
    expect(isStrictlyAscending([])).toBe(true);
    expect(isStrictlyAscending([A, A])).toBe(false);
    expect(isStrictlyAscending([B, A])).toBe(false);
    expect(isStrictlyAscending([A, C, B])).toBe(false);
    expect(isStrictlyAscending([`0xF${'0'.repeat(39)}`, `0xa${'0'.repeat(39)}`])).toBe(false);
  });

  test('rosterHash is keccak256(abi.encodePacked(address[])), as the contract stores it', () => {
    const rng = makeRng(8);
    for (let i = 0; i < 50; i++) {
      const players = randomState(rng).players;
      expect(rosterHash(players)).toBe(keccak256(encodePacked(['address[]'], [players])));
    }
    // 32-byte padding is the whole point: this is not the hash of the 20-byte concatenation
    expect(rosterHash([A, B])).not.toBe(keccak256(`0x${A.slice(2)}${B.slice(2)}`));
  });
});

describe('normalizeState', () => {
  test('lowercases, accepts safe-integer numbers and returns fresh copies', () => {
    const input = {
      ...good(),
      tableId: `0x${'AB'.repeat(32)}`,
      players: [A, B, C].map((p) => p.toUpperCase().replace('0X', '0x')),
      nonce: 5,
      balances: [100, 200n, 300],
    };
    const s = normalizeState(input);
    expect(s).toEqual(good());
    expect(s.players).not.toBe(input.players);
    expect(input.nonce).toBe(5); // untouched
  });

  test('accepts the extremes', () => {
    const s = normalizeState({
      ...good(),
      nonce: UINT64_MAX,
      balances: [UINT256_MAX, 0n, 1n],
      rake: UINT256_MAX,
      volume: UINT256_MAX,
    });
    expect(s.nonce).toBe(UINT64_MAX);
    expect(s.rake).toBe(UINT256_MAX);
    const ten = Array.from(
      { length: 10 },
      (_, i) => `0x${'00'.repeat(19)}${(i + 1).toString(16).padStart(2, '0')}`,
    );
    expect(
      normalizeState({
        ...good(),
        players: ten,
        balances: ten.map(() => 1n),
        keep: ten.map(() => true),
      }).players.length,
    ).toBe(10);
  });

  const cases = [
    ['tableId', { tableId: '0x1234' }],
    ['tableId', { tableId: `0x${'zz'.repeat(32)}` }],
    ['tableId', { tableId: 5 }],
    ['nonce', { nonce: UINT64_MAX + 1n }],
    ['nonce', { nonce: -1n }],
    ['nonce', { nonce: 1.5 }],
    ['nonce', { nonce: 2 ** 53 }],
    ['nonce', { nonce: '5' }],
    ['nonce', { nonce: undefined }],
    ['isFinal', { isFinal: 0 }],
    ['isFinal', { isFinal: undefined }],
    ['players', { players: 'nope' }],
    ['players[1]', { players: [A, '0x1234', C] }],
    ['players must have 2 to 10', { players: [A], balances: [1n], keep: [false] }],
    [
      'players must have 2 to 10',
      {
        players: Array.from(
          { length: 11 },
          (_, i) => `0x${'00'.repeat(19)}${(i + 1).toString(16).padStart(2, '0')}`,
        ),
        balances: Array(11).fill(1n),
        keep: Array(11).fill(false),
      },
    ],
    ['players[1]', { players: [B, A, C] }],
    ['players[1]', { players: [A, A, C] }],
    ['players[0]', { players: [`0x${'00'.repeat(20)}`, A, B] }],
    ['balances must have one entry per player', { balances: [1n, 2n] }],
    ['balances must have one entry per player', { balances: [1n, 2n, 3n, 4n] }],
    ['balances[2]', { balances: [1n, 2n, UINT256_MAX + 1n] }],
    ['balances[0]', { balances: [-1n, 2n, 3n] }],
    ['balances[1]', { balances: [1n, '2', 3n] }],
    ['balances', { balances: undefined }],
    ['keep must have one entry per player', { keep: [true] }],
    ['keep[1]', { keep: [true, 'false', false] }],
    ['keep[0]', { keep: [1, 0, 0] }],
    ['rake', { rake: UINT256_MAX + 1n }],
    ['rake', { rake: -1n }],
    ['volume', { volume: UINT256_MAX + 1n }],
    ['volume', { volume: undefined }],
  ];
  for (const [field, patch] of cases) {
    test(`throws a RangeError naming "${field}" for ${JSON.stringify(Object.keys(patch))}`, () => {
      const run = () => normalizeState({ ...good(), ...patch });
      expect(run).toThrow(RangeError);
      expect(run).toThrow(field);
    });
  }

  test('rejects non-objects', () => {
    for (const bad of [null, undefined, 5, 'state'])
      expect(() => normalizeState(bad)).toThrow(RangeError);
  });
});

describe('decodeState (what the ABI decoder accepts)', () => {
  test('lets through what the contract itself would reject later', () => {
    const odd = { ...good(), players: [C, A], balances: [1n], keep: [false, true, true] };
    expect(decodeState(odd).players).toEqual([C, A]);
    expect(decodeState({ ...good(), players: [] }).players).toEqual([]);
  });

  test('still refuses values the ABI cannot hold', () => {
    expect(() => decodeState({ ...good(), nonce: UINT64_MAX + 1n })).toThrow('nonce');
    expect(() => decodeState({ ...good(), players: [A, '0x12'] })).toThrow('players[1]');
    expect(() => decodeState({ ...good(), keep: [1] })).toThrow('keep[0]');
  });
});

describe('toWire / fromWire', () => {
  test('round-trips 300 random states through JSON', () => {
    const rng = makeRng(31);
    for (let i = 0; i < 300; i++) {
      const state = randomState(rng);
      const wire = JSON.parse(JSON.stringify(toWire(state)));
      expect(typeof wire.nonce).toBe('string');
      expect(wire.balances.every((b) => typeof b === 'string')).toBe(true);
      expect(typeof wire.rake).toBe('string');
      expect(typeof wire.volume).toBe('string');
      expect(statesEqual(fromWire(wire), state)).toBe(true);
    }
  });

  test('the wire form is plain decimal text', () => {
    const wire = toWire({ ...good(), nonce: UINT64_MAX, rake: UINT256_MAX });
    expect(wire.nonce).toBe('18446744073709551615');
    expect(wire.rake).toBe(UINT256_MAX.toString());
    expect(wire.balances).toEqual(['100', '200', '300']);
    expect(toWire(good()).isFinal).toBe(false);
  });

  test('toWire validates like normalizeState', () => {
    expect(() => toWire({ ...good(), players: [B, A, C] })).toThrow(RangeError);
  });

  const w = () => toWire(good());
  const strictness = [
    '01',
    '-1',
    ' 1',
    '1 ',
    '1.0',
    '0x1',
    '+1',
    '',
    '1e3',
    '1,000',
    '१',
    'NaN',
    '00',
  ];
  for (const bad of strictness) {
    test(`rejects ${JSON.stringify(bad)} as a number`, () => {
      expect(() => fromWire({ ...w(), nonce: bad })).toThrow(RangeError);
      expect(() => fromWire({ ...w(), rake: bad })).toThrow(RangeError);
      expect(() => fromWire({ ...w(), volume: bad })).toThrow(RangeError);
      expect(() => fromWire({ ...w(), balances: ['1', bad, '3'] })).toThrow(RangeError);
    });
  }

  test('rejects numbers, bigints, null and undefined where a string belongs', () => {
    for (const bad of [1, 1n, 1.5, null, undefined, true, [], {}]) {
      expect(() => fromWire({ ...w(), nonce: bad })).toThrow(RangeError);
      expect(() => fromWire({ ...w(), rake: bad })).toThrow(RangeError);
      expect(() => fromWire({ ...w(), balances: ['1', bad, '3'] })).toThrow(RangeError);
    }
  });

  test('accepts "0" and the largest values, refuses one past them', () => {
    expect(fromWire({ ...w(), nonce: '0', rake: '0' }).nonce).toBe(0n);
    expect(fromWire({ ...w(), nonce: UINT64_MAX.toString() }).nonce).toBe(UINT64_MAX);
    expect(() => fromWire({ ...w(), nonce: (UINT64_MAX + 1n).toString() })).toThrow(RangeError);
    expect(fromWire({ ...w(), rake: UINT256_MAX.toString() }).rake).toBe(UINT256_MAX);
    expect(() => fromWire({ ...w(), rake: (UINT256_MAX + 1n).toString() })).toThrow(RangeError);
    expect(() => fromWire({ ...w(), rake: '9'.repeat(5000) })).toThrow(RangeError);
  });

  test('keeps the non-numeric fields strict too', () => {
    expect(() => fromWire({ ...w(), isFinal: 'false' })).toThrow('isFinal');
    expect(() => fromWire({ ...w(), keep: [0, 0, 0] })).toThrow('keep[0]');
    expect(() => fromWire({ ...w(), balances: '1,2,3' })).toThrow('balances');
    expect(() => fromWire({ ...w(), players: [B, A, C] })).toThrow('players');
    expect(() => fromWire(null)).toThrow(RangeError);
    expect(() => fromWire('state')).toThrow(RangeError);
  });

  test('ignores unknown extra fields instead of carrying them along', () => {
    const s = fromWire({ ...w(), evil: 'x' });
    expect('evil' in s).toBe(false);
  });
});

describe('statesEqual', () => {
  test('true for equal states, whatever the address case', () => {
    expect(statesEqual(good(), good())).toBe(true);
    const upper = {
      ...good(),
      players: good().players.map((p) => p.toUpperCase().replace('0X', '0x')),
    };
    expect(statesEqual(good(), upper)).toBe(true);
  });

  test('false when any single field differs', () => {
    const base = good();
    const variants = [
      { tableId: `0x${'cd'.repeat(32)}` },
      { nonce: 6n },
      { isFinal: true },
      { players: [A, B, `0x${'00'.repeat(19)}09`] },
      { players: [A, B] },
      { balances: [100n, 200n, 301n] },
      { balances: [100n, 200n] },
      { keep: [false, true, false] },
      { rake: 11n },
      { volume: 1001n },
    ];
    for (const patch of variants) expect(statesEqual(base, { ...good(), ...patch })).toBe(false);
  });

  test('never throws on junk', () => {
    expect(statesEqual(null, good())).toBe(false);
    expect(statesEqual(good(), undefined)).toBe(false);
    expect(statesEqual({}, {})).toBe(false);
    expect(statesEqual({ ...good(), players: [1, 2] }, good())).toBe(false);
  });
});
