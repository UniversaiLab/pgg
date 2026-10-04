import { m } from 'motion/react';
import { useState } from 'react';
import { useClient, useGame } from '../client-context.js';
import { exact } from '../lib/format.js';
import { Chips } from './AnimatedNumber.jsx';
import { Avatar } from './Avatar.jsx';
import { Background } from './Background.jsx';
import { BuyInSheet } from './BuyInSheet.jsx';
import { ChevronRight, ChipIcon, WifiOff } from './Icons.jsx';

const seatDots = (table) =>
  Array.from({ length: table.numSeats }, (_, id) => ({ id, taken: id < table.occupied }));

export function Lobby() {
  const client = useClient();
  const { me, balance, tables, connection } = useGame();
  const [picked, setPicked] = useState(null);

  return (
    <div className="safe-top safe-bottom relative flex min-h-full flex-col overflow-hidden px-5">
      <Background />
      <header className="relative z-10 flex items-center justify-between pt-2">
        <div className="flex items-center gap-3">
          {me && <Avatar id={me.id} name={me.name} size={44} />}
          <div className="leading-tight">
            <div className="text-lg font-bold text-white">{me?.name}</div>
            <div className="text-xs font-semibold uppercase tracking-wider text-faint">
              Play money
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-line bg-surface/80 py-2 pl-3 pr-4 backdrop-blur">
          <ChipIcon className="h-6 w-6" />
          <Chips value={balance} full className="text-lg font-extrabold text-white" />
        </div>
      </header>

      {connection !== 'open' && (
        <div
          className="relative z-10 mt-4 flex items-center gap-2 rounded-2xl bg-raised px-4 py-3 text-sm text-muted"
          role="status"
        >
          <WifiOff className="h-5 w-5 text-red-soft" />
          Reconnecting…
        </div>
      )}

      <main className="relative z-10 mt-7 flex-1">
        <h1 className="text-4xl font-black tracking-tight text-white">Tables</h1>
        <p className="mt-1 text-muted">Pick a stake. Every hand is verifiable.</p>

        <m.ul
          className="mt-5 flex flex-col gap-3"
          initial="hidden"
          animate="show"
          variants={{ show: { transition: { staggerChildren: 0.07, delayChildren: 0.1 } } }}
        >
          {tables.map((table) => (
            <m.li
              key={table.id}
              variants={{
                hidden: { opacity: 0, y: 26, scale: 0.97 },
                show: { opacity: 1, y: 0, scale: 1 },
              }}
              transition={{ type: 'spring', stiffness: 260, damping: 24 }}
            >
              <button
                type="button"
                onClick={() => setPicked(table)}
                className="group flex w-full items-center gap-4 rounded-[22px] border border-line bg-surface/90 p-4 text-left backdrop-blur transition-transform active:scale-[0.98]"
              >
                <div className="flex h-16 min-w-[4.25rem] shrink-0 flex-col items-center justify-center rounded-2xl bg-red px-2 text-white shadow-[0_0_28px_rgba(240,40,73,0.35)]">
                  <span className="text-[11px] font-bold uppercase tracking-wider opacity-80">
                    Blinds
                  </span>
                  <span className="tabular whitespace-nowrap text-[17px] font-black leading-none">
                    {table.smallBlind}/{table.bigBlind}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-lg font-bold text-white">{table.name}</div>
                  <div className="mt-0.5 text-sm text-muted">
                    Buy-in {exact(table.minBuyIn)}–{exact(table.maxBuyIn)}
                  </div>
                  <div
                    className="mt-2 flex gap-1.5"
                    role="img"
                    aria-label={`${table.occupied} of ${table.numSeats} seats taken`}
                  >
                    {seatDots(table).map((dot) => (
                      <span
                        key={dot.id}
                        className={`h-2.5 w-2.5 rounded-full ${dot.taken ? 'bg-red' : 'bg-hover'}`}
                      />
                    ))}
                  </div>
                </div>
                <ChevronRight className="h-6 w-6 shrink-0 text-faint transition-transform group-active:translate-x-1" />
              </button>
            </m.li>
          ))}
        </m.ul>
      </main>

      <footer className="relative z-10 flex items-center justify-between pb-1 pt-6 text-sm text-faint">
        <span>PGG · play-money preview</span>
        <button
          type="button"
          onClick={() => client.logout()}
          className="font-semibold text-muted underline-offset-4 active:underline"
        >
          Log out
        </button>
      </footer>

      <BuyInSheet
        open={picked !== null}
        onClose={() => setPicked(null)}
        title={picked?.name ?? ''}
        subtitle={
          picked
            ? `Blinds ${picked.smallBlind}/${picked.bigBlind} · you have ${exact(balance)}`
            : ''
        }
        min={picked?.minBuyIn ?? 0}
        max={Math.min(picked?.maxBuyIn ?? 0, balance)}
        bigBlind={picked?.bigBlind ?? 1}
        confirmLabel={(value) => `Sit down with ${exact(value)}`}
        onConfirm={(value) => {
          client.join(picked.id, value);
          setPicked(null);
        }}
      />
    </div>
  );
}
