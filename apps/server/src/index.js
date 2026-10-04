import { loadConfig } from './config.js';
import { createGame } from './server.js';
import { startWatchdog } from './watchdog.js';

const config = loadConfig();
if (config.secretIsEphemeral) {
  console.warn('PGG_SECRET is not set: using a random one, so logins reset on every restart.');
}

const game = createGame(config);
if (config.watchdogMs > 0) startWatchdog({ stallMs: config.watchdogMs });
console.log(`pgg server listening on ${game.url}  (websocket ${game.wsUrl})`);
console.log(`tables: ${config.tables.map((t) => t.id).join(', ')}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    game.stop();
    process.exit(0);
  });
}
