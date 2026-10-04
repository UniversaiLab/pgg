// Message schemas (zod). Client->server messages are validated by the server before anything
// else touches them. Server->client schemas exist so tests can prove the server never emits a
// malformed or leaky message; the web client trusts the server and does not ship zod.

import { z } from 'zod';
import { ACTIONS, CLIENT, LIMITS, SERVER, SIGN_REASONS, VAULT_PHASES } from './constants.js';

// Includes VAULT_PHASES and SIGN_REASONS, which live in constants.js so the web client can import them
// without zod; re-exported here so existing imports of the root entry keep working.
export * from './constants.js';

const card = z.string().regex(/^[2-9TJQKA][cdhs]$/);
const hex = (min, max) => z.string().regex(new RegExp(`^[0-9a-f]{${min},${max}}$`));
const chips = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
const seat = z.int().min(0).max(9);
const tableId = z.string().min(1).max(LIMITS.maxTableIdLength);

// Vault messages. Everything is lowercase hex WITH the 0x prefix (what the signing code produces),
// and amounts are decimal strings because token amounts do not fit a JS number. Only the canonical
// spelling is accepted, so one value has one string and two copies of a message compare equal.
const hex0x = (bytes) => z.string().regex(new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`));
const addr = hex0x(20);
const bytes32 = hex0x(32);
const sig65 = hex0x(65);

// `abort` matters: without it the range check still runs after a failed pattern, and BigInt('abc')
// throws instead of failing validation.
const decimal = (pattern, max, what) =>
  z
    .string()
    .regex(pattern, { abort: true })
    .refine((value) => BigInt(value) <= max, `exceeds ${what}`);
const uint = decimal(/^(0|[1-9][0-9]{0,77})$/, 2n ** 256n - 1n, 'uint256');
const u64 = decimal(/^(0|[1-9][0-9]{0,19})$/, 2n ** 64n - 1n, 'uint64');
const positiveUint = decimal(/^[1-9][0-9]{0,77}$/, 2n ** 256n - 1n, 'uint256'); // a uint that is not 0

// The deployment a state is signed under (EIP-712 domain minus the fixed name and version). Strict, because
// an extra key here would be a server bug that changes what people sign.
const domain = z.strictObject({ chainId: z.int().positive(), verifyingContract: addr });

// PokerVault's own bounds (PokerVault.sol: RAKE_BPS_CEILING, MIN_EXIT_WINDOW, MAX_EXIT_WINDOW), so a
// summary the contract would never have accepted at construction is not accepted here either.
const MAX_RAKE_BPS_CEILING = 500;
const MIN_EXIT_WINDOW_SEC = 3600; // 1 hour
const MAX_EXIT_WINDOW_SEC = 2_592_000; // 30 days
const MAX_SEATS = 10; // the contract's MAX_PLAYERS

const epoch = z.int().min(0);
const seatCount = (item) => z.array(item).min(2).max(MAX_SEATS); // the contract allows 2 to MAX_PLAYERS

/** PokerVault's `State` as it travels: amounts and nonce are decimal strings, the arrays line up. */
export const WireState = z
  .object({
    tableId: bytes32,
    nonce: u64,
    isFinal: z.boolean(),
    players: seatCount(addr),
    balances: seatCount(uint),
    keep: seatCount(z.boolean()),
    rake: uint,
    volume: uint,
  })
  .refine(
    (state) =>
      state.balances.length === state.players.length && state.keep.length === state.players.length,
    'players, balances and keep must have the same length',
  );

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
  z.strictObject({ t: z.literal(CLIENT.CLAIM), tableId, address: addr, sig: sig65 }),
  z.strictObject({ t: z.literal(CLIENT.SIGN), nonce: u64, digest: bytes32, sig: sig65 }),
]);

// sessionKeys and playerSigs are positional (index i belongs to state.players[i]), so a list of the wrong
// length would pair a key or signature with the wrong player. Returns the arguments of `.refine`.
const onePerPlayer = (field) => [
  (message) => message[field].length === message.state.players.length,
  { error: `${field} must have one entry per player`, path: [field] },
];

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
  // Present on vault tables only.
  vault: z
    .object({
      chainId: z.int().positive(),
      vault: addr,
      tableKey: bytes32,
      chipUnit: positiveUint, // token base units per chip; 0 would make every balance zero
      maxRakeBps: z.int().min(0).max(MAX_RAKE_BPS_CEILING),
      exitWindowSec: z.int().min(MIN_EXIT_WINDOW_SEC).max(MAX_EXIT_WINDOW_SEC),
      arbiter: addr,
    })
    .optional(),
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
  address: addr.optional(), // vault tables: the on-chain address this seat claimed
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
  // Vault tables only: where the epoch is, and whom the table is waiting for.
  vault: z
    .object({
      epoch,
      phase: z.enum(VAULT_PHASES),
      nonce: u64,
      awaiting: z.array(seat).max(MAX_SEATS), // seats, so never more than the table has
      deadline: z.number().nullable(),
    })
    .optional(),
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
  z
    .object({
      t: z.literal(SERVER.EPOCH),
      tableId,
      epoch,
      domain,
      state: WireState,
      sessionKeys: z.array(addr),
      arbiter: addr,
    })
    .refine(...onePerPlayer('sessionKeys')),
  z.object({
    t: z.literal(SERVER.SIGN_REQ),
    tableId,
    epoch,
    handNo: z.int().min(0).nullable(),
    state: WireState,
    digest: bytes32,
    deadline: z.number(), // epoch ms
    reason: z.enum(SIGN_REASONS),
  }),
  // The library's wire bundle is { domain, state, arbiterSig, playerSigs }; tableId, epoch and sessionKeys
  // are what the client needs around it to verify and file it.
  z
    .object({
      t: z.literal(SERVER.BUNDLE),
      tableId,
      epoch,
      domain,
      state: WireState,
      arbiterSig: sig65,
      playerSigs: seatCount(sig65),
      sessionKeys: z.array(addr),
    })
    .refine(...onePerPlayer('sessionKeys'))
    .refine(...onePerPlayer('playerSigs')),
]);
