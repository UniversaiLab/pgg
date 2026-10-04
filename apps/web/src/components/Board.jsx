import { useEffect, useRef } from 'react';
import { PlayingCard } from './PlayingCard.jsx';

const SLOTS = [0, 1, 2, 3, 4];

/** The community cards. New cards flip in one after another; existing ones stay put. */
export function Board({ board, cardWidth }) {
  const before = useRef(0);
  const known = before.current;
  useEffect(() => {
    before.current = board.length;
  }, [board.length]);

  return (
    <div className="flex items-center justify-center gap-[5px]">
      {SLOTS.map((i) => (
        <div key={i} className="relative" style={{ width: cardWidth, height: cardWidth * 1.42 }}>
          <div className="absolute inset-0 rounded-[14%] border border-dashed border-white/10" />
          {board[i] && (
            <div className="absolute inset-0">
              <PlayingCard
                key={board[i]}
                code={board[i]}
                width={cardWidth}
                delay={Math.max(0, i - known) * 0.16}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
