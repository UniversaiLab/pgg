// The one decision about what to send to the chain, as a pure function (docs/signing-layer.md section 4,
// F3 and F5). The coordinator and the watchtower both call it, level-triggered on every tick and on startup:
// events are only a hint to look sooner. It reads three things and sends nothing:
//
//   chainRow   chain.table(tableKey)
//   store      { epochBaseNonce, bundle, finalBundle, openRound? } for that table
//   chainTime  chain seconds (never Date.now())
//
// Rows, first match wins. Nonces compare as numbers; "digest equal" compares the exit's digest with the
// digest of the bundle we hold.
//
//   Active   B final, B.nonce > chain.nonce          settle(B)
//   Active   anything else                           nothing (a stall is stallAction's business)
//   Exiting  B final, chain.nonce < B.nonce          settle(B)        never challenge a final (it pays at once)
//   Exiting  B not final, chain.nonce < B.nonce      challenge(B)     only if chainTime + margin < deadline
//   Exiting  chain.nonce == B.nonce, digests equal   wait, finalizeExit once chainTime > deadline
//   Exiting  chain.nonce == B.nonce, digests differ  alarm
//   Exiting  chain.nonce > B.nonce                   alarm (the caller may try to adopt a client's bundle)
//   Filling, Closed (and no row)                     done
//
// B is the CURRENT epoch's newest all-signed bundle. With no B (the first round of an epoch) the baseline is
// epochBaseNonce, and the only exit that can sit at that nonce is startExitFromDeposits, whose digest is
// `depositDigest`; that is the one equal-nonce case that is correct without a bundle. A final bundle of the
// PREVIOUS epoch (`finalBundle`) matters only when the chain is behind it, for instance after a reorg took
// the settle away: then it is settled again. Equal to the chain's nonce (a rollover just happened) it means
// nothing, and sending it would only revert with StaleNonce.
//
// `openRound` is accepted and ignored on purpose: a round still collecting signatures never produces a chain
// action, so the state of an open round can never be what an exit or a challenge puts up.
import { bundleDigest } from '@pgg/vault';
import { statusName, TABLE_STATUS } from './chain-port.js';

/** The `alarm` strings nextChainAction can return. */
export const ALARMS = Object.freeze({
  chainNonceAboveBundle: 'chain-nonce-above-bundle',
  chainBehindStore: 'chain-behind-store',
  exitDigestMismatch: 'exit-digest-mismatch',
  challengeWindowMissed: 'challenge-window-missed',
});

const DECIMAL = /^(0|[1-9][0-9]{0,19})$/;

function nonce(value, field) {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && DECIMAL.test(value)) return BigInt(value);
  throw new TypeError(
    `${field} must be a non-negative nonce (bigint, safe integer or decimal string)`,
  );
}

function seconds(value, field) {
  const n = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(n) || n < 0)
    throw new TypeError(`${field} must be a non-negative integer`);
  return n;
}

function bundleView(bundle, field) {
  if (bundle === null || bundle === undefined) return null;
  const state = bundle.state;
  if (state === null || typeof state !== 'object' || typeof state.isFinal !== 'boolean') {
    throw new TypeError(`${field} must be a bundle with a state`);
  }
  return { bundle, nonce: nonce(state.nonce, `${field}.state.nonce`), isFinal: state.isFinal };
}

function readStore(store) {
  if (store === null || typeof store !== 'object') throw new TypeError('store must be an object');
  const current = bundleView(store.bundle, 'store.bundle');
  const previous = bundleView(store.finalBundle, 'store.finalBundle');
  if (previous && !previous.isFinal) throw new TypeError('store.finalBundle must be a final state');
  return { base: nonce(store.epochBaseNonce, 'store.epochBaseNonce'), current, previous };
}

function readRow(chainRow) {
  if (chainRow === null || chainRow === undefined) return null;
  const status = statusName(chainRow.status);
  if (status !== TABLE_STATUS.Active && status !== TABLE_STATUS.Exiting) return { status };
  const row = { status, nonce: nonce(chainRow.nonce, 'chainRow.nonce') };
  if (status === TABLE_STATUS.Exiting) {
    row.deadline = seconds(chainRow.exitDeadline, 'chainRow.exitDeadline');
    if (typeof chainRow.exitDigest !== 'string')
      throw new TypeError('chainRow.exitDigest is required');
    row.digest = chainRow.exitDigest.toLowerCase();
  }
  return row;
}

const withTable = (action, tableKey) => (tableKey === undefined ? action : { ...action, tableKey });
const alarm = (name) => ({ alarm: name });

/**
 * What to send for one table right now: { kind } (plus tableKey when given), { alarm }, or null for nothing.
 * `kind` is a job kind; the executor reads the bundle itself when it runs (jobs carry none).
 *
 *   tableKey            optional, echoed into the result
 *   challengeMarginSec  a challenge is attempted only while chainTime + margin < exitDeadline
 *   depositDigest       digest of the epoch's deposit state (hashState of depositState with the table's
 *                       nonce and rakePaid), needed to recognise a correct exit from deposits when there is
 *                       no bundle in this epoch; without it that exit is reported as a mismatch
 *
 * Throws TypeError on input it cannot read: that is a caller bug, not a state of the world.
 */
export function nextChainAction({
  tableKey,
  chainRow,
  store,
  chainTime,
  challengeMarginSec,
  depositDigest,
}) {
  const row = readRow(chainRow);
  const { base, current, previous } = readStore(store);
  const now = seconds(chainTime, 'chainTime');
  const margin = seconds(challengeMarginSec, 'challengeMarginSec');
  if (!row) return null;
  if (row.status !== TABLE_STATUS.Active && row.status !== TABLE_STATUS.Exiting) return null;

  const settle = withTable({ kind: 'settle' }, tableKey);

  // The chain is behind a final bundle we hold from the last epoch: the settle was reorged away or lost.
  if (previous && previous.nonce > row.nonce) return settle;

  if (row.status === TABLE_STATUS.Active) {
    if (!current) return row.nonce > base ? alarm(ALARMS.chainNonceAboveBundle) : null;
    if (current.nonce > row.nonce) return current.isFinal ? settle : null;
    // The chain is at B's nonce only if B was settled and the Settled event has not been applied yet.
    return current.nonce === row.nonce && current.isFinal
      ? null
      : alarm(ALARMS.chainNonceAboveBundle);
  }

  const known = current ? current.nonce : base;
  if (row.nonce > known) return alarm(ALARMS.chainNonceAboveBundle);
  if (row.nonce < known) {
    if (!current) return alarm(ALARMS.chainBehindStore);
    if (current.isFinal) return settle;
    if (now + margin < row.deadline) return withTable({ kind: 'challenge' }, tableKey);
    return alarm(ALARMS.challengeWindowMissed);
  }

  const expected = current ? bundleDigest(current.bundle) : depositDigest;
  if (typeof expected !== 'string' || expected.toLowerCase() !== row.digest) {
    return alarm(ALARMS.exitDigestMismatch);
  }
  return now > row.deadline ? withTable({ kind: 'finalizeExit' }, tableKey) : null;
}

/**
 * The exit the server starts when a table has stalled (chain still Active): startExit(B) when this epoch has
 * a bundle B newer than the chain, otherwise startExitFromDeposits. In the first round of an epoch the
 * previous final's nonce equals the chain's, so startExit would revert with StaleNonce; and an open round's
 * state is never used, because it is not all-signed. A final B is settled instead: it pays at once and the
 * table goes back to Filling, where an exit would lock the funds for the window and close the table.
 * Returns null unless the chain row is Active. `view` is { tableKey?, chainRow, store }.
 */
export function stallAction({ tableKey, chainRow, store }) {
  const row = readRow(chainRow);
  const { current } = readStore(store);
  if (!row || row.status !== TABLE_STATUS.Active) return null;
  if (current && current.nonce > row.nonce) {
    return withTable({ kind: current.isFinal ? 'settle' : 'startExit' }, tableKey);
  }
  return withTable({ kind: 'startExitFromDeposits' }, tableKey);
}
