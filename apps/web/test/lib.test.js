import { describe, expect, test } from 'bun:test';
import { chips, exact, hash01, initials, parseCard } from '../src/lib/format.js';
import {
  CARDS_ABOVE,
  NAMEPLATE_BELOW,
  SIDE_MARGIN,
  tableGeometry,
  towardCenter,
} from '../src/lib/seats.js';
import { createStore } from '../src/lib/store.js';

describe('format', () => {
  test('chips stay short', () => {
    expect([0, 7, 999, 1234, 9999, 10000, 15200, 99999, 1_000_000, 2_540_000].map(chips)).toEqual([
      '0',
      '7',
      '999',
      '1,234',
      '9,999',
      '10K',
      '15.2K',
      '100K',
      '1M',
      '2.5M',
    ]);
    expect(chips(Number.NaN)).toBe('0');
    expect(exact(15200)).toBe('15,200');
  });

  test('cards parse into rank, suit and colour', () => {
    expect(parseCard('Ah')).toMatchObject({ label: 'A', suit: 'h', red: true });
    expect(parseCard('Td')).toMatchObject({ label: '10', red: true });
    expect(parseCard('7s')).toMatchObject({ label: '7', red: false, name: '7 of spades' });
    expect(parseCard('Kc').red).toBe(false);
  });

  test('initials and hashes are stable', () => {
    expect(initials('ada lovelace')).toBe('AL');
    expect(initials('Bob')).toBe('BO');
    expect(hash01('x')).toBe(hash01('x'));
    expect(hash01('x')).not.toBe(hash01('y'));
    for (const text of ['', 'a', 'player-123']) expect(hash01(text)).toBeGreaterThanOrEqual(0);
  });
});

const PHONES = [
  { name: 'small', w: 360, h: 450 },
  { name: 'regular', w: 390, h: 600 },
  { name: 'large', w: 430, h: 700 },
];

describe('tableGeometry', () => {
  test('the hero is bottom centre; the seat opposite is top centre', () => {
    for (const box of PHONES) {
      const g = tableGeometry(box, 6, 2);
      expect(g.seats[2]).toMatchObject({ slot: 0, x: 50 });
      expect(g.seats[2].y).toBeGreaterThan(g.board.y);
      const opposite = g.seats[(2 + 3) % 6];
      expect(opposite.x).toBeCloseTo(50, 0);
      expect(opposite.y).toBeLessThan(g.board.y);
    }
  });

  test('seats go clockwise, and every avatar leaves room for its own cards and nameplate', () => {
    for (const box of PHONES) {
      for (const n of [2, 3, 6, 9]) {
        for (let hero = 0; hero < n; hero++) {
          const g = tableGeometry(box, n, hero);
          expect(new Set(g.seats.map((p) => p.slot)).size).toBe(n);
          for (const p of g.seats) {
            const px = { x: (p.x / 100) * box.w, y: (p.y / 100) * box.h };
            expect(px.y - CARDS_ABOVE, `${box.name} top`).toBeGreaterThanOrEqual(-0.5); // cards above fit
            expect(px.y + NAMEPLATE_BELOW, `${box.name} bottom`).toBeLessThanOrEqual(box.h + 0.5); // nameplate fits
            expect(px.x - SIDE_MARGIN, `${box.name} left`).toBeGreaterThanOrEqual(-0.5);
            expect(px.x + SIDE_MARGIN, `${box.name} right`).toBeLessThanOrEqual(box.w + 0.5);
          }
        }
      }
    }
    const g = tableGeometry(PHONES[1], 6, 0); // slot 1 bottom-left, 2 top-left, then across the top
    expect(g.seats[1].x).toBeLessThan(50);
    expect(g.seats[2].x).toBeLessThan(50);
    expect(g.seats[4].x).toBeGreaterThan(50);
    expect(g.seats[5].x).toBeGreaterThan(50);
  });

  test('side seats keep clear of the board band', () => {
    for (const box of PHONES) {
      const g = tableGeometry(box, 6, 0, { cardHeight: 70 });
      const bandTop = g.board.y - (70 / 2 / box.h) * 100;
      const bandBottom = g.board.y + (70 / 2 / box.h) * 100;
      for (const seat of [g.seats[1], g.seats[2], g.seats[4], g.seats[5]]) {
        // The seat's avatar centre must not sit inside the board's vertical band.
        expect(seat.y < bandTop || seat.y > bandBottom, `${box.name} seat at y=${seat.y}`).toBe(
          true,
        );
      }
    }
  });

  test('the pot sits above the board without touching the top seat', () => {
    for (const box of PHONES) {
      const g = tableGeometry(box, 6, 0);
      expect(g.pot.y).toBeLessThan(g.board.y);
      const top = g.seats[3]; // opposite the hero
      expect(g.pot.y).toBeGreaterThan(top.y);
    }
  });

  test('bets sit a fixed distance from the seat toward the centre, and never overshoot it', () => {
    const box = { w: 390, h: 560 };
    const g = tableGeometry(box, 6, 0);
    const seat = g.seats[2]; // upper left
    const bet = towardCenter(seat, g.board, box, 86);
    const movedPx = Math.hypot(((bet.x - seat.x) / 100) * box.w, ((bet.y - seat.y) / 100) * box.h);
    expect(movedPx).toBeCloseTo(86, 0);
    const near = { x: 52, y: g.board.y };
    const clipped = towardCenter(near, g.board, box, 500);
    expect(Math.abs(clipped.x - 50)).toBeLessThan(Math.abs(near.x - 50) + 0.01);
  });
});

describe('store', () => {
  test('notifies on change only, and unsubscribes', () => {
    const store = createStore({ n: 0 });
    let calls = 0;
    const off = store.subscribe(() => calls++);
    store.set({ n: 1 });
    const same = store.get();
    store.set(same); // unchanged reference: no notification
    store.set((s) => ({ n: s.n + 1 }));
    expect(calls).toBe(2);
    expect(store.get().n).toBe(2);
    off();
    store.set({ n: 9 });
    expect(calls).toBe(2);
  });
});
