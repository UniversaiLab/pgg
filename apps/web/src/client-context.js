import { createContext, useContext } from 'react';
import { useStore } from './lib/store.js';

export const ClientContext = createContext(null);

export const useClient = () => useContext(ClientContext);

/** Read the whole game state; the components below re-render when it changes. */
export function useGame(select) {
  const client = useClient();
  return useStore(client.store, select);
}
