import { useEffect, useRef, useState } from 'react';
import { exact, chips as short } from '../lib/format.js';

/** Counts from the previous value to the new one, so pots and stacks visibly tick up. */
export function useCountUp(target, ms = 520) {
  const [shown, setShown] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    if (from.current === target) return undefined;
    const start = performance.now();
    const origin = from.current;
    let frame = requestAnimationFrame(function tick(now) {
      const t = Math.min(1, (now - start) / ms);
      const eased = 1 - (1 - t) ** 3;
      setShown(Math.round(origin + (target - origin) * eased));
      if (t < 1) frame = requestAnimationFrame(tick);
      else from.current = target;
    });
    return () => {
      cancelAnimationFrame(frame);
      from.current = target;
    };
  }, [target, ms]);
  return shown;
}

export function Chips({ value, full = false, className = '' }) {
  const shown = useCountUp(value);
  return <span className={`tabular ${className}`}>{full ? exact(shown) : short(shown)}</span>;
}
