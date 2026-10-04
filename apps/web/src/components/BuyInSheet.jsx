import { useEffect, useState } from 'react';
import { exact } from '../lib/format.js';
import { ChipIcon } from './Icons.jsx';
import { Button, Sheet } from './Sheet.jsx';

/**
 * Pick how many chips to bring (or add). `min` and `max` already account for the player's balance
 * and the table limits.
 */
export function BuyInSheet({
  open,
  onClose,
  title,
  subtitle,
  min,
  max,
  bigBlind,
  confirmLabel,
  onConfirm,
}) {
  const [value, setValue] = useState(min);
  useEffect(() => {
    if (open)
      setValue(Math.min(max, Math.max(min, Math.round((min + max) / 2 / bigBlind) * bigBlind)));
  }, [open, min, max, bigBlind]);

  const fill = max > min ? ((value - min) / (max - min)) * 100 : 100;
  const presets = [
    ['Min', min],
    ['50 BB', bigBlind * 50],
    ['100 BB', bigBlind * 100],
    ['Max', max],
  ].filter(([, amount]) => amount >= min && amount <= max);

  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <p className="-mt-2 mb-5 text-muted">{subtitle}</p>
      {max < min ? (
        <p className="rounded-2xl bg-raised p-4 text-muted">
          You do not have enough chips for this table.
        </p>
      ) : (
        <>
          <div className="flex items-center justify-center gap-3 py-2">
            <ChipIcon className="h-9 w-9" />
            <span className="tabular text-5xl font-black text-white">{exact(value)}</span>
          </div>
          <input
            type="range"
            aria-label="Amount"
            min={min}
            max={max}
            step={Math.max(1, Math.round(bigBlind / 2))}
            value={value}
            onChange={(event) => setValue(Number(event.target.value))}
            style={{ '--fill': `${fill}%` }}
          />
          <div className="mt-2 grid grid-cols-4 gap-2">
            {presets.map(([label, amount]) => (
              <button
                key={label}
                type="button"
                onClick={() => setValue(amount)}
                className={`h-10 rounded-full text-sm font-bold ${value === amount ? 'bg-white text-black' : 'bg-raised text-white active:bg-hover'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <Button className="mt-5 w-full" onClick={() => onConfirm(value)}>
            {confirmLabel(value)}
          </Button>
        </>
      )}
    </Sheet>
  );
}
