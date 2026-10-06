import { AnimatePresence, m } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useClient, useGame } from '../client-context.js';
import { chips as short } from '../lib/format.js';
import { vaultHere } from '../lib/game.js';
import { setHaptics } from '../lib/haptics.js';
import { tableGeometry, towardCenter } from '../lib/seats.js';
import { signedLabel, vaultAlarm, waitingText } from '../lib/vault-ui.js';
import { ActionBar } from './ActionBar.jsx';
import { Chips } from './AnimatedNumber.jsx';
import { Board } from './Board.jsx';
import { BuyInSheet } from './BuyInSheet.jsx';
import { FairnessSheet } from './FairnessSheet.jsx';
import { ChevronLeft, ChipIcon, Dots, Shield } from './Icons.jsx';
import { MenuSheet } from './MenuSheet.jsx';
import { ResultBanner } from './ResultBanner.jsx';
import { Seat } from './Seat.jsx';
import { Button, Sheet } from './Sheet.jsx';
import { VaultBanner } from './VaultBanner.jsx';

function useBox(ref) {
  const [box, setBox] = useState({ w: 360, h: 560 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const observer = new ResizeObserver(([entry]) =>
      setBox({ w: entry.contentRect.width, h: entry.contentRect.height }),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return box;
}

const px = (from, to, box) => ({
  x: ((to.x - from.x) / 100) * box.w,
  y: ((to.y - from.y) / 100) * box.h,
});

function Joining() {
  return (
    <div className="flex min-h-full items-center justify-center bg-black text-muted" role="status">
      <div className="flex items-center gap-3">
        <span className="spin-slow inline-block h-5 w-5 rounded-full border-2 border-red border-t-transparent" />
        Taking your seat…
      </div>
    </div>
  );
}

/** Chips on the felt in front of a seat. They slide out from the seat, and sweep into the pot. */
function Bet({ pos, amount, box, pot, board }) {
  // The hero's own cards sit just above their avatar, so their bet goes further out.
  const spot = towardCenter(pos, board, box, pos.slot === 0 ? 150 : 86);
  const fromSeat = px(spot, pos, box);
  const toPot = px(spot, pot, box);
  return (
    <div
      className="absolute z-[5] -translate-x-1/2 -translate-y-1/2"
      style={{ left: `${spot.x}%`, top: `${spot.y}%` }}
    >
      <m.div
        className="flex items-center gap-1 rounded-full bg-black/85 py-[3px] pl-1 pr-2.5 ring-1 ring-white/20"
        initial={{ ...fromSeat, opacity: 0, scale: 0.5 }}
        animate={{ x: 0, y: 0, opacity: 1, scale: 1 }}
        exit={{ ...toPot, opacity: 0, scale: 0.55, transition: { duration: 0.45, ease: 'easeIn' } }}
        transition={{ type: 'spring', stiffness: 320, damping: 26 }}
      >
        <ChipIcon className="h-[18px] w-[18px]" tone="white" />
        <span className="tabular text-[13px] font-extrabold text-white">{short(amount)}</span>
      </m.div>
    </div>
  );
}

/** Winnings travel from the pot to the winner. */
function Payout({ pos, box, pot }) {
  const { x, y } = px(pot, pos, box);
  return (
    <div
      className="pointer-events-none absolute z-[15] -translate-x-1/2 -translate-y-1/2"
      style={{ left: `${pot.x}%`, top: `${pot.y}%` }}
    >
      <m.div
        initial={{ opacity: 0, scale: 0.5, x: 0, y: 0 }}
        animate={{
          opacity: [0, 1, 1, 0],
          scale: [0.5, 1.2, 1, 0.7],
          x: [0, 0, x, x],
          y: [0, 0, y, y],
        }}
        transition={{ duration: 1.4, times: [0, 0.16, 0.82, 1], delay: 0.35, ease: 'easeInOut' }}
      >
        <ChipIcon className="h-9 w-9 drop-shadow-[0_0_14px_rgba(240,40,73,0.9)]" />
      </m.div>
    </div>
  );
}

export function Table() {
  const client = useClient();
  const game = useGame();
  const { table, seat: heroSeat, hole, result, proofs, balance, tables, seq } = game;
  const feltRef = useRef(null);
  const box = useBox(feltRef);
  const [sheet, setSheet] = useState(null); // 'menu' | 'fairness' | 'leave' | 'chips'
  const [vibration, setVibration] = useState(true);
  const [pending, setPending] = useState(false);

  // A fresh message from the server means our last action has been dealt with.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `seq` is the trigger
  useEffect(() => setPending(false), [seq]);

  if (!table || heroSeat === null) return <Joining />;

  const hero = table.seats[heroSeat];
  const heroTurn = table.toAct === heroSeat;
  const cardW = Math.max(34, Math.min(54, box.w * 0.145));
  const geo = tableGeometry(box, table.seats.length, heroSeat, { cardHeight: cardW * 1.42 });
  const layout = geo.seats;
  const serverNow = client.socket?.serverNow() ?? Date.now();
  const ringMs = table.deadline ? Math.max(0, table.deadline - serverNow) : 0;
  const summary = tables.find((t) => t.id === game.tableId);
  const reveals = new Map((result?.reveals ?? []).map((r) => [r.seat, r.cards]));
  const winners = new Set((result?.payouts ?? []).filter((p) => p.net > 0).map((p) => p.seat));
  const handKey = table.handNo ?? 0;
  const vault = vaultHere(game);
  const isVault = Boolean(table.vault);
  // a vault failure turns the shield red too, like a proof that failed
  const proofsBad = proofs.some((p) => p.ok === false) || vaultAlarm(vault);
  const playersReady = table.seats.filter((s) => s && s.status !== 'sitout').length;
  const dealing = table.inHand && table.board.length === 0 && table.round === 'preflop';

  const act = (action, amount) => {
    if (client.act(action, amount)) setPending(true);
  };

  return (
    <div className="relative flex h-full flex-col bg-black">
      <header className="safe-top relative z-30 flex items-center justify-between px-3 pb-1">
        <button
          type="button"
          aria-label="Leave table"
          onClick={() => setSheet('leave')}
          className="flex h-11 w-11 items-center justify-center rounded-full bg-surface/90 text-white active:bg-hover"
        >
          <ChevronLeft className="h-6 w-6" />
        </button>
        <div className="text-center leading-tight">
          <div className="text-[15px] font-bold text-white">{table.name}</div>
          <div className="text-xs font-semibold text-faint">
            {summary ? `${summary.smallBlind}/${summary.bigBlind}` : ''}
            {table.handNo ? ` · Hand #${table.handNo}` : ''}
          </div>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            aria-label="Fair play proofs"
            onClick={() => setSheet('fairness')}
            className={`relative flex h-11 w-11 items-center justify-center rounded-full active:bg-hover ${proofsBad ? 'bg-red text-white' : 'bg-surface/90 text-white'}`}
          >
            <Shield className="h-5 w-5" />
            {proofs.length > 0 && !proofsBad && (
              <span className="absolute right-2 top-2 h-2.5 w-2.5 rounded-full bg-white ring-2 ring-black" />
            )}
          </button>
          <button
            type="button"
            aria-label="Table menu"
            onClick={() => setSheet('menu')}
            className="flex h-11 w-11 items-center justify-center rounded-full bg-surface/90 text-white active:bg-hover"
          >
            <Dots className="h-5 w-5" />
          </button>
        </div>
      </header>

      {isVault && <VaultBanner table={table} vault={vault} />}

      <div ref={feltRef} className="felt relative min-h-0 flex-1 overflow-hidden">
        <div className="felt-rim" />

        {/* pot */}
        <AnimatePresence>
          {table.inHand && table.pot > 0 && (
            <m.div
              key="pot"
              className="absolute z-[6] -translate-x-1/2 -translate-y-1/2"
              style={{ left: `${geo.pot.x}%`, top: `${geo.pot.y}%` }}
              initial={{ opacity: 0, scale: 0.7 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
            >
              <div className="flex items-center gap-1.5 rounded-full bg-black/80 py-1 pl-1.5 pr-3.5 ring-1 ring-white/15">
                <ChipIcon className="h-6 w-6" />
                <span className="text-[12px] font-bold uppercase tracking-wide text-faint">
                  Pot
                </span>
                <Chips value={table.pot} className="text-[16px] font-black text-white" />
              </div>
            </m.div>
          )}
        </AnimatePresence>

        {/* board */}
        <div
          className="absolute z-[4] -translate-x-1/2 -translate-y-1/2"
          style={{ left: `${geo.board.x}%`, top: `${geo.board.y}%` }}
        >
          <Board board={table.board} cardWidth={cardW} />
        </div>

        {/* waiting message */}
        {!table.inHand && !result && (
          <div
            className="absolute left-1/2 top-[40%] z-[4] -translate-x-1/2 text-center"
            role="status"
          >
            <div className="text-lg font-bold text-white">
              {playersReady < 2 ? 'Waiting for players' : 'Next hand starting'}
            </div>
            <div className="mt-1 flex justify-center gap-1.5">
              {[0, 1, 2].map((i) => (
                <m.span
                  key={i}
                  className="h-2 w-2 rounded-full bg-red"
                  animate={{ opacity: [0.2, 1, 0.2], scale: [0.8, 1.15, 0.8] }}
                  transition={{ duration: 1.1, repeat: Number.POSITIVE_INFINITY, delay: i * 0.18 }}
                />
              ))}
            </div>
          </div>
        )}

        {/* bets */}
        <AnimatePresence>
          {table.seats.map((entry) =>
            entry && entry.bet > 0 ? (
              <Bet
                key={`${entry.seat}`}
                pos={layout[entry.seat]}
                amount={entry.bet}
                box={box}
                pot={geo.pot}
                board={geo.board}
              />
            ) : null,
          )}
        </AnimatePresence>

        {/* payouts */}
        {result?.payouts
          .filter((p) => p.net > 0)
          .map((p) => (
            <Payout
              key={`${result.handNo}-${p.seat}`}
              pos={layout[p.seat]}
              box={box}
              pot={geo.pot}
            />
          ))}

        {/* seats */}
        {table.seats.map((entry) => {
          if (!entry) return null;
          const seat = entry.seat;
          const pos = layout[seat];
          const isHero = seat === heroSeat;
          return (
            <Seat
              key={entry.seat}
              entry={entry}
              pos={pos}
              isHero={isHero}
              isButton={table.button === seat && (table.inHand || Boolean(result))}
              acting={table.toAct === seat}
              ring={table.toAct === seat ? { ms: ringMs, cycle: table.deadline } : null}
              hole={isHero && hole?.handNo === table.handNo ? hole : null}
              reveal={reveals.get(seat) ?? null}
              dealFrom={px(pos, geo.pot, box)}
              dealOrder={pos.slot}
              winner={winners.has(seat)}
              cardWidth={cardW}
              handNo={handKey}
              resultVisible={Boolean(result)}
            />
          );
        })}

        <ResultBanner result={result} seats={table.seats} heroSeat={heroSeat} top={geo.pot.y} />
        {dealing && (
          <span className="sr-only" role="status">
            Dealing a new hand
          </span>
        )}
      </div>

      <footer className="safe-bottom relative z-30 px-4 pt-3">
        <ActionBar
          table={table}
          hero={hero}
          heroTurn={heroTurn}
          onAct={act}
          onBack={() => client.back()}
          pending={pending}
          waitText={isVault ? waitingText(table, serverNow) : null}
        />
      </footer>

      <MenuSheet
        open={sheet === 'menu'}
        onClose={() => setSheet(null)}
        haptics={vibration}
        onHaptics={() => {
          setVibration(!vibration);
          setHaptics(!vibration);
        }}
        vaultTable={isVault}
        canAddChips={
          !isVault &&
          Boolean(summary) &&
          hero &&
          (hero.status !== 'seated' || !table.inHand) &&
          hero.chips < summary.maxBuyIn
        }
        onAddChips={() => setSheet('chips')}
        onFairness={() => setSheet('fairness')}
        onLeave={() => setSheet('leave')}
      />
      <FairnessSheet
        open={sheet === 'fairness'}
        onClose={() => setSheet(null)}
        proofs={proofs}
        next={table.fairness.next}
        signed={signedLabel(vault)}
      />
      <Sheet open={sheet === 'leave'} onClose={() => setSheet(null)} title="Leave this table?">
        <p className="-mt-1 mb-5 text-muted">
          {isVault
            ? 'Your chips are paid out on chain when this round of the table ends, usually after the next hand.'
            : table.inHand && hero?.hasCards
              ? 'You will fold this hand and your chips return to your balance when it ends.'
              : 'Your chips return to your balance.'}
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Button tone="dark" onClick={() => setSheet(null)}>
            Stay
          </Button>
          <Button
            onClick={() => {
              if (table.inHand && hero?.hasCards) client.toast("You'll leave after this hand");
              client.leave();
              setSheet(null);
            }}
          >
            Leave
          </Button>
        </div>
      </Sheet>
      {summary && hero && (
        <BuyInSheet
          open={sheet === 'chips'}
          onClose={() => setSheet(null)}
          title="Add chips"
          subtitle={`Table maximum ${summary.maxBuyIn.toLocaleString('en-US')}`}
          min={Math.min(summary.bigBlind, Math.min(balance, summary.maxBuyIn - hero.chips))}
          max={Math.min(balance, summary.maxBuyIn - hero.chips)}
          bigBlind={summary.bigBlind}
          confirmLabel={(value) => `Add ${value.toLocaleString('en-US')}`}
          onConfirm={(value) => {
            client.rebuy(value);
            setSheet(null);
          }}
        />
      )}
    </div>
  );
}
