// Provably-fair deck derivation. Pure and browser-safe: the web client imports this file
// (via `@pgg/engine/fairness`) to verify hands, so it must never import poker-ts or node:*.
//
//   deck = Fisher-Yates over the canonical deck, driven by HMAC-SHA256(serverSeed, context)
//
// `context` binds table, hand number and every client seed, so the same inputs always give the
// same deck and any change to any input gives an unrelated deck.

import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  randomBytes,
  utf8ToBytes,
} from '@noble/hashes/utils.js';

export const DECK_SIZE = 52;
export const SEED_BYTES = 32;
export const MAX_CLIENT_SEED_BYTES = 32;
export const RANKS = '23456789TJQKA';
export const SUITS = 'cdhs'; // clubs, diamonds, hearts, spades (poker-ts enum order)

/** Cards as two-char codes ("As", "Td"), clubs 2..A first. Matches the order poker-ts builds. */
export const CANONICAL_DECK = Object.freeze(
  [...SUITS].flatMap((suit) => [...RANKS].map((rank) => `${rank}${suit}`)),
);

const DOMAIN = 'pgg/deck/v1';
const LOWER_HEX = /^[0-9a-f]*$/;
const CARD_CODE = /^[2-9TJQKA][cdhs]$/;

export const isCardCode = (value) => typeof value === 'string' && CARD_CODE.test(value);

const u32 = (n) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, false);
  return out;
};

const u64 = (n) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), false);
  return out;
};

// Length-prefixed so adjacent fields can never be confused with one another.
const field = (bytes) => concatBytes(u32(bytes.length), bytes);

function parseHex(value, { name, minBytes = 1, maxBytes, exactBytes }) {
  if (typeof value !== 'string' || value.length % 2 !== 0 || !LOWER_HEX.test(value)) {
    throw new TypeError(`${name} must be lowercase hex`);
  }
  const length = value.length / 2;
  if (exactBytes !== undefined && length !== exactBytes) {
    throw new RangeError(`${name} must be exactly ${exactBytes} bytes`);
  }
  if (length < minBytes || (maxBytes !== undefined && length > maxBytes)) {
    throw new RangeError(`${name} must be ${minBytes}-${maxBytes} bytes`);
  }
  return hexToBytes(value);
}

/** 32 fresh CSPRNG bytes as lowercase hex. */
export function newServerSeed() {
  return bytesToHex(randomBytes(SEED_BYTES));
}

/** Public commitment to a server seed: SHA-256 of the seed bytes, lowercase hex. */
export function commitSeed(serverSeed) {
  return bytesToHex(sha256(parseHex(serverSeed, { name: 'serverSeed', exactBytes: SEED_BYTES })));
}

/** Validate client seeds ([{ seat, seed }]) and return them sorted by seat. */
export function normalizeClientSeeds(clientSeeds = []) {
  const seen = new Set();
  const out = [];
  for (const { seat, seed } of clientSeeds) {
    if (!Number.isInteger(seat) || seat < 0 || seat > 255) {
      throw new RangeError('client seed seat must be an integer 0-255');
    }
    if (seen.has(seat)) throw new Error(`duplicate client seed for seat ${seat}`);
    seen.add(seat);
    parseHex(seed, { name: 'client seed', maxBytes: MAX_CLIENT_SEED_BYTES });
    out.push({ seat, seed });
  }
  return out.sort((a, b) => a.seat - b.seat);
}

function contextHash({ tableId, handNo, clientSeeds }) {
  if (typeof tableId !== 'string' || tableId.length === 0 || tableId.length > 64) {
    throw new TypeError('tableId must be a 1-64 character string');
  }
  if (!Number.isSafeInteger(handNo) || handNo < 0) {
    throw new RangeError('handNo must be a non-negative safe integer');
  }
  const parts = [
    field(utf8ToBytes(DOMAIN)),
    field(utf8ToBytes(tableId)),
    u64(handNo),
    u32(clientSeeds.length),
  ];
  for (const { seat, seed } of clientSeeds) parts.push(u32(seat), field(hexToBytes(seed)));
  return sha256(concatBytes(...parts));
}

// HMAC-SHA256 in counter mode: block(i) = HMAC(key, contextHash || i). Yields 32-bit words.
function wordStream(key, context) {
  let counter = 0;
  let block = new Uint8Array(0);
  let offset = 0;
  return () => {
    if (offset + 4 > block.length) {
      block = hmac(sha256, key, concatBytes(context, u32(counter++)));
      offset = 0;
    }
    const word = new DataView(block.buffer, block.byteOffset + offset, 4).getUint32(0, false);
    offset += 4;
    return word;
  };
}

// Uniform integer in [0, n) by rejection sampling, so there is no modulo bias.
function uniform(nextWord, n) {
  const limit = Math.floor(0x100000000 / n) * n;
  let word = nextWord();
  while (word >= limit) word = nextWord();
  return word % n;
}

/**
 * Deterministic deck for one hand, as card codes in DRAW order (index 0 is dealt first).
 * @param {{ serverSeed: string, clientSeeds?: {seat:number, seed:string}[], tableId: string, handNo: number }} input
 * @returns {string[]} 52 distinct card codes
 */
export function deriveDeck({ serverSeed, clientSeeds = [], tableId, handNo }) {
  const key = parseHex(serverSeed, { name: 'serverSeed', exactBytes: SEED_BYTES });
  const seeds = normalizeClientSeeds(clientSeeds);
  const nextWord = wordStream(key, contextHash({ tableId, handNo, clientSeeds: seeds }));
  const deck = [...CANONICAL_DECK];
  for (let i = DECK_SIZE - 1; i > 0; i--) {
    const j = uniform(nextWord, i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/**
 * Check a revealed hand. `dealt` is the cards actually drawn, in draw order (a prefix of the deck:
 * every hole card first, then flop/turn/river if they were reached).
 * Never throws: bad input yields `{ ok: false, reason }`.
 */
export function verifyHand({ commitment, serverSeed, clientSeeds = [], tableId, handNo, dealt }) {
  try {
    if (commitSeed(serverSeed) !== commitment) return { ok: false, reason: 'commitment-mismatch' };
    const deck = deriveDeck({ serverSeed, clientSeeds, tableId, handNo });
    if (!Array.isArray(dealt) || dealt.length > DECK_SIZE)
      return { ok: false, reason: 'bad-dealt' };
    for (let index = 0; index < dealt.length; index++) {
      if (!isCardCode(dealt[index])) return { ok: false, reason: 'bad-dealt', index };
      if (dealt[index] !== deck[index]) {
        return {
          ok: false,
          reason: 'card-mismatch',
          index,
          expected: deck[index],
          got: dealt[index],
        };
      }
    }
    return { ok: true, deck };
  } catch (error) {
    return { ok: false, reason: 'invalid-input', detail: error.message };
  }
}
