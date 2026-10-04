// The Hub owns sockets. It validates and rate-limits what arrives, routes it to the player's
// table actor, and implements the actors' `bus` on top of Bun's native pub/sub:
//   publish(topic, msg)  -> one JSON.stringify, then server.publish fans it out in native code
//   send(playerId, msg)  -> one socket (used for anything private: hole cards, proofs, errors)
// Hole cards never go through a topic.

import { ClientMessage } from '@pgg/protocol';
import { CLIENT, CLOSE, ERR, LIMITS, PROTOCOL_VERSION, SERVER } from '@pgg/protocol/constants';

const MAX_STRIKES = 8; // malformed or rate-limited messages tolerated before disconnecting
const MAX_BUFFERED_BYTES = 1_000_000; // a consumer further behind than this is dropped
const LOBBY_INTERVAL_MS = 1000;

export class Hub {
  #server = null;
  #sockets = new Map(); // playerId -> ws
  #wallet;
  #registry;
  #lobbyDirty = false;
  #lobbyTimer = null;

  constructor({ wallet, registry }) {
    this.#wallet = wallet;
    this.#registry = registry;
  }

  setServer(server) {
    this.#server = server;
    // Lobby counts change often; coalesce into at most one broadcast per interval.
    this.#lobbyTimer = setInterval(() => {
      if (!this.#lobbyDirty) return;
      this.#lobbyDirty = false;
      this.publish('lobby', { t: SERVER.LOBBY, tables: this.#registry.summaries() });
    }, LOBBY_INTERVAL_MS);
  }

  stop() {
    if (this.#lobbyTimer) clearInterval(this.#lobbyTimer);
    this.#lobbyTimer = null;
  }

  markLobbyDirty() {
    this.#lobbyDirty = true;
  }

  get connectionCount() {
    return this.#sockets.size;
  }

  // ---- bus (used by table actors) ----------------------------------------------------------

  publish(topic, message) {
    this.#server?.publish(topic, JSON.stringify(message));
  }

  send(playerId, message) {
    const ws = this.#sockets.get(playerId);
    if (!ws) return;
    if (ws.getBufferedAmount() > MAX_BUFFERED_BYTES) {
      ws.close(1013, 'slow consumer');
      return;
    }
    ws.send(JSON.stringify(message));
  }

  subscribe(playerId, topic) {
    this.#sockets.get(playerId)?.subscribe(topic);
  }

  unsubscribe(playerId, topic) {
    this.#sockets.get(playerId)?.unsubscribe(topic);
  }

  // ---- websocket handlers ------------------------------------------------------------------

  handlers = {
    open: (ws) => this.#onOpen(ws),
    message: (ws, raw) => this.#onMessage(ws, raw),
    close: (ws) => this.#onClose(ws),
  };

  #onOpen(ws) {
    const { player } = ws.data;
    const previous = this.#sockets.get(player.id);
    this.#sockets.set(player.id, ws);
    if (previous && previous !== ws)
      previous.close(CLOSE.REPLACED, 'replaced by a newer connection');

    const actor = this.#registry.tableOf(player.id);
    if (!actor) ws.subscribe('lobby'); // seated players are not looking at the lobby
    ws.send(
      JSON.stringify({
        t: SERVER.WELCOME,
        v: PROTOCOL_VERSION,
        player: { ...player, balance: this.#wallet.balance(player.id) },
        tables: this.#registry.summaries(),
        seated: actor ? { tableId: actor.id, seat: actor.seatOf(player.id) } : null,
      }),
    );
    actor?.connect(player.id);
  }

  #onClose(ws) {
    const { player } = ws.data;
    if (this.#sockets.get(player.id) !== ws) return; // already replaced by a newer socket
    this.#sockets.delete(player.id);
    this.#registry.tableOf(player.id)?.disconnect(player.id);
  }

  #strike(ws, code, msg) {
    this.send(ws.data.player.id, { t: SERVER.ERROR, code, msg });
    ws.data.strikes += 1;
    if (ws.data.strikes >= MAX_STRIKES) ws.close(CLOSE.RATE_LIMITED, 'too many bad messages');
  }

  #onMessage(ws, raw) {
    if (!ws.data.bucket.take()) return this.#strike(ws, ERR.RATE_LIMITED, 'slow down');
    if (typeof raw !== 'string' || raw.length > LIMITS.maxMessageBytes) {
      return ws.close(CLOSE.TOO_LARGE, 'message too large');
    }
    let message;
    try {
      message = ClientMessage.parse(JSON.parse(raw));
    } catch {
      return this.#strike(ws, ERR.BAD_MESSAGE, 'malformed message');
    }
    this.#dispatch(ws.data.player, message);
  }

  #dispatch(player, message) {
    const id = player.id;
    const refuse = (result, ref) => {
      if (!result.ok) this.send(id, { t: SERVER.ERROR, code: result.code, msg: result.msg, ref });
      return result.ok;
    };
    const balance = () => this.send(id, { t: SERVER.BALANCE, balance: this.#wallet.balance(id) });

    if (message.t === CLIENT.PING) {
      return this.send(id, { t: SERVER.PONG, n: message.n, now: Date.now() });
    }
    if (message.t === CLIENT.JOIN) {
      if (this.#registry.tableOf(id))
        return refuse({ ok: false, code: ERR.ALREADY_SEATED }, 'join');
      const target = this.#registry.get(message.tableId);
      if (!target) return refuse({ ok: false, code: ERR.UNKNOWN_TABLE }, 'join');
      if (refuse(target.join(player, message), 'join')) balance();
      return;
    }

    // Everything else acts on the table the player is already sitting at. The client never names
    // a table, so it cannot act on someone else's.
    const actor = this.#registry.tableOf(id);
    if (!actor) return refuse({ ok: false, code: ERR.NOT_SEATED }, message.t);
    switch (message.t) {
      case CLIENT.LEAVE:
        refuse(actor.leave(id), 'leave');
        return balance();
      case CLIENT.ACT:
        return void refuse(actor.act(id, message), 'act');
      case CLIENT.SEED:
        return void refuse(actor.submitSeed(id, message), 'seed');
      case CLIENT.REBUY:
        if (refuse(actor.rebuy(id, message.amount), 'rebuy')) balance();
        return;
      case CLIENT.BACK:
        return void refuse(actor.back(id), 'back');
      case CLIENT.SYNC:
        return void refuse(actor.sync(id), 'sync');
    }
  }
}
