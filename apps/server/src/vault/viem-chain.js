// ViemChain: the ChainPort for anvil and real chains (docs/signing-layer.md section 4). It behaves like
// FakeChain from the coordinator's side, with the same row, seat and event shapes, so everything tested
// against the fake runs against a real PokerVault unchanged.
//
// Reads are synchronous and come from a cache. A table or seat asked for the first time is tracked and
// fetched in the background (null until then); refresh() re-reads everything tracked, which repairs a
// missed event. All chain I/O runs on a poll timer (real time: it is I/O, not a contract deadline):
//
//   1. read the head block (its timestamp is chainTime())
//   2. look up the receipts of transactions in flight; a receipt frees the job's key BEFORE the events go
//      out, so a handler may submit the same job again (FakeChain does the same)
//   3. fetch the vault's logs from the cursor (a bounded block range per poll), re-read the tables they
//      touch at the head block, THEN deliver the events in (block, logIndex) order, then the JobFailed
//      events. A handler that reads the chain sees at least the state its event describes.
//   4. start queued jobs: by JOB_PRIORITY, one transaction in flight per sender account. Each one goes
//      resolver.prepare -> simulate -> estimate gas -> send; the receipt is picked up by step 2 later.
//
// Logs are only fetched while someone is subscribed, so events emitted before runtime.start() subscribes
// wait at the cursor instead of being delivered to nobody.
//
// A stuck transaction is replaced, simply: after `stuckPolls` polls without a receipt it is sent again with
// the same account nonce and every fee 20% higher (a node needs at least +10% to accept a replacement), and
// again after the next `stuckPolls`, and so on. Every hash sent is watched, since the old one may still be
// mined. If the account nonce moves past ours and none of our hashes has a receipt, the job is released as
// a retryable 'TxDropped' failure.
//
// Not handled here (docs section 10): reorgs. The cursor never goes back, and logs marked `removed` are
// dropped. `confirmations` only decides seat().confirmed.
import { decodeState, normalizeAddress, pokerVaultAbi } from '@pgg/vault';
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  decodeEventLog,
  defineChain,
  Eip1559FeesNotSupportedError,
  encodeFunctionData,
  http,
  InsufficientFundsError,
  TransactionReceiptNotFoundError,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  assertJob,
  EVENT_TYPES,
  isRetryableRevert,
  JOB_KINDS,
  JOB_SENDER,
  statusName,
} from './chain-port.js';

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const KEEP_DELIVERED = 1000;
const KEEP_ALARMS = 200;
const lower = (value) => String(value).toLowerCase();
const message = (error) => String(error?.shortMessage ?? error?.message ?? error);

// The contract's event arguments in FakeChain's shapes: bigint amounts and nonces, numbers for counts and
// deadlines, lowercase addresses and hashes.
const EVENT_FIELDS = {
  TableCreated: (a) => ({
    arbiter: lower(a.arbiter),
    maxPlayers: Number(a.maxPlayers),
    minDeposit: a.minDeposit,
    maxDeposit: a.maxDeposit,
  }),
  Deposited: (a) => ({
    player: lower(a.player),
    amount: a.amount,
    total: a.total,
    sessionKey: lower(a.sessionKey),
  }),
  SessionKeySet: (a) => ({ player: lower(a.player), sessionKey: lower(a.sessionKey) }),
  Left: (a) => ({ player: lower(a.player), amount: a.amount }),
  Started: (a) => ({ players: a.players.map(lower) }),
  Settled: (a) => ({
    nonce: a.nonce,
    rakePaid: a.rakePaid,
    rakeDelta: a.rakeDelta,
    stayers: Number(a.stayers),
  }),
  ExitStarted: (a) => ({
    by: lower(a.by),
    nonce: a.nonce,
    digest: lower(a.digest),
    deadline: Number(a.deadline),
  }),
  Challenged: (a) => ({
    by: lower(a.by),
    nonce: a.nonce,
    digest: lower(a.digest),
    deadline: Number(a.deadline),
  }),
  ExitFinalized: (a) => ({ nonce: a.nonce, rakePaid: a.rakePaid, rakeDelta: a.rakeDelta }),
  Payout: (a) => ({ to: lower(a.to), amount: a.amount, pushed: a.pushed }),
};

/** A vault log as a ChainPort event, or null for the events the port does not carry (admin, Withdrawn). */
function eventFromLog(log) {
  let decoded;
  try {
    decoded = decodeEventLog({ abi: pokerVaultAbi, data: log.data, topics: log.topics });
  } catch {
    return null;
  }
  const fields = EVENT_FIELDS[decoded.eventName];
  if (!fields) return null;
  return {
    type: EVENT_TYPES[decoded.eventName],
    tableKey: lower(decoded.args.tableId),
    ...fields(decoded.args),
    block: Number(log.blockNumber),
    logIndex: Number(log.logIndex),
  };
}

// tables(id) as viem returns it: [status, maxPlayers, seated, arbiter, nonce, exitDeadline, minDeposit,
// maxDeposit, escrow, rakePaid, rosterHash, exitDigest]. Status None is "no table", like FakeChain.
function rowFrom(raw) {
  const [status, maxPlayers, seated, arbiter, nonce, exitDeadline] = raw;
  const [minDeposit, maxDeposit, escrow, rakePaid, rosterHash, exitDigest] = raw.slice(6);
  if (Number(status) === 0) return null;
  return Object.freeze({
    status: statusName(Number(status)),
    nonce,
    escrow,
    rakePaid,
    rosterHash: lower(rosterHash),
    exitDeadline: Number(exitDeadline),
    exitDigest: lower(exitDigest),
    arbiter: lower(arbiter),
    seated: Number(seated),
    maxPlayers: Number(maxPlayers),
    minDeposit,
    maxDeposit,
  });
}

/**
 * The contract's own words for a refusal: { error, args } decoded with the vault ABI, or null when the
 * error is not a revert (an RPC or network failure).
 */
export function revertOf(error) {
  if (!(error instanceof BaseError)) return null;
  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (reverted?.data?.errorName) {
    return { error: reverted.data.errorName, args: [...(reverted.data.args ?? [])] };
  }
  const raw = error.walk((e) => typeof e?.data === 'string' && /^0x[0-9a-fA-F]{8}/.test(e.data));
  if (raw) {
    try {
      const decoded = decodeErrorResult({ abi: pokerVaultAbi, data: raw.data });
      return { error: decoded.errorName, args: [...(decoded.args ?? [])] };
    } catch {
      return { error: 'UnknownRevert', args: [raw.data] };
    }
  }
  if (reverted) return { error: 'UnknownRevert', args: [reverted.signature ?? ''] };
  return null;
}

// What a failed simulation, estimate or send means for the job: a contract refusal is final unless the
// contract says it will pass by itself (paused, window still open); anything else is the RPC and retryable.
function classify(error) {
  const revert = revertOf(error);
  if (revert) return { ...revert, retryable: isRetryableRevert(revert.error) };
  if (error instanceof BaseError && error.walk((e) => e instanceof InsufficientFundsError)) {
    return { error: 'InsufficientFunds', retryable: true, args: [message(error)] };
  }
  return { error: 'RpcError', retryable: true, args: [message(error)] };
}

const bump = (fees) =>
  Object.fromEntries(Object.entries(fees).map(([name, wei]) => [name, (wei * 12n) / 10n + 1n]));

// The contract call for a job: (State, arbiterSig, playerSigs) for a bundle, the State alone for
// finalizeExit, and the job's tableKey for the calls that take a tableId.
function callFor(job, args) {
  const bundleCall = () => {
    const bundle = args?.bundle;
    if (!bundle || typeof bundle !== 'object') throw new TypeError('args.bundle is missing');
    const { arbiterSig, playerSigs } = bundle;
    if (typeof arbiterSig !== 'string' || !Array.isArray(playerSigs)) {
      throw new TypeError('the bundle needs arbiterSig and playerSigs');
    }
    const state = decodeState(bundle.state);
    return { tableId: state.tableId, args: [state, arbiterSig, [...playerSigs]] };
  };
  const players = () => {
    if (!Array.isArray(args?.players)) throw new TypeError('args.players is missing');
    return args.players.map((p, i) => normalizeAddress(p, `players[${i}]`));
  };
  switch (job.kind) {
    case JOB_KINDS.createTable:
      return {
        tableId: job.tableKey,
        args: [job.tableKey, args.maxPlayers, args.minDeposit, args.maxDeposit],
      };
    case JOB_KINDS.start:
    case JOB_KINDS.startExitFromDeposits:
      return { tableId: job.tableKey, args: [job.tableKey, players()] };
    case JOB_KINDS.settle:
    case JOB_KINDS.startExit:
    case JOB_KINDS.challenge:
      return bundleCall();
    case JOB_KINDS.finalizeExit: {
      const state = decodeState(args?.state);
      return { tableId: state.tableId, args: [state] };
    }
    default:
      throw new TypeError(`unknown job kind: ${job.kind}`);
  }
}

class ViemChain {
  #info;
  #vault;
  #client;
  #wallet;
  #viemChain;
  #pollMs;
  #confirmations;
  #maxRange;
  #stuckPolls;
  #minGasWei;
  #onAlarm;

  #head = { number: 0n, timestamp: 0 };
  #cursor; // the next block whose logs are fetched
  #lastPos = { block: -1, logIndex: -1 }; // the last position delivered

  #tracked = new Set();
  #known = new Map(); // tableKey -> Set of seat addresses
  #rows = new Map(); // tableKey -> { row, at }
  #seats = new Map(); // tableKey -> Map(address -> { seat, at })
  #wantTables = new Set();
  #wantSeats = new Map(); // tableKey -> Set of addresses
  #fetching = null;
  #fetchAgain = false;

  #queue = [];
  #held = new Set(); // keys queued or running
  #seq = 0;
  #lanes = new Map(); // sender address -> { account, inflight }
  #roles; // 'arbiter' | 'relayer' -> lane
  #failures = []; // JobFailed events waiting for the next delivery
  #resolver = null;
  #sinks = new Set();

  #timer = null;
  #serial = Promise.resolve();
  #closed = false;
  #noResolverNoted = false;

  /** Every event handed to subscribers, in order (the last KEEP_DELIVERED). */
  delivered = [];
  /** Jobs the resolver declined: { key, kind, reason }. */
  skipped = [];
  /** { key, kind, sender, nonce, hash, fees } for every transaction sent, replacements included. */
  sent = [];
  /** { kind, detail, at } for everything reported to onAlarm, newest last. */
  alarms = [];

  constructor(setup) {
    this.#info = setup.info;
    this.#vault = setup.info.vault;
    this.#client = setup.client;
    this.#wallet = setup.wallet;
    this.#viemChain = setup.viemChain;
    this.#pollMs = setup.pollMs;
    this.#confirmations = setup.confirmations;
    this.#maxRange = setup.maxBlockRange;
    this.#stuckPolls = setup.stuckPolls;
    this.#minGasWei = setup.minGasWei;
    this.#onAlarm = setup.onAlarm;
    this.#head = setup.head;
    this.#cursor = setup.fromBlock;
    this.#lastPos = { block: Number(setup.fromBlock) - 1, logIndex: -1 };
    this.#roles = {};
    for (const [role, account] of Object.entries(setup.accounts)) {
      const address = lower(account.address);
      // one lane per ACCOUNT: the same key in both roles must still send one transaction at a time
      if (!this.#lanes.has(address)) this.#lanes.set(address, { account, inflight: null });
      this.#roles[role] = this.#lanes.get(address);
    }
    this.#schedule();
  }

  // ---- ChainPort ------------------------------------------------------------------------------------

  get info() {
    return this.#info;
  }

  table(tableKey) {
    const key = lower(tableKey);
    if (!BYTES32.test(key)) return null;
    this.#track(key);
    return this.#rows.get(key)?.row ?? null;
  }

  seat(tableKey, account) {
    const key = lower(tableKey);
    const address = lower(account);
    if (!BYTES32.test(key) || !ADDRESS.test(address)) return null;
    this.#track(key);
    const known = this.#knownOf(key);
    if (!known.has(address)) {
      known.add(address);
      this.#want(key, address);
      this.#kickFetch();
    }
    const seat = this.#seats.get(key)?.get(address)?.seat;
    return seat ? { ...seat } : null;
  }

  chainTime() {
    return this.#head.timestamp;
  }

  submit(job) {
    assertJob(job);
    if (this.#closed || this.#held.has(job.key)) return false;
    this.#held.add(job.key);
    this.#queue.push({ job: { ...job }, seq: this.#seq++ });
    return true;
  }

  subscribe(sink) {
    if (typeof sink !== 'function') throw new TypeError('sink must be a function');
    this.#sinks.add(sink);
    return () => this.#sinks.delete(sink);
  }

  // ---- adapter controls -----------------------------------------------------------------------------

  setResolver(resolver) {
    if (!resolver || typeof resolver.prepare !== 'function') {
      throw new TypeError('resolver must have prepare(job)');
    }
    this.#resolver = resolver;
  }

  set resolver(resolver) {
    this.setResolver(resolver);
  }

  /** Track a table: returns a promise of its row once the first read is done (null when there is none). */
  track(tableKey) {
    const key = lower(tableKey);
    if (!BYTES32.test(key)) throw new TypeError('tableKey must be 32 bytes of 0x hex');
    this.#track(key);
    return this.#kickFetch().then(() => this.#rows.get(key)?.row ?? null);
  }

  /**
   * Re-read every tracked table and its known seats at the head block, and check the senders' gas.
   * Synchronous for the caller (the runtime calls it from a timer); the promise says whether it worked
   * and never rejects.
   */
  refresh() {
    if (this.#closed) return Promise.resolve(false);
    const run = async () => {
      const head = await this.#client.getBlock({ blockTag: 'latest' });
      this.#setHead(head);
      const seats = [];
      for (const key of this.#tracked) {
        for (const address of this.#knownOf(key)) seats.push([key, address]);
      }
      await this.#readInto(new Set(this.#tracked), seats, head.number);
      await this.#checkGas();
      return true;
    };
    return run().catch((error) => {
      this.#alarm('rpc-error', { step: 'refresh', error: message(error) });
      return false;
    });
  }

  /** Run one poll now, after any poll in progress. Resolves when it is done; never rejects. */
  poll() {
    this.#serial = this.#serial.then(() => this.#pollOnce());
    return this.#serial;
  }

  /** Stop the timer. Nothing is delivered or sent afterwards; resolves once a running poll has ended. */
  close() {
    this.#closed = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    return this.#serial;
  }

  get closed() {
    return this.#closed;
  }

  /** Keys of the jobs waiting for a lane. */
  get queued() {
    return this.#queue.map((q) => q.job.key);
  }

  /** The transactions waiting for a receipt: [{ key, kind, sender, nonce, hashes }]. */
  get inflight() {
    const out = [];
    for (const [sender, lane] of this.#lanes) {
      const f = lane.inflight;
      if (f)
        out.push({
          key: f.job.key,
          kind: f.job.kind,
          sender,
          nonce: f.nonce,
          hashes: [...f.hashes],
        });
    }
    return out;
  }

  /** The next block whose logs will be fetched. */
  get cursor() {
    return this.#cursor;
  }

  // ---- the poll -------------------------------------------------------------------------------------

  #schedule() {
    if (this.#closed) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.poll().then(() => this.#schedule());
    }, this.#pollMs);
  }

  async #pollOnce() {
    if (this.#closed) return;
    try {
      const head = await this.#client.getBlock({ blockTag: 'latest' });
      this.#setHead(head);
      const lanes = [...this.#lanes.values()];
      await Promise.all(lanes.map((lane) => this.#checkLane(lane)));
      await this.#catchUp(head.number);
      await Promise.all(lanes.map((lane) => this.#runLane(lane)));
    } catch (error) {
      // nothing past the failed step happened (the cursor did not move): the next poll tries again
      this.#alarm('rpc-error', { step: 'poll', error: message(error) });
    }
  }

  #setHead(block) {
    if (block.number < this.#head.number) return;
    this.#head = { number: block.number, timestamp: Number(block.timestamp) };
  }

  async #catchUp(headNumber) {
    const events = [];
    let to = this.#cursor - 1n;
    if (this.#sinks.size > 0 && this.#cursor <= headNumber) {
      const last = this.#cursor + BigInt(this.#maxRange) - 1n;
      to = last < headNumber ? last : headNumber;
      const logs = await this.#client.getLogs({
        address: this.#vault,
        fromBlock: this.#cursor,
        toBlock: to,
      });
      for (const log of logs) {
        if (log.removed) continue;
        const event = eventFromLog(log);
        if (event) events.push(event);
      }
      events.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
    }

    // re-read what the events touched (and what is still waiting for a first read) before delivering
    const tables = new Set(this.#wantTables);
    const seats = [];
    for (const [key, addresses] of this.#wantSeats) {
      for (const address of addresses) seats.push([key, address]);
    }
    for (const event of events) {
      if (!this.#tracked.has(event.tableKey)) continue;
      tables.add(event.tableKey);
      const known = this.#knownOf(event.tableKey);
      for (const player of event.players ?? (event.player ? [event.player] : [])) known.add(player);
    }
    for (const key of tables) {
      for (const address of this.#knownOf(key)) seats.push([key, address]);
    }
    for (const [key, byAddress] of this.#seats) {
      for (const [address, entry] of byAddress) {
        if (entry.seat && !entry.seat.confirmed) seats.push([key, address]);
      }
    }
    await this.#readInto(tables, seats, headNumber);

    if (this.#sinks.size === 0) return;
    this.#cursor = to + 1n;
    for (const event of events) this.#deliver(event);
    // JobFailed is not a log: it sorts after everything delivered so far, at the last block fully read
    const failures = this.#failures.splice(0);
    for (const failure of failures) {
      const block = Math.max(this.#lastPos.block, Number(to));
      const logIndex = block === this.#lastPos.block ? this.#lastPos.logIndex + 1 : 0;
      this.#deliver({ ...failure, block, logIndex });
    }
  }

  #deliver(event) {
    if (this.#closed) return;
    this.#lastPos = { block: event.block, logIndex: event.logIndex };
    this.delivered.push(event);
    if (this.delivered.length > KEEP_DELIVERED) this.delivered.shift();
    for (const sink of [...this.#sinks]) {
      if (!this.#sinks.has(sink)) continue;
      try {
        sink(event);
      } catch (error) {
        // one broken subscriber must not starve the others or stop the poll
        this.#alarm('subscriber-error', { type: event.type, error: message(error) });
      }
    }
  }

  // ---- the cache ------------------------------------------------------------------------------------

  #track(key) {
    if (this.#tracked.has(key)) return;
    this.#tracked.add(key);
    this.#wantTables.add(key);
    this.#kickFetch();
  }

  #knownOf(key) {
    if (!this.#known.has(key)) this.#known.set(key, new Set());
    return this.#known.get(key);
  }

  #want(key, address) {
    if (!this.#wantSeats.has(key)) this.#wantSeats.set(key, new Set());
    this.#wantSeats.get(key).add(address);
  }

  // First reads happen at once, not at the next poll; they never deliver anything.
  #kickFetch() {
    if (this.#fetching) {
      this.#fetchAgain = true;
      return this.#fetching;
    }
    const run = async () => {
      do {
        this.#fetchAgain = false;
        if (this.#closed) return;
        const tables = new Set(this.#wantTables);
        const seats = [];
        for (const [key, addresses] of this.#wantSeats) {
          for (const address of addresses) seats.push([key, address]);
        }
        if (tables.size === 0 && seats.length === 0) return;
        await this.#readInto(tables, seats, this.#head.number);
      } while (this.#fetchAgain);
    };
    this.#fetching = run()
      .catch((error) => this.#alarm('rpc-error', { step: 'fetch', error: message(error) }))
      .finally(() => {
        this.#fetching = null;
      });
    return this.#fetching;
  }

  // Reads every table and seat at one block, then applies them all. An entry already read at a later
  // block is not overwritten, so a slow first read cannot undo a newer poll.
  async #readInto(tables, seats, blockNumber) {
    const [rows, seatRows] = await Promise.all([
      Promise.all([...tables].map((key) => this.#readTable(key, blockNumber))),
      Promise.all(seats.map(([key, address]) => this.#readSeat(key, address, blockNumber))),
    ]);
    [...tables].forEach((key, i) => {
      const entry = this.#rows.get(key);
      if (!entry || entry.at <= blockNumber) this.#rows.set(key, { row: rows[i], at: blockNumber });
      this.#wantTables.delete(key);
    });
    seats.forEach(([key, address], i) => {
      if (!this.#seats.has(key)) this.#seats.set(key, new Map());
      const byAddress = this.#seats.get(key);
      const entry = byAddress.get(address);
      if (!entry || entry.at <= blockNumber) {
        byAddress.set(address, { seat: seatRows[i], at: blockNumber });
      }
      this.#wantSeats.get(key)?.delete(address);
    });
  }

  #read(functionName, args, blockNumber) {
    return this.#client.readContract({
      address: this.#vault,
      abi: pokerVaultAbi,
      functionName,
      args,
      blockNumber,
    });
  }

  async #readTable(key, blockNumber) {
    return rowFrom(await this.#read('tables', [key], blockNumber));
  }

  async #readSeat(key, address, blockNumber) {
    const [deposit, sessionKey] = await this.#read('seats', [key, address], blockNumber);
    if (deposit === 0n) return null;
    const seat = { deposit, sessionKey: lower(sessionKey), confirmed: true };
    if (this.#confirmations > 1) {
      // confirmed: the seat as it is now was already there `confirmations` blocks ago
      const deep = blockNumber - BigInt(this.#confirmations - 1);
      seat.confirmed = false;
      if (deep >= 0n) {
        try {
          const [oldDeposit, oldKey] = await this.#read('seats', [key, address], deep);
          seat.confirmed = oldDeposit === deposit && lower(oldKey) === seat.sessionKey;
        } catch {
          // before the vault existed: not deep enough
        }
      }
    }
    return Object.freeze(seat);
  }

  async #checkGas() {
    for (const [sender, lane] of this.#lanes) {
      const balance = await this.#client.getBalance({ address: lane.account.address });
      if (balance < this.#minGasWei) this.#alarm('low-gas', { sender, balance });
    }
  }

  // ---- jobs -----------------------------------------------------------------------------------------

  #release(key) {
    this.#held.delete(key);
  }

  #fail(job, error, retryable, args = []) {
    this.#release(job.key);
    this.#failures.push({
      type: EVENT_TYPES.JobFailed,
      tableKey: job.tableKey,
      key: job.key,
      kind: job.kind,
      error,
      retryable,
      args,
    });
  }

  #takeNext(lane) {
    let best = -1;
    this.#queue.forEach(({ job, seq }, i) => {
      if (this.#roles[JOB_SENDER[job.kind]] !== lane) return;
      const top = this.#queue[best];
      if (
        best < 0 ||
        job.priority > top.job.priority ||
        (job.priority === top.job.priority && seq < top.seq)
      ) {
        best = i;
      }
    });
    return best < 0 ? null : this.#queue.splice(best, 1)[0].job;
  }

  async #runLane(lane) {
    while (!lane.inflight && !this.#closed) {
      if (!this.#resolver) {
        if (this.#queue.length > 0 && !this.#noResolverNoted) {
          this.#noResolverNoted = true;
          this.#alarm('no-resolver', { queued: this.queued });
        }
        return;
      }
      const job = this.#takeNext(lane);
      if (!job) return;
      await this.#execute(job, lane);
    }
  }

  async #execute(job, lane) {
    let prepared;
    try {
      prepared = this.#resolver.prepare({ ...job });
    } catch (error) {
      this.#fail(job, 'PrepareFailed', true, [message(error)]);
      return;
    }
    if (!prepared || typeof prepared.proceed !== 'boolean') {
      this.#fail(job, 'PrepareFailed', false, ['resolver.prepare must return { proceed }']);
      return;
    }
    if (!prepared.proceed) {
      this.skipped.push({ key: job.key, kind: job.kind, reason: prepared.reason });
      this.#release(job.key);
      return;
    }

    let call;
    let data;
    try {
      call = callFor(job, prepared.args);
      data = encodeFunctionData({ abi: pokerVaultAbi, functionName: job.kind, args: call.args });
    } catch (error) {
      this.#fail(job, 'Malformed', false, [message(error)]);
      return;
    }
    if (lower(call.tableId) !== job.tableKey) {
      this.#fail(job, 'JobTableMismatch', false, [lower(call.tableId)]);
      return;
    }

    const account = lane.account;
    const request = {
      address: this.#vault,
      abi: pokerVaultAbi,
      functionName: job.kind,
      args: call.args,
      account,
    };
    try {
      // simulate first: a refusal costs nothing and comes back with the contract's error name
      await this.#client.simulateContract(request);
      const estimate = await this.#client.estimateContractGas(request);
      const gas = (estimate * 12n) / 10n; // headroom: the estimate is exact for the state it ran on
      const fees = await this.#fees();
      const nonce = await this.#client.getTransactionCount({
        address: account.address,
        blockTag: 'pending',
      });
      if (this.#closed) {
        this.#release(job.key);
        return;
      }
      const hash = await this.#send(account, { data, gas, nonce, fees });
      lane.inflight = { job, request, data, gas, nonce, fees, hashes: [hash], polls: 0 };
      const sender = lower(account.address);
      this.sent.push({ key: job.key, kind: job.kind, sender, nonce, hash, fees });
    } catch (error) {
      const failure = classify(error);
      if (failure.error === 'InsufficientFunds') {
        this.#alarm('low-gas', { sender: lower(account.address), error: message(error) });
      }
      this.#fail(job, failure.error, failure.retryable, failure.args);
    }
  }

  #send(account, { data, gas, nonce, fees }) {
    return this.#wallet.sendTransaction({
      account,
      chain: this.#viemChain,
      to: this.#vault,
      data,
      gas,
      nonce,
      ...fees,
    });
  }

  async #fees() {
    try {
      const { maxFeePerGas, maxPriorityFeePerGas } = await this.#client.estimateFeesPerGas();
      return { maxFeePerGas, maxPriorityFeePerGas };
    } catch (error) {
      if (!(error instanceof Eip1559FeesNotSupportedError)) throw error;
      return { gasPrice: await this.#client.getGasPrice() };
    }
  }

  async #receiptOf(inflight) {
    for (const hash of inflight.hashes) {
      try {
        return await this.#client.getTransactionReceipt({ hash });
      } catch (error) {
        if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
      }
    }
    return null;
  }

  async #checkLane(lane) {
    const f = lane.inflight;
    if (!f) return;
    try {
      let receipt = await this.#receiptOf(f);
      if (!receipt) {
        f.polls += 1;
        if (f.polls < this.#stuckPolls) return;
        f.polls = 0;
        const mined = await this.#client.getTransactionCount({
          address: f.request.account.address,
          blockTag: 'latest',
        });
        if (mined > f.nonce) {
          // our nonce is used up: one of our hashes was mined just now, or something else took the nonce
          receipt = await this.#receiptOf(f);
          if (!receipt) {
            lane.inflight = null;
            this.#fail(f.job, 'TxDropped', true, [...f.hashes]);
            return;
          }
        } else {
          f.fees = bump(f.fees);
          const hash = await this.#send(f.request.account, f);
          f.hashes.push(hash);
          const sender = lower(f.request.account.address);
          this.sent.push({
            key: f.job.key,
            kind: f.job.kind,
            sender,
            nonce: f.nonce,
            hash,
            fees: f.fees,
          });
          this.#alarm('tx-replaced', { key: f.job.key, nonce: f.nonce, hash });
          return;
        }
      }
      lane.inflight = null;
      if (receipt.status === 'success') {
        this.#release(f.job.key);
        return;
      }
      // mined but reverted (someone moved the table between our simulation and the block): run it again
      // on the state after that block to learn the contract's reason
      let failure = { error: 'TxReverted', retryable: true, args: [receipt.transactionHash] };
      try {
        await this.#client.simulateContract({ ...f.request, blockNumber: receipt.blockNumber });
      } catch (error) {
        failure = classify(error);
      }
      this.#fail(f.job, failure.error, failure.retryable, failure.args);
    } catch (error) {
      this.#alarm('rpc-error', { step: 'receipt', key: f.job.key, error: message(error) });
    }
  }

  #alarm(kind, detail = null) {
    this.alarms.push({ kind, detail, at: Date.now() });
    if (this.alarms.length > KEEP_ALARMS) this.alarms.shift();
    try {
      this.#onAlarm?.(kind, detail);
    } catch {
      // an alarm handler that throws must not take the poll down with it
    }
  }
}

/**
 * Connect to a PokerVault and return its ChainPort (plus close, refresh, setResolver, track and poll).
 *
 * @param {{ rpcUrl: string, vault: string, arbiterKey: string, relayerKey: string, pollMs?: number,
 *   confirmations?: number, chainId?: number, onAlarm?: (kind: string, detail: object) => void,
 *   fromBlock?: bigint | number, maxBlockRange?: number, stuckPolls?: number, minGasWei?: bigint }} options
 *   fromBlock      first block whose logs are delivered (default: the head at creation). Pass the vault's
 *                  deployment block (or a persisted cursor) to replay history after a restart.
 *   maxBlockRange  blocks per eth_getLogs call (default 1000)
 *   stuckPolls     polls without a receipt before a transaction is re-sent with higher fees (default 5)
 *   minGasWei      below this a sender's balance raises a 'low-gas' alarm on refresh() (default 0.01 ETH)
 *
 * Reads the chain id, MAX_RAKE_BPS, EXIT_WINDOW and the vault's arbiter first, and refuses to start when the
 * arbiter key is not the vault's arbiter (or chainId is given and differs).
 */
export async function createViemChain({
  rpcUrl,
  vault,
  arbiterKey,
  relayerKey,
  pollMs = 1000,
  confirmations = 0,
  chainId,
  onAlarm,
  fromBlock,
  maxBlockRange = 1000,
  stuckPolls = 5,
  minGasWei = 10n ** 16n,
} = {}) {
  if (typeof rpcUrl !== 'string' || rpcUrl === '') throw new TypeError('rpcUrl is required');
  const vaultAddress = normalizeAddress(vault, 'vault');
  const arbiter = privateKeyToAccount(arbiterKey);
  const relayer = privateKeyToAccount(relayerKey);
  if (!Number.isSafeInteger(pollMs) || pollMs <= 0) throw new TypeError('pollMs must be positive');
  if (!Number.isSafeInteger(confirmations) || confirmations < 0) {
    throw new TypeError('confirmations must be a whole number');
  }
  if (!Number.isSafeInteger(maxBlockRange) || maxBlockRange <= 0) {
    throw new TypeError('maxBlockRange must be positive');
  }
  if (!Number.isSafeInteger(stuckPolls) || stuckPolls <= 0) {
    throw new TypeError('stuckPolls must be positive');
  }

  const transport = http(rpcUrl);
  const probe = createPublicClient({ transport });
  const id = await probe.getChainId();
  if (chainId !== undefined && chainId !== id) {
    throw new Error(`ViemChain: the RPC is chain ${id}, not ${chainId}`);
  }
  const viemChain = defineChain({
    id,
    name: `chain-${id}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const client = createPublicClient({ chain: viemChain, transport, cacheTime: 0 });
  const wallet = createWalletClient({ chain: viemChain, transport });

  const read = (functionName) =>
    client.readContract({ address: vaultAddress, abi: pokerVaultAbi, functionName });
  const [vaultArbiter, maxRakeBps, exitWindow, head] = await Promise.all([
    read('arbiter'),
    read('MAX_RAKE_BPS'),
    read('EXIT_WINDOW'),
    client.getBlock({ blockTag: 'latest' }),
  ]);
  if (lower(vaultArbiter) !== lower(arbiter.address)) {
    throw new Error(
      `ViemChain: the arbiter key is ${lower(arbiter.address)} but the vault's arbiter is ${lower(vaultArbiter)}`,
    );
  }

  return new ViemChain({
    info: Object.freeze({
      chainId: id,
      vault: vaultAddress,
      arbiter: lower(arbiter.address),
      relayer: lower(relayer.address),
      maxRakeBps: Number(maxRakeBps),
      exitWindowSec: Number(exitWindow),
    }),
    client,
    wallet,
    viemChain,
    accounts: { arbiter, relayer },
    pollMs,
    confirmations,
    maxBlockRange,
    stuckPolls,
    minGasWei,
    onAlarm,
    head: { number: head.number, timestamp: Number(head.timestamp) },
    fromBlock: fromBlock === undefined ? head.number : BigInt(fromBlock),
  });
}
