import { m } from 'motion/react';
import { useEffect, useState } from 'react';
import { AVATAR_RADIUS } from '../lib/seats.js';
import { Chips } from './AnimatedNumber.jsx';
import { Avatar } from './Avatar.jsx';
import { WifiOff } from './Icons.jsx';
import { PlayingCard } from './PlayingCard.jsx';
import { TimerRing } from './TimerRing.jsx';

const R = AVATAR_RADIUS;
const SIZE = R * 2;

function statusLine(entry) {
  if (entry.status === 'sitout') return 'Away';
  if (entry.status === 'waiting') return 'Waiting';
  if (entry.allIn) return 'All in';
  if (entry.folded) return 'Folded';
  return null;
}

/**
 * One seat. The seat is anchored by the CENTRE of its avatar; the cards hang above it and the
 * nameplate below, each at a fixed pixel offset, so nothing depends on how tall the cards are.
 * `hole` is only ever passed for the hero; everyone else shows card backs until a showdown reveals
 * them through `reveal`.
 */
export function Seat({
  entry,
  pos,
  isHero,
  isButton,
  acting,
  ring,
  hole,
  reveal,
  dealFrom,
  dealOrder,
  winner,
  cardWidth,
  handNo,
  resultVisible,
}) {
  const note = statusLine(entry);
  const out = entry.folded || entry.status !== 'seated';
  const showHero = isHero && hole && (entry.hasCards || resultVisible);
  const showBacks = !isHero && entry.hasCards && !reveal;
  const showReveal = !isHero && reveal;

  const heroW = cardWidth * 1.3;
  const smallW = cardWidth * 0.6;

  return (
    <div
      className="absolute z-10"
      style={{ left: `${pos.x}%`, top: `${pos.y}%`, width: 0, height: 0 }}
    >
      <div
        className="absolute flex items-end justify-center"
        style={{ left: 0, bottom: R - 14, transform: 'translateX(-50%)' }}
      >
        {showHero &&
          hole.cards.map((code, i) => (
            <div
              key={`${handNo}-${code}`}
              className={out ? 'opacity-40' : ''}
              style={{ marginLeft: i ? -heroW * 0.22 : 0 }}
            >
              <HeroCard code={code} i={i} width={heroW} from={dealFrom} order={dealOrder} />
            </div>
          ))}
        {showBacks &&
          [0, 1].map((i) => (
            <div key={`${handNo}-${i}`} style={{ marginLeft: i ? -smallW * 0.3 : 0 }}>
              <PlayingCard
                faceUp={false}
                width={smallW}
                from={dealFrom}
                delay={0.1 + dealOrder * 0.09 + i * 0.07}
                tilt={i ? 7 : -7}
              />
            </div>
          ))}
        {showReveal &&
          reveal.map((code, i) => (
            <div key={`${handNo}-r-${code}`} style={{ marginLeft: i ? -smallW * 0.25 : 0 }}>
              <PlayingCard
                code={code}
                faceUp
                width={smallW * 1.55}
                delay={i * 0.12}
                tilt={i ? 6 : -6}
              />
            </div>
          ))}
      </div>

      <div
        className={`absolute z-10 ${winner ? 'winner-glow rounded-full' : ''} ${out && !winner ? 'opacity-55' : ''}`}
        style={{ left: -R, top: -R, width: SIZE, height: SIZE }}
      >
        <Avatar
          id={entry.playerId}
          name={entry.name}
          size={SIZE}
          className={`border-2 ${acting ? 'border-white' : 'border-black'}`}
        />
        {acting && ring && <TimerRing size={SIZE + 8} ms={ring.ms} cycle={ring.cycle} />}
        {isButton && (
          <m.span
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 400, damping: 18 }}
            className="absolute -right-2 -top-1 flex h-[22px] w-[22px] items-center justify-center rounded-full bg-white text-[12px] font-black text-black shadow-lg"
            title="Dealer"
          >
            D
          </m.span>
        )}
        {!entry.connected && (
          <span
            className="absolute -bottom-1 -left-2 flex h-5 w-5 items-center justify-center rounded-full bg-black text-red-soft ring-1 ring-line"
            title="Disconnected"
          >
            <WifiOff className="h-3.5 w-3.5" />
          </span>
        )}
      </div>

      <div
        className={`absolute z-20 min-w-[78px] max-w-[104px] rounded-2xl border px-3 pb-1 pt-[7px] text-center backdrop-blur ${isHero ? 'border-white/30 bg-black/90' : 'border-line bg-black/85'} ${out && !winner ? 'opacity-70' : ''}`}
        style={{ left: 0, top: R - 12, transform: 'translateX(-50%)' }}
      >
        <div className="truncate whitespace-nowrap text-[12px] font-semibold leading-tight text-muted">
          {entry.name}
        </div>
        {note ? (
          <div
            className={`whitespace-nowrap text-[12.5px] font-extrabold leading-tight ${entry.allIn ? 'text-red-soft' : 'text-faint'}`}
          >
            {note}
          </div>
        ) : (
          <Chips
            value={entry.chips}
            className="text-[14px] font-extrabold leading-tight text-white"
          />
        )}
      </div>
    </div>
  );
}

/** The hero's own cards: dealt face down, then turned over once they land. */
function HeroCard({ code, i, width, from, order }) {
  const [up, setUp] = useState(false);
  const delay = 0.1 + order * 0.09 + i * 0.07;
  useEffect(() => {
    const timer = setTimeout(() => setUp(true), (delay + 0.55) * 1000);
    return () => clearTimeout(timer);
  }, [delay]);
  return (
    <PlayingCard
      code={code}
      faceUp={up}
      width={width}
      from={from}
      delay={delay}
      tilt={i ? 6 : -6}
    />
  );
}
