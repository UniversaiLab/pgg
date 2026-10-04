import { AnimatePresence, m } from 'motion/react';
import { exact } from '../lib/format.js';

const COLORS = ['#f02849', '#ffffff', '#ff6b81', '#e4e6eb'];

const PIECES = Array.from({ length: 26 }, (_, i) => i);

function Confetti() {
  // 26 paper pieces thrown outward from the banner; deterministic so renders are stable.
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden="true">
      {PIECES.map((i) => {
        const angle = (i / 26) * Math.PI * 2 + (i % 3) * 0.2;
        const dist = 110 + ((i * 37) % 90);
        return (
          <span
            key={i}
            className="confetti"
            style={{
              background: COLORS[i % COLORS.length],
              '--dx': `${Math.cos(angle) * dist}px`,
              '--dy': `${Math.sin(angle) * dist - 40}px`,
              '--rot': `${(i * 83) % 540}deg`,
              animationDelay: `${(i % 5) * 40}ms`,
            }}
          />
        );
      })}
    </div>
  );
}

/** "You win 240 · Two Pair". Shown between the end of a hand and the start of the next. */
export function ResultBanner({ result, seats, heroSeat, top }) {
  let headline = null;
  let detail = null;
  let heroWon = false;

  if (result) {
    const winners = result.payouts.map((p) => ({ ...p, name: seats[p.seat]?.name ?? 'Player' }));
    const top = [...winners].sort((a, b) => b.net - a.net)[0];
    heroWon = winners.some((w) => w.seat === heroSeat);
    const single = winners.length === 1;
    if (top) {
      headline = single
        ? `${top.seat === heroSeat ? 'You win' : `${top.name} wins`} ${exact(top.net)}`
        : `${winners.length} players split the pot`;
    }
    const ranking = result.pots.flatMap((pot) => pot.winners.map((w) => w.ranking)).find(Boolean);
    detail = ranking ?? (result.reveals.length === 0 ? 'Everyone else folded' : null);
  }

  return (
    <AnimatePresence>
      {result && headline && (
        <m.div
          key={result.handNo}
          className="pointer-events-none absolute left-1/2 z-20 -translate-x-1/2 -translate-y-1/2"
          style={{ top: `${top}%` }}
          initial={{ opacity: 0, scale: 0.6, y: 14 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.9, y: -10 }}
          transition={{ type: 'spring', stiffness: 300, damping: 20, delay: 0.25 }}
        >
          <div
            role="status"
            className={`relative whitespace-nowrap rounded-full px-5 py-2.5 text-center shadow-2xl ${heroWon ? 'bg-red text-white' : 'border border-white/15 bg-black/90 text-white backdrop-blur'}`}
          >
            <div className="text-[17px] font-black leading-tight">{headline}</div>
            {detail && (
              <div
                className={`text-[12.5px] font-semibold leading-tight ${heroWon ? 'text-white/85' : 'text-muted'}`}
              >
                {detail}
              </div>
            )}
            {heroWon && <Confetti />}
          </div>
        </m.div>
      )}
    </AnimatePresence>
  );
}
