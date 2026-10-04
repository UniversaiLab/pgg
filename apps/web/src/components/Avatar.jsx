import { hash01, initials } from '../lib/format.js';

// Black, white and red only: a neutral or red-tinted gradient chosen from the player's id.
function background(id) {
  const h = hash01(id);
  const angle = Math.round(h * 360);
  if (h < 0.28) return `linear-gradient(${angle}deg, #f02849, #5a0a18)`;
  const light = 26 + Math.round(h * 18);
  return `linear-gradient(${angle}deg, hsl(0 0% ${light}%), hsl(0 0% 8%))`;
}

export function Avatar({ id, name, size = 44, className = '' }) {
  return (
    <div
      className={`flex items-center justify-center rounded-full font-bold text-white ${className}`}
      style={{ width: size, height: size, background: background(id), fontSize: size * 0.38 }}
      aria-hidden="true"
    >
      {initials(name)}
    </div>
  );
}
