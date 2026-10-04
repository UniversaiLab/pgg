import { m } from 'motion/react';
import { useEffect, useState } from 'react';
import { Background } from './Background.jsx';
import { Logo } from './Icons.jsx';

/** Shown on desktops: the game is phone-only, so hand the visitor a QR code instead. */
export function Gate() {
  const [qr, setQr] = useState(null);
  const url = window.location.origin;
  const local = /^(localhost|127\.|\[::1\])/.test(window.location.hostname);

  useEffect(() => {
    let alive = true;
    import('qrcode').then(({ default: QRCode }) =>
      QRCode.toDataURL(url, {
        margin: 1,
        width: 360,
        color: { dark: '#000000', light: '#ffffff' },
      }).then((data) => alive && setQr(data)),
    );
    return () => {
      alive = false;
    };
  }, [url]);

  return (
    <div className="relative flex min-h-full items-center justify-center overflow-hidden bg-black p-6">
      <Background />
      <m.div
        className="relative z-10 w-full max-w-sm text-center"
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 160, damping: 22 }}
      >
        <Logo size={64} className="mx-auto" />
        <h1 className="mt-6 text-3xl font-black tracking-tight text-white">
          PGG is built for your phone
        </h1>
        <p className="mt-2 text-muted">Open this page on your phone to play.</p>
        <div className="mx-auto mt-7 flex h-56 w-56 items-center justify-center rounded-3xl bg-white p-3">
          {qr ? (
            <img src={qr} alt={`QR code for ${url}`} className="h-full w-full" />
          ) : (
            <div className="shimmer h-full w-full rounded-2xl bg-neutral-200" />
          )}
        </div>
        <p className="mt-4 break-all font-mono text-sm text-faint">{url}</p>
        {local && (
          <p className="mt-3 text-sm text-faint">
            This address only works on this computer. To test on a phone, open the page using this
            computer's network address instead.
          </p>
        )}
      </m.div>
    </div>
  );
}

export function RotateNotice() {
  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-4 bg-black p-8 text-center">
      <m.div
        animate={{ rotate: [90, 0] }}
        transition={{ repeat: Infinity, repeatType: 'reverse', duration: 1.2, ease: 'easeInOut' }}
      >
        <Logo size={56} />
      </m.div>
      <p className="text-lg font-bold text-white">Turn your phone upright</p>
      <p className="text-muted">PGG plays in portrait.</p>
    </div>
  );
}
