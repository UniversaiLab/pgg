import { describe, expect, test } from 'bun:test';
import { MemoryStore } from '../../src/vault/memory-store.js';
import { makeWorld } from '../fixtures/store-world.js';
import { runStoreContract } from './store.contract.js';

runStoreContract('MemoryStore', () => new MemoryStore());

describe('MemoryStore specifics', () => {
  test('every store is its own world', () => {
    const w = makeWorld();
    const a = new MemoryStore();
    const b = new MemoryStore();
    a.saveTable(w.record());
    expect(b.loadTable(w.tableKey)).toBeNull();
    expect(b.listTables()).toEqual([]);
  });
});
