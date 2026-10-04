// A deliberately simple, brute-force Hold'em evaluator used ONLY to check the runtime evaluator
// (pokersolver) in tests. It tries all 21 five-card subsets of seven cards and ranks each with a
// plain 5-card ranker. Slow and obvious on purpose: easy to audit by eye.

const VALUE = { 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };

/** Rank exactly five cards. Returns a key; compare keys lexicographically, higher is better. */
export function rank5(cards) {
  const values = cards.map((card) => VALUE[card[0]]).sort((a, b) => b - a);
  const flush = new Set(cards.map((card) => card[1])).size === 1;

  let straightHigh = 0;
  if (new Set(values).size === 5) {
    if (values[0] - values[4] === 4) straightHigh = values[0];
    else if (values.join() === '14,5,4,3,2') straightHigh = 5; // the wheel: ace plays low
  }

  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  // Groups ordered by multiplicity, then by value: quads/trips/pairs first, kickers after.
  const groups = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const shape = groups.map(([, n]) => n).join('');
  const order = groups.map(([value]) => value);

  if (straightHigh && flush) return [8, straightHigh];
  if (shape === '41') return [7, ...order];
  if (shape === '32') return [6, ...order];
  if (flush) return [5, ...values];
  if (straightHigh) return [4, straightHigh];
  if (shape === '311') return [3, ...order];
  if (shape === '221') return [2, ...order];
  if (shape === '2111') return [1, ...order];
  return [0, ...values];
}

export function compareKeys(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Best five-card key from any number of cards (5 to 7). */
export function bestKey(cards) {
  let best = null;
  const pick = (start, chosen) => {
    if (chosen.length === 5) {
      const key = rank5(chosen);
      if (best === null || compareKeys(key, best) > 0) best = key;
      return;
    }
    for (let i = start; i < cards.length; i++) pick(i + 1, [...chosen, cards[i]]);
  };
  pick(0, []);
  return best;
}

/**
 * Winning seats (ascending) among `entries` = [[seat, holeCards], ...] on a full `board`.
 */
export function referenceWinners(entries, board) {
  const scored = entries.map(([seat, hole]) => ({ seat, key: bestKey([...hole, ...board]) }));
  const top = scored.reduce(
    (best, entry) => (compareKeys(entry.key, best) > 0 ? entry.key : best),
    scored[0].key,
  );
  return scored
    .filter((entry) => compareKeys(entry.key, top) === 0)
    .map((entry) => entry.seat)
    .sort((a, b) => a - b);
}
