import { describe, expect, test } from 'bun:test';
import {
  CANONICAL_DECK,
  commitSeed,
  DECK_SIZE,
  deriveDeck,
  newServerSeed,
  normalizeClientSeeds,
  verifyHand,
} from '../src/fairness.js';

const ZERO_SEED = '00'.repeat(32);
const base = { serverSeed: ZERO_SEED, tableId: 't1', handNo: 1 };

describe('commitSeed', () => {
  test('matches the well-known SHA-256 of 32 zero bytes (independent vector)', () => {
    expect(commitSeed(ZERO_SEED)).toBe(
      '66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925',
    );
  });

  test('rejects malformed seeds', () => {
    expect(() => commitSeed('zz')).toThrow();
    expect(() => commitSeed('00'.repeat(31))).toThrow();
    expect(() => commitSeed('AB'.repeat(32))).toThrow(); // uppercase is not canonical
  });
});

describe('deriveDeck', () => {
  // These pin the CURRENT output so accidental algorithm changes fail loudly. They are
  // regression vectors, not an independent reference.
  test('known-answer vector, no client seeds', () => {
    expect(deriveDeck(base).join(' ')).toBe(
      '5s Ac 4c 9d Jd 6d 3h 5d Qh Kd Jh 2h 3d 9c Qd 6h Td 2s 4h 8c 6s As Ks 9s 4d 3c 2d Ah Kc Tc 7s 7d Jc 5h 2c Ad 8d Kh 8h 7h 8s 6c Ts Qc 5c 4s 7c 3s Js Qs 9h Th',
    );
  });

  test('known-answer vector, with client seeds (given out of order)', () => {
    const clientSeeds = [
      { seat: 2, seed: 'aabb' },
      { seat: 0, seed: '01' },
    ];
    expect(deriveDeck({ ...base, clientSeeds }).join(' ')).toBe(
      'Jd Kh 4h Ah Tc 6h 8c 3d As 2c Qs Jc Kd 6c 3c 9s 5h Ks 9h 3h 2d Qd 7d Qh 4c Qc 2h 7s Kc 7h 4s Ts Ad Js 7c Jh 6s Th 2s 3s 9d 9c Td 5c 5s 6d 8h 8s 5d Ac 4d 8d',
    );
  });

  test('is a permutation of the 52 canonical cards', () => {
    const deck = deriveDeck({ ...base, serverSeed: newServerSeed() });
    expect(deck).toHaveLength(DECK_SIZE);
    expect([...deck].sort()).toEqual([...CANONICAL_DECK].sort());
  });

  test('is deterministic and order-independent for client seeds', () => {
    const a = [
      { seat: 1, seed: 'ab' },
      { seat: 4, seed: 'cd' },
    ];
    expect(deriveDeck({ ...base, clientSeeds: a })).toEqual(
      deriveDeck({ ...base, clientSeeds: [...a].reverse() }),
    );
  });

  test('every input changes the deck', () => {
    const ref = deriveDeck(base).join();
    const seed2 = `${'00'.repeat(31)}01`;
    expect(deriveDeck({ ...base, serverSeed: seed2 }).join()).not.toBe(ref);
    expect(deriveDeck({ ...base, tableId: 't2' }).join()).not.toBe(ref);
    expect(deriveDeck({ ...base, handNo: 2 }).join()).not.toBe(ref);
    expect(deriveDeck({ ...base, clientSeeds: [{ seat: 0, seed: '01' }] }).join()).not.toBe(ref);
  });

  test('field boundaries cannot be confused (length-prefixed encoding)', () => {
    const one = deriveDeck({ ...base, clientSeeds: [{ seat: 1, seed: 'aabb' }] });
    const two = deriveDeck({
      ...base,
      clientSeeds: [
        { seat: 1, seed: 'aa' },
        { seat: 2, seed: 'bb' },
      ],
    });
    expect(one.join()).not.toBe(two.join());
  });

  test('is unbiased: every card lands in every position about equally often', () => {
    // Deterministic (seeds are derived from the loop counter), so this cannot flake.
    const trials = 5200;
    const counts = Array.from({ length: DECK_SIZE }, () => new Array(DECK_SIZE).fill(0));
    for (let n = 0; n < trials; n++) {
      const serverSeed = n.toString(16).padStart(64, '0');
      deriveDeck({ ...base, serverSeed, handNo: n }).forEach((card, pos) => {
        counts[CANONICAL_DECK.indexOf(card)][pos]++;
      });
    }
    const expected = trials / DECK_SIZE; // 100
    let worst = 0;
    for (const row of counts) for (const c of row) worst = Math.max(worst, Math.abs(c - expected));
    // Binomial sd is about 9.9; 5 sd = 50. A biased shuffle would blow far past this.
    expect(worst).toBeLessThan(50);
  });
});

describe('normalizeClientSeeds', () => {
  test('sorts by seat and rejects bad input', () => {
    expect(
      normalizeClientSeeds([
        { seat: 3, seed: 'aa' },
        { seat: 1, seed: 'bb' },
      ]).map((s) => s.seat),
    ).toEqual([1, 3]);
    expect(() =>
      normalizeClientSeeds([
        { seat: 1, seed: 'aa' },
        { seat: 1, seed: 'bb' },
      ]),
    ).toThrow(/duplicate/);
    expect(() => normalizeClientSeeds([{ seat: -1, seed: 'aa' }])).toThrow();
    expect(() => normalizeClientSeeds([{ seat: 0, seed: '' }])).toThrow();
    expect(() => normalizeClientSeeds([{ seat: 0, seed: '00'.repeat(33) }])).toThrow();
  });
});

describe('verifyHand', () => {
  const serverSeed = newServerSeed();
  const clientSeeds = [{ seat: 0, seed: 'c0ffee' }];
  const full = { serverSeed, clientSeeds, tableId: 't1', handNo: 7 };
  const deck = deriveDeck(full);
  const commitment = commitSeed(serverSeed);

  test('accepts an honest hand, including a partial (prefix) deal', () => {
    expect(verifyHand({ ...full, commitment, dealt: deck }).ok).toBe(true);
    expect(verifyHand({ ...full, commitment, dealt: deck.slice(0, 9) }).ok).toBe(true);
    expect(verifyHand({ ...full, commitment, dealt: [] }).ok).toBe(true);
  });

  test('rejects a swapped card and says which one', () => {
    const dealt = deck.slice(0, 9);
    [dealt[2], dealt[3]] = [dealt[3], dealt[2]];
    const result = verifyHand({ ...full, commitment, dealt });
    expect(result).toMatchObject({ ok: false, reason: 'card-mismatch', index: 2 });
  });

  test('rejects a seed that does not match the commitment', () => {
    const result = verifyHand({ ...full, serverSeed: newServerSeed(), commitment, dealt: [] });
    expect(result).toEqual({ ok: false, reason: 'commitment-mismatch' });
  });

  test('rejects different client seeds or hand number than were used', () => {
    expect(verifyHand({ ...full, commitment, clientSeeds: [], dealt: deck.slice(0, 5) }).ok).toBe(
      false,
    );
    expect(verifyHand({ ...full, commitment, handNo: 8, dealt: deck.slice(0, 5) }).ok).toBe(false);
  });

  test('never throws on garbage', () => {
    for (const bad of [undefined, null, 'x', 5, {}]) {
      expect(verifyHand({ ...full, commitment, dealt: bad }).ok).toBe(false);
    }
    expect(verifyHand({ commitment: 'nope', serverSeed: 'nope' }).ok).toBe(false);
    expect(verifyHand({ ...full, commitment, dealt: ['Zz'] }).ok).toBe(false);
  });
});
