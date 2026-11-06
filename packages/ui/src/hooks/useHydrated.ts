'use client';

import { useSyncExternalStore } from 'react';

const subscribe = (): (() => void) => () => undefined;
const onClient = (): boolean => true;
const onServer = (): boolean => false;

/**
 * False on the server and during the hydration render, true from the first client render after it. Anything the server
 * cannot know (a dialog that a link opens, who is signed in) waits for it, so the HTML and the first client render match.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, onClient, onServer);
}
