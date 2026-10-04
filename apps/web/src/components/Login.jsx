import { m } from 'motion/react';
import { useState } from 'react';
import { useClient } from '../client-context.js';
import { Background } from './Background.jsx';
import { Logo } from './Icons.jsx';
import { Button } from './Sheet.jsx';

export function Login() {
  const client = useClient();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await client.login(name.trim());
    } catch (cause) {
      setError(cause.message);
      setBusy(false);
    }
  }

  return (
    <div className="safe-top safe-bottom relative flex min-h-full flex-col items-center justify-center overflow-hidden px-6">
      <Background />
      <m.div
        className="relative z-10 flex w-full max-w-sm flex-col items-center"
        initial="hidden"
        animate="show"
        variants={{ show: { transition: { staggerChildren: 0.09, delayChildren: 0.05 } } }}
      >
        <m.div
          variants={{
            hidden: { scale: 0.4, opacity: 0, rotate: -90 },
            show: { scale: 1, opacity: 1, rotate: 0 },
          }}
          transition={{ type: 'spring', stiffness: 150, damping: 14 }}
        >
          <Logo size={92} className="drop-shadow-[0_0_34px_rgba(240,40,73,0.7)]" />
        </m.div>
        <m.h1
          variants={{ hidden: { opacity: 0, y: 16 }, show: { opacity: 1, y: 0 } }}
          className="mt-6 text-5xl font-black tracking-tight text-white"
        >
          PGG
        </m.h1>
        <m.p
          variants={{ hidden: { opacity: 0, y: 16 }, show: { opacity: 1, y: 0 } }}
          className="mt-2 text-center text-lg text-muted"
        >
          Poker you can check. Made for your phone.
        </m.p>

        <m.form
          variants={{ hidden: { opacity: 0, y: 24 }, show: { opacity: 1, y: 0 } }}
          onSubmit={submit}
          className="mt-10 w-full"
        >
          <label htmlFor="name" className="mb-2 block px-1 text-sm font-semibold text-muted">
            Choose a name
          </label>
          <input
            id="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={20}
            autoComplete="nickname"
            autoCapitalize="words"
            enterKeyHint="go"
            placeholder="Your name"
            className="h-14 w-full rounded-full border border-line bg-surface/80 px-6 text-lg text-white outline-none backdrop-blur placeholder:text-faint focus:border-red"
          />
          {error && <p className="mt-2 px-2 text-sm text-red-soft">{error}</p>}
          <Button type="submit" disabled={busy || name.trim().length === 0} className="mt-4 w-full">
            {busy ? 'Taking a seat…' : 'Play now'}
          </Button>
        </m.form>

        <m.p
          variants={{ hidden: { opacity: 0 }, show: { opacity: 1 } }}
          className="mt-6 max-w-xs text-center text-sm text-faint"
        >
          Play-money only for now. Every hand ends with a proof you can verify yourself.
        </m.p>
      </m.div>
    </div>
  );
}
