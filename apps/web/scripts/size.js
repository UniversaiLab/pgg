// Fails if what a phone must download up front (HTML + CSS + the entry JavaScript, gzipped) grows
// past the budget. Lazy chunks (QR code, fairness verifier) do not count: they load on demand.
//
//   bun run build && bun scripts/size.js

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const BUDGET_KB = Number(process.env.SIZE_BUDGET_KB ?? 160);
const dist = new URL('../dist/', import.meta.url).pathname;
const html = readFileSync(join(dist, 'index.html'), 'utf8');

// Everything index.html loads eagerly: its script and stylesheet tags (modulepreload counts too).
const eager = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+)"/g)].map((m) => m[1]);
if (eager.length === 0)
  throw new Error('no assets referenced by dist/index.html; did the build run?');

const gz = (file) => gzipSync(readFileSync(join(dist, file))).length;
let total = gz('index.html');
console.log(`index.html                       ${(total / 1024).toFixed(1)} KB gzip`);
for (const file of eager) {
  const size = gz(file);
  total += size;
  console.log(`${file.padEnd(32)} ${(size / 1024).toFixed(1)} KB gzip`);
}
const lazy = readdirSync(join(dist, 'assets')).filter((f) => !eager.includes(`assets/${f}`));
for (const file of lazy)
  console.log(
    `${`assets/${file}`.padEnd(32)} ${(gz(`assets/${file}`) / 1024).toFixed(1)} KB gzip  (loaded on demand)`,
  );

const kb = total / 1024;
console.log(`\ninitial download: ${kb.toFixed(1)} KB gzip  (budget ${BUDGET_KB} KB)`);
if (kb > BUDGET_KB) {
  console.error(`over budget by ${(kb - BUDGET_KB).toFixed(1)} KB`);
  process.exit(1);
}
