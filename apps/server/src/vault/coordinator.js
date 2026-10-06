// VaultCoordinator: one per vault table. It turns hand results into signed States, collects every member's
// signature, keeps the newest all-signed bundle durable, and walks the table through its epochs on the chain
// (docs/signing-layer.md sections 1 to 7). The TableActor calls it synchronously and never awaits: chain I/O
// happens in the background (jobs resolved at execution time, events back through onChainEvent) and time
// comes only from the injected clock, so an NTP step cannot fire an exit early.
//
// The epoch machine (record.phase; 'halted' is an overlay, see #halt):
//
//   creating --TableCreated--> filling --(all depositors claimed, >= 2, startHoldMs)--> starting --Started--> active
//   active --(round past deadline, or gate closed absentGraceMs)--> stalled --(late sigs, members back)--> active
//   active/stalled --(stallExitMs more)--> stall exit --ExitStarted--> exiting --(settle of a final)--> filling
//   exiting --finalizeExit--> closed --> generation + 1, a new tableKey, creating
//   active --(final bundle complete)--> settling --Settled--> filling   (stayers carry their balance over)
//   settling --ExitStarted at or above the final's nonce--> exiting
//
// Everything is LEVEL-TRIGGERED: #sync() compares the record with the cached chain row on every tick, event,
// claim and boot, so a lost event costs a tick, never a table. Events only bring the facts a row cannot show
// (who deposited, when a key was registered, the roster of Started).
//
// The arbiter's order is reserve, sign (signReserved), attach, send. Nothing is sent before the store holds
// what the message depends on, bundle(n) always goes out before signreq(n+1), and saveBundle + the phase +
// the settle job are one transaction.
//
// host (provided by the TableActor; every method optional):
//   send(playerId, msg)                 a private message
//   publishStatus()                     publicView() changed; republish the table
//   unseat(address, { reason, chips })  the member's chips left the table on chain (Settled, Left, closed)
//   scheduleStart()                     the deal gate may have opened
//   rekey(oldPlayerId, newPlayerId, address)
//                                       a newer valid claim moved this seat to another player id
//   inHand()                            true while a hand is being played (between deal and onHandEnd)
//   seatOf(address)                     the actor's seat number for an address, for publicView().awaiting
import { ERR, SERVER } from '@pgg/protocol/constants';
import {
  buildNextState,
  checkState,
  dealBlocker,
  depositState,
  epochBaseline,
  hashState,
  makeBundle,
  normalizeAddress,
  normalizeState,
  rosterHash,
  serverMayCoSign,
  tableFromChain,
  tableKeyFor,
  toChips,
  toTokenUnits,
  toWire,
  verifyClaim,
} from '@pgg/vault';
import {
  EVENT_TYPES,
  JOB_KINDS,
  makeJob,
  makeJobKey,
  statusName,
  TABLE_STATUS,
} from './chain-port.js';
import { keyExpiring, rotationDecision } from './policy.js';
import { ALARMS, nextChainAction, stallAction } from './reconcile.js';
import { SignRound } from './round.js';
import { DoubleSignError } from './store.js';
import { POLICY_DEFAULTS } from './vault-config.js';

/**
 * Why a table halts, and what that means:
 *   fatal    no automatic way back (an operator looks); otherwise retried after retryDelayMs
 *   persist  written to the table record, so a restart stays halted (a restart cannot fix it)
 *   exit     the stall exit still runs after stallExitMs: the newest all-signed bundle (or the deposits) is
 *            always a fair way out, and players have no self-exit UI yet. Off where the store itself is
 *            not trustworthy (behind the chain, another config, another arbiter): an exit from an old
 *            state would undo hands nobody can challenge for them.
 */
export const HALTS = Object.freeze({
  'double-sign': { fatal: true, persist: true, exit: true },
  'not-conserved': { fatal: true, persist: true, exit: true },
  'bundle-conflict': { fatal: true, persist: true, exit: true },
  'bundle-invalid': { fatal: true, persist: true, exit: true },
  'check-failed': { fatal: true, persist: true, exit: true },
  'key-expired': { fatal: true, persist: true, exit: true },
  'session-key-shared': { fatal: true, persist: true, exit: true },
  'bad-snapshot': { fatal: true, persist: true, exit: true },
  'hand-while-round-open': { fatal: true, persist: true, exit: true },
  'hand-after-final': { fatal: true, persist: true, exit: true },
  'epoch-start-mismatch': { fatal: true, persist: true, exit: true },
  'unknown-roster': { fatal: true, persist: true, exit: false },
  'exit-digest-mismatch': { fatal: true, persist: true, exit: false },
  'store-behind-chain': { fatal: true, persist: true, exit: false },
  'settled-unknown-final': { fatal: true, persist: true, exit: false },
  'table-missing': { fatal: true, persist: true, exit: false },
  'pinned-changed': { fatal: true, persist: false, exit: false },
  'wrong-arbiter': { fatal: true, persist: false, exit: false },
  // a thrown error or a failing store: in-memory only, because a restart re-reads the store and recovers
  'hand-end-failed': { fatal: true, persist: false, exit: false },
  'internal-error': { fatal: true, persist: false, exit: false },
  'stale-chain-cache': { fatal: false, persist: false, exit: false },
});

// Halts that freeze the epoch machine itself: the store or the config cannot be trusted to drive it.
const FROZEN = new Set(['pinned-changed', 'wrong-arbiter', 'init-failed']);

const fail = (code, msg) => ({ ok: false, code, msg });
const LOCKED = Object.freeze(fail(ERR.VAULT_LOCKED, 'the vault table is not available'));

const sum = (list) => list.reduce((a, b) => a + b, 0n);
const isCount = (n) => Number.isSafeInteger(n) && n >= 0;
const json = (value) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? `${v}n` : v));

function comparePositions(a, b) {
  const blocks = BigInt(a.block) - BigInt(b.block);
  if (blocks !== 0n) return blocks < 0n ? -1 : 1;
  return Math.sign(Number(a.logIndex) - Number(b.logIndex));
}

function nonceFrom(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value)) return BigInt(value);
  return null;
}

export class VaultCoordinator {
  #cfg;
  #policy;
  #store;
  #chain;
  #signer;
  #clock;
  #host;
  #domain;
  #unit;

  #rec = null; // the table record as the store last returned it
  #k = null; // its tableKey
  #members = new Map(); // address -> { address, playerId, claimedKey, online, seat, idleHands }
  #byPlayer = new Map(); // playerId -> address
  #round = null; // the SignRound being collected, or null
  #outbox = []; // { address, msg }, sent by flush()
  #halt = null; // { cause, fatal, exit, at, detail, retryAt }
  #pending = null; // a proposal waiting for its one retry after a stale-cache halt
  #gateClosedSince = null;
  #fillingSince = null;
  #notBefore = new Map(); // job kind -> clock time before which it is not queued again
  #failures = new Map(); // job kind -> consecutive failures
  #sentAt = new Map(); // job key -> when we first saw it sent
  #seenFailed = new Map(); // job key -> the failure already counted
  #rebinds = new Map(); // address -> clock times of recent re-binds
  #alarms = [];
  #status = '';
  #syncing = false;

  /**
   * @param {{ cfg: object, store: object, chain: object, signer: object, clock: object, host?: object }} deps
   *   cfg  { id, serverId, numSeats, chipUnit (bigint), rakeBps, smallBlind, bigBlind, minBuyIn, maxBuyIn,
   *          policy?, drain? }   (parseVaultConfig builds it)
   */
  constructor({ cfg, store, chain, signer, clock, host = {} }) {
    if (!cfg || typeof cfg.id !== 'string' || typeof cfg.serverId !== 'string') {
      throw new TypeError('cfg needs id and serverId');
    }
    if (typeof cfg.chipUnit !== 'bigint' || cfg.chipUnit <= 0n) {
      throw new TypeError('cfg.chipUnit must be a positive bigint');
    }
    for (const [name, dep, method] of [
      ['store', store, 'saveTable'],
      ['chain', chain, 'table'],
      ['signer', signer, 'signReserved'],
      ['clock', clock, 'now'],
    ]) {
      if (!dep || typeof dep[method] !== 'function') throw new TypeError(`${name} is required`);
    }
    this.#cfg = cfg;
    this.#policy = { ...POLICY_DEFAULTS, ...(cfg.policy ?? {}) };
    this.#store = store;
    this.#chain = chain;
    this.#signer = signer;
    this.#clock = clock;
    this.#host = host ?? {};
    this.#unit = cfg.chipUnit;
    this.#domain = {
      chainId: chain.info.chainId,
      verifyingContract: normalizeAddress(chain.info.vault),
    };
  }

  // ---- observability (read-only) -------------------------------------------------------------------

  get tableKey() {
    return this.#k;
  }

  /** The phase as published: 'halted' while a halt is in force, else the epoch machine's phase. */
  get phase() {
    if (this.#halt || !this.#rec) return 'halted';
    return this.#rec.phase;
  }

  get halt() {
    return this.#halt ? { ...this.#halt } : null;
  }

  get alarms() {
    return [...this.#alarms];
  }

  // ---- the actor's interface ------------------------------------------------------------------------

  /**
   * Load, reconcile with the chain, resume or recover (section 5). Never throws: a failure halts the table.
   */
  init() {
    this.#guarded('init', () => this.#boot());
    this.#afterChange();
  }

  /**
   * A member proves, with the seat's session key, which on-chain seat this player id holds (section 3).
   * Checks run cheapest first (F12). Returns { ok: true, address, chips } or { ok: false, code, msg }.
   */
  claim(playerId, { address, sig } = {}) {
    const result = this.#guarded('claim', () => this.#claim(playerId, address, sig), LOCKED);
    this.#afterChange();
    return result;
  }

  /**
   * A member's signature for a signreq. Late or duplicate: { ok: true }, silently. Verified by recovering
   * over the digest THIS server reserved for the nonce; the client's digest is a consistency check only.
   */
  sign(playerId, { nonce, digest, sig } = {}) {
    const result = this.#guarded('sign', () => this.#sign(playerId, nonce, digest, sig), LOCKED);
    this.#afterChange();
    return result;
  }

  /**
   * A hand ended (call BEFORE the actor reconciles its roster). Builds, checks, reserves and signs the next
   * state and queues the signreqs; flush() sends them once the actor has published. Never throws.
   *   snapshot { handNo, result: { pot, rake }, entries: [{ address, chips, leaving, connected, status, seat? }] }
   */
  onHandEnd(snapshot) {
    this.#guarded('hand-end', () => this.#handEnd(snapshot));
    // the actor publishes right after this, so the status it shows already includes the round
    this.#status = this.#statusKey();
  }

  /** Send what onHandEnd (or anything else) queued. */
  flush() {
    this.#guarded('flush', () => this.#flushOutbox());
  }

  /**
   * A member asked to leave. Acknowledges with the head nonce (the client's leaveAckNonce): a state at or
   * below it may still keep them, anything later will not. Returns { ok: true, head } or { ok: false, code }.
   */
  requestLeave(playerId) {
    const result = this.#guarded('leave', () => this.#requestLeave(playerId), LOCKED);
    this.#afterChange();
    return result;
  }

  /** Resend the epoch, the newest bundle, then the open signreq. */
  onConnect(playerId) {
    this.#guarded('connect', () => {
      const member = this.#memberOf(playerId);
      if (!member) return;
      member.online = true;
      this.#resendTo(member.address);
    });
    this.#afterChange();
  }

  onDisconnect(playerId) {
    this.#guarded('disconnect', () => {
      const member = this.#memberOf(playerId);
      if (member) member.online = false;
    });
    this.#afterChange();
  }

  /** S1: true only when the next hand may be dealt. Side-effect free. */
  canDeal() {
    try {
      if (!this.#rec || this.#halt || this.#rec.phase !== 'active') return false;
      if (this.#round?.isLive) return false;
      if (this.#rotationDue()) return false;
      return dealBlocker(this.#gateView()) === null;
    } catch {
      return false;
    }
  }

  /** TableState.vault: { epoch, phase, nonce, awaiting (seats), deadline }. */
  publicView() {
    const rec = this.#rec;
    if (!rec) return { epoch: 0, phase: 'halted', nonce: '0', awaiting: [], deadline: null };
    const live = this.#round?.isLive ? this.#round : null;
    return {
      epoch: Number(rec.epoch),
      phase: this.phase,
      nonce: String(this.#head() ?? rec.epochBaseNonce),
      awaiting: this.#awaitingSeats(),
      deadline: live ? live.deadline : null,
    };
  }

  onChainEvent(event) {
    this.#guarded('event', () => this.#event(event));
    this.#afterChange();
  }

  /** The periodic tick: timers, resends, stall exits, retries, chain actions. */
  tick() {
    this.#guarded('tick', () => {
      if (!this.#rec) return;
      const now = this.#clock.now();
      this.#retryHalt(now);
      this.#sync();
      this.#stallTick(now);
    });
    this.#afterChange();
  }

  // ---- plumbing -------------------------------------------------------------------------------------

  #guarded(label, fn, fallback = undefined) {
    try {
      return fn();
    } catch (error) {
      if (error instanceof DoubleSignError || error?.code === 'double-sign') {
        this.#haltWith('double-sign', { error });
      } else if (label === 'init') {
        this.#haltWith('init-failed', { error });
      } else {
        this.#haltWith(label === 'hand-end' ? 'hand-end-failed' : 'internal-error', { error });
      }
      return fallback;
    }
  }

  // After anything that may have changed what the table can do: reconcile, propose what is due, open the
  // gate, send, publish. Each step is guarded on its own, so one failure cannot hide the others.
  #afterChange() {
    this.#guarded('sync', () => {
      this.#sync();
      this.#maybeProposeBetweenHands();
    });
    this.#guarded('gate', () => {
      if (this.canDeal()) this.#hostCall('scheduleStart');
    });
    this.#guarded('flush', () => this.#flushOutbox());
    const key = this.#statusKey();
    if (key !== this.#status) {
      this.#status = key;
      this.#hostCall('publishStatus');
    }
  }

  #statusKey() {
    try {
      return json(this.publicView());
    } catch {
      return '';
    }
  }

  #hostCall(method, ...args) {
    const fn = this.#host?.[method];
    if (typeof fn !== 'function') return method === 'inHand' ? false : undefined;
    try {
      return fn.apply(this.#host, args);
    } catch (error) {
      this.#alarm('host-error', { method, error: String(error?.message ?? error) });
      return method === 'inHand' ? true : undefined; // an unknown hand state is treated as "in a hand"
    }
  }

  #inHand() {
    return this.#hostCall('inHand') === true;
  }

  #alarm(kind, detail = null) {
    this.#alarms.push({ kind, detail, at: this.#clock.now() });
    if (this.#alarms.length > 200) this.#alarms.splice(0, this.#alarms.length - 200);
  }

  #save(changes) {
    this.#rec = this.#store.saveTable({ ...this.#rec, ...changes, updatedAt: this.#clock.now() });
    return this.#rec;
  }

  #row() {
    const raw = this.#k ? this.#chain.table(this.#k) : null;
    return raw ? { ...raw, status: statusName(raw.status) } : null;
  }

  #pinned() {
    const c = this.#cfg;
    return {
      chipUnit: c.chipUnit,
      blinds: { small: c.smallBlind, big: c.bigBlind },
      rakeBps: c.rakeBps,
      numSeats: c.numSeats,
    };
  }

  #haltWith(cause, { detail = null, error = null } = {}) {
    const spec = HALTS[cause] ?? { fatal: true, persist: false, exit: false };
    const now = this.#clock.now();
    const text = detail ?? (error ? String(error?.message ?? error) : null);
    this.#halt = {
      cause,
      fatal: spec.fatal,
      exit: spec.exit,
      at: now,
      detail: text,
      retryAt: spec.fatal ? null : now + this.#policy.retryDelayMs,
    };
    this.#alarm('halt', { cause, detail: text });
    if (spec.persist && this.#rec) {
      try {
        this.#save({ halt: { cause, detail: text } });
      } catch {
        // the halt is in force in memory; a store that cannot take this write is failing anyway
      }
    }
  }

  // ---- boot (section 5) -----------------------------------------------------------------------------

  #freshRecord(generation) {
    const c = this.#cfg;
    return {
      tableKey: tableKeyFor({
        chainId: this.#domain.chainId,
        vault: this.#domain.verifyingContract,
        serverId: c.serverId,
        generation,
      }),
      serverId: c.serverId,
      tableId: c.id,
      generation,
      epoch: 0,
      phase: 'creating',
      pinned: this.#pinned(),
      limits: {
        minDeposit: toTokenUnits(c.minBuyIn, this.#unit),
        maxDeposit: toTokenUnits(c.maxBuyIn, this.#unit),
      },
      roster: null,
      sessionKeys: null,
      base: null,
      depositors: [],
      keyTimes: {},
      leaving: [],
      epochBaseNonce: 0n,
      nonceHw: 0n,
      rakeCum: 0n,
      volumeCum: 0n,
      rakePaid: 0n,
      dust: {},
      lastAppliedEvent: null,
      // chain time before any deposit at this tableKey: the oldest a session key here can be
      createdAt: this.#chain.chainTime(),
      epochStartedAt: null,
      roundMeta: null,
      stallExit: null,
      exit: null,
      halt: null,
      drain: this.#cfg.drain === true,
    };
  }

  #adopt(record) {
    this.#rec = record;
    this.#k = record.tableKey;
  }

  #boot() {
    const mine = this.#store.listTables().filter((r) => r.serverId === this.#cfg.serverId);
    let record = null;
    for (const r of mine) {
      if (record === null || BigInt(r.generation) > BigInt(record.generation)) record = r;
    }
    if (!record) record = this.#store.saveTable(this.#freshRecord(1));
    this.#adopt(record);

    // A changed unit silently changes everyone's chip count: refuse to resume rather than guess.
    if (json(record.pinned) !== json(this.#pinned())) {
      this.#haltWith('pinned-changed', {
        detail: `stored ${json(record.pinned)}, configured ${json(this.#pinned())}`,
      });
      return;
    }
    const row = this.#row();
    const arbiter = normalizeAddress(this.#signer.address);
    if (
      (row ? normalizeAddress(row.arbiter) : normalizeAddress(this.#chain.info.arbiter)) !== arbiter
    ) {
      this.#haltWith('wrong-arbiter');
      return;
    }
    if ((this.#cfg.drain === true) !== (record.drain === true))
      this.#save({ drain: this.#cfg.drain === true });
    if (record.halt) {
      const spec = HALTS[record.halt.cause] ?? { exit: false };
      this.#halt = {
        cause: record.halt.cause,
        fatal: true,
        exit: spec.exit,
        at: this.#clock.now(),
        detail: record.halt.detail ?? null,
        retryAt: null,
      };
    }
    // F10: a restored old database must never propose at a nonce the chain has already passed
    if (row && row.nonce > this.#rec.nonceHw && !this.#halt) this.#haltWith('store-behind-chain');

    this.#placeholders();
    this.#recoverRound();
    // a stall decided before the restart stands only while the round that stalled is still the open one;
    // a closed gate restarts its clock (everyone has to re-claim anyway)
    const stall = this.#rec.stallExit;
    if (stall && (stall.nonce === null || stall.nonce !== this.#round?.nonce)) {
      this.#save({ stallExit: null });
    }
    // a job marked sent before the crash may never have left: let the reconciler decide again
    for (const job of this.#store.pendingJobs()) {
      if (job.tableKey === this.#k && job.status === 'sent') {
        this.#store.markJob(job.key, 'failed', { error: 'restarted' });
      }
    }
    this.#sync();
  }

  // Step 5: the roster comes back as placeholders. Nobody is claimed until they claim again.
  #placeholders() {
    this.#members.clear();
    this.#byPlayer.clear();
    for (const address of this.#rec.roster ?? this.#rec.depositors ?? []) this.#addMember(address);
  }

  #addMember(address) {
    let member = this.#members.get(address);
    if (!member) {
      member = {
        address,
        playerId: null,
        claimedKey: null,
        online: false,
        seat: null,
        idleHands: 0,
      };
      this.#members.set(address, member);
    }
    return member;
  }

  // Steps 1 to 3: re-sign a reserved state (RFC 6979 gives the same bytes), complete a round whose
  // signatures are all stored, re-issue an open one verbatim with a fresh deadline. Step 4 (the hand in
  // flight) needs nothing: it was never reserved, and chips come from the highest reserved state.
  #recoverRound() {
    if (!this.#rec.base) return;
    const open = this.#store.openRound(this.#k);
    if (!open) return;
    let { arbiterSig } = open;
    if (arbiterSig === null) {
      arbiterSig = this.#signer.signReserved(this.#k, open.nonce);
      this.#store.attachArbiterSig(this.#k, open.nonce, arbiterSig);
    }
    const meta = this.#rec.roundMeta;
    const mine = meta && BigInt(meta.nonce) === open.nonce;
    this.#round = new SignRound({
      state: open.state,
      digest: open.digest,
      arbiterSig,
      sessionKeys: this.#rec.sessionKeys,
      reason: mine ? meta.reason : open.state.isFinal ? 'maintenance' : 'hand',
      handNo: mine ? (meta.handNo ?? null) : null,
      openedAt: this.#clock.now(),
      timing: this.#policy,
      playerSigs: open.playerSigs,
    });
    if (this.#round.isComplete) this.#completeRound();
  }

  // ---- the epoch machine (level-triggered) ----------------------------------------------------------

  #sync() {
    if (!this.#rec || this.#syncing) return;
    if (this.#halt && FROZEN.has(this.#halt.cause)) return;
    this.#syncing = true;
    try {
      for (let i = 0; i < 6 && this.#step(); i++) {
        // a transition can enable the next one (creating -> filling -> starting)
      }
      this.#watch();
      this.#pumpJobs();
    } finally {
      this.#syncing = false;
    }
  }

  // One transition, if the chain row says one is due. Returns true when the phase changed.
  #step() {
    const phase = this.#rec.phase;
    if (phase === 'closed') {
      this.#nextGeneration();
      return true;
    }
    const row = this.#row();
    const fresh = phase === 'creating' || phase === 'filling' || phase === 'starting';
    switch (row?.status ?? null) {
      case null:
        if (phase === 'creating') {
          this.#ensureJob(JOB_KINDS.createTable);
          return false;
        }
        // the record says the table exists and the chain has none (a reorg took createTable away):
        // with nothing signed start over, otherwise stop
        if (this.#rec.nonceHw === 0n && !this.#rec.base) {
          this.#save({ phase: 'creating', depositors: [], roster: null });
          return true;
        }
        if (this.#halt?.cause !== 'table-missing') this.#haltWith('table-missing');
        return false;
      case TABLE_STATUS.Filling:
        if (phase === 'creating') {
          this.#save({ phase: 'filling' });
          this.#fillingSince = this.#clock.now();
          return true;
        }
        if (phase === 'filling') return this.#maybeStart(row);
        if (phase === 'starting') return this.#checkStarting();
        return this.#applySettled(row);
      case TABLE_STATUS.Active:
        return fresh ? this.#enterActive(row, null, null) : false;
      case TABLE_STATUS.Exiting:
        if (fresh) return this.#enterActive(row, null, null);
        if (phase === 'active' || phase === 'stalled') return this.#enterExiting(row);
        if (phase === 'settling') {
          // a member front-ran our settle with an exit at or above the final: keep is ignored now
          const final = this.#store.loadBundle(this.#k);
          if (!final?.state.isFinal || row.nonce >= final.state.nonce)
            return this.#enterExiting(row);
          return false;
        }
        if (phase === 'exiting') this.#trackExit(row);
        return false;
      case TABLE_STATUS.Closed:
        return this.#applyClosed(row);
      default:
        return false;
    }
  }

  // The reconciler (section 4): the same decision the watchtower makes, from the store and the chain row.
  #watch() {
    const row = this.#row();
    if (!row) return;
    let action;
    try {
      action = nextChainAction({
        tableKey: this.#k,
        chainRow: row,
        store: this.#storeView(),
        chainTime: this.#chain.chainTime(),
        challengeMarginSec: this.#policy.challengeMarginSec,
        depositDigest: this.#depositDigest(row),
      });
    } catch (error) {
      this.#alarm('reconcile-error', String(error?.message ?? error));
      return;
    }
    if (!action) return;
    if (action.alarm) {
      this.#alarm(action.alarm);
      if (action.alarm === ALARMS.exitDigestMismatch && !this.#halt?.fatal) {
        this.#haltWith('exit-digest-mismatch');
      } else if (action.alarm === ALARMS.chainNonceAboveBundle && !this.#halt?.fatal) {
        this.#haltWith('store-behind-chain');
      }
      return;
    }
    this.#ensureJob(action.kind);
  }

  #storeView() {
    return {
      epochBaseNonce: this.#rec.epochBaseNonce,
      bundle: this.#store.loadBundle(this.#k),
      finalBundle: this.#store.loadFinalBundle(this.#k),
    };
  }

  #depositDigest(row) {
    const { roster, base } = this.#rec;
    if (!roster || !base) return undefined;
    return hashState(
      depositState({
        tableId: this.#k,
        players: roster,
        deposits: base.balances,
        nonce: this.#rec.epochBaseNonce,
        rake: row.rakePaid,
      }),
      this.#domain,
    );
  }

  #maybeStart(row) {
    if (this.#halt || this.#rec.drain) return false;
    const now = this.#clock.now();
    if (now < (this.#notBefore.get(JOB_KINDS.start) ?? -Infinity)) return false;
    if (this.#startBlocker(row, now) !== null) return false;
    const roster = [...this.#rec.depositors].sort();
    this.#store.transaction(() => {
      this.#save({ phase: 'starting', roster });
      this.#store.enqueueJob(makeJob(JOB_KINDS.start, this.#k));
    });
    return true;
  }

  /** Why the table cannot start now (null when it can). */
  #startBlocker(row, now) {
    const depositors = this.#rec.depositors.filter(
      (a) => (this.#chain.seat(this.#k, a)?.deposit ?? 0n) > 0n,
    );
    if (depositors.length < 2) return 'too-few';
    if (row.seated !== depositors.length) return 'depositor-unknown';
    if (now < (this.#fillingSince ?? now) + this.#policy.startHoldMs) return 'hold';
    const arbiter = normalizeAddress(this.#signer.address);
    const keys = new Set();
    for (const address of depositors) {
      const seat = this.#chain.seat(this.#k, address);
      if (seat.confirmed === false) return 'unconfirmed';
      const member = this.#members.get(address);
      if (!member || !this.#isClaimed(member)) return 'not-claimed';
      const key = normalizeAddress(seat.sessionKey);
      if (key === arbiter || keys.has(key)) return 'session-key-shared';
      keys.add(key);
      if (keyExpiring(this.#keyAgeMs(address), this.#policy)) return 'key-expiring';
    }
    return null;
  }

  #checkStarting() {
    const job = this.#store.getJob(makeJobKey(JOB_KINDS.start, this.#k));
    if (job && (job.status === 'pending' || job.status === 'sent')) return false;
    // the start was declined or failed: back to filling, where the conditions are checked again
    this.#save({ phase: 'filling', roster: null });
    return true;
  }

  #enterActive(row, players, at) {
    let roster = players ?? this.#rec.roster;
    if (!roster || rosterHash(roster) !== row.rosterHash) {
      const guess = [...this.#rec.depositors].sort();
      if (guess.length >= 2 && rosterHash(guess) === row.rosterHash) roster = guess;
      else {
        this.#haltWith('unknown-roster');
        return false;
      }
    }
    roster = roster.map((a) => normalizeAddress(a));
    const seats = roster.map((p) => this.#chain.seat(this.#k, p));
    if (seats.some((s) => !s || s.deposit <= 0n)) {
      this.#haltWith('unknown-roster');
      return false;
    }
    // The epoch base IS the chain's nonce: anything we reserved above it never reached the chain, and a
    // base below it would let us sign at a nonce clients may already hold.
    if (this.#rec.nonceHw !== row.nonce) {
      this.#haltWith('epoch-start-mismatch', {
        detail: `store ${this.#rec.nonceHw}, chain ${row.nonce}`,
      });
      return false;
    }
    const deposits = seats.map((s) => s.deposit);
    const sessionKeys = seats.map((s) => normalizeAddress(s.sessionKey));
    // F7: the baseline carries the cumulative volume of the final that closed the last epoch (the
    // highest state the store holds), never 0 after a rollover
    const base = epochBaseline({
      tableId: this.#k,
      players: roster,
      deposits,
      nonce: row.nonce,
      rake: row.rakePaid,
      volume: this.#rec.volumeCum,
    });
    const dust = Object.fromEntries(roster.map((p, i) => [p, deposits[i] % this.#unit]));
    const changes = {
      phase: 'active',
      epoch: Number(this.#rec.epoch) + 1,
      roster,
      sessionKeys,
      base,
      epochBaseNonce: row.nonce,
      rakePaid: row.rakePaid,
      dust,
      depositors: roster,
      epochStartedAt: this.#chain.chainTime(),
      leaving: this.#rec.leaving.filter((a) => roster.includes(a)),
      roundMeta: null,
      stallExit: null,
      exit: null,
    };
    if (at) changes.lastAppliedEvent = at;
    this.#save(changes);
    for (const address of [...this.#members.keys()]) {
      if (!roster.includes(address)) this.#dropMember(address);
    }
    for (const address of roster) this.#addMember(address);
    this.#gateClosedSince = null;
    // One key on two seats, or the arbiter's key on a seat, would let one signature serve for two.
    // The start job refuses such a roster; if the chain started one anyway, nothing is signed for it.
    const arbiter = normalizeAddress(this.#signer.address);
    if (new Set(sessionKeys).size !== sessionKeys.length || sessionKeys.includes(arbiter)) {
      this.#haltWith('session-key-shared');
    }
    for (const address of roster) this.#queue(address, this.#epochMessage());
    return true;
  }

  #enterExiting(row) {
    this.#save({
      phase: 'exiting',
      exit: { nonce: row.nonce, digest: row.exitDigest, deadline: row.exitDeadline },
      stallExit: null,
    });
    this.#gateClosedSince = null;
    return true;
  }

  // A challenge moves the exit: remember what it holds now, so the payout can be named at Closed.
  #trackExit(row) {
    const exit = this.#rec.exit;
    if (exit && exit.nonce === row.nonce && exit.digest === row.exitDigest) return;
    this.#save({ exit: { nonce: row.nonce, digest: row.exitDigest, deadline: row.exitDeadline } });
  }

  #applySettled(row) {
    const final = [this.#store.loadBundle(this.#k), this.#store.loadFinalBundle(this.#k)].find(
      (b) => b?.state.isFinal && b.state.nonce === row.nonce,
    );
    if (!final) {
      if (this.#halt?.cause !== 'settled-unknown-final') this.#haltWith('settled-unknown-final');
      return false;
    }
    this.#abandonRound();
    const { players, keep, balances } = final.state;
    const stayers = players.filter((_, i) => keep[i]);
    this.#save({
      phase: 'filling',
      epochBaseNonce: row.nonce,
      rakePaid: row.rakePaid,
      roster: null,
      sessionKeys: null,
      base: null,
      depositors: stayers,
      leaving: [],
      dust: {},
      roundMeta: null,
      stallExit: null,
      exit: null,
    });
    players.forEach((address, i) => {
      if (!keep[i]) this.#unseat(address, 'settled', balances[i]);
    });
    for (const member of this.#members.values()) member.idleHands = 0;
    this.#fillingSince = this.#clock.now();
    this.#pending = null;
    if (this.#halt && !this.#halt.fatal) this.#halt = null;
    return true;
  }

  #applyClosed(row) {
    const state = this.#exitState(row);
    this.#abandonRound();
    this.#save({ phase: 'closed', stallExit: null });
    for (const address of [...this.#members.keys()]) {
      const i = state ? state.players.indexOf(address) : -1;
      this.#unseat(address, 'closed', i >= 0 ? state.balances[i] : 0n);
    }
    return true;
  }

  // The state an exit paid out: matched by the exit's digest when we saw it, else the signed state at the
  // exit's nonce, else the deposit state.
  #exitState(row) {
    const { exit, roster, base } = this.#rec;
    const nonce = exit?.nonce ?? row.nonce;
    const candidates = [];
    const bundle = this.#store.loadBundle(this.#k);
    if (bundle) candidates.push(bundle.state);
    const signed = this.#store.getSigned(this.#k, nonce);
    if (signed) candidates.push(signed.state);
    if (roster && base) {
      candidates.push(
        depositState({
          tableId: this.#k,
          players: roster,
          deposits: base.balances,
          nonce: this.#rec.epochBaseNonce,
          rake: this.#rec.rakePaid,
        }),
      );
    }
    if (exit?.digest) {
      return candidates.find((s) => hashState(s, this.#domain) === exit.digest) ?? null;
    }
    return candidates.find((s) => s.nonce === nonce) ?? null;
  }

  #nextGeneration() {
    const generation = Number(this.#rec.generation) + 1;
    this.#adopt(this.#store.saveTable(this.#freshRecord(generation)));
    this.#members.clear();
    this.#byPlayer.clear();
    this.#round = null;
    this.#pending = null;
    this.#gateClosedSince = null;
    this.#fillingSince = null;
    if (this.#halt && !FROZEN.has(this.#halt.cause)) this.#halt = null;
  }

  // ---- jobs -----------------------------------------------------------------------------------------

  #ensureJob(kind) {
    const now = this.#clock.now();
    if (now < (this.#notBefore.get(kind) ?? -Infinity)) return;
    this.#store.enqueueJob(makeJob(kind, this.#k));
  }

  // Hand every queued job of this table to the chain (idempotent by key), notice the ones whose effect is
  // on chain, give up on a sent job whose effect never shows, and back off after a failure.
  #pumpJobs() {
    const row = this.#row();
    const now = this.#clock.now();
    for (const job of this.#store.pendingJobs()) {
      if (job.tableKey !== this.#k) continue;
      if (job.status === 'pending') {
        this.#chain.submit(makeJob(job.kind, job.tableKey));
      } else if (job.status === 'sent') {
        if (this.#effectVisible(job.kind, row)) {
          this.#store.markJob(job.key, 'done');
          this.#failures.delete(job.kind);
          this.#notBefore.delete(job.kind);
          this.#sentAt.delete(job.key);
        } else {
          const at = this.#sentAt.get(job.key) ?? now;
          this.#sentAt.set(job.key, at);
          if (now - at > this.#policy.jobStaleMs) {
            this.#store.markJob(job.key, 'failed', { error: 'no-effect' });
            this.#sentAt.delete(job.key);
          }
        }
      } else if (job.status === 'failed') {
        const tag = `${job.attempts}:${job.error}`;
        if (this.#seenFailed.get(job.key) !== tag) {
          this.#seenFailed.set(job.key, tag);
          this.#backoff(job.kind);
        }
      }
    }
  }

  #backoff(kind) {
    const n = (this.#failures.get(kind) ?? 0) + 1;
    this.#failures.set(kind, n);
    const delay = Math.min(
      this.#policy.retryBackoffMs * 2 ** Math.min(n - 1, 20),
      this.#policy.maxBackoffMs,
    );
    this.#notBefore.set(kind, this.#clock.now() + delay);
  }

  #effectVisible(kind, row) {
    if (!row) return false;
    switch (kind) {
      case JOB_KINDS.createTable:
        return true;
      case JOB_KINDS.start:
        return row.status !== TABLE_STATUS.Filling;
      case JOB_KINDS.settle: {
        const final = this.#store.loadFinalBundle(this.#k);
        return (
          row.status === TABLE_STATUS.Filling ||
          row.status === TABLE_STATUS.Closed ||
          (final !== null && row.nonce >= final.state.nonce)
        );
      }
      case JOB_KINDS.startExit:
      case JOB_KINDS.startExitFromDeposits:
        return row.status !== TABLE_STATUS.Active;
      case JOB_KINDS.challenge: {
        const bundle = this.#store.loadBundle(this.#k);
        return row.status !== TABLE_STATUS.Exiting || row.nonce >= (bundle?.state.nonce ?? 0n);
      }
      case JOB_KINDS.finalizeExit:
        return row.status === TABLE_STATUS.Closed;
      default:
        return false;
    }
  }

  #jobFailed(event) {
    const job = this.#store.getJob(event.key);
    if (job && job.tableKey === this.#k && job.status !== 'done') {
      this.#store.markJob(event.key, 'failed', { error: String(event.error) });
      const after = this.#store.getJob(event.key);
      this.#seenFailed.set(event.key, `${after.attempts}:${after.error}`);
    }
    this.#backoff(event.kind);
    this.#alarm('job-failed', {
      kind: event.kind,
      error: String(event.error),
      retryable: event.retryable,
    });
    // A paused vault (EnforcedPause) is retried with back-off, not a halt (section 4); any refusal of a
    // start sends the table back to filling, where the roster is read again.
    if (event.kind === JOB_KINDS.start && this.#rec.phase === 'starting') {
      this.#save({ phase: 'filling', roster: null });
    }
  }

  // ---- members, keys, claims ------------------------------------------------------------------------

  #memberOf(playerId) {
    const address = this.#byPlayer.get(playerId);
    return address === undefined ? null : (this.#members.get(address) ?? null);
  }

  #dropMember(address) {
    const member = this.#members.get(address);
    if (!member) return;
    this.#members.delete(address);
    if (member.playerId !== null && this.#byPlayer.get(member.playerId) === address) {
      this.#byPlayer.delete(member.playerId);
    }
  }

  #unseat(address, reason, balance) {
    this.#dropMember(address);
    let chips = 0;
    try {
      chips = toChips(balance, this.#unit).chips;
    } catch {
      chips = 0;
    }
    this.#hostCall('unseat', address, { reason, chips });
  }

  /** The session key of an epoch member, fixed for the epoch (the chain cannot change it while Active). */
  #epochKey(address) {
    const i = this.#rec.roster?.indexOf(address) ?? -1;
    return i >= 0 ? (this.#rec.sessionKeys?.[i] ?? null) : null;
  }

  /** The key a claim must be signed by now: the epoch's while one runs, else the seat's on chain. */
  #currentKey(address) {
    if (this.#rec.base) return this.#epochKey(address);
    const key = this.#chain.seat(this.#k, address)?.sessionKey;
    return key ? normalizeAddress(key) : null;
  }

  // A claim holds only while the seat still has the key that signed it (deposit() overwrites the key).
  #isClaimed(member) {
    return (
      member.playerId !== null &&
      member.claimedKey !== null &&
      member.claimedKey === this.#currentKey(member.address)
    );
  }

  #keyAgeMs(address) {
    const registered = this.#rec.keyTimes?.[address] ?? this.#rec.createdAt ?? 0;
    return Math.max(0, (this.#chain.chainTime() - Number(registered)) * 1000);
  }

  #rebindAllowed(address) {
    const now = this.#clock.now();
    const recent = (this.#rebinds.get(address) ?? []).filter(
      (t) => now - t < this.#policy.rebindWindowMs,
    );
    if (recent.length >= this.#policy.rebindLimit) {
      this.#rebinds.set(address, recent);
      return false;
    }
    recent.push(now);
    this.#rebinds.set(address, recent);
    return true;
  }

  #claim(playerId, address, sig) {
    if (!this.#rec || (this.#halt && FROZEN.has(this.#halt.cause))) return LOCKED;
    if (typeof playerId !== 'string' || playerId === '') return fail(ERR.BAD_CLAIM, 'no player id');
    let who;
    try {
      who = normalizeAddress(address);
    } catch {
      return fail(ERR.BAD_CLAIM, 'not an address');
    }
    const phase = this.#rec.phase;
    if (phase === 'creating' || phase === 'closed') {
      return fail(ERR.CLAIM_PENDING, 'the table is being created');
    }
    const bound = this.#byPlayer.get(playerId);
    if (bound !== undefined && bound !== who) {
      return fail(ERR.BAD_CLAIM, 'this player already holds another seat at this table');
    }
    const seat = this.#chain.seat(this.#k, who);
    if (!seat || seat.deposit <= 0n) return fail(ERR.BAD_CLAIM, 'no seat on chain');
    if (seat.confirmed === false)
      return fail(ERR.CLAIM_PENDING, 'the deposit is not confirmed yet');
    const inEpoch = Boolean(this.#rec.base);
    if (inEpoch && !this.#rec.roster.includes(who)) {
      return fail(ERR.BAD_CLAIM, 'not a member of this epoch');
    }
    const key = this.#currentKey(who);
    if (key === null) return fail(ERR.BAD_CLAIM, 'no session key');
    if (key === normalizeAddress(this.#signer.address) || this.#keyTakenByOther(who, key)) {
      return fail(ERR.BAD_CLAIM, 'this session key is not unique to the seat');
    }
    if (
      !verifyClaim({ domain: this.#domain, tableKey: this.#k, address: who, playerId }, sig, key)
    ) {
      return fail(ERR.BAD_CLAIM, 'the claim is not signed by the session key of this seat');
    }
    const row = this.#row();
    if (row && row.nonce > this.#rec.nonceHw) {
      if (!this.#halt?.fatal) this.#haltWith('store-behind-chain');
      return LOCKED;
    }

    const member = this.#addMember(who);
    if (member.playerId !== null && member.playerId !== playerId) {
      if (!this.#rebindAllowed(who)) {
        return fail(ERR.RATE_LIMITED, 'too many re-binds for this seat');
      }
      const old = member.playerId;
      if (this.#byPlayer.get(old) === who) this.#byPlayer.delete(old);
      this.#hostCall('rekey', old, playerId, who);
    }
    member.playerId = playerId;
    member.claimedKey = key;
    member.online = true;
    this.#byPlayer.set(playerId, who);
    if (!inEpoch && !this.#rec.depositors.includes(who)) {
      this.#save({ depositors: [...this.#rec.depositors, who] });
    }
    this.#resendTo(who);
    return { ok: true, address: who, chips: this.#chipsFor(who) };
  }

  #keyTakenByOther(address, key) {
    for (const other of this.#members.keys()) {
      if (other !== address && this.#currentKey(other) === key) return true;
    }
    return false;
  }

  #chipsFor(address) {
    if (this.#rec.base) {
      const state = this.#latestState();
      const i = state.players.indexOf(address);
      return i >= 0 ? toChips(state.balances[i], this.#unit).chips : 0;
    }
    const seat = this.#chain.seat(this.#k, address);
    return seat ? toChips(seat.deposit, this.#unit).chips : 0;
  }

  #requestLeave(playerId) {
    const member = this.#memberOf(playerId);
    if (!member || !this.#rec) return fail(ERR.NOT_SEATED, 'not a member of this vault table');
    if (!this.#rec.leaving.includes(member.address)) {
      this.#save({ leaving: [...this.#rec.leaving, member.address] });
    }
    return { ok: true, head: this.#head() ?? this.#rec.epochBaseNonce };
  }

  // ---- states and rounds ----------------------------------------------------------------------------

  #head() {
    const { nonceHw, epochBaseNonce } = this.#rec;
    return nonceHw > epochBaseNonce ? nonceHw : null;
  }

  #baseState() {
    return normalizeState(this.#rec.base);
  }

  // Chips after a restart come from the highest reserved state of the epoch, not from the last bundle: if
  // round n was open, the next state must be built on state n.
  #latestState() {
    return this.#store.latestSigned(this.#k)?.state ?? this.#baseState();
  }

  #handsInEpoch() {
    return Number(this.#rec.nonceHw - this.#rec.epochBaseNonce);
  }

  #checkCtx() {
    return {
      domain: this.#domain,
      maxRakeBps: this.#chain.info.maxRakeBps,
      sessionKeyOf: (player) => this.#epochKey(player),
      table: tableFromChain(this.#row() ?? {}),
    };
  }

  #decide(entries, handsInEpoch) {
    const now = this.#chain.chainTime();
    const started = this.#rec.epochStartedAt;
    const keyAges = Object.fromEntries(entries.map((e) => [e.address, this.#keyAgeMs(e.address)]));
    return rotationDecision({
      entries,
      handsInEpoch,
      epochAgeMs: started === null ? undefined : Math.max(0, (now - Number(started)) * 1000),
      keyAges,
      drain: this.#rec.drain === true,
      leaveRequests: this.#rec.leaving,
      config: this.#policy,
    });
  }

  #currentEntries(state) {
    return state.players.map((address, i) => ({
      address,
      chips: toChips(state.balances[i], this.#unit).chips,
      leaving: this.#rec.leaving.includes(address),
      idleHands: this.#members.get(address)?.idleHands ?? 0,
    }));
  }

  // Would the next hand have to end the epoch anyway? Then it is not dealt; the final goes out instead.
  #rotationDue() {
    if (!this.#rec.base) return false;
    const state = this.#latestState();
    if (state.isFinal) return true;
    return this.#decide(this.#currentEntries(state), this.#handsInEpoch()).rotate;
  }

  #handEnd(snapshot) {
    if (!this.#rec) return;
    const phase = this.#rec.phase;
    if (this.#halt) {
      this.#alarm('hand-dropped', { handNo: snapshot?.handNo ?? null, cause: this.#halt.cause });
      return;
    }
    if (!this.#rec.base || !['active', 'stalled', 'exiting'].includes(phase)) {
      this.#alarm('hand-outside-epoch', { handNo: snapshot?.handNo ?? null, phase });
      return;
    }
    if (this.#round?.isLive) {
      this.#haltWith('hand-while-round-open', { detail: `round ${this.#round.nonce} is open` });
      return;
    }
    const prev = this.#latestState();
    if (prev.isFinal) {
      this.#haltWith('hand-after-final');
      return;
    }
    const read = this.#readSnapshot(snapshot);
    if (typeof read === 'string') {
      this.#haltWith('bad-snapshot', { detail: read });
      return;
    }
    const { handNo, rake, pot, byAddress } = read;
    const roster = prev.players;
    const balances = roster.map(
      (address) =>
        toTokenUnits(byAddress.get(address).chips, this.#unit) + (this.#rec.dust[address] ?? 0n),
    );
    for (const address of roster) {
      const entry = byAddress.get(address);
      const member = this.#addMember(address);
      member.idleHands =
        entry.status === 'sitout' && entry.connected === true ? member.idleHands + 1 : 0;
      if (isCount(entry.seat)) member.seat = entry.seat;
    }
    // During an exit the hand that was in flight is proposed as it is (so a challenge can raise the exit);
    // the epoch's final is the exit-recovery state, not a rotation.
    const decision =
      phase === 'exiting'
        ? { rotate: false }
        : this.#decide(
            roster.map((address) => ({
              address,
              chips: byAddress.get(address).chips,
              leaving: byAddress.get(address).leaving === true,
              idleHands: this.#members.get(address).idleHands,
            })),
            this.#handsInEpoch() + 1,
          );
    this.#propose({
      prev,
      balances,
      rakeDelta: toTokenUnits(rake, this.#unit),
      volumeDelta: toTokenUnits(pot, this.#unit),
      final: decision.rotate,
      keep: decision.rotate ? decision.keep : undefined,
      reason: decision.rotate ? decision.reason : 'hand',
      handNo,
    });
  }

  // What the actor handed in, read strictly. Returns a description of the problem instead of throwing.
  #readSnapshot(snapshot) {
    if (snapshot === null || typeof snapshot !== 'object') return 'snapshot must be an object';
    const { handNo = null, result, entries } = snapshot;
    if (handNo !== null && !isCount(handNo)) return 'handNo must be a whole number';
    if (!result || !isCount(result.rake) || !isCount(result.pot)) {
      return 'result must carry whole-chip pot and rake';
    }
    if (result.rake > result.pot) return 'the rake cannot exceed the pot';
    if (!Array.isArray(entries)) return 'entries must be an array';
    const byAddress = new Map();
    for (const entry of entries) {
      let address;
      try {
        address = normalizeAddress(entry?.address);
      } catch {
        continue; // not a vault member (cannot be one without an address)
      }
      if (!isCount(entry.chips)) return `chips of ${address} must be whole chips`;
      if (byAddress.has(address)) return `${address} appears twice`;
      byAddress.set(address, entry);
    }
    for (const address of this.#rec.roster) {
      if (!byAddress.has(address)) return `member ${address} is missing from the snapshot`;
    }
    return { handNo, rake: result.rake, pot: result.pot, byAddress };
  }

  // Build, check, reserve, sign, attach, then queue the signreqs. A state the contract would refuse is never
  // signed: a stale chain view gets one re-read and one retry, anything else halts.
  #propose({
    prev,
    balances,
    rakeDelta = 0n,
    volumeDelta = 0n,
    final = false,
    keep,
    reason,
    handNo = null,
    retry = false,
  }) {
    const state = buildNextState({ prev, balances, rakeDelta, volumeDelta, final, keep });
    if (sum(state.balances) + state.rake !== sum(prev.balances) + prev.rake) {
      this.#haltWith('not-conserved', {
        detail: `${sum(state.balances) + state.rake} != ${sum(prev.balances) + prev.rake}`,
      });
      return false;
    }
    for (const player of state.players) {
      const age = this.#keyAgeMs(player);
      if (!serverMayCoSign({ sessionKeyAgeMs: age, policyMaxMs: this.#policy.policyMaxMs })) {
        this.#haltWith('key-expired', { detail: player });
        return false;
      }
    }
    const verdict = checkState(state, null, this.#checkCtx());
    if (!verdict.ok) {
      const detail = `${verdict.error}(${verdict.args.join(', ')})`;
      if (retry) {
        this.#haltWith('check-failed', { detail });
        return false;
      }
      this.#pending = { prev, balances, rakeDelta, volumeDelta, final, keep, reason, handNo };
      this.#haltWith('stale-chain-cache', { detail });
      this.#reread();
      return false;
    }
    const k = this.#k;
    this.#store.transaction(() => {
      this.#store.reserve(k, state, verdict.digest);
      this.#save({ roundMeta: { nonce: state.nonce, reason, handNo } });
    });
    const arbiterSig = this.#signer.signReserved(k, state.nonce);
    this.#store.attachArbiterSig(k, state.nonce, arbiterSig);
    this.#round = new SignRound({
      state,
      digest: verdict.digest,
      arbiterSig,
      sessionKeys: this.#rec.sessionKeys,
      reason,
      handNo,
      openedAt: this.#clock.now(),
      timing: this.#policy,
    });
    for (const address of state.players) this.#queue(address, this.#signreqMessage(this.#round));
    return true;
  }

  // Ask the chain adapter for a full re-read (FakeChain: repair(); a real adapter: refresh()).
  #reread() {
    const chain = this.#chain;
    try {
      if (typeof chain.refresh === 'function') chain.refresh();
      else if (typeof chain.repair === 'function') chain.repair();
    } catch (error) {
      this.#alarm('reread-failed', String(error?.message ?? error));
    }
  }

  #retryHalt(now) {
    const halt = this.#halt;
    if (!halt || halt.fatal || now < halt.retryAt) return;
    this.#halt = null;
    const pending = this.#pending;
    this.#pending = null;
    if (pending && !this.#round?.isLive) this.#propose({ ...pending, retry: true });
  }

  #maybeProposeBetweenHands() {
    if (!this.#rec?.base || this.#halt || this.#round?.isLive || this.#inHand()) return;
    const phase = this.#rec.phase;
    const prev = this.#latestState();
    if (prev.isFinal) return;
    if (phase === 'active' || phase === 'stalled') {
      const decision = this.#decide(this.#currentEntries(prev), this.#handsInEpoch());
      if (!decision.rotate) return;
      this.#propose({
        prev,
        balances: prev.balances,
        final: true,
        keep: decision.keep,
        reason: decision.reason,
      });
    } else if (phase === 'exiting') {
      this.#maybeExitRecovery(prev);
    }
  }

  // Exit recovery (section 6): every member is back inside the window, the open round is complete, so the
  // table can settle a final instead of closing: keep everyone with chips who did not ask to leave.
  #maybeExitRecovery(prev) {
    const row = this.#row();
    if (!row || row.status !== TABLE_STATUS.Exiting) return;
    if (this.#chain.chainTime() + this.#policy.challengeMarginSec >= row.exitDeadline) return;
    for (const address of prev.players) {
      const member = this.#members.get(address);
      if (!member || !this.#isClaimed(member) || !member.online) return;
    }
    const entries = this.#currentEntries(prev);
    this.#propose({
      prev,
      balances: prev.balances,
      final: true,
      keep: entries.map((e) => e.chips > 0 && !e.leaving),
      reason: 'exit-recovery',
    });
  }

  #sign(playerId, nonceIn, digest, sig) {
    if (!this.#rec) return LOCKED;
    const member = this.#memberOf(playerId);
    if (!member || !this.#isClaimed(member)) {
      return fail(ERR.NOT_SEATED, 'claim the seat first');
    }
    const nonce = nonceFrom(nonceIn);
    if (nonce === null) return fail(ERR.BAD_SIGNATURE, 'nonce must be a uint64');
    const round = this.#round;
    if (!round || nonce !== round.nonce) {
      const newest = round ? round.nonce : this.#rec.nonceHw;
      if (nonce > newest) return fail(ERR.BAD_SIGNATURE, `nothing was proposed at nonce ${nonce}`);
      return { ok: true }; // a late or repeated signature for a state that is already settled
    }
    if (!round.isLive) return { ok: true };
    const verdict = round.verify(member.address, { digest, sig });
    if (!verdict.ok) {
      return fail(
        verdict.code === 'not-a-signer' ? ERR.NOT_SEATED : ERR.BAD_SIGNATURE,
        verdict.msg,
      );
    }
    if (verdict.duplicate && !verdict.conflict) return { ok: true };
    // persist first, then count: a crash after this line keeps the signature
    const stored = this.#store.addPlayerSig(this.#k, nonce, member.address, sig);
    if (verdict.conflict || stored.conflict) return { ok: true };
    round.record(member.address, sig);
    if (round.isComplete) this.#completeRound();
    return { ok: true };
  }

  // The last signature is in: one transaction saves the bundle, moves the phase and (for a final) queues
  // the settle; then bundle(n) goes to everyone before anything at n+1 can be proposed.
  #completeRound() {
    const round = this.#round;
    const k = this.#k;
    const sigs = this.#store.playerSigs(k, round.nonce);
    if (sigs.size !== round.state.players.length) return false;
    const bundle = makeBundle({
      domain: this.#domain,
      state: round.state,
      arbiterSig: round.arbiterSig,
      playerSigs: [...sigs.values()],
    });
    const { isFinal } = round.state;
    let saved;
    this.#store.transaction(() => {
      saved = this.#store.saveBundle(k, bundle, this.#verifyCtx());
      if (!saved.saved && saved.reason !== 'not-newer') return;
      const changes = { stallExit: null, roundMeta: null };
      if (isFinal) changes.phase = 'settling';
      else if (this.#rec.phase === 'stalled') changes.phase = 'active';
      this.#save(changes);
      if (isFinal) this.#store.enqueueJob(makeJob(JOB_KINDS.settle, k));
    });
    if (saved.reason === 'conflict') {
      this.#haltWith('bundle-conflict', { detail: `nonce ${round.nonce}` });
      return false;
    }
    if (saved.reason === 'invalid') {
      this.#haltWith('bundle-invalid', { detail: `${saved.error} at nonce ${round.nonce}` });
      return false;
    }
    this.#round = null;
    if (saved.reason === 'old-epoch') return false;
    this.#gateClosedSince = null;
    for (const address of round.state.players) this.#queue(address, this.#bundleMessage(bundle));
    return true;
  }

  #verifyCtx() {
    return {
      arbiter: normalizeAddress(this.#signer.address),
      sessionKeyOf: (player) => this.#epochKey(player),
      expect: { domain: this.#domain, tableId: this.#k, players: this.#rec.roster },
    };
  }

  #abandonRound() {
    this.#round?.abandon();
    this.#round = null;
  }

  // ---- stalls (section 6) ---------------------------------------------------------------------------

  #gateView() {
    const roster = this.#rec.roster ?? [];
    return {
      active: this.#rec.phase === 'active',
      roundOpen: Boolean(this.#round?.isLive),
      head: this.#head(),
      bundle: this.#store.loadBundle(this.#k),
      members: roster.map((address) => {
        const member = this.#members.get(address);
        return {
          claimed: member ? this.#isClaimed(member) : false,
          online: member?.online === true,
        };
      }),
      verify: {
        arbiter: this.#signer.address,
        sessionKeyOf: (player) => this.#epochKey(player),
      },
      tableId: this.#k,
      domain: this.#domain,
      roster,
    };
  }

  #stallTick(now) {
    if (!this.#rec.base) return;
    const phase = this.#rec.phase;
    const round = this.#round?.isLive ? this.#round : null;
    if (round) {
      const { resend } = round.due(now);
      if (resend) {
        for (const address of round.missing) {
          const member = this.#members.get(address);
          if (member?.online && this.#isClaimed(member)) {
            this.#queue(address, this.#signreqMessage(round));
          }
        }
      }
    }
    let stallFrom = null;
    if (this.#halt) {
      if (this.#halt.fatal && this.#halt.exit) stallFrom = this.#halt.at;
    } else if (phase === 'active' || phase === 'stalled') {
      if (round) {
        this.#gateClosedSince = null;
        if (round.expired) {
          stallFrom = round.deadline;
          if (phase === 'active') this.#save({ phase: 'stalled' });
        }
      } else if (!this.#inHand()) {
        // F11: a gate closed for an absent or unclaimed member with no round open is a stall too
        const view = { ...this.#gateView(), active: true };
        const reason = dealBlocker(view)?.reason ?? null;
        if (reason === 'member-offline' || reason === 'member-not-claimed') {
          this.#gateClosedSince ??= now;
        } else {
          this.#gateClosedSince = null;
        }
        if (this.#gateClosedSince !== null) {
          stallFrom = this.#gateClosedSince + this.#policy.absentGraceMs;
        }
        const stalled = stallFrom !== null && now >= stallFrom;
        if (stalled && phase === 'active') this.#save({ phase: 'stalled' });
        if (!stalled && phase === 'stalled') this.#save({ phase: 'active' });
        if (!stalled && this.#rec.stallExit) this.#save({ stallExit: null });
      }
    }
    if (stallFrom !== null && now >= stallFrom + this.#policy.stallExitMs) {
      this.#requestStallExit(round?.nonce ?? null);
    }
  }

  // The stall exit: startExit(B) when this epoch has a bundle above the chain, else startExitFromDeposits.
  // The decision is written to the record with the job, so the resolver's guard can re-check it at send
  // time, and a late signature (which clears it in the same transaction as its bundle) stops it.
  #requestStallExit(nonce) {
    const row = this.#row();
    if (!row || row.status !== TABLE_STATUS.Active) return;
    const action = stallAction({ tableKey: this.#k, chainRow: row, store: this.#storeView() });
    if (!action || action.kind === JOB_KINDS.settle) return; // a final is the reconciler's
    const stall = this.#rec.stallExit;
    if (stall && stall.kind === action.kind && stall.nonce === nonce) {
      this.#ensureJob(action.kind);
      return;
    }
    if (this.#clock.now() < (this.#notBefore.get(action.kind) ?? -Infinity)) return;
    this.#store.transaction(() => {
      this.#save({ stallExit: { kind: action.kind, nonce, since: this.#clock.now() } });
      this.#store.enqueueJob(makeJob(action.kind, this.#k));
    });
  }

  // ---- chain events ---------------------------------------------------------------------------------

  #event(event) {
    if (!this.#rec || !event || typeof event.tableKey !== 'string') return;
    if (event.tableKey.toLowerCase() !== this.#k) return;
    if (event.type === EVENT_TYPES.JobFailed) {
      this.#jobFailed(event);
      return;
    }
    const last = this.#rec.lastAppliedEvent;
    if (last && comparePositions(event, last) <= 0) return; // already applied before a restart
    const at = { block: event.block, logIndex: event.logIndex };
    switch (event.type) {
      case EVENT_TYPES.Deposited:
      case EVENT_TYPES.SessionKeySet: {
        // the policy age of a session key counts from its registration on chain (S3)
        const player = normalizeAddress(event.player);
        const keyTimes = { ...this.#rec.keyTimes, [player]: this.#chain.chainTime() };
        const depositors =
          event.type === EVENT_TYPES.Deposited && !this.#rec.depositors.includes(player)
            ? [...this.#rec.depositors, player]
            : this.#rec.depositors;
        this.#save({ keyTimes, depositors, lastAppliedEvent: at });
        this.#addMember(player);
        return;
      }
      case EVENT_TYPES.Left: {
        const player = normalizeAddress(event.player);
        this.#save({
          depositors: this.#rec.depositors.filter((a) => a !== player),
          lastAppliedEvent: at,
        });
        this.#unseat(player, 'left', event.amount);
        return;
      }
      case EVENT_TYPES.Started: {
        const phase = this.#rec.phase;
        const row = this.#row();
        if (
          ['creating', 'filling', 'starting'].includes(phase) &&
          row &&
          row.status !== 'Filling'
        ) {
          this.#enterActive(row, event.players, at);
        }
        return;
      }
      default:
      // Settled, ExitStarted, Challenged, ExitFinalized, Payout: the row says it all; #sync follows
    }
  }

  // ---- messages -------------------------------------------------------------------------------------

  #queue(address, message) {
    this.#outbox.push({ address, message });
  }

  #flushOutbox() {
    const out = this.#outbox.splice(0);
    for (const { address, message } of out) {
      const member = this.#members.get(address);
      if (member?.playerId) this.#hostCall('send', member.playerId, message);
    }
  }

  #resendTo(address) {
    if (this.#rec.base && this.#rec.roster.includes(address)) {
      this.#queue(address, this.#epochMessage());
      const bundle = this.#store.loadBundle(this.#k);
      if (bundle) this.#queue(address, this.#bundleMessage(bundle));
    }
    const round = this.#round;
    if (round?.isLive && !round.hasSigned(address) && round.state.players.includes(address)) {
      this.#queue(address, this.#signreqMessage(round));
    }
  }

  #epochMessage() {
    return {
      t: SERVER.EPOCH,
      tableId: this.#cfg.id,
      epoch: Number(this.#rec.epoch),
      domain: { ...this.#domain },
      state: toWire(this.#baseState()),
      sessionKeys: [...this.#rec.sessionKeys],
      arbiter: normalizeAddress(this.#signer.address),
    };
  }

  #signreqMessage(round) {
    return {
      t: SERVER.SIGN_REQ,
      tableId: this.#cfg.id,
      epoch: Number(this.#rec.epoch),
      handNo: round.handNo ?? null,
      state: toWire(round.state),
      digest: round.digest,
      deadline: round.deadline,
      reason: round.reason,
    };
  }

  #bundleMessage(bundle) {
    return {
      t: SERVER.BUNDLE,
      tableId: this.#cfg.id,
      epoch: Number(this.#rec.epoch),
      domain: { ...this.#domain },
      state: toWire(bundle.state),
      arbiterSig: bundle.arbiterSig,
      playerSigs: [...bundle.playerSigs],
      sessionKeys: [...this.#rec.sessionKeys],
    };
  }

  #awaitingSeats() {
    const round = this.#round?.isLive ? this.#round : null;
    let addresses = [];
    if (round) addresses = round.missing;
    else if (this.#rec.base && this.#rec.phase !== 'settling') {
      addresses = this.#rec.roster.filter((a) => {
        const member = this.#members.get(a);
        return !member?.online || !this.#isClaimed(member);
      });
    } else if (this.#rec.phase === 'filling') {
      addresses = this.#rec.depositors.filter((a) => {
        const member = this.#members.get(a);
        return !member || !this.#isClaimed(member);
      });
    }
    const seats = [];
    for (const address of addresses) {
      const seat = this.#hostCall('seatOf', address) ?? this.#members.get(address)?.seat ?? null;
      if (isCount(seat) && seat < 10 && !seats.includes(seat)) seats.push(seat);
    }
    return seats.slice(0, 10);
  }
}
