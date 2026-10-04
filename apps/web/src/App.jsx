import { AnimatePresence, domAnimation, LazyMotion, MotionConfig, m } from 'motion/react';
import { ClientContext, useGame } from './client-context.js';
import { Gate, RotateNotice } from './components/Gate.jsx';
import { Logo } from './components/Icons.jsx';
import { Lobby } from './components/Lobby.jsx';
import { Login } from './components/Login.jsx';
import { Table } from './components/Table.jsx';
import { Toasts } from './components/Toasts.jsx';
import { useDevice } from './lib/device.js';

function Boot() {
  return (
    <div className="flex h-full items-center justify-center bg-black">
      <m.div
        animate={{ scale: [1, 1.08, 1], opacity: [0.7, 1, 0.7] }}
        transition={{ duration: 1.4, repeat: Number.POSITIVE_INFINITY }}
      >
        <Logo size={64} />
      </m.div>
    </div>
  );
}

function Screens() {
  const phase = useGame((state) => state.phase);
  const screen = { boot: <Boot />, login: <Login />, lobby: <Lobby />, table: <Table /> }[phase];
  return (
    <AnimatePresence mode="wait" initial={false}>
      <m.div
        key={phase}
        className="h-full"
        initial={{ opacity: 0, scale: 0.985 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.22 }}
      >
        {screen}
      </m.div>
    </AnimatePresence>
  );
}

export function App({ client }) {
  const device = useDevice();
  // The providers wrap everything, including the desktop gate: `m` components outside
  // <LazyMotion> never animate, and would stay stuck at their invisible starting state.
  return (
    <ClientContext.Provider value={client}>
      <MotionConfig reducedMotion="user">
        <LazyMotion features={domAnimation} strict>
          {device.mobile ? (
            <>
              <div className="mx-auto h-full max-w-md overflow-hidden bg-black">
                <Screens />
              </div>
              <Toasts />
              {device.landscape && <RotateNotice />}
            </>
          ) : (
            <Gate />
          )}
        </LazyMotion>
      </MotionConfig>
    </ClientContext.Provider>
  );
}
