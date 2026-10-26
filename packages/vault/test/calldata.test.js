import { describe, expect, test } from 'bun:test';
import { encodeFunctionData, erc20Abi } from 'viem';
import { calls, pokerVaultAbi, stringAt, wordAt } from '../src/index.js';

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const KEY = `0x${'ab'.repeat(32)}`;
const state = {
  tableId: KEY,
  nonce: 7n,
  isFinal: true,
  players: [A, B],
  balances: [5_000_000n, 3n],
  keep: [true, false],
  rake: 12n,
  volume: 99n,
};
const bundle = {
  state,
  arbiterSig: `0x${'cd'.repeat(65)}`,
  playerSigs: [`0x${'ef'.repeat(65)}`, `0x${'01'.repeat(65)}`],
};
const vault = (functionName, args) =>
  encodeFunctionData({ abi: pokerVaultAbi, functionName, args });

describe('calldata matches viem byte for byte', () => {
  test('token calls', () => {
    expect(calls.balanceOf(A)).toBe(
      encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [A] }),
    );
    expect(calls.allowance(A, B)).toBe(
      encodeFunctionData({ abi: erc20Abi, functionName: 'allowance', args: [A, B] }),
    );
    expect(calls.approve(B, 2n ** 255n)).toBe(
      encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [B, 2n ** 255n] }),
    );
    expect(calls.decimals()).toBe(encodeFunctionData({ abi: erc20Abi, functionName: 'decimals' }));
  });

  test('vault calls', () => {
    expect(calls.deposit(KEY, 123n, A)).toBe(vault('deposit', [KEY, 123n, A]));
    expect(calls.leave(KEY)).toBe(vault('leave', [KEY]));
    expect(calls.withdraw(B)).toBe(vault('withdraw', [B]));
    expect(calls.withdrawable(B)).toBe(vault('withdrawable', [B]));
    expect(calls.token()).toBe(vault('TOKEN', []));
    expect(calls.startExitFromDeposits(KEY, [A, B])).toBe(
      vault('startExitFromDeposits', [KEY, [A, B]]),
    );
    expect(calls.startExit(bundle)).toBe(
      vault('startExit', [state, bundle.arbiterSig, bundle.playerSigs]),
    );
    expect(calls.finalizeExit(state)).toBe(vault('finalizeExit', [state]));
  });

  test('result decoding', () => {
    expect(wordAt(`0x${'0'.repeat(63)}6`)).toBe(6n);
    // symbol() returning "mUSD"
    const ret = `0x${'0'.repeat(62)}20${'0'.repeat(63)}4${'6d555344'.padEnd(64, '0')}`;
    expect(stringAt(ret)).toBe('mUSD');
  });
});
