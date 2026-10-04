/** 1234 -> "1,234"; 15200 -> "15.2K"; 2_500_000 -> "2.5M". Keeps stack labels short on a phone. */
export function chips(value) {
  if (!Number.isFinite(value)) return '0';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (abs >= 10_000) return `${trim(value / 1000)}K`;
  return Math.round(value).toLocaleString('en-US');
}

const trim = (n) => `${Math.round(n * 10) / 10}`.replace(/\.0$/, '');

/** Full precision, for places that need the exact number (buy-in sheet). */
export const exact = (value) => Math.round(value).toLocaleString('en-US');

const RANK_NAMES = { T: '10', J: 'J', Q: 'Q', K: 'K', A: 'A' };
const SUIT_NAMES = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };

/** "Ah" -> { rank: "A", suit: "h", red: true, label: "A" } */
export function parseCard(code) {
  const rank = code[0];
  const suit = code[1];
  return {
    code,
    rank,
    suit,
    red: suit === 'h' || suit === 'd',
    label: RANK_NAMES[rank] ?? rank,
    name: `${RANK_NAMES[rank] ?? rank} of ${SUIT_NAMES[suit]}`,
  };
}

export function initials(name) {
  const parts = name.trim().split(/\s+/);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2)).toUpperCase();
}

/** Stable pseudo-random number in [0, 1) from a string, for avatar variety. */
export function hash01(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}
