// The arbiter's signing key behind the narrowest interface that works (docs/signing-layer.md, ArbiterSigner).
// There is deliberately no method that signs "a digest": the only thing this object will sign is the digest
// the store RESERVED for a table and nonce. The store's primary key (table, nonce) is the double-sign guard,
// so a coding mistake that asks for a second digest at a nonce, or for a nonce nobody reserved, throws here
// instead of producing a signature the contract would honour.
//
// Synchronous for a local key. A KMS or HSM signer is asynchronous and a later change; the order the
// coordinator uses (reserve, sign, attach, send) already allows it.
import { privateKeyToAddress, signDigest } from '@pgg/vault';

const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

export class LocalKeySigner {
  #privateKey;
  #reserved;
  #address;

  /**
   * @param {{ privateKey: string, reserved: (tableKey: string, nonce: bigint) => (string | null | undefined) }} options
   *   privateKey  32 bytes of 0x hex. Development only; production uses a KMS-backed signer.
   *   reserved    returns the digest the store reserved for that table and nonce, or nothing
   */
  constructor({ privateKey, reserved }) {
    if (typeof privateKey !== 'string' || !PRIVATE_KEY.test(privateKey)) {
      throw new TypeError('privateKey must be 32 bytes of 0x hex');
    }
    if (typeof reserved !== 'function') throw new TypeError('reserved must be a function');
    this.#privateKey = privateKey;
    this.#reserved = reserved;
    this.#address = privateKeyToAddress(privateKey);
    Object.freeze(this);
  }

  /** The arbiter's address: what the vault stores as the table's arbiter. */
  get address() {
    return this.#address;
  }

  /**
   * Signs the digest reserved for (tableKey, nonce): '0x' + r || s || v, deterministic, so signing again after
   * a crash gives the same bytes. Throws when nothing is reserved or the store returns something that is not a
   * digest.
   */
  signReserved(tableKey, nonce) {
    if (typeof tableKey !== 'string' || tableKey === '') {
      throw new TypeError('tableKey must be a non-empty string');
    }
    const n = typeof nonce === 'number' && Number.isSafeInteger(nonce) ? BigInt(nonce) : nonce;
    if (typeof n !== 'bigint' || n < 0n) throw new TypeError('nonce must be a non-negative bigint');
    const digest = this.#reserved(tableKey, n);
    if (digest === null || digest === undefined) {
      throw new Error(`nothing is reserved for table ${tableKey} at nonce ${n}; refusing to sign`);
    }
    if (typeof digest !== 'string' || !BYTES32.test(digest)) {
      throw new TypeError('the reserved digest must be 32 bytes of 0x hex');
    }
    return signDigest(this.#privateKey, digest);
  }
}
