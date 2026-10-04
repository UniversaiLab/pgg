// Where everything sits on the felt. The hero is always at the bottom centre; the others go
// clockwise around an ellipse. Everything is computed from the real felt size, because the things
// that sit on it (avatars, nameplates, cards) have a fixed size in pixels while screens do not.
//
// A seat is anchored by the CENTRE OF ITS AVATAR; its cards and nameplate hang off that point at
// fixed pixel offsets (see Seat.jsx), so the geometry here only has to leave enough room.

export const AVATAR_RADIUS = 27;
export const NAMEPLATE_BELOW = 70; // avatar centre to the bottom of its nameplate
export const CARDS_ABOVE = 86; // avatar centre to the top of an opponent's (revealed) cards
export const SIDE_MARGIN = 48; // half a nameplate plus breathing room

const round = (n) => Math.round(n * 100) / 100;
const pct = (px, total) => (px / total) * 100;

/**
 * @param {{ w: number, h: number }} box felt size in px
 * @param {number} numSeats
 * @param {number} heroSeat
 * @param {{ cardHeight?: number }} [options] height of a board card in px
 * @returns {{ seats: { x: number, y: number, slot: number }[], pot: {x:number,y:number}, board: {x:number,y:number} }}
 */
export function tableGeometry(box, numSeats, heroSeat, { cardHeight = 74 } = {}) {
  const top = pct(CARDS_ABOVE, box.h);
  const bottom = 100 - pct(NAMEPLATE_BELOW, box.h);
  const cy = (top + bottom) / 2;
  const ry = (bottom - top) / 2;
  const rx = 50 - pct(SIDE_MARGIN, box.w);

  const seats = Array.from({ length: numSeats }, (_, seat) => {
    const slot = (seat - heroSeat + numSeats) % numSeats;
    const angle = Math.PI / 2 + (slot * 2 * Math.PI) / numSeats;
    // Stretching the vertical component pushes the side seats away from the board's band.
    const vertical = Math.max(-1, Math.min(1, Math.sin(angle) * 1.25));
    return { slot, x: round(50 + rx * Math.cos(angle)), y: round(cy + ry * vertical) };
  });

  return {
    seats,
    board: { x: 50, y: round(cy) },
    // Just above the board, with room for the pot pill (about 34px tall).
    pot: { x: 50, y: round(cy - pct(cardHeight / 2 + 26, box.h)) },
  };
}

/**
 * Where a seat's bet sits: `distance` px from the seat toward the centre of the felt (never past
 * 80% of the way), so it clears the seat's own nameplate whatever the screen size.
 */
export function towardCenter(position, center, box, distance = 86) {
  const dx = ((center.x - position.x) / 100) * box.w;
  const dy = ((center.y - position.y) / 100) * box.h;
  const length = Math.hypot(dx, dy) || 1;
  const travel = Math.min(distance, length * 0.8);
  return {
    x: round(position.x + pct((dx / length) * travel, box.w)),
    y: round(position.y + pct((dy / length) * travel, box.h)),
  };
}
