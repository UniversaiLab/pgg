// The controller: owns the socket, turns server messages into state (via the pure reducer) and
// performs the side effects that follow them. The UI only reads the store and calls these actions.

import { CLIENT, ERR, SERVER } from '@pgg/protocol/constants';
import { devLogin, siweNonce, siweVerify } from './api.js';
import {
  addToast,
  applyServerMessage,
  dismissToast,
  errorText,
  initialState,
  isHeroTurn,
  markProof,
  setVault,
} from './game.js';
import { buzz } from './haptics.js';
import { GameSocket } from './socket.js';
import { createStore } from './store.js';

const TOKEN_KEY = 'pgg.token';
// @pgg/vault's RECORD_PREFIX, repeated here so the eager bundle never imports the vault library (a test keeps
// the two equal)
export const VAULT_RECORD_PREFIX = 'pgg.vault.v1.';
const VAULT_MESSAGES = new Set([SERVER.EPOCH, SERVER.SIGN_REQ, SERVER.BUNDLE]);

/** The vault part of the app build: never taken from a server message. */
export function buildVaultConfig(env = import.meta.env ?? {}) {
  const chainId = Number(env.VITE_VAULT_CHAIN_ID);
  const vault = env.VITE_VAULT_ADDRESS;
  return {
    rpcUrl: env.VITE_VAULT_RPC_URL || null,
    domain:
      Number.isSafeInteger(chainId) && chainId > 0 && /^0x[0-9a-fA-F]{40}$/.test(vault ?? '')
        ? { chainId, verifyingContract: vault.toLowerCase() }
        : null,
    allowUnpinned: env.VITE_VAULT_ALLOW_UNPINNED === '1',
  };
}

const randomSeed = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

export function createClient({
  store = createStore(initialState),
  storage = globalThis.localStorage,
  login = devLogin,
  wsUrl = () => {
    const base = new URL('/ws', globalThis.location.href);
    base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    return base.href;
  },
  SocketImpl = GameSocket,
  seed = randomSeed,
  verify = verifyLazily,
  loadVault = () => import('./vault.js'),
  loadWallet = () => import('./wallet.js'),
  provider = () => globalThis.ethereum,
  vaultConfig = buildVaultConfig(),
  vaultOptions = {}, // extra createVaultController options (tests: chainView, locks, ...)
  timers = globalThis,
  claimRetryMs = 5_000,
} = {}) {
  let token = null;
  let socket = null;
  const seedsSent = new Set(); // `${tableId}:${handNo}`
  let syncRequestedAt = -1;

  // The vault controller is loaded only for vault tables: a play-money session never imports it, never reads
  // its records and never logs (vault-inert.test.js).
  let vault = null;
  let vaultLoad = null;
  const vaultBacklog = []; // messages that arrived while it loaded, in order
  let vaultContext = null; // { playerId, tables }
  let claimRetry = null;

  const read = (key) => {
    try {
      return storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  };
  const write = (key, value) => {
    try {
      if (value === null) storage?.removeItem(key);
      else storage?.setItem(key, value);
    } catch {
      // private mode or a full disk: the player just has to log in again next time
    }
  };

  const setConnection = (connection) => store.set((state) => ({ ...state, connection }));

  function ensureVault() {
    vaultLoad ??= Promise.resolve()
      .then(loadVault)
      .then((mod) => {
        vault = mod.createVaultController({
          storage,
          send,
          onState: (tableId, ui) => store.set((state) => setVault(state, tableId, ui)),
          chainView: mod.pinnedChainView({
            rpcUrl: vaultConfig.rpcUrl,
            vault: vaultConfig.domain?.verifyingContract,
          }),
          domain: vaultConfig.domain,
          allowUnpinned: vaultConfig.allowUnpinned,
          ...vaultOptions,
        });
        if (vaultContext) vault.setContext(vaultContext);
        if (vaultContext?.claim) vault.claimAll();
        for (const message of vaultBacklog.splice(0)) vault.handle(message);
        return vault;
      })
      .catch(() => {
        // a failed chunk load (offline): try again on the next vault message
        vaultLoad = null;
        store.set((state) => addToast(state, 'Could not load the table signer', 'error'));
      });
    return vaultLoad;
  }

  function toVault(message) {
    if (vault) vault.handle(message);
    else {
      vaultBacklog.push(message);
      ensureVault();
    }
  }

  // A vault table in the lobby that this device holds a key for: claim it (the server keeps no binding of
  // ours across its restarts, so every welcome re-claims).
  const holdsVaultKey = (tables) =>
    tables.some(
      (t) => t?.vault?.tableKey && read(VAULT_RECORD_PREFIX + t.vault.tableKey.toLowerCase()),
    );

  function onVaultLobby(message, welcome) {
    const tables = message.tables ?? [];
    if (!tables.some((t) => t?.vault)) return;
    vaultContext = { ...(vaultContext ?? {}), tables };
    if (welcome) vaultContext.playerId = message.player.id;
    if (vault) {
      vault.setContext(vaultContext);
      if (welcome) vault.claimAll();
    } else if (welcome && holdsVaultKey(tables)) {
      vaultContext.claim = true;
      ensureVault();
    }
  }

  function onMessage(message) {
    const before = store.get();
    const after = applyServerMessage(before, message);
    store.set(after);

    if (message.t === SERVER.WELCOME || message.t === SERVER.LOBBY) {
      onVaultLobby(message, message.t === SERVER.WELCOME);
    }
    if (
      VAULT_MESSAGES.has(message.t) ||
      (message.t === SERVER.TABLE && (message.state?.vault || vault)) ||
      (message.t === SERVER.UNSEATED && vault)
    ) {
      toVault(message);
    }
    if (message.t === SERVER.ERROR && message.code === ERR.CLAIM_PENDING && vault && !claimRetry) {
      // the deposit is not deep enough yet: ask again shortly
      claimRetry = timers.setTimeout(() => {
        claimRetry = null;
        vault?.claimAll();
      }, claimRetryMs);
    }

    if (message.t === SERVER.TABLE) {
      // A gap in `seq` means we missed a message (for example around a reconnect): ask for a resync.
      const gap = before.seq > 0 && message.seq > before.seq + 1;
      if (gap && syncRequestedAt !== message.seq) {
        syncRequestedAt = message.seq;
        socket.send({ t: CLIENT.SYNC });
      }
      contributeSeed(after);
      if (isHeroTurn(after) && !isHeroTurn(before)) buzz([18, 40, 18]);
    }
    if (message.t === SERVER.PROOF) {
      Promise.resolve(verify(message.proof)).then((ok) =>
        store.set((state) => markProof(state, message.handNo, ok)),
      );
    }
    if (message.t === SERVER.ERROR && message.code === 'rate-limited') buzz(30);
    // a vault seat was paid out on chain: show the new wallet balance (and anything parked to withdraw)
    if (message.t === SERVER.UNSEATED && wallet?.address) refreshWallet().catch(() => null);
  }

  // The server commits to the next hand while the current one is being played; answering with a
  // seed of our own means it cannot have chosen its seed to suit us.
  function contributeSeed(state) {
    const next = state.table?.fairness.next;
    if (!next || state.seat === null) return;
    const key = `${state.tableId}:${next.handNo}`;
    if (seedsSent.has(key)) return;
    if (socket.send({ t: CLIENT.SEED, handNo: next.handNo, seed: seed() })) seedsSent.add(key);
  }

  function startSocket() {
    socket?.close();
    socket = new SocketImpl({
      url: () => `${wsUrl()}?token=${encodeURIComponent(token)}`,
      onMessage,
      onStatus: (status) => {
        setConnection(status);
        if (status === 'unauthorized') {
          write(TOKEN_KEY, null);
          store.set((state) => ({ ...state, phase: 'login', me: null }));
        }
      },
    });
    socket.connect();
  }

  const send = (message) => socket?.send(message) ?? false;

  // ---- the cashier: the player's own wallet -------------------------------------------------------------
  // Lazy like the vault controller. Money only moves in transactions the player confirms in their wallet.

  let wallet = null;
  const setCashier = (patch) =>
    store.set((state) => ({
      ...state,
      cashier: patch === null ? null : { ...state.cashier, ...patch },
    }));
  const setWallet = (patch) =>
    store.set((state) => ({ ...state, wallet: { ...(state.wallet ?? {}), ...patch } }));

  async function walletReady() {
    if (wallet) return wallet;
    if (!vaultConfig.domain)
      throw Object.assign(new Error('This app build has no vault configured'), {
        code: 'no-vault',
      });
    const mod = await loadWallet();
    wallet = mod.createWallet({
      provider: provider(),
      chainId: vaultConfig.domain.chainId,
      rpcUrl: vaultConfig.rpcUrl,
      vault: vaultConfig.domain.verifyingContract,
    });
    return wallet;
  }

  async function refreshWallet() {
    if (!wallet?.address) return null;
    const b = await wallet.balances();
    setWallet({
      address: wallet.address,
      symbol: b.token.symbol,
      decimals: b.token.decimals,
      balance: b.balance.toString(),
      withdrawable: b.withdrawable.toString(),
    });
    return b;
  }

  const fail = (error) => {
    const text = error?.message ?? String(error);
    setCashier({ step: 'error', error: text });
    return { ok: false, error: text, code: error?.code ?? 'error' };
  };

  return {
    store,
    get socket() {
      return socket;
    },

    /** Resume a saved session if there is one, otherwise show the login screen. */
    async boot() {
      const saved = read(TOKEN_KEY);
      if (!saved) {
        store.set((state) => ({ ...state, phase: 'login' }));
        return;
      }
      try {
        const body = await login({ token: saved });
        token = body.token;
        startSocket();
      } catch {
        write(TOKEN_KEY, null);
        store.set((state) => ({ ...state, phase: 'login' }));
      }
    },

    async login(name) {
      const body = await login({ name });
      token = body.token;
      write(TOKEN_KEY, token);
      startSocket();
    },

    /** Sign in with the wallet (EIP-4361): the account is the wallet, and only its own seats can be claimed. */
    async loginWithWallet(name) {
      const w = await walletReady();
      await w.connect();
      const mod = await loadWallet();
      const nonce = await siweNonce();
      const message = mod.siweMessage({
        domain: globalThis.location.host,
        address: w.address, // any case recovers to the same signer; the server compares lowercase
        uri: globalThis.location.origin,
        chainId: vaultConfig.domain.chainId,
        nonce,
      });
      const signature = await w.signMessage(message);
      const body = await siweVerify({ message, signature, name: name || undefined });
      token = body.token;
      write(TOKEN_KEY, token);
      await refreshWallet().catch(() => null);
      startSocket();
    },

    /** Wallet sign-in is offered when this build has a vault and the browser has a wallet. */
    walletSignInAvailable: () => Boolean(vaultConfig.domain && provider()?.request),

    logout() {
      socket?.close();
      write(TOKEN_KEY, null);
      token = null;
      seedsSent.clear();
      // the vault records stay on this device: they hold keys to money at a table, not a login
      vault?.close();
      vault = null;
      vaultLoad = null;
      vaultContext = null;
      if (claimRetry !== null) timers.clearTimeout(claimRetry);
      claimRetry = null;
      wallet = null;
      store.set({ ...initialState, phase: 'login' });
    },

    /** Resolves once the vault controller (if loaded) has handled every message so far. For tests. */
    vaultSettled: async () => {
      await vaultLoad;
      await vault?.settled();
    },

    join: (tableId, buyIn) => send({ t: CLIENT.JOIN, tableId, buyIn }),

    /** Is there a wallet in this browser at all (window.ethereum)? */
    walletAvailable: () => Boolean(provider()?.request),

    /** Connect the player's wallet on the table's chain and read the token balances. */
    async connectWallet() {
      try {
        setCashier({ step: 'connecting', error: null });
        const w = await walletReady();
        await w.connect();
        await refreshWallet();
        setCashier({ step: 'idle' });
        return { ok: true, address: w.address };
      } catch (error) {
        return fail(error);
      }
    },

    refreshWallet: () => refreshWallet().catch(() => null),

    /**
     * Put `chips` on a vault table from the wallet: make the table's session key (stored before anything
     * names it on chain), approve if needed, deposit, then claim the seat. Steps show in state.cashier.
     */
    async deposit(tableId, chips) {
      try {
        const w = await walletReady();
        if (!w.address) await w.connect();
        const v = await ensureVault();
        if (!v) throw new Error('Could not load the table signer');
        const prepared = v.prepareDeposit(tableId, { wallet: w.address });
        if (!prepared.ok) throw new Error(prepared.detail ?? 'Could not make a key for this table');
        const amount = BigInt(chips) * prepared.unit;
        setCashier({ tableId, step: 'approve', error: null });
        await w.deposit({
          tableKey: prepared.tableKey,
          amount,
          sessionKey: prepared.sessionKey,
          onStep: (step) => setCashier({ step }),
        });
        setCashier({ step: 'claiming' });
        vaultContext = { ...(vaultContext ?? {}), claim: true };
        v.claimAll();
        await refreshWallet();
        setCashier({ step: 'done' });
        return { ok: true };
      } catch (error) {
        return fail(error);
      }
    },

    /** Test chains only: mint MockToken to the connected wallet. */
    async mintTestTokens(amount) {
      try {
        const w = await walletReady();
        if (!w.address) await w.connect();
        setCashier({ step: 'minting', error: null });
        await w.mintTestTokens(BigInt(amount));
        await refreshWallet();
        setCashier({ step: 'idle' });
        return { ok: true };
      } catch (error) {
        return fail(error);
      }
    },

    /**
     * Leave a vault table and get the money back, without the server if need be:
     *   Filling   leave(): the deposit comes straight back
     *   Active    startExit from the newest all-signed state this device holds (or from the deposits when
     *             none was signed this epoch); after the exit window anyone, the server included, pays it out
     *   Exiting   finalizeExit once the window has passed (the server normally does this itself)
     */
    async exitVault(tableId) {
      try {
        const w = await walletReady();
        if (!w.address) await w.connect();
        const v = await ensureVault();
        const info = v?.exitInfo(tableId);
        if (!info) throw new Error('This device holds no seat at that table');
        const mod = await loadVault();
        const view = mod.pinnedChainView({
          rpcUrl: vaultConfig.rpcUrl,
          vault: vaultConfig.domain.verifyingContract,
        });
        const read = view ? await view.table(info.tableKey) : { ok: false };
        const row = read.ok ? read.table : null;
        const status = row ? Number(row.status) : null;
        setCashier({ tableId, step: 'exiting', error: null });
        if (status === 1) {
          await w.leave(info.tableKey);
        } else if (status === 2) {
          if (info.bundle) await w.startExit(info.bundle);
          else if (info.roster) await w.startExitFromDeposits(info.tableKey, info.roster);
          else throw new Error('No signed state on this device to exit from');
        } else if (status === 3) {
          const now = Math.floor(Date.now() / 1000);
          if (now <= Number(row.exitDeadline)) {
            setCashier({ step: 'exit-pending', deadline: Number(row.exitDeadline) });
            return { ok: true, pending: true, deadline: Number(row.exitDeadline) };
          }
          if (!info.bundle) throw new Error('The server will pay this exit out');
          await w.finalizeExit(info.bundle.state);
        } else {
          throw new Error('The table has already paid out');
        }
        await refreshWallet();
        setCashier({ step: 'exited' });
        return { ok: true };
      } catch (error) {
        return fail(error);
      }
    },

    /** Pull a payout the token could not push (it sits in the vault for this wallet). */
    async withdraw() {
      try {
        const w = await walletReady();
        if (!w.address) await w.connect();
        setCashier({ step: 'withdrawing', error: null });
        await w.withdraw();
        await refreshWallet();
        setCashier({ step: 'idle' });
        return { ok: true };
      } catch (error) {
        return fail(error);
      }
    },

    closeCashier: () => setCashier(null),
    leave() {
      // at a vault table the leave intent is recorded first: from now on a final that keeps me is refused
      const { tableId } = store.get();
      if (vault && tableId !== null) vault.noteLeave(tableId);
      return send({ t: CLIENT.LEAVE });
    },
    back: () => send({ t: CLIENT.BACK }),
    rebuy: (amount) => send({ t: CLIENT.REBUY, amount }),
    act(action, amount) {
      const { table } = store.get();
      if (!table?.handNo && table?.handNo !== 0) return false;
      return send({
        t: CLIENT.ACT,
        handNo: table.handNo,
        action,
        ...(amount === undefined ? {} : { amount }),
      });
    },

    dismissToast: (id) => store.set((state) => dismissToast(state, id)),
    toast: (text, tone = 'info') => store.set((state) => addToast(state, text, tone)),
    errorText,
  };
}

// Loaded on demand: the browser only needs the verifier once a proof arrives.
async function verifyLazily(proof) {
  const { verifyHand } = await import('@pgg/engine/fairness');
  return verifyHand(proof).ok;
}
