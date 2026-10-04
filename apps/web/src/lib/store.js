// A tiny external store: no dependency, and React reads it with useSyncExternalStore.
import { useSyncExternalStore } from 'react';

export function createStore(initial) {
  let state = initial;
  const listeners = new Set();
  return {
    get: () => state,
    set(next) {
      const value = typeof next === 'function' ? next(state) : next;
      if (value === state) return;
      state = value;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Subscribe a component to one slice of a store. `select` must return a stable value. */
export function useStore(store, select = (state) => state) {
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}
