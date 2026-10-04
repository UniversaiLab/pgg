// The ABI committed in src/abi.js must be the one forge builds, and the errors the checks name must be the
// contract's real errors (same names, same parameter types).
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { keccak256, toHex } from 'viem';
import { renderAbiModule } from '../scripts/vault-abi.js';
import { pokerVaultAbi } from '../src/abi.js';
import { ERRORS } from '../src/check.js';

const artifact = new URL('../../../contracts/out/PokerVault.sol/PokerVault.json', import.meta.url);
const have = existsSync(artifact);
const require = process.env.PGG_REQUIRE_CHAIN_TESTS === '1';

if (!have && require) {
  test('the forge artifact exists (PGG_REQUIRE_CHAIN_TESTS=1)', () => {
    expect(have, 'run `forge build` in contracts/').toBe(true);
  });
}

describe.skipIf(!have)('against contracts/out/PokerVault.sol/PokerVault.json', () => {
  const forge = have ? JSON.parse(readFileSync(artifact, 'utf8')).abi : [];

  test('the committed ABI equals the forge output (regenerate with scripts/vault-abi.js)', () => {
    expect(pokerVaultAbi).toEqual(forge);
  });

  test('the generator would write what is committed, up to formatting', () => {
    const source = renderAbiModule(forge);
    const evaluated = JSON.parse(source.slice(source.indexOf('= ') + 2, source.lastIndexOf(';')));
    expect(evaluated).toEqual(pokerVaultAbi);
  });
});

describe('the committed ABI and the error catalogue', () => {
  const contractErrors = pokerVaultAbi.filter((item) => item.type === 'error');
  const signatureOf = (item) => `${item.name}(${item.inputs.map((i) => i.type).join(',')})`;

  test('it is the full ABI: constructor, the state functions and the events', () => {
    const functions = pokerVaultAbi.filter((i) => i.type === 'function').map((i) => i.name);
    for (const name of [
      'settle',
      'startExit',
      'challenge',
      'finalizeExit',
      'stateDigest',
      'depositState',
      'tables',
      'seats',
    ]) {
      expect(functions).toContain(name);
    }
    expect(pokerVaultAbi.some((i) => i.type === 'constructor')).toBe(true);
    expect(pokerVaultAbi.some((i) => i.type === 'event' && i.name === 'ExitStarted')).toBe(true);
  });

  test('every PokerVault error in ERRORS exists in the ABI with the same signature and selector', () => {
    for (const entry of Object.values(ERRORS).filter((e) => e.source === 'PokerVault')) {
      const item = contractErrors.find((e) => e.name === entry.name);
      expect(item, entry.name).toBeDefined();
      expect(signatureOf(item), entry.name).toBe(entry.signature);
      expect(keccak256(toHex(entry.signature)).slice(0, 10)).toBe(entry.selector);
    }
  });

  test('the OpenZeppelin ECDSA errors in ERRORS are in the ABI too, with the same signatures', () => {
    const oz = Object.values(ERRORS).filter((e) => e.source === 'OpenZeppelin ECDSA');
    expect(oz.length).toBe(3);
    for (const entry of oz) {
      const item = contractErrors.find((e) => e.name === entry.name);
      expect(item, entry.name).toBeDefined();
      expect(signatureOf(item), entry.name).toBe(entry.signature);
    }
  });
});
