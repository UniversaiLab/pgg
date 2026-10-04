// Runs on its own thread, so it keeps running while the main thread is stuck in a loop.
self.onmessage = ({ data: { shared, stallMs } }) => {
  const beat = new BigInt64Array(shared);
  setInterval(() => {
    const silentMs = Date.now() - Number(Atomics.load(beat, 0));
    if (silentMs > stallMs) {
      console.error(
        `watchdog: the event loop has been stuck for ${silentMs} ms; killing the process`,
      );
      process.kill(process.pid, 'SIGKILL');
    }
  }, 250);
};
