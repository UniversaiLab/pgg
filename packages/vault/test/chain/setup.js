// Shared set-up for the library's chain tests: an anvil with the real PokerVault, one Active table of three
// players with session keys and dust in their deposits, and the helpers to sign and to read reverts.
import { ContractFunctionRevertedError, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { buildNextState, genesisState, sortRoster } from '../../src/build.js';
import { tableFromChain } from '../../src/check.js';
import { hashState } from '../../src/eip712.js';
import { privateKeyToAddress, signDigest } from '../../src/sign.js';
import { deployVault, startAnvil } from '../../testing/index.js';

const key = (name) => keccak256(toHex(`vault-lib-test:${name}`));
export const NAMES = ['alice', 'bob', 'carol'];

export async function setupEpoch() {
  const node = await startAnvil();
  const arbiter = privateKeyToAccount(key('arbiter'));
  await node.testClient.setBalance({ address: arbiter.address, value: 10n ** 21n });
  const deployed = await deployVault(node, { arbiter });
  const domain = { chainId: node.chainId, verifyingContract: deployed.vault };
  const tableId = keccak256(toHex('vault-lib-chain-table'));

  const read = (functionName, args = []) =>
    node.publicClient.readContract({
      address: deployed.vault,
      abi: deployed.vaultAbi,
      functionName,
      args,
    });
  const wait = (hash) => node.publicClient.waitForTransactionReceipt({ hash });
  const write = async (account, address, abi, functionName, args) =>
    wait(await node.walletFor(account).writeContract({ address, abi, functionName, args }));

  const seats = [];
  for (const name of NAMES) {
    const wallet = await node.account(name);
    const sessionKey = key(`session:${name}`);
    seats.push({
      address: wallet.address.toLowerCase(),
      wallet,
      name,
      session: { key: sessionKey, address: privateKeyToAddress(sessionKey) },
    });
  }
  const roster = sortRoster(seats).sorted;

  await write(deployed.arbiter, deployed.vault, deployed.vaultAbi, 'createTable', [
    tableId,
    6,
    1_000_000n,
    10_000_000_000n,
  ]);
  const deposits = [];
  for (const [i, seat] of roster.entries()) {
    const amount = 1_000_000_000n + BigInt(i) * 123_457n; // not a multiple of any chip unit: dust
    deposits.push(amount);
    await write(seat.wallet, deployed.token, deployed.tokenAbi, 'mint', [
      seat.wallet.address,
      amount,
    ]);
    await write(seat.wallet, deployed.token, deployed.tokenAbi, 'approve', [
      deployed.vault,
      amount,
    ]);
    await write(seat.wallet, deployed.vault, deployed.vaultAbi, 'deposit', [
      tableId,
      amount,
      seat.session.address,
    ]);
  }
  await write(deployed.arbiter, deployed.vault, deployed.vaultAbi, 'start', [
    tableId,
    roster.map((s) => s.address),
  ]);

  const genesis = genesisState({ tableId, players: roster.map((s) => s.address), deposits });
  const sessionKeys = new Map();
  for (const seat of roster) {
    const onChain = await read('seats', [tableId, seat.address]);
    sessionKeys.set(seat.address, onChain[1]); // [deposit, sessionKey]
  }
  const ctx = {
    domain,
    maxRakeBps: await read('MAX_RAKE_BPS'),
    sessionKeyOf: (address) => sessionKeys.get(address) ?? null,
    table: tableFromChain(await read('tables', [tableId])),
  };

  /** The first error `fn` would revert with on chain, as { error, args }, or null if it would succeed. */
  const revertOf = async (functionName, args, account) => {
    try {
      await node.publicClient.simulateContract({
        address: deployed.vault,
        abi: deployed.vaultAbi,
        functionName,
        args,
        account,
      });
      return null;
    } catch (error) {
      const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
      if (!reverted?.data) return { error: 'unknown', args: [String(error.shortMessage ?? error)] };
      return { error: reverted.data.errorName, args: reverted.data.args ?? [] };
    }
  };

  /** Arbiter (viem) and player (this library) signatures over `state`'s digest. */
  const sign = async (state) => {
    const digest = hashState(state, domain);
    return {
      arbiterSig: await deployed.arbiter.sign({ hash: digest }),
      playerSigs: roster.map((p) => signDigest(p.session.key, digest)),
    };
  };

  /** A valid next state: seat 0 wins 49 tokens from seat 1, 1 token of rake out of a pot of 100. */
  const goodState = () =>
    buildNextState({
      prev: genesis,
      balances: genesis.balances.map((b, i) =>
        i === 0 ? b + 49_000_000n : i === 1 ? b - 50_000_000n : b,
      ),
      rakeDelta: 1_000_000n,
      volumeDelta: 100_000_000n,
    });

  return {
    node,
    deployed,
    domain,
    tableId,
    roster,
    genesis,
    ctx,
    read,
    write,
    revertOf,
    sign,
    goodState,
    submit: (state, sigs) => [state, sigs.arbiterSig, sigs.playerSigs],
  };
}
