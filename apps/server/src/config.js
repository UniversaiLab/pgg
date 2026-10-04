import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';

const positive = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

/** Play-money stakes. Chips are integers; the escrow milestone maps them to token units. */
function defaultTables() {
  const make = (id, name, smallBlind, minBuyIn, maxBuyIn) => ({
    id,
    name,
    numSeats: 6,
    smallBlind,
    bigBlind: smallBlind * 2,
    minBuyIn,
    maxBuyIn,
    rakeBps: 300,
    rakeCap: smallBlind * 6,
  });
  return [
    make('rookie-1', 'Rookie', 5, 200, 1000),
    make('rookie-2', 'Rookie II', 5, 200, 1000),
    make('regular-1', 'Regular', 25, 1000, 5000),
    make('high-1', 'High Roller', 100, 4000, 20000),
  ];
}

/** `n` identical 6-max tables, for load tests only (LOAD_TABLES=n). */
function loadTestTables(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `load-${i + 1}`,
    name: `Load ${i + 1}`,
    numSeats: 6,
    smallBlind: 5,
    bigBlind: 10,
    minBuyIn: 200,
    maxBuyIn: 1000,
    rakeBps: 300,
    rakeCap: 30,
  }));
}

export function loadConfig(env = process.env) {
  const secret = env.PGG_SECRET ?? bytesToHex(randomBytes(32));
  return {
    port: env.PORT === undefined ? 8787 : Number(env.PORT), // 0 picks a free port (tests)
    hostname: env.HOST ?? '0.0.0.0',
    secret,
    secretIsEphemeral: env.PGG_SECRET === undefined,
    tokenTtlMs: positive(env.TOKEN_TTL_MS, 24 * 60 * 60 * 1000),
    startBalance: positive(env.START_BALANCE, 10_000),
    turnMs: positive(env.TURN_MS, 20_000),
    interHandMs: positive(env.INTER_HAND_MS, 3_000),
    sitoutGraceMs: positive(env.SITOUT_GRACE_MS, 60_000),
    // Per connection. A human sends a few messages a second at most; raise this only for load tests.
    rateLimit: {
      capacity: positive(env.RATE_CAPACITY, 40),
      refillPerSec: positive(env.RATE_REFILL, 20),
    },
    // The event loop may be blocked this long before the watchdog kills the process (0 disables).
    watchdogMs: Number(env.WATCHDOG_MS ?? 10_000),
    corsOrigins: (env.CORS_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173').split(','),
    webDist: env.WEB_DIST ?? null,
    tables:
      positive(env.LOAD_TABLES, 0) > 0
        ? loadTestTables(positive(env.LOAD_TABLES, 0))
        : defaultTables(),
  };
}
