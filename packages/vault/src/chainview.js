// What a browser needs to check the server's word against the chain, without viem (F1). Three parts:
//
//   1. hand-written calldata and ABI decoding for exactly two views of PokerVault: tables(bytes32) and
//      seats(bytes32,address). Everything here is a fixed-size static tuple, so a decoder is a few lines and
//      a strict one is cheap: any dirty bit, wrong length or out-of-range value is refused, because the node
//      answering may be hostile or broken.
//   2. createRpcChainView: those two reads and the latest block time over plain JSON-RPC (`fetch`). The RPC
//      URL and the vault address are PINNED IN THE APP BUILD by the caller; nothing here takes them from a
//      server message. It never throws on a bad answer: it returns { ok: false, error }.
//   3. pure verification: verifyEpochAgainstChain (does the chain agree with the epoch the server announced?)
//      and chainShowsSettled (is the final state I signed now settled on the chain?).
//
// Why this exists: every money check a client makes (clientShouldSign) is relative to a baseline that arrives
// in the server's `epoch` message. A lying server could announce a fake epoch (same roster, a replayed or
// invented genesis, other balances) and the client would sign states against it. The chain is the only
// witness the server cannot forge, so before signing the first state of an epoch the client reads the table
// and the seats and requires them to match, to the unit.
import { keccakHex, UINT64_MAX, utf8 } from './bytes.js';
import { STATUS } from './check.js';
import { normalizeDomain } from './eip712.js';
import { normalizeAddress, normalizeState, rosterHash } from './state.js';

// ---- ABI: the two views ---------------------------------------------------------------------------------

const selectorOf = (signature) => keccakHex(utf8(signature)).slice(0, 10);

/** First four bytes of keccak256("tables(bytes32)"), as 0x + 8 hex. */
export const TABLES_SELECTOR = selectorOf('tables(bytes32)');
/** First four bytes of keccak256("seats(bytes32,address)"), as 0x + 8 hex. */
export const SEATS_SELECTOR = selectorOf('seats(bytes32,address)');

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const HEX_ANY = /^0x[0-9a-fA-F]*$/;
const ZERO_WORD = '0'.repeat(64);
const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;

const statusNames = Object.fromEntries(Object.entries(STATUS).map(([name, n]) => [n, name]));

function bytes32Of(value, field) {
  if (typeof value !== 'string' || !HEX32.test(value)) {
    throw new RangeError(`${field} must be 32 bytes of 0x hex`);
  }
  return value.slice(2).toLowerCase();
}

/** Calldata for PokerVault.tables(tableKey): selector + the 32-byte key. Throws RangeError on a bad key. */
export function encodeTablesCall(tableKey) {
  return `${TABLES_SELECTOR}${bytes32Of(tableKey, 'tableKey')}`;
}

/** Calldata for PokerVault.seats(tableKey, address): selector + key + the address as a 32-byte word. */
export function encodeSeatsCall(tableKey, address) {
  const key = bytes32Of(tableKey, 'tableKey');
  const who = normalizeAddress(address, 'address').slice(2);
  return `${SEATS_SELECTOR}${key}${'00'.repeat(12)}${who}`;
}

// The return data of both views is a static tuple: N words of 32 bytes, nothing else.
function wordsOf(hex, count, what) {
  // length first: a regex over a huge hostile string would walk all of it
  if (typeof hex !== 'string' || hex.length !== 2 + count * 64) {
    throw new RangeError(`${what} must be exactly ${count} words (${count * 32} bytes)`);
  }
  if (!HEX_ANY.test(hex)) throw new RangeError(`${what} is not 0x hex`);
  const body = hex.slice(2).toLowerCase();
  return Array.from({ length: count }, (_, i) => body.slice(i * 64, (i + 1) * 64));
}

function uintWord(word, max, field) {
  const value = BigInt(`0x${word}`);
  if (value > max) throw new RangeError(`${field} is out of range`);
  return value;
}

function addressWord(word, field) {
  // an ABI address word has 12 zero bytes in front; anything else is not what a contract returns
  if (!word.startsWith('0'.repeat(24)))
    throw new RangeError(`${field} is not a clean address word`);
  return `0x${word.slice(24)}`;
}

/**
 * Decode the return data of PokerVault.tables(bytes32): 12 words, exactly. Returns the row with the
 * contract's field names, in the shape tableFromChain accepts: status, maxPlayers and seated as numbers,
 * nonce, exitDeadline and every amount as bigint, arbiter as a lowercase address, rosterHash and exitDigest
 * as lowercase 0x hex. Strict, because the answer may come from a hostile node: a wrong length, a status
 * above Closed, a uint8 or uint64 or address with bits outside its type, or a table that has no status but
 * has data in it, throws RangeError. A table that does not exist decodes to status 0 (None) and zeros.
 */
export function decodeTableRow(hex) {
  const w = wordsOf(hex, 12, 'tables() return data');
  const row = {
    status: Number(uintWord(w[0], 4n, 'status')),
    maxPlayers: Number(uintWord(w[1], 0xffn, 'maxPlayers')),
    seated: Number(uintWord(w[2], 0xffn, 'seated')),
    arbiter: addressWord(w[3], 'arbiter'),
    nonce: uintWord(w[4], UINT64_MAX, 'nonce'),
    exitDeadline: uintWord(w[5], UINT64_MAX, 'exitDeadline'),
    minDeposit: BigInt(`0x${w[6]}`),
    maxDeposit: BigInt(`0x${w[7]}`),
    escrow: BigInt(`0x${w[8]}`),
    rakePaid: BigInt(`0x${w[9]}`),
    rosterHash: `0x${w[10]}`,
    exitDigest: `0x${w[11]}`,
  };
  if (row.status === STATUS.None && w.some((word) => word !== ZERO_WORD)) {
    throw new RangeError('a table with no status must be empty');
  }
  return row;
}

/**
 * Decode the return data of PokerVault.seats(bytes32,address): 2 words, exactly. Returns
 * { deposit: bigint, sessionKey: lowercase address }, or null for an empty seat (both zero). A seat with a
 * deposit and no session key, or a key and no deposit, cannot exist in the contract (deposit() needs both,
 * leave() and settle() delete both), so it is refused as a lie.
 */
export function decodeSeat(hex) {
  const w = wordsOf(hex, 2, 'seats() return data');
  const deposit = BigInt(`0x${w[0]}`);
  const sessionKey = addressWord(w[1], 'sessionKey');
  if (deposit === 0n && sessionKey === ZERO_ADDRESS) return null;
  if (deposit === 0n || sessionKey === ZERO_ADDRESS) {
    throw new RangeError('a seat has a deposit and a session key, or neither');
  }
  return { deposit, sessionKey };
}

// ---- JSON-RPC over fetch ---------------------------------------------------------------------------------

// 12 words of hex is under 1 KB; a block header is a few KB. Anything past this is not an honest answer.
const MAX_RESPONSE_CHARS = 64 * 1024;
const QUANTITY = /^0x(0|[1-9a-fA-F][0-9a-fA-F]*)$/;

/**
 * A ChainView over plain JSON-RPC: `eth_call` on the vault for tables() and seats(), and the newest block's
 * timestamp. `rpcUrl` and `vault` are PINNED IN THE APP BUILD by the caller; this function never learns
 * either from a server message. `fetch` is injectable (the default is the platform's); `timeoutMs` bounds
 * every request, answer included. A bad argument here is a caller bug and throws.
 *
 * Every method is async and NEVER throws and never rejects: a network failure, a timeout, an HTTP error, a
 * body that is not JSON, a response that is not exactly one JSON-RPC 2.0 reply to this request, a revert, or
 * return data that is not exactly what the contract would return, all come back as { ok: false, error }.
 *
 *   table(tableKey)           -> { ok: true, table: row | null } | { ok: false, error }
 *                                row is decodeTableRow's; null when no such table exists (status None)
 *   seat(tableKey, address)   -> { ok: true, seat: { deposit, sessionKey } | null } | { ok: false, error }
 *   blockTimestamp()          -> { ok: true, timestamp: bigint (seconds) } | { ok: false, error }
 *
 * Reads are at the 'latest' block; a client that needs more depth should re-read before it relies on a
 * change. A vault address with no code answers 0x, which is refused as a wrong-length result.
 */
export function createRpcChainView({
  rpcUrl,
  vault,
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
} = {}) {
  if (typeof rpcUrl !== 'string' || !/^https?:\/\/\S+$/.test(rpcUrl)) {
    throw new TypeError('rpcUrl must be an http(s) URL');
  }
  const to = normalizeAddress(vault, 'vault');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch must be a function');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be a positive number');
  }

  let nextId = 1;

  async function exchange(body, signal) {
    const response = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal,
    });
    if (response === null || typeof response !== 'object' || response.ok !== true) {
      return { ok: false, error: `the RPC answered HTTP ${response?.status ?? 'nothing'}` };
    }
    const text = await response.text();
    if (typeof text !== 'string') return { ok: false, error: 'the RPC body is not text' };
    if (text.length > MAX_RESPONSE_CHARS) return { ok: false, error: 'the RPC body is too large' };
    return { ok: true, text };
  }

  // One JSON-RPC request. Resolves { ok: true, result } or { ok: false, error }; never rejects.
  async function rpc(method, params) {
    const id = nextId++;
    // AbortSignal.timeout bounds the whole exchange (headers and body) without this module reading a clock
    // or arming a timer. Where the platform lacks it, the injected fetch must bound the request itself.
    const signal =
      typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(timeoutMs)
        : undefined;
    const timeoutError = { ok: false, error: `the RPC did not answer in ${timeoutMs} ms` };
    // a fetch (or a body read) that ignores the signal must not hold the caller up past the timeout
    const timedOut = signal
      ? new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve(timeoutError), { once: true });
        })
      : null;
    let outcome;
    try {
      const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      const exchanged = exchange(body, signal);
      outcome = await (timedOut ? Promise.race([exchanged, timedOut]) : exchanged);
    } catch (error) {
      if (signal?.aborted) return timeoutError;
      return { ok: false, error: `the RPC request failed: ${messageOf(error)}` };
    }
    if (!outcome.ok) return outcome;

    let reply;
    try {
      reply = JSON.parse(outcome.text);
    } catch {
      return { ok: false, error: 'the RPC answer is not JSON' };
    }
    if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) {
      return { ok: false, error: 'the RPC answer is not a JSON-RPC reply object' };
    }
    if (reply.jsonrpc !== '2.0') return { ok: false, error: 'the RPC answer is not JSON-RPC 2.0' };
    if (reply.id !== id) return { ok: false, error: 'the RPC answer is for another request' };
    const hasResult = hasOwn(reply, 'result');
    const hasError = hasOwn(reply, 'error');
    if (hasError) {
      return { ok: false, error: `the RPC returned an error: ${describeRpcError(reply.error)}` };
    }
    if (!hasResult) {
      return { ok: false, error: 'the RPC answer carries neither a result nor an error' };
    }
    return { ok: true, result: reply.result };
  }

  async function ethCall(data) {
    const answer = await rpc('eth_call', [{ to, data }, 'latest']);
    if (!answer.ok) return answer;
    if (typeof answer.result !== 'string') {
      return { ok: false, error: 'the RPC result is not a hex string' };
    }
    return answer;
  }

  return {
    async table(tableKey) {
      let data;
      try {
        data = encodeTablesCall(tableKey);
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      const answer = await ethCall(data);
      if (!answer.ok) return answer;
      try {
        const row = decodeTableRow(answer.result);
        return { ok: true, table: row.status === STATUS.None ? null : row };
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    },

    async seat(tableKey, address) {
      let data;
      try {
        data = encodeSeatsCall(tableKey, address);
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      const answer = await ethCall(data);
      if (!answer.ok) return answer;
      try {
        return { ok: true, seat: decodeSeat(answer.result) };
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    },

    async blockTimestamp() {
      const answer = await rpc('eth_getBlockByNumber', ['latest', false]);
      if (!answer.ok) return answer;
      const block = answer.result;
      if (block === null || typeof block !== 'object' || Array.isArray(block)) {
        return { ok: false, error: 'the RPC returned no block' };
      }
      const { timestamp } = block;
      if (typeof timestamp !== 'string' || !QUANTITY.test(timestamp)) {
        return { ok: false, error: 'the block timestamp is not a hex quantity' };
      }
      const seconds = BigInt(timestamp);
      if (seconds > UINT64_MAX) return { ok: false, error: 'the block timestamp is out of range' };
      return { ok: true, timestamp: seconds };
    },
  };
}

// Object.hasOwn is newer than the oldest phones this has to run on (Safari before 15.4)
const hasOwn = (object, key) => Object.hasOwn(object, key);

function messageOf(error) {
  return String(error?.message ?? error).slice(0, 200);
}

function describeRpcError(error) {
  if (error !== null && typeof error === 'object') {
    return `${typeof error.code === 'number' ? error.code : '?'} ${messageOf(error.message ?? '')}`.trim();
  }
  return messageOf(error);
}

// ---- verification ----------------------------------------------------------------------------------------

/**
 * Every refusal verifyEpochAgainstChain can give, with what it means. `MALFORMED` and `INTERNAL` are not
 * rules: the arguments were unusable, or something unexpected threw; both fail closed.
 */
export const EPOCH_RULES = Object.freeze({
  MALFORMED: 'the epoch, the chain rows or the client facts are not what this function needs',
  INTERNAL: 'an unexpected exception; the epoch is refused',
  'table-id': 'the epoch is for another table than the one pinned',
  status: 'the table is not Active (or Filling, when that was allowed), or does not exist',
  nonce: "the chain's nonce is not the epoch's genesis nonce",
  roster:
    "the chain's roster hash is not the hash of the epoch's players (or, in Filling, the seat count differs)",
  rake: "the epoch's cumulative rake is not what the vault has already paid out (rakePaid)",
  escrow: 'the escrow is not sum(balances) + rake - rakePaid',
  arbiter: "the table's arbiter is not the epoch's",
  'session-key': "a seat is empty or its session key is not the epoch's",
  'my-balance': 'my balance in the epoch is not what my own records say',
  deposit: "a seat's deposit on the chain is not its balance in the epoch",
});

function big(value, field) {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new RangeError(`${field} must be a non-negative integer`);
}

function statusOf(value, field) {
  const n = typeof value === 'string' ? STATUS[value] : value;
  if (!Number.isInteger(n) || n < 0 || n > 4) throw new RangeError(`${field} is not a Status`);
  return n;
}

// The row as decodeTableRow, tableFromChain's object or a ChainPort row can all be: only the fields read.
function readTable(row) {
  if (row === null || typeof row !== 'object')
    throw new RangeError('chainTable must be a table row');
  if (typeof row.rosterHash !== 'string' || !HEX32.test(row.rosterHash)) {
    throw new RangeError('chainTable.rosterHash must be 32 bytes of 0x hex');
  }
  return {
    status: statusOf(row.status, 'chainTable.status'),
    nonce: big(row.nonce, 'chainTable.nonce'),
    escrow: big(row.escrow, 'chainTable.escrow'),
    rakePaid: big(row.rakePaid, 'chainTable.rakePaid'),
    rosterHash: row.rosterHash.toLowerCase(),
    arbiter: normalizeAddress(row.arbiter, 'chainTable.arbiter'),
    // only a Filling table needs it, and tableFromChain's rows do not carry it
    seated: row.seated === undefined ? null : big(row.seated, 'chainTable.seated'),
  };
}

function readEpoch(epoch) {
  if (epoch === null || typeof epoch !== 'object') throw new RangeError('epoch must be an object');
  const state = normalizeState(epoch.state);
  if (!Array.isArray(epoch.sessionKeys) || epoch.sessionKeys.length !== state.players.length) {
    throw new RangeError('epoch.sessionKeys must have one entry per player');
  }
  const sessionKeys = epoch.sessionKeys.map((key, i) => {
    const address = normalizeAddress(key, `epoch.sessionKeys[${i}]`);
    if (address === ZERO_ADDRESS) throw new RangeError(`epoch.sessionKeys[${i}] must not be zero`);
    return address;
  });
  return {
    domain: normalizeDomain(epoch.domain),
    state,
    sessionKeys,
    arbiter: normalizeAddress(epoch.arbiter, 'epoch.arbiter'),
  };
}

const sum = (values) => values.reduce((a, b) => a + b, 0n);

/**
 * F1: does the chain say what the server's `epoch` message says? Pure; the caller reads the chain (see
 * createRpcChainView) and passes the rows. Returns { ok: true } or { ok: false, rule, detail }, `rule` one
 * of EPOCH_RULES. It never throws: a malformed argument is a refusal (`MALFORMED`).
 *
 *   epoch            { domain, state, sessionKeys, arbiter } in internal form. `state` is the epoch's genesis
 *                    (epochBaseline: the table's nonce and rakePaid, and the deposits as balances);
 *                    `sessionKeys[i]` belongs to `state.players[i]`.
 *   tableKey         the table this client pinned (bytes32)
 *   chainTable       the vault's tables(tableKey) row (decodeTableRow, tableFromChain or a ChainPort row;
 *                    status a number or its name). null means the table does not exist.
 *   chainSeats       one entry per roster seat, in state order: { deposit, sessionKey } as decodeSeat returns
 *                    it, or null for an empty seat
 *   myAddress        my wallet address; it must be on the roster
 *   myExpectedBalance bigint: what MY records say my balance is at this genesis (my deposit, or the balance
 *                    of the final state I signed if I stayed), never taken from the server's message
 *   allowFilling     true to accept a table that is still Filling (the epoch message can arrive before
 *                    `start` is mined). The result is then { ok: true, filling: true }: the roster is not
 *                    pinned until the table is Active, so check again then, and sign nothing before.
 *
 * Checked in this order: table-id, status (Active), nonce (equal to the genesis nonce), roster (rosterHash
 * equals rosterHash(players)), escrow (equals sum(balances) + rake - rakePaid), rake (the genesis rake
 * equals rakePaid), arbiter, session-key (every seat's key equals sessionKeys[i]), my-balance, deposit
 * (every seat's deposit equals its balance: while Active the contract never changes them, so this pins what
 * the other seats hold too). Three checks go beyond the contract's own list: table-id, rake and deposit.
 * They only refuse epochs that no honest server builds (epochBaseline sets rake = rakePaid and balances =
 * deposits).
 */
export function verifyEpochAgainstChain(args) {
  const refuse = (rule, detail) => ({ ok: false, rule, detail });
  try {
    let input;
    try {
      input = readArgs(args);
    } catch (error) {
      return refuse('MALFORMED', messageOf(error));
    }
    if (input.chainTable === null) return refuse('status', 'the table does not exist on the chain');
    const {
      epoch,
      tableKey,
      chainTable: t,
      chainSeats,
      me,
      myExpectedBalance,
      allowFilling,
    } = input;
    const { state } = epoch;

    if (state.tableId !== tableKey) return refuse('table-id', 'the epoch is for another table');
    const filling = t.status === STATUS.Filling;
    if (t.status !== STATUS.Active && !(filling && allowFilling)) {
      return refuse('status', `the table is ${statusNames[t.status]}, not Active`);
    }
    if (t.nonce !== state.nonce) {
      return refuse(
        'nonce',
        `the chain is at nonce ${t.nonce}, the epoch starts at ${state.nonce}`,
      );
    }
    if (filling) {
      // start() has not run: the roster hash is still zero and the contract has not frozen anyone. The seats
      // must at least be exactly the epoch's players in number; the hash is checked once the table is Active.
      if (t.seated === null)
        return refuse('MALFORMED', 'a Filling chainTable needs its seated count');
      if (t.seated !== BigInt(state.players.length)) {
        return refuse(
          'roster',
          `${t.seated} seats are taken, the epoch has ${state.players.length}`,
        );
      }
    } else if (t.rosterHash !== rosterHash(state.players)) {
      return refuse('roster', 'the chain roster hash is not the hash of the epoch players');
    }
    // escrow first: a rake that differs from rakePaid moves money between the books, and the formula says so
    const claimed = sum(state.balances) + state.rake - t.rakePaid;
    if (t.escrow !== claimed) {
      return refuse('escrow', `the chain holds ${t.escrow}, the epoch accounts for ${claimed}`);
    }
    if (state.rake !== t.rakePaid) {
      return refuse('rake', `the epoch rake is ${state.rake}, the vault has paid ${t.rakePaid}`);
    }
    if (t.arbiter !== epoch.arbiter) {
      return refuse('arbiter', 'the table arbiter is not the epoch arbiter');
    }
    for (let i = 0; i < state.players.length; i++) {
      const seat = chainSeats[i];
      if (seat === null) return refuse('session-key', `seat ${i} is empty on the chain`);
      if (seat.confirmed === false) return refuse('session-key', `seat ${i} is not confirmed`);
      if (seat.sessionKey !== epoch.sessionKeys[i]) {
        return refuse('session-key', `seat ${i} has another session key on the chain`);
      }
    }
    const meIndex = state.players.indexOf(me);
    if (state.balances[meIndex] !== myExpectedBalance) {
      return refuse(
        'my-balance',
        `the epoch gives you ${state.balances[meIndex]} but you know you have ${myExpectedBalance}`,
      );
    }
    for (let i = 0; i < state.players.length; i++) {
      if (chainSeats[i].deposit !== state.balances[i]) {
        return refuse(
          'deposit',
          `seat ${i} deposited ${chainSeats[i].deposit}, the epoch gives it ${state.balances[i]}`,
        );
      }
    }
    return filling ? { ok: true, filling: true } : { ok: true };
  } catch (error) {
    return refuse('INTERNAL', messageOf(error)); // fail closed
  }
}

function readArgs(args) {
  if (args === null || typeof args !== 'object')
    throw new RangeError('arguments must be an object');
  const epoch = readEpoch(args.epoch);
  const tableKey = `0x${bytes32Of(args.tableKey, 'tableKey')}`;
  const n = epoch.state.players.length;
  const allowFilling = args.allowFilling === undefined ? false : args.allowFilling;
  if (typeof allowFilling !== 'boolean') throw new RangeError('allowFilling must be a boolean');
  const chainTable = args.chainTable === null ? null : readTable(args.chainTable);
  if (!Array.isArray(args.chainSeats) || args.chainSeats.length !== n) {
    throw new RangeError('chainSeats must have one entry per roster seat');
  }
  const chainSeats = Array.from({ length: n }, (_, i) => {
    const seat = args.chainSeats[i];
    if (seat === null) return null;
    if (typeof seat !== 'object' || seat === undefined) {
      throw new RangeError(`chainSeats[${i}] must be a seat or null`);
    }
    return {
      deposit: big(seat.deposit, `chainSeats[${i}].deposit`),
      sessionKey: normalizeAddress(seat.sessionKey, `chainSeats[${i}].sessionKey`),
      confirmed: seat.confirmed,
    };
  });
  const me = normalizeAddress(args.myAddress, 'myAddress');
  if (!epoch.state.players.includes(me)) throw new RangeError('myAddress is not on the roster');
  if (typeof args.myExpectedBalance !== 'bigint' || args.myExpectedBalance < 0n) {
    throw new RangeError('myExpectedBalance must be a non-negative bigint');
  }
  return {
    epoch,
    tableKey,
    chainTable,
    chainSeats,
    me,
    myExpectedBalance: args.myExpectedBalance,
    allowFilling,
  };
}

/**
 * Does the chain show that the final state I signed has been settled? True when the table is Filling with
 * a nonce at or above the final's (settle sets the table's nonce to the final's), or Active at a nonce at or
 * above it (the epoch after the settle has started: its genesis nonce IS the final's). Anything else is
 * false, including Exiting, Closed, a table that does not exist, a row or a final that cannot be read, and a
 * state that is not final: the client then stays latched and signs nothing higher. Never throws.
 *
 *   chainTable  the tables(tableKey) row, fresh from the chain (null when the table does not exist)
 *   final       the final State I signed (internal form), or a bundle { state, ... } carrying it
 *
 * The client clears its "I signed a final" latch only when this is true; the server's word never clears it.
 */
export function chainShowsSettled(args) {
  try {
    const { chainTable, final } = args ?? {};
    if (chainTable === null || chainTable === undefined) return false;
    const finalState = final?.state ?? final;
    if (finalState?.isFinal !== true) return false;
    const nonce = big(finalState.nonce, 'final.nonce');
    const status = statusOf(chainTable.status, 'chainTable.status');
    const tableNonce = big(chainTable.nonce, 'chainTable.nonce');
    return (status === STATUS.Filling || status === STATUS.Active) && tableNonce >= nonce;
  } catch {
    return false;
  }
}
