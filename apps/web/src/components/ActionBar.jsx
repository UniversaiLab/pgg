import { m } from 'motion/react';
import { useState } from 'react';
import { exact } from '../lib/format.js';
import { ChipIcon } from './Icons.jsx';
import { Button, Sheet } from './Sheet.jsx';

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

/** Quick raise targets: the amount to raise TO, as a share of the pot, clamped to what is legal. */
export function raiseTargets(table, hero) {
  const { legal } = table;
  if (!legal || legal.min === undefined) return [];
  const call = legal.toCall;
  const base = (hero?.bet ?? 0) + call;
  const pot = table.pot + call;
  const targets = [
    ['½ Pot', base + Math.round(pot * 0.5)],
    ['¾ Pot', base + Math.round(pot * 0.75)],
    ['Pot', base + pot],
    ['All in', legal.max],
  ].map(([label, amount]) => {
    const value = clamp(amount, legal.min, legal.max);
    return [value === legal.max ? 'All in' : label, value];
  });
  const seen = new Set(); // collapse presets that clamp to the same amount
  return targets.filter(([, value]) => !seen.has(value) && seen.add(value));
}

function Waiting({ children }) {
  return (
    <div
      className="relative flex h-14 items-center justify-center overflow-hidden rounded-full bg-surface px-6 text-center text-[15px] font-semibold text-muted"
      role="status"
    >
      <div className="shimmer absolute inset-0" aria-hidden="true" />
      <span className="relative">{children}</span>
    </div>
  );
}

export function ActionBar({ table, hero, heroTurn, onAct, onBack, pending }) {
  const [raising, setRaising] = useState(false);
  const legal = table.legal;

  if (!hero) return null;
  if (hero.status === 'sitout') {
    return (
      <Button tone="white" onClick={onBack} className="w-full">
        I'm back — deal me in
      </Button>
    );
  }
  if (hero.status === 'waiting') return <Waiting>You'll be dealt in next hand</Waiting>;
  if (!table.inHand) return <Waiting>Next hand is about to start…</Waiting>;
  if (hero.folded) return <Waiting>You folded — waiting for the hand to finish</Waiting>;
  if (hero.allIn) return <Waiting>You're all in — good luck!</Waiting>;
  if (!heroTurn || !legal) {
    const who = table.toAct !== null ? table.seats[table.toAct]?.name : null;
    return <Waiting>{who ? `Waiting for ${who}…` : 'Dealing…'}</Waiting>;
  }

  const canRaise = legal.min !== undefined;
  const raiseWord = legal.actions.includes('bet') ? 'Bet' : 'Raise';
  const targets = raiseTargets(table, hero);
  const callLabel = legal.toCall > 0 ? `Call ${exact(legal.toCall)}` : 'Check';
  const allInCall = legal.toCall > 0 && legal.toCall >= hero.chips;

  return (
    <m.div
      initial={{ y: 40, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 380, damping: 28 }}
    >
      {/* Quick bets are also in the raise sheet, so this row is hidden on short screens. */}
      {canRaise && (
        <div className="mb-2.5 grid grid-flow-col auto-cols-fr gap-2 [@media(max-height:700px)]:hidden">
          {targets.map(([label, amount]) => (
            <button
              key={label}
              type="button"
              disabled={pending}
              onClick={() => onAct(legal.actions.includes('bet') ? 'bet' : 'raise', amount)}
              className="h-10 rounded-full border border-line bg-surface text-[13px] font-bold text-white active:bg-hover disabled:opacity-40"
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <div className={`grid gap-2.5 ${canRaise ? 'grid-cols-[1fr_1.35fr_1fr]' : 'grid-cols-2'}`}>
        <Button tone="dark" disabled={pending} onClick={() => onAct('fold')} className="px-2">
          Fold
        </Button>
        <Button
          tone="white"
          disabled={pending}
          onClick={() => onAct(legal.toCall > 0 ? 'call' : 'check')}
          className="px-2"
        >
          {allInCall ? `All in ${exact(hero.chips)}` : callLabel}
        </Button>
        {canRaise && (
          <Button disabled={pending} onClick={() => setRaising(true)} className="px-2">
            {raiseWord}
          </Button>
        )}
      </div>

      {canRaise && (
        <RaiseSheet
          open={raising}
          onClose={() => setRaising(false)}
          word={raiseWord}
          legal={legal}
          targets={targets}
          onConfirm={(amount) => {
            setRaising(false);
            onAct(legal.actions.includes('bet') ? 'bet' : 'raise', amount);
          }}
        />
      )}
    </m.div>
  );
}

function RaiseSheet({ open, onClose, word, legal, targets, onConfirm }) {
  const [value, setValue] = useState(legal.min);
  const [seenOpen, setSeenOpen] = useState(false);
  if (open && !seenOpen) {
    setSeenOpen(true);
    setValue(legal.min);
  }
  if (!open && seenOpen) setSeenOpen(false);

  const fill = legal.max > legal.min ? ((value - legal.min) / (legal.max - legal.min)) * 100 : 100;
  const allIn = value >= legal.max;

  return (
    <Sheet open={open} onClose={onClose} title={`${word} to`}>
      <div className="flex items-center justify-center gap-3 py-1">
        <ChipIcon className="h-9 w-9" />
        <span className="tabular text-5xl font-black text-white">{exact(value)}</span>
      </div>
      <input
        type="range"
        aria-label={`${word} amount`}
        min={legal.min}
        max={legal.max}
        step={1}
        value={value}
        onChange={(event) => setValue(Number(event.target.value))}
        style={{ '--fill': `${fill}%` }}
      />
      <div className="mt-2 grid grid-flow-col auto-cols-fr gap-2">
        {[['Min', legal.min], ...targets].map(([label, amount]) => (
          <button
            key={label}
            type="button"
            onClick={() => setValue(amount)}
            className={`h-10 rounded-full text-[13px] font-bold ${value === amount ? 'bg-white text-black' : 'bg-raised text-white active:bg-hover'}`}
          >
            {label}
          </button>
        ))}
      </div>
      <Button className="mt-5 w-full" onClick={() => onConfirm(value)}>
        {allIn ? `All in ${exact(value)}` : `${word} to ${exact(value)}`}
      </Button>
    </Sheet>
  );
}
