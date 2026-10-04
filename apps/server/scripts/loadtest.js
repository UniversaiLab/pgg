// One-command load test with the load generator spread over several processes, so the clients
// are not the bottleneck being measured.
//
//   bun apps/server/scripts/loadtest.js --tables 600 --clients 3 --seconds 30 --think 150
//
// Starts the server in its own process, starts --clients bot processes (each takes an equal share
// of the tables), and reports aggregate throughput, latency percentiles and the SERVER's own CPU
// and memory read from /proc (Linux). Latency is measured by the bots, so it still includes their
// event-loop delay; with enough client processes that is small next to the server's.

import { readFileSync } from 'node:fs';
import { sleep } from '../test/bot.js';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .flatMap((arg, i, all) => (arg.startsWith('--') ? [[arg.slice(2), all[i + 1]]] : [])),
);
const num = (name, fallback) => (args[name] === undefined ? fallback : Number(args[name]));
const TABLES = num('tables', 300);
const CLIENTS = num('clients', 3);
const SECONDS = num('seconds', 20);
const THINK = num('think', 150);
const PORT = num('port', 18788);
const perClient = Math.ceil(TABLES / CLIENTS);

const proc = (pid) => {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ');
  const rss = readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)?.[1];
  return { cpu: (Number(stat[13]) + Number(stat[14])) / 100, rssMb: Number(rss) / 1024 };
};
const percentile = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

const server = Bun.spawn(['bun', new URL('../src/index.js', import.meta.url).pathname], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    PGG_SECRET: 'load-test',
    LOAD_TABLES: String(perClient * CLIENTS),
    START_BALANCE: '1000000',
    TURN_MS: '30000',
    INTER_HAND_MS: '300',
    RATE_CAPACITY: '1000',
    RATE_REFILL: '1000',
  },
  stdout: 'ignore',
  stderr: 'inherit',
});
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break;
  } catch {}
  await sleep(50);
}

console.log(
  `${perClient * CLIENTS} tables, ${perClient * CLIENTS * 6} connections from ${CLIENTS} client processes, think ${THINK} ms, ${SECONDS}s`,
);
const clients = Array.from({ length: CLIENTS }, (_, k) =>
  Bun.spawn(
    [
      'bun',
      new URL('./bots.js', import.meta.url).pathname,
      '--url',
      `http://127.0.0.1:${PORT}`,
      '--tables',
      String(perClient),
      '--offset',
      String(k * perClient),
      '--seconds',
      String(SECONDS),
      '--think',
      String(THINK),
      '--json',
      '1',
    ],
    { stdout: 'pipe', stderr: 'inherit' },
  ),
);

// Server CPU/memory over the window in which the clients are all playing.
await sleep(2000 + 0); // let the clients connect and sit down
const start = proc(server.pid);
const t0 = performance.now();
let peak = start.rssMb;
const sampler = setInterval(() => (peak = Math.max(peak, proc(server.pid).rssMb)), 500);
const outputs = await Promise.all(clients.map((client) => new Response(client.stdout).text()));
clearInterval(sampler);
const end = proc(server.pid);
const elapsed = (performance.now() - t0) / 1000;

const results = outputs.map((out) =>
  JSON.parse(
    out
      .split('\n')
      .find((line) => line.startsWith('JSON '))
      ?.slice(5) ?? '{}',
  ),
);
const sum = (key) => results.reduce((total, r) => total + (r[key] ?? 0), 0);
const latencies = results.flatMap((r) => r.latencies ?? []).sort((a, b) => a - b);

console.log('\n--- results (aggregate) ---');
console.log(`seated at end      ${sum('seated')}/${sum('total')}`);
console.log(`actions            ${sum('actions')}  (${(sum('actions') / SECONDS).toFixed(0)}/s)`);
console.log(
  `hands (approx)     ${sum('hands').toFixed(0)}  (${(sum('hands') / SECONDS).toFixed(1)}/s)`,
);
console.log(`messages received  ${sum('received')}  (${(sum('received') / SECONDS).toFixed(0)}/s)`);
console.log(
  `action->broadcast  p50 ${percentile(latencies, 50).toFixed(1)} ms  p95 ${percentile(latencies, 95).toFixed(1)} ms  p99 ${percentile(latencies, 99).toFixed(1)} ms  max ${latencies.at(-1).toFixed(1)} ms  (sampled n=${latencies.length})`,
);
console.log(
  `server CPU         ${(end.cpu - start.cpu).toFixed(1)}s over ${elapsed.toFixed(1)}s = ${(((end.cpu - start.cpu) / elapsed) * 100).toFixed(0)}% of one core`,
);
console.log(`server memory      ${end.rssMb.toFixed(0)} MB (peak ${peak.toFixed(0)} MB)`);
console.log(`errors             ${sum('errors')}`);
server.kill();
process.exit(0);
