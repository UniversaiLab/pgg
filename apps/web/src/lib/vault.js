// The vault signing controller (docs/signing-layer.md section 8). client.js imports it LAZILY, only once a
// vault table or a vault message shows up, so a play-money session never loads it, never touches its storage
// and never logs. It wraps the durable signer and the ledger of @pgg/vault:
//
//   claim     on every welcome, for each vault table this device holds a key for: the server then re-sends the
//             epoch, the newest bundle and any open signreq (it keeps nothing about us across a restart)
//   epoch     pinned only after the chain view, built from the app build's RPC URL, agrees with it (F1)
//   tbl       what this player SAW: the ledger judges every proposal against it (F8)
//   signreq   answered only through the signer, which writes its record before it returns a signature; a
//             'wait' (the ledger has not seen enough yet) is kept and retried on the next table or epoch message
//   bundle    kept only when every signature verifies against the pinned epoch
//
// What the rules compare against is never taken from the server: the wallet, the unit and the domain come from
// this device's key record (or the app build), and the server's maxRakeBps can only make the check stricter.
// Nothing here deletes a key or a record; no server message leads to signer.forget. Messages are handled one at
// a time, in order, and only the tab that holds the table's lock signs (a Web Lock, or a storage lease).
import { CLIENT, SERVER } from '@pgg/protocol/constants';
import { createLedger, createRpcChainView, createSigner, RAKE_BPS_CEILING } from '@pgg/vault';

const LEASE_PREFIX = 'pgg.vault.lease.';
const RECENT_TABLES = 8;

/**
 * This tab's identity for the storage lease. Kept in sessionStorage, which survives a reload of the same tab
 * (a reloaded page must not wait out the lease its previous life took) but is not shared with other tabs.
 */
export function tabIdentity(session = globalThis.sessionStorage) {
  const fresh = `tab-${Math.floor(Math.random() * 2 ** 48).toString(36)}`;
  try {
    const known = session?.getItem('pgg.vault.tab');
    if (known) return known;
    session?.setItem('pgg.vault.tab', fresh);
  } catch {
    // no session storage: a reload then waits for the old lease to run out
  }
  return fresh;
}

/**
 * A chain view that never hangs: every read races a timer (createRpcChainView relies on AbortSignal.timeout,
 * which Safari before 16 lacks). A timeout is an ordinary read failure: the epoch is checked again later.
 */
export function withTimeout(view, { ms = 8_000, timers = globalThis } = {}) {
  const race = (promise) =>
    new Promise((resolve) => {
      const timer = timers.setTimeout(() => resolve({ ok: false, error: 'timeout' }), ms);
      Promise.resolve(promise).then(
        (value) => {
          timers.clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          timers.clearTimeout(timer);
          resolve({ ok: false, error: String(error?.message ?? error) });
        },
      );
    });
  return {
    table: (tableKey) => race(view.table(tableKey)),
    seat: (tableKey, address) => race(view.seat(tableKey, address)),
  };
}

/**
 * The chain view the app build pins: { rpcUrl, vault } from VITE_VAULT_RPC_URL and VITE_VAULT_ADDRESS, never from
 * a server message. Null when the build has none (then epochs are refused unless allowUnpinned).
 */
export function pinnedChainView({ rpcUrl, vault, fetch } = {}) {
  if (!rpcUrl || !vault) return null;
  return createRpcChainView({ rpcUrl, vault, ...(fetch ? { fetch } : {}) });
}

/**
 * @param {object} options
 *   storage        localStorage-like, synchronous (the signer's records live there)
 *   send           (message) => boolean: the socket
 *   onState        (tableId, uiState) => void: called whenever what the UI shows may have changed
 *   chainView      { table, seat } (async); null: no chain view in this build
 *   domain         the app build's { chainId, verifyingContract }, used when a record does not carry one
 *   maxRakeBps     the app build's ceiling (default the contract's 500); a server value may only lower it
 *   allowUnpinned  dev only: accept a table's first epoch without a chain view, with a lasting warning
 *   locks          navigator.locks or a fake; null: a storage lease decides which tab signs
 *   channel        a BroadcastChannel or a fake: tells other tabs that a record changed
 *   persist        () => void: asks the browser to keep this site's storage (once)
 *   now, newKey    injectable for tests
 */
export function createVaultController({
  storage,
  send,
  onState = () => {},
  chainView = null,
  domain = null,
  maxRakeBps = RAKE_BPS_CEILING,
  allowUnpinned = false,
  locks = globalThis.navigator?.locks ?? null,
  channel = null,
  persist = () => globalThis.navigator?.storage?.persist?.(),
  now = () => Date.now(),
  timers = globalThis,
  timeoutMs = 8_000,
  leaseMs = 15_000,
  tabId = tabIdentity(),
  newKey,
} = {}) {
  if (typeof send !== 'function') throw new TypeError('send is required');
  const view = chainView ? withTimeout(chainView, { ms: timeoutMs, timers }) : null;
  const signer = createSigner({ storage, chainView: view, ...(newKey ? { newKey } : {}), now });
  const tables = new Map(); // game table id -> entry
  let playerId = null;
  let persisted = false;
  let queue = Promise.resolve();
  let closed = false;

  const entryFor = (tableId) => {
    let entry = tables.get(tableId);
    if (!entry) {
      entry = {
        tableId,
        tableKey: null,
        summary: null, // TableSummary.vault from the lobby
        ledger: null, // made once this device's record (and so its unit) is known
        recent: [], // the last table messages, replayed into the ledger when it is made
        pending: null, // the newest signreq not answered yet
        waiting: null, // why it is not answered yet
        refused: null, // the last proposal refused: { rule, detail }
        epochProblem: null, // the last epoch refused: { rule, detail }
        filling: false,
        head: null, // the newest nonce the server said the table is at (TableState.vault.nonce)
        lock: null, // Promise<boolean> while a Web Lock is being taken
        locked: false,
        release: null,
      };
      tables.set(tableId, entry);
    }
    return entry;
  };

  const record = (tableKey) => {
    if (!tableKey) return null;
    const restored = signer.restore(tableKey);
    return restored.ok ? restored.record : null;
  };

  function uiState(entry) {
    const rec = record(entry.tableKey);
    const failure = entry.tableKey ? signer.failure(entry.tableKey) : null;
    return {
      tableKey: entry.tableKey,
      hasKey: rec !== null,
      epoch: rec?.pinned?.epoch ?? null,
      signedNonce: rec?.last ? String(rec.last.nonce) : null,
      bundleNonce: rec?.bundle ? String(rec.bundle.state.nonce) : null,
      failure: failure && {
        kind: failure.kind,
        rule: failure.rule,
        detail: failure.detail,
        blocking: failure.blocking,
      },
      unpinned: rec?.pinned?.unpinned === true,
      keyLost: failure?.kinds.includes('lost-key') === true,
      noChainView: view === null && !allowUnpinned,
      waiting: entry.waiting,
      refused: entry.refused,
      epochProblem: entry.epochProblem,
      filling: entry.filling,
    };
  }

  const changed = (entry) => {
    try {
      onState(entry.tableId, uiState(entry));
    } catch {
      // the UI's problem, never the signer's
    }
  };

  const announce = (entry) => {
    try {
      channel?.postMessage({ t: 'vault-record', tableKey: entry.tableKey });
    } catch {
      // another tab will see the record on its next read anyway
    }
  };

  // ---- which tab signs ----------------------------------------------------------------------------

  // 'held' | 'other' (another tab's lease is still running) | 'storage' (the lease cannot be read or written)
  function lease(entry) {
    const key = LEASE_PREFIX + entry.tableKey;
    try {
      const raw = storage.getItem(key);
      const held = raw ? JSON.parse(raw) : null;
      const t = now();
      if (held && held.tab !== tabId && Number(held.until) > t) return 'other';
      const mine = JSON.stringify({ tab: tabId, until: t + leaseMs });
      storage.setItem(key, mine);
      return storage.getItem(key) === mine ? 'held' : 'storage';
    } catch {
      return 'storage';
    }
  }

  // 'held' | 'other' | 'storage'
  async function holdLock(entry) {
    if (!locks?.request) return lease(entry);
    if (entry.locked) return 'held';
    entry.lock ??= new Promise((resolve) => {
      try {
        Promise.resolve(
          locks.request(`pgg.vault.${entry.tableKey}`, { ifAvailable: true }, (lock) => {
            if (!lock) {
              resolve(false);
              return undefined;
            }
            resolve(true);
            // held until close(): the lock is released when this promise settles
            return new Promise((release) => {
              entry.release = release;
            });
          }),
        ).catch(() => resolve(false));
      } catch {
        resolve(false);
      }
    });
    entry.locked = await entry.lock;
    if (!entry.locked) entry.lock = null; // another tab holds it: ask again next time
    return entry.locked ? 'held' : 'other';
  }

  // ---- the work ----------------------------------------------------------------------------------

  function epochContext(entry, rec) {
    const pinned = rec.domain ?? domain;
    if (!rec.wallet || !pinned || rec.unit === null) return null;
    const serverCap = entry.summary?.maxRakeBps;
    return {
      wallet: rec.wallet,
      domain: pinned,
      unit: rec.unit,
      // the server's figure may only make the check stricter
      maxRakeBps: Number.isInteger(serverCap) ? Math.min(maxRakeBps, serverCap) : maxRakeBps,
      allowUnpinned,
      tableKey: entry.tableKey,
    };
  }

  async function onEpoch(entry, message) {
    const key = String(message.state?.tableId ?? '').toLowerCase();
    if (entry.summary && entry.summary.tableKey.toLowerCase() !== key) {
      entry.epochProblem = {
        rule: 'TABLE',
        detail: 'the epoch is for another table than the lobby lists',
      };
      return;
    }
    entry.tableKey ??= key;
    const rec = record(entry.tableKey);
    const ctx = rec ? epochContext(entry, rec) : null;
    if (!ctx) {
      entry.epochProblem = {
        rule: 'NO-KEY',
        detail: 'this device holds no usable key for this table',
      };
      return;
    }
    const verdict = await signer.handleEpoch(message, ctx);
    entry.filling = verdict.ok === true && verdict.filling === true;
    entry.epochProblem = verdict.ok ? null : { rule: verdict.rule, detail: verdict.detail };
    if (verdict.ok) announce(entry);
  }

  async function trySign(entry) {
    if (!entry.pending) return;
    if (!entry.tableKey) entry.tableKey = String(entry.pending.state?.tableId ?? '').toLowerCase();
    if (!record(entry.tableKey)) {
      // nothing to sign with on this device: no lock, no lease, no write
      entry.pending = null;
      entry.waiting = null;
      entry.refused = { rule: 'NO-KEY', detail: 'this device holds no key for this table' };
      return;
    }
    const lock = await holdLock(entry);
    if (lock !== 'held') {
      // kept: answered once the other tab lets go, or storage works again
      entry.waiting = lock === 'other' ? 'other-tab' : 'storage';
      return;
    }
    const answer = signer.handleSignReq(entry.pending, {
      ledger: entry.ledger,
      tableKey: entry.tableKey,
    });
    if (answer.action === 'wait') {
      entry.waiting = answer.reason;
      return;
    }
    entry.pending = null;
    entry.waiting = null;
    if (answer.action === 'send') {
      entry.refused = null;
      announce(entry);
      send({ t: CLIENT.SIGN, nonce: String(answer.nonce), digest: answer.digest, sig: answer.sig });
    } else {
      entry.refused = { rule: answer.rule, detail: answer.detail };
    }
  }

  async function process(message) {
    if (closed || !message || typeof message !== 'object') return;
    switch (message.t) {
      case SERVER.TABLE: {
        if (!message.state?.vault && !tables.has(message.tableId)) return;
        const entry = entryFor(message.tableId);
        entry.recent = [...entry.recent, message].slice(-RECENT_TABLES);
        if (ensureLedger(entry)) entry.ledger.observeTable(message);
        if (message.state?.vault?.nonce !== undefined) entry.head = message.state.vault.nonce;
        await trySign(entry);
        changed(entry);
        return;
      }
      case SERVER.EPOCH: {
        const entry = entryFor(message.tableId);
        await onEpoch(entry, message);
        ensureLedger(entry);
        await trySign(entry);
        changed(entry);
        return;
      }
      case SERVER.SIGN_REQ: {
        const entry = entryFor(message.tableId);
        entry.pending = message;
        entry.tableKey ??= String(message.state?.tableId ?? '').toLowerCase();
        ensureLedger(entry);
        await trySign(entry);
        changed(entry);
        return;
      }
      case SERVER.BUNDLE: {
        const entry = entryFor(message.tableId);
        entry.tableKey ??= String(message.state?.tableId ?? '').toLowerCase();
        const stored = signer.acceptBundle(message, { tableKey: entry.tableKey });
        if (stored.stored) announce(entry);
        changed(entry);
        return;
      }
      case SERVER.UNSEATED: {
        // the chips left the table; the key and the bundle stay until the chain says the table is done
        const entry = tables.get(message.tableId);
        if (entry) changed(entry);
        return;
      }
      default:
    }
  }

  // The ledger counts in the unit of this device's record, the one every money check uses: never a guess. It is
  // made once that record is known, and catches up on the table messages seen before.
  function ensureLedger(entry) {
    if (entry.ledger) return true;
    const unit = record(entry.tableKey)?.unit;
    if (!unit) return false;
    entry.ledger = createLedger({ unit, tableId: entry.tableId });
    for (const message of entry.recent) entry.ledger.observeTable(message);
    return true;
  }

  // Ask the other tabs' controllers to refresh what they show.
  try {
    channel?.addEventListener?.('message', (event) => {
      const key = event?.data?.tableKey;
      for (const entry of tables.values()) if (entry.tableKey === key) changed(entry);
    });
  } catch {
    // no channel: one tab
  }

  return {
    /** The player id the server gave this session, and the lobby (TableSummary list) with the vault tables. */
    setContext({ playerId: id, tables: summaries = [] } = {}) {
      if (typeof id === 'string') playerId = id;
      for (const summary of summaries) {
        if (!summary?.vault?.tableKey) continue;
        const entry = entryFor(summary.id);
        entry.summary = summary.vault;
        entry.tableKey = summary.vault.tableKey.toLowerCase();
      }
    },

    /**
     * Claim every vault table this device holds a key for (call after each welcome). Returns how many claims
     * went out. The claim proves the seat with the session key; it never moves funds.
     */
    claimAll() {
      if (closed || playerId === null) return 0;
      let sent = 0;
      for (const entry of tables.values()) {
        const rec = record(entry.tableKey);
        if (!rec?.wallet) continue;
        if (!persisted) {
          persisted = true;
          try {
            Promise.resolve(persist?.()).catch(() => {});
          } catch {
            // best effort: some browsers ask the user, some refuse
          }
        }
        const claim = signer.signClaim(entry.tableKey, {
          playerId,
          ...(rec.domain ? {} : { domain }),
          wallet: rec.wallet,
        });
        if (!claim.ok) continue;
        if (
          send({ t: CLIENT.CLAIM, tableId: entry.tableId, address: rec.wallet, sig: claim.sig })
        ) {
          sent += 1;
        }
        changed(entry);
      }
      return sent;
    },

    /** A server message (any type; the ones that are not for a vault table are ignored). Resolves when done. */
    handle(message) {
      queue = queue.then(() => process(message)).catch(() => {});
      return queue;
    },

    /** The player pressed Leave at this table: from now on a final that keeps them is refused (rule C2). */
    noteLeave(tableId) {
      const entry = tables.get(tableId);
      if (!entry?.tableKey || !record(entry.tableKey)) return { ok: false, reason: 'no-key' };
      const head = entry.head === null || entry.head === undefined ? null : String(entry.head);
      const noted = signer.noteLeave(entry.tableKey, head);
      changed(entry);
      return noted;
    },

    /** What the UI shows for this table, or null when it is not a vault table this controller knows. */
    state(tableId) {
      const entry = tables.get(tableId);
      return entry ? uiState(entry) : null;
    },

    /** Resolves once every message handed in so far has been handled. */
    settled: () => queue,

    close() {
      closed = true;
      for (const entry of tables.values()) {
        entry.release?.();
        entry.release = null;
        entry.locked = false;
      }
      try {
        channel?.close?.();
      } catch {
        // already closed
      }
    },
  };
}
