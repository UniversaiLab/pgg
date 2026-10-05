// The in-memory StateStore, for tests and for the simulation. It follows the same rules as SqliteStore
// (every decision lives in store.js) but keeps everything in Maps, and a transaction is an undo log:
// every write remembers what it replaced, and a failure plays the log back. There are no deletes, so
// "undo" is only ever "put the old value back".
//
// It also offers failAfterWrites(k), the crash-point hook: the k-th write from now succeeds and then
// throws, so a test can stop an operation between any two of its writes and look at what is left.
import { bundleFromWire, bundleToWire, toWire } from '@pgg/vault';
import {
  advanceCounters,
  asAddress,
  buildJob,
  buildRecord,
  bundleConflictAlarm,
  checkBundleForSave,
  closedError,
  cursorBehind,
  cursorOf,
  decideBundle,
  decideReserve,
  decideSig,
  decodeJson,
  decodeSigned,
  encodeJson,
  isThenable,
  JOB_FINISHED,
  keyOf,
  latestSignedNonce,
  mergeTable,
  nextMax,
  nonceOf,
  openRoundNonce,
  orderSigs,
  parseJob,
  parsePatch,
  parseReserve,
  parseTableRecord,
  StoreError,
  sigConflictAlarm,
  sigOf,
  sigResult,
  statusOf,
} from './store.js';

export class MemoryStore {
  #open = true;
  #depth = 0;
  #undo = [];
  #writes = 0;
  #failIn = null;
  #failError = null;

  #tables = new Map(); // tableKey -> { hot, bodyJson }
  #signed = new Map(); // tableKey -> Map<nonce, { digest, stateJson, arbiterSig }>
  #sigs = new Map(); // tableKey -> Map<nonce, Map<address, sig>>
  #latest = new Map(); // tableKey -> { nonce, digest, json }: newest bundle
  #final = new Map(); // tableKey -> { nonce, digest, json }: newest final bundle
  #jobs = new Map(); // key -> row
  #alarmRows = new Map(); // key -> row
  #kv = new Map(); // cursor and the id counters

  // ---- plumbing -----------------------------------------------------------------------------

  #assertOpen() {
    if (!this.#open) throw closedError();
  }

  #countWrite() {
    this.#writes += 1;
    if (this.#failIn !== null && --this.#failIn === 0) {
      this.#failIn = null;
      throw typeof this.#failError === 'function' ? this.#failError() : this.#failError;
    }
  }

  // Every write goes through here so it can be undone and counted.
  #put(map, key, value) {
    const had = map.has(key);
    const previous = map.get(key);
    this.#undo.push(() => {
      if (had) map.set(key, previous);
      else map.delete(key);
    });
    map.set(key, value);
    this.#countWrite();
  }

  // An empty container left behind by a rolled-back write is harmless, so creating one is not logged.
  #sub(root, key) {
    let map = root.get(key);
    if (!map) {
      map = new Map();
      root.set(key, map);
    }
    return map;
  }

  /** Total writes since the store was created (the unit failAfterWrites counts in). */
  get writeCount() {
    return this.#writes;
  }

  /**
   * Test hook for crash points: the k-th write from now succeeds and then `error` is thrown, which rolls
   * the surrounding transaction back. `error` may be a function: it is called at that moment and what it
   * returns is thrown, so a test can also kill the whole process there (the SIGKILL test does). `null`
   * disarms. It fires once.
   */
  failAfterWrites(k, error = new Error('injected store failure')) {
    this.#assertOpen();
    if (k === null) {
      this.#failIn = null;
      return;
    }
    if (!Number.isSafeInteger(k) || k < 1) throw new RangeError('k must be a positive integer');
    this.#failIn = k;
    this.#failError = error;
  }

  transaction(fn) {
    this.#assertOpen();
    if (typeof fn !== 'function') throw new TypeError('transaction needs a function');
    const mark = this.#undo.length;
    this.#depth += 1;
    let result;
    try {
      result = fn();
      if (isThenable(result)) {
        throw new StoreError('async-transaction', 'a transaction callback must be synchronous');
      }
    } catch (error) {
      this.#depth -= 1;
      while (this.#undo.length > mark) this.#undo.pop()();
      throw error;
    }
    this.#depth -= 1;
    if (this.#depth === 0) this.#undo.length = 0;
    return result;
  }

  close() {
    if (!this.#open) return;
    if (this.#depth > 0)
      throw new StoreError('in-transaction', 'cannot close inside a transaction');
    this.#open = false;
    for (const map of [
      this.#tables,
      this.#signed,
      this.#sigs,
      this.#latest,
      this.#final,
      this.#jobs,
      this.#alarmRows,
      this.#kv,
    ]) {
      map.clear();
    }
  }

  // ---- tables -------------------------------------------------------------------------------

  loadTable(tableKey) {
    this.#assertOpen();
    const key = keyOf(tableKey);
    const row = this.#tables.get(key);
    return row ? buildRecord(key, row.hot, row.bodyJson) : null;
  }

  saveTable(record) {
    this.#assertOpen();
    const parsed = parseTableRecord(record);
    return this.transaction(() => {
      const merged = mergeTable(this.#tables.get(parsed.tableKey) ?? null, parsed);
      this.#put(this.#tables, parsed.tableKey, merged);
      return buildRecord(parsed.tableKey, merged.hot, merged.bodyJson);
    });
  }

  listTables() {
    this.#assertOpen();
    return [...this.#tables.keys()]
      .sort()
      .map((key) => buildRecord(key, this.#tables.get(key).hot, this.#tables.get(key).bodyJson));
  }

  // ---- signed states ------------------------------------------------------------------------

  #signedRow(tableKey, nonce) {
    return this.#signed.get(tableKey)?.get(nonce.toString()) ?? null;
  }

  #maxSigned(tableKey) {
    let max = null;
    for (const nonce of this.#signed.get(tableKey)?.keys() ?? []) max = nextMax(max, BigInt(nonce));
    return max;
  }

  #storeSigned(tableKey, nonce, row) {
    this.#put(this.#sub(this.#signed, tableKey), nonce.toString(), row);
  }

  #sigRow(tableKey, nonce) {
    return this.#sigs.get(tableKey)?.get(nonce.toString()) ?? new Map();
  }

  #putSig(tableKey, nonce, address, sig) {
    const byNonce = this.#sub(this.#sigs, tableKey);
    const existing = byNonce.get(nonce.toString()) ?? new Map();
    this.#put(byNonce, nonce.toString(), new Map(existing).set(address, sig));
  }

  reserve(tableKey, state, digest) {
    this.#assertOpen();
    const input = parseReserve(tableKey, state, digest);
    return this.transaction(() => {
      const table = this.#tables.get(input.tableKey) ?? null;
      const existing = this.#signedRow(input.tableKey, input.nonce);
      if (decideReserve(input, table?.hot ?? null, existing) === 'repeat') return false;
      this.#storeSigned(input.tableKey, input.nonce, {
        digest: input.digest,
        stateJson: input.stateJson,
        arbiterSig: null,
      });
      const hot = { ...table.hot, ...advanceCounters(table.hot, input.state) };
      this.#put(this.#tables, input.tableKey, { ...table, hot });
      return true;
    });
  }

  attachArbiterSig(tableKey, nonce, sig) {
    this.#assertOpen();
    const key = keyOf(tableKey);
    const n = nonceOf(nonce);
    const signature = sigOf(sig, 'arbiter signature');
    return this.transaction(() => {
      const row = this.#signedRow(key, n);
      if (!row) throw new StoreError('not-reserved', `nothing is reserved at nonce ${n}`);
      const verdict = decideSig(row.arbiterSig, signature);
      if (verdict === 'store') this.#storeSigned(key, n, { ...row, arbiterSig: signature });
      if (verdict === 'conflict') {
        this.#alarm(sigConflictAlarm('arbiter-sig-conflict', key, n, 'arbiter'));
      }
      return sigResult(verdict);
    });
  }

  addPlayerSig(tableKey, nonce, address, sig) {
    this.#assertOpen();
    const key = keyOf(tableKey);
    const n = nonceOf(nonce);
    const player = asAddress(address);
    const signature = sigOf(sig, 'player signature');
    return this.transaction(() => {
      const row = this.#signedRow(key, n);
      if (!row) throw new StoreError('not-reserved', `nothing is reserved at nonce ${n}`);
      if (!JSON.parse(row.stateJson).players.includes(player)) {
        throw new StoreError(
          'not-in-roster',
          `${player} is not a player of the state at nonce ${n}`,
        );
      }
      const verdict = decideSig(this.#sigRow(key, n).get(player) ?? null, signature);
      if (verdict === 'store') this.#putSig(key, n, player, signature);
      if (verdict === 'conflict') {
        this.#alarm(sigConflictAlarm('player-sig-conflict', key, n, player));
      }
      return sigResult(verdict);
    });
  }

  playerSigs(tableKey, nonce) {
    this.#assertOpen();
    const key = keyOf(tableKey);
    const n = nonceOf(nonce);
    const row = this.#signedRow(key, n);
    if (!row) return new Map();
    return orderSigs(JSON.parse(row.stateJson), this.#sigRow(key, n));
  }

  getSigned(tableKey, nonce) {
    this.#assertOpen();
    const row = this.#signedRow(keyOf(tableKey), nonceOf(nonce));
    return row ? decodeSigned(row) : null;
  }

  latestSigned(tableKey, { anyEpoch = false } = {}) {
    this.#assertOpen();
    const key = keyOf(tableKey);
    const table = this.#tables.get(key);
    if (!table) return null;
    const nonce = latestSignedNonce({
      epochBaseNonce: table.hot.epochBaseNonce,
      maxSigned: this.#maxSigned(key),
      anyEpoch,
    });
    return nonce === null ? null : decodeSigned(this.#signedRow(key, nonce));
  }

  openRound(tableKey) {
    this.#assertOpen();
    const key = keyOf(tableKey);
    const table = this.#tables.get(key);
    if (!table) return null;
    const nonce = openRoundNonce({
      epochBaseNonce: table.hot.epochBaseNonce,
      maxSigned: this.#maxSigned(key),
      latestBundleNonce: this.#latest.get(key)?.nonce ?? null,
    });
    if (nonce === null) return null;
    const row = this.#signedRow(key, nonce);
    return {
      nonce,
      ...decodeSigned(row),
      playerSigs: orderSigs(JSON.parse(row.stateJson), this.#sigRow(key, nonce)),
    };
  }

  // ---- bundles ------------------------------------------------------------------------------

  saveBundle(tableKey, bundle, verifyCtx) {
    this.#assertOpen();
    const key = keyOf(tableKey);
    const checked = checkBundleForSave(key, bundle, verifyCtx);
    if (!checked.ok) return checked.result;
    return this.transaction(() => {
      const table = this.#tables.get(key);
      if (!table) throw new StoreError('unknown-table', `unknown table ${key}`);
      const { bundle: b, digest } = checked;
      const nonce = b.state.nonce;
      const row = this.#signedRow(key, nonce);
      const decision = decideBundle({
        nonce,
        digest,
        epochBaseNonce: table.hot.epochBaseNonce,
        signedDigest: row?.digest ?? null,
        latest: this.#latest.get(key) ?? null,
      });
      if (decision.verdict === 'conflict') {
        this.#alarm(bundleConflictAlarm(key, nonce, decision.stored, digest));
        return { saved: false, reason: 'conflict' };
      }
      if (decision.verdict !== 'save') return { saved: false, reason: decision.verdict };

      // A bundle we never reserved (adopted after a lost database) must also close the double-sign
      // guard at its nonce, or the arbiter could later sign a different state there.
      if (!row) {
        this.#storeSigned(key, nonce, {
          digest,
          stateJson: JSON.stringify(toWire(b.state)),
          arbiterSig: b.arbiterSig,
        });
        const hot = { ...table.hot, ...advanceCounters(table.hot, b.state) };
        this.#put(this.#tables, key, { ...table, hot });
      } else if (row.arbiterSig === null) {
        this.#storeSigned(key, nonce, { ...row, arbiterSig: b.arbiterSig });
      }
      const known = this.#sigRow(key, nonce);
      b.state.players.forEach((player, i) => {
        if (!known.has(player)) this.#putSig(key, nonce, player, b.playerSigs[i]);
      });
      const slot = { nonce, digest, json: JSON.stringify(bundleToWire(b)) };
      this.#put(this.#latest, key, slot);
      if (b.state.isFinal) this.#put(this.#final, key, slot);
      return { saved: true };
    });
  }

  loadBundle(tableKey) {
    this.#assertOpen();
    const key = keyOf(tableKey);
    const table = this.#tables.get(key);
    const slot = this.#latest.get(key);
    if (!table || !slot || slot.nonce <= table.hot.epochBaseNonce) return null;
    return bundleFromWire(JSON.parse(slot.json));
  }

  loadFinalBundle(tableKey) {
    this.#assertOpen();
    const slot = this.#final.get(keyOf(tableKey));
    return slot ? bundleFromWire(JSON.parse(slot.json)) : null;
  }

  // ---- jobs and cursor ----------------------------------------------------------------------

  // See SqliteStore.enqueueJob: in flight keeps its key, done or failed gives it up.
  enqueueJob(job) {
    this.#assertOpen();
    const parsed = parseJob(job);
    return this.transaction(() => {
      const existing = this.#jobs.get(parsed.key);
      if (existing && !JOB_FINISHED.includes(existing.status)) return false;
      const seq = (this.#kv.get('jobSeq') ?? 0) + 1;
      this.#put(this.#kv, 'jobSeq', seq);
      this.#put(this.#jobs, parsed.key, {
        ...parsed,
        seq,
        status: 'pending',
        txHash: null,
        attempts: 0,
        error: null,
      });
      return true;
    });
  }

  getJob(key) {
    this.#assertOpen();
    const row = this.#jobs.get(key);
    return row ? buildJob(row) : null;
  }

  pendingJobs() {
    this.#assertOpen();
    return [...this.#jobs.values()]
      .filter((row) => row.status !== 'done')
      .sort((a, b) => b.priority - a.priority || a.seq - b.seq)
      .map(buildJob);
  }

  markJob(key, status, patch = {}) {
    this.#assertOpen();
    const next = statusOf(status);
    const changes = parsePatch(patch);
    if (typeof key !== 'string') throw new TypeError('job key must be a string');
    return this.transaction(() => {
      const row = this.#jobs.get(key);
      if (!row) return false;
      this.#put(this.#jobs, key, { ...row, ...changes, status: next });
      return true;
    });
  }

  getCursor() {
    this.#assertOpen();
    const text = this.#kv.get('cursor');
    return text === undefined ? null : decodeJson(text);
  }

  setCursor(block) {
    this.#assertOpen();
    const next = cursorOf(block);
    return this.transaction(() => {
      const text = this.#kv.get('cursor');
      if (text !== undefined && cursorBehind(decodeJson(text), next)) return false;
      this.#put(this.#kv, 'cursor', encodeJson(next));
      return true;
    });
  }

  // ---- alarms -------------------------------------------------------------------------------

  #alarm(alarm) {
    const existing = this.#alarmRows.get(alarm.key);
    if (existing) {
      this.#put(this.#alarmRows, alarm.key, { ...existing, count: existing.count + 1 });
      return;
    }
    const id = (this.#kv.get('alarmSeq') ?? 0) + 1;
    this.#put(this.#kv, 'alarmSeq', id);
    this.#put(this.#alarmRows, alarm.key, {
      id,
      kind: alarm.kind,
      tableKey: alarm.tableKey,
      nonce: alarm.nonce,
      detailJson: encodeJson(alarm.detail),
      count: 1,
    });
  }

  alarms(tableKey) {
    this.#assertOpen();
    const key = tableKey === undefined ? null : keyOf(tableKey);
    return [...this.#alarmRows.values()]
      .filter((row) => key === null || row.tableKey === key)
      .sort((a, b) => a.id - b.id)
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        tableKey: row.tableKey,
        nonce: row.nonce,
        detail: decodeJson(row.detailJson),
        count: row.count,
      }));
  }
}
