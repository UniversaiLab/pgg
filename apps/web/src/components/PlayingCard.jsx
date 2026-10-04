import { m } from 'motion/react';
import { parseCard } from '../lib/format.js';
import { Suit } from './Icons.jsx';

const FLIP = { type: 'spring', stiffness: 230, damping: 24 };

/**
 * One playing card. `faceUp` flips it in 3D. `from` ({x, y} in px, relative to where the card ends
 * up) makes it fly in from somewhere else, as if dealt; otherwise it just drops in.
 */
export function PlayingCard({
  code,
  faceUp = true,
  width = 48,
  delay = 0,
  from = null,
  tilt = 0,
  glow = false,
}) {
  const card = code ? parseCard(code) : null;
  const dealt = from
    ? { x: from.x, y: from.y, opacity: 0, scale: 0.45, rotate: tilt - 40 }
    : { y: -18, opacity: 0, scale: 0.92, rotate: tilt };

  return (
    <m.div
      className="shrink-0"
      style={{ '--w': `${width}px` }}
      initial={dealt}
      animate={{ x: 0, y: 0, opacity: 1, scale: 1, rotate: tilt }}
      transition={{ type: 'spring', stiffness: 260, damping: 26, delay }}
    >
      <div className="card-scene">
        <m.div
          className="card-body"
          initial={{ rotateY: 180 }}
          animate={{ rotateY: faceUp && card ? 0 : 180 }}
          transition={{ ...FLIP, delay: delay + (from ? 0.28 : 0.05) }}
        >
          <div
            className={`card-face ${card?.red ? 'red' : ''} ${glow ? 'ring-2 ring-red' : ''}`}
            role="img"
            aria-label={card ? card.name : 'card'}
          >
            {card && (
              <>
                <div
                  className="absolute left-[11%] top-[6%] flex flex-col items-center leading-none"
                  style={{ fontSize: width * 0.4 }}
                >
                  <span className="font-extrabold tracking-tight">{card.label}</span>
                  <Suit suit={card.suit} className="mt-[2px] h-[0.62em] w-[0.62em]" />
                </div>
                <Suit
                  suit={card.suit}
                  className="absolute bottom-[8%] right-[10%] opacity-95"
                  style={{ width: width * 0.5, height: width * 0.5 }}
                />
              </>
            )}
          </div>
          <div className="card-back" aria-hidden="true">
            <div
              className="absolute inset-[18%] flex items-center justify-center rounded-[28%] border border-red/40 text-[0.5em] font-black tracking-widest text-red/80"
              style={{ fontSize: width * 0.3 }}
            >
              PGG
            </div>
          </div>
        </m.div>
      </div>
    </m.div>
  );
}
