/** Play-money login: a name gets a token and a starting balance; a token resumes the same player. */
export async function devLogin({ name, token }, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl('/api/dev-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(token ? { token } : { name }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `login failed (${response.status})`);
  }
  return response.json(); // { token, player: { id, name, balance } }
}

/** Wallet sign-in: a nonce, then the signed EIP-4361 message. -> { token, player } */
export async function siweNonce(fetchImpl = globalThis.fetch) {
  const response = await fetchImpl('/api/siwe/nonce');
  if (!response.ok) throw new Error('could not start the wallet sign-in');
  return (await response.json()).nonce;
}

export async function siweVerify({ message, signature, name }, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl('/api/siwe/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, signature, name }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `sign-in failed (${response.status})`);
  }
  return response.json();
}
