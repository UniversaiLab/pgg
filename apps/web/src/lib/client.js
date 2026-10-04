// The controller: owns the socket, turns server messages into state (via the pure reducer) and
// performs the side effects that follow them. The UI only reads the store and calls these actions.

import { CLIENT, SERVER } from '@pgg/protocol/constants';
import { devLogin } from './api.js';
import {
  addToast,
  applyServerMessage,
  dismissToast,
  errorText,
  initialState,
  isHeroTurn,
  markProof,
} from './game.js';
import { buzz } from './haptics.js';
import { GameSocket } from './socket.js';
import { createStore } from './store.js';

const TOKEN_KEY = 'pgg.token';

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
} = {}) {
  let token = null;
  let socket = null;
  const seedsSent = new Set(); // `${tableId}:${handNo}`
  let syncRequestedAt = -1;

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

  function onMessage(message) {
    const before = store.get();
    const after = applyServerMessage(before, message);
    store.set(after);

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

    logout() {
      socket?.close();
      write(TOKEN_KEY, null);
      token = null;
      seedsSent.clear();
      store.set({ ...initialState, phase: 'login' });
    },

    join: (tableId, buyIn) => send({ t: CLIENT.JOIN, tableId, buyIn }),
    leave: () => send({ t: CLIENT.LEAVE }),
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
