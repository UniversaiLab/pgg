// Starts the watchdog, then freezes the event loop. The process must be killed from outside.
import { startWatchdog } from '../../src/watchdog.js';

startWatchdog({ stallMs: 600, heartbeatMs: 50 });
setTimeout(() => {
  console.log('freezing');
  for (;;); // eslint-disable-line no-empty
}, 300);
