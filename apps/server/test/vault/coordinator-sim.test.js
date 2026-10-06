// A deterministic simulation of the coordinator over many seeds; the schedule and the invariants are in sim.js.
import { describe, expect, test } from 'bun:test';
import { simulate } from './sim.js';

const SEEDS = 60;

describe('coordinator simulation', () => {
  const totals = { bundles: 0, gates: 0 };
  for (let seed = 1; seed <= SEEDS; seed++) {
    test(`seed ${seed}`, () => {
      const { checked } = simulate(seed);
      totals.bundles += checked.bundles;
      totals.gates += checked.gates;
    });
  }

  test('the seeds exercised the checks (bundles checked against the chain, gates seen open)', () => {
    expect(totals.bundles).toBeGreaterThan(SEEDS);
    expect(totals.gates).toBeGreaterThan(SEEDS);
  });
});
