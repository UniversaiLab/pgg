import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as constants from '../src/constants.js';
import * as root from '../src/index.js';
import {
  CLIENT,
  ClientMessage,
  ERR,
  LIMITS,
  SERVER,
  ServerMessage,
  SIGN_REASONS,
  TableState,
  TableSummary,
  VAULT_PHASES,
  WireState,
} from '../src/index.js';

// ---- fixtures -------------------------------------------------------------------------------

const hexOf = (byte, count) => `0x${byte.repeat(count)}`;
const address = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const TABLE = hexOf('11', 32);
const DIGEST = hexOf('cd', 32);
const SIG = hexOf('ab', 65);
const UINT256_MAX = (2n ** 256n - 1n).toString();
const UINT64_MAX = (2n ** 64n - 1n).toString();
const DOMAIN = { chainId: 137, verifyingContract: address(0xabc) };

const wire = (over = {}) => ({
  tableId: TABLE,
  nonce: '7',
  isFinal: false,
  players: [address(1), address(2), address(3)],
  balances: ['100', '200', '300'],
  keep: [true, true, true],
  rake: '6',
  volume: '300',
  ...over,
});

// A state with `n` players, every array resized together.
const wireOf = (n) =>
  wire({
    players: Array.from({ length: n }, (_, i) => address(i + 1)),
    balances: Array.from({ length: n }, () => '1'),
    keep: Array.from({ length: n }, () => true),
  });

// `message` for a table of `n` players: the state, and the per-player lists that must line up with it
// (session keys, player signatures), all resized together.
const forPlayers = (message, n) => {
  const copy = { ...message, state: wireOf(n) };
  if ('sessionKeys' in message)
    copy.sessionKeys = Array.from({ length: n }, (_, i) => address(i + 11));
  if ('playerSigs' in message) copy.playerSigs = Array.from({ length: n }, () => SIG);
  return copy;
};

const MESSAGES = {
  claim: {
    schema: ClientMessage,
    message: { t: CLIENT.CLAIM, tableId: 'vault-1', address: address(1), sig: SIG },
  },
  sig: {
    schema: ClientMessage,
    message: { t: CLIENT.SIGN, nonce: '7', digest: DIGEST, sig: SIG },
  },
  epoch: {
    schema: ServerMessage,
    message: {
      t: SERVER.EPOCH,
      tableId: 'vault-1',
      epoch: 0,
      domain: DOMAIN,
      state: wire(),
      sessionKeys: [address(11), address(12), address(13)],
      arbiter: address(99),
    },
  },
  signreq: {
    schema: ServerMessage,
    message: {
      t: SERVER.SIGN_REQ,
      tableId: 'vault-1',
      epoch: 2,
      handNo: 14,
      state: wire(),
      digest: DIGEST,
      deadline: 1_700_000_030_000,
      reason: 'hand',
    },
  },
  bundle: {
    schema: ServerMessage,
    message: {
      t: SERVER.BUNDLE,
      tableId: 'vault-1',
      epoch: 2,
      domain: DOMAIN,
      state: wire(),
      arbiterSig: SIG,
      playerSigs: [SIG, SIG, SIG],
      sessionKeys: [address(11), address(12), address(13)],
    },
  },
};

const ABSENT = Symbol('absent');

/** A copy of `message` with the value at a dotted path replaced, or removed when ABSENT. */
function at(message, path, value) {
  const copy = structuredClone(message);
  const keys = path.split('.');
  let node = copy;
  for (const key of keys.slice(0, -1)) node = node[key];
  if (value === ABSENT) delete node[keys.at(-1)];
  else node[keys.at(-1)] = value;
  return copy;
}

const accepts = (kind, message) => MESSAGES[kind].schema.safeParse(message).success;

// ---- what every hex or number field has to refuse -------------------------------------------

const hexBad = (bytes) => [
  ['uppercase digits', `0x${'AB'.repeat(bytes)}`],
  ['mixed case', `0x${'aB'.repeat(bytes)}`],
  ['uppercase prefix', `0X${'ab'.repeat(bytes)}`],
  ['missing 0x', 'ab'.repeat(bytes)],
  ['one byte short', `0x${'ab'.repeat(bytes - 1)}`],
  ['one byte long', `0x${'ab'.repeat(bytes + 1)}`],
  ['odd number of digits', `0x${'ab'.repeat(bytes)}a`],
  ['empty', ''],
  ['only the prefix', '0x'],
  ['a non-hex character', `0x${'ab'.repeat(bytes - 1)}zz`],
  ['trailing newline', `0x${'ab'.repeat(bytes)}\n`],
  ['leading space', ` 0x${'ab'.repeat(bytes)}`],
  ['a number', 123],
  ['null', null],
  ['a byte array', Array.from({ length: bytes }, () => 171)],
  ['an object', {}],
];

const hexGood = (bytes) => [
  ['ordinary', `0x${'ab'.repeat(bytes)}`],
  ['all zero', `0x${'00'.repeat(bytes)}`],
  ['all ff', `0x${'ff'.repeat(bytes)}`],
  ['digits only', `0x${'09'.repeat(bytes)}`],
];

const numberBad = [
  ['a number', 5],
  ['a float', 1.5],
  ['a number too large for a double', 1e21],
  ['leading zero', '01'],
  ['zero with leading zeros', '00'],
  ['negative', '-1'],
  ['plus sign', '+1'],
  ['decimal point', '1.0'],
  ['exponent', '1e3'],
  ['hex', '0x10'],
  ['leading space', ' 1'],
  ['trailing newline', '1\n'],
  ['empty', ''],
  ['null', null],
  ['text', 'abc'],
  ['non-ASCII digits', '١٢٣'],
  ['a very long string', '9'.repeat(10_000)],
];

const uintBad = [
  ...numberBad,
  ['one above uint256', (2n ** 256n).toString()],
  ['79 digits', '9'.repeat(79)],
];
const u64Bad = [
  ...numberBad,
  ['one above uint64', (2n ** 64n).toString()],
  ['21 digits', '9'.repeat(21)],
  ['uint256 max', UINT256_MAX],
];

const TYPES = {
  addr: { bad: hexBad(20), good: hexGood(20) },
  bytes32: { bad: hexBad(32), good: hexGood(32) },
  sig65: { bad: hexBad(65), good: hexGood(65) },
  uint: {
    bad: uintBad,
    good: [
      ['zero', '0'],
      ['one', '1'],
      ['uint64 max', UINT64_MAX],
      ['uint256 max', UINT256_MAX],
    ],
  },
  u64: {
    bad: u64Bad,
    good: [
      ['zero', '0'],
      ['one', '1'],
      ['uint64 max', UINT64_MAX],
    ],
  },
};

// [message, dotted path to the field, its type]
const FIELDS = [
  ['claim', 'address', 'addr'],
  ['claim', 'sig', 'sig65'],
  ['sig', 'nonce', 'u64'],
  ['sig', 'digest', 'bytes32'],
  ['sig', 'sig', 'sig65'],
  ['epoch', 'arbiter', 'addr'],
  ['epoch', 'sessionKeys.0', 'addr'],
  ['epoch', 'state.tableId', 'bytes32'],
  ['epoch', 'state.nonce', 'u64'],
  ['epoch', 'state.players.1', 'addr'],
  ['epoch', 'state.balances.1', 'uint'],
  ['epoch', 'state.rake', 'uint'],
  ['epoch', 'state.volume', 'uint'],
  ['signreq', 'digest', 'bytes32'],
  ['signreq', 'state.tableId', 'bytes32'],
  ['signreq', 'state.nonce', 'u64'],
  ['signreq', 'state.balances.0', 'uint'],
  ['bundle', 'arbiterSig', 'sig65'],
  ['bundle', 'playerSigs.0', 'sig65'],
  ['bundle', 'playerSigs.2', 'sig65'],
  ['bundle', 'sessionKeys.0', 'addr'],
  ['bundle', 'state.players.2', 'addr'],
  ['bundle', 'state.volume', 'uint'],
];

describe('the sample messages are valid', () => {
  for (const kind of Object.keys(MESSAGES)) {
    test(`${kind}`, () => {
      const result = MESSAGES[kind].schema.safeParse(MESSAGES[kind].message);
      expect(result.error?.issues).toBeUndefined();
      expect(result.success).toBe(true);
    });
  }

  test('parsing changes nothing: no trimming, casing or number coercion', () => {
    for (const { schema, message } of Object.values(MESSAGES)) {
      expect(schema.parse(message)).toEqual(message);
    }
  });
});

describe('wire names are part of the protocol', () => {
  test('constants', () => {
    expect(CLIENT.CLAIM).toBe('claim');
    expect(CLIENT.SIGN).toBe('sig');
    expect(SERVER.EPOCH).toBe('epoch');
    expect(SERVER.SIGN_REQ).toBe('signreq');
    expect(SERVER.BUNDLE).toBe('bundle');
    expect(ERR.NOT_VAULT_TABLE).toBe('not-vault-table');
    expect(ERR.BAD_CLAIM).toBe('bad-claim');
    expect(ERR.BAD_SIGNATURE).toBe('bad-signature');
    expect(ERR.VAULT_LOCKED).toBe('vault-locked');
  });

  test('every CLIENT and SERVER type has a schema, and every schema a constant', () => {
    const typesOf = (union) => union.options.map((option) => option.shape.t.value).sort();
    expect(typesOf(ClientMessage)).toEqual(Object.values(CLIENT).sort());
    expect(typesOf(ServerMessage)).toEqual(Object.values(SERVER).sort());
  });

  test('VAULT_PHASES and SIGN_REASONS live in constants.js, frozen, and index.js re-exports them', () => {
    const lists = [
      [constants.VAULT_PHASES, root.VAULT_PHASES],
      [constants.SIGN_REASONS, root.SIGN_REASONS],
    ];
    for (const [list, reexported] of lists) {
      expect(Array.isArray(list)).toBe(true);
      expect(Object.isFrozen(list)).toBe(true);
      expect(new Set(list).size).toBe(list.length);
      expect(reexported).toBe(list); // the same array, not a copy
    }
    expect(() => constants.VAULT_PHASES.push('x')).toThrow(TypeError);
    expect(() => constants.SIGN_REASONS.push('x')).toThrow(TypeError);
  });

  test('the schemas accept exactly the values constants.js lists', () => {
    const phased = (phase) =>
      TableState.shape.vault.safeParse({
        epoch: 0,
        phase,
        nonce: '1',
        awaiting: [],
        deadline: null,
      }).success;
    for (const phase of constants.VAULT_PHASES) expect(phased(phase)).toBe(true);
    expect(phased('stalled ')).toBe(false);
    const reasoned = (reason) => accepts('signreq', at(MESSAGES.signreq.message, 'reason', reason));
    for (const reason of constants.SIGN_REASONS) expect(reasoned(reason)).toBe(true);
    expect(reasoned('hand ')).toBe(false);
  });

  test('constants.js has no imports, because the web bundle loads it', () => {
    const source = readFileSync(new URL('../src/constants.js', import.meta.url), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\bfrom\s+['"]/);
    expect(source).not.toMatch(/\brequire\(|\bimport\(/);
  });
});

describe('hex, amount and nonce fields', () => {
  for (const [kind, path, type] of FIELDS) {
    describe(`${kind}.${path} (${type})`, () => {
      for (const [label, value] of TYPES[type].good) {
        test(`accepts ${label}`, () => {
          expect(accepts(kind, at(MESSAGES[kind].message, path, value))).toBe(true);
        });
      }

      for (const [label, value] of TYPES[type].bad) {
        test(`refuses ${label} without throwing`, () => {
          const message = at(MESSAGES[kind].message, path, value);
          expect(() => MESSAGES[kind].schema.safeParse(message)).not.toThrow();
          expect(accepts(kind, message)).toBe(false);
        });
      }

      test('refuses it missing', () => {
        expect(accepts(kind, at(MESSAGES[kind].message, path, ABSENT))).toBe(false);
      });
    });
  }
});

describe('client messages', () => {
  for (const kind of ['claim', 'sig']) {
    test(`${kind}: an extra field is refused`, () => {
      const message = { ...MESSAGES[kind].message, extra: 1 };
      expect(accepts(kind, message)).toBe(false);
    });

    test(`${kind}: every field is required`, () => {
      for (const key of Object.keys(MESSAGES[kind].message).filter((k) => k !== 't')) {
        expect(accepts(kind, at(MESSAGES[kind].message, key, ABSENT))).toBe(false);
      }
    });
  }

  test('claim names a table like join does: 1 to 64 characters', () => {
    const claim = MESSAGES.claim.message;
    expect(accepts('claim', at(claim, 'tableId', 'x'))).toBe(true);
    expect(accepts('claim', at(claim, 'tableId', 'x'.repeat(LIMITS.maxTableIdLength)))).toBe(true);
    expect(accepts('claim', at(claim, 'tableId', ''))).toBe(false);
    expect(accepts('claim', at(claim, 'tableId', 'x'.repeat(LIMITS.maxTableIdLength + 1)))).toBe(
      false,
    );
    expect(accepts('claim', at(claim, 'tableId', 5))).toBe(false);
  });

  test('sig has no table: it always goes to the table the player sits at', () => {
    expect(accepts('sig', { ...MESSAGES.sig.message, tableId: 'vault-1' })).toBe(false);
  });

  test('the largest valid claim and sig fit in a message, with room to spare', () => {
    // JSON escapes a control character as \u0001, six characters per character: the worst case
    // for the table id. The nonce is the longest one a uint64 allows.
    const claim = {
      t: CLIENT.CLAIM,
      tableId: '\u0001'.repeat(LIMITS.maxTableIdLength),
      address: hexOf('ff', 20),
      sig: hexOf('ff', 65),
    };
    const sig = {
      t: CLIENT.SIGN,
      nonce: UINT64_MAX,
      digest: hexOf('ff', 32),
      sig: hexOf('ff', 65),
    };
    for (const message of [claim, sig]) {
      expect(ClientMessage.safeParse(message).success).toBe(true);
      const raw = JSON.stringify(message);
      // The Hub measures raw.length; the socket measures bytes. Both must fit.
      expect(raw.length).toBeLessThanOrEqual(LIMITS.maxMessageBytes / 2);
      expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(LIMITS.maxMessageBytes / 2);
    }
  });
});

describe('WireState', () => {
  test('accepts 2 to 10 players', () => {
    for (const n of [2, 3, 6, 10]) expect(WireState.safeParse(wireOf(n)).success).toBe(true);
  });

  test('refuses 0, 1 and 11 players', () => {
    for (const n of [0, 1, 11, 12]) expect(WireState.safeParse(wireOf(n)).success).toBe(false);
  });

  test('refuses arrays that do not line up', () => {
    const six = wireOf(6);
    for (const key of ['players', 'balances', 'keep']) {
      expect(WireState.safeParse({ ...six, [key]: six[key].slice(1) }).success).toBe(false);
      expect(WireState.safeParse({ ...six, [key]: [...six[key], six[key][0]] }).success).toBe(
        false,
      );
    }
    // Two of the three short at once, matching each other but not the third.
    const short = { ...six, players: six.players.slice(1), balances: six.balances.slice(1) };
    expect(WireState.safeParse(short).success).toBe(false);
  });

  test('a mismatch is reported without crashing when an array is not an array', () => {
    for (const key of ['players', 'balances', 'keep']) {
      for (const bad of ['x', null, {}, 3]) {
        const result = WireState.safeParse({ ...wire(), [key]: bad });
        expect(result.success).toBe(false);
      }
    }
  });

  test('isFinal and keep hold real booleans', () => {
    expect(WireState.safeParse(wire({ isFinal: 'true' })).success).toBe(false);
    expect(WireState.safeParse(wire({ isFinal: 1 })).success).toBe(false);
    expect(WireState.safeParse(wire({ isFinal: true })).success).toBe(true);
    expect(WireState.safeParse(wire({ keep: [true, 1, true] })).success).toBe(false);
    expect(WireState.safeParse(wire({ keep: [true, 'false', true] })).success).toBe(false);
  });

  test('every field is required', () => {
    for (const key of Object.keys(wire())) {
      const state = wire();
      delete state[key];
      expect(WireState.safeParse(state).success).toBe(false);
    }
  });

  test('the same limits apply inside every message that carries a state', () => {
    for (const kind of ['epoch', 'signreq', 'bundle']) {
      const message = MESSAGES[kind].message;
      // The per-player lists (session keys, signatures) grow and shrink with the state.
      expect(accepts(kind, forPlayers(message, 2))).toBe(true);
      expect(accepts(kind, forPlayers(message, 10))).toBe(true);
      expect(accepts(kind, forPlayers(message, 1))).toBe(false);
      expect(accepts(kind, forPlayers(message, 11))).toBe(false);
      expect(accepts(kind, at(message, 'state.keep', [true, true]))).toBe(false);
      expect(accepts(kind, at(message, 'state.balances', ['1', '2', '3', '4']))).toBe(false);
      expect(accepts(kind, at(message, 'state', ABSENT))).toBe(false);
    }
  });
});

describe('server messages', () => {
  test('signreq accepts every reason and nothing else', () => {
    for (const reason of SIGN_REASONS) {
      expect(accepts('signreq', at(MESSAGES.signreq.message, 'reason', reason))).toBe(true);
    }
    expect(SIGN_REASONS).toEqual([
      'hand',
      'bust',
      'leave',
      'idle',
      'join',
      'topup',
      'drain',
      'maintenance',
      'exit-recovery',
    ]);
    for (const bad of ['Hand', 'timeout', '', null, 3]) {
      expect(accepts('signreq', at(MESSAGES.signreq.message, 'reason', bad))).toBe(false);
    }
  });

  test('signreq: handNo is a non-negative integer or null, deadline a number', () => {
    const message = MESSAGES.signreq.message;
    for (const ok of [0, 1, 400, null])
      expect(accepts('signreq', at(message, 'handNo', ok))).toBe(true);
    for (const bad of [-1, 1.5, '3', undefined]) {
      expect(accepts('signreq', at(message, 'handNo', bad ?? ABSENT))).toBe(false);
    }
    expect(accepts('signreq', at(message, 'deadline', '1700000030000'))).toBe(false);
    expect(accepts('signreq', at(message, 'deadline', null))).toBe(false);
    expect(accepts('signreq', at(message, 'deadline', ABSENT))).toBe(false);
  });

  test('epoch numbers are integers from zero', () => {
    for (const kind of ['epoch', 'signreq', 'bundle']) {
      const message = MESSAGES[kind].message;
      expect(accepts(kind, at(message, 'epoch', 0))).toBe(true);
      expect(accepts(kind, at(message, 'epoch', 41))).toBe(true);
      for (const bad of [-1, 0.5, '1', null])
        expect(accepts(kind, at(message, 'epoch', bad))).toBe(false);
      expect(accepts(kind, at(message, 'epoch', ABSENT))).toBe(false);
    }
  });

  test('bundle carries 2 to 10 player signatures, one per player', () => {
    const message = MESSAGES.bundle.message;
    const sigs = (n) => Array.from({ length: n }, () => SIG);
    for (const n of [2, 3, 10]) expect(accepts('bundle', forPlayers(message, n))).toBe(true);
    for (const n of [0, 1, 11])
      expect(accepts('bundle', at(forPlayers(message, 3), 'playerSigs', sigs(n)))).toBe(false);
  });

  test('session keys are a list of addresses, one per player', () => {
    for (const kind of ['epoch', 'bundle']) {
      const message = MESSAGES[kind].message;
      expect(accepts(kind, at(message, 'sessionKeys', 'x'))).toBe(false);
      expect(accepts(kind, at(message, 'sessionKeys', ABSENT))).toBe(false);
      expect(accepts(kind, at(message, 'sessionKeys', [address(11), address(12), 7]))).toBe(false);
    }
  });

  test('every message carries the domain its state was signed under', () => {
    for (const kind of ['epoch', 'bundle']) {
      const message = MESSAGES[kind].message;
      expect(accepts(kind, at(message, 'domain', ABSENT))).toBe(false);
      expect(accepts(kind, at(message, 'domain', null))).toBe(false);
      expect(accepts(kind, at(message, 'domain.chainId', ABSENT))).toBe(false);
      expect(accepts(kind, at(message, 'domain.verifyingContract', ABSENT))).toBe(false);
      for (const chainId of [1, 137, Number.MAX_SAFE_INTEGER]) {
        expect(accepts(kind, at(message, 'domain.chainId', chainId))).toBe(true);
      }
      for (const bad of [0, -1, 1.5, '137', 137n, null, NaN, Infinity, 2 ** 60]) {
        const patched = at(message, 'domain.chainId', 1);
        patched.domain.chainId = bad;
        expect(accepts(kind, patched)).toBe(false);
      }
      for (const [, bad] of hexBad(20)) {
        expect(accepts(kind, at(message, 'domain.verifyingContract', bad))).toBe(false);
      }
      for (const [, good] of hexGood(20)) {
        expect(accepts(kind, at(message, 'domain.verifyingContract', good))).toBe(true);
      }
      // A key the library does not know would change what people sign; it is refused, not dropped.
      expect(accepts(kind, at(message, 'domain.name', 'PGG PokerVault'))).toBe(false);
    }
  });

  test('the domain survives parsing unchanged', () => {
    for (const kind of ['epoch', 'bundle']) {
      const parsed = ServerMessage.parse(MESSAGES[kind].message);
      expect(parsed.domain).toEqual(DOMAIN);
    }
  });

  test('sessionKeys must have exactly one entry per player', () => {
    for (const kind of ['epoch', 'bundle']) {
      for (const n of [2, 3, 6, 10]) {
        const message = forPlayers(MESSAGES[kind].message, n);
        const keys = (count) => Array.from({ length: count }, (_, i) => address(i + 11));
        expect(accepts(kind, message)).toBe(true);
        expect(accepts(kind, at(message, 'sessionKeys', keys(n - 1)))).toBe(false);
        expect(accepts(kind, at(message, 'sessionKeys', keys(n + 1)))).toBe(false);
        expect(accepts(kind, at(message, 'sessionKeys', []))).toBe(false);
      }
    }
  });

  test('playerSigs must have exactly one entry per player', () => {
    const sigs = (count) => Array.from({ length: count }, () => SIG);
    for (const n of [2, 3, 6, 10]) {
      const message = forPlayers(MESSAGES.bundle.message, n);
      expect(accepts('bundle', message)).toBe(true);
      expect(accepts('bundle', at(message, 'playerSigs', sigs(n - 1)))).toBe(false);
      if (n < 10) expect(accepts('bundle', at(message, 'playerSigs', sigs(n + 1)))).toBe(false);
    }
  });

  test('a length mismatch is reported on the list that is wrong', () => {
    const issuesOf = (kind, message) => MESSAGES[kind].schema.safeParse(message).error.issues;
    const short = at(MESSAGES.bundle.message, 'sessionKeys', [address(11), address(12)]);
    expect(issuesOf('bundle', short).map((i) => i.path)).toEqual([['sessionKeys']]);
    const fewSigs = at(MESSAGES.bundle.message, 'playerSigs', [SIG, SIG]);
    expect(issuesOf('bundle', fewSigs).map((i) => i.path)).toEqual([['playerSigs']]);
    const both = at(short, 'playerSigs', [SIG, SIG]);
    expect(
      issuesOf('bundle', both)
        .map((i) => i.path[0])
        .sort(),
    ).toEqual(['playerSigs', 'sessionKeys']);
    const epoch = at(MESSAGES.epoch.message, 'sessionKeys', [address(11)]);
    expect(issuesOf('epoch', epoch).map((i) => i.path)).toEqual([['sessionKeys']]);
  });

  test('the length check never throws on a message that is broken in other ways', () => {
    for (const kind of ['epoch', 'bundle']) {
      const message = MESSAGES[kind].message;
      const broken = [
        at(message, 'state', ABSENT),
        at(message, 'state', null),
        at(message, 'state', 'x'),
        at(message, 'state.players', null),
        at(message, 'state.players', ABSENT),
        at(message, 'sessionKeys', null),
        at(message, 'sessionKeys', 'abc'),
        at(message, 'sessionKeys', ABSENT),
        ...(kind === 'bundle'
          ? [
              at(message, 'playerSigs', null),
              at(message, 'playerSigs', 'abc'),
              at(message, 'playerSigs', ABSENT),
            ]
          : []),
      ];
      for (const candidate of broken) {
        expect(() => MESSAGES[kind].schema.safeParse(candidate)).not.toThrow();
        expect(accepts(kind, candidate)).toBe(false);
      }
    }
  });

  test('required fields cannot be left out', () => {
    for (const kind of ['epoch', 'signreq', 'bundle']) {
      for (const key of Object.keys(MESSAGES[kind].message).filter((k) => k !== 't')) {
        expect(accepts(kind, at(MESSAGES[kind].message, key, ABSENT))).toBe(false);
      }
    }
  });
});

describe('optional vault fields on the existing schemas', () => {
  const summary = {
    id: 'table-1',
    name: 'Table 1',
    smallBlind: 5,
    bigBlind: 10,
    minBuyIn: 100,
    maxBuyIn: 1000,
    numSeats: 6,
    occupied: 2,
    rakeBps: 300,
  };
  const vaultSummary = {
    chainId: 137,
    vault: address(0xabc),
    tableKey: TABLE,
    chipUnit: '10000',
    maxRakeBps: 500,
    exitWindowSec: 86_400,
    arbiter: address(99),
  };
  const playState = {
    tableId: 'table-1',
    name: 'Table 1',
    handNo: null,
    inHand: false,
    button: null,
    toAct: null,
    round: null,
    board: [],
    pot: 0,
    seats: [
      {
        seat: 0,
        playerId: 'p1',
        name: 'Ann',
        chips: 100,
        bet: 0,
        folded: false,
        allIn: false,
        hasCards: false,
        status: 'seated',
        connected: true,
      },
      null,
    ],
    legal: null,
    deadline: null,
    fairness: { current: null, next: null },
  };
  const vaultState = {
    epoch: 3,
    phase: 'active',
    nonce: '41',
    awaiting: [0, 2],
    deadline: 1_700_000_030_000,
  };

  test('a play table without them parses, and nothing is added to it', () => {
    const parsedSummary = TableSummary.parse(summary);
    expect(parsedSummary).toEqual(summary);
    expect('vault' in parsedSummary).toBe(false);

    const parsedState = TableState.parse(playState);
    expect(parsedState).toEqual(playState);
    expect('vault' in parsedState).toBe(false);
    expect('address' in parsedState.seats[0]).toBe(false);
  });

  test('a play table inside a lobby or table message still validates', () => {
    expect(
      ServerMessage.safeParse({ t: SERVER.LOBBY, tables: [summary, { ...summary, id: 'b' }] })
        .success,
    ).toBe(true);
    expect(
      ServerMessage.safeParse({
        t: SERVER.TABLE,
        tableId: 'table-1',
        seq: 4,
        state: playState,
        events: [],
      }).success,
    ).toBe(true);
  });

  test('TableSummary.vault is kept, not stripped, and is checked', () => {
    const parsed = TableSummary.parse({ ...summary, vault: vaultSummary });
    expect(parsed.vault).toEqual(vaultSummary);

    const bad = (patch) =>
      TableSummary.safeParse({ ...summary, vault: { ...vaultSummary, ...patch } });
    expect(bad({}).success).toBe(true);
    expect(bad({ vault: address(0xabc).toUpperCase() }).success).toBe(false);
    expect(bad({ vault: '0xabc' }).success).toBe(false);
    expect(bad({ tableKey: 'ab'.repeat(32) }).success).toBe(false);
    expect(bad({ arbiter: hexOf('ab', 32) }).success).toBe(false);
    expect(bad({ chipUnit: 10_000 }).success).toBe(false);
    expect(bad({ chipUnit: '010000' }).success).toBe(false);
    expect(bad({ chainId: '137' }).success).toBe(false);
    expect(bad({ maxRakeBps: 1.5 }).success).toBe(false);
    for (const key of Object.keys(vaultSummary)) {
      const partial = { ...vaultSummary };
      delete partial[key];
      expect(TableSummary.safeParse({ ...summary, vault: partial }).success).toBe(false);
    }
  });

  test('TableSummary.vault stays inside what PokerVault itself accepts', () => {
    const ok = (patch) =>
      TableSummary.safeParse({ ...summary, vault: { ...vaultSummary, ...patch } }).success;
    // chainId: a positive integer
    expect(ok({ chainId: 1 })).toBe(true);
    for (const chainId of [0, -1, 1.5, '1', null, NaN]) expect(ok({ chainId })).toBe(false);
    // chipUnit: a uint of at least 1
    for (const chipUnit of ['1', '2', '10000', UINT256_MAX]) expect(ok({ chipUnit })).toBe(true);
    for (const chipUnit of ['0', '00', '01', '', '-1', 1, 0, null, (2n ** 256n).toString()]) {
      expect(ok({ chipUnit })).toBe(false);
    }
    // maxRakeBps: 0 to RAKE_BPS_CEILING (500)
    for (const maxRakeBps of [0, 1, 250, 500]) expect(ok({ maxRakeBps })).toBe(true);
    for (const maxRakeBps of [-1, 501, 10_000, 2.5, '500', null]) {
      expect(ok({ maxRakeBps })).toBe(false);
    }
    // exitWindowSec: MIN_EXIT_WINDOW (1 hour) to MAX_EXIT_WINDOW (30 days)
    for (const exitWindowSec of [3600, 3601, 86_400, 2_592_000]) {
      expect(ok({ exitWindowSec })).toBe(true);
    }
    for (const exitWindowSec of [0, -1, 1, 3599, 2_592_001, 86_400.5, '86400', null]) {
      expect(ok({ exitWindowSec })).toBe(false);
    }
  });

  test('TableState.vault is kept, not stripped, and is checked', () => {
    const parsed = TableState.parse({ ...playState, vault: vaultState });
    expect(parsed.vault).toEqual(vaultState);

    const bad = (patch) =>
      TableState.safeParse({ ...playState, vault: { ...vaultState, ...patch } });
    expect(bad({ deadline: null }).success).toBe(true);
    for (const phase of VAULT_PHASES) expect(bad({ phase }).success).toBe(true);
    expect(bad({ phase: 'open' }).success).toBe(false);
    expect(bad({ nonce: 41 }).success).toBe(false);
    expect(bad({ nonce: '041' }).success).toBe(false);
    expect(bad({ epoch: -1 }).success).toBe(false);
    expect(bad({ awaiting: [10] }).success).toBe(false);
    expect(bad({ awaiting: ['0'] }).success).toBe(false);
    expect(bad({ awaiting: [] }).success).toBe(true);
    expect(bad({ awaiting: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] }).success).toBe(true);
    expect(bad({ awaiting: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0] }).success).toBe(false); // more than 10 seats
    expect(bad({ deadline: '1' }).success).toBe(false);
    for (const key of Object.keys(vaultState)) {
      const partial = { ...vaultState };
      delete partial[key];
      expect(TableState.safeParse({ ...playState, vault: partial }).success).toBe(false);
    }
  });

  test('VAULT_PHASES lists the epoch machine', () => {
    expect(VAULT_PHASES).toEqual([
      'creating',
      'filling',
      'starting',
      'active',
      'settling',
      'stalled',
      'exiting',
      'closed',
      'halted',
    ]);
  });

  test('a seat may carry the address it claimed, in canonical form only', () => {
    const withSeat = (patch) => ({
      ...playState,
      seats: [{ ...playState.seats[0], ...patch }, null],
    });
    const parsed = TableState.parse(withSeat({ address: address(5) }));
    expect(parsed.seats[0].address).toBe(address(5));
    expect(TableState.safeParse(withSeat({ address: address(5).toUpperCase() })).success).toBe(
      false,
    );
    expect(TableState.safeParse(withSeat({ address: 'ann' })).success).toBe(false);
    expect(TableState.safeParse(withSeat({ address: null })).success).toBe(false);
  });
});
