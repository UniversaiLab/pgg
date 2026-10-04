// Stateless signed tokens: base64url(JSON payload) "." base64url(HMAC-SHA256).
// Play-money milestone only: the token proves "this is the player the server created", nothing more.
// Milestone 2 replaces login with wallet signatures (SIWE) and session keys.

import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toB64u = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

function fromB64u(text) {
  const padded =
    text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

// Constant-time comparison so signature checks leak nothing through timing.
function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const sign = (secret, body) => hmac(sha256, utf8ToBytes(secret), encoder.encode(body));

/** @param {{ id: string, name: string, exp: number }} payload exp is epoch milliseconds */
export function signToken(secret, payload) {
  const body = toB64u(encoder.encode(JSON.stringify(payload)));
  return `${body}.${toB64u(sign(secret, body))}`;
}

/** @returns {{ id: string, name: string, exp: number } | null} null for anything invalid */
export function verifyToken(secret, token, now = Date.now()) {
  try {
    if (typeof token !== 'string' || token.length > 512) return null;
    const [body, signature, extra] = token.split('.');
    if (!body || !signature || extra !== undefined) return null;
    if (!equalBytes(sign(secret, body), fromB64u(signature))) return null;
    const payload = JSON.parse(decoder.decode(fromB64u(body)));
    const valid =
      typeof payload.id === 'string' &&
      typeof payload.name === 'string' &&
      Number.isFinite(payload.exp) &&
      payload.exp > now;
    return valid ? payload : null;
  } catch {
    return null;
  }
}
