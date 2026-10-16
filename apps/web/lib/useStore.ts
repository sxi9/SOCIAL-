'use client';

import { useSyncExternalStore } from 'react';
import { getVersion, state, subscribe, type AppState } from './store';

const getServerVersion = () => 0;

/** Re-renders on every store change; components read fields off the state. */
export function useAppState(): AppState {
  useSyncExternalStore(subscribe, getVersion, getServerVersion);
  return state;
}
