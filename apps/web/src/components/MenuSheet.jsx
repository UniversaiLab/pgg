import { useState } from 'react';
import { ChevronRight, Shield } from './Icons.jsx';
import { Button, Sheet } from './Sheet.jsx';

function Row({ children, onClick, tone = 'text-white', right }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-14 w-full items-center justify-between rounded-2xl bg-raised px-4 text-left text-[16px] font-bold active:bg-hover ${tone}`}
    >
      <span className="flex items-center gap-3">{children}</span>
      {right ?? <ChevronRight className="h-5 w-5 text-faint" />}
    </button>
  );
}

export function MenuSheet({
  open,
  onClose,
  haptics,
  onHaptics,
  canAddChips,
  onAddChips,
  onFairness,
  onLeave,
  vaultTable = false,
  onExit,
  exitStatus = null,
}) {
  const [confirming, setConfirming] = useState(false);
  const close = () => {
    setConfirming(false);
    onClose();
  };
  if (confirming) {
    return (
      <Sheet open={open} onClose={close} title="Exit on chain">
        <p className="mb-4 text-muted">
          This takes your money out through the escrow contract, without the server. Your wallet
          sends the newest state everyone signed. The table stops, and after the exit window
          everyone is paid what that state says. Use it when the table is stuck; to leave normally,
          use Leave table.
        </p>
        <Button
          className="w-full"
          onClick={() => {
            setConfirming(false);
            onExit?.();
          }}
        >
          Exit and withdraw
        </Button>
        <Button tone="dark" className="mt-2 mb-2 w-full" onClick={() => setConfirming(false)}>
          Back
        </Button>
      </Sheet>
    );
  }
  return (
    <Sheet open={open} onClose={close} title="Table">
      <div className="flex flex-col gap-2.5 pb-2">
        <Row onClick={onFairness}>
          <Shield className="h-5 w-5" /> Fair play &amp; proofs
        </Row>
        {canAddChips && <Row onClick={onAddChips}>Add chips</Row>}
        <Row
          onClick={onHaptics}
          checked={haptics}
          right={
            <span
              className={`flex h-7 w-12 items-center rounded-full p-1 transition-colors ${haptics ? 'bg-red' : 'bg-hover'}`}
              aria-hidden="true"
            >
              <span
                className={`h-5 w-5 rounded-full bg-white transition-transform ${haptics ? 'translate-x-5' : ''}`}
              />
            </span>
          }
        >
          Vibration
        </Row>
        {vaultTable && (
          <Row
            onClick={() => setConfirming(true)}
            right={
              exitStatus ? (
                <span className="text-xs font-semibold text-muted">{exitStatus}</span>
              ) : undefined
            }
          >
            Exit and withdraw
          </Row>
        )}
        <Row onClick={onLeave} tone="text-red-soft">
          Leave table
        </Row>
      </div>
    </Sheet>
  );
}
