import { useSyncExternalStore } from 'react';

const subscribe = (): (() => void) => () => undefined;
const detectMac = (): boolean =>
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

/** True on Apple platforms, where the modifier is Cmd rather than Ctrl. The server and the first paint say false. */
export function useIsMac(): boolean {
  return useSyncExternalStore(subscribe, detectMac, () => false);
}
