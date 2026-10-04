// Chips <-> token base units. The game counts chips (JS numbers, always whole); the vault counts token base
// units (BigInt: 6 decimals for USDC, 18 for most others, far beyond 2^53). One chip is `unit` base units.
// A deposit does not have to be a multiple of the unit: the remainder ("dust") stays on the player's
// balance, never moves in a hand, and so conserves exactly.

function checkUnit(unit) {
  if (typeof unit !== 'bigint' || unit <= 0n) throw new RangeError('unit must be a bigint above 0');
}

/** Whole chips -> token base units. */
export function toTokenUnits(chips, unit) {
  checkUnit(unit);
  if (!Number.isSafeInteger(chips) || chips < 0) {
    throw new RangeError('chips must be a non-negative safe integer');
  }
  return BigInt(chips) * unit;
}

/**
 * Token base units -> { chips, dust }, with dust = tokenUnits mod unit. Throws RangeError when the chip
 * count is not a safe integer: better to refuse than to round a balance.
 */
export function toChips(tokenUnits, unit) {
  checkUnit(unit);
  if (typeof tokenUnits !== 'bigint' || tokenUnits < 0n) {
    throw new RangeError('tokenUnits must be a non-negative bigint');
  }
  const whole = tokenUnits / unit;
  if (whole > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('chip count is not a safe integer');
  }
  return { chips: Number(whole), dust: tokenUnits % unit };
}
