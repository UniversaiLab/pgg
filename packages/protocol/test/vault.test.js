import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { recoverTypedDataAddress } from 'viem';
import { buildVector, STATE_TYPE_STRING, VECTOR_PATH } from '../scripts/vault-vector.js';
import { STATE_TYPES, stateMessage, stateTypedData, VAULT_NAME } from '../src/vault.js';

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

describe('STATE_TYPES is frozen all the way down', () => {
  // @pgg/vault computes STATE_TYPEHASH from this once and reads the live object when it encodes a state.
  // Anything that changed it after that would leave the two disagreeing, and every digest wrong.
  test('the object, the field list and every field are frozen', () => {
    expect(Object.isFrozen(STATE_TYPES)).toBe(true);
    expect(Object.isFrozen(STATE_TYPES.State)).toBe(true);
    expect(STATE_TYPES.State).toHaveLength(8);
    for (const field of STATE_TYPES.State) expect(Object.isFrozen(field)).toBe(true);
  });

  test('every way of changing it throws, and the content is the same afterwards', () => {
    const before = JSON.stringify(STATE_TYPES);
    const attempts = [
      () => STATE_TYPES.State.push({ name: 'extra', type: 'bool' }),
      () => STATE_TYPES.State.pop(),
      () => STATE_TYPES.State.reverse(),
      () => STATE_TYPES.State.sort(),
      () => STATE_TYPES.State.splice(0, 1),
      () => {
        STATE_TYPES.State.length = 0;
      },
      () => {
        STATE_TYPES.State[0] = { name: 'x', type: 'bool' };
      },
      () => {
        STATE_TYPES.State[0].type = 'bytes32[]';
      },
      () => {
        STATE_TYPES.State[1].name = 'other';
      },
      () => {
        delete STATE_TYPES.State[2].name;
      },
      () => {
        STATE_TYPES.Other = [];
      },
      () => {
        delete STATE_TYPES.State;
      },
      () => {
        STATE_TYPES.State = [];
      },
    ];
    for (const attempt of attempts) expect(attempt).toThrow(TypeError);
    expect(JSON.stringify(STATE_TYPES)).toBe(before);
  });

  test('stateTypedData hands out the frozen object, and viem still reads it', async () => {
    const typed = stateTypedData(state(), { chainId: 137, verifyingContract: A });
    expect(typed.types).toBe(STATE_TYPES);
    expect(Object.isFrozen(typed.types.State)).toBe(true);
    // The existing signature tests above prove viem hashes it; this one proves it does not try to edit it.
    const { hashTypedData } = await import('viem');
    expect(() => hashTypedData(typed)).not.toThrow();
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
