// RAKE_BPS_CEILING is a copy of a Solidity constant, so a test reads the contract source to keep them equal.
// rules.js refuses a view whose maxRakeBps is above it: no vault can be built with a higher cap.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { makeBundle, verifyBundle } from '../src/bundle.js';
import { checkState, RAKE_BPS_CEILING } from '../src/check.js';
import { makeWorld } from './fixtures.js';

describe('RAKE_BPS_CEILING', () => {
  test('equals PokerVault.RAKE_BPS_CEILING in the contract source', () => {
    const source = readFileSync(
      new URL('../../../contracts/src/PokerVault.sol', import.meta.url),
      'utf8',
    );
    const found = source.match(/RAKE_BPS_CEILING\s*=\s*(\d+)\s*;/);
    expect(found, 'the constant is declared in PokerVault.sol').not.toBeNull();
    expect(RAKE_BPS_CEILING).toBe(Number(found[1]));
  });
});

describe('sessionKeyOf is called with lowercase addresses', () => {
  // The README promises it, so a Map keyed by lowercase addresses works whatever case the input had.
  const w = makeWorld({ seed: 91 });
  const shout = (h) => `0x${h.slice(2).toUpperCase()}`;
  const state = w.nextHand(w.genesis);
  const sigs = w.sign(state);

  test('verifyBundle, even when the bundle was written in upper case', () => {
    const seen = [];
    const loud = makeBundle({
      domain: w.domain,
      state: { ...state, tableId: shout(state.tableId), players: state.players.map(shout) },
      ...sigs,
    });
    const result = verifyBundle(loud, {
      arbiter: shout(w.arbiter),
      sessionKeyOf: (address) => {
        seen.push(address);
        return w.sessionKeyOf(address);
      },
    });
    expect(result.ok).toBe(true);
    expect(seen).toEqual(state.players);
    for (const address of seen) expect(address).toBe(address.toLowerCase());
  });

  test('checkState', () => {
    const seen = [];
    const ctx = w.ctx({
      sessionKeyOf: (address) => {
        seen.push(address);
        return w.sessionKeyOf(address);
      },
    });
    const loud = { ...state, players: state.players.map(shout) };
    expect(checkState(loud, sigs, ctx).ok).toBe(true);
    expect(seen).toEqual(state.players);
  });
});
