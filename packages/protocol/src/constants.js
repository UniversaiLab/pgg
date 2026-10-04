// Constants shared by server and web. No dependencies, so the web bundle can import this without
// pulling in zod. The validating schemas live in index.js and are server-side.

export const PROTOCOL_VERSION = 1;

export const ACTIONS = Object.freeze(['fold', 'check', 'call', 'bet', 'raise']);

/** Every `t` a client may send. */
export const CLIENT = Object.freeze({
  JOIN: 'join',
  LEAVE: 'leave',
  ACT: 'act',
  SEED: 'seed',
  REBUY: 'rebuy',
  BACK: 'back',
  SYNC: 'sync',
  PING: 'ping',
});

/** Every `t` the server may send. */
export const SERVER = Object.freeze({
  WELCOME: 'welcome',
  LOBBY: 'lobby',
  SEATED: 'seated',
  UNSEATED: 'unseated',
  TABLE: 'tbl',
  CARDS: 'cards',
  PROOF: 'proof',
  BALANCE: 'balance',
  ERROR: 'err',
  PONG: 'pong',
});

/** Stable error codes (`err.code`). Clients branch on these, never on the message text. */
export const ERR = Object.freeze({
  BAD_MESSAGE: 'bad-message',
  RATE_LIMITED: 'rate-limited',
  UNKNOWN_TABLE: 'unknown-table',
  NOT_SEATED: 'not-seated',
  ALREADY_SEATED: 'already-seated',
  SEAT_TAKEN: 'seat-taken',
  TABLE_FULL: 'table-full',
  BAD_BUY_IN: 'bad-buy-in',
  INSUFFICIENT_FUNDS: 'insufficient-funds',
  STALE_HAND: 'stale-hand',
  NOT_YOUR_TURN: 'not-your-turn',
  ILLEGAL_ACTION: 'illegal-action',
  BAD_AMOUNT: 'bad-amount',
  SEED_CLOSED: 'seed-closed',
  REBUY_NOT_ALLOWED: 'rebuy-not-allowed',
});

/** WebSocket close codes (4000-4999 are application-defined). */
export const CLOSE = Object.freeze({
  REPLACED: 4000,
  UNAUTHORIZED: 4001,
  RATE_LIMITED: 4008,
  TOO_LARGE: 1009,
});

export const LIMITS = Object.freeze({
  maxMessageBytes: 2048,
  maxNameLength: 20,
  maxTableIdLength: 64,
});
