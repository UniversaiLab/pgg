// Rake maths on integer chips. Pure. Uses BigInt for the multiplications so large pots in
// 6-decimal token units cannot lose precision.

/** Hard ceiling in basis points. The escrow contract (Milestone 2) enforces the same bound. */
export const MAX_RAKE_BPS = 500;

/**
 * Rake for one pot.
 * @param {{ pot: number, sawFlop: boolean, bps: number, cap?: number, noFlopNoDrop?: boolean }} input
 */
export function computeRake({
  pot,
  sawFlop,
  bps,
  cap = Number.MAX_SAFE_INTEGER,
  noFlopNoDrop = true,
}) {
  if (!Number.isSafeInteger(pot) || pot < 0)
    throw new RangeError('pot must be a non-negative integer');
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_RAKE_BPS) {
    throw new RangeError(`bps must be an integer 0-${MAX_RAKE_BPS}`);
  }
  if (!Number.isSafeInteger(cap) || cap < 0)
    throw new RangeError('cap must be a non-negative integer');
  if (noFlopNoDrop && !sawFlop) return 0;
  const raw = Number((BigInt(pot) * BigInt(bps)) / 10000n);
  return Math.min(raw, cap);
}

/**
 * Split `rake` across winners in proportion to what each one received.
 * Largest-remainder rounding (ties to the lowest index), so shares always sum to exactly `rake`
 * and no share exceeds its payout. Deterministic.
 * @param {number[]} payouts non-negative integers; zero for non-winners
 * @param {number} rake
 * @returns {number[]} rake share per index
 */
export function allocateRake(payouts, rake) {
  const total = payouts.reduce((sum, p) => sum + p, 0);
  const shares = payouts.map(() => 0);
  if (rake === 0 || total === 0) return shares;
  if (rake > total) throw new RangeError('rake exceeds total payouts');

  const bigTotal = BigInt(total);
  const remainders = [];
  let assigned = 0;
  payouts.forEach((payout, index) => {
    if (payout === 0) return;
    const scaled = BigInt(rake) * BigInt(payout);
    const share = Number(scaled / bigTotal);
    shares[index] = share;
    assigned += share;
    remainders.push({ index, remainder: scaled % bigTotal });
  });

  remainders.sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );
  for (let left = rake - assigned, i = 0; left > 0; left--, i++) shares[remainders[i].index] += 1;
  return shares;
}
