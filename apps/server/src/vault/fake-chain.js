// FakeChain: PokerVault in memory, behind the ChainPort. Every coordinator and watchtower test runs against
// it, so it has to say no to exactly what the contract says no to, with the contract's own error names. The
// verification steps are not re-written here: createTable..finalizeExit follow PokerVault.sol function by
// function, and every state is judged by @pgg/vault checkState / checkSettle, which the anvil equivalence
// tests already hold to the contract's order and error names.
//
// Two layers, on purpose:
//   live   the contract's storage. Jobs and the test helpers (deposit, leave, ...) change it at once.
//   view   what table(), seat() and chainTime() answer: the adapter's cache. It is refreshed by tick(), which
//          is the poll timer, BEFORE that tick's events are delivered (a handler that reads the chain sees at
//          least the state its event describes). An event that never arrives (loseEvents) leaves its table's
//          view stale until repair(), the periodic re-read, fixes it.
//
// submit() only queues. tick() runs the queued jobs by priority, one block per successful transaction, then
// delivers the events in order. Nothing is ever delivered from inside submit() or a read.
//
// Not part of the ChainPort (test-only): send, deposit, setSessionKey, leave, withdraw, setConfirmed,
// advanceTime, tick, failNext, loseEvents, repair, pause, setVaultArbiter, blacklist, mint, balances,
// invariants, live, and the logs (delivered, lost, skipped).
import {
  checkSettle,
  checkState,
  decodeState,
  depositState,
  hashState,
  normalizeAddress,
  RAKE_BPS_CEILING,
  rosterHash,
  STATUS,
  UINT256_MAX,
} from '@pgg/vault';
import {
  assertJob,
  EVENT_TYPES,
  isRetryableRevert,
  JOB_KINDS,
  JOB_SENDER,
  statusName,
} from './chain-port.js';

const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;
const ZERO_HASH = `0x${'00'.repeat(32)}`;
const MIN_EXIT_WINDOW = 3600; // PokerVault.MIN_EXIT_WINDOW
const MAX_EXIT_WINDOW = 30 * 24 * 3600; // PokerVault.MAX_EXIT_WINDOW
const MAX_TABLE_PLAYERS = 10; // PokerVault.MAX_PLAYERS
const PLAYER_CALLS = ['deposit', 'setSessionKey', 'leave', 'withdraw'];
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const HEX_BYTES = /^0x([0-9a-fA-F]{2})*$/;

/** A revert: the contract's error name and its arguments, typed like viem decodes them. */
class Revert extends Error {
  constructor(error, args = []) {
    super(error);
    this.error = error;
    this.args = args;
  }
}

const malformed = (message) => new Revert('Malformed', [message]);

// The contract's ABI decoder rejects these before the function body runs, so they win over every check.
function uint(value, field, max = UINT256_MAX) {
  const v = typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : value;
  if (typeof v !== 'bigint' || v < 0n || v > max) {
    throw malformed(`${field} must be an unsigned integer in range`);
  }
  return v;
}

function address(value, field) {
  try {
    return normalizeAddress(value, field);
  } catch (error) {
    throw malformed(error.message);
  }
}

function bytes32(value, field) {
  if (typeof value !== 'string' || !BYTES32.test(value)) {
    throw malformed(`${field} must be 32 bytes of 0x hex`);
  }
  return value.toLowerCase();
}

function addresses(list, field) {
  if (!Array.isArray(list)) throw malformed(`${field} must be an array`);
  return Array.from(list, (a, i) => address(a, `${field}[${i}]`));
}

function decodeAny(state) {
  try {
    return decodeState(state);
  } catch (error) {
    throw malformed(error.message);
  }
}

function decodeBundle(bundle) {
  if (bundle === null || typeof bundle !== 'object') throw malformed('bundle must be an object');
  const state = decodeAny(bundle.state);
  const { arbiterSig, playerSigs } = bundle;
  const hex = (sig) => typeof sig === 'string' && HEX_BYTES.test(sig);
  if (!hex(arbiterSig) || !Array.isArray(playerSigs) || !playerSigs.every(hex)) {
    throw malformed('signatures must be 0x hex: arbiterSig and playerSigs');
  }
  return { state, sigs: { arbiterSig, playerSigs } };
}

const blankRow = () => ({
  status: STATUS.None,
  maxPlayers: 0,
  seated: 0,
  arbiter: ZERO_ADDRESS,
  nonce: 0n,
  exitDeadline: 0,
  minDeposit: 0n,
  maxDeposit: 0n,
  escrow: 0n,
  rakePaid: 0n,
  rosterHash: ZERO_HASH,
  exitDigest: ZERO_HASH,
  seats: new Map(), // address -> { deposit, sessionKey, confirmed }
});

const publicRow = (t) =>
  Object.freeze({
    status: statusName(t.status),
    nonce: t.nonce,
    escrow: t.escrow,
    rakePaid: t.rakePaid,
    rosterHash: t.rosterHash,
    exitDeadline: t.exitDeadline,
    exitDigest: t.exitDigest,
    arbiter: t.arbiter,
    seated: t.seated,
    maxPlayers: t.maxPlayers,
    minDeposit: t.minDeposit,
    maxDeposit: t.maxDeposit,
  });

const seatsOf = (t) => new Map([...t.seats].map(([a, s]) => [a, Object.freeze({ ...s })]));

const text = (value) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? `${v}n` : v));

/** Throws unless a test helper's result is { ok: true }; returns the result. Reads best around setup code. */
export function expectOk(result, what = 'call') {
  if (!result.ok) throw new Error(`${what} reverted: ${result.error}(${result.args.join(', ')})`);
  return result;
}

/**
 * The test token. Accounts and the vault are all just addresses here; approvals are implicit (every holder
 * has approved the vault for everything), so a deposit fails only when the holder is too poor.
 */
class TokenLedger {
  #held = new Map();
  #blocked = new Set();
  #vault;
  #house;
  #minted = 0n;

  constructor(vault, house) {
    this.#vault = vault;
    this.#house = house;
  }

  of(account) {
    return this.#held.get(account) ?? 0n;
  }

  /** Tokens the vault holds. */
  get vault() {
    return this.of(this.#vault);
  }

  /** Tokens the house (the rake recipient) holds. */
  get house() {
    return this.of(this.#house);
  }

  /** Everything ever minted: the sum of all balances, always. */
  get minted() {
    return this.#minted;
  }

  get total() {
    let sum = 0n;
    for (const v of this.#held.values()) sum += v;
    return sum;
  }

  mint(account, amount) {
    this.#held.set(account, this.of(account) + amount);
    this.#minted += amount;
  }

  /** MockToken's blacklist: a blocked account can neither send nor receive. */
  block(account, blocked) {
    if (blocked) this.#blocked.add(account);
    else this.#blocked.delete(account);
  }

  move(from, to, amount) {
    if (this.#blocked.has(from) || this.#blocked.has(to))
      throw new Revert('Error', ['blacklisted']);
    const have = this.of(from);
    if (have < amount) throw new Revert('ERC20InsufficientBalance', [from, have, amount]);
    this.#held.set(from, have - amount);
    this.#held.set(to, this.of(to) + amount);
  }
}

export class FakeChain {
  #info;
  #domain;
  #vaultArbiter;
  #house;
  #paused = false;
  #tables = new Map(); // tableKey -> live row
  #withdrawable = new Map();
  #totalLocked = 0n;
  #ledger;
  #autoMint;

  #time;
  #block;
  #logIndex = 0;

  #view = { time: 0, tables: new Map(), seats: new Map() };
  #stale = new Set();

  #queue = [];
  #held = new Set(); // keys queued or running
  #seq = 0;
  #pending = [];
  #sinks = new Set();
  #resolver = null;
  #failures = new Map();
  #losses = [];
  #ticking = false;

  /** Every event handed to subscribers, in order. */
  delivered = [];
  /** Events that were emitted and never delivered (see loseEvents). */
  lost = [];
  /** Jobs the resolver declined: { key, kind, reason }. */
  skipped = [];
  /** { key, kind, sender, ok, error? } for every transaction a job sent or tried to send. */
  sent = [];

  constructor({
    chainId = 31337,
    vault = '0x00000000000000000000000000000000000dead1',
    arbiter = '0x000000000000000000000000000000000000a2b1',
    relayer = '0x00000000000000000000000000000000005e1a01',
    house = '0x000000000000000000000000000000000000b055',
    maxRakeBps = 500,
    exitWindowSec = 3600,
    startTime = 1_700_000_000,
    startBlock = 1,
    autoMint = false,
    resolver = null,
  } = {}) {
    if (!Number.isInteger(maxRakeBps) || maxRakeBps < 0 || maxRakeBps > RAKE_BPS_CEILING) {
      throw new RangeError('BadConfig: maxRakeBps must be an integer from 0 to 500');
    }
    if (
      !Number.isInteger(exitWindowSec) ||
      exitWindowSec < MIN_EXIT_WINDOW ||
      exitWindowSec > MAX_EXIT_WINDOW
    ) {
      throw new RangeError('BadConfig: exitWindowSec must be from 1 hour to 30 days');
    }
    if (!Number.isSafeInteger(startTime) || startTime < 0) {
      throw new RangeError('startTime must be a non-negative safe integer');
    }
    this.#info = Object.freeze({
      chainId,
      vault: normalizeAddress(vault, 'vault'),
      arbiter: normalizeAddress(arbiter, 'arbiter'),
      relayer: normalizeAddress(relayer, 'relayer'),
      maxRakeBps,
      exitWindowSec,
    });
    this.#domain = { chainId, verifyingContract: this.#info.vault };
    this.#vaultArbiter = this.#info.arbiter;
    this.#house = normalizeAddress(house, 'house');
    this.#ledger = new TokenLedger(this.#info.vault, this.#house);
    this.#autoMint = autoMint;
    this.#time = startTime;
    this.#block = startBlock;
    this.#view.time = startTime;
    if (resolver) this.resolver = resolver;
  }

  // ---- ChainPort ----------------------------------------------------------------------------------

  get info() {
    return this.#info;
  }

  table(tableKey) {
    return this.#view.tables.get(String(tableKey).toLowerCase()) ?? null;
  }

  seat(tableKey, account) {
    const seat = this.#view.seats
      .get(String(tableKey).toLowerCase())
      ?.get(String(account).toLowerCase());
    return seat ? { ...seat } : null;
  }

  chainTime() {
    return this.#view.time;
  }

  submit(job) {
    assertJob(job);
    if (this.#held.has(job.key)) return false;
    this.#held.add(job.key);
    this.#queue.push({ job: { ...job }, seq: this.#seq++ });
    return true;
  }

  subscribe(sink) {
    if (typeof sink !== 'function') throw new TypeError('sink must be a function');
    this.#sinks.add(sink);
    return () => this.#sinks.delete(sink);
  }

  // ---- the resolver (coordinator side) --------------------------------------------------------------

  set resolver(resolver) {
    if (!resolver || typeof resolver.prepare !== 'function') {
      throw new TypeError('resolver must have prepare(job)');
    }
    this.#resolver = resolver;
  }

  // ---- test-only: time and the poll -----------------------------------------------------------------

  /** Seconds on the live chain clock (chainTime() lags until the next tick). */
  get liveTime() {
    return this.#time;
  }

  /** Latest block number. */
  get block() {
    return this.#block;
  }

  /** Move the live clock and mine an empty block, like anvil's increaseTime + mine. */
  advanceTime(seconds) {
    if (!Number.isSafeInteger(seconds) || seconds < 0) {
      throw new RangeError('seconds must be a non-negative safe integer');
    }
    this.#time += seconds;
    this.#mine();
  }

  /**
   * One poll: run the queued jobs (highest priority first, then in submit order), refresh the view, deliver
   * the events. Jobs submitted while it runs wait for the next tick. Returns what the jobs did.
   */
  tick() {
    if (this.#ticking) throw new Error('tick() re-entered');
    if (this.#queue.length > 0 && !this.#resolver) {
      throw new Error('FakeChain has no resolver: pass { resolver } or set chain.resolver');
    }
    this.#ticking = true;
    const batch = this.#queue
      .splice(0)
      .sort((a, b) => b.job.priority - a.job.priority || a.seq - b.seq);
    try {
      const jobs = batch.map(({ job }) => this.#runJob(job));
      // keys are free again before the events go out, so a handler may submit the same job for the next poll
      for (const { job } of batch) this.#held.delete(job.key);
      const events = this.#deliver();
      return { jobs, events };
    } finally {
      for (const { job } of batch) this.#held.delete(job.key);
      this.#ticking = false;
    }
  }

  /** The periodic re-read: refresh every table and the clock from the live chain. Returns the tables that changed. */
  repair() {
    const changed = [];
    for (const key of this.#tables.keys()) {
      const before = text([this.#view.tables.get(key), [...(this.#view.seats.get(key) ?? [])]]);
      this.#refresh(key);
      const after = text([this.#view.tables.get(key), [...this.#view.seats.get(key)]]);
      if (before !== after) changed.push(key);
    }
    this.#view.time = this.#time;
    this.#stale.clear();
    return changed;
  }

  /** The next job of this kind fails with `error` before anything is sent (an RPC error, say). Queue them up. */
  failNext(kind, error, retryable = true) {
    if (!Object.hasOwn(JOB_KINDS, kind)) throw new RangeError(`unknown job kind: ${kind}`);
    if (!this.#failures.has(kind)) this.#failures.set(kind, []);
    this.#failures.get(kind).push({ error, retryable });
  }

  /** The next `count` events matching a type name or a predicate are never delivered. */
  loseEvents(match, count = 1) {
    const test = typeof match === 'function' ? match : (event) => event.type === match;
    this.#losses.push({ test, remaining: count });
  }

  // ---- test-only: other people's transactions ----------------------------------------------------------

  /**
   * A transaction from any account, executed now and mined in its own block. `kind` is a job kind or one of
   * deposit, setSessionKey, leave, withdraw, and `args` what it takes (see chain-port.js, plus `tableKey` for
   * createTable, start and startExitFromDeposits).
   * This is how a test plays a hostile or merely different party: a player starting an exit from an old
   * bundle, anyone challenging or finalising. Returns { ok: true } or { ok: false, error, args }.
   */
  send(sender, kind, args) {
    if (!Object.hasOwn(JOB_KINDS, kind) && !PLAYER_CALLS.includes(kind)) {
      throw new RangeError(`unknown call: ${kind}`);
    }
    return this.#tx(normalizeAddress(sender, 'sender'), kind, args);
  }

  /** Give an account tokens. */
  mint(account, amount) {
    this.#ledger.mint(normalizeAddress(account, 'account'), uint(amount, 'amount'));
  }

  /**
   * PokerVault.deposit from `player`. `confirmed: false` leaves the seat visible but below confirmation
   * depth (seat().confirmed is false until setConfirmed). Needs the tokens unless autoMint is on.
   */
  deposit(tableKey, player, amount, sessionKey, { confirmed = true } = {}) {
    return this.#tx(normalizeAddress(player, 'player'), 'deposit', {
      tableKey,
      amount,
      sessionKey,
      confirmed,
    });
  }

  setSessionKey(tableKey, player, sessionKey, { confirmed = true } = {}) {
    return this.#tx(normalizeAddress(player, 'player'), 'setSessionKey', {
      tableKey,
      sessionKey,
      confirmed,
    });
  }

  leave(tableKey, player) {
    return this.#tx(normalizeAddress(player, 'player'), 'leave', { tableKey });
  }

  withdraw(account, to) {
    return this.#tx(normalizeAddress(account, 'account'), 'withdraw', { to });
  }

  /** Flip whether a seat is at confirmation depth. The view shows it after the next tick. */
  setConfirmed(tableKey, player, confirmed) {
    const seat = this.#tables.get(tableKey.toLowerCase())?.seats.get(player.toLowerCase());
    if (!seat) throw new Error('no such seat');
    seat.confirmed = Boolean(confirmed);
  }

  /** The owner pauses or unpauses new tables, deposits and starts. */
  pause(paused) {
    this.#paused = Boolean(paused);
  }

  get paused() {
    return this.#paused;
  }

  /** The owner rotates the vault's arbiter. Tables that exist keep theirs. */
  setVaultArbiter(account) {
    this.#vaultArbiter = address(account, 'arbiter');
  }

  /** Make the token refuse transfers to `account`, so its payouts become withdrawable instead. */
  blacklist(account, blocked = true) {
    this.#ledger.block(normalizeAddress(account, 'account'), blocked);
  }

  get balances() {
    return this.#ledger;
  }

  get houseAddress() {
    return this.#house;
  }

  withdrawableOf(account) {
    return this.#withdrawable.get(normalizeAddress(account, 'account')) ?? 0n;
  }

  get totalLocked() {
    return this.#totalLocked;
  }

  /** The contract's solvency invariants. `ok` is false when any of them is broken. */
  invariants() {
    let escrowSum = 0n;
    let seatsMatch = true;
    for (const t of this.#tables.values()) {
      escrowSum += t.escrow;
      let deposits = 0n;
      for (const seat of t.seats.values()) deposits += seat.deposit;
      if (deposits !== t.escrow || BigInt(t.seats.size) !== BigInt(t.seated)) seatsMatch = false;
    }
    let withdrawableSum = 0n;
    for (const v of this.#withdrawable.values()) withdrawableSum += v;
    const vaultBalance = this.#ledger.vault;
    const ok =
      vaultBalance === this.#totalLocked &&
      this.#totalLocked === escrowSum + withdrawableSum &&
      seatsMatch &&
      this.#ledger.total === this.#ledger.minted;
    return {
      ok,
      vaultBalance,
      totalLocked: this.#totalLocked,
      escrowSum,
      withdrawableSum,
      seatsMatch,
    };
  }

  /** The live (not cached) row of a table with its seats, or null. */
  live(tableKey) {
    const t = this.#tables.get(tableKey.toLowerCase());
    return t ? { ...publicRow(t), seats: seatsOf(t) } : null;
  }

  /** Events emitted and not yet delivered. */
  get pending() {
    return [...this.#pending];
  }

  /** Keys of the jobs waiting for the next tick. */
  get queued() {
    return this.#queue.map((q) => q.job.key);
  }

  // ---- jobs -----------------------------------------------------------------------------------------

  #runJob(job) {
    const done = (outcome, extra = {}) => ({ key: job.key, kind: job.kind, outcome, ...extra });
    let prepared;
    try {
      prepared = this.#resolver.prepare({ ...job });
    } catch (error) {
      this.#failJob(job, 'PrepareFailed', true, [String(error?.message ?? error)]);
      return done('failed', { error: 'PrepareFailed' });
    }
    if (!prepared || typeof prepared.proceed !== 'boolean') {
      this.#failJob(job, 'PrepareFailed', false, ['resolver.prepare must return { proceed }']);
      return done('failed', { error: 'PrepareFailed' });
    }
    if (!prepared.proceed) {
      this.skipped.push({ key: job.key, kind: job.kind, reason: prepared.reason });
      return done('skipped', { reason: prepared.reason });
    }
    const injected = this.#failures.get(job.kind)?.shift();
    if (injected) {
      this.#failJob(job, injected.error, injected.retryable, []);
      return done('failed', { error: injected.error });
    }

    const args = { ...prepared.args, tableKey: job.tableKey };
    const claimed = String(
      (job.kind === JOB_KINDS.finalizeExit ? args.state?.tableId : args.bundle?.state?.tableId) ??
        job.tableKey,
    ).toLowerCase();
    if (claimed !== job.tableKey) {
      this.#failJob(job, 'JobTableMismatch', false, [claimed]);
      return done('failed', { error: 'JobTableMismatch' });
    }

    const sender = this.#info[JOB_SENDER[job.kind]];
    const result = this.#tx(sender, job.kind, args);
    this.sent.push({ key: job.key, kind: job.kind, sender, ok: result.ok, error: result.error });
    if (result.ok) return done('sent', { sender });
    this.#failJob(job, result.error, isRetryableRevert(result.error), result.args);
    return done('failed', { error: result.error });
  }

  #failJob(job, error, retryable, args) {
    this.#push({
      type: EVENT_TYPES.JobFailed,
      tableKey: job.tableKey,
      key: job.key,
      kind: job.kind,
      error,
      retryable,
      args,
    });
  }

  // ---- mining, events, the view -------------------------------------------------------------------------

  #mine() {
    this.#block += 1;
    this.#logIndex = 0;
  }

  #push(event) {
    this.#pending.push({ ...event, block: this.#block, logIndex: this.#logIndex++ });
  }

  #refresh(key) {
    const t = this.#tables.get(key);
    if (!t) return;
    this.#view.tables.set(key, publicRow(t));
    this.#view.seats.set(key, seatsOf(t));
  }

  #deliver() {
    const events = this.#pending.splice(0);
    const kept = [];
    const lostTables = new Set();
    for (const event of events) {
      const rule = this.#losses.find((r) => r.remaining > 0 && r.test(event));
      if (rule) {
        rule.remaining -= 1;
        this.lost.push(event);
        lostTables.add(event.tableKey);
      } else {
        kept.push(event);
      }
    }
    for (const event of kept) this.#stale.delete(event.tableKey);
    for (const key of lostTables) {
      if (!kept.some((e) => e.tableKey === key)) this.#stale.add(key);
    }
    for (const key of this.#tables.keys()) if (!this.#stale.has(key)) this.#refresh(key);
    this.#view.time = this.#time;

    let firstError = null;
    for (const event of kept) {
      this.delivered.push(event);
      for (const sink of [...this.#sinks]) {
        if (!this.#sinks.has(sink)) continue;
        try {
          sink(event);
        } catch (error) {
          firstError ??= error;
        }
      }
    }
    if (firstError) throw firstError;
    return kept.length;
  }

  // ---- the contract ---------------------------------------------------------------------------------

  #row(tableKey) {
    return this.#tables.get(tableKey) ?? blankRow();
  }

  // Runs one transaction. A revert changes nothing (every call checks before it writes), mines nothing and
  // emits nothing; a success mines one block and queues the logs in order.
  #tx(sender, kind, args) {
    const logs = [];
    try {
      this.#call(sender, kind, args ?? {}, logs);
    } catch (error) {
      if (error instanceof Revert) return { ok: false, error: error.error, args: error.args };
      throw error;
    }
    this.#mine();
    for (const log of logs) this.#push(log);
    return { ok: true };
  }

  #call(sender, kind, args, logs) {
    switch (kind) {
      case 'createTable':
        return this.#createTable(sender, args, logs);
      case 'deposit':
        return this.#deposit(sender, args, logs);
      case 'setSessionKey':
        return this.#setSessionKey(sender, args, logs);
      case 'leave':
        return this.#leave(sender, args, logs);
      case 'start':
        return this.#start(sender, args, logs);
      case 'settle':
        return this.#settle(sender, args, logs);
      case 'startExit':
        return this.#startExit(sender, args, logs);
      case 'startExitFromDeposits':
        return this.#startExitFromDeposits(sender, args, logs);
      case 'challenge':
        return this.#challenge(sender, args, logs);
      case 'finalizeExit':
        return this.#finalizeExit(sender, args, logs);
      case 'withdraw':
        return this.#withdraw(sender, args);
      default:
        throw new RangeError(`unknown call: ${kind}`);
    }
  }

  #whenNotPaused() {
    if (this.#paused) throw new Revert('EnforcedPause');
  }

  // _verify's table argument, as checkState wants it.
  #ctx(t) {
    return {
      domain: this.#domain,
      maxRakeBps: this.#info.maxRakeBps,
      sessionKeyOf: (player) => t.seats.get(player)?.sessionKey ?? null,
      table: {
        status: t.status,
        nonce: t.nonce,
        escrow: t.escrow,
        rakePaid: t.rakePaid,
        rosterHash: t.rosterHash,
        arbiter: t.arbiter,
      },
    };
  }

  #requireMemberOrArbiter(t, sender) {
    if (sender !== t.arbiter && (t.seats.get(sender)?.deposit ?? 0n) === 0n) {
      throw new Revert('NotMember');
    }
  }

  // Pays `to` from the vault, or credits `withdrawable` when the token refuses the transfer.
  #payout(logs, tableKey, to, amount) {
    if (amount === 0n) return;
    let pushed = true;
    try {
      this.#ledger.move(this.#info.vault, to, amount);
    } catch (error) {
      if (!(error instanceof Revert)) throw error;
      pushed = false;
    }
    if (pushed) this.#totalLocked -= amount;
    else this.#withdrawable.set(to, (this.#withdrawable.get(to) ?? 0n) + amount);
    logs.push({ type: EVENT_TYPES.Payout, tableKey, to, amount, pushed });
  }

  #createTable(sender, args, logs) {
    const tableKey = bytes32(args.tableKey, 'tableId');
    const maxPlayers = Number(uint(args.maxPlayers, 'maxPlayers', 255n));
    const minDeposit = uint(args.minDeposit, 'minDeposit');
    const maxDeposit = uint(args.maxDeposit, 'maxDeposit');
    this.#whenNotPaused();
    if (sender !== this.#vaultArbiter) throw new Revert('NotArbiter');
    if (this.#row(tableKey).status !== STATUS.None) throw new Revert('TableExists');
    if (tableKey === ZERO_HASH || maxPlayers < 2 || maxPlayers > MAX_TABLE_PLAYERS) {
      throw new Revert('BadTableParams');
    }
    if (minDeposit === 0n || minDeposit > maxDeposit) throw new Revert('BadTableParams');

    const t = blankRow();
    t.status = STATUS.Filling;
    t.arbiter = sender;
    t.maxPlayers = maxPlayers;
    t.minDeposit = minDeposit;
    t.maxDeposit = maxDeposit;
    this.#tables.set(tableKey, t);
    logs.push({
      type: EVENT_TYPES.TableCreated,
      tableKey,
      arbiter: sender,
      maxPlayers,
      minDeposit,
      maxDeposit,
    });
  }

  #deposit(sender, args, logs) {
    const tableKey = bytes32(args.tableKey, 'tableId');
    const amount = uint(args.amount, 'amount');
    const sessionKey = address(args.sessionKey, 'sessionKey');
    this.#whenNotPaused();
    const t = this.#row(tableKey);
    if (t.status !== STATUS.Filling) throw new Revert('WrongStatus', [t.status]);
    if (amount === 0n) throw new Revert('ZeroAmount');
    if (sessionKey === ZERO_ADDRESS) throw new Revert('BadSessionKey');

    const seat = t.seats.get(sender);
    const total = (seat?.deposit ?? 0n) + amount;
    if (total > UINT256_MAX) throw new Revert('Panic', [0x11n]);
    if (total < t.minDeposit || total > t.maxDeposit) throw new Revert('DepositOutOfRange');
    if (!seat && t.seated >= t.maxPlayers) throw new Revert('TableFull');
    if (this.#autoMint && this.#ledger.of(sender) < amount) {
      this.#ledger.mint(sender, amount - this.#ledger.of(sender));
    }
    this.#ledger.move(sender, this.#info.vault, amount); // reverts when the player is too poor

    if (!seat) t.seated += 1;
    t.seats.set(sender, { deposit: total, sessionKey, confirmed: args.confirmed !== false });
    t.escrow += amount;
    this.#totalLocked += amount;
    logs.push({ type: EVENT_TYPES.Deposited, tableKey, player: sender, amount, total, sessionKey });
  }

  #setSessionKey(sender, args, logs) {
    const tableKey = bytes32(args.tableKey, 'tableId');
    const sessionKey = address(args.sessionKey, 'sessionKey');
    const t = this.#row(tableKey);
    if (t.status !== STATUS.Filling) throw new Revert('WrongStatus', [t.status]);
    if (sessionKey === ZERO_ADDRESS) throw new Revert('BadSessionKey');
    const seat = t.seats.get(sender);
    if (!seat) throw new Revert('NoSeat');
    t.seats.set(sender, { ...seat, sessionKey, confirmed: args.confirmed !== false });
    logs.push({ type: EVENT_TYPES.SessionKeySet, tableKey, player: sender, sessionKey });
  }

  #leave(sender, args, logs) {
    const tableKey = bytes32(args.tableKey, 'tableId');
    const t = this.#row(tableKey);
    if (t.status !== STATUS.Filling) throw new Revert('WrongStatus', [t.status]);
    const amount = t.seats.get(sender)?.deposit ?? 0n;
    if (amount === 0n) throw new Revert('NoSeat');

    t.seats.delete(sender);
    t.seated -= 1;
    t.escrow -= amount;
    logs.push({ type: EVENT_TYPES.Left, tableKey, player: sender, amount });
    this.#payout(logs, tableKey, sender, amount);
  }

  #start(sender, args, logs) {
    const tableKey = bytes32(args.tableKey, 'tableId');
    const players = addresses(args.players, 'players');
    this.#whenNotPaused();
    const t = this.#row(tableKey);
    if (sender !== t.arbiter) throw new Revert('NotArbiter');
    if (t.status !== STATUS.Filling) throw new Revert('WrongStatus', [t.status]);
    const n = players.length;
    if (n < 2 || n !== t.seated) throw new Revert('BadRoster');
    let previous = ZERO_ADDRESS;
    for (const p of players) {
      // strictly ascending means distinct; distinct, funded and as many as are seated means exactly the seated set
      if (p <= previous || (t.seats.get(p)?.deposit ?? 0n) === 0n) throw new Revert('BadRoster');
      previous = p;
    }
    t.rosterHash = rosterHash(players);
    t.status = STATUS.Active;
    logs.push({ type: EVENT_TYPES.Started, tableKey, players });
  }

  #settle(_sender, args, logs) {
    const { state: s, sigs } = decodeBundle(args.bundle);
    const tableKey = s.tableId;
    const t = this.#row(tableKey);
    const checked = checkSettle(s, sigs, this.#ctx(t));
    if (!checked.ok) throw new Revert(checked.error, checked.args);

    const rakeDelta = s.rake - t.rakePaid;
    t.nonce = s.nonce;
    t.rakePaid = s.rake;
    t.status = STATUS.Filling;
    t.rosterHash = ZERO_HASH;
    t.exitDigest = ZERO_HASH;
    t.exitDeadline = 0;

    let kept = 0n;
    let stayers = 0;
    s.players.forEach((player, i) => {
      if (s.keep[i]) {
        t.seats.get(player).deposit = s.balances[i];
        kept += s.balances[i];
        stayers += 1;
      } else {
        t.seats.delete(player);
      }
    });
    t.escrow = kept;
    t.seated = stayers;

    logs.push({
      type: EVENT_TYPES.Settled,
      tableKey,
      nonce: s.nonce,
      rakePaid: s.rake,
      rakeDelta,
      stayers,
    });
    s.players.forEach((player, i) => {
      if (!s.keep[i]) this.#payout(logs, tableKey, player, s.balances[i]);
    });
    this.#payout(logs, tableKey, this.#house, rakeDelta);
  }

  #startExit(sender, args, logs) {
    const { state: s, sigs } = decodeBundle(args.bundle);
    const tableKey = s.tableId;
    const t = this.#row(tableKey);
    if (t.status !== STATUS.Active) throw new Revert('WrongStatus', [t.status]);
    this.#requireMemberOrArbiter(t, sender);
    const checked = checkState(s, sigs, this.#ctx(t));
    if (!checked.ok) throw new Revert(checked.error, checked.args);

    const deadline = this.#time + this.#info.exitWindowSec;
    t.status = STATUS.Exiting;
    t.nonce = s.nonce;
    t.exitDigest = checked.digest;
    t.exitDeadline = deadline;
    logs.push({
      type: EVENT_TYPES.ExitStarted,
      tableKey,
      by: sender,
      nonce: s.nonce,
      digest: checked.digest,
      deadline,
    });
  }

  #startExitFromDeposits(sender, args, logs) {
    const tableKey = bytes32(args.tableKey, 'tableId');
    const players = addresses(args.players, 'players');
    const t = this.#row(tableKey);
    if (t.status !== STATUS.Active) throw new Revert('WrongStatus', [t.status]);
    this.#requireMemberOrArbiter(t, sender);
    if (rosterHash(players) !== t.rosterHash) throw new Revert('RosterMismatch');

    const digest = hashState(
      depositState({
        tableId: tableKey,
        players,
        deposits: players.map((p) => t.seats.get(p).deposit),
        nonce: t.nonce,
        rake: t.rakePaid,
      }),
      this.#domain,
    );
    const deadline = this.#time + this.#info.exitWindowSec;
    t.status = STATUS.Exiting;
    t.exitDigest = digest;
    t.exitDeadline = deadline;
    logs.push({
      type: EVENT_TYPES.ExitStarted,
      tableKey,
      by: sender,
      nonce: t.nonce,
      digest,
      deadline,
    });
  }

  #challenge(sender, args, logs) {
    const { state: s, sigs } = decodeBundle(args.bundle);
    const tableKey = s.tableId;
    const t = this.#row(tableKey);
    if (t.status !== STATUS.Exiting) throw new Revert('WrongStatus', [t.status]);
    if (this.#time > t.exitDeadline) throw new Revert('ExitWindowClosed');
    const checked = checkState(s, sigs, this.#ctx(t));
    if (!checked.ok) throw new Revert(checked.error, checked.args);

    const deadline = this.#time + this.#info.exitWindowSec;
    t.nonce = s.nonce;
    t.exitDigest = checked.digest;
    t.exitDeadline = deadline;
    logs.push({
      type: EVENT_TYPES.Challenged,
      tableKey,
      by: sender,
      nonce: s.nonce,
      digest: checked.digest,
      deadline,
    });
  }

  #finalizeExit(_sender, args, logs) {
    const s = decodeAny(args.state);
    const tableKey = s.tableId;
    const t = this.#row(tableKey);
    if (t.status !== STATUS.Exiting) throw new Revert('WrongStatus', [t.status]);
    if (this.#time <= t.exitDeadline) throw new Revert('ExitWindowOpen');
    if (hashState(s, this.#domain) !== t.exitDigest) throw new Revert('DigestMismatch');

    // The next three cannot fire for a state whose digest matched (the exit only ever holds a state that
    // passed _verify, or the deposit state), but the contract repeats them and so does this.
    const n = s.players.length;
    if (s.balances.length !== n) throw new Revert('BadLength');
    if (s.rake < t.rakePaid) throw new Revert('RakeDecreased');
    const rakeDelta = s.rake - t.rakePaid;
    let sum = rakeDelta;
    for (const balance of s.balances) sum += balance;
    if (sum > UINT256_MAX) throw new Revert('Panic', [0x11n]);
    if (sum !== t.escrow) throw new Revert('NotConserved', [sum, t.escrow]);

    t.status = STATUS.Closed;
    t.rakePaid = s.rake;
    t.escrow = 0n;
    t.seated = 0;
    t.rosterHash = ZERO_HASH;
    t.exitDigest = ZERO_HASH;
    t.exitDeadline = 0;
    for (const player of s.players) t.seats.delete(player);

    logs.push({
      type: EVENT_TYPES.ExitFinalized,
      tableKey,
      nonce: s.nonce,
      rakePaid: s.rake,
      rakeDelta,
    });
    s.players.forEach((player, i) => {
      this.#payout(logs, tableKey, player, s.balances[i]);
    });
    this.#payout(logs, tableKey, this.#house, rakeDelta);
  }

  #withdraw(sender, args) {
    const to = address(args.to, 'to');
    const amount = this.#withdrawable.get(sender) ?? 0n;
    if (amount === 0n) throw new Revert('NothingToWithdraw');
    this.#ledger.move(this.#info.vault, to, amount); // may revert (blocked recipient): nothing changes then
    this.#withdrawable.set(sender, 0n);
    this.#totalLocked -= amount;
  }
}
