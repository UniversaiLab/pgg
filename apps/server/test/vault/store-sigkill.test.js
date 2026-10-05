// The durability test for the one thing the arbiter must never get wrong: once reserve() has returned, the
// state is on disk. A child process (fixtures/sqlite-writer.js) reserves states in a loop and prints each
// nonce only after reserve() returned; this test kills it with SIGKILL at a random (seeded) moment, several
// times on the same file, and then opens the database as a restarted server would.
//
// SIGKILL stops the process but not the operating system, so this proves atomic commits and WAL recovery,
// not survival of a power cut (that is what synchronous=FULL is for, checked in sqlite-store.test.js).
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../../src/vault/sqlite-store.js';
import { DoubleSignError, StoreError } from '../../src/vault/store.js';
import { makeWorld } from '../fixtures/store-world.js';

const WRITER = new URL('../fixtures/sqlite-writer.js', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'pgg-sigkill-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const w = makeWorld();

// A small seeded generator, so a failing run can be repeated.
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const thrown = (fn) => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
};

// Start the writer and collect what it reports. With `runMs` the parent checks the lease, lets it run that
// long and kills it; with `die: [phase, n]` the child kills itself in the middle of a transaction (or, for
// settle:done, right after one committed: `committed` says the commit was reached).
async function runWriter(path, { runMs, die } = {}) {
  const child = Bun.spawn(['bun', WRITER, path, ...(die ? [die[0], String(die[1])] : [])], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const reported = [];
  let committed = false;
  let buffer = '';
  let markReady;
  const ready = new Promise((resolve) => {
    markReady = resolve;
  });
  const exitedEarly = child.exited.then((code) => {
    throw new Error(`the writer exited with ${code} before it was ready`);
  });
  exitedEarly.catch(() => {}); // only awaited through the race below

  const reading = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line === 'ready') markReady();
        else if (line === 'committed') committed = true;
        else reported.push(line);
      }
    }
  })();

  let lease;
  if (die) {
    await child.exited; // it kills itself
  } else {
    await Promise.race([ready, exitedEarly]);
    // the child holds the file now: a second arbiter on it must be refused
    lease = thrown(() => new SqliteStore(path));
    await Bun.sleep(runMs);
    child.kill('SIGKILL');
    await child.exited;
  }
  await reading;
  const stderr = await new Response(child.stderr).text();
  return { reported, committed, lease, signal: child.signalCode, stderr };
}

const parse = (lines) => lines.map((line) => line.split(' ')).map(([n, d]) => [BigInt(n), d]);

describe('SqliteStore survives SIGKILL', () => {
  test('every reported nonce is in the database with its exact digest, after repeated kills', async () => {
    const path = join(dir, 'sigkill.db');
    const random = seeded(20260607);
    const reported = new Map();
    let rounds = 0;

    for (let round = 0; round < 6; round++) {
      const result = await runWriter(path, { runMs: 60 + Math.floor(random() * 500) });
      rounds += 1;
      expect(result.signal, result.stderr).toBe('SIGKILL');
      expect(result.lease).toBeInstanceOf(StoreError); // the lease: one arbiter per database file
      expect(result.lease.code).toBe('locked');
      for (const line of result.reported) {
        const [nonce, digest] = line.split(' ');
        reported.set(BigInt(nonce), digest);
      }

      // a restarted server opens the same file
      const store = new SqliteStore(path);
      try {
        expect(store.integrityCheck()).toEqual(['ok']);
        const table = store.loadTable(w.tableKey);

        // everything the child reported is there, byte for byte
        for (const [nonce, digest] of reported) {
          const stored = store.getSigned(w.tableKey, nonce);
          expect(stored, `nonce ${nonce}`).not.toBeNull();
          expect(stored.digest).toBe(digest);
          expect(stored.digest).toBe(w.digestOf(w.stateAt(nonce)));
          expect(stored.state).toEqual(w.stateAt(nonce));
        }

        // nothing is half-written: the rows are exactly 1..nonceHw, each with the right digest and an arbiter
        // signature that is either missing (killed between reserve and attach) or the right one
        const high = table.nonceHw;
        expect(
          high >=
            (reported.size === 0 ? 0n : [...reported.keys()].reduce((a, b) => (a > b ? a : b))),
        ).toBe(true);
        for (let nonce = 1n; nonce <= high; nonce++) {
          const stored = store.getSigned(w.tableKey, nonce);
          expect(stored, `nonce ${nonce}`).not.toBeNull();
          expect(stored.digest).toBe(w.digestOf(w.stateAt(nonce)));
          expect([null, w.arbiterSigFor(w.stateAt(nonce))]).toContain(stored.arbiterSig);
        }
        expect(store.getSigned(w.tableKey, high + 1n)).toBeNull();
        // the counters moved in the same transaction as the row they belong to
        expect(table.rakeCum).toBe(high * 10n);
        expect(table.volumeCum).toBe(high * 1000n);
        expect(store.openRound(w.tableKey).nonce).toBe(high);

        // the guard survived the crash: another digest at the last nonce is still refused
        const forked = w.stateAt(high, { variant: 1n });
        expect(thrown(() => store.reserve(w.tableKey, forked, w.digestOf(forked)))).toBeInstanceOf(
          DoubleSignError,
        );
      } finally {
        store.close();
      }
    }

    // the test must have exercised something: a good number of reserves across the rounds
    expect(rounds).toBe(6);
    expect(reported.size).toBeGreaterThan(20);
  }, 60_000);

  // The timer test above lands anywhere in the loop, and a kill during the commit's fsync is harmless, so it
  // rarely hits the window that matters: after some of a transaction's writes and before its commit. Here the
  // child kills itself exactly there, after each write of a reserve and of an attach.
  test('a process killed in the middle of a transaction leaves nothing of it behind', async () => {
    const path = join(dir, 'midtx.db');
    const high = () => {
      const store = new SqliteStore(path);
      try {
        return store.loadTable(w.tableKey)?.nonceHw ?? 0n;
      } finally {
        store.close();
      }
    };
    const cases = [
      ['reserve:1', 4],
      ['reserve:2', 3],
      ['reserve:1', 1],
      ['attach:1', 5],
      ['attach:1', 1],
    ];
    new SqliteStore(path).close(); // an empty file to start from

    for (const [phase, at] of cases) {
      const before = high();
      const result = await runWriter(path, { die: [phase, at] });
      expect(result.signal, result.stderr).toBe('SIGKILL');
      const reported = parse(result.reported);
      const duringReserve = phase.startsWith('reserve');
      // the interrupted reserve never returned, so it was never reported; an interrupted attach came after it
      expect(reported.map(([n]) => n)).toEqual(
        Array.from({ length: duringReserve ? at - 1 : at }, (_, i) => before + 1n + BigInt(i)),
      );

      const store = new SqliteStore(path);
      try {
        expect(store.integrityCheck()).toEqual(['ok']);
        const table = store.loadTable(w.tableKey);
        const expectedHigh = duringReserve ? before + BigInt(at - 1) : before + BigInt(at);
        expect(table.nonceHw).toBe(expectedHigh);
        expect(table.rakeCum).toBe(expectedHigh * 10n);
        expect(table.volumeCum).toBe(expectedHigh * 1000n);
        for (const [nonce, digest] of reported) {
          expect(store.getSigned(w.tableKey, nonce).digest).toBe(digest);
        }
        expect(store.getSigned(w.tableKey, expectedHigh + 1n)).toBeNull();
        if (duringReserve) {
          // the whole reserve is gone: no row, no counter, and the nonce can be reserved afresh
          expect(store.getSigned(w.tableKey, before + BigInt(at))).toBeNull();
        } else {
          // the reserve committed; only the arbiter signature never made it
          expect(store.getSigned(w.tableKey, expectedHigh).arbiterSig).toBeNull();
          expect(store.openRound(w.tableKey).nonce).toBe(expectedHigh);
        }
        // every state before the interrupted one is complete
        const complete = duringReserve ? expectedHigh : expectedHigh - 1n;
        for (let nonce = before + 1n; nonce <= complete; nonce++) {
          expect(store.getSigned(w.tableKey, nonce).arbiterSig).toBe(
            w.arbiterSigFor(w.stateAt(nonce)),
          );
        }
        const next = w.stateAt(expectedHigh + 1n);
        expect(store.reserve(w.tableKey, next, w.digestOf(next))).toBe(true);
      } finally {
        store.close();
      }
    }
  }, 60_000);

  // The coordinator completes a round in ONE transaction: the bundle, the phase and the settle job. A crash
  // must leave all of it or none of it, or a final state could be signed by everyone and never settled.
  test('a process killed inside the settle transaction leaves none of it; one killed after it, all of it', async () => {
    const path = join(dir, 'settle.db');
    const jobKey = `chain-action:${w.tableKey}`;
    new SqliteStore(path).close(); // an empty file to start from
    const finalAt = (nonce) => w.stateAt(nonce, { isFinal: true, keep: w.players.map(() => true) });

    // after the 1st write (a player signature) up to the last write before the commit (the job)
    for (const [phase, at] of [
      ['settle:1', 1],
      ['settle:3', 2],
      ['settle:5', 1],
      ['settle:6', 2],
      ['settle:7', 1],
    ]) {
      const result = await runWriter(path, { die: [phase, at] });
      expect(result.signal, result.stderr).toBe('SIGKILL');
      expect(result.committed, `${phase} was killed after the commit`).toBe(false);
      const nonce = BigInt(result.reported.at(-1).split(' ')[0]);
      expect(result.reported).toHaveLength(at);

      const store = new SqliteStore(path);
      try {
        expect(store.integrityCheck()).toEqual(['ok']);
        // the round is exactly as it was before the transaction: reserved and signed by the arbiter, open
        const round = store.openRound(w.tableKey);
        expect(round.nonce).toBe(nonce);
        expect(round.state).toEqual(finalAt(nonce));
        expect(round.arbiterSig).toBe(w.arbiterSigFor(finalAt(nonce)));
        expect(round.playerSigs.size).toBe(0);
        expect(store.loadBundle(w.tableKey)).toBeNull();
        expect(store.loadFinalBundle(w.tableKey)).toBeNull();
        expect(store.pendingJobs()).toEqual([]);
        expect(store.getJob(jobKey)).toBeNull();
        expect(store.loadTable(w.tableKey).phase).toBe('active');
      } finally {
        store.close();
      }
    }

    // and the same transaction, left to commit, is all there
    const done = await runWriter(path, { die: ['settle:done', 1] });
    expect(done.signal, done.stderr).toBe('SIGKILL');
    expect(done.committed).toBe(true);
    const nonce = BigInt(done.reported.at(-1).split(' ')[0]);
    const store = new SqliteStore(path);
    try {
      expect(store.integrityCheck()).toEqual(['ok']);
      expect(store.loadBundle(w.tableKey)).toEqual(w.bundleFor(finalAt(nonce)));
      expect(store.loadFinalBundle(w.tableKey)).toEqual(w.bundleFor(finalAt(nonce)));
      expect(store.openRound(w.tableKey)).toBeNull();
      expect(store.getJob(jobKey)).toMatchObject({
        kind: 'settle',
        status: 'pending',
        priority: 5,
      });
      expect(store.loadTable(w.tableKey).phase).toBe('settling');
      expect([...store.playerSigs(w.tableKey, nonce).keys()]).toEqual(w.players);
    } finally {
      store.close();
    }
  }, 60_000);

  test('the writer gets the lease back after a kill, and a live one cannot be taken', async () => {
    const path = join(dir, 'lease.db');
    const first = await runWriter(path, { runMs: 150 });
    expect(first.lease?.code).toBe('locked');
    const store = new SqliteStore(path); // the dead writer's lock is gone
    store.close();
    const second = await runWriter(path, { runMs: 150 }); // and a new writer can take it again
    expect(second.lease?.code).toBe('locked');
    expect(second.signal).toBe('SIGKILL');
  }, 30_000);
});
