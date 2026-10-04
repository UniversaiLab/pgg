import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { verifyHand } from '@pgg/engine/fairness';
import { CLIENT, CLOSE, ERR, SERVER } from '@pgg/protocol/constants';
import { loadConfig } from '../src/config.js';
import { createGame } from '../src/server.js';
import { Bot, sleep, until } from './bot.js';

let game;

beforeAll(() => {
  game = createGame(
    {
      ...loadConfig({
        PORT: '0',
        HOST: '127.0.0.1',
        PGG_SECRET: 'e2e-secret',
        TURN_MS: '3000',
        INTER_HAND_MS: '20',
        SITOUT_GRACE_MS: '400',
      }),
    },
    {},
  );
});

afterAll(() => game.stop());

const newBot = (name, options = {}) =>
  new Bot({ httpUrl: game.url, wsUrl: game.wsUrl, name, ...options });

async function connected(name, options) {
  const bot = new Bot({ httpUrl: game.url, wsUrl: game.wsUrl, name, ...options });
  await bot.login();
  await bot.connect();
  await until(() => bot.log.some((m) => m.t === SERVER.WELCOME), { what: 'welcome' });
  return bot;
}

describe('HTTP', () => {
  test('health, tables and dev-login', async () => {
    expect((await (await fetch(`${game.url}/api/health`)).json()).ok).toBe(true);
    const { tables } = await (await fetch(`${game.url}/api/tables`)).json();
    expect(tables.map((t) => t.id)).toEqual(['rookie-1', 'rookie-2', 'regular-1', 'high-1']);

    const bot = newBot('Ann');
    const first = await bot.login();
    expect(first.player).toMatchObject({ name: 'Ann', balance: 10_000 });
    const resumed = await newBot('ignored').login(first.token);
    expect(resumed.player.id).toBe(first.player.id);
    expect(resumed.player.name).toBe('Ann');
  });

  test('rejects bad names and bad tokens', async () => {
    for (const body of [
      {},
      { name: '' },
      { name: 'x'.repeat(21) },
      { name: '<script>' },
      { name: 5 },
    ]) {
      const response = await fetch(`${game.url}/api/dev-login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect((await fetch(`${game.url}/ws?token=garbage`)).status).toBe(401);
    expect((await fetch(`${game.url}/ws`)).status).toBe(401);
  });
});

describe('WebSocket protocol', () => {
  test('welcome carries the player, the lobby, and nothing about other players', async () => {
    const bot = await connected('Wendy');
    const welcome = bot.log.find((m) => m.t === SERVER.WELCOME);
    expect(welcome.player).toMatchObject({ name: 'Wendy', balance: 10_000 });
    expect(welcome.tables).toHaveLength(4);
    expect(welcome.seated).toBeNull();
    expect(bot.invalid).toEqual([]);
    bot.close();
  });

  test('malformed and unknown messages get errors, not crashes', async () => {
    const bot = await connected('Mal');
    bot.ws.send('not json');
    bot.ws.send(JSON.stringify({ t: 'nope' }));
    bot.send({ t: CLIENT.JOIN, tableId: 'nonexistent', buyIn: 200 });
    bot.send({ t: CLIENT.ACT, handNo: 1, action: 'fold' });
    await until(() => bot.errors.length >= 4, { what: 'four errors' });
    expect(bot.errors.map((e) => e.code)).toEqual([
      ERR.BAD_MESSAGE,
      ERR.BAD_MESSAGE,
      ERR.UNKNOWN_TABLE,
      ERR.NOT_SEATED,
    ]);
    expect(bot.connected).toBe(true);
    bot.close();
  });

  test('a flood is rate limited and the connection is dropped', async () => {
    const bot = await connected('Flood');
    for (let i = 0; i < 400; i++) bot.ws.send(JSON.stringify({ t: 'ping', n: i }));
    await until(() => bot.closeCode !== null, { what: 'disconnect' });
    expect(bot.closeCode).toBe(CLOSE.RATE_LIMITED);
    expect(bot.errors.some((e) => e.code === ERR.RATE_LIMITED)).toBe(true);
  });

  test('an oversized message closes the connection', async () => {
    const bot = await connected('Big');
    bot.ws.send('x'.repeat(5000));
    await until(() => bot.closeCode !== null, { what: 'disconnect' });
    expect([CLOSE.TOO_LARGE, 1006, 1009]).toContain(bot.closeCode);
  });

  test('a second connection replaces the first', async () => {
    const first = await connected('Twin');
    const second = new Bot({ httpUrl: game.url, wsUrl: game.wsUrl, name: 'Twin' });
    await second.login(first.token);
    await second.connect();
    await until(() => first.closeCode !== null, { what: 'first socket closed' });
    expect(first.closeCode).toBe(CLOSE.REPLACED);
    expect(second.connected).toBe(true);
    second.close();
  });

  test('ping gets a pong', async () => {
    const bot = await connected('Pinger');
    bot.send({ t: CLIENT.PING, n: 42 });
    await until(() => bot.log.some((m) => m.t === SERVER.PONG), { what: 'pong' });
    expect(bot.log.find((m) => m.t === SERVER.PONG)).toMatchObject({ n: 42 });
    bot.close();
  });
});

describe('playing', () => {
  const settle = async (bots) => {
    for (const bot of bots) bot.autoplay = false;
    // Let any hand in flight finish, then everyone leaves cleanly.
    await until(() => bots.every((bot) => !bot.state?.inHand), {
      timeout: 20_000,
      what: 'idle table',
    });
    await Promise.all(bots.map((bot) => bot.leave()));
  };
  const conserved = () => game.wallet.held + game.registry.chipsOnTables() === game.wallet.issued;

  test('three bots play 12 hands: private cards, valid proofs, no chip lost', async () => {
    const play = { thinkMs: 25, aggression: 12, rejoin: { tableId: 'rookie-1', buyIn: 1000 } };
    const bots = await Promise.all(
      ['Ada', 'Bob', 'Cy'].map((name, i) => connected(name, { seed: 100 + i, ...play })),
    );
    for (const bot of bots) {
      bot.join('rookie-1', 1000);
      bot.autoplay = true;
    }
    const handsSeen = () => Math.max(...bots.map((bot) => bot.state?.handNo ?? 0));
    await until(() => handsSeen() >= 12, { timeout: 60_000, what: '12 hands' });
    await settle(bots);

    for (const bot of bots) {
      expect(bot.invalid, `${bot.name} saw an invalid server message`).toEqual([]);
      expect(
        bot.errors.filter((e) => e.code !== ERR.STALE_HAND),
        bot.name,
      ).toEqual([]);
    }

    // Privacy: a public table message must never contain a hole card dealt in that hand,
    // except in the message that carries a showdown's reveals.
    const allHole = new Map(); // handNo -> every hole card dealt
    for (const bot of bots) {
      for (const [handNo, cards] of bot.hole) {
        allHole.set(handNo, [...new Set([...(allHole.get(handNo) ?? []), ...cards])]);
      }
    }
    expect(allHole.size).toBeGreaterThanOrEqual(12);
    let checked = 0;
    for (const bot of bots) {
      for (const msg of bot.log.filter((m) => m.t === SERVER.TABLE)) {
        if (msg.events.some((e) => e.type === 'hand-end')) continue;
        const json = JSON.stringify(msg);
        for (const card of allHole.get(msg.state.handNo) ?? []) {
          expect(json, `hand ${msg.state.handNo} seq ${msg.seq}`).not.toContain(`"${card}"`);
        }
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(100);

    // Each bot's proofs verify and contain the cards it was dealt.
    let proofs = 0;
    for (const bot of bots) {
      for (const proof of bot.proofs) {
        expect(verifyHand(proof).ok, `${bot.name} hand ${proof.handNo}`).toBe(true);
        expect(proof.dealt.join(' ')).toContain(bot.hole.get(proof.handNo).join(' '));
        proofs += 1;
      }
    }
    expect(proofs).toBeGreaterThanOrEqual(12);

    // Money: everyone left, so every chip is back in a wallet or in the house.
    expect(game.registry.get('rookie-1').chipsOnTable()).toBe(0);
    expect(conserved()).toBe(true);
    expect(game.wallet.held).toBe(game.wallet.issued);
    expect(game.wallet.house).toBeGreaterThan(0); // rake was collected
  }, 90_000);

  test('reconnecting mid-hand resumes the seat, the state and the cards', async () => {
    const play = { thinkMs: 25, aggression: 10 };
    const [a, b] = await Promise.all([
      connected('Rex', { seed: 7, ...play }),
      connected('Sue', { seed: 8, ...play }),
    ]);
    a.join('rookie-2', 800);
    b.join('rookie-2', 800);
    await until(() => a.state?.inHand && a.hole.size > 0, { what: 'hand to start' });
    const handNo = a.state.handNo;
    const cards = a.hole.get(handNo);

    a.ws.close();
    await until(() => a.closeCode !== null, { what: 'close' });
    await until(() => b.state?.seats.some((s) => s && s.playerId === a.id && !s.connected), {
      what: 'peer sees the disconnect',
    });

    const back = new Bot({ httpUrl: game.url, wsUrl: game.wsUrl, name: 'Rex', ...play, seed: 7 });
    await back.login(a.token);
    await back.connect();
    await until(() => back.hole.has(handNo) && back.state, { what: 'resume' });
    expect(back.log.find((m) => m.t === SERVER.WELCOME).seated).toMatchObject({
      tableId: 'rookie-2',
    });
    expect(back.hole.get(handNo)).toEqual(cards);
    expect(back.state.handNo).toBe(handNo);
    expect(back.state.seats.find((s) => s?.playerId === back.id).connected).toBe(true);

    back.autoplay = true;
    b.autoplay = true;
    await until(() => back.handsEnded >= 1, { timeout: 30_000, what: 'a hand to finish' });
    await settle([back, b]);
    expect(conserved()).toBe(true);
    expect(game.registry.get('rookie-2').chipsOnTable()).toBe(0);
  }, 60_000);

  test('a client cannot act for another player or at a table it is not seated at', async () => {
    const play = { thinkMs: 25, aggression: 10 };
    const [x, y] = await Promise.all([
      connected('Xi', { seed: 3, ...play }),
      connected('Yo', { seed: 4, ...play }),
    ]);
    x.join('regular-1', 2000);
    y.join('regular-1', 2000);
    await until(() => x.state?.inHand && y.state?.inHand, { what: 'hand' });
    const state = x.state;
    const notMe = state.seats[state.toAct].playerId === x.id ? y : x;
    notMe.send({ t: CLIENT.ACT, handNo: state.handNo, action: 'fold' });
    await until(() => notMe.errors.length > 0, { what: 'error' });
    expect(notMe.errors[0].code).toBe(ERR.NOT_YOUR_TURN);

    const outsider = await connected('Zed');
    outsider.send({ t: CLIENT.ACT, handNo: state.handNo, action: 'fold' });
    outsider.send({ t: CLIENT.SEED, handNo: state.handNo, seed: 'abcd' });
    await until(() => outsider.errors.length >= 2, { what: 'outsider errors' });
    expect(outsider.errors.map((e) => e.code)).toEqual([ERR.NOT_SEATED, ERR.NOT_SEATED]);
    outsider.close();

    x.autoplay = y.autoplay = true;
    await until(() => x.handsEnded >= 1, { timeout: 30_000, what: 'a hand' });
    await settle([x, y]);
    expect(conserved()).toBe(true);
  }, 60_000);

  test('a player who drops and never returns is refunded after the grace period', async () => {
    const [p, q] = await Promise.all([
      connected('Pat', { seed: 11 }),
      connected('Quin', { seed: 12 }),
    ]);
    p.join('high-1', 5000);
    q.join('high-1', 5000);
    await until(() => q.state?.seats.filter(Boolean).length === 2, { what: 'both seated' });
    p.close();
    await sleep(900); // grace is 400 ms in this config
    await until(() => q.state?.seats.filter(Boolean).length === 1, {
      timeout: 15_000,
      what: 'Pat to be removed',
    });
    // Pat's chips came back to the wallet (less blinds if a hand was in flight).
    expect(game.wallet.balance(p.id)).toBeGreaterThan(9000);
    await q.leave();
    expect(conserved()).toBe(true);
    expect(game.registry.get('high-1').chipsOnTable()).toBe(0);
  }, 40_000);
});

describe('serving the web app', () => {
  test('static files, immutable assets and an SPA fallback, without shadowing the API', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'pgg-web-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(
      join(dir, 'index.html'),
      '<!doctype html><title>PGG</title><div id="root"></div>',
    );
    writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');

    const web = createGame({
      ...loadConfig({ PORT: '0', HOST: '127.0.0.1', PGG_SECRET: 'x', WEB_DIST: dir }),
    });
    try {
      const home = await fetch(`${web.url}/`);
      expect(home.status).toBe(200);
      expect(await home.text()).toContain('<div id="root">');
      expect(home.headers.get('cache-control')).toContain('no-cache');

      const asset = await fetch(`${web.url}/assets/app-abc123.js`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get('cache-control')).toContain('immutable');

      const deep = await fetch(`${web.url}/some/client/route`);
      expect(deep.status).toBe(200);
      expect(await deep.text()).toContain('<div id="root">');

      expect((await (await fetch(`${web.url}/api/health`)).json()).ok).toBe(true);
      expect((await fetch(`${web.url}/ws`)).status).toBe(401); // still the WebSocket endpoint
    } finally {
      web.stop();
    }
  });
});
