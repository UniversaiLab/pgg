// Load test: many tables full of scripted bots playing real hands over real WebSockets.
//
//   bun apps/server/scripts/bots.js --tables 50 --seconds 30 --think 150
//
// By default the server runs in a SEPARATE process, so its CPU and memory are measured on their
// own (Linux, via /proc) instead of being mixed up with the bots'. Use --url to test a server you
// started yourself (then server CPU/memory are not available).
//
// Latency is "action sent -> the broadcast that contains it comes back", seen by the bot, so it
// includes the bots' own event-loop delay. On one machine it is an upper bound for the server.

import { readFileSync } from 'node:fs';
import { Bot, sleep, until } from '../test/bot.js';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .flatMap((arg, i, all) => (arg.startsWith('--') ? [[arg.slice(2), all[i + 1]]] : [])),
);
const num = (name, fallback) => (args[name] === undefined ? fallback : Number(args[name]));

const TABLES = num('tables', 20);
const OFFSET = num('offset', 0); // first table number - 1, so several client processes can share a server
const SEATS = num('seats', 6);
const SECONDS = num('seconds', 20);
const THINK_MS = num('think', 100);
const PORT = num('port', 18787);
const REMOTE = args.url;

const percentile = (sorted, p) =>
  sorted.length === 0
    ? NaN
    : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

function procStats(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ');
    const ticks = Number(stat[13]) + Number(stat[14]); // utime + stime, in clock ticks (100/s)
    const rssKb = Number(
      readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)?.[1] ?? 0,
    );
    return { cpuSeconds: ticks / 100, rssMb: rssKb / 1024 };
  } catch {
    return null;
  }
}

let child = null;
let httpUrl = REMOTE;
if (!REMOTE) {
  child = Bun.spawn(['bun', new URL('../src/index.js', import.meta.url).pathname], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      PGG_SECRET: 'load-test',
      LOAD_TABLES: String(TABLES),
      START_BALANCE: '1000000',
      TURN_MS: '30000',
      INTER_HAND_MS: '300',
      RATE_CAPACITY: '1000',
      RATE_REFILL: '1000',
    },
    stdout: 'ignore',
    stderr: 'inherit',
  });
  httpUrl = `http://127.0.0.1:${PORT}`;
  await until(async () => false, { timeout: 0 }).catch(() => {});
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${httpUrl}/api/health`)).ok) break;
    } catch {}
    await sleep(50);
  }
}
const wsUrl = `${httpUrl.replace('http', 'ws')}/ws`;

const total = TABLES * SEATS;
console.log(
  `${TABLES} tables x ${SEATS} bots = ${total} connections, think ${THINK_MS} ms, ${SECONDS}s`,
);

const bots = [];
const connectStart = performance.now();
for (let start = 0; start < total; start += 100) {
  await Promise.all(
    Array.from({ length: Math.min(100, total - start) }, async (_, k) => {
      const index = start + k;
      const table = `load-${OFFSET + (index % TABLES) + 1}`;
      const bot = new Bot({
        httpUrl,
        wsUrl,
        name: `bot${index}`,
        seed: 1000 + index,
        validate: false,
        thinkMs: THINK_MS,
        aggression: 18,
        rejoin: { tableId: table, buyIn: 1000 },
      });
      await bot.login();
      await bot.connect();
      bot.tableTarget = table;
      bots.push(bot);
    }),
  );
}
console.log(`connected in ${((performance.now() - connectStart) / 1000).toFixed(1)}s`);

for (const bot of bots) {
  bot.join(bot.tableTarget, 1000);
  bot.autoplay = true;
}

const before = child ? procStats(child.pid) : null;
const startedAt = performance.now();
let peakRss = before?.rssMb ?? 0;
const sampler = setInterval(() => {
  const now = child ? procStats(child.pid) : null;
  if (now) peakRss = Math.max(peakRss, now.rssMb);
}, 500);
await sleep(SECONDS * 1000);
clearInterval(sampler);
const elapsed = (performance.now() - startedAt) / 1000;
const after = child ? procStats(child.pid) : null;

const latencies = bots.flatMap((bot) => bot.latencies).sort((a, b) => a - b);
const actions = bots.reduce((sum, bot) => sum + bot.actionsSent, 0);
const hands = bots.reduce((sum, bot) => sum + bot.handsEnded, 0) / SEATS; // each hand seen by ~SEATS bots
const errors = bots.flatMap((bot) => bot.errors);
const seated = bots.filter((bot) => bot.tableId !== null).length;
const received = bots.reduce((sum, bot) => sum + bot.log.length, 0);

console.log('\n--- results ---');
console.log(`seated at end        ${seated}/${total}`);
console.log(`hands (approx)       ${hands.toFixed(0)}  (${(hands / elapsed).toFixed(1)}/s)`);
console.log(`actions              ${actions}  (${(actions / elapsed).toFixed(0)}/s)`);
console.log(
  `messages received    ${received}  (${(received / elapsed).toFixed(0)}/s across all bots)`,
);
console.log(
  `action->broadcast    p50 ${percentile(latencies, 50).toFixed(1)} ms   p95 ${percentile(latencies, 95).toFixed(1)} ms   p99 ${percentile(latencies, 99).toFixed(1)} ms   max ${(latencies.at(-1) ?? NaN).toFixed(1)} ms   (n=${latencies.length})`,
);
if (after && before) {
  const cpu = after.cpuSeconds - before.cpuSeconds;
  console.log(
    `server CPU           ${cpu.toFixed(1)}s over ${elapsed.toFixed(1)}s = ${((cpu / elapsed) * 100).toFixed(0)}% of one core`,
  );
  console.log(
    `server memory        ${after.rssMb.toFixed(0)} MB now, ${peakRss.toFixed(0)} MB peak`,
  );
}
const codes = Object.groupBy(errors, (e) => e.code);
console.log(
  `errors               ${errors.length} ${errors.length ? JSON.stringify(Object.fromEntries(Object.entries(codes).map(([k, v]) => [k, v.length]))) : ''}`,
);

if (args.json) {
  console.log(
    `JSON ${JSON.stringify({ hands, actions, received, seated, total, errors: errors.length, latencies: latencies.filter((_, i) => i % 5 === 0) })}`,
  );
}
for (const bot of bots) bot.close();
child?.kill();
process.exit(0);
