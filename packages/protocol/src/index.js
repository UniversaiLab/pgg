// Message schemas (zod). Client->server messages are validated by the server before anything
// else touches them. Server->client schemas exist so tests can prove the server never emits a
// malformed or leaky message; the web client trusts the server and does not ship zod.

import { z } from 'zod';
import { ACTIONS, CLIENT, LIMITS, SERVER } from './constants.js';

export * from './constants.js';

const card = z.string().regex(/^[2-9TJQKA][cdhs]$/);
const hex = (min, max) => z.string().regex(new RegExp(`^[0-9a-f]{${min},${max}}$`));
const chips = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
const seat = z.int().min(0).max(9);
const tableId = z.string().min(1).max(LIMITS.maxTableIdLength);

// ---- client -> server -----------------------------------------------------------------------

export const ClientMessage = z.discriminatedUnion('t', [
  z.strictObject({
    t: z.literal(CLIENT.JOIN),
    tableId,
    seat: seat.optional(),
    buyIn: chips.min(1),
  }),
  z.strictObject({ t: z.literal(CLIENT.LEAVE) }),
  z.strictObject({
    t: z.literal(CLIENT.ACT),
    handNo: z.int().min(0),
    action: z.enum(ACTIONS),
    amount: chips.optional(),
  }),
  z.strictObject({ t: z.literal(CLIENT.SEED), handNo: z.int().min(0), seed: hex(2, 64) }),
  z.strictObject({ t: z.literal(CLIENT.REBUY), amount: chips.min(1) }),
  z.strictObject({ t: z.literal(CLIENT.BACK) }),
  z.strictObject({ t: z.literal(CLIENT.SYNC) }),
  z.strictObject({ t: z.literal(CLIENT.PING), n: z.int().optional() }),
]);

// ---- server -> client -----------------------------------------------------------------------

export const TableSummary = z.object({
  id: tableId,
  name: z.string(),
  smallBlind: chips,
  bigBlind: chips,
  minBuyIn: chips,
  maxBuyIn: chips,
  numSeats: z.int(),
  occupied: z.int(),
  rakeBps: z.int(),
});

const seatState = z.object({
  seat,
  playerId: z.string(),
  name: z.string(),
  chips,
  bet: chips,
  folded: z.boolean(),
  allIn: z.boolean(),
  hasCards: z.boolean(),
  status: z.enum(['seated', 'waiting', 'sitout']),
  connected: z.boolean(),
});

export const TableState = z.object({
  tableId,
  name: z.string(),
  handNo: z.int().nullable(),
  inHand: z.boolean(),
  button: seat.nullable(),
  toAct: seat.nullable(),
  round: z.enum(['preflop', 'flop', 'turn', 'river']).nullable(),
  board: z.array(card).max(5),
  pot: chips,
  seats: z.array(seatState.nullable()),
  legal: z
    .object({
      actions: z.array(z.enum(ACTIONS)),
      toCall: chips,
      min: chips.optional(),
      max: chips.optional(),
    })
    .nullable(),
  deadline: z.number().nullable(),
  // Commitment to the hand in progress, and to the next one (published early so players can
  // contribute a client seed before it is dealt).
  fairness: z.object({
    current: z.object({ handNo: z.int(), commitment: hex(64, 64) }).nullable(),
    next: z.object({ handNo: z.int(), commitment: hex(64, 64) }).nullable(),
  }),
});

export const ServerMessage = z.discriminatedUnion('t', [
  z.object({
    t: z.literal(SERVER.WELCOME),
    v: z.int(),
    player: z.object({ id: z.string(), name: z.string(), balance: chips }),
    tables: z.array(TableSummary),
    seated: z.object({ tableId, seat }).nullable(),
  }),
  z.object({ t: z.literal(SERVER.LOBBY), tables: z.array(TableSummary) }),
  z.object({ t: z.literal(SERVER.SEATED), tableId, seat }),
  z.object({ t: z.literal(SERVER.UNSEATED), tableId, reason: z.string(), chips }),
  z.object({
    t: z.literal(SERVER.TABLE),
    tableId,
    seq: z.int(),
    state: TableState,
    events: z.array(z.looseObject({ type: z.string() })),
  }),
  z.object({
    t: z.literal(SERVER.CARDS),
    tableId,
    handNo: z.int(),
    seat,
    cards: z.tuple([card, card]),
  }),
  z.object({
    t: z.literal(SERVER.PROOF),
    tableId,
    handNo: z.int(),
    proof: z.object({
      tableId,
      handNo: z.int(),
      commitment: hex(64, 64),
      serverSeed: hex(64, 64),
      clientSeeds: z.array(z.object({ seat, seed: hex(2, 64) })),
      dealt: z.array(card),
    }),
  }),
  z.object({ t: z.literal(SERVER.BALANCE), balance: chips }),
  z.object({
    t: z.literal(SERVER.ERROR),
    code: z.string(),
    msg: z.string().optional(),
    ref: z.string().optional(),
  }),
  z.object({ t: z.literal(SERVER.PONG), n: z.int().optional(), now: z.number() }),
]);
