// @pgg/vault: the signing layer for PokerVault. Pure and browser-safe (no node: imports, no viem): the
// server (arbiter), the web client, the test bots and the watchtower all build, hash, check and verify
// States with this one package. README.md has the shapes and a worked example.
export { pokerVaultAbi } from './abi.js';
export { buildNextState, depositState, epochBaseline, genesisState, sortRoster } from './build.js';
export {
  bundleConflict,
  bundleDigest,
  bundleFromWire,
  bundleToWire,
  EXPECT_ERRORS,
  isNewer,
  makeBundle,
  verifyBundle,
} from './bundle.js';
export { UINT64_MAX, UINT256_MAX } from './bytes.js';
export {
  checkSettle,
  checkState,
  ERRORS,
  RAKE_BPS_CEILING,
  STATUS,
  tableFromChain,
} from './check.js';
export {
  DOMAIN_TYPEHASH,
  domainSeparator,
  domainsEqual,
  hashState,
  hashStruct,
  normalizeDomain,
  STATE_TYPE_STRING,
  STATE_TYPEHASH,
} from './eip712.js';
export { claimDigest, recoverClaim, signClaim, tableKeyFor, verifyClaim } from './ids.js';
export {
  canDeal,
  clientShouldSign,
  dealBlocker,
  decideSign,
  RULES,
  serverMayCoSign,
} from './rules.js';
export {
  fromHex,
  keccak256,
  newPrivateKey,
  privateKeyToAddress,
  publicKeyToAddress,
  recoverSigner,
  signDigest,
  toHex,
  tryRecoverSigner,
} from './sign.js';
export {
  compareAddress,
  decodeState,
  fromWire,
  isStrictlyAscending,
  MAX_PLAYERS,
  MIN_PLAYERS,
  normalizeAddress,
  normalizeState,
  rosterHash,
  statesEqual,
  toWire,
} from './state.js';
export { toChips, toTokenUnits } from './units.js';
