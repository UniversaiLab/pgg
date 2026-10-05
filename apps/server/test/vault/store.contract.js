// The StateStore contract: ONE suite that MemoryStore and SqliteStore must both pass
// (docs/signing-layer.md section 4). It is not a *.test.js file on purpose; memory-store.test.js and
// sqlite-store.test.js call runStoreContract with a factory for their store.
//
// What matters most here is money and safety: one digest per nonce for ever (F10), counters that never
// move backwards, a bundle that is verified before it is kept, and every multi-write operation being
// all-or-nothing (the crash-point tests stop each one after each of its writes).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  hashState,
  makeBundle,
  privateKeyToAddress,
  signDigest,
  UINT64_MAX,
  UINT256_MAX,
} from '@pgg/vault';
import { DoubleSignError, STORE_METHODS, StoreError } from '../../src/vault/store.js';
import { DOMAIN, keyFor, makeWorld, VAULT } from '../fixtures/store-world.js';

const w = makeWorld();
// Same players and keys, another generation: a different tableKey, so the same nonce is a different state
// with a different digest.
const w2 = makeWorld({ generation: 2 });
const OTHER_TABLE = `0x${'22'.repeat(32)}`;

const thrown = (fn) => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
};

const expectStoreError = (fn, code) => {
  const error = thrown(fn);
  expect(error).toBeInstanceOf(StoreError);
  expect(error.code).toBe(code);
  return error;
};

// Everything observable about a table, so "changes nothing" can be one toEqual.
function view(store, maxNonce = 12n) {
  const signed = [];
  const sigs = [];
  for (let n = 0n; n <= maxNonce; n++) {
    signed.push(store.getSigned(w.tableKey, n));
    sigs.push([...store.playerSigs(w.tableKey, n)]);
  }
  return {
    tables: store.listTables(),
    signed,
    sigs,
    round: store.openRound(w.tableKey),
    latest: store.latestSigned(w.tableKey, { anyEpoch: true }),
    bundle: store.loadBundle(w.tableKey),
    finalBundle: store.loadFinalBundle(w.tableKey),
    jobs: store.pendingJobs(),
    cursor: store.getCursor(),
    alarms: store.alarms(),
  };
}

// Reserve states 1..n of the standard table, in order, the way the arbiter would.
function reserveUpTo(store, n, options = {}) {
  for (let nonce = 1n; nonce <= BigInt(n); nonce++) {
    const state = w.stateAt(nonce, options);
    store.reserve(w.tableKey, state, w.digestOf(state));
  }
}

export function runStoreContract(name, makeStore) {
  describe(`StateStore contract: ${name}`, () => {
    let store;

    beforeEach(() => {
      store = makeStore();
      store.saveTable(w.record());
    });

    afterEach(() => {
      store.close();
    });

    const reserve = (nonce, options) => {
      const state = w.stateAt(BigInt(nonce), options);
      return store.reserve(w.tableKey, state, w.digestOf(state));
    };

    // Run `run` against a fresh store prepared by `setup`, once with a failure after each of its writes.
    // After every failure the store must look exactly as it did before, must still work, and the
    // operation must then complete into exactly the state a clean run produces.
    function crashPoints({ setup = () => {}, run, minWrites = 1 }) {
      const reference = makeStore();
      reference.saveTable(w.record());
      setup(reference);
      const writesBefore = reference.writeCount;
      run(reference);
      const total = reference.writeCount - writesBefore;
      const after = view(reference);
      reference.close();
      expect(total).toBeGreaterThanOrEqual(minWrites);

      for (let k = 1; k <= total; k++) {
        const s = makeStore();
        s.saveTable(w.record());
        setup(s);
        const before = view(s);
        s.failAfterWrites(k);
        const error = thrown(() => run(s));
        expect(error?.message).toBe('injected store failure');
        expect(view(s)).toEqual(before);
        s.failAfterWrites(null);
        run(s);
        expect(view(s)).toEqual(after);
        s.close();
      }
    }

    // ---- table records ------------------------------------------------------------------

    describe('table records', () => {
      test('saveTable then loadTable keeps every field, bigints exact', () => {
        const record = w.record({
          tableKey: OTHER_TABLE,
          epochBaseNonce: 5n,
          nonceHw: 9n,
          rakeCum: 2n ** 200n,
          volumeCum: UINT256_MAX,
          rakePaid: 77n,
          dust: { [w.players[0]]: 7n, [w.players[1]]: UINT256_MAX },
          lastAppliedEvent: { block: 123456789012n, logIndex: 4 },
          roster: [{ address: w.players[0], seat: 0, deposit: 2n ** 255n }, null, 'x', [1, 2n]],
          somethingNew: { nested: [true, 'a', 3n] },
        });
        expect(store.saveTable(record)).toEqual(record);
        expect(store.loadTable(OTHER_TABLE)).toEqual(record);
        const loaded = store.loadTable(OTHER_TABLE);
        expect(typeof loaded.nonceHw).toBe('bigint');
        expect(typeof loaded.dust[w.players[1]]).toBe('bigint');
      });

      test('missing counters default to zero, dust to empty, lastAppliedEvent to null', () => {
        const { pinned } = w.record();
        const saved = store.saveTable({ tableKey: OTHER_TABLE, pinned });
        expect(saved).toEqual({
          tableKey: OTHER_TABLE,
          pinned,
          epochBaseNonce: 0n,
          nonceHw: 0n,
          rakeCum: 0n,
          volumeCum: 0n,
          rakePaid: 0n,
          dust: {},
          lastAppliedEvent: null,
        });
      });

      test('a table key is a non-empty string of at most 256 characters', () => {
        const longest = `0x${'a'.repeat(254)}`;
        expect(store.loadTable(longest)).toBeNull();
        for (const bad of [`${longest}a`, '', 5, null, undefined, {}]) {
          expect(thrown(() => store.loadTable(bad))).toBeInstanceOf(TypeError);
        }
        expect(thrown(() => store.saveTable(w.record({ tableKey: `${longest}a` })))).toBeInstanceOf(
          TypeError,
        );
        expect(store.saveTable(w.record({ tableKey: longest })).tableKey).toBe(longest);
      });

      test('an unknown table loads as null and keys are case-insensitive', () => {
        expect(store.loadTable(OTHER_TABLE)).toBeNull();
        expect(store.loadTable(w.tableKey.toUpperCase().replace('0X', '0x'))).toEqual(
          store.loadTable(w.tableKey),
        );
      });

      test('what loadTable returns is a copy, and so is what saveTable was given', () => {
        const record = w.record();
        store.saveTable(record);
        record.phase = 'tampered';
        record.dust[w.players[0]] = 999n;
        record.pinned.numSeats = 2;
        const loaded = store.loadTable(w.tableKey);
        expect(loaded.phase).toBe('active');
        expect(loaded.dust[w.players[0]]).toBe(7n);
        loaded.roster.push('junk');
        loaded.pinned.chipUnit = 1n;
        expect(store.loadTable(w.tableKey)).toEqual(w.record());
      });

      test('pinned config cannot change for a tableKey, whatever the key order', () => {
        const same = w.record({
          pinned: { numSeats: 6, rakeBps: 200, blinds: { big: 10, small: 5 }, chipUnit: 10_000n },
        });
        expect(store.saveTable(same).pinned.rakeBps).toBe(200);
        for (const pinned of [
          { ...w.record().pinned, chipUnit: 1n },
          { ...w.record().pinned, rakeBps: 300 },
          { ...w.record().pinned, extra: 1 },
          { chipUnit: 10_000n },
        ]) {
          const before = view(store);
          expectStoreError(() => store.saveTable(w.record({ pinned })), 'pinned-changed');
          expect(view(store)).toEqual(before);
        }
      });

      test('saveTable never moves nonceHw, rakeCum or volumeCum backwards', () => {
        reserveUpTo(store, 4);
        const stale = w.record({ phase: 'later', nonceHw: 1n, rakeCum: 5n, volumeCum: 6n });
        const saved = store.saveTable(stale);
        expect(saved).toMatchObject({
          phase: 'later',
          nonceHw: 4n,
          rakeCum: 40n,
          volumeCum: 4000n,
        });
        expect(store.loadTable(w.tableKey)).toEqual(saved);
        // each counter on its own
        const mixed = store.saveTable(w.record({ nonceHw: 9n, rakeCum: 0n, volumeCum: 99_999n }));
        expect(mixed).toMatchObject({ nonceHw: 9n, rakeCum: 40n, volumeCum: 99_999n });
        const mixed2 = store.saveTable(w.record({ nonceHw: 0n, rakeCum: 41n, volumeCum: 0n }));
        expect(mixed2).toMatchObject({ nonceHw: 9n, rakeCum: 41n, volumeCum: 99_999n });
      });

      test('the high-water mark is never below the epoch base, and the base never goes back', () => {
        reserveUpTo(store, 3);
        const moved = store.saveTable(w.record({ epochBaseNonce: 3n, nonceHw: 0n }));
        expect(moved.epochBaseNonce).toBe(3n);
        const adopted = store.saveTable(w.record({ epochBaseNonce: 20n, nonceHw: 0n }));
        expect(adopted).toMatchObject({ epochBaseNonce: 20n, nonceHw: 20n });
        const before = view(store);
        expectStoreError(
          () => store.saveTable(w.record({ epochBaseNonce: 19n })),
          'epoch-base-regression',
        );
        expect(view(store)).toEqual(before);
        // a brand-new table starts with the same rule
        const fresh = store.saveTable(w.record({ tableKey: OTHER_TABLE, epochBaseNonce: 8n }));
        expect(fresh.nonceHw).toBe(8n);
      });

      test('malformed records are refused and change nothing', () => {
        const before = view(store);
        const bad = [
          [null, TypeError],
          [{ ...w.record(), tableKey: '' }, TypeError],
          [{ ...w.record(), tableKey: 5 }, TypeError],
          [{ ...w.record(), pinned: undefined }, TypeError],
          [{ ...w.record(), pinned: [] }, TypeError],
          [{ ...w.record(), nonceHw: 'x' }, TypeError],
          [{ ...w.record(), nonceHw: -1n }, RangeError],
          [{ ...w.record(), epochBaseNonce: UINT64_MAX + 1n }, RangeError],
          [{ ...w.record(), rakeCum: UINT256_MAX + 1n }, RangeError],
          [{ ...w.record(), rakePaid: -1n }, RangeError],
          [{ ...w.record(), dust: [] }, TypeError],
          [{ ...w.record(), dust: { a: -1n } }, RangeError],
          [{ ...w.record(), dust: { a: 'x' } }, TypeError],
          [{ ...w.record(), lastAppliedEvent: { block: 1n } }, TypeError],
          [{ ...w.record(), lastAppliedEvent: 5 }, TypeError],
          [{ ...w.record(), roster: new Map() }, TypeError],
          [{ ...w.record(), roster: [undefined] }, TypeError],
          [{ ...w.record(), roster: [Number.NaN] }, RangeError],
          [{ ...w.record(), extra: () => 1 }, TypeError],
          [{ ...w.record(), extra: { $bigint: '1' } }, TypeError],
        ];
        for (const [record, kind] of bad) {
          expect(thrown(() => store.saveTable(record))).toBeInstanceOf(kind);
        }
        expect(view(store)).toEqual(before);
      });

      test('values JSON cannot hold are refused instead of being changed', () => {
        // an undefined property is simply absent, an undefined array item is an error (see above)
        const saved = store.saveTable(w.record({ gone: undefined, kept: 0 }));
        expect('gone' in saved).toBe(false);
        expect(saved.kept).toBe(0);
        expect(thrown(() => store.saveTable(w.record({ deep: nest(40) })))).toBeInstanceOf(
          RangeError,
        );
      });

      test('listTables lists every table, ordered by key', () => {
        store.saveTable(w.record({ tableKey: OTHER_TABLE }));
        const keys = store.listTables().map((t) => t.tableKey);
        expect(keys).toEqual([w.tableKey, OTHER_TABLE].sort());
      });
    });

    // ---- reserve ------------------------------------------------------------------------

    describe('reserve', () => {
      test('stores a state exactly: 2^256-1 amounts, 2^64-1 nonce, keep flags, isFinal', () => {
        const state = w.stateAt(UINT64_MAX, {
          isFinal: true,
          keep: [true, false, true],
          balances: [UINT256_MAX, 0n, UINT256_MAX - 1n],
          rake: UINT256_MAX,
          volume: UINT256_MAX,
        });
        const digest = w.digestOf(state);
        expect(store.reserve(w.tableKey, state, digest)).toBe(true);
        const stored = store.getSigned(w.tableKey, UINT64_MAX);
        expect(stored).toEqual({ state, digest, arbiterSig: null });
        expect(stored.state.balances[0]).toBe(UINT256_MAX);
        expect(stored.state.keep).toEqual([true, false, true]);
        expect(store.loadTable(w.tableKey)).toMatchObject({
          nonceHw: UINT64_MAX,
          rakeCum: UINT256_MAX,
          volumeCum: UINT256_MAX,
        });
      });

      test('the state handed in is not kept by reference', () => {
        const state = w.stateAt(1n);
        const digest = w.digestOf(state);
        store.reserve(w.tableKey, state, digest);
        state.balances[0] = 0n;
        state.players.pop();
        const stored = store.getSigned(w.tableKey, 1n);
        expect(stored.state).toEqual(w.stateAt(1n));
        stored.state.balances[1] = 0n;
        expect(store.getSigned(w.tableKey, 1n).state).toEqual(w.stateAt(1n));
      });

      test('the same digest again is idempotent: false the second time, nothing changes', () => {
        expect(reserve(1)).toBe(true);
        store.attachArbiterSig(w.tableKey, 1n, w.arbiterSigFor(w.stateAt(1n)));
        const before = view(store);
        expect(reserve(1)).toBe(false);
        expect(view(store)).toEqual(before);
        expect(store.getSigned(w.tableKey, 1n).arbiterSig).toBe(w.arbiterSigFor(w.stateAt(1n)));
      });

      test('a different digest at an existing nonce is a DoubleSignError and changes nothing', () => {
        reserveUpTo(store, 3);
        const before = view(store);
        const other = w.stateAt(3n, { variant: 1n });
        const error = thrown(() => store.reserve(w.tableKey, other, w.digestOf(other)));
        expect(error).toBeInstanceOf(DoubleSignError);
        expect(error).toBeInstanceOf(StoreError);
        expect(error.code).toBe('double-sign');
        expect(error.nonce).toBe(3n);
        expect(error.stored).toBe(w.digestOf(w.stateAt(3n)));
        expect(error.attempted).toBe(w.digestOf(other));
        expect(view(store)).toEqual(before);
        expect(store.getSigned(w.tableKey, 3n).digest).toBe(w.digestOf(w.stateAt(3n)));
      });

      test('a double sign is caught at the first nonce, the middle one and the highest', () => {
        reserveUpTo(store, 5);
        for (const nonce of [1n, 3n, 5n]) {
          const other = w.stateAt(nonce, { variant: 2n });
          expect(thrown(() => store.reserve(w.tableKey, other, w.digestOf(other)))).toBeInstanceOf(
            DoubleSignError,
          );
        }
      });

      test('a double sign outranks the epoch-base refusal; a plain repeat below the base is refused', () => {
        reserveUpTo(store, 3);
        store.saveTable(w.record({ epochBaseNonce: 3n }));
        const other = w.stateAt(2n, { variant: 1n });
        expect(thrown(() => store.reserve(w.tableKey, other, w.digestOf(other)))).toBeInstanceOf(
          DoubleSignError,
        );
        const same = w.stateAt(2n);
        expectStoreError(
          () => store.reserve(w.tableKey, same, w.digestOf(same)),
          'below-epoch-base',
        );
      });

      test('advances nonceHw, rakeCum and volumeCum, and only forward', () => {
        const a = w.stateAt(5n, { rake: 50n, volume: 500n });
        store.reserve(w.tableKey, a, w.digestOf(a));
        expect(store.loadTable(w.tableKey)).toMatchObject({
          nonceHw: 5n,
          rakeCum: 50n,
          volumeCum: 500n,
        });
        const lower = w.stateAt(6n, { rake: 10n, volume: 100n });
        store.reserve(w.tableKey, lower, w.digestOf(lower));
        expect(store.loadTable(w.tableKey)).toMatchObject({
          nonceHw: 6n,
          rakeCum: 50n,
          volumeCum: 500n,
        });
        const mixed = w.stateAt(7n, { rake: 60n, volume: 100n });
        store.reserve(w.tableKey, mixed, w.digestOf(mixed));
        expect(store.loadTable(w.tableKey)).toMatchObject({
          nonceHw: 7n,
          rakeCum: 60n,
          volumeCum: 500n,
        });
        const other = w.stateAt(8n, { rake: 60n, volume: 900n });
        store.reserve(w.tableKey, other, w.digestOf(other));
        expect(store.loadTable(w.tableKey)).toMatchObject({
          nonceHw: 8n,
          rakeCum: 60n,
          volumeCum: 900n,
        });
      });

      test('a nonce at or below epochBaseNonce is refused, the next one is not', () => {
        store.saveTable(w.record({ epochBaseNonce: 4n }));
        for (const nonce of [0n, 1n, 3n, 4n]) {
          const state = w.stateAt(nonce);
          const before = view(store);
          expectStoreError(
            () => store.reserve(w.tableKey, state, w.digestOf(state)),
            'below-epoch-base',
          );
          expect(view(store)).toEqual(before);
        }
        expect(reserve(5)).toBe(true);
      });

      test('a never-reserved nonce at or below the high-water mark is refused', () => {
        reserve(5);
        for (const nonce of [1n, 4n]) {
          const state = w.stateAt(nonce);
          const before = view(store);
          expectStoreError(
            () => store.reserve(w.tableKey, state, w.digestOf(state)),
            'behind-high-water',
          );
          expect(view(store)).toEqual(before);
        }
        // a mark moved forward by saveTable (adopted evidence) closes everything below it too
        store.saveTable(w.record({ nonceHw: 20n }));
        expectStoreError(() => reserve(10), 'behind-high-water');
        expectStoreError(() => reserve(20), 'behind-high-water');
        expect(reserve(21)).toBe(true);
      });

      test('a repeat of a digest for a different state is refused', () => {
        reserve(1);
        const other = w.stateAt(1n, { variant: 1n });
        const before = view(store);
        expectStoreError(
          () => store.reserve(w.tableKey, other, w.digestOf(w.stateAt(1n))),
          'state-mismatch',
        );
        expect(view(store)).toEqual(before);
      });

      test('an unknown table and a state for another table are refused', () => {
        const state = w.stateAt(1n);
        expectStoreError(
          () => store.reserve(OTHER_TABLE, { ...state, tableId: OTHER_TABLE }, w.digestOf(state)),
          'unknown-table',
        );
        store.saveTable(w.record({ tableKey: OTHER_TABLE }));
        expectStoreError(
          () => store.reserve(OTHER_TABLE, state, w.digestOf(state)),
          'table-mismatch',
        );
        expect(store.getSigned(OTHER_TABLE, 1n)).toBeNull();
        expect(store.loadTable(OTHER_TABLE).nonceHw).toBe(0n);
      });

      test('nonces are compared as numbers: 9, 10, 99, 100', () => {
        for (const nonce of [9, 10, 99, 100]) expect(reserve(nonce)).toBe(true);
        expect(store.loadTable(w.tableKey).nonceHw).toBe(100n);
        expect(store.latestSigned(w.tableKey).state.nonce).toBe(100n);
        expectStoreError(() => reserve(98), 'behind-high-water');
        expect(store.openRound(w.tableKey).nonce).toBe(100n);
      });

      test('two tables never share nonces', () => {
        store.saveTable(w.record({ tableKey: OTHER_TABLE }));
        reserve(1);
        const other = { ...w.stateAt(1n, { variant: 3n }), tableId: OTHER_TABLE };
        expect(store.reserve(OTHER_TABLE, other, w.digestOf(other))).toBe(true);
        expect(store.getSigned(w.tableKey, 1n).digest).toBe(w.digestOf(w.stateAt(1n)));
        expect(store.getSigned(OTHER_TABLE, 1n).digest).toBe(w.digestOf(other));
        expect(store.loadTable(w.tableKey).nonceHw).toBe(1n);
      });

      test('malformed input is refused and stores nothing', () => {
        const state = w.stateAt(1n);
        const digest = w.digestOf(state);
        const before = view(store);
        expect(
          thrown(() => store.reserve(w.tableKey, { ...state, nonce: UINT64_MAX + 1n }, digest)),
        ).toBeInstanceOf(RangeError);
        expect(
          thrown(() => store.reserve(w.tableKey, { ...state, players: [] }, digest)),
        ).toBeInstanceOf(RangeError);
        expect(thrown(() => store.reserve(w.tableKey, null, digest))).toBeInstanceOf(RangeError);
        expect(thrown(() => store.reserve(w.tableKey, state, '0x1234'))).toBeInstanceOf(RangeError);
        expect(thrown(() => store.reserve(w.tableKey, state, 5))).toBeInstanceOf(RangeError);
        expect(thrown(() => store.reserve('', state, digest))).toBeInstanceOf(TypeError);
        expect(view(store)).toEqual(before);
        // an uppercase digest is the same digest
        expect(store.reserve(w.tableKey, state, `0x${digest.slice(2).toUpperCase()}`)).toBe(true);
        expect(store.getSigned(w.tableKey, 1n).digest).toBe(digest);
        expect(store.reserve(w.tableKey, state, digest)).toBe(false);
      });
    });

    // ---- signatures ---------------------------------------------------------------------

    describe('signatures', () => {
      const other = signDigest(keyFor('other-signer'), w.digestOf(w.stateAt(1n, { variant: 9n })));

      test('attachArbiterSig stores once; the same signature again is a no-op', () => {
        reserve(1);
        const sig = w.arbiterSigFor(w.stateAt(1n));
        expect(store.attachArbiterSig(w.tableKey, 1n, sig)).toEqual({
          stored: true,
          conflict: false,
        });
        expect(store.getSigned(w.tableKey, 1n).arbiterSig).toBe(sig);
        expect(store.attachArbiterSig(w.tableKey, 1n, sig)).toEqual({
          stored: false,
          conflict: false,
        });
        expect(store.alarms()).toEqual([]);
      });

      test('a different arbiter signature is not overwritten, is reported, and raises an alarm', () => {
        reserve(1);
        const sig = w.arbiterSigFor(w.stateAt(1n));
        store.attachArbiterSig(w.tableKey, 1n, sig);
        expect(store.attachArbiterSig(w.tableKey, 1n, other)).toEqual({
          stored: false,
          conflict: true,
        });
        expect(store.getSigned(w.tableKey, 1n).arbiterSig).toBe(sig);
        expect(store.alarms()).toMatchObject([
          { kind: 'arbiter-sig-conflict', tableKey: w.tableKey, nonce: 1n, count: 1 },
        ]);
      });

      test('a nonce given as a plain number must be a safe integer', () => {
        reserve(1);
        const sig = w.arbiterSigFor(w.stateAt(1n));
        expect(store.getSigned(w.tableKey, 1)).not.toBeNull(); // 1 is 1n
        for (const bad of [2 ** 53, 2 ** 60, 1.5, -1, '1', null]) {
          expect(thrown(() => store.getSigned(w.tableKey, bad))).toBeInstanceOf(
            typeof bad === 'number' && bad < 0 ? RangeError : TypeError,
          );
          expect(thrown(() => store.attachArbiterSig(w.tableKey, bad, sig))).toBeDefined();
        }
        expect(store.getSigned(w.tableKey, 1n).arbiterSig).toBeNull();
      });

      test('attachArbiterSig needs a reserved nonce and a 65-byte signature', () => {
        const sig = w.arbiterSigFor(w.stateAt(1n));
        expectStoreError(() => store.attachArbiterSig(w.tableKey, 1n, sig), 'not-reserved');
        reserve(1);
        for (const bad of ['0x1234', 5, null, `0x${'zz'.repeat(65)}`]) {
          expect(thrown(() => store.attachArbiterSig(w.tableKey, 1n, bad))).toBeInstanceOf(
            RangeError,
          );
        }
        expect(store.getSigned(w.tableKey, 1n).arbiterSig).toBeNull();
        // case does not matter, and it is kept lowercase
        store.attachArbiterSig(w.tableKey, 1n, `0x${sig.slice(2).toUpperCase()}`);
        expect(store.getSigned(w.tableKey, 1n).arbiterSig).toBe(sig);
      });

      test('addPlayerSig stores, is idempotent, and playerSigs returns them in roster order', () => {
        reserve(1);
        const state = w.stateAt(1n);
        // stored in reverse roster order on purpose
        for (const i of [2, 0, 1]) {
          expect(
            store.addPlayerSig(w.tableKey, 1n, w.players[i], w.playerSigFor(state, i)),
          ).toEqual({
            stored: true,
            conflict: false,
          });
        }
        expect(store.addPlayerSig(w.tableKey, 1n, w.players[1], w.playerSigFor(state, 1))).toEqual({
          stored: false,
          conflict: false,
        });
        const sigs = store.playerSigs(w.tableKey, 1n);
        expect(sigs).toBeInstanceOf(Map);
        expect([...sigs.keys()]).toEqual(w.players);
        expect([...sigs.values()]).toEqual(w.players.map((_, i) => w.playerSigFor(state, i)));
        expect(store.playerSigs(w.tableKey, 2n).size).toBe(0);
      });

      test('a different player signature is never overwritten and is reported as a conflict', () => {
        reserve(1);
        const state = w.stateAt(1n);
        const good = w.playerSigFor(state, 0);
        store.addPlayerSig(w.tableKey, 1n, w.players[0], good);
        expect(store.addPlayerSig(w.tableKey, 1n, w.players[0], other)).toEqual({
          stored: false,
          conflict: true,
        });
        expect(store.playerSigs(w.tableKey, 1n).get(w.players[0])).toBe(good);
        // the same conflict again bumps the count of one alarm instead of adding rows
        store.addPlayerSig(w.tableKey, 1n, w.players[0], other);
        expect(store.alarms()).toMatchObject([
          { kind: 'player-sig-conflict', nonce: 1n, detail: { subject: w.players[0] }, count: 2 },
        ]);
      });

      test('addPlayerSig needs a reserved nonce, a player of that state and a good signature', () => {
        const state = w.stateAt(1n);
        const sig = w.playerSigFor(state, 0);
        expectStoreError(
          () => store.addPlayerSig(w.tableKey, 1n, w.players[0], sig),
          'not-reserved',
        );
        reserve(1);
        const stranger = privateKeyToAddress(keyFor('stranger'));
        expectStoreError(() => store.addPlayerSig(w.tableKey, 1n, stranger, sig), 'not-in-roster');
        expect(thrown(() => store.addPlayerSig(w.tableKey, 1n, 'nope', sig))).toBeInstanceOf(
          RangeError,
        );
        expect(
          thrown(() => store.addPlayerSig(w.tableKey, 1n, w.players[0], '0x12')),
        ).toBeInstanceOf(RangeError);
        expect(store.playerSigs(w.tableKey, 1n).size).toBe(0);
        // a checksummed (mixed-case) address is the same player
        const mixed = `0x${w.players[0].slice(2).toUpperCase()}`;
        expect(store.addPlayerSig(w.tableKey, 1n, mixed, sig).stored).toBe(true);
        expect([...store.playerSigs(w.tableKey, 1n).keys()]).toEqual([w.players[0]]);
      });

      test('getSigned, latestSigned and the current epoch', () => {
        expect(store.getSigned(w.tableKey, 1n)).toBeNull();
        expect(store.latestSigned(w.tableKey)).toBeNull();
        expect(store.latestSigned(OTHER_TABLE)).toBeNull();
        reserveUpTo(store, 3);
        expect(store.latestSigned(w.tableKey)).toEqual({
          state: w.stateAt(3n),
          digest: w.digestOf(w.stateAt(3n)),
          arbiterSig: null,
        });
        // epoch 2 starts at nonce 3: nothing of epoch 2 is reserved yet
        store.saveTable(w.record({ epochBaseNonce: 3n }));
        expect(store.latestSigned(w.tableKey)).toBeNull();
        expect(store.latestSigned(w.tableKey, { anyEpoch: true }).state.nonce).toBe(3n);
        reserve(4);
        expect(store.latestSigned(w.tableKey).state.nonce).toBe(4n);
        expect(store.latestSigned(w.tableKey, { anyEpoch: true }).state.nonce).toBe(4n);
      });
    });

    // ---- open round ---------------------------------------------------------------------

    describe('openRound', () => {
      test('is null for a fresh table and for an unknown one', () => {
        expect(store.openRound(w.tableKey)).toBeNull();
        expect(store.openRound(OTHER_TABLE)).toBeNull();
      });

      test('is the highest reserved state, even before the arbiter signed it', () => {
        reserve(1);
        expect(store.openRound(w.tableKey)).toEqual({
          nonce: 1n,
          state: w.stateAt(1n),
          digest: w.digestOf(w.stateAt(1n)),
          arbiterSig: null,
          playerSigs: new Map(),
        });
        reserve(2);
        expect(store.openRound(w.tableKey).nonce).toBe(2n);
      });

      test('carries the arbiter signature and the stored player signatures in roster order', () => {
        reserve(1);
        const state = w.stateAt(1n);
        store.attachArbiterSig(w.tableKey, 1n, w.arbiterSigFor(state));
        store.addPlayerSig(w.tableKey, 1n, w.players[2], w.playerSigFor(state, 2));
        store.addPlayerSig(w.tableKey, 1n, w.players[0], w.playerSigFor(state, 0));
        const round = store.openRound(w.tableKey);
        expect(round.arbiterSig).toBe(w.arbiterSigFor(state));
        expect([...round.playerSigs.keys()]).toEqual([w.players[0], w.players[2]]);
      });

      test('closes when a complete bundle at or above it is saved, and the next reserve opens a new one', () => {
        reserve(1);
        expect(store.saveBundle(w.tableKey, w.bundleFor(w.stateAt(1n)), w.verifyCtx())).toEqual({
          saved: true,
        });
        expect(store.openRound(w.tableKey)).toBeNull();
        reserve(2);
        expect(store.openRound(w.tableKey).nonce).toBe(2n);
        store.saveBundle(w.tableKey, w.bundleFor(w.stateAt(2n)), w.verifyCtx());
        expect(store.openRound(w.tableKey)).toBeNull();
      });

      test('a bundle ABOVE the highest reserved state also covers it', () => {
        reserve(1);
        store.saveBundle(w.tableKey, w.bundleFor(w.stateAt(2n)), w.verifyCtx());
        expect(store.openRound(w.tableKey)).toBeNull();
      });

      test('a bundle BELOW the highest reserved state does not', () => {
        reserve(1);
        reserve(2);
        store.saveBundle(w.tableKey, w.bundleFor(w.stateAt(1n)), w.verifyCtx());
        expect(store.openRound(w.tableKey).nonce).toBe(2n);
      });

      test('states of an earlier epoch are not an open round', () => {
        reserveUpTo(store, 2);
        store.saveTable(w.record({ epochBaseNonce: 2n }));
        expect(store.openRound(w.tableKey)).toBeNull();
        reserve(3);
        expect(store.openRound(w.tableKey).nonce).toBe(3n);
      });

      test('compares nonces as numbers: 9 below 10', () => {
        reserve(9);
        reserve(10);
        expect(store.openRound(w.tableKey).nonce).toBe(10n);
        store.saveBundle(w.tableKey, w.bundleFor(w.stateAt(9n)), w.verifyCtx());
        expect(store.openRound(w.tableKey).nonce).toBe(10n);
        store.saveBundle(w.tableKey, w.bundleFor(w.stateAt(10n)), w.verifyCtx());
        expect(store.openRound(w.tableKey)).toBeNull();
      });
    });

    // ---- bundles ------------------------------------------------------------------------

    describe('saveBundle', () => {
      const save = (bundle, ctx = w.verifyCtx()) => store.saveBundle(w.tableKey, bundle, ctx);

      test('saves a verified bundle and loadBundle returns it exactly', () => {
        reserve(1);
        const bundle = w.bundleFor(w.stateAt(1n));
        expect(save(bundle)).toEqual({ saved: true });
        expect(store.loadBundle(w.tableKey)).toEqual(bundle);
        expect(store.loadFinalBundle(w.tableKey)).toBeNull();
      });

      test('a bundle in upper-case hex is stored in canonical form, signatures under lower-case addresses', () => {
        const upper = (hex) => `0x${hex.slice(2).toUpperCase()}`;
        const state = w.stateAt(2n);
        const canonical = w.bundleFor(state);
        const shouting = {
          domain: { ...DOMAIN, verifyingContract: upper(VAULT) },
          state: { ...state, tableId: upper(state.tableId), players: state.players.map(upper) },
          arbiterSig: upper(canonical.arbiterSig),
          playerSigs: canonical.playerSigs.map(upper),
        };
        expect(save(shouting)).toEqual({ saved: true });
        expect(store.loadBundle(w.tableKey)).toEqual(canonical);
        expect(store.getSigned(w.tableKey, 2n)).toEqual({
          state,
          digest: w.digestOf(state),
          arbiterSig: canonical.arbiterSig,
        });
        expect([...store.playerSigs(w.tableKey, 2n)]).toEqual(
          w.players.map((address, i) => [address, w.playerSigFor(state, i)]),
        );
      });

      test('a bundle with 2^256-1 amounts and a 2^64-1 nonce survives the trip', () => {
        const state = w.stateAt(UINT64_MAX, {
          balances: [UINT256_MAX, UINT256_MAX, UINT256_MAX],
          rake: UINT256_MAX,
          volume: UINT256_MAX,
        });
        const bundle = w.bundleFor(state);
        expect(save(bundle)).toEqual({ saved: true });
        expect(store.loadBundle(w.tableKey)).toEqual(bundle);
        expect(store.loadTable(w.tableKey).nonceHw).toBe(UINT64_MAX);
      });

      test('verifies first: every kind of bad bundle saves nothing at all', () => {
        reserve(1);
        const state = w.stateAt(1n);
        const digest = w.digestOf(state);
        const strangerKey = keyFor('stranger');
        const sign = (key, st = state, domain = DOMAIN) => signDigest(key, hashState(st, domain));
        const sigs = (st = state, domain = DOMAIN) =>
          w.seats.map((s) => sign(s.sessionKey, st, domain));
        const otherDomain = { chainId: 1, verifyingContract: VAULT };
        const twoSeat = {
          ...state,
          players: state.players.slice(0, 2),
          balances: state.balances.slice(0, 2),
          keep: state.keep.slice(0, 2),
        };
        const cases = [
          ['BadSignature', w.bundleFor(state, { arbiterSig: sign(strangerKey) })],
          [
            'BadSignature',
            w.bundleFor(state, { playerSigs: [sigs()[0], sign(strangerKey), sigs()[2]] }),
          ],
          [
            'WrongDomain',
            makeBundle({
              domain: otherDomain,
              state,
              arbiterSig: sign(w.arbiterKey, state, otherDomain),
              playerSigs: sigs(state, otherDomain),
            }),
          ],
          [
            'WrongTable',
            makeBundle({
              domain: DOMAIN,
              state: { ...state, tableId: OTHER_TABLE },
              arbiterSig: sign(w.arbiterKey, { ...state, tableId: OTHER_TABLE }),
              playerSigs: sigs({ ...state, tableId: OTHER_TABLE }),
            }),
          ],
          [
            'WrongRoster',
            makeBundle({
              domain: DOMAIN,
              state: twoSeat,
              arbiterSig: sign(w.arbiterKey, twoSeat),
              playerSigs: sigs(twoSeat).slice(0, 2),
            }),
          ],
          ['Malformed', {}],
          ['Malformed', null],
          ['Malformed', { ...w.bundleFor(state), arbiterSig: '0x12' }],
        ];
        const before = view(store);
        for (const [error, bundle] of cases) {
          const result = save(bundle);
          expect(result).toMatchObject({ saved: false, reason: 'invalid', error });
          expect(Array.isArray(result.args)).toBe(true);
          expect(view(store)).toEqual(before);
        }
        expect(store.getSigned(w.tableKey, 1n).digest).toBe(digest);
        // and the same state with good signatures is accepted
        expect(save(w.bundleFor(state))).toEqual({ saved: true });
      });

      test('a wrong session key for a player fails; the right one passes', () => {
        const state = w.stateAt(1n);
        const ctx = w.verifyCtx({
          sessionKeyOf: (address) =>
            address === w.players[0]
              ? privateKeyToAddress(keyFor('someone else'))
              : w.sessionKeyOf(address),
        });
        expect(save(w.bundleFor(state), ctx)).toMatchObject({
          saved: false,
          error: 'BadSignature',
        });
        expect(store.loadBundle(w.tableKey)).toBeNull();
        expect(save(w.bundleFor(state))).toEqual({ saved: true });
      });

      test('a bundle for the right keys but another arbiter is refused', () => {
        const ctx = w.verifyCtx({ arbiter: privateKeyToAddress(keyFor('not-the-arbiter')) });
        expect(save(w.bundleFor(w.stateAt(1n)), ctx)).toMatchObject({
          saved: false,
          error: 'BadSignature',
        });
        expect(store.loadBundle(w.tableKey)).toBeNull();
      });

      test('expect must name domain, tableId and players, and the table being saved to', () => {
        const bundle = w.bundleFor(w.stateAt(1n));
        const { domain, tableId, players } = w.verifyCtx().expect;
        for (const expectArg of [
          { tableId, players },
          { domain, players },
          { domain, tableId },
          { domain, tableId, players: undefined },
          {},
          null,
          undefined,
        ]) {
          expect(
            thrown(() => save(bundle, { ...w.verifyCtx(), expect: expectArg })),
          ).toBeInstanceOf(TypeError);
        }
        expect(
          thrown(() =>
            save(bundle, { ...w.verifyCtx(), expect: { domain, tableId: OTHER_TABLE, players } }),
          ),
        ).toBeInstanceOf(TypeError);
        expect(thrown(() => save(bundle, null))).toBeInstanceOf(TypeError);
        expect(thrown(() => save(bundle, { ...w.verifyCtx(), sessionKeyOf: 5 }))).toBeInstanceOf(
          TypeError,
        );
        expect(store.loadBundle(w.tableKey)).toBeNull();
        const foreign = { ...w.stateAt(1n), tableId: OTHER_TABLE };
        const foreignBundle = makeBundle({
          domain: DOMAIN,
          state: foreign,
          arbiterSig: signDigest(w.arbiterKey, w.digestOf(foreign)),
          playerSigs: w.seats.map((s) => signDigest(s.sessionKey, w.digestOf(foreign))),
        });
        expectStoreError(
          () =>
            store.saveBundle(OTHER_TABLE, foreignBundle, {
              ...w.verifyCtx(),
              expect: { domain, tableId: OTHER_TABLE, players },
            }),
          'unknown-table',
        );
      });

      test('is monotone: a lower nonce and the same bundle again are not-newer, nothing changes', () => {
        const b2 = w.bundleFor(w.stateAt(2n));
        expect(save(b2)).toEqual({ saved: true });
        const before = view(store);
        expect(save(b2)).toEqual({ saved: false, reason: 'not-newer' });
        expect(save(w.bundleFor(w.stateAt(1n)))).toEqual({ saved: false, reason: 'not-newer' });
        expect(view(store)).toEqual(before);
        expect(store.loadBundle(w.tableKey)).toEqual(b2);
        expect(save(w.bundleFor(w.stateAt(3n)))).toEqual({ saved: true });
        expect(store.loadBundle(w.tableKey).state.nonce).toBe(3n);
      });

      test('is monotone by number, not by text: 9 is below 10', () => {
        expect(save(w.bundleFor(w.stateAt(10n)))).toEqual({ saved: true });
        expect(save(w.bundleFor(w.stateAt(9n)))).toEqual({ saved: false, reason: 'not-newer' });
        expect(store.loadBundle(w.tableKey).state.nonce).toBe(10n);
        expect(save(w.bundleFor(w.stateAt(100n)))).toEqual({ saved: true });
        expect(save(w.bundleFor(w.stateAt(99n)))).toEqual({ saved: false, reason: 'not-newer' });
      });

      test('an equal nonce with a different digest is a conflict: not saved, alarm recorded', () => {
        const first = w.bundleFor(w.stateAt(3n));
        const second = w.bundleFor(w.stateAt(3n, { variant: 1n }));
        expect(save(first)).toEqual({ saved: true });
        const before = view(store);
        expect(save(second)).toEqual({ saved: false, reason: 'conflict' });
        expect(store.loadBundle(w.tableKey)).toEqual(first);
        expect(store.alarms()).toEqual([
          {
            id: 1,
            kind: 'bundle-conflict',
            tableKey: w.tableKey,
            nonce: 3n,
            detail: {
              digests: [w.digestOf(w.stateAt(3n)), w.digestOf(w.stateAt(3n, { variant: 1n }))],
            },
            count: 1,
          },
        ]);
        expect(store.alarms(w.tableKey)).toHaveLength(1);
        expect(store.alarms(OTHER_TABLE)).toEqual([]);
        // the state table is untouched; only the alarm was added
        expect({ ...view(store), alarms: [] }).toEqual({ ...before, alarms: [] });
        // the same conflict raised again is one alarm with a higher count
        save(second);
        expect(store.alarms()).toMatchObject([{ id: 1, count: 2 }]);
      });

      test('a bundle that contradicts the RESERVED digest is a conflict, even with no bundle saved', () => {
        reserve(3);
        const forked = w.bundleFor(w.stateAt(3n, { variant: 1n }));
        expect(save(forked)).toEqual({ saved: false, reason: 'conflict' });
        expect(store.loadBundle(w.tableKey)).toBeNull();
        expect(store.alarms()).toMatchObject([{ kind: 'bundle-conflict', nonce: 3n }]);
        expect(store.getSigned(w.tableKey, 3n).digest).toBe(w.digestOf(w.stateAt(3n)));
        // an old-epoch nonce with a contradicting digest is still an alarm
        reserve(4);
        reserve(5);
        store.saveTable(w.record({ epochBaseNonce: 5n }));
        expect(save(w.bundleFor(w.stateAt(4n, { variant: 1n })))).toEqual({
          saved: false,
          reason: 'conflict',
        });
      });

      test('a bundle at or below the epoch base belongs to an earlier epoch', () => {
        reserveUpTo(store, 3);
        store.saveTable(w.record({ epochBaseNonce: 3n }));
        const before = view(store);
        expect(save(w.bundleFor(w.stateAt(3n)))).toEqual({ saved: false, reason: 'old-epoch' });
        expect(save(w.bundleFor(w.stateAt(2n)))).toEqual({ saved: false, reason: 'old-epoch' });
        expect(view(store)).toEqual(before);
        expect(save(w.bundleFor(w.stateAt(4n)))).toEqual({ saved: true });
      });

      test('a bundle we never reserved is adopted and closes the double-sign guard at its nonce', () => {
        const state = w.stateAt(7n, { rake: 70n, volume: 700n });
        expect(save(w.bundleFor(state))).toEqual({ saved: true });
        expect(store.getSigned(w.tableKey, 7n)).toEqual({
          state,
          digest: w.digestOf(state),
          arbiterSig: w.arbiterSigFor(state),
        });
        expect([...store.playerSigs(w.tableKey, 7n).values()]).toEqual(
          w.players.map((_, i) => w.playerSigFor(state, i)),
        );
        expect(store.loadTable(w.tableKey)).toMatchObject({
          nonceHw: 7n,
          rakeCum: 70n,
          volumeCum: 700n,
        });
        expect(store.openRound(w.tableKey)).toBeNull();
        // the arbiter must now refuse to sign anything else at nonce 7, and nothing below it
        const other = w.stateAt(7n, { variant: 1n });
        expect(thrown(() => store.reserve(w.tableKey, other, w.digestOf(other)))).toBeInstanceOf(
          DoubleSignError,
        );
        expectStoreError(() => reserve(6), 'behind-high-water');
        expect(store.reserve(w.tableKey, state, w.digestOf(state))).toBe(false);
        expect(reserve(8)).toBe(true);
      });

      test('adopting a bundle below the high-water mark never lowers a counter', () => {
        store.saveTable(w.record({ nonceHw: 20n, rakeCum: 900n, volumeCum: 90_000n }));
        const counters = (extra) => ({ nonceHw: 20n, rakeCum: 900n, volumeCum: 90_000n, ...extra });
        expect(save(w.bundleFor(w.stateAt(15n, { rake: 150n, volume: 15_000n })))).toEqual({
          saved: true,
        });
        expect(store.loadTable(w.tableKey)).toMatchObject(counters());
        // each counter on its own: higher rake alone, then higher volume alone
        save(w.bundleFor(w.stateAt(16n, { rake: 1000n, volume: 16_000n })));
        expect(store.loadTable(w.tableKey)).toMatchObject(counters({ rakeCum: 1000n }));
        save(w.bundleFor(w.stateAt(17n, { rake: 100n, volume: 100_000n })));
        expect(store.loadTable(w.tableKey)).toMatchObject(
          counters({ rakeCum: 1000n, volumeCum: 100_000n }),
        );
        // the nonce of an adopted state is the highest signed one, whatever order they arrived in
        expect(store.latestSigned(w.tableKey).state.nonce).toBe(17n);
        expect(store.getSigned(w.tableKey, 15n)).not.toBeNull();
      });

      test('saving a bundle for a reserved state completes its arbiter signature and keeps stored signatures', () => {
        reserve(1);
        const state = w.stateAt(1n);
        const mine = w.playerSigFor(state, 0);
        store.addPlayerSig(w.tableKey, 1n, w.players[0], mine);
        expect(store.getSigned(w.tableKey, 1n).arbiterSig).toBeNull();
        expect(save(w.bundleFor(state))).toEqual({ saved: true });
        expect(store.getSigned(w.tableKey, 1n).arbiterSig).toBe(w.arbiterSigFor(state));
        expect([...store.playerSigs(w.tableKey, 1n).values()]).toEqual(
          w.players.map((_, i) => w.playerSigFor(state, i)),
        );
        expect(store.loadTable(w.tableKey).nonceHw).toBe(1n);
      });

      test("a stored player signature is not replaced by the bundle's", () => {
        reserve(1);
        const state = w.stateAt(1n);
        const odd = signDigest(keyFor('odd-signer'), w.digestOf(state));
        store.addPlayerSig(w.tableKey, 1n, w.players[0], odd);
        expect(save(w.bundleFor(state))).toEqual({ saved: true });
        const sigs = store.playerSigs(w.tableKey, 1n);
        expect(sigs.get(w.players[0])).toBe(odd);
        expect(sigs.get(w.players[1])).toBe(w.playerSigFor(state, 1));
        expect(sigs.get(w.players[2])).toBe(w.playerSigFor(state, 2));
      });

      test('an existing arbiter signature is not replaced by the bundle', () => {
        reserve(1);
        const state = w.stateAt(1n);
        store.attachArbiterSig(w.tableKey, 1n, w.arbiterSigFor(state));
        save(w.bundleFor(state));
        expect(store.getSigned(w.tableKey, 1n).arbiterSig).toBe(w.arbiterSigFor(state));
      });

      test('loadBundle is the newest bundle of the CURRENT epoch only', () => {
        save(w.bundleFor(w.stateAt(1n)));
        save(w.bundleFor(w.stateAt(2n)));
        expect(store.loadBundle(w.tableKey).state.nonce).toBe(2n);
        store.saveTable(w.record({ epochBaseNonce: 2n }));
        expect(store.loadBundle(w.tableKey)).toBeNull();
        expect(save(w.bundleFor(w.stateAt(3n)))).toEqual({ saved: true });
        expect(store.loadBundle(w.tableKey).state.nonce).toBe(3n);
        expect(store.loadBundle(OTHER_TABLE)).toBeNull();
      });

      test('loadFinalBundle is the most recent final, kept after the epoch moves on', () => {
        expect(store.loadFinalBundle(w.tableKey)).toBeNull();
        save(w.bundleFor(w.stateAt(1n)));
        expect(store.loadFinalBundle(w.tableKey)).toBeNull();
        const keep = [true, true, false];
        const final2 = w.bundleFor(w.stateAt(2n, { isFinal: true, keep }));
        save(final2);
        expect(store.loadFinalBundle(w.tableKey)).toEqual(final2);
        expect(store.loadBundle(w.tableKey)).toEqual(final2);
        // the epoch moves on: the current bundle is gone, the final stays
        store.saveTable(w.record({ epochBaseNonce: 2n }));
        expect(store.loadBundle(w.tableKey)).toBeNull();
        expect(store.loadFinalBundle(w.tableKey)).toEqual(final2);
        // a newer non-final bundle does not displace it as the final one, but it is the newest bundle
        save(w.bundleFor(w.stateAt(3n)));
        expect(store.loadFinalBundle(w.tableKey)).toEqual(final2);
        expect(store.loadBundle(w.tableKey)).toEqual(w.bundleFor(w.stateAt(3n)));
        // a newer final does
        const final5 = w.bundleFor(w.stateAt(5n, { isFinal: true, keep }));
        save(final5);
        expect(store.loadFinalBundle(w.tableKey)).toEqual(final5);
        expect(store.loadBundle(w.tableKey)).toEqual(final5);
        // an older final (not newer than the latest) does not come back
        expect(save(w.bundleFor(w.stateAt(4n, { isFinal: true, keep })))).toEqual({
          saved: false,
          reason: 'not-newer',
        });
        expect(store.loadFinalBundle(w.tableKey)).toEqual(final5);
      });

      test('a final bundle keeps its keep flags and isFinal exactly', () => {
        const keep = [false, true, true];
        const state = w.stateAt(2n, { isFinal: true, keep });
        save(w.bundleFor(state));
        const loaded = store.loadFinalBundle(w.tableKey);
        expect(loaded.state.isFinal).toBe(true);
        expect(loaded.state.keep).toEqual(keep);
        expect(store.getSigned(w.tableKey, 2n).state.keep).toEqual(keep);
      });
    });

    // ---- tables are isolated ------------------------------------------------------------

    describe('two tables in one store', () => {
      // Nothing of one table may ever show up in the other.
      test('signatures, rounds, bundles and alarms stay with their own table', () => {
        store.saveTable(w2.record());
        expect(w2.tableKey).not.toBe(w.tableKey);

        reserve(1);
        reserve(2);
        const own = w.stateAt(2n);
        store.attachArbiterSig(w.tableKey, 2n, w.arbiterSigFor(own));
        store.addPlayerSig(w.tableKey, 2n, w.players[0], w.playerSigFor(own, 0));
        store.saveBundle(w.tableKey, w.bundleFor(w.stateAt(1n)), w.verifyCtx());
        store.saveBundle(
          w.tableKey,
          w.bundleFor(w.stateAt(3n, { isFinal: true, keep: [true, true, true] })),
          w.verifyCtx(),
        );
        store.saveBundle(w.tableKey, w.bundleFor(w.stateAt(3n, { variant: 1n })), w.verifyCtx());

        // table 2 has seen none of it
        expect(store.getSigned(w2.tableKey, 1n)).toBeNull();
        expect(store.getSigned(w2.tableKey, 2n)).toBeNull();
        expect(store.playerSigs(w2.tableKey, 2n).size).toBe(0);
        expect(store.openRound(w2.tableKey)).toBeNull();
        expect(store.latestSigned(w2.tableKey)).toBeNull();
        expect(store.loadBundle(w2.tableKey)).toBeNull();
        expect(store.loadFinalBundle(w2.tableKey)).toBeNull();
        expect(store.alarms(w2.tableKey)).toEqual([]);
        expect(store.loadTable(w2.tableKey)).toMatchObject({
          nonceHw: 0n,
          rakeCum: 0n,
          volumeCum: 0n,
        });

        // and the same nonces in table 2 are its own, whatever table 1 holds at them
        const second = w2.stateAt(2n);
        expect(store.reserve(w2.tableKey, second, w2.digestOf(second))).toBe(true);
        expect(store.playerSigs(w2.tableKey, 2n).size).toBe(0);
        expect(store.getSigned(w2.tableKey, 2n)).toEqual({
          state: second,
          digest: w2.digestOf(second),
          arbiterSig: null,
        });
        expect(store.openRound(w2.tableKey).nonce).toBe(2n);
        // the same player at the same nonce signs in each table separately: stored, not "already there"
        expect(
          store.addPlayerSig(w2.tableKey, 2n, w.players[0], w2.playerSigFor(second, 0)),
        ).toEqual({
          stored: true,
          conflict: false,
        });
        expect(store.attachArbiterSig(w2.tableKey, 2n, w2.arbiterSigFor(second))).toEqual({
          stored: true,
          conflict: false,
        });
        expect(store.playerSigs(w2.tableKey, 2n).get(w.players[0])).toBe(
          w2.playerSigFor(second, 0),
        );
        expect(store.getSigned(w.tableKey, 2n).digest).toBe(w.digestOf(own));
        expect(store.getSigned(w.tableKey, 2n).arbiterSig).toBe(w.arbiterSigFor(own));
        expect(store.playerSigs(w.tableKey, 2n).get(w.players[0])).toBe(w.playerSigFor(own, 0));
        expect(store.playerSigs(w.tableKey, 2n).size).toBe(1);
        expect(store.alarms(w.tableKey)).toHaveLength(1);
        expect(store.alarms()).toHaveLength(1);

        // a bundle of table 2 is saved, and only table 2 sees it
        expect(store.saveBundle(w2.tableKey, w2.bundleFor(second), w2.verifyCtx())).toEqual({
          saved: true,
        });
        expect(store.loadBundle(w2.tableKey)).toEqual(w2.bundleFor(second));
        expect(store.loadBundle(w.tableKey).state.nonce).toBe(3n);
        expect(store.loadFinalBundle(w2.tableKey)).toBeNull();
        expect(store.loadFinalBundle(w.tableKey).state.nonce).toBe(3n);
      });

      test('an epoch change in one table does not move the other', () => {
        store.saveTable(w2.record());
        reserve(1);
        const mine = w2.stateAt(1n);
        store.reserve(w2.tableKey, mine, w2.digestOf(mine));
        store.saveTable(w.record({ epochBaseNonce: 1n }));
        expect(store.openRound(w.tableKey)).toBeNull();
        expect(store.latestSigned(w.tableKey)).toBeNull();
        expect(store.openRound(w2.tableKey).nonce).toBe(1n);
        expect(store.latestSigned(w2.tableKey).state.nonce).toBe(1n);
        expect(store.loadTable(w2.tableKey).epochBaseNonce).toBe(0n);
      });

      test('jobs carry their table and the cursor is one for the whole store', () => {
        store.saveTable(w2.record());
        store.enqueueJob({ key: 'a', kind: 'settle', tableKey: w.tableKey, priority: 1 });
        store.enqueueJob({ key: 'b', kind: 'settle', tableKey: w2.tableKey, priority: 1 });
        expect(store.pendingJobs().map((j) => [j.key, j.tableKey])).toEqual([
          ['a', w.tableKey],
          ['b', w2.tableKey],
        ]);
        store.setCursor(10);
        expect(store.getCursor()).toBe(10);
      });
    });

    // ---- transactions -------------------------------------------------------------------

    describe('transaction', () => {
      const boom = new Error('boom');

      test("returns fn's result and commits", () => {
        const result = store.transaction(() => {
          reserve(1);
          return { answer: 42 };
        });
        expect(result).toEqual({ answer: 42 });
        expect(store.getSigned(w.tableKey, 1n)).not.toBeNull();
      });

      test('rolls back everything when fn throws, and rethrows the same error', () => {
        const before = view(store);
        const error = thrown(() =>
          store.transaction(() => {
            reserveUpTo(store, 3);
            store.attachArbiterSig(w.tableKey, 1n, w.arbiterSigFor(w.stateAt(1n)));
            store.addPlayerSig(w.tableKey, 1n, w.players[0], w.playerSigFor(w.stateAt(1n), 0));
            store.saveTable(w.record({ phase: 'changed', epochBaseNonce: 1n }));
            store.enqueueJob({ key: 'j', kind: 'k', tableKey: w.tableKey, priority: 1 });
            store.setCursor(77);
            store.saveBundle(w.tableKey, w.bundleFor(w.stateAt(2n)), w.verifyCtx());
            store.saveBundle(
              w.tableKey,
              w.bundleFor(w.stateAt(2n, { variant: 1n })),
              w.verifyCtx(),
            );
            throw boom;
          }),
        );
        expect(error).toBe(boom);
        expect(view(store)).toEqual(before);
        // and the store is not stuck inside a transaction
        expect(reserve(1)).toBe(true);
      });

      test('is re-entrant: a nested call joins the outer one, so an outer failure undoes it', () => {
        const before = view(store);
        thrown(() =>
          store.transaction(() => {
            const inner = store.transaction(() => {
              reserve(1);
              return 'inner';
            });
            expect(inner).toBe('inner');
            expect(store.getSigned(w.tableKey, 1n)).not.toBeNull();
            throw boom;
          }),
        );
        expect(view(store)).toEqual(before);
        store.transaction(() => store.transaction(() => store.transaction(() => reserve(1))));
        expect(store.getSigned(w.tableKey, 1n)).not.toBeNull();
      });

      test('a nested failure is undone on its own when the outer one carries on', () => {
        store.transaction(() => {
          reserve(1);
          const error = thrown(() =>
            store.transaction(() => {
              reserve(2);
              store.enqueueJob({ key: 'inner', kind: 'k', tableKey: w.tableKey, priority: 0 });
              throw boom;
            }),
          );
          expect(error).toBe(boom);
          expect(store.getSigned(w.tableKey, 2n)).toBeNull();
          expect(store.getJob('inner')).toBeNull();
          reserve(2);
        });
        expect(store.getSigned(w.tableKey, 1n)).not.toBeNull();
        expect(store.getSigned(w.tableKey, 2n)).not.toBeNull();
        expect(store.pendingJobs()).toEqual([]);
      });

      test("a failing store call inside a transaction undoes only itself, not the caller's earlier writes", () => {
        store.transaction(() => {
          reserve(1);
          const other = w.stateAt(1n, { variant: 1n });
          expect(thrown(() => store.reserve(w.tableKey, other, w.digestOf(other)))).toBeInstanceOf(
            DoubleSignError,
          );
          reserve(2);
        });
        expect(store.latestSigned(w.tableKey).state.nonce).toBe(2n);
        expect(store.getSigned(w.tableKey, 1n)).not.toBeNull();
      });

      test('an async callback is refused and rolled back', () => {
        const before = view(store);
        expectStoreError(
          () =>
            store.transaction(async () => {
              reserve(1);
            }),
          'async-transaction',
        );
        expect(view(store)).toEqual(before);
        expectStoreError(() => store.transaction(() => Promise.resolve(1)), 'async-transaction');
      });

      test('needs a function', () => {
        expect(thrown(() => store.transaction(5))).toBeInstanceOf(TypeError);
        expect(thrown(() => store.transaction())).toBeInstanceOf(TypeError);
      });

      test('the store cannot be closed from inside a transaction', () => {
        store.transaction(() => {
          reserve(1);
          expectStoreError(() => store.close(), 'in-transaction');
        });
        expect(store.getSigned(w.tableKey, 1n)).not.toBeNull();
      });

      test('reads inside a transaction see its own writes', () => {
        store.transaction(() => {
          reserve(1);
          expect(store.openRound(w.tableKey).nonce).toBe(1n);
          expect(store.loadTable(w.tableKey).nonceHw).toBe(1n);
        });
      });
    });

    // ---- crash points -------------------------------------------------------------------

    describe('crash points: every operation is all-or-nothing', () => {
      const ctx = w.verifyCtx();
      const state1 = w.stateAt(1n);

      test('reserve', () => {
        crashPoints({
          run: (s) => s.reserve(w.tableKey, state1, w.digestOf(state1)),
          minWrites: 2,
        });
      });

      test('reserve of a later state', () => {
        crashPoints({
          setup: (s) => reserveUpTo(s, 3),
          run: (s) => {
            const state = w.stateAt(4n, { rake: 999n });
            s.reserve(w.tableKey, state, w.digestOf(state));
          },
          minWrites: 2,
        });
      });

      test('attachArbiterSig and addPlayerSig', () => {
        const setup = (s) => reserveUpTo(s, 1);
        crashPoints({
          setup,
          run: (s) => s.attachArbiterSig(w.tableKey, 1n, w.arbiterSigFor(state1)),
        });
        crashPoints({
          setup,
          run: (s) => s.addPlayerSig(w.tableKey, 1n, w.players[1], w.playerSigFor(state1, 1)),
        });
      });

      test('a second signature, and a bundle that completes a half-signed round', () => {
        // the first signature is already stored: a rollback must take out only what the failed call added
        const setup = (s) => {
          reserveUpTo(s, 1);
          s.addPlayerSig(w.tableKey, 1n, w.players[0], w.playerSigFor(state1, 0));
        };
        crashPoints({
          setup,
          run: (s) => s.addPlayerSig(w.tableKey, 1n, w.players[1], w.playerSigFor(state1, 1)),
        });
        crashPoints({
          setup,
          run: (s) => expect(s.saveBundle(w.tableKey, w.bundleFor(state1), ctx).saved).toBe(true),
          minWrites: 4,
        });
      });

      test('a conflicting signature records its alarm or nothing', () => {
        crashPoints({
          setup: (s) => {
            reserveUpTo(s, 1);
            s.attachArbiterSig(w.tableKey, 1n, w.arbiterSigFor(state1));
          },
          run: (s) =>
            s.attachArbiterSig(w.tableKey, 1n, signDigest(keyFor('x'), w.digestOf(w.stateAt(2n)))),
        });
      });

      test('saveBundle for a reserved state', () => {
        crashPoints({
          setup: (s) => reserveUpTo(s, 1),
          run: (s) => expect(s.saveBundle(w.tableKey, w.bundleFor(state1), ctx).saved).toBe(true),
          minWrites: 3,
        });
      });

      test('saveBundle adopting a final bundle nobody reserved', () => {
        const final = w.stateAt(5n, { isFinal: true, keep: [true, true, true] });
        crashPoints({
          run: (s) => expect(s.saveBundle(w.tableKey, w.bundleFor(final), ctx).saved).toBe(true),
          minWrites: 6,
        });
      });

      test('saveBundle that ends in a conflict alarm', () => {
        crashPoints({
          setup: (s) => reserveUpTo(s, 1),
          run: (s) =>
            expect(
              s.saveBundle(w.tableKey, w.bundleFor(w.stateAt(1n, { variant: 1n })), ctx),
            ).toEqual({
              saved: false,
              reason: 'conflict',
            }),
        });
      });

      test('saveTable, with its counters and body', () => {
        crashPoints({
          setup: (s) => reserveUpTo(s, 2),
          run: (s) => s.saveTable(w.record({ phase: 'settling', epochBaseNonce: 2n, nonceHw: 9n })),
        });
      });

      test('a transaction that reserves, queues a job and moves the cursor', () => {
        crashPoints({
          run: (s) =>
            s.transaction(() => {
              s.reserve(w.tableKey, state1, w.digestOf(state1));
              s.enqueueJob({ key: 'settle:1', kind: 'settle', tableKey: w.tableKey, priority: 5 });
              s.setCursor(1234);
            }),
          minWrites: 4,
        });
      });

      test('jobs and cursor', () => {
        crashPoints({
          run: (s) =>
            s.enqueueJob({
              key: 'a',
              kind: 'k',
              tableKey: w.tableKey,
              priority: 1,
              data: { n: 1n },
            }),
        });
        crashPoints({
          setup: (s) => s.enqueueJob({ key: 'a', kind: 'k', tableKey: w.tableKey, priority: 1 }),
          run: (s) => s.markJob('a', 'sent', { txHash: '0xabc', attempts: 1 }),
        });
        crashPoints({
          setup: (s) => {
            s.enqueueJob({ key: 'a', kind: 'k', tableKey: w.tableKey, priority: 1 });
            s.markJob('a', 'done', { txHash: '0xabc', attempts: 4 });
          },
          run: (s) => s.enqueueJob({ key: 'a', kind: 'k2', tableKey: w.tableKey, priority: 2 }),
        });
        crashPoints({ run: (s) => s.setCursor(10n) });
      });
    });

    // ---- jobs ---------------------------------------------------------------------------

    describe('jobs', () => {
      const job = (key, priority = 0, extra = {}) => ({
        key,
        kind: 'settle',
        tableKey: w.tableKey,
        priority,
        ...extra,
      });

      test('enqueueJob is idempotent by key and says whether the job was new', () => {
        expect(store.enqueueJob(job('a', 1))).toBe(true);
        expect(store.enqueueJob(job('a', 9, { kind: 'other' }))).toBe(false);
        expect(store.getJob('a')).toEqual({
          key: 'a',
          kind: 'settle',
          tableKey: w.tableKey,
          priority: 1,
          status: 'pending',
          txHash: null,
          attempts: 0,
          error: null,
        });
        expect(store.pendingJobs()).toHaveLength(1);
      });

      test('a job that is in flight keeps its key: pending and sent jobs are not touched', () => {
        store.enqueueJob(job('a', 1));
        store.markJob('a', 'sent', { txHash: '0xabc', attempts: 2 });
        const before = store.getJob('a');
        expect(store.enqueueJob(job('a', 9, { kind: 'other', data: { x: 1 } }))).toBe(false);
        expect(store.getJob('a')).toEqual(before);
      });

      test('a done or failed job gives up its key: the same action can be queued again', () => {
        // one key means "this action on this table", and the next epoch needs the same action again
        for (const finished of ['done', 'failed']) {
          const key = `k-${finished}`;
          store.enqueueJob(job(key, 1));
          store.enqueueJob(job(`other-${finished}`, 1));
          store.markJob(key, 'sent', { txHash: '0x1', attempts: 3, error: 'old' });
          store.markJob(key, finished);
          expect(store.enqueueJob(job(key, 7, { kind: 'again', data: { n: 2n } }))).toBe(true);
          expect(store.getJob(key)).toEqual({
            key,
            kind: 'again',
            tableKey: w.tableKey,
            priority: 7,
            status: 'pending',
            txHash: null,
            attempts: 0,
            error: null,
            data: { n: 2n },
          });
          // and it is in flight again
          expect(store.enqueueJob(job(key, 1))).toBe(false);
        }
      });

      test('a re-queued job goes to the back of its priority group', () => {
        for (const key of ['a', 'b', 'c']) store.enqueueJob(job(key, 1));
        store.markJob('a', 'done');
        expect(store.pendingJobs().map((j) => j.key)).toEqual(['b', 'c']);
        store.enqueueJob(job('a', 1));
        expect(store.pendingJobs().map((j) => j.key)).toEqual(['b', 'c', 'a']);
        // and again, in the other order than they were first queued: each goes behind everything before it
        store.markJob('b', 'failed');
        store.markJob('a', 'done');
        store.enqueueJob(job('b', 1));
        store.enqueueJob(job('a', 1));
        expect(store.pendingJobs().map((j) => j.key)).toEqual(['c', 'b', 'a']);
      });

      test('pendingJobs is priority first (high to low), then insertion order', () => {
        for (const [key, priority] of [
          ['a', 1],
          ['b', 10],
          ['c', 1],
          ['d', 10],
          ['e', 9],
          ['f', -3],
        ]) {
          store.enqueueJob(job(key, priority));
        }
        expect(store.pendingJobs().map((j) => j.key)).toEqual(['b', 'd', 'e', 'a', 'c', 'f']);
      });

      test('pendingJobs holds everything that is not done: pending, sent and failed', () => {
        for (const key of ['a', 'b', 'c', 'd']) store.enqueueJob(job(key));
        store.markJob('b', 'sent');
        store.markJob('c', 'done');
        store.markJob('d', 'failed', { error: 'reverted' });
        expect(store.pendingJobs().map((j) => [j.key, j.status])).toEqual([
          ['a', 'pending'],
          ['b', 'sent'],
          ['d', 'failed'],
        ]);
        store.markJob('b', 'done');
        store.markJob('d', 'pending');
        expect(store.pendingJobs().map((j) => j.key)).toEqual(['a', 'd']);
      });

      test('markJob changes status and only the patch fields it is given', () => {
        store.enqueueJob(job('a'));
        expect(store.markJob('a', 'sent', { txHash: '0xabc', attempts: 1 })).toBe(true);
        expect(store.getJob('a')).toMatchObject({
          status: 'sent',
          txHash: '0xabc',
          attempts: 1,
          error: null,
        });
        store.markJob('a', 'failed', { error: 'boom' });
        expect(store.getJob('a')).toMatchObject({
          status: 'failed',
          txHash: '0xabc',
          attempts: 1,
          error: 'boom',
        });
        store.markJob('a', 'pending', { error: null, attempts: 2, txHash: undefined });
        expect(store.getJob('a')).toMatchObject({
          status: 'pending',
          txHash: '0xabc',
          attempts: 2,
          error: null,
        });
        store.markJob('a', 'sent', { txHash: null });
        expect(store.getJob('a').txHash).toBeNull();
        store.markJob('a', 'done');
        expect(store.getJob('a')).toMatchObject({ status: 'done', attempts: 2 });
      });

      test('markJob on an unknown key does nothing and says so', () => {
        expect(store.markJob('nope', 'done')).toBe(false);
        expect(store.getJob('nope')).toBeNull();
        expect(store.pendingJobs()).toEqual([]);
      });

      test('bad statuses, patches and jobs are refused', () => {
        store.enqueueJob(job('a'));
        const before = view(store);
        expect(thrown(() => store.markJob('a', 'finished'))).toBeInstanceOf(TypeError);
        expect(thrown(() => store.markJob('a', undefined))).toBeInstanceOf(TypeError);
        expect(thrown(() => store.markJob('a', 'sent', { attempts: -1 }))).toBeInstanceOf(
          TypeError,
        );
        expect(thrown(() => store.markJob('a', 'sent', { attempts: 1.5 }))).toBeInstanceOf(
          TypeError,
        );
        expect(thrown(() => store.markJob('a', 'sent', { txHash: 5 }))).toBeInstanceOf(TypeError);
        expect(thrown(() => store.markJob('a', 'sent', { error: 5 }))).toBeInstanceOf(TypeError);
        expect(thrown(() => store.markJob('a', 'sent', { status: 'done' }))).toBeInstanceOf(
          TypeError,
        );
        expect(thrown(() => store.markJob('a', 'sent', 'x'))).toBeInstanceOf(TypeError);
        expect(thrown(() => store.markJob(5, 'sent'))).toBeInstanceOf(TypeError);
        for (const bad of [
          null,
          {},
          job(''),
          job('x', 1.5),
          job('x', Number.NaN),
          { ...job('x'), kind: '' },
          { ...job('x'), tableKey: '' },
          { ...job('x'), bundle: {} },
          { ...job('x'), status: 'done' },
          job('x', 0, { data: new Map() }),
        ]) {
          expect(thrown(() => store.enqueueJob(bad))).toBeInstanceOf(TypeError);
        }
        expect(view(store)).toEqual(before);
      });

      test('a job without a priority has priority 0; optional data keeps its bigints', () => {
        store.enqueueJob({ key: 'a', kind: 'k', tableKey: w.tableKey });
        store.enqueueJob(job('b', 0, { data: { amount: 2n ** 200n, list: [1, 'x'] } }));
        expect(store.getJob('a')).toMatchObject({ priority: 0 });
        expect('data' in store.getJob('a')).toBe(false);
        expect(store.getJob('b').data).toEqual({ amount: 2n ** 200n, list: [1, 'x'] });
        expect(store.pendingJobs().map((j) => j.key)).toEqual(['a', 'b']);
      });

      test('a job and the cursor it came from are one transaction', () => {
        store.setCursor(5);
        thrown(() =>
          store.transaction(() => {
            store.enqueueJob(job('a'));
            store.setCursor(9);
            throw new Error('crash');
          }),
        );
        expect(store.getCursor()).toBe(5);
        expect(store.getJob('a')).toBeNull();
        store.transaction(() => {
          store.enqueueJob(job('a'));
          store.setCursor(9);
        });
        expect(store.getCursor()).toBe(9);
        expect(store.getJob('a')).not.toBeNull();
      });
    });

    // ---- cursor -------------------------------------------------------------------------

    describe('cursor', () => {
      test('starts unset, then holds the last block set', () => {
        expect(store.getCursor()).toBeNull();
        expect(store.setCursor(100)).toBe(true);
        expect(store.getCursor()).toBe(100);
      });

      test('never decreases: a lower block is ignored, an equal or higher one is taken', () => {
        store.setCursor(100);
        expect(store.setCursor(99)).toBe(false);
        expect(store.getCursor()).toBe(100);
        expect(store.setCursor(100)).toBe(true);
        expect(store.setCursor(101)).toBe(true);
        expect(store.getCursor()).toBe(101);
        expect(store.setCursor(0)).toBe(false);
        expect(store.getCursor()).toBe(101);
      });

      test('compares numbers, not text, and keeps the type it was given', () => {
        store.setCursor(9);
        expect(store.setCursor(10)).toBe(true);
        expect(store.setCursor(9)).toBe(false);
        store.setCursor(99);
        expect(store.setCursor(100)).toBe(true);
        expect(store.getCursor()).toBe(100);
        store.setCursor(2n ** 40n);
        expect(store.getCursor()).toBe(2n ** 40n);
        expect(store.setCursor(2 ** 40 - 1)).toBe(false);
        expect(store.setCursor(2n ** 40n + 1n)).toBe(true);
      });

      test('refuses things that are not block numbers', () => {
        store.setCursor(5);
        for (const bad of [
          -1,
          1.5,
          '7',
          null,
          undefined,
          Number.NaN,
          2n ** 64n,
          2 ** 53,
          2 ** 60,
        ]) {
          expect(thrown(() => store.setCursor(bad))).toBeDefined();
        }
        expect(store.getCursor()).toBe(5);
      });
    });

    // ---- alarms -------------------------------------------------------------------------

    describe('alarms', () => {
      test('start empty, and an alarm raised inside a failed transaction is rolled back', () => {
        expect(store.alarms()).toEqual([]);
        reserve(3);
        thrown(() =>
          store.transaction(() => {
            store.saveBundle(
              w.tableKey,
              w.bundleFor(w.stateAt(3n, { variant: 1n })),
              w.verifyCtx(),
            );
            expect(store.alarms()).toHaveLength(1);
            throw new Error('abort');
          }),
        );
        expect(store.alarms()).toEqual([]);
      });

      test('one alarm per table, nonce, kind and signer; anything else is another alarm', () => {
        const bad = (n) =>
          signDigest(keyFor('other-signer'), w.digestOf(w.stateAt(n, { variant: 9n })));
        store.saveTable(w2.record());
        reserveUpTo(store, 2);
        for (const n of [1n, 2n]) {
          const state = w.stateAt(n);
          store.attachArbiterSig(w.tableKey, n, w.arbiterSigFor(state));
          store.addPlayerSig(w.tableKey, n, w.players[0], w.playerSigFor(state, 0));
          store.addPlayerSig(w.tableKey, n, w.players[1], w.playerSigFor(state, 1));
        }
        const theirs = w2.stateAt(1n);
        store.reserve(w2.tableKey, theirs, w2.digestOf(theirs));
        store.addPlayerSig(w2.tableKey, 1n, w.players[0], w2.playerSigFor(theirs, 0));

        store.addPlayerSig(w.tableKey, 1n, w.players[0], bad(1n)); // player 0, nonce 1
        store.addPlayerSig(w.tableKey, 1n, w.players[1], bad(1n)); // player 1, nonce 1
        store.addPlayerSig(w.tableKey, 2n, w.players[0], bad(2n)); // player 0, nonce 2
        store.attachArbiterSig(w.tableKey, 1n, bad(1n)); //            the arbiter, nonce 1
        store.attachArbiterSig(w.tableKey, 2n, bad(2n)); //            the arbiter, nonce 2
        store.addPlayerSig(w2.tableKey, 1n, w.players[0], bad(1n)); // player 0, nonce 1, other table
        store.addPlayerSig(w.tableKey, 1n, w.players[0], bad(1n)); //  the first one again
        store.attachArbiterSig(w2.tableKey, 1n, w2.arbiterSigFor(theirs));
        store.attachArbiterSig(w2.tableKey, 1n, bad(1n)); //           the arbiter, nonce 1, other table

        expect(
          store.alarms().map((a) => [a.kind, a.tableKey, a.nonce, a.detail.subject, a.count]),
        ).toEqual([
          ['player-sig-conflict', w.tableKey, 1n, w.players[0], 2],
          ['player-sig-conflict', w.tableKey, 1n, w.players[1], 1],
          ['player-sig-conflict', w.tableKey, 2n, w.players[0], 1],
          ['arbiter-sig-conflict', w.tableKey, 1n, 'arbiter', 1],
          ['arbiter-sig-conflict', w.tableKey, 2n, 'arbiter', 1],
          ['player-sig-conflict', w2.tableKey, 1n, w.players[0], 1],
          ['arbiter-sig-conflict', w2.tableKey, 1n, 'arbiter', 1],
        ]);
        expect(store.alarms(w2.tableKey).map((a) => a.id)).toEqual([6, 7]);
        expect(store.alarms(w.tableKey)).toHaveLength(5);
      });

      test('are listed in the order they were raised, each with its own id', () => {
        reserve(1);
        reserve(2);
        store.saveBundle(w.tableKey, w.bundleFor(w.stateAt(2n, { variant: 1n })), w.verifyCtx());
        store.saveBundle(w.tableKey, w.bundleFor(w.stateAt(1n, { variant: 1n })), w.verifyCtx());
        expect(store.alarms().map((a) => [a.id, a.nonce, a.count])).toEqual([
          [1, 2n, 1],
          [2, 1n, 1],
        ]);
      });
    });

    // ---- close --------------------------------------------------------------------------

    describe('close', () => {
      test('every call after close() throws a StoreError with code closed', () => {
        const state = w.stateAt(1n);
        const bundle = w.bundleFor(state);
        const calls = {
          transaction: (s) => s.transaction(() => 1),
          loadTable: (s) => s.loadTable(w.tableKey),
          saveTable: (s) => s.saveTable(w.record()),
          listTables: (s) => s.listTables(),
          reserve: (s) => s.reserve(w.tableKey, state, w.digestOf(state)),
          attachArbiterSig: (s) => s.attachArbiterSig(w.tableKey, 1n, w.arbiterSigFor(state)),
          addPlayerSig: (s) =>
            s.addPlayerSig(w.tableKey, 1n, w.players[0], w.playerSigFor(state, 0)),
          playerSigs: (s) => s.playerSigs(w.tableKey, 1n),
          getSigned: (s) => s.getSigned(w.tableKey, 1n),
          latestSigned: (s) => s.latestSigned(w.tableKey),
          openRound: (s) => s.openRound(w.tableKey),
          saveBundle: (s) => s.saveBundle(w.tableKey, bundle, w.verifyCtx()),
          loadBundle: (s) => s.loadBundle(w.tableKey),
          loadFinalBundle: (s) => s.loadFinalBundle(w.tableKey),
          enqueueJob: (s) => s.enqueueJob({ key: 'a', kind: 'k', tableKey: w.tableKey }),
          getJob: (s) => s.getJob('a'),
          pendingJobs: (s) => s.pendingJobs(),
          markJob: (s) => s.markJob('a', 'done'),
          getCursor: (s) => s.getCursor(),
          setCursor: (s) => s.setCursor(1),
          alarms: (s) => s.alarms(),
          failAfterWrites: (s) => s.failAfterWrites(1),
        };
        expect(Object.keys(calls).sort()).toEqual([...STORE_METHODS, 'failAfterWrites'].sort());
        reserve(1);
        store.close();
        for (const [method, call] of Object.entries(calls)) {
          const error = thrown(() => call(store));
          expect(error, method).toBeInstanceOf(StoreError);
          expect(error.code, method).toBe('closed');
        }
        expect(thrown(() => store.close())).toBeUndefined(); // closing twice is harmless
      });
    });

    // ---- hook ---------------------------------------------------------------------------

    describe('failAfterWrites', () => {
      test('fires once, after the k-th write, and can be disarmed', () => {
        store.failAfterWrites(1);
        expect(thrown(() => reserve(1))?.message).toBe('injected store failure');
        expect(store.getSigned(w.tableKey, 1n)).toBeNull();
        expect(reserve(1)).toBe(true); // it fired once only
        store.failAfterWrites(100);
        store.failAfterWrites(null);
        expect(reserve(2)).toBe(true);
        const custom = new RangeError('custom');
        store.failAfterWrites(2, custom);
        expect(thrown(() => reserve(3))).toBe(custom);
        expect(store.getSigned(w.tableKey, 3n)).toBeNull();
        // a function is called at the moment of failure, once, and what it returns is thrown
        let calls = 0;
        store.failAfterWrites(1, () => {
          calls += 1;
          return new RangeError(`lazy ${store.writeCount}`);
        });
        expect(calls).toBe(0);
        expect(thrown(() => reserve(3))?.message).toMatch(/^lazy \d+$/);
        expect(calls).toBe(1);
        expect(reserve(3)).toBe(true);
        expect(calls).toBe(1);
        expect(thrown(() => store.failAfterWrites(0))).toBeInstanceOf(RangeError);
        expect(thrown(() => store.failAfterWrites(1.5))).toBeInstanceOf(RangeError);
      });
    });
  });
}

function nest(depth) {
  let value = 1;
  for (let i = 0; i < depth; i++) value = { value };
  return value;
}
