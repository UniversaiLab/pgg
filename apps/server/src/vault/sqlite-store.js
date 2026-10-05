// The durable StateStore on bun:sqlite. Rules (what counts as a double sign, what is newer) live in
// store.js; this file stores bytes and makes the guard physical:
//
//   - signed_states has PRIMARY KEY (table_key, nonce): the database itself refuses a second row at a
//     nonce, whatever the code above it does. reserve() relies on that insert, not only on a lookup.
//   - synchronous=FULL and WAL: a commit is on disk before reserve() returns, so the arbiter signs only
//     what survives a power cut.
//   - locking_mode=EXCLUSIVE: the open store holds the file's lock. A second store (a second arbiter on
//     the same database) fails at open. That is the lease, and it lasts as long as the store object lives.
//
// Big numbers are TEXT decimal strings and are compared as BigInt in code, never by SQL ordering. The
// highest signed nonce is kept in vault_tables.max_signed for that reason.
import { Database } from 'bun:sqlite';
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

export const SCHEMA_VERSION = 1;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS vault_tables (
     table_key TEXT PRIMARY KEY,
     epoch_base_nonce TEXT NOT NULL,
     nonce_hw TEXT NOT NULL,
     rake_cum TEXT NOT NULL,
     volume_cum TEXT NOT NULL,
     max_signed TEXT,
     body TEXT NOT NULL
   ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS signed_states (
     table_key TEXT NOT NULL,
     nonce TEXT NOT NULL,
     digest TEXT NOT NULL,
     state TEXT NOT NULL,
     arbiter_sig TEXT,
     PRIMARY KEY (table_key, nonce)
   ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS sigs (
     table_key TEXT NOT NULL,
     nonce TEXT NOT NULL,
     address TEXT NOT NULL,
     sig TEXT NOT NULL,
     PRIMARY KEY (table_key, nonce, address)
   ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS bundles (
     table_key TEXT NOT NULL,
     slot TEXT NOT NULL CHECK (slot IN ('latest', 'final')),
     nonce TEXT NOT NULL,
     digest TEXT NOT NULL,
     bundle TEXT NOT NULL,
     PRIMARY KEY (table_key, slot)
   ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS chain_cursor (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     block TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS jobs (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     key TEXT NOT NULL UNIQUE,
     kind TEXT NOT NULL,
     table_key TEXT NOT NULL,
     priority INTEGER NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'done', 'failed')),
     tx_hash TEXT,
     attempts INTEGER NOT NULL DEFAULT 0,
     error TEXT,
     data TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS alarms (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     key TEXT NOT NULL UNIQUE,
     kind TEXT NOT NULL,
     table_key TEXT NOT NULL,
     nonce TEXT NOT NULL,
     detail TEXT NOT NULL,
     count INTEGER NOT NULL DEFAULT 1
   )`,
];

const TABLE_COLUMNS =
  'table_key, epoch_base_nonce, nonce_hw, rake_cum, volume_cum, max_signed, body FROM vault_tables';

const STATEMENTS = {
  getTable: `SELECT ${TABLE_COLUMNS} WHERE table_key = ?`,
  allTables: `SELECT ${TABLE_COLUMNS} ORDER BY table_key`,
  insertTable: `INSERT INTO vault_tables
    (table_key, epoch_base_nonce, nonce_hw, rake_cum, volume_cum, max_signed, body)
    VALUES (?, ?, ?, ?, ?, NULL, ?)`,
  updateTable: `UPDATE vault_tables
    SET epoch_base_nonce = ?, nonce_hw = ?, rake_cum = ?, volume_cum = ?, body = ?
    WHERE table_key = ?`,
  advanceTable: `UPDATE vault_tables
    SET nonce_hw = ?, rake_cum = ?, volume_cum = ?, max_signed = ?
    WHERE table_key = ?`,

  getSigned:
    'SELECT digest, state, arbiter_sig FROM signed_states WHERE table_key = ? AND nonce = ?',
  insertSigned: `INSERT INTO signed_states (table_key, nonce, digest, state, arbiter_sig)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT (table_key, nonce) DO NOTHING`,
  setArbiterSig:
    'UPDATE signed_states SET arbiter_sig = ? WHERE table_key = ? AND nonce = ? AND arbiter_sig IS NULL',

  getSig: 'SELECT sig FROM sigs WHERE table_key = ? AND nonce = ? AND address = ?',
  allSigs: 'SELECT address, sig FROM sigs WHERE table_key = ? AND nonce = ?',
  insertSig: `INSERT INTO sigs (table_key, nonce, address, sig) VALUES (?, ?, ?, ?)
    ON CONFLICT (table_key, nonce, address) DO NOTHING`,

  getBundle: 'SELECT nonce, digest, bundle FROM bundles WHERE table_key = ? AND slot = ?',
  putBundle: `INSERT INTO bundles (table_key, slot, nonce, digest, bundle) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (table_key, slot) DO UPDATE
    SET nonce = excluded.nonce, digest = excluded.digest, bundle = excluded.bundle`,

  getCursor: 'SELECT block FROM chain_cursor WHERE id = 1',
  putCursor: `INSERT INTO chain_cursor (id, block) VALUES (1, ?)
    ON CONFLICT (id) DO UPDATE SET block = excluded.block`,

  insertJob: `INSERT INTO jobs (key, kind, table_key, priority, status, data)
    VALUES (?, ?, ?, ?, 'pending', ?)`,
  getJob: 'SELECT * FROM jobs WHERE key = ?',
  deleteJob: 'DELETE FROM jobs WHERE key = ?',
  pendingJobs: "SELECT * FROM jobs WHERE status <> 'done' ORDER BY priority DESC, seq ASC",
  updateJob: 'UPDATE jobs SET status = ?, tx_hash = ?, attempts = ?, error = ? WHERE key = ?',

  upsertAlarm: `INSERT INTO alarms (key, kind, table_key, nonce, detail) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET count = count + 1`,
  allAlarms: 'SELECT * FROM alarms ORDER BY id',
  tableAlarms: 'SELECT * FROM alarms WHERE table_key = ? ORDER BY id',
};

const FINISHED = new Set(JOB_FINISHED);

const jobRow = (r) => ({
  key: r.key,
  kind: r.kind,
  tableKey: r.table_key,
  priority: r.priority,
  status: r.status,
  txHash: r.tx_hash,
  attempts: r.attempts,
  error: r.error,
  dataJson: r.data,
});

function openError(error, path) {
  if (error instanceof StoreError) return error;
  if (error?.code === 'SQLITE_BUSY' || error?.code === 'SQLITE_LOCKED') {
    return new StoreError(
      'locked',
      `${path} is already open in another store (one arbiter per database)`,
      {
        cause: error,
      },
    );
  }
  return error;
}

export class SqliteStore {
  #db;
  #path;
  #q = {};
  #depth = 0;
  #writes = 0;
  #failIn = null;
  #failError = null;

  /** @param {string | { path: string }} options  a file path, or ':memory:' for tests */
  constructor(options) {
    const path = typeof options === 'string' ? options : options?.path;
    if (typeof path !== 'string' || path === '')
      throw new TypeError('SqliteStore needs a database path');
    this.#path = path;
    const db = new Database(path);
    try {
      this.#configure(db, path);
      for (const [name, sql] of Object.entries(STATEMENTS)) this.#q[name] = db.prepare(sql);
    } catch (error) {
      for (const statement of Object.values(this.#q)) statement.finalize();
      db.close();
      throw openError(error, path);
    }
    this.#db = db;
  }

  // The pragmas come first and in this order: the exclusive lock must be set before WAL is entered, and
  // the first real read or write is what takes the lock, so the schema transaction below does it at once.
  #configure(db, path) {
    const memory = path === ':memory:';
    db.run('PRAGMA busy_timeout = 0'); // a second arbiter must fail now, not after waiting
    db.run('PRAGMA locking_mode = EXCLUSIVE');
    const journal = db.query('PRAGMA journal_mode = WAL').get().journal_mode;
    if (!memory && journal !== 'wal') {
      throw new StoreError('journal-mode', `${path} cannot use WAL (got ${journal})`);
    }
    db.run('PRAGMA synchronous = FULL');
    if (db.query('PRAGMA synchronous').get().synchronous !== 2) {
      throw new StoreError('synchronous', 'synchronous=FULL did not take effect');
    }
    if (!memory && db.query('PRAGMA locking_mode').get().locking_mode !== 'exclusive') {
      throw new StoreError('locking-mode', 'the exclusive lock did not take effect');
    }

    db.run('BEGIN IMMEDIATE');
    try {
      db.run(
        'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID',
      );
      db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', [
        'schema_version',
        String(SCHEMA_VERSION),
      ]);
      const { value } = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get();
      if (value !== String(SCHEMA_VERSION)) {
        throw new StoreError(
          'schema-version',
          `${path} has schema version ${value}, this code is version ${SCHEMA_VERSION}`,
        );
      }
      for (const ddl of SCHEMA) db.run(ddl);
      db.run('COMMIT');
    } catch (error) {
      db.run('ROLLBACK');
      throw error;
    }
  }

  // ---- plumbing -----------------------------------------------------------------------------

  #assertOpen() {
    if (this.#db === undefined) throw closedError();
  }

  // The one place a write statement runs. It also counts the write for failAfterWrites, so the crash
  // hook needs no separate code path in production.
  #run(statement, ...args) {
    const result = statement.run(...args);
    this.#writes += 1;
    if (this.#failIn !== null && --this.#failIn === 0) {
      this.#failIn = null;
      throw typeof this.#failError === 'function' ? this.#failError() : this.#failError;
    }
    return result;
  }

  get path() {
    return this.#path;
  }

  /** Total write statements since the store was opened (the unit failAfterWrites counts in). */
  get writeCount() {
    return this.#writes;
  }

  /**
   * Test hook for crash points: the k-th write statement from now runs and then `error` is thrown, which
   * rolls the surrounding transaction back. `error` may be a function: it is called at that moment and
   * what it returns is thrown, so a test can also kill the whole process there (the SIGKILL test does).
   * `null` disarms. It fires once.
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

  /** The durability settings of this connection, read back from SQLite (the tests check them). */
  settings() {
    this.#assertOpen();
    const read = (name) => Object.values(this.#db.query(`PRAGMA ${name}`).get())[0];
    return {
      journalMode: read('journal_mode'),
      synchronous: read('synchronous'),
      lockingMode: read('locking_mode'),
    };
  }

  /** PRAGMA integrity_check: ['ok'] when the file is sound, otherwise what is wrong. */
  integrityCheck() {
    this.#assertOpen();
    return this.#db
      .query('PRAGMA integrity_check')
      .all()
      .map((row) => row.integrity_check);
  }

  // A nested call gets a SAVEPOINT: it joins the outer commit, but if it fails alone its own writes are
  // undone even when the caller catches the error and carries on.
  transaction(fn) {
    this.#assertOpen();
    if (typeof fn !== 'function') throw new TypeError('transaction needs a function');
    const outer = this.#depth === 0;
    const savepoint = `pgg_nested_${this.#depth}`;
    this.#db.run(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    this.#depth += 1;
    let result;
    try {
      result = fn();
      if (isThenable(result)) {
        throw new StoreError('async-transaction', 'a transaction callback must be synchronous');
      }
    } catch (error) {
      this.#depth -= 1;
      this.#undo(outer, savepoint);
      throw error;
    }
    this.#depth -= 1;
    try {
      this.#db.run(outer ? 'COMMIT' : `RELEASE ${savepoint}`);
    } catch (error) {
      this.#undo(outer, savepoint);
      throw error;
    }
    return result;
  }

  #undo(outer, savepoint) {
    try {
      if (outer) {
        this.#db.run('ROLLBACK');
      } else {
        this.#db.run(`ROLLBACK TO ${savepoint}`);
        this.#db.run(`RELEASE ${savepoint}`);
      }
    } catch (error) {
      // After an I/O error SQLite may already have rolled back, and then there is nothing left to undo.
      // If a transaction is somehow still open, the next BEGIN fails loudly instead of corrupting.
      if (this.#db.inTransaction) throw error;
    }
  }

  close() {
    if (this.#db === undefined) return;
    if (this.#depth > 0)
      throw new StoreError('in-transaction', 'cannot close inside a transaction');
    for (const statement of Object.values(this.#q)) statement.finalize();
    this.#db.close();
    this.#db = undefined;
  }

  // ---- row helpers --------------------------------------------------------------------------

  #tableRow(key) {
    const r = this.#q.getTable.get(key);
    return r ? this.#tableFrom(r) : null;
  }

  #tableFrom(r) {
    return {
      hot: {
        epochBaseNonce: BigInt(r.epoch_base_nonce),
        nonceHw: BigInt(r.nonce_hw),
        rakeCum: BigInt(r.rake_cum),
        volumeCum: BigInt(r.volume_cum),
      },
      maxSigned: r.max_signed === null ? null : BigInt(r.max_signed),
      bodyJson: r.body,
    };
  }

  #signedRow(key, nonce) {
    const r = this.#q.getSigned.get(key, nonce.toString());
    return r ? { digest: r.digest, stateJson: r.state, arbiterSig: r.arbiter_sig } : null;
  }

  #sigMap(key, nonce) {
    const byAddress = new Map();
    for (const r of this.#q.allSigs.all(key, nonce.toString())) byAddress.set(r.address, r.sig);
    return byAddress;
  }

  #slot(key, which) {
    const r = this.#q.getBundle.get(key, which);
    return r ? { nonce: BigInt(r.nonce), digest: r.digest, json: r.bundle } : null;
  }

  #putTableCounters(key, table, counters, maxSigned) {
    this.#run(
      this.#q.advanceTable,
      counters.nonceHw.toString(),
      counters.rakeCum.toString(),
      counters.volumeCum.toString(),
      maxSigned === null ? null : maxSigned.toString(),
      key,
    );
    return { ...table, hot: { ...table.hot, ...counters }, maxSigned };
  }

  // ---- tables -------------------------------------------------------------------------------

  loadTable(tableKey) {
    this.#assertOpen();
    const key = keyOf(tableKey);
    const table = this.#tableRow(key);
    return table ? buildRecord(key, table.hot, table.bodyJson) : null;
  }

  saveTable(record) {
    this.#assertOpen();
    const parsed = parseTableRecord(record);
    return this.transaction(() => {
      const stored = this.#tableRow(parsed.tableKey);
      const { hot, bodyJson } = mergeTable(stored, parsed);
      if (stored) {
        this.#run(
          this.#q.updateTable,
          hot.epochBaseNonce.toString(),
          hot.nonceHw.toString(),
          hot.rakeCum.toString(),
          hot.volumeCum.toString(),
          bodyJson,
          parsed.tableKey,
        );
      } else {
        this.#run(
          this.#q.insertTable,
          parsed.tableKey,
          hot.epochBaseNonce.toString(),
          hot.nonceHw.toString(),
          hot.rakeCum.toString(),
          hot.volumeCum.toString(),
          bodyJson,
        );
      }
      return buildRecord(parsed.tableKey, hot, bodyJson);
    });
  }

  listTables() {
    this.#assertOpen();
    return this.#q.allTables.all().map((r) => {
      const table = this.#tableFrom(r);
      return buildRecord(r.table_key, table.hot, table.bodyJson);
    });
  }

  // ---- signed states ------------------------------------------------------------------------

  reserve(tableKey, state, digest) {
    this.#assertOpen();
    const input = parseReserve(tableKey, state, digest);
    return this.transaction(() => {
      const table = this.#tableRow(input.tableKey);
      // The primary key answers first: either the row goes in, or something is already stored at this
      // nonce and the insert changes nothing. A refusal below throws, and the transaction takes the
      // inserted row back out.
      const inserted =
        this.#run(
          this.#q.insertSigned,
          input.tableKey,
          input.nonce.toString(),
          input.digest,
          input.stateJson,
          null,
        ).changes === 1;
      const existing = inserted ? null : this.#signedRow(input.tableKey, input.nonce);
      if (decideReserve(input, table?.hot ?? null, existing) === 'repeat') return false;
      this.#putTableCounters(
        input.tableKey,
        table,
        advanceCounters(table.hot, input.state),
        nextMax(table.maxSigned, input.nonce),
      );
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
      if (verdict === 'store') this.#run(this.#q.setArbiterSig, signature, key, n.toString());
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
      const existing = this.#q.getSig.get(key, n.toString(), player)?.sig ?? null;
      const verdict = decideSig(existing, signature);
      if (verdict === 'store') this.#run(this.#q.insertSig, key, n.toString(), player, signature);
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
    return orderSigs(JSON.parse(row.stateJson), this.#sigMap(key, n));
  }

  getSigned(tableKey, nonce) {
    this.#assertOpen();
    const row = this.#signedRow(keyOf(tableKey), nonceOf(nonce));
    return row ? decodeSigned(row) : null;
  }

  latestSigned(tableKey, { anyEpoch = false } = {}) {
    this.#assertOpen();
    const key = keyOf(tableKey);
    const table = this.#tableRow(key);
    if (!table) return null;
    const nonce = latestSignedNonce({
      epochBaseNonce: table.hot.epochBaseNonce,
      maxSigned: table.maxSigned,
      anyEpoch,
    });
    return nonce === null ? null : decodeSigned(this.#signedRow(key, nonce));
  }

  openRound(tableKey) {
    this.#assertOpen();
    const key = keyOf(tableKey);
    const table = this.#tableRow(key);
    if (!table) return null;
    const nonce = openRoundNonce({
      epochBaseNonce: table.hot.epochBaseNonce,
      maxSigned: table.maxSigned,
      latestBundleNonce: this.#slot(key, 'latest')?.nonce ?? null,
    });
    if (nonce === null) return null;
    const row = this.#signedRow(key, nonce);
    return {
      nonce,
      ...decodeSigned(row),
      playerSigs: orderSigs(JSON.parse(row.stateJson), this.#sigMap(key, nonce)),
    };
  }

  // ---- bundles ------------------------------------------------------------------------------

  saveBundle(tableKey, bundle, verifyCtx) {
    this.#assertOpen();
    const key = keyOf(tableKey);
    const checked = checkBundleForSave(key, bundle, verifyCtx);
    if (!checked.ok) return checked.result;
    return this.transaction(() => {
      const table = this.#tableRow(key);
      if (!table) throw new StoreError('unknown-table', `unknown table ${key}`);
      const { bundle: b, digest } = checked;
      const nonce = b.state.nonce;
      const row = this.#signedRow(key, nonce);
      const decision = decideBundle({
        nonce,
        digest,
        epochBaseNonce: table.hot.epochBaseNonce,
        signedDigest: row?.digest ?? null,
        latest: this.#slot(key, 'latest'),
      });
      if (decision.verdict === 'conflict') {
        this.#alarm(bundleConflictAlarm(key, nonce, decision.stored, digest));
        return { saved: false, reason: 'conflict' };
      }
      if (decision.verdict !== 'save') return { saved: false, reason: decision.verdict };

      // A bundle we never reserved (adopted after a lost database) must also close the double-sign
      // guard at its nonce, or the arbiter could later sign a different state there.
      if (!row) {
        this.#run(
          this.#q.insertSigned,
          key,
          nonce.toString(),
          digest,
          JSON.stringify(toWire(b.state)),
          b.arbiterSig,
        );
        this.#putTableCounters(
          key,
          table,
          advanceCounters(table.hot, b.state),
          nextMax(table.maxSigned, nonce),
        );
      } else if (row.arbiterSig === null) {
        this.#run(this.#q.setArbiterSig, b.arbiterSig, key, nonce.toString());
      }
      b.state.players.forEach((player, i) => {
        this.#run(this.#q.insertSig, key, nonce.toString(), player, b.playerSigs[i]);
      });
      const json = JSON.stringify(bundleToWire(b));
      this.#run(this.#q.putBundle, key, 'latest', nonce.toString(), digest, json);
      if (b.state.isFinal)
        this.#run(this.#q.putBundle, key, 'final', nonce.toString(), digest, json);
      return { saved: true };
    });
  }

  loadBundle(tableKey) {
    this.#assertOpen();
    const key = keyOf(tableKey);
    const table = this.#tableRow(key);
    const slot = this.#slot(key, 'latest');
    if (!table || !slot || slot.nonce <= table.hot.epochBaseNonce) return null;
    return bundleFromWire(JSON.parse(slot.json));
  }

  loadFinalBundle(tableKey) {
    this.#assertOpen();
    const slot = this.#slot(keyOf(tableKey), 'final');
    return slot ? bundleFromWire(JSON.parse(slot.json)) : null;
  }

  // ---- jobs and cursor ----------------------------------------------------------------------

  // The key is the job's identity while it is in flight (pending or sent): asking again is a no-op. A job
  // that is done or failed no longer holds its key, because one key means "this action on this table" and
  // the next epoch needs the same action again. That job is replaced by a fresh pending one (at the back
  // of the queue, with its attempts and error cleared).
  enqueueJob(job) {
    this.#assertOpen();
    const parsed = parseJob(job);
    return this.transaction(() => {
      const existing = this.#q.getJob.get(parsed.key);
      if (existing && !FINISHED.has(existing.status)) return false;
      if (existing) this.#run(this.#q.deleteJob, parsed.key);
      this.#run(
        this.#q.insertJob,
        parsed.key,
        parsed.kind,
        parsed.tableKey,
        parsed.priority,
        parsed.dataJson,
      );
      return true;
    });
  }

  getJob(key) {
    this.#assertOpen();
    const r = this.#q.getJob.get(key);
    return r ? buildJob(jobRow(r)) : null;
  }

  pendingJobs() {
    this.#assertOpen();
    return this.#q.pendingJobs.all().map((r) => buildJob(jobRow(r)));
  }

  markJob(key, status, patch = {}) {
    this.#assertOpen();
    const next = statusOf(status);
    const changes = parsePatch(patch);
    if (typeof key !== 'string') throw new TypeError('job key must be a string');
    return this.transaction(() => {
      const r = this.#q.getJob.get(key);
      if (!r) return false;
      const merged = { txHash: r.tx_hash, attempts: r.attempts, error: r.error, ...changes };
      this.#run(this.#q.updateJob, next, merged.txHash, merged.attempts, merged.error, key);
      return true;
    });
  }

  getCursor() {
    this.#assertOpen();
    const r = this.#q.getCursor.get();
    return r ? decodeJson(r.block) : null;
  }

  setCursor(block) {
    this.#assertOpen();
    const next = cursorOf(block);
    return this.transaction(() => {
      const r = this.#q.getCursor.get();
      if (r && cursorBehind(decodeJson(r.block), next)) return false;
      this.#run(this.#q.putCursor, encodeJson(next));
      return true;
    });
  }

  // ---- alarms -------------------------------------------------------------------------------

  #alarm(alarm) {
    this.#run(
      this.#q.upsertAlarm,
      alarm.key,
      alarm.kind,
      alarm.tableKey,
      alarm.nonce.toString(),
      encodeJson(alarm.detail),
    );
  }

  alarms(tableKey) {
    this.#assertOpen();
    const rows =
      tableKey === undefined ? this.#q.allAlarms.all() : this.#q.tableAlarms.all(keyOf(tableKey));
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      tableKey: r.table_key,
      nonce: BigInt(r.nonce),
      detail: decodeJson(r.detail),
      count: r.count,
    }));
  }
}
