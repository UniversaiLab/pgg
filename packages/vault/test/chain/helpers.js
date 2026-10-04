// Set-up and plumbing for the equivalence property test (equivalence.test.js): one anvil, one real
// PokerVault, and a table in every state the contract can be in, so the JavaScript checks can be compared
// with the contract's own reverts on all of them.
//
// Nothing here sends a transaction after setupWorld() returns. The property loop only ever uses eth_call
// (simulateContract), so the chain stays exactly as built and thousands of cases are cheap.
import {
  ContractFunctionRevertedError,
  decodeErrorResult,
  encodeFunctionData,
  keccak256,
  toHex,
} from 'viem';
import { tableFromChain } from '../../src/check.js';
import { deployVault, startAnvil, testAccount } from '../../testing/index.js';

export const STATUS_NAME = ['None', 'Filling', 'Active', 'Exiting', 'Closed'];
export const EXIT_WINDOW = 86_400;

/**
 * What a reverted call looked like, as { error, args } with viem's types (uint as bigint, bytes32 as hex).
 * A Panic is { error: 'Panic', args: [code] }. A revert with no data at all (the ABI decoder refusing the
 * calldata) is 'EmptyRevert'. Anything that is not a revert (a dead RPC, a viem encoding error) is
 * 'NotARevert' so it can never be mistaken for a contract error.
 */
export function decodeRevert(error) {
  const reverted = error.walk?.((e) => e instanceof ContractFunctionRevertedError);
  if (reverted?.data)
    return { error: reverted.data.errorName, args: [...(reverted.data.args ?? [])] };
  if (reverted?.signature) return { error: 'UnknownError', args: [reverted.signature] };
  if (reverted) return { error: 'EmptyRevert', args: [] };
  return { error: 'NotARevert', args: [String(error.shortMessage ?? error.message ?? error)] };
}

const bigAddressOrder = (a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1);

/**
 * Start anvil, deploy the real vault and build the tables:
 *
 *   active3, active2, active10  fresh epochs of 3, 2 (the minimum) and 10 (the maximum) players
 *   rolled                      4 players in a second epoch: nonce 7 and 2,500,000 of rake already paid
 *   filling                     3 deposits, not started
 *   exiting                     3 players, an exit started with a valid signed state (nonce 3)
 *   closed                      an exit that was finalised
 *   none                        an id the vault has never seen
 *
 * Every table object has { name, id, seats, players, ctx, status }; `ctx` is what checkState wants,
 * read from the chain (the session keys from `seats()`, the row from `tables()`).
 */
export async function setupWorld({ maxRakeBps = 137 } = {}) {
  const node = await startAnvil();
  try {
    return await build(node, maxRakeBps);
  } catch (error) {
    await node.stop();
    throw error;
  }
}

async function build(node, maxRakeBps) {
  const deployed = await deployVault(node, { maxRakeBps, exitWindow: EXIT_WINDOW });
  const { vault, vaultAbi, tokenAbi } = deployed;
  const client = node.publicClient;
  // as viem returns them (checksummed): the library must take any case
  const domain = { chainId: node.chainId, verifyingContract: vault };

  const wait = async (hash) => {
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`transaction ${hash} reverted during setup`);
    return receipt;
  };
  const send = async (account, address, abi, functionName, args) =>
    wait(await node.walletFor(account).writeContract({ address, abi, functionName, args }));
  const sendVault = (account, functionName, args) =>
    send(account, vault, vaultAbi, functionName, args);
  const read = (functionName, args = []) =>
    client.readContract({ address: vault, abi: vaultAbi, functionName, args });

  const settler = await node.account('settle-caller'); // settle is open to anyone, so a non-member calls it
  // Signers that hold no seat: wrong-key faults use them. They never need funds.
  const strangers = [0, 1, 2, 3].map((i) => testAccount(`equivalence-stranger-${i}`));

  // --- building tables ---------------------------------------------------------------------------------
  const tableId = (name) => keccak256(toHex(`pgg-equivalence:${name}`));

  /** Create a table and deposit for `count` players (deposits are not round numbers: they carry dust). */
  async function fill(name, count) {
    const id = tableId(name);
    await sendVault(deployed.arbiter, 'createTable', [id, 10, 1_000_000n, 10_000_000_000n]);
    const seats = [];
    for (let i = 0; i < count; i++) {
      const wallet = await node.account(`${name}-player-${i}`);
      const session = testAccount(`${name}-session-${i}`);
      const amount = 1_000_000_000n + BigInt(i) * 123_457n + BigInt(i * 7 + 3);
      await send(wallet, deployed.token, tokenAbi, 'mint', [wallet.address, amount]);
      await send(wallet, deployed.token, tokenAbi, 'approve', [vault, amount]);
      await sendVault(wallet, 'deposit', [id, amount, session.address]);
      seats.push({ address: wallet.address.toLowerCase(), wallet, session, deposit: amount });
    }
    seats.sort(bigAddressOrder);
    return { name, id, seats };
  }
  const start = (t) => sendVault(deployed.arbiter, 'start', [t.id, t.seats.map((s) => s.address)]);

  /** A state for table `t` with the given fields over a plain default (balances = the deposits). */
  const stateOf = (t, fields) => ({
    tableId: t.id,
    nonce: 1n,
    isFinal: false,
    players: t.seats.map((s) => s.address),
    balances: t.seats.map((s) => s.deposit),
    keep: t.seats.map(() => false),
    rake: 0n,
    volume: 0n,
    ...fields,
  });
  /** Everyone signs the digest the CONTRACT computes (so this set-up does not lean on the JS hash). */
  const signAll = async (t, state) => {
    const hash = await read('stateDigest', [state]);
    return {
      arbiterSig: await deployed.arbiter.sign({ hash }),
      playerSigs: await Promise.all(t.seats.map((s) => s.session.sign({ hash }))),
    };
  };
  const submit = (state, sigs) => [state, sigs.arbiterSig, sigs.playerSigs];
  /** Move `amount` from seat `from` to seat `to`, `rake` of it going to the house. */
  const hand = (t, { from, to, amount, rake = 0n }) =>
    t.seats.map((s, i) => s.deposit - (i === from ? amount : 0n) + (i === to ? amount - rake : 0n));

  // closed first: finalising an exit needs the clock moved past the window, and that must not touch the
  // deadline of the exiting table built after it.
  const closed = await fill('closed', 2);
  await start(closed);
  {
    const state = stateOf(closed, {
      nonce: 1n,
      balances: hand(closed, { from: 0, to: 1, amount: 5_000_000n }),
    });
    await sendVault(deployed.arbiter, 'startExit', submit(state, await signAll(closed, state)));
    await node.advance(EXIT_WINDOW + 1);
    await sendVault(settler, 'finalizeExit', [state]);
  }

  const active3 = await fill('active3', 3);
  await start(active3);
  const active2 = await fill('active2', 2);
  await start(active2);
  const active10 = await fill('active10', 10);
  await start(active10);
  const filling = await fill('filling', 3);

  const rolled = await fill('rolled', 4);
  await start(rolled);
  {
    const final = stateOf(rolled, {
      nonce: 7n,
      isFinal: true,
      balances: hand(rolled, { from: 0, to: 1, amount: 123_456_789n, rake: 2_500_000n }),
      keep: [true, true, true, true],
      rake: 2_500_000n,
      volume: 200_000_000n,
    });
    await sendVault(settler, 'settle', submit(final, await signAll(rolled, final)));
    await start(rolled); // the second epoch begins with everybody rolled over
  }

  const exiting = await fill('exiting', 3);
  await start(exiting);
  {
    const state = stateOf(exiting, {
      nonce: 3n,
      balances: hand(exiting, { from: 2, to: 0, amount: 40_000_000n, rake: 1_000_000n }),
      rake: 1_000_000n,
      volume: 100_000_000n,
    });
    await sendVault(deployed.arbiter, 'startExit', submit(state, await signAll(exiting, state)));
  }

  // --- reading the tables back ---------------------------------------------------------------------------
  const maxBps = await read('MAX_RAKE_BPS');
  async function describeTable(name, id, seats, rosterFrom = seats) {
    const row = tableFromChain(await read('tables', [id]));
    const keys = new Map();
    for (const seat of seats) {
      const onChain = await read('seats', [id, seat.address]);
      keys.set(seat.address, onChain[1]);
    }
    return {
      name,
      id,
      seats,
      players: rosterFrom.map((s) => s.address),
      status: row.status,
      ctx: {
        domain,
        maxRakeBps: maxBps,
        sessionKeyOf: (address) => keys.get(address) ?? null,
        table: row,
      },
    };
  }
  // `none` borrows a roster so there is something to put in a state; the vault has no row for it.
  const tables = {};
  for (const t of [active3, active2, active10, rolled, filling, exiting, closed]) {
    tables[t.name] = await describeTable(t.name, t.id, t.seats);
  }
  tables.none = await describeTable('none', tableId('none'), [], active3.seats);

  // --- the oracle: what the contract does with a call, without changing anything --------------------
  const callerFor = (entry) => (entry === 'settle' ? settler : deployed.arbiter);
  const outcome = async (entry, state, sigs) => {
    try {
      await client.simulateContract({
        address: vault,
        abi: vaultAbi,
        functionName: entry,
        args: submit(state, sigs),
        account: callerFor(entry),
      });
      return null;
    } catch (error) {
      return decodeRevert(error);
    }
  };

  /** The same call with the calldata edited afterwards, for inputs viem refuses to encode. */
  const rawOutcome = async (entry, state, sigs, patch) => {
    const data = patch(
      encodeFunctionData({ abi: vaultAbi, functionName: entry, args: submit(state, sigs) }),
    );
    try {
      await client.call({ account: callerFor(entry), to: vault, data });
      return null;
    } catch (error) {
      const raw = error.walk?.((e) => typeof e?.data === 'string' && e.data.length > 2);
      if (!raw) return { error: 'EmptyRevert', args: [] };
      try {
        const decoded = decodeErrorResult({ abi: vaultAbi, data: raw.data });
        return { error: decoded.errorName, args: [...(decoded.args ?? [])] };
      } catch {
        return { error: 'UnknownError', args: [raw.data] };
      }
    }
  };

  // --- signing with the real keys ------------------------------------------------------------------------
  const signed = new Map();
  /**
   * Sign `digest` as `ref` says: { who: 'arbiter' } | { who: 'seat', index } | { who: 'stranger', index }.
   * A seat index beyond the table's roster is a stranger too. Signatures are made by viem, not by the
   * library under test, and cached because the same digest is signed by the same key many times.
   */
  const signRef = (table, ref, digest) => {
    const account =
      ref.who === 'arbiter'
        ? deployed.arbiter
        : ref.who === 'seat' && table.seats[ref.index]
          ? table.seats[ref.index].session
          : strangers[(ref.index ?? 0) % strangers.length];
    const key = `${account.address}:${digest}`;
    if (!signed.has(key)) signed.set(key, account.sign({ hash: digest }));
    return signed.get(key);
  };

  return {
    node,
    deployed,
    domain,
    maxRakeBps: maxBps,
    tables,
    read,
    outcome,
    rawOutcome,
    signRef,
    blockNumber: () => client.getBlockNumber({ cacheTime: 0 }), // viem caches this for seconds by default
    /** The table's row and every seat's session key, read again (to prove nothing moved). */
    rowOf: async (table) => tableFromChain(await read('tables', [table.id])),
    stop: () => node.stop(),
  };
}
