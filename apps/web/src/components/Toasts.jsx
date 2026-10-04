import { AnimatePresence, m } from 'motion/react';
import { useEffect } from 'react';
import { useClient, useGame } from '../client-context.js';

function Toast({ toast, onDone }) {
  useEffect(() => {
    const timer = setTimeout(onDone, 2800);
    return () => clearTimeout(timer);
  }, [onDone]);
  return (
    <m.div
      layout={false}
      initial={{ y: -30, opacity: 0, scale: 0.9 }}
      animate={{ y: 0, opacity: 1, scale: 1 }}
      exit={{ y: -20, opacity: 0, scale: 0.95 }}
      transition={{ type: 'spring', stiffness: 400, damping: 28 }}
      className={`pointer-events-auto max-w-[88vw] rounded-full px-5 py-3 text-center text-[14px] font-semibold shadow-2xl ${toast.tone === 'error' ? 'bg-red text-white' : 'bg-white text-black'}`}
      role="status"
    >
      {toast.text}
    </m.div>
  );
}

export function Toasts() {
  const client = useClient();
  const toasts = useGame((state) => state.toasts);
  return (
    <div className="safe-top pointer-events-none fixed inset-x-0 top-0 z-[60] flex flex-col items-center gap-2 pt-3">
      <AnimatePresence>
        {toasts.map((toast) => (
          <Toast key={toast.id} toast={toast} onDone={() => client.dismissToast(toast.id)} />
        ))}
      </AnimatePresence>
    </div>
  );
}
