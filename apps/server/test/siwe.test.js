import { describe, expect, test } from 'bun:test';
import { privateKeyToAccount } from 'viem/accounts';
import { createApp } from '../src/app.js';
import { verifyToken } from '../src/auth.js';
import { NonceBook, siweMessage, verifySiwe } from '../src/siwe.js';
import { PlayMoneyWallet } from '../src/wallet.js';

const account = privateKeyToAccount(`0x${'42'.repeat(32)}`);
const other = privateKeyToAccount(`0x${'43'.repeat(32)}`);
const NOW = Date.parse('2026-10-26T12:00:00Z');
const message = (over = {}) =>
  siweMessage({
    domain: 'pgg.test',
    address: account.address,
    uri: 'https://pgg.test',
    chainId: 31337,
    nonce: over.nonce,
    issuedAt: new Date(NOW).toISOString(),
    expirationTime: new Date(NOW + 600_000).toISOString(),
    ...over,
  });
const check = async (over = {}, signer = account, opts = {}) => {
  const nonces = opts.nonces ?? new NonceBook({ now: () => NOW });
  const nonce = opts.nonce ?? nonces.issue();
  const text = message({ nonce, ...over });
  const signature = await signer.signMessage({ message: text });
  return verifySiwe({
    message: text,
    signature,
    nonces,
    domains: ['pgg.test'],
    chainId: 31337,
    now: NOW,
  });
};

describe('sign-in with a wallet', () => {
  test('a valid signature signs in that wallet', async () => {
    expect(await check()).toEqual({ ok: true, address: account.address.toLowerCase() });
  });

  test('refused: another wallet signed, another site, another chain, expired, unknown nonce', async () => {
    expect((await check({}, other)).ok).toBe(false);
    expect((await check({ domain: 'evil.test' })).ok).toBe(false);
    expect((await check({ chainId: 1 })).ok).toBe(false);
    expect((await check({ expirationTime: new Date(NOW - 1).toISOString() })).ok).toBe(false);
    expect((await check({}, account, { nonce: 'made-up' })).ok).toBe(false);
  });

  test('a nonce works once', async () => {
    const nonces = new NonceBook({ now: () => NOW });
    const nonce = nonces.issue();
    expect((await check({}, account, { nonces, nonce })).ok).toBe(true);
    expect((await check({}, account, { nonces, nonce })).ok).toBe(false);
  });

  test('the HTTP flow issues a token whose player id is the wallet', async () => {
    const config = { secret: 's', tokenTtlMs: 60_000, corsOrigins: [], vault: { chainId: 31337 } };
    const app = createApp({
      config,
      wallet: new PlayMoneyWallet({ startBalance: 100 }),
      registry: { size: 0, summaries: () => [] },
    });
    const { nonce } = await (await app.request('http://pgg.test/api/siwe/nonce')).json();
    const text = siweMessage({
      domain: 'pgg.test',
      address: account.address,
      uri: 'http://pgg.test',
      chainId: 31337,
      nonce,
      issuedAt: new Date().toISOString(),
      expirationTime: new Date(Date.now() + 600_000).toISOString(),
    });
    const signature = await account.signMessage({ message: text });
    const res = await app.request('http://pgg.test/api/siwe/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: text, signature, name: 'Alex' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const claims = verifyToken('s', body.token);
    expect(claims.id).toBe(account.address.toLowerCase());
    expect(claims.wallet).toBe(account.address.toLowerCase());
    expect(claims.name).toBe('Alex');
    // replaying the same signed message fails: its nonce is spent
    const again = await app.request('http://pgg.test/api/siwe/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: text, signature }),
    });
    expect(again.status).toBe(401);
  });
});
