import { useState } from 'react';
import { Check, Close, Shield } from './Icons.jsx';
import { Sheet } from './Sheet.jsx';

const short = (hex, head = 8, tail = 6) =>
  hex.length > head + tail + 1 ? `${hex.slice(0, head)}…${hex.slice(-tail)}` : hex;

function Status({ ok }) {
  if (ok === undefined)
    return (
      <span className="shimmer rounded-full px-3 py-1 text-xs font-bold text-faint">Checking…</span>
    );
  return ok ? (
    <span className="flex items-center gap-1 rounded-full bg-white px-3 py-1 text-xs font-bold text-black">
      <Check className="h-3.5 w-3.5" /> Verified
    </span>
  ) : (
    <span className="flex items-center gap-1 rounded-full bg-red px-3 py-1 text-xs font-bold text-white">
      <Close className="h-3.5 w-3.5" /> Failed
    </span>
  );
}

/** Every hand ends with a proof; the app checks each one on this phone and lists the outcome. */
export function FairnessSheet({ open, onClose, proofs, next, signed = null }) {
  const [openRow, setOpenRow] = useState(null);
  return (
    <Sheet open={open} onClose={onClose} title="Fair play">
      <p className="-mt-1 mb-4 text-[15px] leading-snug text-muted">
        Before each hand the table commits to a secret shuffle. After the hand it shows you the
        secret, and your phone checks that the cards were never changed.
      </p>
      {signed && (
        <div className="mb-4 rounded-2xl bg-raised p-3.5">
          <div className="text-xs font-bold uppercase tracking-wider text-faint">
            Kept on this phone, signed by every player
          </div>
          <div className="mt-1 text-[15px] font-bold text-white">{signed}</div>
        </div>
      )}
      {next && (
        <div className="mb-4 rounded-2xl bg-raised p-3.5">
          <div className="text-xs font-bold uppercase tracking-wider text-faint">
            Committed for hand #{next.handNo}
          </div>
          <div className="mt-1 break-all font-mono text-[13px] text-white">
            {short(next.commitment, 14, 10)}
          </div>
        </div>
      )}
      <div className="max-h-[38vh] overflow-y-auto">
        {proofs.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center text-muted">
            <Shield className="h-9 w-9 text-faint" />
            Play a hand and its proof will appear here.
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {proofs.map(({ handNo, proof, ok }) => (
              <li key={handNo} className="rounded-2xl bg-raised">
                <button
                  type="button"
                  onClick={() => setOpenRow(openRow === handNo ? null : handNo)}
                  className="flex w-full items-center justify-between px-4 py-3 text-left"
                  aria-expanded={openRow === handNo}
                >
                  <span className="font-bold text-white">Hand #{handNo}</span>
                  <Status ok={ok} />
                </button>
                {openRow === handNo && (
                  <dl className="space-y-2 px-4 pb-4 font-mono text-[12px] text-muted">
                    <div>
                      <dt className="font-sans text-[11px] font-bold uppercase tracking-wider text-faint">
                        Commitment
                      </dt>
                      <dd className="break-all text-white">{proof.commitment}</dd>
                    </div>
                    <div>
                      <dt className="font-sans text-[11px] font-bold uppercase tracking-wider text-faint">
                        Revealed secret
                      </dt>
                      <dd className="break-all text-white">{proof.serverSeed}</dd>
                    </div>
                    <div>
                      <dt className="font-sans text-[11px] font-bold uppercase tracking-wider text-faint">
                        Seeds from players
                      </dt>
                      <dd className="break-all text-white">
                        {proof.clientSeeds.length
                          ? proof.clientSeeds.map((s) => `seat ${s.seat}: ${s.seed}`).join('  ')
                          : 'none'}
                      </dd>
                    </div>
                  </dl>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Sheet>
  );
}
