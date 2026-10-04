// Starts the watchdog and stays busy-but-responsive for longer than the stall limit, then exits.
import { startWatchdog } from '../../src/watchdog.js';

startWatchdog({ stallMs: 600, heartbeatMs: 50 });
const end = Date.now() + 1800;
const tick = () => {
  const until = Date.now() + 100;
  while (Date.now() < until); // 100 ms of work, far below the 600 ms limit
  if (Date.now() < end) setTimeout(tick, 10);
  else console.log('finished');
};
tick();
