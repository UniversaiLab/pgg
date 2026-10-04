import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { recoverTypedDataAddress } from 'viem';
import { buildVector, STATE_TYPE_STRING, VECTOR_PATH } from '../scripts/vault-vector.js';
import { stateMessage, stateTypedData, VAULT_NAME } from '../src/vault.js';

const A = '0x0000000000000000000000000000000000000001';
const B = '0x0000000000000000000000000000000000000002';
const C = '0x0000000000000000000000000000000000000003';
const state = (over = {}) => ({
  tableId: `0x${'11'.repeat(32)}`,
  nonce: 1,
  players: [A, B, C],
  balances: [1, 2, 3],
  ...over,
});

describe('vault typed data', () => {
  test('the struct is exactly the one PokerVault hashes', () => {
    expect(STATE_TYPE_STRING).toBe(
      'State(bytes32 tableId,uint64 nonce,bool isFinal,address[] players,uint256[] balances,bool[] keep,uint256 rake,uint256 volume)',
    );
  });

  test('stateMessage uses bigint amounts and fills in defaults', () => {
    const m = stateMessage(state());
    expect(m.balances).toEqual([1n, 2n, 3n]);
    expect(m.keep).toEqual([false, false, false]);
    expect(m.isFinal).toBe(false);
    expect(m.rake).toBe(0n);
    expect(m.nonce).toBe(1n);
  });

  test('rejects mismatched arrays and unsorted or duplicate players', () => {
    expect(() => stateMessage(state({ balances: [1, 2] }))).toThrow(RangeError);
    expect(() => stateMessage(state({ keep: [true] }))).toThrow(RangeError);
    expect(() => stateMessage(state({ players: [B, A, C] }))).toThrow(/ascending/);
    expect(() => stateMessage(state({ players: [A, A, C] }))).toThrow(/ascending/);
  });

  test('domain carries the contract name, version, chain and address', () => {
    const t = stateTypedData(state(), { chainId: 137, verifyingContract: A });
    expect(t.domain).toEqual({
      name: VAULT_NAME,
      version: '1',
      chainId: 137,
      verifyingContract: A,
    });
    expect(t.primaryType).toBe('State');
  });
});

describe('cross-language vector shared with the Foundry tests', () => {
  test('the committed vector is what viem produces now', async () => {
    const committed = JSON.parse(readFileSync(VECTOR_PATH, 'utf8'));
    expect(committed).toEqual(JSON.parse(JSON.stringify(await buildVector())));
  });

  test('every signature recovers to the right signer', async () => {
    const v = await buildVector();
    const typed = stateTypedData(v.state, { chainId: v.chainId, verifyingContract: v.vault });
    const recover = (signature) => recoverTypedDataAddress({ ...typed, signature });
    expect(await recover(v.signatures.arbiter)).toBe(v.arbiter);
    for (let i = 0; i < v.players.length; i++) {
      expect(await recover(v.signatures.players[i])).toBe(v.sessionKeys[i]);
    }
  });

  test('players are sorted, as the contract requires', async () => {
    const v = await buildVector();
    for (let i = 1; i < v.players.length; i++) {
      expect(BigInt(v.players[i]) > BigInt(v.players[i - 1])).toBe(true);
    }
  });
});
