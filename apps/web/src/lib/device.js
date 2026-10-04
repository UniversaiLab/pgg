import { useEffect, useState } from 'react';

const OVERRIDE_KEY = 'pgg.desktop';

/** Phones and small tablets in touch mode count as mobile. `?desktop=1` is a developer override. */
export function detectDevice() {
  const query = new URLSearchParams(globalThis.location?.search ?? '');
  let override = query.has('desktop');
  try {
    override ||= globalThis.localStorage?.getItem(OVERRIDE_KEY) === '1';
  } catch {
    // storage unavailable; the query parameter still works
  }
  const coarse = globalThis.matchMedia?.('(pointer: coarse)').matches ?? false;
  const narrow = Math.min(globalThis.innerWidth, globalThis.innerHeight) <= 900;
  const landscape =
    (globalThis.matchMedia?.('(orientation: landscape)').matches ?? false) &&
    globalThis.innerHeight < 520;
  return { mobile: override || (coarse && narrow), landscape: !override && landscape && coarse };
}

export function useDevice() {
  const [device, setDevice] = useState(detectDevice);
  useEffect(() => {
    const update = () => setDevice(detectDevice());
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);
  return device;
}
