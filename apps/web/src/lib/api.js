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
