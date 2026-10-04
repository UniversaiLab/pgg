// Liveness watchdog. A JavaScript infinite loop cannot be interrupted from inside the process, and
// a wedged server that still holds its port looks healthy to a load balancer's TCP check while
// serving nobody. So a separate thread watches a heartbeat that the main thread refreshes, and
// kills the whole process if it stops: crash-only design, restarted by whatever supervises us
// (systemd, Docker, Kubernetes). Hands in flight are lost; play-money chips are in memory anyway,
// and Milestone 2 persists state so a restart loses nothing.

export function startWatchdog({ stallMs = 10_000, heartbeatMs = 250 } = {}) {
  const shared = new SharedArrayBuffer(8);
  const beat = new BigInt64Array(shared);
  const stamp = () => Atomics.store(beat, 0, BigInt(Date.now()));
  stamp();

  const timer = setInterval(stamp, heartbeatMs);
  timer.unref?.(); // never keep the process alive just for the heartbeat

  const worker = new Worker(new URL('./watchdog-worker.js', import.meta.url).href);
  worker.postMessage({ shared, stallMs });
  worker.unref?.();

  return {
    stop() {
      clearInterval(timer);
      worker.terminate();
    },
  };
}
