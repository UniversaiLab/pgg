import { useEffect, useState } from 'react';
import { useClient, useGame } from '../client-context.js';
import { exact, shortAddress, tokenAmount } from '../lib/format.js';
import { ChipIcon } from './Icons.jsx';
import { Button, Sheet } from './Sheet.jsx';

const STEP_TEXT = {
  connecting: 'Open your wallet to connect…',
  approve: 'Confirm the spending approval in your wallet…',
  deposit: 'Confirm the deposit in your wallet…',
  claiming: 'Deposit confirmed. Taking your seat…',
  minting: 'Confirm the test-token mint in your wallet…',
  done: 'You are in. Your seat is ready.',
};

// Local and test chains run a MockToken anyone may mint.
const TEST_CHAINS = new Set([31337, 80002, 97, 11155111]);

/**
 * Sit at a real-money (vault) table: connect the wallet, pick an amount in chips, deposit it into the escrow
 * contract. The chips are locked in the contract, not held by us; they come back through a signed state
 * when you leave.
 */
export function DepositSheet({ table, onClose }) {
  const client = useClient();
  const { wallet, cashier } = useGame();
  const open = table !== null;
  const unit = table?.vault ? BigInt(table.vault.chipUnit) : 1n;
  const decimals = wallet?.decimals ?? 6;
  const symbol = wallet?.symbol ?? 'USDC';
  const min = table?.minBuyIn ?? 0;
  const walletChips = wallet ? Number(BigInt(wallet.balance) / unit) : 0;
  const max = Math.min(table?.maxBuyIn ?? 0, walletChips);
  const [value, setValue] = useState(min);
  const busy =
    cashier && ['connecting', 'approve', 'deposit', 'claiming', 'minting'].includes(cashier.step);
  const filling = table?.vault?.phase === 'filling' || table?.vault?.phase === undefined;

  useEffect(() => {
    if (open)
      setValue(Math.max(min, Math.min(max, Math.round((min + (table?.maxBuyIn ?? min)) / 2))));
  }, [open, min, max, table?.maxBuyIn]);

  useEffect(() => {
    if (cashier?.step === 'done') {
      const timer = setTimeout(() => {
        client.closeCashier();
        onClose();
      }, 1200);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [cashier?.step, client, onClose]);

  const close = () => {
    if (!busy) {
      client.closeCashier();
      onClose();
    }
  };

  const fill = max > min ? ((value - min) / (max - min)) * 100 : 100;

  return (
    <Sheet open={open} onClose={close} title={table?.name ?? ''}>
      <p className="-mt-2 mb-4 text-muted">
        Real money · blinds {table?.smallBlind}/{table?.bigBlind} · 1 chip ={' '}
        {tokenAmount(unit, decimals)} {symbol}
      </p>

      {!wallet ? (
        <div className="flex flex-col gap-3">
          <p className="rounded-2xl bg-raised p-4 text-sm text-muted">
            Your stake is locked in the PGG escrow contract on chain. Only a state you and the table
            signed can pay it out, and you can always exit on your own.
          </p>
          {client.walletAvailable() ? (
            <Button className="w-full" disabled={busy} onClick={() => client.connectWallet()}>
              Connect wallet
            </Button>
          ) : (
            <p className="rounded-2xl bg-raised p-4 text-sm text-white">
              No wallet found. Open this page in your wallet app’s browser (MetaMask, Coinbase
              Wallet, Rabby…) to play for real money.
            </p>
          )}
        </div>
      ) : !filling ? (
        <p className="rounded-2xl bg-raised p-4 text-sm text-muted">
          This table is playing an epoch right now. Deposits open again at the next rotation, when
          players leave or join.
        </p>
      ) : (
        <>
          <div className="mb-3 flex items-center justify-between rounded-2xl bg-raised px-4 py-3 text-sm">
            <span className="text-muted">{shortAddress(wallet.address)}</span>
            <span className="tabular font-bold text-white">
              {tokenAmount(wallet.balance, decimals)} {symbol}
            </span>
          </div>
          {max < min ? (
            <div className="flex flex-col gap-3">
              <p className="rounded-2xl bg-raised p-4 text-sm text-muted">
                You need at least {tokenAmount(BigInt(min) * unit, decimals)} {symbol} for this
                table.
              </p>
              {TEST_CHAINS.has(table?.vault?.chainId) && (
                <Button
                  tone="dark"
                  className="w-full"
                  disabled={busy}
                  onClick={() => client.mintTestTokens(BigInt(table.maxBuyIn) * unit)}
                >
                  Get test {symbol}
                </Button>
              )}
            </div>
          ) : (
            <>
              <div className="flex items-center justify-center gap-3 py-1">
                <ChipIcon className="h-9 w-9" />
                <span className="tabular text-5xl font-black text-white">{exact(value)}</span>
              </div>
              <p className="tabular mb-2 text-center text-muted">
                {tokenAmount(BigInt(value) * unit, decimals)} {symbol}
              </p>
              <input
                type="range"
                aria-label="Amount"
                min={min}
                max={max}
                step={Math.max(1, Math.round((table?.bigBlind ?? 2) / 2))}
                value={value}
                disabled={busy}
                onChange={(event) => setValue(Number(event.target.value))}
                style={{ '--fill': `${fill}%` }}
              />
              <Button
                className="mt-5 w-full"
                disabled={busy}
                onClick={() => client.deposit(table.id, value)}
              >
                Deposit {tokenAmount(BigInt(value) * unit, decimals)} {symbol}
              </Button>
            </>
          )}
        </>
      )}

      {cashier?.step && STEP_TEXT[cashier.step] && (
        <p className="mt-4 text-center text-sm font-semibold text-white" role="status">
          {STEP_TEXT[cashier.step]}
        </p>
      )}
      {cashier?.step === 'error' && (
        <p
          className="mt-4 rounded-2xl bg-red/15 p-3 text-center text-sm text-red-soft"
          role="alert"
        >
          {cashier.error}
        </p>
      )}
    </Sheet>
  );
}
