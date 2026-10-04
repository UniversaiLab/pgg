import { LIMITS } from '@pgg/protocol/constants';
import { createApp } from './app.js';
import { verifyToken } from './auth.js';
import { loadConfig } from './config.js';
import { Hub } from './hub.js';
import { TokenBucket } from './ratelimit.js';
import { Registry } from './registry.js';
import { realClock, TableActor } from './table-actor.js';
import { PlayMoneyWallet } from './wallet.js';

/**
 * Build and start the whole game server. Used by index.js and, with port 0 and a short clock, by
 * the end-to-end tests.
 */
export function createGame(config = loadConfig(), { clock = realClock } = {}) {
  const wallet = new PlayMoneyWallet({ startBalance: config.startBalance });
  const registry = new Registry();
  const hub = new Hub({ wallet, registry });

  for (const table of config.tables) {
    registry.add(
      new TableActor({
        cfg: {
          ...table,
          turnMs: config.turnMs,
          interHandMs: config.interHandMs,
          sitoutGraceMs: config.sitoutGraceMs,
        },
        bus: hub,
        wallet,
        clock,
        onChange: () => hub.markLobbyDirty(),
        onSeat: (playerId, tableId) => registry.setSeat(playerId, tableId),
      }),
    );
  }

  const app = createApp({ config, wallet, registry });

  const server = Bun.serve({
    port: config.port,
    hostname: config.hostname,
    fetch(request, bunServer) {
      const url = new URL(request.url);
      if (url.pathname !== '/ws') return app.fetch(request);

      // The token is a query parameter because browsers cannot set headers on a WebSocket.
      // It is a play-money session token; Milestone 2 authenticates with wallet signatures.
      const claims = verifyToken(config.secret, url.searchParams.get('token'));
      if (!claims) return new Response('unauthorized', { status: 401 });
      wallet.open(claims.id);
      const upgraded = bunServer.upgrade(request, {
        data: {
          player: { id: claims.id, name: claims.name },
          bucket: new TokenBucket(config.rateLimit),
          strikes: 0,
        },
      });
      return upgraded ? undefined : new Response('upgrade failed', { status: 400 });
    },
    websocket: {
      ...hub.handlers,
      maxPayloadLength: LIMITS.maxMessageBytes * 2,
      idleTimeout: 60,
      perMessageDeflate: false, // CPU matters more than bytes for our small messages
    },
  });
  hub.setServer(server);

  return {
    server,
    app,
    wallet,
    registry,
    hub,
    config,
    url: `http://localhost:${server.port}`,
    wsUrl: `ws://localhost:${server.port}/ws`,
    stop() {
      hub.stop();
      registry.destroyAll();
      server.stop(true);
    },
  };
}
