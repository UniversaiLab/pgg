// @pgg/vault: the signing layer for PokerVault. Phase 0 exports only the signature primitives; the
// rest of the library is added in Phase 1.
export {
  fromHex,
  keccak256,
  newPrivateKey,
  privateKeyToAddress,
  publicKeyToAddress,
  recoverSigner,
  signDigest,
  toHex,
} from './sign.js';
