import { ChevronRight, Shield } from './Icons.jsx';
import { Sheet } from './Sheet.jsx';

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
}) {
  return (
    <Sheet open={open} onClose={onClose} title="Table">
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
          <div
            aria-disabled="true"
            className="flex h-14 w-full items-center justify-between rounded-2xl bg-raised px-4 text-[16px] font-bold text-faint"
          >
            Exit and withdraw
            <span className="text-xs font-semibold">needs a wallet · coming next</span>
          </div>
        )}
        <Row onClick={onLeave} tone="text-red-soft">
          Leave table
        </Row>
      </div>
    </Sheet>
  );
}
