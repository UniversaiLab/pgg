import { AnimatePresence, m } from 'motion/react';
import { bannerFor } from '../lib/vault-ui.js';
import { Shield } from './Icons.jsx';

const TONES = {
  red: 'bg-red text-white',
  white: 'bg-white text-black',
  muted: 'bg-surface text-muted ring-1 ring-line',
};

/** A vault table's standing message. Persistent, never a toast: it stays until its cause is gone. */
export function VaultBanner({ table, vault }) {
  const banner = bannerFor(table, vault);
  return (
    <AnimatePresence initial={false}>
      {banner && (
        <m.div
          key={banner.title}
          role={banner.tone === 'red' ? 'alert' : 'status'}
          className={`mx-3 mb-2 flex gap-3 rounded-2xl px-4 py-3 ${TONES[banner.tone]}`}
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
        >
          <Shield className="mt-0.5 h-5 w-5 shrink-0" />
          <div className="min-w-0">
            <div className="text-[15px] font-bold leading-snug">{banner.title}</div>
            <div className="mt-0.5 text-[13px] leading-snug opacity-90">{banner.body}</div>
          </div>
        </m.div>
      )}
    </AnimatePresence>
  );
}
