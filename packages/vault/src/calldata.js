// Calldata for the few contract calls the browser makes from the player's own wallet (deposit, leave, the
// self-exit, withdraw) and the token calls around them (balance, allowance, approve). A small hand-written ABI
// encoder, so the web app needs no viem: it covers exactly the types these calls use, and test/calldata.test.js
// checks every call byte for byte against viem's encodeFunctionData.

import { fromHex, keccak256, toHex } from './sign.js';
import { normalizeState } from './state.js';

const enc = new TextEncoder();
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const strip = (hex) => String(hex).slice(2).toLowerCase();
const padRight = (hex) => hex.padEnd(Math.ceil(hex.length / 64) * 64 || 0, '0');

/** The 4-byte selector of a function signature like 'deposit(bytes32,uint256,address)'. */
export const selector = (signature) => toHex(keccak256(enc.encode(signature))).slice(0, 10);

function isDynamic(type) {
  if (Array.isArray(type)) return type.some(isDynamic);
  return type === 'bytes' || type.endsWith('[]');
}

// One value as hex without 0x. Static types are one word; dynamic ones are their tail encoding.
function encodeValue(type, value) {
  if (Array.isArray(type)) return encodeTuple(type, value);
  if (type.endsWith('[]')) {
    const inner = type.slice(0, -2);
    return word(value.length) + encodeTuple(new Array(value.length).fill(inner), value);
  }
  switch (type) {
    case 'address':
      if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new TypeError(`bad address ${value}`);
      return strip(value).padStart(64, '0');
    case 'bool':
      return word(value ? 1 : 0);
    case 'bytes32':
      if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new TypeError(`bad bytes32 ${value}`);
      return strip(value);
    case 'bytes': {
      const hex = strip(value);
      if (!/^[0-9a-f]*$/.test(hex) || hex.length % 2) throw new TypeError('bad bytes');
      return word(hex.length / 2) + padRight(hex);
    }
    default:
      if (/^uint\d+$/.test(type)) {
        const n = BigInt(value);
        if (n < 0n || n >= 1n << BigInt(type.slice(4)))
          throw new RangeError(`${type} out of range`);
        return word(n);
      }
      throw new TypeError(`unsupported type ${type}`);
  }
}

// Head/tail encoding of a list of values (a tuple, or the elements of an array).
function encodeTuple(types, values) {
  const heads = [];
  const tails = [];
  let tailOffset = types.length * 32;
  types.forEach((type, i) => {
    const encoded = encodeValue(type, values[i]);
    if (isDynamic(type)) {
      heads.push(word(tailOffset));
      tails.push(encoded);
      tailOffset += encoded.length / 2;
    } else {
      heads.push(encoded);
    }
  });
  return heads.join('') + tails.join('');
}

/** '0x' + selector + arguments. `types` uses Solidity names; a tuple is a nested array of types. */
export function encodeCall(signature, types, values) {
  return selector(signature) + encodeTuple(types, values);
}

const STATE = [
  'bytes32',
  'uint64',
  'bool',
  'address[]',
  'uint256[]',
  'bool[]',
  'uint256',
  'uint256',
];
const STATE_SIG = '(bytes32,uint64,bool,address[],uint256[],bool[],uint256,uint256)';

function stateValues(state) {
  const s = normalizeState(state);
  return [s.tableId, s.nonce, s.isFinal, s.players, s.balances, s.keep, s.rake, s.volume];
}

/** The calls a player's wallet makes. Every function returns calldata (0x hex). */
export const calls = Object.freeze({
  // ERC-20
  balanceOf: (owner) => encodeCall('balanceOf(address)', ['address'], [owner]),
  allowance: (owner, spender) =>
    encodeCall('allowance(address,address)', ['address', 'address'], [owner, spender]),
  approve: (spender, amount) =>
    encodeCall('approve(address,uint256)', ['address', 'uint256'], [spender, amount]),
  decimals: () => selector('decimals()'),
  symbol: () => selector('symbol()'),
  // MockToken on a test chain only: anyone may mint
  mint: (to, amount) => encodeCall('mint(address,uint256)', ['address', 'uint256'], [to, amount]),
  // PokerVault
  token: () => selector('TOKEN()'),
  exitWindow: () => selector('EXIT_WINDOW()'),
  withdrawable: (account) => encodeCall('withdrawable(address)', ['address'], [account]),
  deposit: (tableKey, amount, sessionKey) =>
    encodeCall(
      'deposit(bytes32,uint256,address)',
      ['bytes32', 'uint256', 'address'],
      [tableKey, amount, sessionKey],
    ),
  leave: (tableKey) => encodeCall('leave(bytes32)', ['bytes32'], [tableKey]),
  withdraw: (to) => encodeCall('withdraw(address)', ['address'], [to]),
  startExit: (bundle) =>
    encodeCall(
      `startExit(${STATE_SIG},bytes,bytes[])`,
      [STATE, 'bytes', 'bytes[]'],
      [stateValues(bundle.state), bundle.arbiterSig, [...bundle.playerSigs]],
    ),
  startExitFromDeposits: (tableKey, players) =>
    encodeCall(
      'startExitFromDeposits(bytes32,address[])',
      ['bytes32', 'address[]'],
      [tableKey, players],
    ),
  finalizeExit: (state) => encodeCall(`finalizeExit(${STATE_SIG})`, [STATE], [stateValues(state)]),
});

/** The n-th 32-byte word of an eth_call result, as a bigint (a uint, or an address/bool in a word). */
export function wordAt(result, n = 0) {
  const hex = strip(result).slice(n * 64, n * 64 + 64);
  if (hex.length !== 64) throw new RangeError('result too short');
  return BigInt(`0x${hex}`);
}

/** The n-th word as a lowercase address. */
export const addressAt = (result, n = 0) => `0x${word(wordAt(result, n)).slice(24)}`;

/** A string returned by a view (symbol()): offset, length, bytes. */
export function stringAt(result) {
  const offset = Number(wordAt(result, 0)) / 32;
  const length = Number(wordAt(result, offset));
  const start = (offset + 1) * 64;
  const bytes = fromHex(`0x${strip(result).slice(start, start + length * 2)}`);
  return new TextDecoder().decode(bytes);
}
