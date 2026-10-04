// EIP-712 definition of the table state that the arbiter and every player sign, and that PokerVault.sol
// verifies. This must match `PokerVault.STATE_TYPEHASH` exactly; test/vault.test.js checks it against a
// vector that the Foundry tests check too (contracts/test/vectors/state.json).
//
// Plain data on purpose: no web3 library is needed here, so the web client can import it without
// pulling one in. Pass the pieces to viem (`signTypedData`, `hashTypedData`) or ethers.

export const VAULT_NAME = 'PGG PokerVault';
export const VAULT_VERSION = '1';

export const STATE_PRIMARY_TYPE = 'State';

// Deeply frozen: @pgg/vault builds STATE_TYPEHASH from this once at load and also reads the live object when
// it encodes a state, so a change after load would make the two disagree and every digest wrong.
const field = (name, type) => Object.freeze({ name, type });

export const STATE_TYPES = Object.freeze({
  State: Object.freeze([
    field('tableId', 'bytes32'),
    field('nonce', 'uint64'),
    field('isFinal', 'bool'),
    field('players', 'address[]'),
    field('balances', 'uint256[]'),
    field('keep', 'bool[]'),
    field('rake', 'uint256'),
    field('volume', 'uint256'),
  ]),
});

/** The domain of one deployment: the chain it lives on and its address. */
export function vaultDomain({ chainId, verifyingContract }) {
  return { name: VAULT_NAME, version: VAULT_VERSION, chainId, verifyingContract };
}

/**
 * Normalise a state into the message that gets signed. Amounts become bigint (token units with 6 or 18
 * decimals do not fit a JS number), and the arrays must line up with `players`.
 * @param {{ tableId: string, nonce: number|bigint, isFinal?: boolean, players: string[],
 *           balances: (bigint|number|string)[], keep?: boolean[], rake?: bigint|number|string,
 *           volume?: bigint|number|string }} state
 */
export function stateMessage(state) {
  const n = state.players.length;
  if (state.balances.length !== n) throw new RangeError('balances must match players');
  const keep = state.keep ?? state.players.map(() => false);
  if (keep.length !== n) throw new RangeError('keep must match players');
  for (let i = 1; i < n; i++) {
    if (BigInt(state.players[i]) <= BigInt(state.players[i - 1])) {
      throw new RangeError('players must be strictly ascending by address');
    }
  }
  return {
    tableId: state.tableId,
    nonce: BigInt(state.nonce),
    isFinal: state.isFinal ?? false,
    players: state.players,
    balances: state.balances.map((b) => BigInt(b)),
    keep,
    rake: BigInt(state.rake ?? 0),
    volume: BigInt(state.volume ?? 0),
  };
}

/** Everything a signer needs: `{ domain, types, primaryType, message }`. */
export function stateTypedData(state, domainInput) {
  return {
    domain: vaultDomain(domainInput),
    types: STATE_TYPES,
    primaryType: STATE_PRIMARY_TYPE,
    message: stateMessage(state),
  };
}
