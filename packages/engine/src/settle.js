// Pot construction and payout, independent of poker-ts.
//
// poker-ts 1.5.0 runs the betting round well but mishandles settlement in some all-in cases:
// it can skip paying a short-stack all-in winner (the dealer nulls all-in players, and the payout
// loop skips nulls), and it puts a folded player's dead money wholly into the main pot. Both are
// wrong for real money, so PokerTable uses poker-ts only for betting and settles with this module.
//
// Standard rules: a player can win from each opponent at most what they put in themselves.

import pokersolver from 'pokersolver';

const { Hand } = pokersolver;

/**
 * Build main and side pots from what each seat put in.
 * @param {number[]} contributions total chips each seat committed this hand (index = seat)
 * @param {Set<number>} folded seats that folded; their chips stay in as dead money
 * @returns {{ size: number, eligible: number[] }[]}
 */
export function buildPots(contributions, folded) {
  const live = contributions.flatMap((chips, seat) =>
    chips > 0 && !folded.has(seat) ? [seat] : [],
  );
  if (live.length === 0) throw new Error('no live player to award the pot to');
  const levels = [...new Set(live.map((seat) => contributions[seat]))].sort((a, b) => a - b);

  const pots = [];
  let previous = 0;
  levels.forEach((level, index) => {
    const isTop = index === levels.length - 1;
    let size = 0;
    for (const chips of contributions) {
      // The top pot also takes any dead chips a folded player committed beyond the top level.
      size += Math.max(0, (isTop ? chips : Math.min(chips, level)) - previous);
    }
    if (size > 0)
      pots.push({ size, eligible: live.filter((seat) => contributions[seat] >= level) });
    previous = level;
  });
  return pots;
}

/**
 * Award every pot.
 * @param {{ contributions: number[], folded: Set<number>, hole: Map<number, string[]>,
 *   board: string[], button: number }} input `hole` needs cards for every non-folded seat that
 *   shares a pot with someone else; `board` must be complete in that case.
 * @returns {{ pots: object[], payouts: number[] }} `payouts[seat]` is the gross amount won
 */
export function settlePots({ contributions, folded, hole, board, button }) {
  const numSeats = contributions.length;
  const payouts = new Array(numSeats).fill(0);
  const pots = buildPots(contributions, folded).map((pot) => {
    let winners;
    if (pot.eligible.length === 1) {
      winners = [{ seat: pot.eligible[0] }];
    } else {
      if (board.length !== 5)
        throw new Error(
          `showdown needs the full board: board=${board.join(' ')} pot=${JSON.stringify(pot)} contributions=${JSON.stringify(contributions)} folded=${[...folded]}`,
        );
      const solved = pot.eligible.map((seat) => {
        const cards = hole.get(seat);
        if (!cards) throw new Error(`missing hole cards for seat ${seat}`);
        return Hand.solve([...cards, ...board]);
      });
      winners = Hand.winners(solved).map((hand) => ({
        seat: pot.eligible[solved.indexOf(hand)],
        ranking: hand.name,
        cards: hand.cards.map((card) => `${card.value}${card.suit}`),
      }));
    }

    // Equal split; leftover chips go one each to winners clockwise from the seat after the button.
    const clockwise = [...winners].sort(
      (a, b) =>
        ((a.seat - button - 1 + numSeats) % numSeats) -
        ((b.seat - button - 1 + numSeats) % numSeats),
    );
    const share = Math.floor(pot.size / winners.length);
    const odd = pot.size - share * winners.length;
    clockwise.forEach((winner, index) => {
      payouts[winner.seat] += share + (index < odd ? 1 : 0);
    });
    return { ...pot, winners };
  });
  return { pots, payouts };
}
