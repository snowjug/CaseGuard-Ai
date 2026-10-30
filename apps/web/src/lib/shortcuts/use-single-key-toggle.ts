'use client';

import { useCallback, useMemo } from 'react';
import { useToast } from '../toast';
import { useSingleKeyShortcuts } from './index';

export interface SingleKeyToggle {
  enabled: boolean;
  /** Turns the shortcuts on or off and says so in a toast: for a screen reader the change is otherwise silent. */
  set: (enabled: boolean) => void;
  toggle: () => void;
}

/** The "single-key shortcuts" setting with its announcement, for the shortcut help and the command palette. */
export function useSingleKeyToggle(): SingleKeyToggle {
  const { enabled, setEnabled } = useSingleKeyShortcuts();
  const toast = useToast();
  const set = useCallback(
    (next: boolean) => {
      setEnabled(next);
      if (next)
        toast.info('Single-key shortcuts are on', {
          body: 'Shortcuts such as / and G then C work again.',
        });
      else
        toast.info('Single-key shortcuts are off', {
          body: 'Only shortcuts that use Ctrl or Cmd work. Turn them back on in the keyboard shortcuts help or the command palette.',
        });
    },
    [setEnabled, toast],
  );
  const toggle = useCallback(() => set(!enabled), [set, enabled]);
  return useMemo(() => ({ enabled, set, toggle }), [enabled, set, toggle]);
}
