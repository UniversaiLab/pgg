import { AnimatePresence, m } from 'motion/react';
import { useEffect } from 'react';

/** A bottom sheet. Tap the dimmed area, press Escape, or use the close affordance to dismiss. */
export function Sheet({ open, onClose, title, children }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <m.button
            type="button"
            aria-label="Close"
            className="fixed inset-0 z-40 cursor-default bg-black/75"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <m.div
            role="dialog"
            aria-modal="true"
            aria-label={title}
            className="safe-bottom fixed inset-x-0 bottom-0 z-50 mx-auto max-w-md rounded-t-[28px] border-t border-line bg-surface px-5 pt-3"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', stiffness: 420, damping: 38 }}
          >
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="mx-auto mb-3 block h-1.5 w-11 rounded-full bg-hover"
            />
            {title && <h2 className="mb-3 text-xl font-bold text-white">{title}</h2>}
            {children}
          </m.div>
        </>
      )}
    </AnimatePresence>
  );
}

/** The pill button used across the app. */
export function Button({ tone = 'red', className = '', children, ...props }) {
  const tones = {
    red: 'bg-red text-white active:bg-red-deep',
    white: 'bg-white text-black active:bg-neutral-300',
    dark: 'bg-raised text-white active:bg-hover',
    ghost: 'bg-transparent text-white border border-line active:bg-raised',
  };
  return (
    <button
      type="button"
      className={`flex h-14 items-center justify-center gap-2 rounded-full px-6 text-[17px] font-bold transition-transform active:scale-[0.97] disabled:opacity-40 disabled:active:scale-100 ${tones[tone]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
