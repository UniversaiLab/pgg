// Drives a phone-sized Chromium through the whole app against a real server and bots, and saves
// screenshots. A smoke test that the UI works end to end, and a way to look at it.
//
//   bun run build            (once, to create dist/)
//   bun scripts/shots.js [--out /some/dir]
//
// Uses the Chromium that ships with Playwright (PLAYWRIGHT_BROWSERS_PATH) via playwright-core.

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { Bot, sleep } from '../../server/test/bot.js';

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : fallback;
};
const OUT = resolve(arg('out', '/tmp/pgg-shots'));
const PORT = Number(arg('port', 18900));
const [VIEW_W, VIEW_H] = arg('viewport', '390x844').split('x').map(Number);
const DIST = resolve(import.meta.dirname, '../dist');
const SERVER = resolve(import.meta.dirname, '../../server/src/index.js');
mkdirSync(OUT, { recursive: true });

// Playwright treats an element with opacity 0 as visible, so check the whole ancestor chain: this
// is what catches animated content stuck at its invisible starting state.
async function assertOpaque(locator, label) {
  const opacity = await locator.evaluate((el) => {
    let value = 1;
    for (let node = el; node; node = node.parentElement)
      value *= Number(getComputedStyle(node).opacity);
    return value;
  });
  if (opacity < 0.99)
    throw new Error(
      `${label} is on the page but effectively invisible (opacity ${opacity.toFixed(2)})`,
    );
}

const chromePath = () => {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  const glob = new Bun.Glob('chromium-*/chrome-linux/chrome');
  const found = [...glob.scanSync({ cwd: root })].sort().at(-1);
  if (!found) throw new Error(`no Chromium under ${root}`);
  return join(root, found);
};

const server = Bun.spawn(['bun', SERVER], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    PGG_SECRET: 'shots',
    WEB_DIST: DIST,
    TURN_MS: '25000',
    INTER_HAND_MS: '1800',
    START_BALANCE: '10000',
  },
  stdout: 'ignore',
  stderr: 'inherit',
});
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${base}/api/health`)).ok) break;
  } catch {}
  await sleep(50);
}

const problems = [];
const bots = [];
let browser;
try {
  // Two scripted opponents who take their time, like people.
  for (const [i, name] of ['Maya', 'Jonas'].entries()) {
    const bot = new Bot({
      httpUrl: base,
      wsUrl: `ws://127.0.0.1:${PORT}/ws`,
      name,
      seed: 40 + i,
      thinkMs: 900,
      aggression: 14,
      validate: false,
      rejoin: { tableId: 'rookie-1', buyIn: 600 },
    });
    await bot.login();
    await bot.connect();
    bot.join('rookie-1', 600);
    bot.autoplay = true;
    bots.push(bot);
  }

  browser = await chromium.launch({ executablePath: chromePath(), args: ['--no-sandbox'] });
  const phone = await browser.newContext({
    viewport: { width: VIEW_W, height: VIEW_H },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: 'dark',
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const page = await phone.newPage();
  page.on(
    'console',
    (m) =>
      ['error', 'warning'].includes(m.type()) && problems.push(`console.${m.type()}: ${m.text()}`),
  );
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  const shot = async (name) => {
    await page.screenshot({ path: join(OUT, `${name}.png`) });
    console.log('saved', name);
  };

  await page.goto(base);
  await page.locator('#name').waitFor();
  await sleep(1200); // let the entrance animation settle
  await assertOpaque(page.getByRole('heading', { name: 'PGG' }), 'login title');
  await assertOpaque(page.locator('#name'), 'name field');
  await shot('01-login');

  await page.locator('#name').fill('Alex');
  await assertOpaque(
    page.getByRole('button', { name: 'Play now' }),
    'login button once a name is entered',
  );
  await page.getByRole('button', { name: 'Play now' }).click();
  await page.getByRole('heading', { name: 'Tables' }).waitFor();
  await sleep(1200);
  await assertOpaque(page.getByRole('heading', { name: 'Tables' }), 'lobby title');
  await assertOpaque(page.getByRole('button', { name: /Rookie/ }).first(), 'first table card');
  await shot('02-lobby');

  await page
    .getByRole('button', { name: /Rookie/ })
    .first()
    .click();
  await page.getByRole('dialog').waitFor();
  await sleep(600);
  await shot('03-buyin');

  await page.getByRole('button', { name: /^Sit down with/ }).click();
  await page.getByRole('button', { name: 'Table menu' }).waitFor();
  await sleep(1200);
  await shot('04-table');

  // Play until we have seen our turn, a street or two, and a result.
  const shotsTaken = new Set();
  const started = Date.now();
  while (Date.now() - started < 90_000 && shotsTaken.size < 3) {
    const fold = page.getByRole('button', { name: 'Fold', exact: true });
    if (await fold.isVisible().catch(() => false)) {
      if (!shotsTaken.has('turn')) {
        await sleep(700);
        await shot('05-your-turn');
        shotsTaken.add('turn');
        const raise = page.getByRole('button', { name: /^(Raise|Bet)$/ });
        if (await raise.isVisible().catch(() => false)) {
          await raise.click();
          await page.getByRole('dialog').waitFor();
          await sleep(500);
          await shot('06-raise-sheet');
          await page.keyboard.press('Escape');
          await sleep(400);
        }
      }
      const call = page.getByRole('button', { name: /^(Check|Call)/ });
      await call.click().catch(() => {});
      await sleep(300);
    }
    if (
      !shotsTaken.has('result') &&
      (await page
        .getByText(/ wins | win |split the pot/)
        .first()
        .isVisible()
        .catch(() => false))
    ) {
      await sleep(900);
      await shot('07-result');
      shotsTaken.add('result');
    }
    if (
      !shotsTaken.has('board') &&
      (await page
        .locator(
          '[aria-label$=" of hearts"], [aria-label$=" of spades"], [aria-label$=" of clubs"], [aria-label$=" of diamonds"]',
        )
        .count()) >= 5
    ) {
      await sleep(700);
      await shot('08-board');
      shotsTaken.add('board');
    }
    await sleep(250);
  }

  await page.getByRole('button', { name: 'Fair play proofs' }).click();
  await page.getByRole('dialog').waitFor();
  await sleep(700);
  await shot('09-fairness');
  await page.keyboard.press('Escape');
  await sleep(400);

  await page.getByRole('button', { name: 'Table menu' }).click();
  await page.getByRole('dialog').waitFor();
  await sleep(600);
  await shot('10-menu');

  // A desktop browser gets the QR gate instead.
  const desktop = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: 'dark',
  });
  const dpage = await desktop.newPage();
  await dpage.goto(base);
  await dpage.getByRole('heading', { name: /built for your phone/ }).waitFor();
  await dpage.locator('img[alt^="QR code"]').waitFor();
  await sleep(1000);
  await assertOpaque(dpage.getByRole('heading', { name: /built for your phone/ }), 'gate title');
  await assertOpaque(dpage.locator('img[alt^="QR code"]'), 'gate QR code');
  await dpage.screenshot({ path: join(OUT, '11-desktop-gate.png') });
  console.log('saved 11-desktop-gate');

  console.log('\nsteps seen:', [...shotsTaken].join(', '));
} catch (error) {
  problems.push(`script: ${error.stack ?? error}`);
} finally {
  for (const bot of bots) bot.close();
  await browser?.close();
  server.kill();
}

console.log(
  problems.length
    ? `\nPROBLEMS (${problems.length}):\n${problems.join('\n')}`
    : '\nno console errors',
);
process.exit(problems.length ? 1 : 0);
