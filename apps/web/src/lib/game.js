// Pure game state. Everything the server tells us goes through applyServerMessage, which returns
// the next state and has no side effects, so it is easy to test and the UI is just a view of it.

import { SERVER } from '@pgg/protocol/constants';

export const MAX_EVENTS = 40;
export const MAX_PROOFS = 20;

export const initialState = Object.freeze({
  phase: 'boot', // boot | login | lobby | table
  connection: 'idle', // idle | connecting | open | reconnecting
  me: null, // { id, name }
  balance: 0,
  tables: [],
  tableId: null,
  seat: null,
  table: null, // the latest public table state
  seq: 0,
  hole: null, // { handNo, cards } for the hand in progress
  events: [], // recent table events, each with a unique `id`, newest last
  result: null, // the last hand-end result
  proofs: [], // fairness proofs received, newest first
  toasts: [], // { id, text, tone }
  nextId: 1,
});

export const addToast = (state, text, tone = 'info') => ({
  ...state,
  toasts: [...state.toasts, { id: state.nextId, text, tone }].slice(-3),
  nextId: state.nextId + 1,
});

const UNSEAT_REASONS = {
  busted: ['You ran out of chips', 'info'],
  timeout: ['You were away too long and were moved off the table', 'info'],
};

const ERROR_TEXT = {
  'not-your-turn': 'It is not your turn',
  'illegal-action': 'That action is not allowed right now',
  'bad-amount': 'That amount is not allowed',
  'stale-hand': 'That hand has already moved on',
  'insufficient-funds': 'Not enough chips for that buy-in',
  'bad-buy-in': 'That buy-in is outside the limits',
  'seat-taken': 'That seat is taken',
  'table-full': 'This table is full',
  'already-seated': 'You are already seated at a table',
  'rate-limited': 'Slow down a little',
  'rebuy-not-allowed': 'You can add chips between hands',
};

export function errorText(code) {
  return ERROR_TEXT[code] ?? 'Something went wrong';
}

/** @returns {object} the next state */
export function applyServerMessage(state, message) {
  switch (message.t) {
    case SERVER.WELCOME: {
      const seated = message.seated;
      return {
        ...state,
        me: { id: message.player.id, name: message.player.name },
        balance: message.player.balance,
        tables: message.tables,
        tableId: seated ? seated.tableId : null,
        seat: seated ? seated.seat : null,
        phase: seated ? 'table' : 'lobby',
      };
    }
    case SERVER.LOBBY:
      return { ...state, tables: message.tables };
    case SERVER.SEATED:
      return { ...state, tableId: message.tableId, seat: message.seat, phase: 'table' };
    case SERVER.UNSEATED: {
      const next = {
        ...state,
        tableId: null,
        seat: null,
        table: null,
        hole: null,
        result: null,
        events: [],
        seq: 0,
        phase: 'lobby',
      };
      const note = UNSEAT_REASONS[message.reason];
      return note ? addToast(next, note[0], note[1]) : next;
    }
    case SERVER.TABLE: {
      if (state.tableId !== null && message.tableId !== state.tableId) return state;
      const stamped = message.events.map((event, i) => ({
        ...event,
        id: state.nextId + i,
        seq: message.seq,
      }));
      const ended = stamped.findLast((event) => event.type === 'hand-end');
      const started = stamped.some((event) => event.type === 'hand-start');
      return {
        ...state,
        table: message.state,
        seq: message.seq,
        // The server sends our cards just BEFORE the hand-start update, so keep them when they
        // belong to the hand this message describes and drop them once a different hand begins.
        hole: state.hole && state.hole.handNo !== message.state.handNo ? null : state.hole,
        result: ended ? ended.result : started ? null : state.result,
        events: [...state.events, ...stamped].slice(-MAX_EVENTS),
        nextId: state.nextId + stamped.length,
      };
    }
    case SERVER.CARDS:
      return { ...state, hole: { handNo: message.handNo, cards: message.cards } };
    case SERVER.PROOF:
      return {
        ...state,
        proofs: [{ handNo: message.handNo, proof: message.proof }, ...state.proofs].slice(
          0,
          MAX_PROOFS,
        ),
      };
    case SERVER.BALANCE:
      return { ...state, balance: message.balance };
    case SERVER.ERROR:
      return addToast(state, errorText(message.code), 'error');
    default:
      return state;
  }
}

/** Record whether a fairness proof checked out. */
export function markProof(state, handNo, ok) {
  return {
    ...state,
    proofs: state.proofs.map((entry) => (entry.handNo === handNo ? { ...entry, ok } : entry)),
  };
}

export function dismissToast(state, id) {
  return { ...state, toasts: state.toasts.filter((item) => item.id !== id) };
}

// ---- selectors ---------------------------------------------------------------------------------

export const heroEntry = (state) =>
  state.table && state.seat !== null ? (state.table.seats[state.seat] ?? null) : null;

export const isHeroTurn = (state) =>
  Boolean(state.table && state.seat !== null && state.table.toAct === state.seat);

/** Seats in the order they act, starting from `seat`, that currently hold a player. */
export const occupiedSeats = (table) => table.seats.flatMap((entry) => (entry ? [entry] : []));

/** Total chips the hero would put in to call, capped by their stack. */
export const callAmount = (state) => state.table?.legal?.toCall ?? 0;
