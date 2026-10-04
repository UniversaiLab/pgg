// Adversarial review of state.js, units.js and build.js: every way a value could slip past validation, the
// decimal-string wire format, address handling against the contract's keccak256(abi.encodePacked(address[])),
// aliasing and mutation, and the chip <-> token conversions near 2^53.
//
// Titles starting with "REVIEW BUG" fail on purpose today: each pins down a defect found in the review (see
// the report) and passes once src is fixed. Titles starting with "REVIEW GAP" are `test.todo` specs: they do
// not run by default; `bun test --todo` runs them and shows what they would assert.
import { describe, expect, test } from 'bun:test';
import { encodePacked, keccak256 } from 'viem';
import { buildNextState, genesisState, sortRoster } from '../src/build.js';
import { checkState } from '../src/check.js';
import { hashState } from '../src/eip712.js';
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
import { toChips, toTokenUnits } from '../src/units.js';
import { makeWorld, UNIT } from './fixtures.js';
import { makeRng, randomRoster, randomState, UINT64_MAX, UINT256_MAX } from './gen.js';

const addr = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const TABLE = `0x${'ab'.repeat(32)}`;
const wire = (patch = {}) => ({
  tableId: TABLE,
  nonce: '7',
  isFinal: false,
  players: [addr(1n), addr(2n), addr(3n)],
  balances: ['10', '20', '30'],
  keep: [false, false, false],
  rake: '1',
  volume: '100',
  ...patch,
});
const internal = (patch = {}) => ({
  tableId: TABLE,
  nonce: 7n,
  isFinal: false,
  players: [addr(1n), addr(2n), addr(3n)],
  balances: [10n, 20n, 30n],
  keep: [false, false, false],
  rake: 1n,
  volume: 100n,
  ...patch,
});

describe('fromWire: decimal strings, and nothing else', () => {
  const accepted = {
    zero: ['0', 0n],
    one: ['1', 1n],
    'uint64 max': [UINT64_MAX.toString(), UINT64_MAX],
    'above 2^53': ['9007199254740993', 9007199254740993n], // a JS number would already have rounded this
  };
  for (const [name, [text, value]] of Object.entries(accepted)) {
    test(`accepts ${name}`, () => {
      expect(fromWire(wire({ nonce: text })).nonce).toBe(value);
      expect(fromWire(wire({ rake: text })).rake).toBe(value);
    });
  }

  const refused = [
    '',
    ' ',
    ' 1',
    '1 ',
    '1\n',
    '\n1',
    '\t1',
    ' 1',
    '01',
    '00',
    '-0',
    '-1',
    '+1',
    '1.0',
    '1.',
    '.5',
    '1e3',
    '1E3',
    '0x10',
    '0b1',
    '1_000',
    '1,000',
    'NaN',
    'Infinity',
    'null',
    '１２３', // full-width digits
    '١٢٣', // Arabic-Indic digits
    '1\u0000',
    UINT64_MAX.toString().concat('x'),
  ];
  for (const text of refused) {
    test(`refuses the string ${JSON.stringify(text)}`, () => {
      expect(() => fromWire(wire({ nonce: text }))).toThrow(RangeError);
      expect(() => fromWire(wire({ balances: [text, '1', '1'] }))).toThrow(RangeError);
      expect(() => fromWire(wire({ rake: text }))).toThrow(RangeError);
      expect(() => fromWire(wire({ volume: text }))).toThrow(RangeError);
    });
  }

  test('2^64 is too big for the nonce but fine for an amount; 2^256 is too big for both', () => {
    expect(() => fromWire(wire({ nonce: (UINT64_MAX + 1n).toString() }))).toThrow(/nonce/);
    expect(fromWire(wire({ rake: (UINT64_MAX + 1n).toString() })).rake).toBe(UINT64_MAX + 1n);
    expect(fromWire(wire({ rake: UINT256_MAX.toString() })).rake).toBe(UINT256_MAX);
    expect(() => fromWire(wire({ rake: (UINT256_MAX + 1n).toString() }))).toThrow(/rake/);
    expect(() => fromWire(wire({ balances: [(UINT256_MAX + 1n).toString(), '0', '0'] }))).toThrow(
      /balances\[0\]/,
    );
    // 78 digits that are still too big, and the first length the digit cap itself refuses
    expect(() => fromWire(wire({ volume: '9'.repeat(78) }))).toThrow(/volume/);
    expect(() => fromWire(wire({ volume: '1'.repeat(79) }))).toThrow(/volume/);
  });

  test('a very long string is refused quickly, before anything is parsed', () => {
    const started = performance.now();
    expect(() => fromWire(wire({ nonce: '1'.repeat(5_000_000) }))).toThrow(RangeError);
    expect(() => fromWire(wire({ rake: `${'1'.repeat(5_000_000)}x` }))).toThrow(RangeError);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test('anything that is not a string is refused, including every other way to spell a number', () => {
    const notStrings = [
      1,
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1n,
      true,
      null,
      undefined,
      [],
      ['1'],
      {},
      { toString: () => '1' },
      new String('1'),
      Symbol('1'),
      () => '1',
    ];
    for (const v of notStrings) {
      expect(() => fromWire(wire({ nonce: v })), `nonce ${String(typeof v)}`).toThrow(RangeError);
      expect(() => fromWire(wire({ rake: v })), `rake ${String(typeof v)}`).toThrow(RangeError);
      expect(() => fromWire(wire({ volume: v })), `volume ${String(typeof v)}`).toThrow(RangeError);
      expect(() => fromWire(wire({ balances: [v, '1', '1'] })), 'balances').toThrow(RangeError);
    }
  });

  test('the non-number fields are strict too', () => {
    for (const isFinal of [0, 1, 'true', 'false', null, undefined, [], {}]) {
      expect(() => fromWire(wire({ isFinal })), String(isFinal)).toThrow(RangeError);
    }
    for (const keep of [
      [0, 0, 0],
      ['false', 'false', 'false'],
      [null, null, null],
      'fff',
      undefined,
    ]) {
      expect(() => fromWire(wire({ keep }))).toThrow(RangeError);
    }
    for (const players of [undefined, null, 'x', {}, [1, 2, 3], [addr(1n), addr(2n), null]]) {
      expect(() => fromWire(wire({ players }))).toThrow();
    }
    expect(() => fromWire(wire({ balances: 'abc' }))).toThrow(RangeError);
    expect(() => fromWire(wire({ balances: undefined }))).toThrow(RangeError);
  });

  test('a missing field is an error, not a default', () => {
    for (const field of Object.keys(wire())) {
      const w = wire();
      delete w[field];
      expect(() => fromWire(w), `without ${field}`).toThrow();
    }
  });

  test('not an object at all', () => {
    for (const v of [null, undefined, 1, 'x', true]) expect(() => fromWire(v)).toThrow(RangeError);
  });
});

describe('JSON hazards', () => {
  test('a __proto__ or constructor key in the JSON does not change what is read, and is ignored', () => {
    const text = JSON.stringify(wire()).replace(
      '{',
      '{"__proto__":{"nonce":"99","isFinal":true},"constructor":{"prototype":{"nonce":"98"}},',
    );
    const parsed = JSON.parse(text);
    expect(Object.hasOwn(parsed, '__proto__')).toBe(true); // JSON.parse makes it an own property
    const state = fromWire(parsed);
    expect(state.nonce).toBe(7n);
    expect(state.isFinal).toBe(false);
    expect(Object.getPrototypeOf(state)).toBe(Object.prototype);
    expect({}.nonce).toBeUndefined(); // nothing leaked into Object.prototype
  });

  test('extra fields are dropped, never carried into the state or the wire form', () => {
    const noisy = { ...wire(), extra: 'x', toJSON: 'y', __v: 3 };
    const state = fromWire(noisy);
    expect(Object.keys(state).sort()).toEqual(
      ['tableId', 'nonce', 'isFinal', 'players', 'balances', 'keep', 'rake', 'volume'].sort(),
    );
    expect(Object.keys(toWire(state)).sort()).toEqual(Object.keys(wire()).sort());
  });

  test('a duplicated key in the text: the last one wins, as JSON.parse always does', () => {
    const text = `{"tableId":"${TABLE}","nonce":"1","nonce":"2","isFinal":false,"players":["${addr(1n)}","${addr(2n)}"],"balances":["1","2"],"keep":[false,false],"rake":"0","volume":"0"}`;
    expect(fromWire(JSON.parse(text)).nonce).toBe(2n);
  });

  test('JSON numbers (not strings) are refused even when they are exact integers', () => {
    const text = JSON.stringify(wire()).replace('"nonce":"7"', '"nonce":7');
    expect(() => fromWire(JSON.parse(text))).toThrow(RangeError);
    const big = `{"tableId":"${TABLE}","nonce":"1","isFinal":false,"players":["${addr(1n)}","${addr(2n)}"],"balances":[12345678901234567890,2],"keep":[false,false],"rake":"0","volume":"0"}`;
    expect(() => fromWire(JSON.parse(big))).toThrow(RangeError);
  });

  test('toWire output survives JSON.stringify/parse exactly, for the widest values', () => {
    const state = normalizeState(
      internal({
        nonce: UINT64_MAX,
        balances: [UINT256_MAX, 0n, 1n],
        rake: UINT256_MAX,
        volume: 2n ** 200n,
      }),
    );
    const there = JSON.parse(JSON.stringify(toWire(state)));
    expect(statesEqual(fromWire(there), state)).toBe(true);
    expect(fromWire(there).balances[0]).toBe(UINT256_MAX);
  });

  test('toWire refuses a wire state, so strings are never silently reinterpreted', () => {
    expect(() => toWire(wire())).toThrow(RangeError);
  });
});

describe('normalizeState: ranges, rosters and addresses', () => {
  test('uint64 and uint256 edges for the internal form', () => {
    expect(normalizeState(internal({ nonce: UINT64_MAX })).nonce).toBe(UINT64_MAX);
    expect(() => normalizeState(internal({ nonce: UINT64_MAX + 1n }))).toThrow(/nonce/);
    expect(() => normalizeState(internal({ nonce: -1n }))).toThrow(/nonce/);
    expect(() => normalizeState(internal({ rake: -1n }))).toThrow(/rake/);
    expect(() => normalizeState(internal({ volume: UINT256_MAX + 1n }))).toThrow(/volume/);
    expect(() => normalizeState(internal({ balances: [1n, -1n, 1n] }))).toThrow(/balances\[1\]/);
    // negative zero is the number 0
    expect(normalizeState(internal({ nonce: -0 })).nonce).toBe(0n);
    // a number beyond the safe range has already lost digits: refuse it
    for (const n of [2 ** 53, 2 ** 64, 1e21, Number.MAX_VALUE, 0.5, -1, Number.NaN, Infinity]) {
      expect(() => normalizeState(internal({ nonce: n })), String(n)).toThrow(RangeError);
      expect(() => normalizeState(internal({ rake: n })), String(n)).toThrow(RangeError);
    }
  });

  test('the roster rules: 2 to 10 players, strictly ascending, first not the zero address', () => {
    const roster = (n) => Array.from({ length: n }, (_, i) => addr(BigInt(i + 1)));
    const sized = (n) =>
      internal({
        players: roster(n),
        balances: Array(n).fill(1n),
        keep: Array(n).fill(false),
      });
    expect(() => normalizeState(sized(1))).toThrow(/players/);
    expect(normalizeState(sized(2)).players).toHaveLength(2);
    expect(normalizeState(sized(10)).players).toHaveLength(10);
    expect(() => normalizeState(sized(11))).toThrow(/players/);
    expect(() => normalizeState(sized(0))).toThrow(/players/);
    // ascending
    expect(() => normalizeState(internal({ players: [addr(2n), addr(1n), addr(3n)] }))).toThrow(
      /ascending/,
    );
    expect(() => normalizeState(internal({ players: [addr(1n), addr(1n), addr(3n)] }))).toThrow(
      /ascending/,
    );
    expect(() => normalizeState(internal({ players: [addr(1n), addr(3n), addr(2n)] }))).toThrow(
      /ascending/,
    );
    // the same address in different cases is still a duplicate
    expect(() =>
      normalizeState(
        internal({
          players: [
            addr(0xabcdefn),
            addr(0xabcdefn).toUpperCase().replace('0X', '0x'),
            addr(0xffffffn),
          ],
        }),
      ),
    ).toThrow(/ascending/);
    // zero address first (the contract's `start` rejects it: p <= previous(0))
    expect(() => normalizeState(internal({ players: [addr(0n), addr(1n), addr(2n)] }))).toThrow(
      /zero address/,
    );
    // lengths
    expect(() => normalizeState(internal({ balances: [1n, 2n] }))).toThrow(/balances/);
    expect(() => normalizeState(internal({ keep: [false, false] }))).toThrow(/keep/);
    expect(() => normalizeState(internal({ keep: [false, false, false, false] }))).toThrow(/keep/);
  });

  test('numeric order, not text order: 0x…0a is above 0x…09 and 0x…ff00 is above 0x…ffff0? (hex width)', () => {
    expect(compareAddress(addr(0xan), addr(9n))).toBe(1);
    expect(compareAddress(addr(0x100n), addr(0xffn))).toBe(1);
    expect(compareAddress(addr(1n << 159n), addr((1n << 159n) - 1n))).toBe(1);
    expect(isStrictlyAscending([addr(0xffn), addr(0x100n), addr(1n << 100n)])).toBe(true);
  });

  const BAD_ADDRESSES = {
    'no 0x': '1'.repeat(40),
    'uppercase 0X': `0X${'1'.repeat(40)}`,
    '19 bytes': `0x${'11'.repeat(19)}`,
    '21 bytes': `0x${'11'.repeat(21)}`,
    '39 hex digits': `0x${'1'.repeat(39)}`,
    '41 hex digits': `0x${'1'.repeat(41)}`,
    'trailing newline': `0x${'1'.repeat(40)}\n`,
    'leading space': ` 0x${'1'.repeat(40)}`,
    'trailing space': `0x${'1'.repeat(40)} `,
    'non-hex digit': `0x${'1'.repeat(39)}g`,
    'full-width hex digit': `0x${'1'.repeat(39)}Ａ`,
    'embedded NUL': `0x${'1'.repeat(39)}\u0000`,
    'empty string': '',
    '0x only': '0x',
    'ens name': 'vitalik.eth',
    number: 17,
    bigint: 17n,
    null: null,
    undefined,
    'string object': new String(`0x${'1'.repeat(40)}`),
    'byte array': new Uint8Array(20),
  };
  for (const [name, value] of Object.entries(BAD_ADDRESSES)) {
    test(`refuses an address that is: ${name}`, () => {
      expect(() => normalizeAddress(value)).toThrow(RangeError);
      expect(() => normalizeState(internal({ players: [value, addr(2n), addr(3n)] }))).toThrow(
        RangeError,
      );
      expect(() => normalizeState(internal({ players: [addr(1n), addr(2n), value] }))).toThrow(
        RangeError,
      );
      expect(() => rosterHash([addr(1n), value])).toThrow(RangeError);
      expect(() => sortRoster([{ address: addr(1n) }, { address: value }])).toThrow(RangeError);
    });
  }

  test('mixed case is accepted whatever its checksum (the bytes are what count), and lowercased', () => {
    const wrongChecksum = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
    expect(normalizeAddress(wrongChecksum)).toBe(wrongChecksum.toLowerCase());
    expect(normalizeAddress(wrongChecksum)).toMatch(/^0x[0-9a-f]{40}$/);
  });

  test('the output is canonical: lowercase, and equal for every spelling of the input', () => {
    const loud = internal({
      tableId: TABLE.toUpperCase().replace('0X', '0x'),
      players: [addr(0xabn).toUpperCase().replace('0X', '0x'), addr(0xacn), addr(0xadn)],
    });
    const quiet = internal({ players: [addr(0xabn), addr(0xacn), addr(0xadn)] });
    expect(normalizeState(loud)).toEqual(normalizeState(quiet));
    expect(JSON.stringify(toWire(loud))).toBe(JSON.stringify(toWire(quiet)));
  });

  test('not an object', () => {
    for (const v of [null, undefined, 1, 'x', true])
      expect(() => normalizeState(v)).toThrow(RangeError);
  });

  test('200 thousand players are refused, and quickly enough that a hostile peer cannot park the CPU', () => {
    const players = Array.from({ length: 200_000 }, (_, i) => addr(BigInt(i + 1)));
    const started = performance.now();
    expect(() =>
      fromWire(wire({ players, balances: players.map(() => '1'), keep: players.map(() => false) })),
    ).toThrow(/players/);
    // 200k entries took roughly 100 ms when this was written: the whole array is mapped before the
    // length is looked at. Not a bug by itself; this bounds it so a regression to something quadratic shows.
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('no aliasing and no mutation', () => {
  const deepFreeze = (o) => {
    for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
    return Object.freeze(o);
  };

  test('normalizeState returns fresh arrays: changing the result does not touch the input, nor the reverse', () => {
    const input = internal();
    const out = normalizeState(input);
    expect(out.players).not.toBe(input.players);
    expect(out.balances).not.toBe(input.balances);
    expect(out.keep).not.toBe(input.keep);
    out.balances[0] = 999n;
    out.players[0] = addr(77n);
    out.keep[0] = true;
    expect(input).toEqual(internal());
    input.balances[1] = 5n;
    expect(out.balances[1]).toBe(20n);
  });

  test('toWire, fromWire, buildNextState, genesisState and sortRoster accept frozen input and do not alias it', () => {
    const frozen = deepFreeze(internal());
    const w = toWire(frozen);
    expect(w.players).not.toBe(frozen.players);
    expect(fromWire(deepFreeze(wire())).players).toHaveLength(3);
    const next = buildNextState({ prev: frozen, balances: [10n, 20n, 30n] });
    expect(next.players).not.toBe(frozen.players);
    expect(next.keep).not.toBe(frozen.keep);
    const genesis = genesisState({
      tableId: TABLE,
      players: deepFreeze([addr(1n), addr(2n)]),
      deposits: deepFreeze([1n, 2n]),
    });
    expect(genesis.balances).toEqual([1n, 2n]);
    const items = deepFreeze([{ address: addr(2n) }, { address: addr(1n) }]);
    expect(sortRoster(items).sorted[0]).toBe(items[1]); // the objects themselves come back, in order
  });

  test('the caller keeping a reference to what it passed in cannot change a state afterwards', () => {
    const balances = [10n, 20n, 30n];
    const prev = normalizeState(internal());
    const next = buildNextState({ prev, balances });
    balances[0] = 0n;
    expect(next.balances[0]).toBe(10n);
    const keep = [true, true, true];
    const final = buildNextState({ prev, balances: [10n, 20n, 30n], final: true, keep });
    keep[0] = false;
    expect(final.keep[0]).toBe(true);
  });

  test('statesEqual is value equality, case-insensitive on addresses and never throws', () => {
    const a = normalizeState(internal());
    const b = { ...a, players: a.players.map((p) => p.toUpperCase().replace('0X', '0x')) };
    expect(statesEqual(a, b)).toBe(true);
    for (const patch of [
      { nonce: 8n },
      { isFinal: true },
      { balances: [10n, 20n, 31n] },
      { keep: [false, true, false] },
      { rake: 2n },
      { volume: 101n },
      { tableId: `0x${'cd'.repeat(32)}` },
      { players: [addr(1n), addr(2n), addr(4n)] },
    ]) {
      expect(statesEqual(a, { ...a, ...patch }), JSON.stringify(Object.keys(patch))).toBe(false);
    }
    for (const junk of [null, undefined, 1, 'x', {}, [], { ...a, players: null }]) {
      expect(statesEqual(a, junk)).toBe(false);
      expect(statesEqual(junk, a)).toBe(false);
    }
  });
});

describe('rosterHash is the contract’s keccak256(abi.encodePacked(address[]))', () => {
  const viemHash = (players) =>
    keccak256(encodePacked(['address[]'], [players.map((p) => p.toLowerCase())]));

  test('pads every address to 32 bytes: 2 players, 10 players, and a hash that differs from the unpadded one', () => {
    const rng = makeRng(77);
    for (const n of [2, 3, 6, 10]) {
      const players = randomRoster(rng, n);
      expect(rosterHash(players)).toBe(viemHash(players));
      const unpadded = keccak256(`0x${players.map((p) => p.slice(2)).join('')}`);
      expect(rosterHash(players)).not.toBe(unpadded);
    }
  });

  test('empty, one, duplicates, descending and the zero address hash the way the contract would', () => {
    // the contract applies no rule when hashing; the rules live in `start`. The library mirrors the hash.
    for (const players of [
      [],
      [addr(1n)],
      [addr(5n), addr(5n)],
      [addr(9n), addr(1n)],
      [addr(0n), addr(1n)],
      [addr((1n << 160n) - 1n), addr(0n)],
    ]) {
      expect(rosterHash(players)).toBe(viemHash(players));
    }
  });

  test('case never matters', () => {
    const lower = [addr(0xabcdefn), addr(0xfedcban)];
    expect(rosterHash(lower.map((p) => p.toUpperCase().replace('0X', '0x')))).toBe(
      rosterHash(lower),
    );
  });

  test('order matters (the roster is a sequence, not a set)', () => {
    expect(rosterHash([addr(1n), addr(2n)])).not.toBe(rosterHash([addr(2n), addr(1n)]));
  });

  test('a prefix of a roster hashes differently from the roster (no length ambiguity)', () => {
    expect(rosterHash([addr(1n), addr(2n)])).not.toBe(rosterHash([addr(1n), addr(2n), addr(3n)]));
    expect(rosterHash([addr(1n)])).not.toBe(rosterHash([addr(1n), addr(0n)]));
  });
});

describe('the holes in an array', () => {
  // JSON.parse can never produce a hole, but code can (`new Array(3)`, `delete a[1]`). Array.prototype.map
  // and every skip holes, so a hole sails through per-element validation.
  test.todo('REVIEW GAP (nit): normalizeState must not return arrays with holes', () => {
    for (const field of ['balances', 'keep']) {
      let out;
      try {
        out = normalizeState(internal({ [field]: new Array(3) }));
      } catch (error) {
        expect(error).toBeInstanceOf(RangeError); // refusing is the right answer
        continue;
      }
      // accepted: then every slot must at least be real
      expect(Object.keys(out[field]).length, `${field} holes`).toBe(out[field].length);
    }
  });

  test.todo('REVIEW GAP (nit): a state with holes is not equal to a state with values', () => {
    const real = normalizeState(internal());
    const holey = { ...real, balances: new Array(3), keep: new Array(3) };
    expect(statesEqual(holey, real)).toBe(false); // Array.prototype.every skips the holes
  });

  test('a hole is at least never approved: hashing throws and checkState does not say ok', () => {
    const w = makeWorld({ seed: 1 });
    for (const field of ['balances', 'keep']) {
      const holey = { ...w.genesis, nonce: 1n, [field]: new Array(3) };
      expect(() => hashState(holey, w.domain), field).toThrow();
      let verdict;
      try {
        verdict = checkState(holey, null, w.ctx());
      } catch {
        verdict = { ok: false };
      }
      expect(verdict.ok, field).toBe(false);
    }
  });
});

describe('units: chips <-> token base units', () => {
  const MAX = BigInt(Number.MAX_SAFE_INTEGER);

  test('near 2^53 a chip count is exact or refused, never rounded', () => {
    expect(toTokenUnits(Number.MAX_SAFE_INTEGER, UNIT)).toBe(MAX * UNIT);
    expect(() => toTokenUnits(Number.MAX_SAFE_INTEGER + 1, UNIT)).toThrow(RangeError);
    expect(() => toTokenUnits(2 ** 53 + 2, UNIT)).toThrow(RangeError);
    expect(toChips(MAX * UNIT, UNIT)).toEqual({ chips: Number.MAX_SAFE_INTEGER, dust: 0n });
    expect(toChips(MAX * UNIT + UNIT - 1n, UNIT)).toEqual({
      chips: Number.MAX_SAFE_INTEGER,
      dust: UNIT - 1n,
    });
    expect(() => toChips((MAX + 1n) * UNIT, UNIT)).toThrow(RangeError);
    expect(() => toChips((MAX + 1n) * UNIT + 5n, UNIT)).toThrow(RangeError);
  });

  test('negative, fractional, NaN, infinite and non-number chips are refused', () => {
    for (const bad of [
      -1,
      -0.5,
      0.5,
      1.5,
      Number.NaN,
      Infinity,
      -Infinity,
      '5',
      5n,
      null,
      undefined,
      [],
      {},
    ]) {
      expect(() => toTokenUnits(bad, UNIT), String(bad)).toThrow(RangeError);
    }
    expect(toTokenUnits(-0, UNIT)).toBe(0n); // -0 is zero
  });

  test('a unit that is not a positive bigint is refused by both functions', () => {
    for (const unit of [0n, -1n, 0, 1, 10000, '10000', null, undefined, 1.5, 10n ** 4n * -1n]) {
      expect(() => toTokenUnits(5, unit), String(unit)).toThrow(RangeError);
      expect(() => toChips(5n, unit), String(unit)).toThrow(RangeError);
    }
    expect(toTokenUnits(5, 1n)).toBe(5n); // unit 1: one chip per base unit is legal
    expect(toChips(5n, 1n)).toEqual({ chips: 5, dust: 0n });
  });

  test('token amounts that are negative or not bigints are refused', () => {
    for (const bad of [-1n, 5, 5.5, '5', null, undefined, Number.NaN]) {
      expect(() => toChips(bad, UNIT), String(bad)).toThrow(RangeError);
    }
  });

  test('dust: the split is exact and inverts, for every remainder around the unit', () => {
    for (const total of [0n, 1n, UNIT - 1n, UNIT, UNIT + 1n, 7n * UNIT - 1n, 123_456_789_012n]) {
      const { chips, dust } = toChips(total, UNIT);
      expect(dust).toBeGreaterThanOrEqual(0n);
      expect(dust).toBeLessThan(UNIT);
      expect(toTokenUnits(chips, UNIT) + dust).toBe(total);
    }
  });

  test('an 18-decimal token: 0.01 token per chip, balances of a billion tokens, and a balance too big to count in chips', () => {
    const unit = 10n ** 16n;
    const billion = 10n ** 9n * 10n ** 18n;
    expect(toChips(billion, unit)).toEqual({ chips: 10 ** 11, dust: 0n });
    expect(toChips(billion + 12345n, unit)).toEqual({ chips: 10 ** 11, dust: 12345n });
    expect(toTokenUnits(10 ** 11, unit)).toBe(billion);
    // 10^24 tokens (never real money) would need 10^26 chips: refused rather than rounded
    expect(() => toChips(10n ** 24n * 10n ** 18n, unit)).toThrow(RangeError);
    // a unit of 1 base unit with an 18-decimal balance: the chip count itself exceeds 2^53
    expect(() => toChips(10n ** 18n, 1n)).toThrow(RangeError);
  });

  test('a chip count times a huge unit can exceed uint256: the state refuses it instead of wrapping', () => {
    const unit = 2n ** 250n;
    const tooMany = toTokenUnits(2 ** 10, unit); // 2^260
    expect(tooMany > UINT256_MAX).toBe(true);
    expect(() => normalizeState(internal({ balances: [tooMany, 1n, 1n] }))).toThrow(
      /balances\[0\]/,
    );
  });
});

describe('build.js', () => {
  const players = [addr(1n), addr(2n), addr(3n)];
  const genesis = () => genesisState({ tableId: TABLE, players, deposits: [10n, 20n, 30n] });

  test('genesisState matches the contract’s depositState shape: not final, keep all false, volume 0', () => {
    const g = genesis();
    expect(g).toMatchObject({
      isFinal: false,
      keep: [false, false, false],
      volume: 0n,
      rake: 0n,
      nonce: 0n,
    });
  });

  test('genesisState refuses what cannot be a roster', () => {
    expect(() => genesisState({ tableId: TABLE, players, deposits: [1n, 2n] })).toThrow(RangeError);
    expect(() => genesisState({ tableId: TABLE, players, deposits: [1n, 2n, 3n, 4n] })).toThrow(
      RangeError,
    );
    expect(() => genesisState({ tableId: TABLE, players, deposits: 'abc' })).toThrow(RangeError);
    expect(() =>
      genesisState({ tableId: TABLE, players: [...players].reverse(), deposits: [1n, 2n, 3n] }),
    ).toThrow(/ascending/);
    expect(() => genesisState({ tableId: TABLE, players, deposits: [1n, -2n, 3n] })).toThrow(
      RangeError,
    );
    expect(() => genesisState({ tableId: TABLE, players, deposits: [1n, 2.5, 3n] })).toThrow(
      RangeError,
    );
    expect(() => genesisState({ tableId: TABLE, players, deposits: ['1', '2', '3'] })).toThrow(
      RangeError,
    );
    expect(() =>
      genesisState({ tableId: TABLE, players, deposits: [1n, 2n, 3n], nonce: -1n }),
    ).toThrow(RangeError);
    expect(() =>
      genesisState({ tableId: TABLE, players, deposits: [1n, 2n, 3n], rake: -1n }),
    ).toThrow(RangeError);
  });

  test('buildNextState: nonce + 1, cumulative rake and volume, and the overflow edges', () => {
    const next = buildNextState({
      prev: genesis(),
      balances: [10n, 20n, 30n],
      rakeDelta: 3n,
      volumeDelta: 50n,
    });
    expect(next).toMatchObject({ nonce: 1n, rake: 3n, volume: 50n });
    const again = buildNextState({
      prev: next,
      balances: [10n, 20n, 30n],
      rakeDelta: 3n,
      volumeDelta: 50n,
    });
    expect(again).toMatchObject({ nonce: 2n, rake: 6n, volume: 100n });
    const last = { ...genesis(), nonce: UINT64_MAX };
    expect(() => buildNextState({ prev: last, balances: [10n, 20n, 30n] })).toThrow(/nonce/);
    const full = { ...genesis(), volume: UINT256_MAX };
    expect(() =>
      buildNextState({ prev: full, balances: [10n, 20n, 30n], volumeDelta: 1n }),
    ).toThrow(/volume/);
    expect(() =>
      buildNextState({ prev: full, balances: [10n, 20n, 30n], volumeDelta: 0n }),
    ).not.toThrow();
    const rich = { ...genesis(), rake: UINT256_MAX };
    expect(() => buildNextState({ prev: rich, balances: [10n, 20n, 30n], rakeDelta: 1n })).toThrow(
      /rake/,
    );
  });

  test('buildNextState refuses what cannot be a next state', () => {
    const prev = genesis();
    expect(() => buildNextState({ prev, balances: [1n, 2n] })).toThrow(RangeError);
    expect(() => buildNextState({ prev, balances: 'abc' })).toThrow(RangeError);
    expect(() => buildNextState({ prev, balances: [1n, -2n, 3n] })).toThrow(RangeError);
    expect(() => buildNextState({ prev, balances: [1n, 2n, 3n], rakeDelta: -1n })).toThrow(
      RangeError,
    );
    expect(() => buildNextState({ prev, balances: [1n, 2n, 3n], volumeDelta: -1 })).toThrow(
      RangeError,
    );
    expect(() => buildNextState({ prev, balances: [1n, 2n, 3n], rakeDelta: 1.5 })).toThrow(
      RangeError,
    );
    expect(() =>
      buildNextState({ prev, balances: [1n, 2n, 3n], final: true, keep: [true] }),
    ).toThrow(RangeError);
    expect(() =>
      buildNextState({ prev, balances: [1n, 2n, 3n], final: true, keep: 'ttt' }),
    ).toThrow(RangeError);
    expect(() =>
      buildNextState({ prev: { ...prev, players: undefined }, balances: [1n, 2n, 3n] }),
    ).toThrow();
  });

  test('a negative delta is refused even when the cumulative value would stay valid (rake and volume never go down here)', () => {
    const prev = { ...genesis(), rake: 10n, volume: 1000n };
    expect(() => buildNextState({ prev, balances: [10n, 20n, 30n], rakeDelta: -1n })).toThrow(
      /rakeDelta/,
    );
    expect(() => buildNextState({ prev, balances: [10n, 20n, 30n], volumeDelta: -1n })).toThrow(
      /volumeDelta/,
    );
    expect(() => buildNextState({ prev, balances: [10n, 20n, 30n], rakeDelta: -10n })).toThrow(
      /rakeDelta/,
    );
  });

  test('a state that is not final always has keep all false, whatever keep was passed', () => {
    const prev = genesis();
    expect(buildNextState({ prev, balances: [1n, 2n, 3n], keep: [true, true, true] }).keep).toEqual(
      [false, false, false],
    );
    expect(buildNextState({ prev, balances: [1n, 2n, 3n], final: true }).keep).toEqual([
      false,
      false,
      false,
    ]);
    expect(
      buildNextState({ prev, balances: [1n, 2n, 3n], final: true, keep: [true, false, true] }).keep,
    ).toEqual([true, false, true]);
  });

  test.todo('REVIEW GAP (nit): final must be a boolean; the string "false" must not make a final state', () => {
    // Boolean('false') is true, so `final: 'false'` (a flag read from a config or a query string) would
    // quietly produce an isFinal state, the kind that can pay out the table.
    let state;
    try {
      state = buildNextState({ prev: genesis(), balances: [10n, 20n, 30n], final: 'false' });
    } catch (error) {
      expect(error).toBeInstanceOf(RangeError);
      return;
    }
    expect(state.isFinal).toBe(false);
  });

  test('REVIEW BUG: genesisState must be able to carry the cumulative volume of a rolled-over epoch', () => {
    // rake and volume are cumulative since the TABLE was created. After a rollover the baseline is
    // rake = rakePaid and volume = V of the previous epoch's final state. genesisState has a `rake` option and
    // no `volume` one, so volume is silently 0 and the next hand can never satisfy RakeTooHigh (next test).
    const g = genesisState({
      tableId: TABLE,
      players,
      deposits: [10n, 20n, 30n],
      nonce: 9n,
      rake: 20n,
      volume: 1000n,
    });
    expect(g.volume).toBe(1000n);
  });

  test('the trap itself: a rolled-over baseline built as README.md says makes the first hand RakeTooHigh', () => {
    // 20 chips of rake were paid out of 1000 chips of volume (2%). Epoch 2 starts; the README tells us to
    // pass { nonce, rake } to genesisState. One more hand: pot 200, rake 4 (2%).
    const w = makeWorld({ seed: 31, n: 3 });
    const rakePaid = 20n * UNIT;
    const deposits = w.deposits;
    const escrow = deposits.reduce((a, b) => a + b, 0n); // what the stayers carried in; the rake is already paid
    const g = genesisState({
      tableId: w.tableId,
      players: w.players,
      deposits,
      nonce: 9n,
      rake: rakePaid,
    });
    const hand = buildNextState({
      prev: g,
      balances: g.balances.map((b, i) =>
        i === 0 ? b + 96n * UNIT : i === 1 ? b - 100n * UNIT : b,
      ),
      rakeDelta: 4n * UNIT,
      volumeDelta: 200n * UNIT,
    });
    const ctx = w.ctx({ table: { nonce: 9n, rakePaid, escrow } });
    const result = checkState(hand, null, ctx);
    expect(result).toMatchObject({ ok: false, error: 'RakeTooHigh' }); // 24 chips of rake on 200 of volume
    // carrying the volume (1000 chips) makes the very same hand legal:
    const carried = { ...hand, volume: 1200n * UNIT };
    expect(checkState(carried, null, ctx)).toMatchObject({ ok: true });
  });
});

describe('sortRoster', () => {
  test('order and position are inverse permutations; duplicates (any case) throw', () => {
    const rng = makeRng(5);
    for (let i = 0; i < 50; i++) {
      const n = 2 + rng.int(9);
      const items = randomState(rng, { players: n }).players.map((address, k) => ({ address, k }));
      const shuffled = [...items].sort(() => (rng.bool() ? 1 : -1));
      const { sorted, order, position } = sortRoster(shuffled);
      expect(isStrictlyAscending(sorted.map((s) => s.address))).toBe(true);
      for (const [j, from] of order.entries()) expect(sorted[j]).toBe(shuffled[from]);
      for (const [from, to] of position.entries()) expect(order[to]).toBe(from);
    }
    expect(() =>
      sortRoster([{ address: addr(5n) }, { address: addr(5n).toUpperCase().replace('0X', '0x') }]),
    ).toThrow(/duplicate/);
    expect(() => sortRoster('abc')).toThrow(RangeError);
    expect(() => sortRoster([null])).toThrow(RangeError);
    expect(sortRoster([]).sorted).toEqual([]);
  });
});

describe('decodeState is exactly as loose as the ABI decoder', () => {
  test('it keeps what the contract would hash (bad rosters, mismatched lengths) and refuses what it could not decode', () => {
    expect(() =>
      decodeState(internal({ players: [addr(3n), addr(1n)], balances: [1n], keep: [] })),
    ).not.toThrow();
    expect(() => decodeState(internal({ players: [], balances: [], keep: [] }))).not.toThrow();
    expect(() => decodeState(internal({ nonce: UINT64_MAX + 1n }))).toThrow(RangeError);
    expect(() => decodeState(internal({ players: [addr(1n).slice(0, 40)] }))).toThrow(RangeError);
    expect(() => decodeState(internal({ isFinal: 'yes' }))).toThrow(RangeError);
  });
});
