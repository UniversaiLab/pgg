// Sign-In with Ethereum (EIP-4361): a player proves they control a wallet by signing a short text message with
// it (personal_sign). The server hands out single-use nonces, checks the message names this site, this nonce
// and a time window, and recovers the signer. The session token then carries the wallet as the player id, so
// a real-money seat and the account playing it are the same wallet.
import { keccak256, recoverSigner, toHex } from '@pgg/vault';

const encoder = new TextEncoder();
const NONCE_TTL_MS = 5 * 60_000;
const MAX_NONCES = 10_000;
const MAX_MESSAGE = 2_000;

/** Single-use nonces, forgotten after a few minutes. */
export class NonceBook {
  #nonces = new Map(); // nonce -> expiry (ms)
  #now;

  constructor({ now = () => Date.now() } = {}) {
    this.#now = now;
  }

  issue() {
    const now = this.#now();
    if (this.#nonces.size >= MAX_NONCES) {
      for (const [nonce, exp] of this.#nonces) if (exp <= now) this.#nonces.delete(nonce);
      if (this.#nonces.size >= MAX_NONCES) this.#nonces.delete(this.#nonces.keys().next().value);
    }
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    this.#nonces.set(nonce, now + NONCE_TTL_MS);
    return nonce;
  }

  /** True once per issued, unexpired nonce. */
  take(nonce) {
    const exp = this.#nonces.get(nonce);
    this.#nonces.delete(nonce);
    return exp !== undefined && exp > this.#now();
  }
}

/** The EIP-191 digest personal_sign signs. */
export function personalDigest(message) {
  const bytes = encoder.encode(message);
  const prefix = encoder.encode(`\x19Ethereum Signed Message:\n${bytes.length}`);
  const all = new Uint8Array(prefix.length + bytes.length);
  all.set(prefix);
  all.set(bytes, prefix.length);
  return toHex(keccak256(all));
}

/** Build the message the wallet shows (EIP-4361 layout). */
export function siweMessage({ domain, address, uri, chainId, nonce, issuedAt, expirationTime }) {
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    '',
    'Sign in to PGG. This signature only proves you own this wallet; it cannot move funds.',
    '',
    `URI: ${uri}`,
    'Version: 1',
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expirationTime}`,
  ].join('\n');
}

/** Parse the fields we check out of an EIP-4361 message. Null when it is not one. */
export function parseSiwe(message) {
  if (typeof message !== 'string' || message.length > MAX_MESSAGE) return null;
  const lines = message.split('\n');
  const head = /^(\S+) wants you to sign in with your Ethereum account:$/.exec(lines[0] ?? '');
  const address = lines[1] ?? '';
  if (!head || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  const field = (name) => {
    const line = lines.find((l) => l.startsWith(`${name}: `));
    return line ? line.slice(name.length + 2) : null;
  };
  return {
    domain: head[1],
    address: address.toLowerCase(),
    uri: field('URI'),
    version: field('Version'),
    chainId: Number(field('Chain ID')),
    nonce: field('Nonce'),
    issuedAt: field('Issued At'),
    expirationTime: field('Expiration Time'),
  };
}

/**
 * Check a signed sign-in message. -> { ok: true, address } | { ok: false, error }
 *   domains  the hosts this server answers as (the message must name one of them)
 *   chainId  when set, the message must name it
 */
export function verifySiwe({
  message,
  signature,
  nonces,
  domains,
  chainId = null,
  now = Date.now(),
}) {
  const m = parseSiwe(message);
  if (!m) return { ok: false, error: 'not a sign-in message' };
  if (!domains.includes(m.domain)) return { ok: false, error: 'the message is for another site' };
  if (m.version !== '1') return { ok: false, error: 'unsupported message version' };
  if (chainId !== null && m.chainId !== Number(chainId)) {
    return { ok: false, error: 'the message is for another chain' };
  }
  const issued = Date.parse(m.issuedAt ?? '');
  const expires = Date.parse(m.expirationTime ?? '');
  if (!Number.isFinite(issued) || !Number.isFinite(expires)) {
    return { ok: false, error: 'the message has no valid time window' };
  }
  if (issued > now + 60_000 || expires <= now)
    return { ok: false, error: 'the message has expired' };
  const signer = recoverSigner(personalDigest(message), signature);
  if (!signer) return { ok: false, error: 'bad signature' };
  if (signer.toLowerCase() !== m.address)
    return { ok: false, error: 'the signature is not from that wallet' };
  // the nonce is spent only by a message that is otherwise valid, so a bad attempt cannot burn someone's nonce
  if (!m.nonce || !nonces.take(m.nonce)) return { ok: false, error: 'unknown or used nonce' };
  return { ok: true, address: m.address };
}
