// chainview.js without a chain: the hand-written ABI codec against viem on random inputs, the JSON-RPC client
// against a hostile or broken node (a fake `fetch`, plus one real HTTP server), and every refusal rule of the
// pure epoch verification. The same functions run against a real anvil in chain/chainview.test.js.
import { describe, expect, test } from 'bun:test';
import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  toFunctionSelector,
} from 'viem';
import { pokerVaultAbi } from '../src/abi.js';
import { buildNextState, epochBaseline } from '../src/build.js';
import {
  chainShowsSettled,
  createRpcChainView,
  decodeSeat,
  decodeTableRow,
  EPOCH_RULES,
  encodeSeatsCall,
  encodeTablesCall,
  SEATS_SELECTOR,
  TABLES_SELECTOR,
  verifyEpochAgainstChain,
} from '../src/chainview.js';
import { STATUS, tableFromChain } from '../src/check.js';
import { rosterHash } from '../src/state.js';
import { makeWorld, UNIT, VAULT } from './fixtures.js';
import { makeRng, UINT64_MAX, UINT256_MAX } from './gen.js';

const outputsOf = (name) =>
  pokerVaultAbi.find((e) => e.type === 'function' && e.name === name).outputs;
const ZERO32 = `0x${'00'.repeat(32)}`;
const word = (value) => value.toString(16).padStart(64, '0');

// a table row as the contract returns it, field by field, and its ABI encoding made by viem
const TABLE_FIELDS = [
  'status',
  'maxPlayers',
  'seated',
  'arbiter',
  'nonce',
  'exitDeadline',
  'minDeposit',
  'maxDeposit',
  'escrow',
  'rakePaid',
  'rosterHash',
  'exitDigest',
];
const encodeRow = (row) =>
  encodeAbiParameters(
    outputsOf('tables'),
    TABLE_FIELDS.map((f) => row[f]),
  );
const emptyRow = () => ({
  status: 0,
  maxPlayers: 0,
  seated: 0,
  arbiter: `0x${'00'.repeat(20)}`,
  nonce: 0n,
  exitDeadline: 0n,
  minDeposit: 0n,
  maxDeposit: 0n,
  escrow: 0n,
  rakePaid: 0n,
  rosterHash: ZERO32,
  exitDigest: ZERO32,
});
const randomRow = (rng) => {
  const status = rng.int(5);
  if (status === 0) return emptyRow();
  const amount = () => (rng.bool(0.1) ? UINT256_MAX : rng.bigint(rng.pick([0, 8, 64, 128, 256])));
  return {
    status,
    maxPlayers: rng.bool(0.1) ? 255 : rng.int(256),
    seated: rng.bool(0.1) ? 255 : rng.int(256),
    arbiter: rng.hex(20),
    nonce: rng.bool(0.1) ? UINT64_MAX : rng.bigint(64),
    exitDeadline: rng.bool(0.1) ? UINT64_MAX : rng.bigint(64),
    minDeposit: amount(),
    maxDeposit: amount(),
    escrow: amount(),
    rakePaid: amount(),
    rosterHash: rng.hex(32),
    exitDigest: rng.hex(32),
  };
};
const encodeSeat = (deposit, sessionKey) =>
  encodeAbiParameters(outputsOf('seats'), [deposit, sessionKey]);

describe('the ABI codec against viem', () => {
  test('the selectors are the first four bytes of keccak256 of the signature text', () => {
    expect(TABLES_SELECTOR).toBe(toFunctionSelector('tables(bytes32)'));
    expect(SEATS_SELECTOR).toBe(toFunctionSelector('seats(bytes32,address)'));
    expect(TABLES_SELECTOR).toMatch(/^0x[0-9a-f]{8}$/);
    expect(SEATS_SELECTOR).not.toBe(TABLES_SELECTOR);
    // and they are the selectors of the real contract's functions
    const abiSelector = (name) =>
      toFunctionSelector(pokerVaultAbi.find((e) => e.type === 'function' && e.name === name));
    expect(TABLES_SELECTOR).toBe(abiSelector('tables'));
    expect(SEATS_SELECTOR).toBe(abiSelector('seats'));
  });

  test('the return types are exactly the ones this decoder assumes (12 and 2 static words)', () => {
    expect(outputsOf('tables').map((o) => o.name)).toEqual(TABLE_FIELDS);
    expect(outputsOf('tables').map((o) => o.type)).toEqual([
      'uint8',
      'uint8',
      'uint8',
      'address',
      'uint64',
      'uint64',
      'uint256',
      'uint256',
      'uint256',
      'uint256',
      'bytes32',
      'bytes32',
    ]);
    expect(outputsOf('seats').map((o) => `${o.name}:${o.type}`)).toEqual([
      'deposit:uint256',
      'sessionKey:address',
    ]);
    // Status is a uint8 enum with five members: None, Filling, Active, Exiting, Closed
    expect(Object.keys(STATUS)).toHaveLength(5);
  });

  test('encodeTablesCall and encodeSeatsCall equal viem encodeFunctionData on 400 random inputs', () => {
    const rng = makeRng(7001);
    for (let i = 0; i < 400; i++) {
      const key = rng.hex(32);
      const who = rng.hex(20);
      expect(encodeTablesCall(key)).toBe(
        encodeFunctionData({ abi: pokerVaultAbi, functionName: 'tables', args: [key] }),
      );
      expect(encodeSeatsCall(key, who)).toBe(
        encodeFunctionData({ abi: pokerVaultAbi, functionName: 'seats', args: [key, who] }),
      );
    }
  });

  test('the encoders take any case, lowercase the result, and refuse a key or address that is not one', () => {
    const key = `0x${'AB'.repeat(32)}`;
    const who = getAddress(`0x${'cd'.repeat(20)}`);
    expect(encodeTablesCall(key)).toBe(`${TABLES_SELECTOR}${'ab'.repeat(32)}`);
    expect(encodeSeatsCall(key, who)).toBe(
      `${SEATS_SELECTOR}${'ab'.repeat(32)}${'00'.repeat(12)}${'cd'.repeat(20)}`,
    );
    for (const bad of [
      undefined,
      null,
      5,
      '0x12',
      `0x${'ab'.repeat(33)}`,
      `0x${'zz'.repeat(32)}`,
      'ab'.repeat(32),
    ]) {
      expect(() => encodeTablesCall(bad), String(bad)).toThrow(RangeError);
      expect(() => encodeSeatsCall(bad, who), String(bad)).toThrow(RangeError);
    }
    for (const bad of [undefined, '0x12', `0x${'ab'.repeat(21)}`, 5n]) {
      expect(() => encodeSeatsCall(key, bad), String(bad)).toThrow(RangeError);
    }
  });

  test('decodeTableRow equals viem decodeFunctionResult on 500 random rows', () => {
    const rng = makeRng(7002);
    const seenStatus = new Set();
    for (let i = 0; i < 500; i++) {
      const row = randomRow(rng);
      seenStatus.add(row.status);
      const data = encodeRow(row);
      const viaViem = decodeFunctionResult({ abi: pokerVaultAbi, functionName: 'tables', data });
      const mine = decodeTableRow(data);
      TABLE_FIELDS.forEach((field, k) => {
        const expected = field === 'arbiter' ? viaViem[k].toLowerCase() : viaViem[k];
        // viem returns uint64 as bigint and uint8 as number: so does this decoder
        expect(mine[field], `${field} in row ${i}`).toEqual(
          field === 'rosterHash' || field === 'exitDigest' ? expected.toLowerCase() : expected,
        );
      });
      // and it is the shape tableFromChain already accepts, with viem's array form giving the same row
      expect(tableFromChain(mine)).toEqual(
        tableFromChain(
          viaViem.map((v, k) => (TABLE_FIELDS[k] === 'arbiter' ? v.toLowerCase() : v)),
        ),
      );
    }
    expect([...seenStatus].sort()).toEqual([0, 1, 2, 3, 4]);
  });

  test('decodeTableRow takes upper-case hex and extremes: uint64 and uint256 maxima, 255 seats', () => {
    const row = {
      ...randomRow(makeRng(1)),
      status: 4,
      maxPlayers: 255,
      seated: 255,
      nonce: UINT64_MAX,
      exitDeadline: UINT64_MAX,
      minDeposit: UINT256_MAX,
      maxDeposit: UINT256_MAX,
      escrow: UINT256_MAX,
      rakePaid: UINT256_MAX,
    };
    const data = encodeRow(row);
    const decoded = decodeTableRow(`0x${data.slice(2).toUpperCase()}`);
    expect(decoded.nonce).toBe(UINT64_MAX);
    expect(decoded.escrow).toBe(UINT256_MAX);
    expect(decoded.maxPlayers).toBe(255);
    expect(decoded.rosterHash).toBe(row.rosterHash.toLowerCase());
  });

  test('decodeSeat equals viem on 300 random seats, and an empty seat is null', () => {
    const rng = makeRng(7003);
    for (let i = 0; i < 300; i++) {
      const deposit = rng.bool(0.1) ? UINT256_MAX : 1n + rng.bigint(rng.pick([8, 64, 128, 255]));
      const key = rng.hex(20);
      const data = encodeSeat(deposit, key);
      const [d, k] = decodeFunctionResult({ abi: pokerVaultAbi, functionName: 'seats', data });
      expect(decodeSeat(data)).toEqual({ deposit: d, sessionKey: k.toLowerCase() });
    }
    expect(decodeSeat(encodeSeat(0n, `0x${'00'.repeat(20)}`))).toBeNull();
  });
});

describe('the decoders refuse anything the contract would not return', () => {
  const good = encodeRow({ ...randomRow(makeRng(5)), status: 2 });
  const words = (hex) => hex.slice(2).match(/.{64}/g);
  const patchWord = (hex, index, value) => {
    const w = words(hex);
    w[index] = value;
    return `0x${w.join('')}`;
  };
  const bad = (hex) => expect(() => decodeTableRow(hex)).toThrow(RangeError);

  test('wrong lengths, not hex, not a string', () => {
    for (const hex of [
      '0x',
      '0x00',
      good.slice(0, -2),
      good.slice(0, -64),
      `${good}00`,
      `${good}${'00'.repeat(32)}`,
      good.slice(2),
      `0X${good.slice(2)}`,
      `0x${'zz'.repeat(384)}`,
      `0x${good.slice(2, -1)}g`,
      undefined,
      null,
      12,
      {},
      [],
    ]) {
      bad(hex);
    }
    expect(() => decodeSeat(`0x${'00'.repeat(63)}`)).toThrow(RangeError);
    expect(() => decodeSeat(`0x${'00'.repeat(65)}`)).toThrow(RangeError);
    expect(() => decodeSeat(null)).toThrow(RangeError);
  });

  test('a status above Closed, and uint8, uint64 and address words with bits outside their type', () => {
    bad(patchWord(good, 0, word(5n)));
    bad(patchWord(good, 0, word(1n << 255n)));
    bad(patchWord(good, 1, word(256n)));
    bad(patchWord(good, 2, word(256n)));
    bad(patchWord(good, 4, word(1n << 64n)));
    bad(patchWord(good, 5, word(1n << 64n)));
    bad(patchWord(good, 3, `${'ff'.repeat(12)}${'11'.repeat(20)}`)); // dirty high bytes of the address
    bad(patchWord(good, 3, `0000000000000000000000010000000000000000000000000000000000000001`));
    // the boundaries just inside are fine
    expect(decodeTableRow(patchWord(good, 0, word(4n))).status).toBe(4);
    expect(decodeTableRow(patchWord(good, 1, word(255n))).maxPlayers).toBe(255);
    expect(decodeTableRow(patchWord(good, 4, word((1n << 64n) - 1n))).nonce).toBe(UINT64_MAX);
  });

  test('a table with no status must be empty: data under status None is a lie', () => {
    expect(decodeTableRow(encodeRow(emptyRow()))).toMatchObject({
      status: 0,
      nonce: 0n,
      seated: 0,
    });
    for (let i = 1; i < 12; i++) {
      bad(patchWord(encodeRow(emptyRow()), i, word(1n)));
    }
  });

  test('a seat is a deposit and a key, or neither', () => {
    const key = `0x${'ab'.repeat(20)}`;
    expect(() => decodeSeat(encodeSeat(5n, `0x${'00'.repeat(20)}`))).toThrow(RangeError);
    expect(() => decodeSeat(encodeSeat(0n, key))).toThrow(RangeError);
    expect(() => decodeSeat(`0x${word(5n)}${'ff'.repeat(12)}${'ab'.repeat(20)}`)).toThrow(
      RangeError,
    );
    expect(decodeSeat(encodeSeat(1n, key))).toEqual({ deposit: 1n, sessionKey: key });
  });

  test('a hostile megabyte string is refused by its length, not walked', () => {
    const huge = `0x${'0'.repeat(5_000_000)}`;
    expect(() => decodeTableRow(huge)).toThrow(RangeError);
    expect(() => decodeSeat(huge)).toThrow(RangeError);
  });
});

// ---- the JSON-RPC client -----------------------------------------------------------------------------------

const KEY = `0x${'ab'.repeat(32)}`;
const WHO = `0x${'cd'.repeat(20)}`;
const LIVE_ROW = {
  status: 2,
  maxPlayers: 6,
  seated: 3,
  arbiter: `0x${'11'.repeat(20)}`,
  nonce: 7n,
  exitDeadline: 0n,
  minDeposit: 1n,
  maxDeposit: 10n ** 12n,
  escrow: 3_000_000n,
  rakePaid: 4n,
  rosterHash: `0x${'22'.repeat(32)}`,
  exitDigest: ZERO32,
};

// A fetch that answers every JSON-RPC request through `handler(request) -> body`, where body is an object
// (sent as JSON) or a string (sent as it is). The request id is passed in so a reply can echo it.
function fakeFetch(handler, { status = 200 } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    const request = JSON.parse(init.body);
    calls.push({ url, init, request });
    const body = await handler(request, calls.length);
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  };
  fn.calls = calls;
  return fn;
}
const reply = (request, result) => ({ jsonrpc: '2.0', id: request.id, result });
const viewWith = (fetch, extra = {}) =>
  createRpcChainView({ rpcUrl: 'http://rpc.invalid', vault: VAULT, fetch, ...extra });
// the unusable outcomes all look like this
const failure = expect.objectContaining({ ok: false, error: expect.any(String) });

describe('createRpcChainView: honest answers', () => {
  test('table(): an eth_call at latest on the vault, decoded', async () => {
    const fetch = fakeFetch((req) => reply(req, encodeRow(LIVE_ROW)));
    const view = viewWith(fetch);
    const result = await view.table(KEY);
    expect(result).toEqual({ ok: true, table: { ...LIVE_ROW } });
    const { url, init, request } = fetch.calls[0];
    expect(url).toBe('http://rpc.invalid');
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(request).toEqual({
      jsonrpc: '2.0',
      id: expect.any(Number),
      method: 'eth_call',
      params: [{ to: VAULT, data: encodeTablesCall(KEY) }, 'latest'],
    });
  });

  test('seat(): the encoded call, the decoded seat, and null for an empty one', async () => {
    const key = `0x${'ee'.repeat(20)}`;
    const fetch = fakeFetch((req) =>
      reply(
        req,
        req.params[0].data.includes('cd'.repeat(20))
          ? encodeSeat(9n, key)
          : encodeSeat(0n, `0x${'00'.repeat(20)}`),
      ),
    );
    const view = viewWith(fetch);
    expect(await view.seat(KEY, WHO)).toEqual({ ok: true, seat: { deposit: 9n, sessionKey: key } });
    expect(await view.seat(KEY, `0x${'01'.repeat(20)}`)).toEqual({ ok: true, seat: null });
    expect(fetch.calls[0].request.params[0].data).toBe(encodeSeatsCall(KEY, WHO));
  });

  test('table() of a table that does not exist is null, not an error', async () => {
    const view = viewWith(fakeFetch((req) => reply(req, encodeRow(emptyRow()))));
    expect(await view.table(KEY)).toEqual({ ok: true, table: null });
  });

  test('blockTimestamp(): eth_getBlockByNumber latest, as a bigint of seconds', async () => {
    const fetch = fakeFetch((req) =>
      reply(req, { number: '0x10', timestamp: '0x65f0a1b2', hash: '0x01' }),
    );
    const view = viewWith(fetch);
    expect(await view.blockTimestamp()).toEqual({ ok: true, timestamp: 0x65f0a1b2n });
    expect(fetch.calls[0].request.method).toBe('eth_getBlockByNumber');
    expect(fetch.calls[0].request.params).toEqual(['latest', false]);
    const zero = viewWith(fakeFetch((req) => reply(req, { timestamp: '0x0' })));
    expect(await zero.blockTimestamp()).toEqual({ ok: true, timestamp: 0n });
  });

  test('request ids are distinct and each answer is matched to its own request, even out of order', async () => {
    const rows = [1n, 2n, 3n].map((nonce) => ({ ...LIVE_ROW, nonce }));
    const fetch = fakeFetch(async (req) => {
      const which = Number(req.params[0].data.slice(-2)) % 10; // the last key byte picks the row
      await new Promise((r) => setTimeout(r, (4 - which) * 5)); // the later keys answer first
      return reply(req, encodeRow(rows[which - 1]));
    });
    const view = viewWith(fetch);
    const keys = [1, 2, 3].map((n) => `0x${'00'.repeat(31)}0${n}`);
    const results = await Promise.all(keys.map((k) => view.table(k)));
    expect(results.map((r) => r.table.nonce)).toEqual([1n, 2n, 3n]);
    expect(new Set(fetch.calls.map((c) => c.request.id)).size).toBe(3);
  });

  test('the vault address is lowercased, and the url and vault are only what the constructor was given', async () => {
    const fetch = fakeFetch((req) => reply(req, encodeRow(LIVE_ROW)));
    const view = createRpcChainView({
      rpcUrl: 'https://rpc.example/key',
      vault: getAddress(VAULT),
      fetch,
    });
    await view.table(KEY);
    expect(fetch.calls[0].request.params[0].to).toBe(VAULT);
    expect(fetch.calls[0].url).toBe('https://rpc.example/key');
  });
});

describe('createRpcChainView: a hostile or broken node never makes it throw', () => {
  const GOOD_ROW = encodeRow(LIVE_ROW);
  const GOOD_SEAT = encodeSeat(5n, `0x${'ab'.repeat(20)}`);
  const GOOD_BLOCK = { timestamp: '0x10' };

  // every way a response can be wrong, applied to table(), seat() and blockTimestamp()
  const envelopes = {
    'a network error': () => {
      throw new Error('connect ECONNREFUSED');
    },
    'a rejection with a string': () => Promise.reject('boom'),
    'a rejection with null': () => Promise.reject(null),
    'a body that is not JSON': () => 'not json at all',
    'an empty body': () => '',
    'JSON null': () => 'null',
    'a JSON number': () => '42',
    'a JSON string with hex': () => JSON.stringify(GOOD_ROW),
    'a batch (array) reply': (req, body) => [body(req)],
    'no jsonrpc member': (req, body) => {
      const { jsonrpc, ...rest } = body(req);
      return rest;
    },
    'jsonrpc 1.0': (req, body) => ({ ...body(req), jsonrpc: '1.0' }),
    'the id of another request': (req, body) => ({ ...body(req), id: req.id + 1 }),
    'the id as a string': (req, body) => ({ ...body(req), id: String(req.id) }),
    'no id': (req, body) => {
      const { id, ...rest } = body(req);
      return rest;
    },
    'an error reply': (req) => ({
      jsonrpc: '2.0',
      id: req.id,
      error: { code: -32000, message: 'execution reverted' },
    }),
    'an error that is a string': (req) => ({ jsonrpc: '2.0', id: req.id, error: 'nope' }),
    'an error that is null': (req) => ({ jsonrpc: '2.0', id: req.id, error: null }),
    'a result and an error together': (req, body) => ({
      ...body(req),
      error: { code: 1, message: 'x' },
    }),
    'neither a result nor an error': (req) => ({ jsonrpc: '2.0', id: req.id }),
    'a result of null': (req) => reply(req, null),
    'a result that is a number': (req) => reply(req, 1),
    'a result that is an object': (req) => reply(req, {}),
    'a result that is an array': (req) => reply(req, [GOOD_ROW]),
    'an empty result (an address with no code)': (req) => reply(req, '0x'),
    'a result that is not hex': (req) => reply(req, `0x${'zz'.repeat(384)}`),
    'a result with an odd number of digits': (req) => reply(req, `${GOOD_ROW}0`),
    'a result of the wrong length': (req) => reply(req, `${GOOD_ROW}${'00'.repeat(32)}`),
    'an enormous body': () => `{"jsonrpc":"2.0","id":1,"result":"0x${'0'.repeat(200_000)}"}`,
  };
  const targets = {
    table: [(view) => view.table(KEY), (req) => reply(req, GOOD_ROW)],
    seat: [(view) => view.seat(KEY, WHO), (req) => reply(req, GOOD_SEAT)],
    blockTimestamp: [(view) => view.blockTimestamp(), (req) => reply(req, GOOD_BLOCK)],
  };
  for (const [method, [run, honest]] of Object.entries(targets)) {
    for (const [name, make] of Object.entries(envelopes)) {
      // the shape-only envelopes that rewrite a good reply only make sense when there is one for the method
      test(`${method}: ${name} gives { ok: false, error }`, async () => {
        const view = viewWith(fakeFetch((req) => make(req, honest)));
        const result = await run(view);
        expect(result).toEqual(failure);
        expect(Object.keys(result).sort()).toEqual(['error', 'ok']);
      });
    }
  }

  test('an error wins over a result, and a reply with neither says so', async () => {
    const both = viewWith(
      fakeFetch((req) => ({
        ...reply(req, encodeRow(LIVE_ROW)),
        error: { code: -32000, message: 'execution reverted' },
      })),
    );
    expect((await both.table(KEY)).error).toMatch(/returned an error: -32000 execution reverted/);
    const neither = viewWith(fakeFetch((req) => ({ jsonrpc: '2.0', id: req.id })));
    expect((await neither.table(KEY)).error).toMatch(/neither a result nor an error/);
    expect((await neither.blockTimestamp()).error).toMatch(/neither a result nor an error/);
  });

  test('a body past the size cap is refused as too large, before it is parsed', async () => {
    const big = `{"jsonrpc":"2.0","id":1,"result":"0x${'0'.repeat(70_000)}"}`;
    const view = viewWith(fakeFetch(() => big));
    expect(await view.table(KEY)).toEqual({ ok: false, error: 'the RPC body is too large' });
    // just under the cap is parsed (and then refused for its length by the decoder, not as too large)
    const under = `{"jsonrpc":"2.0","id":1,"result":"0x${'0'.repeat(60_000)}"}`;
    expect((await viewWith(fakeFetch(() => under)).table(KEY)).error).toMatch(/12 words/);
  });

  test('an HTTP error status is an error even when the body looks right', async () => {
    for (const status of [500, 502, 404, 403, 429, 301]) {
      const view = viewWith(fakeFetch((req) => reply(req, GOOD_ROW), { status }));
      expect(await view.table(KEY), String(status)).toEqual(failure);
    }
  });

  test('a fetch that answers with junk instead of a Response', async () => {
    for (const answer of [
      undefined,
      null,
      5,
      'x',
      {},
      { ok: true },
      { ok: true, text: 5 },
      { ok: true, text: () => 5 },
      { ok: 'yes', text: async () => '{}' },
    ]) {
      const view = viewWith(async () => answer);
      expect(await view.table(KEY), JSON.stringify(answer)).toEqual(failure);
    }
    const throwsLate = viewWith(async () => ({
      ok: true,
      text: async () => {
        throw new Error('body stream broke');
      },
    }));
    expect(await throwsLate.table(KEY)).toEqual(failure);
  });

  test('a node that never answers times out and the request is aborted', async () => {
    let signal;
    const hang = (_url, init) => {
      signal = init.signal;
      return new Promise(() => {});
    };
    const view = viewWith(hang, { timeoutMs: 30 });
    const result = await view.table(KEY);
    expect(result).toEqual(failure);
    expect(result.error).toMatch(/did not answer/);
    expect(signal.aborted).toBe(true);
    // the body can hang as well as the headers
    const slowBody = viewWith(async () => ({ ok: true, text: () => new Promise(() => {}) }), {
      timeoutMs: 30,
    });
    expect((await slowBody.seat(KEY, WHO)).error).toMatch(/did not answer/);
    expect((await slowBody.blockTimestamp()).error).toMatch(/did not answer/);
  });

  test('a late answer after the timeout does not turn into an unhandled rejection or a late result', async () => {
    const unhandled = [];
    const onUnhandled = (e) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    const view = viewWith(
      async () => {
        await new Promise((r) => setTimeout(r, 60));
        throw new Error('too late');
      },
      { timeoutMs: 20 },
    );
    expect(await view.table(KEY)).toEqual(failure);
    await new Promise((r) => setTimeout(r, 120));
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
  });

  test('bad arguments to a method are an { ok: false } result with no request sent', async () => {
    const fetch = fakeFetch((req) => reply(req, GOOD_ROW));
    const view = viewWith(fetch);
    for (const bad of [undefined, null, 'x', '0x12', 5, {}]) {
      expect(await view.table(bad), String(bad)).toEqual(failure);
      expect(await view.seat(bad, WHO), String(bad)).toEqual(failure);
      expect(await view.seat(KEY, bad), String(bad)).toEqual(failure);
    }
    expect(fetch.calls).toHaveLength(0);
  });

  test('RPC error text is clipped, so a hostile message cannot fill a log', async () => {
    const view = viewWith(
      fakeFetch((req) => ({
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -1, message: 'x'.repeat(10_000) },
      })),
    );
    const result = await view.table(KEY);
    expect(result.ok).toBe(false);
    expect(result.error.length).toBeLessThan(400);
  });

  test('blockTimestamp(): a block that is not a block, a timestamp that is not a quantity', async () => {
    for (const block of [
      null,
      [],
      'x',
      7,
      {},
      { timestamp: 5 },
      { timestamp: null },
      { timestamp: '0x' },
      { timestamp: '0x01' }, // leading zero: not a minimal quantity
      { timestamp: '0xzz' },
      { timestamp: '16' },
      { timestamp: '-0x1' },
      { timestamp: '0x10 ' },
      { timestamp: `0x1${'0'.repeat(16)}` }, // 2^64
      { timestamp: `0x${'f'.repeat(65)}` },
    ]) {
      const view = viewWith(fakeFetch((req) => reply(req, block)));
      expect(await view.blockTimestamp(), JSON.stringify(block)).toEqual(failure);
    }
    const max = viewWith(fakeFetch((req) => reply(req, { timestamp: `0x${'f'.repeat(16)}` })));
    expect(await max.blockTimestamp()).toEqual({ ok: true, timestamp: UINT64_MAX });
  });

  test('a real HTTP server that is hostile: status 500, garbage, a hang, and a lie about the length', async () => {
    const modes = {
      error: () => new Response('boom', { status: 500 }),
      garbage: () => new Response('<html>not rpc</html>', { status: 200 }),
      hang: () => new Promise((resolve) => setTimeout(() => resolve(new Response('{}')), 400)),
      short: async (req) => {
        const { id } = await req.json();
        return Response.json({ jsonrpc: '2.0', id, result: `0x${'00'.repeat(100)}` });
      },
      honest: async (req) => {
        const { id } = await req.json();
        return Response.json({ jsonrpc: '2.0', id, result: encodeRow(LIVE_ROW) });
      },
    };
    let mode = 'error';
    const server = Bun.serve({ port: 0, fetch: (req) => modes[mode](req) });
    try {
      const view = createRpcChainView({
        rpcUrl: `http://127.0.0.1:${server.port}`,
        vault: VAULT,
        timeoutMs: 100,
      });
      for (const m of ['error', 'garbage', 'hang', 'short']) {
        mode = m;
        expect(await view.table(KEY), m).toEqual(failure);
      }
      mode = 'honest';
      expect((await view.table(KEY)).table.nonce).toBe(7n);
    } finally {
      await server.stop(true);
    }
    // nothing is listening any more
    const dead = createRpcChainView({
      rpcUrl: `http://127.0.0.1:${server.port}`,
      vault: VAULT,
      timeoutMs: 100,
    });
    expect(await dead.table(KEY)).toEqual(failure);
  });
});

describe('the package index exports the chain view API', () => {
  test('every name is exported, and is the very function or constant of chainview.js', async () => {
    const index = await import('../src/index.js');
    const mine = await import('../src/chainview.js');
    for (const name of [
      'chainShowsSettled',
      'createRpcChainView',
      'decodeSeat',
      'decodeTableRow',
      'EPOCH_RULES',
      'encodeSeatsCall',
      'encodeTablesCall',
      'SEATS_SELECTOR',
      'TABLES_SELECTOR',
      'verifyEpochAgainstChain',
    ]) {
      expect(index[name], name).toBeDefined();
      expect(index[name], name).toBe(mine[name]);
    }
  });
});

describe('createRpcChainView: arguments are checked at construction', () => {
  const ok = { rpcUrl: 'http://rpc.invalid', vault: VAULT, fetch: async () => ({}) };
  test('a bad url, vault, fetch or timeout throws (a caller bug, not a hostile answer)', () => {
    for (const patch of [
      { rpcUrl: undefined },
      { rpcUrl: '' },
      { rpcUrl: 'rpc.invalid' },
      { rpcUrl: 'ftp://rpc.invalid' },
      { rpcUrl: 'http://' },
      { rpcUrl: 'http://rpc.invalid/ x' },
      { rpcUrl: 5 },
      { vault: undefined },
      { vault: '0x12' },
      { vault: `0x${'zz'.repeat(20)}` },
      { fetch: 'fetch' },
      { fetch: null },
      { timeoutMs: 0 },
      { timeoutMs: -1 },
      { timeoutMs: Number.NaN },
      { timeoutMs: Number.POSITIVE_INFINITY },
    ]) {
      expect(() => createRpcChainView({ ...ok, ...patch }), JSON.stringify(patch)).toThrow();
    }
    expect(() => createRpcChainView()).toThrow();
    expect(() => createRpcChainView(ok)).not.toThrow();
  });

  test('the platform fetch is the default', () => {
    expect(() => createRpcChainView({ rpcUrl: 'http://rpc.invalid', vault: VAULT })).not.toThrow();
  });
});

// ---- verification against the chain ------------------------------------------------------------------------

const w = makeWorld({ seed: 321, n: 3 });
const ME = 1;
const KEY_OF_TABLE = w.tableId;
const rowFor = (patch = {}) => ({
  status: STATUS.Active,
  maxPlayers: 6,
  seated: 3,
  arbiter: w.arbiter,
  nonce: w.genesis.nonce,
  exitDeadline: 0n,
  minDeposit: UNIT,
  maxDeposit: 10n ** 12n,
  escrow: w.escrow,
  rakePaid: w.genesis.rake,
  rosterHash: rosterHash(w.players),
  exitDigest: ZERO32,
  ...patch,
});
const seatsFor = () =>
  w.players.map((_, i) => ({ deposit: w.deposits[i], sessionKey: w.sessionAddresses[i] }));
const epochFor = (patch = {}) => ({
  domain: w.domain,
  state: w.genesis,
  sessionKeys: w.sessionAddresses,
  arbiter: w.arbiter,
  ...patch,
});
const argsFor = (patch = {}) => ({
  epoch: epochFor(),
  tableKey: KEY_OF_TABLE,
  chainTable: rowFor(),
  chainSeats: seatsFor(),
  myAddress: w.players[ME],
  myExpectedBalance: w.deposits[ME],
  ...patch,
});
const verify = (patch) => verifyEpochAgainstChain(argsFor(patch));
const refusedBy = (rule) =>
  expect.objectContaining({ ok: false, rule, detail: expect.any(String) });
const changeSeat = (i, patch) => seatsFor().map((s, j) => (j === i ? { ...s, ...patch } : s));

describe('verifyEpochAgainstChain: an honest epoch', () => {
  test('the genesis of a new table, exactly as the chain has it', () => {
    expect(verify()).toEqual({ ok: true });
  });

  test('a rolled-over epoch: nonce and rake above zero, stayers carrying their balances', () => {
    const final = buildNextState({
      prev: w.genesis,
      balances: w.genesis.balances.map((b, i) =>
        i === 0 ? b + 29n * UNIT : i === 1 ? b - 30n * UNIT : b,
      ),
      rakeDelta: UNIT,
      volumeDelta: 60n * UNIT,
      final: true,
      keep: [true, true, true],
    });
    const next = epochBaseline({
      tableId: w.tableId,
      players: w.players,
      deposits: final.balances,
      nonce: final.nonce,
      rake: final.rake,
      volume: final.volume,
    });
    expect(next.volume).toBe(60n * UNIT); // the chain does not store it: nothing here compares it
    const result = verify({
      epoch: epochFor({ state: next }),
      chainTable: rowFor({ nonce: final.nonce, rakePaid: final.rake, escrow: w.escrow - UNIT }),
      chainSeats: final.balances.map((deposit, i) => ({
        deposit,
        sessionKey: w.sessionAddresses[i],
      })),
      myExpectedBalance: final.balances[ME],
    });
    expect(result).toEqual({ ok: true });
  });

  test('every row spelling: decodeTableRow, tableFromChain, a status name, viem-style checksummed addresses, upper-case hex', () => {
    const decoded = decodeTableRow(encodeRow(rowFor()));
    expect(verify({ chainTable: decoded })).toEqual({ ok: true });
    expect(verify({ chainTable: tableFromChain(decoded) })).toEqual({ ok: true });
    expect(verify({ chainTable: rowFor({ status: 'Active' }) })).toEqual({ ok: true });
    expect(verify({ chainTable: rowFor({ arbiter: getAddress(w.arbiter) }) })).toEqual({
      ok: true,
    });
    const loud = `0x${rosterHash(w.players).slice(2).toUpperCase()}`;
    expect(verify({ chainTable: rowFor({ rosterHash: loud }) })).toEqual({ ok: true });
    expect(
      verify({
        chainTable: rowFor({
          nonce: Number(w.genesis.nonce),
          escrow: Number(w.escrow) > 2 ** 53 ? w.escrow : w.escrow,
        }),
      }),
    ).toEqual({ ok: true });
    expect(
      verify({
        chainSeats: seatsFor().map((s) => ({
          ...s,
          sessionKey: getAddress(s.sessionKey),
          confirmed: true,
        })),
        tableKey: `0x${w.tableId.slice(2).toUpperCase()}`,
        myAddress: getAddress(w.players[ME]),
      }),
    ).toEqual({ ok: true });
  });

  test('it does not mutate its arguments, and frozen arguments work', () => {
    const deepFreeze = (o) => {
      for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
      return Object.freeze(o);
    };
    const args = deepFreeze(argsFor());
    expect(verifyEpochAgainstChain(args)).toEqual({ ok: true });
  });
});

describe('verifyEpochAgainstChain: every rule refuses its own lie', () => {
  test('table-id: an epoch for another table than the one pinned', () => {
    expect(verify({ tableKey: `0x${'ab'.repeat(32)}` })).toEqual(refusedBy('table-id'));
    expect(
      verify({ epoch: epochFor({ state: { ...w.genesis, tableId: `0x${'ab'.repeat(32)}` } }) }),
    ).toEqual(refusedBy('table-id'));
  });

  test('status: the table must be Active; None, Exiting and Closed are refused, Filling only when allowed', () => {
    expect(verify({ chainTable: null })).toEqual(refusedBy('status'));
    for (const status of [
      STATUS.None,
      STATUS.Filling,
      STATUS.Exiting,
      STATUS.Closed,
      'None',
      'Filling',
      'Exiting',
      'Closed',
    ]) {
      expect(verify({ chainTable: rowFor({ status }) }), String(status)).toEqual(
        refusedBy('status'),
      );
    }
    // allowFilling widens only Filling
    for (const status of [STATUS.None, STATUS.Exiting, STATUS.Closed]) {
      expect(verify({ chainTable: rowFor({ status }), allowFilling: true })).toEqual(
        refusedBy('status'),
      );
    }
  });

  test('nonce: the chain must be at the epoch genesis nonce, not above and not below', () => {
    for (const nonce of [w.genesis.nonce + 1n, 5n, UINT64_MAX]) {
      const r = verify({ chainTable: rowFor({ nonce }) });
      expect(r, String(nonce)).toEqual(refusedBy('nonce'));
    }
    const ahead = { ...w.genesis, nonce: 3n };
    expect(verify({ epoch: epochFor({ state: ahead }) })).toEqual(refusedBy('nonce'));
  });

  test('roster: the chain roster hash must be the hash of the epoch players', () => {
    const other = makeWorld({ seed: 999, n: 3 });
    for (const hash of [
      rosterHash(other.players),
      rosterHash([...w.players].reverse()),
      ZERO32,
      `0x${'ff'.repeat(32)}`,
    ]) {
      expect(verify({ chainTable: rowFor({ rosterHash: hash }) }), hash).toEqual(
        refusedBy('roster'),
      );
    }
    // a stranger swapped in at the same size, with the same keys and balances
    const stranger = `0x${(BigInt(w.players[2]) + 1n).toString(16).padStart(40, '0')}`;
    const swapped = { ...w.genesis, players: [...w.players.slice(0, 2), stranger] };
    expect(
      verify({
        epoch: epochFor({ state: swapped }),
        myAddress: w.players[0],
        myExpectedBalance: w.deposits[0],
      }),
    ).toEqual(refusedBy('roster'));
  });

  test('escrow: it must equal sum(balances) + rake - rakePaid, to the last unit', () => {
    for (const delta of [1n, -1n, UNIT, -UNIT]) {
      const r = verify({ chainTable: rowFor({ escrow: w.escrow + delta }) });
      expect(r, String(delta)).toEqual(refusedBy('escrow'));
      expect(r.detail).toMatch(/holds/);
    }
    // the epoch invents money: balances that add to more than the chain holds
    const inflated = {
      ...w.genesis,
      balances: w.genesis.balances.map((b, i) => (i === 0 ? b + 1n : b)),
    };
    expect(verify({ epoch: epochFor({ state: inflated }) })).toEqual(refusedBy('escrow'));
    // the books are cumulative: rake and rakePaid both enter the formula, so a rake the vault never paid
    // makes the same balances too small, or too big, for the escrow
    expect(verify({ epoch: epochFor({ state: { ...w.genesis, rake: 5n } }) })).toEqual(
      refusedBy('escrow'),
    );
    expect(verify({ chainTable: rowFor({ rakePaid: 5n }) })).toEqual(refusedBy('escrow'));
  });

  test('rake: the genesis rake is what the vault has already paid out, even when the escrow adds up', () => {
    // the server books 5 units of rake that were never paid, taking them out of seat 0, so that escrow = sum + rake - rakePaid holds
    const skimmed = {
      ...w.genesis,
      rake: 5n,
      balances: w.genesis.balances.map((b, i) => (i === 0 ? b - 5n : b)),
    };
    const r = verify({ epoch: epochFor({ state: skimmed }) });
    expect(r).toEqual(refusedBy('rake'));
    expect(r.detail).toMatch(/vault has paid/);
    // the other way round: the vault paid 5 that the epoch does not account for, with the escrow reduced to match
    const paid = verify({ chainTable: rowFor({ rakePaid: 5n, escrow: w.escrow - 5n }) });
    expect(paid).toEqual(refusedBy('rake'));
    // a rolled-over epoch where both agree is fine
    const rolled = { ...w.genesis, rake: 5n };
    expect(
      verify({
        epoch: epochFor({ state: rolled }),
        chainTable: rowFor({ rakePaid: 5n }),
      }),
    ).toEqual({ ok: true });
  });

  test('arbiter: the table arbiter must be the epoch arbiter, not any other', () => {
    const other = `0x${'77'.repeat(20)}`;
    expect(verify({ chainTable: rowFor({ arbiter: other }) })).toEqual(refusedBy('arbiter'));
    expect(verify({ epoch: epochFor({ arbiter: other }) })).toEqual(refusedBy('arbiter'));
  });

  test('session-key: every seat must hold the epoch key; an empty or unconfirmed seat is refused', () => {
    const stolen = `0x${'99'.repeat(20)}`;
    for (let i = 0; i < 3; i++) {
      const r = verify({ chainSeats: changeSeat(i, { sessionKey: stolen }) });
      expect(r, `seat ${i}`).toEqual(refusedBy('session-key'));
      expect(r.detail).toMatch(new RegExp(`seat ${i}`));
      const lyingEpoch = verify({
        epoch: epochFor({ sessionKeys: w.sessionAddresses.map((k, j) => (j === i ? stolen : k)) }),
      });
      expect(lyingEpoch, `epoch key ${i}`).toEqual(refusedBy('session-key'));
      expect(
        verify({ chainSeats: seatsFor().map((s, j) => (j === i ? null : s)) }),
        `empty ${i}`,
      ).toEqual(refusedBy('session-key'));
      expect(
        verify({ chainSeats: changeSeat(i, { confirmed: false }) }),
        `unconfirmed ${i}`,
      ).toEqual(refusedBy('session-key'));
    }
    // the server gave everyone one key it controls
    const keys = w.players.map(() => stolen);
    expect(verify({ epoch: epochFor({ sessionKeys: keys }) })).toEqual(refusedBy('session-key'));
  });

  test('my-balance: what the epoch gives me must be what my own records say', () => {
    for (const expected of [w.deposits[ME] + 1n, w.deposits[ME] - 1n, 0n, w.deposits[0]]) {
      const r = verify({ myExpectedBalance: expected });
      expect(r, String(expected)).toEqual(refusedBy('my-balance'));
      expect(r.detail).toMatch(/you know you have/);
    }
    // the server moved a unit from my seat to another: the chain's escrow and deposits catch it too, but the
    // rule that names it for me is my-balance when everything else agrees (a chain that agrees with the lie)
    const moved = {
      ...w.genesis,
      balances: w.genesis.balances.map((b, i) => (i === ME ? b - 1n : i === 0 ? b + 1n : b)),
    };
    const chainAgrees = seatsFor().map((s, i) => ({ ...s, deposit: moved.balances[i] }));
    expect(verify({ epoch: epochFor({ state: moved }), chainSeats: chainAgrees })).toEqual(
      refusedBy('my-balance'),
    );
  });

  test('deposit: a seat whose deposit on the chain differs from its balance in the epoch is refused', () => {
    for (const i of [0, 2]) {
      const r = verify({ chainSeats: changeSeat(i, { deposit: w.deposits[i] + 1n }) });
      expect(r, `seat ${i}`).toEqual(refusedBy('deposit'));
      expect(r.detail).toMatch(new RegExp(`seat ${i}`));
    }
    // my own seat, when my record agrees with the epoch but the chain does not
    expect(verify({ chainSeats: changeSeat(ME, { deposit: w.deposits[ME] - 1n }) })).toEqual(
      refusedBy('deposit'),
    );
    // chips moved between two other seats: the sum is right, the deposits are not
    const shifted = {
      ...w.genesis,
      balances: w.genesis.balances.map((b, i) => (i === 0 ? b - UNIT : i === 2 ? b + UNIT : b)),
    };
    expect(verify({ epoch: epochFor({ state: shifted }) })).toEqual(refusedBy('deposit'));
  });

  test('the rules are reported in a fixed order when several lies are told at once', () => {
    const stolen = `0x${'99'.repeat(20)}`;
    // the books with 5 units of rake that were never paid, taken out of seat 0: escrow still adds up
    const skimmed = {
      ...w.genesis,
      rake: 5n,
      balances: w.genesis.balances.map((b, i) => (i === 0 ? b - 5n : b)),
    };
    // each lie is a patch: `row` edits the chain row, `seats` edits seats by index, the rest replaces arguments
    const lies = [
      ['table-id', { tableKey: `0x${'ab'.repeat(32)}` }],
      ['status', { row: { status: STATUS.Exiting } }],
      ['nonce', { row: { nonce: 9n } }],
      ['roster', { row: { rosterHash: ZERO32 } }],
      ['escrow', { row: { escrow: 1n } }],
      ['rake', { epoch: epochFor({ state: skimmed }) }],
      ['arbiter', { row: { arbiter: `0x${'77'.repeat(20)}` } }],
      ['session-key', { seats: { 0: { sessionKey: stolen } } }],
      ['my-balance', { myExpectedBalance: 1n }],
      ['deposit', { seats: { 2: { deposit: 1n } } }],
    ];
    const tell = (args, { row, seats, ...replace }) => {
      Object.assign(args, replace);
      if (row) args.chainTable = { ...args.chainTable, ...row };
      for (const [i, patch] of Object.entries(seats ?? {})) {
        args.chainSeats = args.chainSeats.map((seat, j) =>
          j === Number(i) ? { ...seat, ...patch } : seat,
        );
      }
    };
    for (let i = 0; i < lies.length; i++) {
      // every lie from i onwards is told at once: the first one in the list is the one named
      const args = argsFor();
      for (const [, patch] of lies.slice(i)) tell(args, patch);
      expect(verifyEpochAgainstChain(args), lies[i][0]).toEqual(refusedBy(lies[i][0]));
    }
  });

  test('every rule id the function can give is documented in EPOCH_RULES', () => {
    for (const id of [
      'MALFORMED',
      'INTERNAL',
      'table-id',
      'status',
      'nonce',
      'roster',
      'rake',
      'escrow',
      'arbiter',
      'session-key',
      'my-balance',
      'deposit',
    ]) {
      expect(typeof EPOCH_RULES[id], id).toBe('string');
    }
    expect(Object.isFrozen(EPOCH_RULES)).toBe(true);
  });
});

describe('verifyEpochAgainstChain: a Filling table, when it is explicitly allowed', () => {
  const filling = (patch = {}) => rowFor({ status: STATUS.Filling, rosterHash: ZERO32, ...patch });

  test('the epoch can be checked before start(): same facts, no roster hash yet, and the result says so', () => {
    expect(verify({ chainTable: filling(), allowFilling: true })).toEqual({
      ok: true,
      filling: true,
    });
  });

  test('without allowFilling the same table is refused', () => {
    expect(verify({ chainTable: filling() })).toEqual(refusedBy('status'));
    expect(verify({ chainTable: filling(), allowFilling: false })).toEqual(refusedBy('status'));
  });

  test('the seat count must match the epoch roster (a stuffed table is refused), and the other rules still bind', () => {
    for (const seated of [2, 4, 6]) {
      expect(
        verify({ chainTable: filling({ seated }), allowFilling: true }),
        String(seated),
      ).toEqual(refusedBy('roster'));
    }
    expect(verify({ chainTable: filling({ nonce: 3n }), allowFilling: true })).toEqual(
      refusedBy('nonce'),
    );
    expect(verify({ chainTable: filling({ escrow: w.escrow + 5n }), allowFilling: true })).toEqual(
      refusedBy('escrow'),
    );
    expect(
      verify({
        chainTable: filling(),
        chainSeats: changeSeat(1, { sessionKey: `0x${'99'.repeat(20)}` }),
        allowFilling: true,
      }),
    ).toEqual(refusedBy('session-key'));
    expect(
      verify({
        chainTable: filling(),
        chainSeats: changeSeat(2, { deposit: 1n }),
        allowFilling: true,
      }),
    ).toEqual(refusedBy('deposit'));
    expect(verify({ chainTable: filling(), myExpectedBalance: 5n, allowFilling: true })).toEqual(
      refusedBy('my-balance'),
    );
  });

  test('a Filling row without a seated count cannot be checked: MALFORMED, not a pass', () => {
    const { seated, ...bare } = filling();
    expect(verify({ chainTable: bare, allowFilling: true })).toEqual(refusedBy('MALFORMED'));
  });

  test('allowFilling does not make an Active table need a seated count', () => {
    const { seated, ...bare } = rowFor();
    expect(verify({ chainTable: bare, allowFilling: true })).toEqual({ ok: true });
  });
});

describe('verifyEpochAgainstChain: bad arguments fail closed and never throw', () => {
  test('MALFORMED for every unusable argument', () => {
    const cases = {
      'no arguments': undefined,
      'null arguments': null,
      'a string': 'epoch',
      'no epoch': { epoch: undefined },
      'epoch null': { epoch: null },
      'epoch state missing': { epoch: { ...epochFor(), state: undefined } },
      'epoch state not a State': { epoch: epochFor({ state: { nonce: 1n } }) },
      'epoch state with a reversed roster': {
        epoch: epochFor({ state: { ...w.genesis, players: [...w.players].reverse() } }),
      },
      'epoch domain missing': { epoch: epochFor({ domain: undefined }) },
      'epoch domain malformed': {
        epoch: epochFor({ domain: { chainId: 0, verifyingContract: VAULT } }),
      },
      'sessionKeys missing': { epoch: epochFor({ sessionKeys: undefined }) },
      'sessionKeys too short': { epoch: epochFor({ sessionKeys: w.sessionAddresses.slice(1) }) },
      'sessionKeys too long': { epoch: epochFor({ sessionKeys: [...w.sessionAddresses, VAULT] }) },
      'a session key that is not an address': {
        epoch: epochFor({ sessionKeys: [...w.sessionAddresses.slice(0, 2), 'key'] }),
      },
      'a zero session key': {
        epoch: epochFor({
          sessionKeys: [...w.sessionAddresses.slice(0, 2), `0x${'00'.repeat(20)}`],
        }),
      },
      'arbiter missing': { epoch: epochFor({ arbiter: undefined }) },
      'arbiter malformed': { epoch: epochFor({ arbiter: '0x12' }) },
      'tableKey missing': { tableKey: undefined },
      'tableKey short': { tableKey: '0x12' },
      'chainTable missing': { chainTable: undefined },
      'chainTable a string': { chainTable: 'row' },
      'chainTable status junk': { chainTable: rowFor({ status: 9 }) },
      'chainTable status a fraction': { chainTable: rowFor({ status: 2.5 }) },
      'chainTable status an unknown name': { chainTable: rowFor({ status: 'Paused' }) },
      'chainTable nonce a string': { chainTable: rowFor({ nonce: '0' }) },
      'chainTable nonce negative': { chainTable: rowFor({ nonce: -1n }) },
      'chainTable escrow missing': { chainTable: rowFor({ escrow: undefined }) },
      'chainTable rakePaid a fraction': { chainTable: rowFor({ rakePaid: 0.5 }) },
      'chainTable rosterHash short': { chainTable: rowFor({ rosterHash: '0x12' }) },
      'chainTable rosterHash missing': { chainTable: rowFor({ rosterHash: undefined }) },
      'chainTable arbiter malformed': { chainTable: rowFor({ arbiter: 'me' }) },
      'chainSeats missing': { chainSeats: undefined },
      'chainSeats too short': { chainSeats: seatsFor().slice(1) },
      'chainSeats too long': { chainSeats: [...seatsFor(), seatsFor()[0]] },
      'a chain seat that is a string': { chainSeats: [seatsFor()[0], 'seat', seatsFor()[2]] },
      'a chain seat that is undefined': { chainSeats: [seatsFor()[0], undefined, seatsFor()[2]] },
      'a chain seat without a deposit': { chainSeats: changeSeat(0, { deposit: undefined }) },
      'a chain seat with a negative deposit': { chainSeats: changeSeat(0, { deposit: -1n }) },
      'a chain seat key malformed': { chainSeats: changeSeat(0, { sessionKey: '0x12' }) },
      'myAddress missing': { myAddress: undefined },
      'myAddress malformed': { myAddress: 'me' },
      'myAddress not on the roster': { myAddress: `0x${'77'.repeat(20)}` },
      'myExpectedBalance missing': { myExpectedBalance: undefined },
      'myExpectedBalance a number': { myExpectedBalance: Number(w.deposits[ME]) },
      'myExpectedBalance negative': { myExpectedBalance: -1n },
      'myExpectedBalance a string': { myExpectedBalance: String(w.deposits[ME]) },
      'allowFilling not a boolean': { allowFilling: 'yes' },
      'allowFilling a number': { allowFilling: 1 },
    };
    for (const [name, patch] of Object.entries(cases)) {
      const args =
        patch === undefined || patch === null || typeof patch === 'string' ? patch : argsFor(patch);
      const r = verifyEpochAgainstChain(args);
      expect(r, name).toEqual(refusedBy('MALFORMED'));
    }
  });

  test('3000 junk argument sets: an answer every time, and never an { ok: true } for junk', () => {
    const rng = makeRng(31337);
    const junk = () =>
      rng.pick([
        undefined,
        null,
        0,
        1,
        -1,
        1.5,
        Number.NaN,
        '',
        'x',
        true,
        [],
        [1],
        {},
        1n,
        -1n,
        Symbol('s'),
        () => 1,
        new Proxy(
          {},
          {
            get() {
              throw new Error('trap');
            },
          },
        ),
        {
          get state() {
            throw new Error('getter');
          },
        },
        Object.create(null),
      ]);
    for (let i = 0; i < 3000; i++) {
      const args = argsFor();
      const keys = Object.keys(args);
      for (let k = 0; k < 1 + rng.int(3); k++) args[rng.pick(keys)] = junk();
      const r = verifyEpochAgainstChain(args);
      expect(typeof r.ok).toBe('boolean');
      if (!r.ok) expect(typeof r.rule).toBe('string');
      else expect(args.tableKey).toBe(KEY_OF_TABLE); // junk elsewhere cannot pass; only an unchanged call can
    }
  });

  test('an unexpected exception is a refusal (INTERNAL), never a pass', () => {
    const trap = {
      get state() {
        throw new Error('boom');
      },
    };
    // a getter that throws on a field read after the arguments were validated is outside readArgs:
    // use an epoch whose sessionKeys array reports a length but throws on read
    const sessionKeys = new Proxy(w.sessionAddresses, {
      get(target, key, receiver) {
        if (key === 'map') throw new Error('map is broken');
        return Reflect.get(target, key, receiver);
      },
    });
    const r = verify({ epoch: epochFor({ sessionKeys }) });
    expect(r.ok).toBe(false);
    expect(['MALFORMED', 'INTERNAL']).toContain(r.rule);
    expect(verifyEpochAgainstChain(trap).ok).toBe(false);
  });
});

describe('chainShowsSettled: is the final state I signed now on the chain?', () => {
  const final = buildNextState({
    prev: w.genesis,
    balances: w.genesis.balances,
    final: true,
    keep: [true, true, true],
  });
  const N = final.nonce;
  const row = (status, nonce) => ({ status, nonce });
  const shows = (chainTable, f = final) => chainShowsSettled({ chainTable, final: f });

  test('Filling at or above the final nonce, and an Active epoch at or above it, are settled', () => {
    for (const nonce of [N, N + 1n, N + 100n, UINT64_MAX]) {
      expect(shows(row(STATUS.Filling, nonce)), `Filling ${nonce}`).toBe(true);
      expect(shows(row(STATUS.Active, nonce)), `Active ${nonce}`).toBe(true);
    }
  });

  test('anything below the final nonce is not settled: the final has not been applied', () => {
    for (const nonce of [0n, N - 1n]) {
      expect(shows(row(STATUS.Filling, nonce)), `Filling ${nonce}`).toBe(false);
      expect(shows(row(STATUS.Active, nonce)), `Active ${nonce}`).toBe(false);
    }
  });

  test('Exiting, Closed and None are never "settled", whatever the nonce: the latch stays', () => {
    for (const status of [
      STATUS.Exiting,
      STATUS.Closed,
      STATUS.None,
      'Exiting',
      'Closed',
      'None',
    ]) {
      for (const nonce of [0n, N, N + 5n]) {
        expect(shows(row(status, nonce)), `${status} ${nonce}`).toBe(false);
      }
    }
  });

  test('the row may be any spelling: names, numbers, bigint or safe-integer nonces, a full table row', () => {
    expect(shows({ status: 'Filling', nonce: Number(N) })).toBe(true);
    expect(shows({ status: 'Active', nonce: N })).toBe(true);
    expect(shows(rowFor({ status: STATUS.Filling, nonce: N }))).toBe(true);
    expect(
      shows(
        decodeTableRow(
          encodeRow({ ...rowFor({ status: STATUS.Active, nonce: N }), arbiter: w.arbiter }),
        ),
      ),
    ).toBe(true);
  });

  test('a bundle carrying the final works as well as the state itself', () => {
    const bundle = { domain: w.domain, state: final, arbiterSig: '0x', playerSigs: [] };
    expect(shows(row(STATUS.Filling, N), bundle)).toBe(true);
    expect(shows(row(STATUS.Filling, N - 1n), bundle)).toBe(false);
  });

  test('a state that is not final cannot be settled', () => {
    const hand = w.nextHand(w.genesis);
    expect(shows(row(STATUS.Filling, 99n), hand)).toBe(false);
    expect(shows(row(STATUS.Filling, 99n), { ...final, isFinal: 'true' })).toBe(false);
  });

  test('anything unreadable is false, never true and never a throw', () => {
    for (const chainTable of [
      null,
      undefined,
      'row',
      5,
      {},
      { status: 'Filling' },
      { nonce: 5n },
      { status: 9, nonce: 5n },
      { status: 'Paused', nonce: 5n },
      { status: 1, nonce: -1n },
      { status: 1, nonce: '5' },
      { status: 1, nonce: 1.5 },
    ]) {
      expect(
        shows(chainTable),
        JSON.stringify(chainTable, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)),
      ).toBe(false);
    }
    for (const f of [
      null,
      undefined,
      'final',
      5,
      {},
      { isFinal: true },
      { isFinal: true, nonce: -1n },
      { isFinal: true, nonce: '9' },
      { state: null },
    ]) {
      // called directly: `shows` would put the real final in place of an undefined one
      expect(chainShowsSettled({ chainTable: row(STATUS.Filling, 99n), final: f }), String(f)).toBe(
        false,
      );
    }
    expect(chainShowsSettled()).toBe(false);
    expect(chainShowsSettled(null)).toBe(false);
    expect(chainShowsSettled({})).toBe(false);
    expect(chainShowsSettled('x')).toBe(false);
  });
});

describe('F1: a lying server after I signed a final (verifyEpochAgainstChain with chainShowsSettled)', () => {
  // I signed a final state at nonce 3 (every seat kept). The server has not settled it, or never will. The
  // chain still shows the old epoch: Active at nonce 0. The server now announces a "new epoch" and wants me
  // to sign states on top of it.
  const base0 = w.genesis;
  const hand1 = w.nextHand(base0, {
    winner: 0,
    loser: 1,
    amount: 40n * UNIT,
    rake: UNIT,
    pot: 80n * UNIT,
  });
  const hand2 = w.nextHand(hand1, {
    winner: 2,
    loser: 0,
    amount: 10n * UNIT,
    rake: 0n,
    pot: 20n * UNIT,
  });
  const final = buildNextState({
    prev: hand2,
    balances: hand2.balances,
    final: true,
    keep: [true, true, true],
  });
  const chainActiveOld = rowFor(); // nonce 0, escrow = deposits, Active
  const nextEpochState = (patch = {}) =>
    epochBaseline({
      tableId: w.tableId,
      players: w.players,
      deposits: final.balances,
      nonce: final.nonce,
      rake: final.rake,
      volume: final.volume,
      ...patch,
    });
  const fakeEpoch = (state) => epochFor({ state });
  const seatsAfter = final.balances.map((deposit, i) => ({
    deposit,
    sessionKey: w.sessionAddresses[i],
  }));
  const myAfter = final.balances[ME];

  test('the same roster at the final nonce, before the chain has settled: refused on the nonce, and not settled', () => {
    expect(final.nonce).toBe(3n);
    const lie = verify({
      epoch: fakeEpoch(nextEpochState()),
      chainTable: chainActiveOld,
      chainSeats: seatsAfter,
      myExpectedBalance: myAfter,
    });
    expect(lie).toEqual(refusedBy('nonce'));
    expect(chainShowsSettled({ chainTable: chainActiveOld, final })).toBe(false);
  });

  test('a fake epoch with other balances at the final nonce is refused as well (my chips moved to a stranger)', () => {
    const robbed = nextEpochState({
      deposits: final.balances.map((b, i) =>
        i === ME ? 0n : i === 0 ? b + final.balances[ME] : b,
      ),
    });
    for (const table of [chainActiveOld, rowFor({ nonce: final.nonce })]) {
      const r = verify({ epoch: fakeEpoch(robbed), chainTable: table, myExpectedBalance: myAfter });
      expect(r.ok).toBe(false);
    }
  });

  test('replaying the old genesis (same roster, same nonce as the chain) matches the chain: only the latch stops it', () => {
    // The chain really is Active at nonce 0 with these deposits, so the pure check passes. Adopting it would
    // rewind my hands, so the controller must also require chainShowsSettled (and a genesis nonce that is not
    // below the highest nonce it signed): both say no here.
    expect(verify()).toEqual({ ok: true });
    expect(chainShowsSettled({ chainTable: chainActiveOld, final })).toBe(false);
    expect(base0.nonce < final.nonce).toBe(true);
  });

  test('the chain exits instead of settling: still not settled, and the epoch is refused', () => {
    const exiting = rowFor({ status: STATUS.Exiting, nonce: hand1.nonce });
    expect(chainShowsSettled({ chainTable: exiting, final })).toBe(false);
    expect(verify({ epoch: fakeEpoch(nextEpochState()), chainTable: exiting })).toEqual(
      refusedBy('status'),
    );
  });

  test('once the final is settled on chain the new epoch is accepted, first as Filling, then as Active', () => {
    // settle(final): the vault is Filling at the final nonce, seats hold the kept balances, rake paid
    const filling = rowFor({
      status: STATUS.Filling,
      nonce: final.nonce,
      rakePaid: final.rake,
      rosterHash: ZERO32,
      escrow: w.escrow - final.rake,
    });
    expect(chainShowsSettled({ chainTable: filling, final })).toBe(true);
    const mine = { chainSeats: seatsAfter, myExpectedBalance: myAfter };
    expect(
      verify({
        epoch: fakeEpoch(nextEpochState()),
        chainTable: filling,
        allowFilling: true,
        ...mine,
      }),
    ).toEqual({
      ok: true,
      filling: true,
    });
    // ... and start(): Active at the same nonce, roster hash set
    const active = { ...filling, status: STATUS.Active, rosterHash: rosterHash(w.players) };
    expect(chainShowsSettled({ chainTable: active, final })).toBe(true);
    expect(verify({ epoch: fakeEpoch(nextEpochState()), chainTable: active, ...mine })).toEqual({
      ok: true,
    });
  });

  test('a settle of a DIFFERENT, higher final also settles mine (the chain moved on)', () => {
    const later = rowFor({ status: STATUS.Filling, nonce: final.nonce + 4n, rakePaid: final.rake });
    expect(chainShowsSettled({ chainTable: later, final })).toBe(true);
  });
});
