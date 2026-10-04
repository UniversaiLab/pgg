// HTTP side (Hono): login, lobby, health. Anything latency-sensitive uses the WebSocket instead.

import { LIMITS } from '@pgg/protocol/constants';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { signToken, verifyToken } from './auth.js';

const NAME = /^[\p{L}\p{N} ._-]+$/u;

function cleanName(input) {
  const name = typeof input === 'string' ? input.trim().replace(/\s+/g, ' ') : '';
  if (name.length === 0 || name.length > LIMITS.maxNameLength || !NAME.test(name)) return null;
  return name;
}

export function createApp({ config, wallet, registry }) {
  const app = new Hono();
  app.use('/api/*', cors({ origin: config.corsOrigins }));

  app.get('/api/health', (c) => c.json({ ok: true, tables: registry.size }));
  app.get('/api/tables', (c) => c.json({ tables: registry.summaries() }));

  // Play-money login: pick a name, get a signed token and a starting balance. A previously issued
  // token resumes the same player. Replaced by wallet sign-in in Milestone 2.
  app.post('/api/dev-login', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const resumed = verifyToken(config.secret, body.token);
    const name = resumed ? resumed.name : cleanName(body.name);
    if (!name) return c.json({ error: 'name must be 1-20 letters, numbers, spaces . _ -' }, 400);

    const id = resumed ? resumed.id : crypto.randomUUID();
    const balance = wallet.open(id);
    const token = resumed
      ? body.token
      : signToken(config.secret, { id, name, exp: Date.now() + config.tokenTtlMs });
    return c.json({ token, player: { id, name, balance: wallet.balance(id) ?? balance } });
  });

  return app;
}
