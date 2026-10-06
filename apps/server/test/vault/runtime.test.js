// The runtime wires one resolver, one coordinator per vault table, the chain's events and two timers on the
// injected clock. It decides nothing itself; these tests check the wiring and its lifecycle.
import { describe, expect, test } from 'bun:test';
import { keccak256, privateKeyToAddress, toHex } from '@pgg/vault';
import { FakeChain } from '../../src/vault/fake-chain.js';
import { MemoryStore } from '../../src/vault/memory-store.js';
import { createVaultRuntime, HostProxy } from '../../src/vault/runtime.js';
import { LocalKeySigner } from '../../src/vault/signer.js';
import { POLICY_DEFAULTS, TABLE_DEFAULTS } from '../../src/vault/vault-config.js';
import { FakeClock } from '../helpers.js';

const keyFor = (name) => toHex(keccak256(new TextEncoder().encode(`runtime:${name}`)));

function setup({ tables = 2, policy = {} } = {}) {
  const clock = new FakeClock();
  const arbiterKey = keyFor('arbiter');
  const chain = new FakeChain({
    arbiter: privateKeyToAddress(arbiterKey),
    relayer: privateKeyToAddress(keyFor('relayer')),
    autoMint: true,
  });
  const store = new MemoryStore();
  const signer = new LocalKeySigner({
    privateKey: arbiterKey,
    reserved: (tableKey, nonce) => store.getSigned(tableKey, nonce)?.digest ?? null,
  });
  const config = {
    policy: { ...POLICY_DEFAULTS, ...policy },
    tables: Array.from({ length: tables }, (_, i) => ({
      id: `vault-${i + 1}`,
      name: `Vault ${i + 1}`,
      serverId: `rt-vault-${i + 1}`,
      ...TABLE_DEFAULTS,
      policy: { ...POLICY_DEFAULTS, ...policy },
    })),
  };
  const runtime = createVaultRuntime({ store, chain, signer, clock, config });
  return { clock, chain, store, signer, runtime, config };
}

describe('createVaultRuntime', () => {
  test('one coordinator per table; start() initialises each, which creates its own table on chain', () => {
    const { chain, runtime, clock } = setup();
    expect(runtime.coordinators()).toHaveLength(2);
    expect(runtime.coordinator('vault-1')).not.toBe(runtime.coordinator('vault-2'));
    expect(runtime.coordinator('nope')).toBeNull();
    runtime.start();
    const [a, b] = runtime.coordinators();
    expect(a.tableKey).not.toBe(b.tableKey);
    expect(a.phase).toBe('creating');
    // the resolver the runtime registered runs the createTable jobs
    chain.tick();
    expect(chain.table(a.tableKey)).toMatchObject({ status: 'Filling' });
    expect(chain.table(b.tableKey)).toMatchObject({ status: 'Filling' });
    // events reach every coordinator; the periodic tick moves each to filling
    clock.advance(POLICY_DEFAULTS.tickMs);
    expect(a.phase).toBe('filling');
    expect(b.phase).toBe('filling');
  });

  test('the tick and the re-read run on the injected clock, every tickMs and rereadMs', () => {
    const { chain, runtime, clock } = setup({
      tables: 1,
      policy: { tickMs: 1_000, rereadMs: 30_000 },
    });
    let rereads = 0;
    const repair = chain.repair.bind(chain);
    chain.repair = () => {
      rereads += 1;
      return repair();
    };
    let ticks = 0;
    const coordinator = runtime.coordinator('vault-1');
    const tick = coordinator.tick.bind(coordinator);
    coordinator.tick = () => {
      ticks += 1;
      tick();
    };
    expect(clock.pending).toBe(0); // nothing runs before start()
    runtime.start();
    expect(clock.pending).toBe(2);
    clock.advance(29_999);
    expect(ticks).toBe(29);
    expect(rereads).toBe(0);
    clock.advance(1);
    expect(ticks).toBe(30);
    expect(rereads).toBe(1);
    clock.advance(30_000);
    expect(rereads).toBe(2);
  });

  test('a re-read that throws is noted and retried; the timers keep running', () => {
    const { chain, runtime, clock } = setup({ tables: 1 });
    chain.repair = () => {
      throw new Error('rpc down');
    };
    runtime.start();
    expect(() => clock.advance(POLICY_DEFAULTS.rereadMs * 2)).not.toThrow();
    expect(runtime.rereadFailures.map((f) => f.error)).toEqual(['rpc down', 'rpc down']);
    expect(clock.pending).toBe(2);
  });

  test('close() stops the timers and the event subscription, and is idempotent; start() after close does nothing', () => {
    const { chain, runtime, clock } = setup({ tables: 1 });
    runtime.start();
    runtime.start(); // a second start is ignored
    expect(clock.pending).toBe(2);
    runtime.close();
    runtime.close();
    expect(runtime.closed).toBe(true);
    expect(clock.pending).toBe(0);
    const coordinator = runtime.coordinator('vault-1');
    let events = 0;
    const onChainEvent = coordinator.onChainEvent.bind(coordinator);
    coordinator.onChainEvent = (e) => {
      events += 1;
      onChainEvent(e);
    };
    chain.tick(); // createTable runs and emits TableCreated: nobody is listening any more
    expect(events).toBe(0);
    runtime.start();
    expect(clock.pending).toBe(0);
  });

  test('messages go to the host attached for that table; before attach they go nowhere', () => {
    const { runtime } = setup();
    const sent = [];
    expect(() => runtime.attachHost('nope', {})).toThrow(RangeError);
    runtime.attachHost('vault-2', {
      send: (playerId, msg) => sent.push([playerId, msg.t]),
      inHand: () => true,
    });
    runtime.start();
    expect(sent).toEqual([]); // nothing to send yet, and nothing was thrown for the unattached table
  });

  test('bad configuration is refused', () => {
    const { store, chain, signer, clock, config } = setup();
    expect(() => createVaultRuntime({ store, chain, signer, clock, config: {} })).toThrow(
      TypeError,
    );
    expect(() =>
      createVaultRuntime({
        store,
        chain,
        signer,
        clock,
        config: { tables: [config.tables[0], config.tables[0]] },
      }),
    ).toThrow(RangeError);
  });
});

describe('HostProxy', () => {
  test('forwards to the attached target; a missing target or method is a no-op (inHand: false)', () => {
    const proxy = new HostProxy();
    expect(proxy.inHand()).toBe(false);
    expect(proxy.send('p', {})).toBeUndefined();
    const calls = [];
    const target = {
      send(...args) {
        calls.push(['send', this === target, ...args]);
        return 'sent';
      },
      inHand: () => true,
    };
    proxy.attach(target);
    expect(proxy.target).toBe(target);
    expect(proxy.send('p1', { t: 'x' })).toBe('sent');
    expect(calls).toEqual([['send', true, 'p1', { t: 'x' }]]);
    expect(proxy.inHand()).toBe(true);
    expect(proxy.unseat('a', {})).toBeUndefined();
  });
});
