import { loadConfig } from './config.js';
import { createGame } from './server.js';
import { realClock } from './table-actor.js';
import { startWatchdog } from './watchdog.js';

const config = loadConfig();
if (config.secretIsEphemeral) {
  console.warn('PGG_SECRET is not set: using a random one, so logins reset on every restart.');
}

// Vault tables (VAULT_TABLES) need the chain and the store before the first socket is accepted. The
// module is loaded only then, so a play-money server never loads the vault stack.
let vault = null;
if (config.vault) {
  const { createVaultSetup } = await import('./vault/boot.js');
  vault = await createVaultSetup(config.vault, { clock: realClock });
}

const game = createGame(config, { vault });
if (config.watchdogMs > 0) startWatchdog({ stallMs: config.watchdogMs });
console.log(`pgg server listening on ${game.url}  (websocket ${game.wsUrl})`);
console.log(`tables: ${config.tables.map((t) => t.id).join(', ')}`);
if (vault) {
  console.log(
    `vault tables: ${vault.tables.map((t) => t.id).join(', ')} on chain ${vault.info.chainId}`,
  );
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    game.stop();
    process.exit(0);
  });
}
