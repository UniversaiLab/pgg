// EIP-712 hashing of the State, written by hand so the browser needs no web3 library. The result must be
// byte-for-byte what PokerVault.stateDigest() returns and what viem's hashTypedData produces; the tests
// check both, plus the shared vector in contracts/test/vectors/state.json.
//
//   structHash = keccak256(abi.encode(TYPEHASH, tableId, nonce, isFinal,
//                                     keccak256(players as 32-byte words), keccak256(balances),
//                                     keccak256(keep as 32-byte words), rake, volume))
//   digest     = keccak256(0x1901 || domainSeparator || structHash)
//
// The field list is not repeated here: both the type string and the encoding are driven by STATE_TYPES from
// @pgg/protocol/vault, so that package stays the single source and a change to it changes the typehash.
import { STATE_TYPES, VAULT_NAME, VAULT_VERSION } from '@pgg/protocol/vault';
import { addressWord, boolWord, bytes32Word, concat, keccakHex, uintWord, utf8 } from './bytes.js';
import { fromHex } from './sign.js';
import { decodeState, normalizeAddress } from './state.js';

const DOMAIN_TYPE_STRING =
  'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)';

/** 'State(bytes32 tableId,uint64 nonce,...)', built from STATE_TYPES. */
export const STATE_TYPE_STRING = `State(${STATE_TYPES.State.map((f) => `${f.type} ${f.name}`).join(',')})`;
export const STATE_TYPEHASH = keccakHex(utf8(STATE_TYPE_STRING));
export const DOMAIN_TYPEHASH = keccakHex(utf8(DOMAIN_TYPE_STRING));

// How one value of each supported type becomes a 32-byte word. Arrays of these hash their words together.
const WORD = {
  bytes32: bytes32Word,
  uint64: uintWord,
  uint256: uintWord,
  bool: boolWord,
  address: addressWord,
};

for (const { type, name } of STATE_TYPES.State) {
  const element = type.endsWith('[]') ? type.slice(0, -2) : type;
  if (!WORD[element]) throw new Error(`eip712.js cannot encode ${type} ${name}; extend WORD`);
}

function encodeField(type, value) {
  if (type.endsWith('[]')) {
    const word = WORD[type.slice(0, -2)];
    return fromHex(keccakHex(concat(value.map(word))));
  }
  return WORD[type](value);
}

/**
 * The domain every state is signed under: the chain and the vault's address (name and version are fixed by
 * the contract). Chain id must be a positive safe integer; the address is lowercased.
 */
export function normalizeDomain(domain) {
  if (domain === null || typeof domain !== 'object')
    throw new RangeError('domain must be an object');
  const chainId = typeof domain.chainId === 'bigint' ? Number(domain.chainId) : domain.chainId;
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new RangeError('domain.chainId must be a positive safe integer');
  }
  return {
    chainId,
    verifyingContract: normalizeAddress(domain.verifyingContract, 'domain.verifyingContract'),
  };
}

export const domainsEqual = (a, b) => {
  try {
    const x = normalizeDomain(a);
    const y = normalizeDomain(b);
    return x.chainId === y.chainId && x.verifyingContract === y.verifyingContract;
  } catch {
    return false;
  }
};

/** The EIP-712 domain separator, as PokerVault.domainSeparator() returns it. */
export function domainSeparator(domain) {
  const d = normalizeDomain(domain);
  return keccakHex(
    concat([
      fromHex(DOMAIN_TYPEHASH),
      fromHex(keccakHex(utf8(VAULT_NAME))),
      fromHex(keccakHex(utf8(VAULT_VERSION))),
      uintWord(BigInt(d.chainId)),
      addressWord(d.verifyingContract),
    ]),
  );
}

/**
 * hashStruct(State). Checks types and ranges only (what the contract's ABI decoder would), not the
 * roster rules: the contract hashes whatever it is given, and checkState needs to hash states that other
 * checks reject.
 */
export function hashStruct(state) {
  const s = decodeState(state);
  const words = STATE_TYPES.State.map((field) => encodeField(field.type, s[field.name]));
  return keccakHex(concat([fromHex(STATE_TYPEHASH), ...words]));
}

/** The digest the arbiter and every player sign: '0x' + 64 hex. */
export function hashState(state, domain) {
  return keccakHex(
    concat([
      new Uint8Array([0x19, 0x01]),
      fromHex(domainSeparator(domain)),
      fromHex(hashStruct(state)),
    ]),
  );
}
