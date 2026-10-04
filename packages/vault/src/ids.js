// Names and proofs that tie the off-chain table to the on-chain one.
//
// tableKey   the bytes32 used as the vault's tableId. Derived, not random, so a restarted server finds the
//            same table, and a new generation (after a table closed) gets a fresh id.
// claim      a session-key signature that says "this browser holds the session key of this on-chain seat
//            and is player `playerId`". The server checks it against seats(tableKey, address).sessionKey.
//            It is the stand-in for wallet sign-in until SIWE exists. It is not an EIP-712 message on
//            purpose: it can never be mistaken for a State digest (those start with 0x1901).
import { concat, keccakHex, uintWord, utf8 } from './bytes.js';
import { normalizeDomain } from './eip712.js';
import { fromHex, recoverSigner, signDigest } from './sign.js';
import { normalizeAddress } from './state.js';

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const CLAIM_PREFIX = 'PGG claim v1';

/** keccak256(utf8("pgg:" + chainId + ":" + vault + ":" + serverId + ":" + generation)), vault lowercase. */
export function tableKeyFor({ chainId, vault, serverId, generation }) {
  const domain = normalizeDomain({ chainId, verifyingContract: vault });
  if (typeof serverId !== 'string' || serverId === '' || serverId.includes(':')) {
    throw new RangeError('serverId must be a non-empty string without ":"');
  }
  const whole = typeof generation === 'bigint' || Number.isSafeInteger(generation);
  if (!whole || generation < 0) throw new RangeError('generation must be a non-negative integer');
  return keccakHex(
    utf8(`pgg:${domain.chainId}:${domain.verifyingContract}:${serverId}:${generation}`),
  );
}

/**
 * keccak256( "PGG claim v1" || uint256(chainId) || vault (20 bytes) || tableKey (32 bytes)
 *            || address (20 bytes) || utf8(playerId) ). Every part before playerId has a fixed width, so
 * no two different claims share a preimage.
 */
export function claimDigest({ domain, tableKey, address, playerId }) {
  const d = normalizeDomain(domain);
  if (typeof tableKey !== 'string' || !BYTES32.test(tableKey)) {
    throw new RangeError('tableKey must be 32 bytes of 0x hex');
  }
  if (typeof playerId !== 'string' || playerId === '') {
    throw new RangeError('playerId must be a non-empty string');
  }
  return keccakHex(
    concat([
      utf8(CLAIM_PREFIX),
      uintWord(BigInt(d.chainId)),
      fromHex(d.verifyingContract),
      fromHex(tableKey),
      fromHex(normalizeAddress(address)),
      utf8(playerId),
    ]),
  );
}

/** Sign a claim with the seat's session key. Returns the 65-byte signature. */
export const signClaim = (sessionPrivateKey, claim) =>
  signDigest(sessionPrivateKey, claimDigest(claim));

/** The address that signed the claim (lowercase), or null for a signature the vault would not accept. */
export const recoverClaim = (claim, signature) => recoverSigner(claimDigest(claim), signature);

/** True when `signature` is a claim signature by `sessionKey` (the seat's on-chain session key). */
export function verifyClaim(claim, signature, sessionKey) {
  const signer = recoverClaim(claim, signature);
  return signer !== null && sessionKey != null && signer === sessionKey.toLowerCase();
}
