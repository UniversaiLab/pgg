import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UINT64_MAX, UINT256_MAX } from '@pgg/vault';
import { SCHEMA_VERSION, SqliteStore } from '../../src/vault/sqlite-store.js';
import { DoubleSignError, StoreError } from '../../src/vault/store.js';
import { makeWorld } from '../fixtures/store-world.js';
import { runStoreContract } from './store.contract.js';

const dir = mkdtempSync(join(tmpdir(), 'pgg-sqlite-store-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let counter = 0;
const freshPath = () => join(dir, `db-${counter++}.db`);

const thrown = (fn) => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
};

runStoreContract('SqliteStore (:memory:)', () => new SqliteStore(':memory:'));
runStoreContract('SqliteStore (file)', () => new SqliteStore(freshPath()));

const w = makeWorld();

// Everything a restart must give back, in one comparable value.
function snapshot(store, upTo) {
  const signed = [];
  for (let n = 0n; n <= upTo; n++) {
    signed.push([store.getSigned(w.tableKey, n), [...store.playerSigs(w.tableKey, n)]]);
  }
  return {
    table: store.loadTable(w.tableKey),
    signed,
    round: store.openRound(w.tableKey),
    bundle: store.loadBundle(w.tableKey),
    finalBundle: store.loadFinalBundle(w.tableKey),
    jobs: store.pendingJobs(),
    cursor: store.getCursor(),
    alarms: store.alarms(),
  };
}

describe('SqliteStore: durability settings and the lease', () => {
  test('a file store runs in WAL with synchronous=FULL and an exclusive lock', () => {
    const store = new SqliteStore(freshPath());
    expect(store.settings()).toEqual({
      journalMode: 'wal',
      synchronous: 2,
      lockingMode: 'exclusive',
    });
    store.close();
  });

  test('the exclusive lock is taken before WAL, so the wal-index lives in memory and no -shm file exists', () => {
    const path = freshPath();
    new SqliteStore(path).close(); // leaves a database that is already in WAL mode
    // reopening such a file is where the order of the two pragmas shows: WAL first would map a -shm file
    const store = new SqliteStore(path);
    store.saveTable(w.record());
    expect(existsSync(`${path}-shm`)).toBe(false);
    expect(store.settings().lockingMode).toBe('exclusive');
    store.close();
  });

  test('synchronous=FULL and the exclusive lock also hold for :memory:', () => {
    const store = new SqliteStore({ path: ':memory:' });
    expect(store.settings().synchronous).toBe(2);
    expect(store.path).toBe(':memory:');
    store.close();
  });

  test('a second store on the same file fails at open with code "locked"', () => {
    const path = freshPath();
    const first = new SqliteStore(path);
    first.saveTable(w.record());
    for (let attempt = 0; attempt < 3; attempt++) {
      const started = performance.now();
      const error = thrown(() => new SqliteStore(path));
      expect(error).toBeInstanceOf(StoreError);
      expect(error.code).toBe('locked');
      // it fails at once: a second arbiter must not sit waiting for the first to let go
      expect(performance.now() - started).toBeLessThan(500);
    }
    // the failed attempts did not disturb the first store, nor did they leave a lock behind
    expect(first.loadTable(w.tableKey).tableKey).toBe(w.tableKey);
    first.saveTable(w.record({ phase: 'still works' }));
    first.close();
    const second = new SqliteStore(path);
    expect(second.loadTable(w.tableKey).phase).toBe('still works');
    second.close();
  });

  test('nothing else can read the file while a store holds it', () => {
    const path = freshPath();
    const store = new SqliteStore(path);
    const raw = new Database(path);
    expect(thrown(() => raw.query('SELECT count(*) AS n FROM sqlite_master').get())?.code).toBe(
      'SQLITE_BUSY',
    );
    raw.close();
    store.close();
  });

  test('the lease is released by close()', () => {
    const path = freshPath();
    new SqliteStore(path).close();
    const raw = new Database(path);
    expect(raw.query('SELECT count(*) AS n FROM sqlite_master').get().n).toBeGreaterThan(0);
    raw.close();
  });

  test('bad paths and options are refused', () => {
    expect(thrown(() => new SqliteStore())).toBeInstanceOf(TypeError);
    expect(thrown(() => new SqliteStore(''))).toBeInstanceOf(TypeError);
    expect(thrown(() => new SqliteStore({}))).toBeInstanceOf(TypeError);
    expect(thrown(() => new SqliteStore(5))).toBeInstanceOf(TypeError);
    expect(thrown(() => new SqliteStore(join(dir, 'no-such-dir', 'x.db')))).toBeDefined();
  });
});

describe('SqliteStore: schema', () => {
  test('carries schema_version, and opening an existing file again changes nothing', () => {
    const path = freshPath();
    const first = new SqliteStore(path);
    first.saveTable(w.record());
    first.close();
    new SqliteStore(path).close();
    new SqliteStore(path).close();
    const raw = new Database(path);
    expect(raw.query("SELECT value FROM meta WHERE key = 'schema_version'").get().value).toBe(
      String(SCHEMA_VERSION),
    );
    expect(raw.query('SELECT count(*) AS n FROM vault_tables').get().n).toBe(1);
    expect(raw.query('SELECT count(*) AS n FROM meta').get().n).toBe(1);
    raw.close();
  });

  test('a database from another schema version is refused and left alone', () => {
    const path = freshPath();
    const first = new SqliteStore(path);
    first.saveTable(w.record());
    first.close();
    const raw = new Database(path);
    raw.run("UPDATE meta SET value = '99' WHERE key = 'schema_version'");
    raw.close();
    const error = thrown(() => new SqliteStore(path));
    expect(error).toBeInstanceOf(StoreError);
    expect(error.code).toBe('schema-version');
    const check = new Database(path);
    expect(check.query("SELECT value FROM meta WHERE key = 'schema_version'").get().value).toBe(
      '99',
    );
    expect(check.query('SELECT count(*) AS n FROM vault_tables').get().n).toBe(1);
    check.close();
  });

  test("the arbiter's double-sign guard is a primary key (table_key, nonce)", () => {
    const path = freshPath();
    const store = new SqliteStore(path);
    store.saveTable(w.record());
    const state = w.stateAt(1n);
    store.reserve(w.tableKey, state, w.digestOf(state));
    store.close();
    const raw = new Database(path);
    const primaryKey = (table) =>
      raw
        .query(`PRAGMA table_info(${table})`)
        .all()
        .filter((column) => column.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((column) => column.name);
    expect(primaryKey('signed_states')).toEqual(['table_key', 'nonce']);
    expect(primaryKey('sigs')).toEqual(['table_key', 'nonce', 'address']);
    expect(primaryKey('bundles')).toEqual(['table_key', 'slot']);
    expect(primaryKey('vault_tables')).toEqual(['table_key']);
    // the database itself refuses a second row at the nonce, whatever the code above it does
    const insert = () =>
      raw.run(
        "INSERT INTO signed_states (table_key, nonce, digest, state) VALUES (?, '1', '0xdead', '{}')",
        [w.tableKey],
      );
    expect(thrown(insert)?.code).toBe('SQLITE_CONSTRAINT_PRIMARYKEY');
    raw.close();
  });

  test('bigints are stored as decimal TEXT', () => {
    const path = freshPath();
    const store = new SqliteStore(path);
    store.saveTable(w.record({ rakePaid: UINT256_MAX, dust: { [w.players[0]]: UINT256_MAX } }));
    const state = w.stateAt(UINT64_MAX, {
      balances: [UINT256_MAX, UINT256_MAX, UINT256_MAX],
      rake: UINT256_MAX,
      volume: UINT256_MAX,
    });
    store.reserve(w.tableKey, state, w.digestOf(state));
    store.close();
    const raw = new Database(path);
    const row = raw.query('SELECT typeof(nonce) AS t, nonce, state FROM signed_states').get();
    expect(row.t).toBe('text');
    expect(row.nonce).toBe(UINT64_MAX.toString());
    expect(JSON.parse(row.state).balances).toEqual(
      [UINT256_MAX, UINT256_MAX, UINT256_MAX].map(String),
    );
    const table = raw.query('SELECT * FROM vault_tables').get();
    for (const column of ['epoch_base_nonce', 'nonce_hw', 'rake_cum', 'volume_cum', 'max_signed']) {
      expect(typeof table[column]).toBe('string');
    }
    expect(table.nonce_hw).toBe(UINT64_MAX.toString());
    expect(table.rake_cum).toBe(UINT256_MAX.toString());
    raw.close();
  });

  test('integrityCheck says ok on a healthy file and on a busy one', () => {
    const store = new SqliteStore(freshPath());
    store.saveTable(w.record());
    for (let n = 1n; n <= 20n; n++) {
      const state = w.stateAt(n);
      store.reserve(w.tableKey, state, w.digestOf(state));
    }
    expect(store.integrityCheck()).toEqual(['ok']);
    store.close();
  });

  test('a file that is not a database is refused', () => {
    const path = freshPath();
    writeFileSync(path, 'this is not a sqlite database, just some text '.repeat(200));
    expect(thrown(() => new SqliteStore(path))).toBeDefined();
    expect(existsSync(path)).toBe(true);
  });
});

describe('SqliteStore: restart', () => {
  test('everything is there after close and reopen, and the double-sign guard still holds', () => {
    const path = freshPath();
    const first = new SqliteStore(path);
    first.saveTable(w.record({ dust: { [w.players[1]]: 5n } }));
    for (let n = 1n; n <= 4n; n++) {
      const state = w.stateAt(n);
      first.reserve(w.tableKey, state, w.digestOf(state));
      first.attachArbiterSig(w.tableKey, n, w.arbiterSigFor(state));
      if (n <= 3n) {
        first.addPlayerSig(w.tableKey, n, w.players[0], w.playerSigFor(state, 0));
        first.saveBundle(w.tableKey, w.bundleFor(state), w.verifyCtx());
      }
    }
    first.saveBundle(w.tableKey, w.bundleFor(w.stateAt(2n, { variant: 1n })), w.verifyCtx()); // alarm
    first.saveBundle(
      w.tableKey,
      w.bundleFor(w.stateAt(9n, { isFinal: true, keep: [true, true, true] })),
      w.verifyCtx(),
    );
    first.enqueueJob({
      key: 'settle:9',
      kind: 'settle',
      tableKey: w.tableKey,
      priority: 3,
      data: { n: 9n },
    });
    first.markJob('settle:9', 'sent', { txHash: '0xabc', attempts: 2 });
    first.setCursor(4242n);
    const before = snapshot(first, 10n);
    first.close();

    const second = new SqliteStore(path);
    expect(snapshot(second, 10n)).toEqual(before);
    expect(before.round).toBeNull();
    expect(before.alarms).toHaveLength(1);
    expect(before.cursor).toBe(4242n);
    // the guard survived the restart: a different digest at a stored nonce, an adopted nonce, anywhere
    for (const nonce of [1n, 4n, 9n]) {
      const other = w.stateAt(nonce, { variant: 5n });
      expect(thrown(() => second.reserve(w.tableKey, other, w.digestOf(other)))).toBeInstanceOf(
        DoubleSignError,
      );
    }
    const again = w.stateAt(4n);
    expect(second.reserve(w.tableKey, again, w.digestOf(again))).toBe(false);
    // and the counters did not forget anything
    expect(
      thrown(() => second.reserve(w.tableKey, w.stateAt(5n), w.digestOf(w.stateAt(5n)))),
    ).toBeInstanceOf(StoreError);
    second.close();
  });

  test('a transaction that was never committed is not there after a restart', () => {
    const path = freshPath();
    const first = new SqliteStore(path);
    first.saveTable(w.record());
    first.failAfterWrites(2);
    const state = w.stateAt(1n);
    expect(thrown(() => first.reserve(w.tableKey, state, w.digestOf(state)))).toBeDefined();
    first.close();
    const second = new SqliteStore(path);
    expect(second.getSigned(w.tableKey, 1n)).toBeNull();
    expect(second.loadTable(w.tableKey).nonceHw).toBe(0n);
    expect(second.reserve(w.tableKey, state, w.digestOf(state))).toBe(true);
    second.close();
  });
});
