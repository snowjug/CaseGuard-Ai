'use client';

import { useCallback, useRef, useState } from 'react';

/**
 * Where focus goes when the element that opened an overlay is gone by the time the overlay closes: a menu item
 * disappears together with its menu, so the account button (the menu's own trigger) is the logical place, then the page.
 */
const FALLBACK_SELECTORS = ['button[title="Account and settings"]', '#main-content'] as const;

function focusAfterClose(opener: HTMLElement): void {
  // Wait for the dialog to unmount so Fluent's focus trap cannot take the focus back.
  window.setTimeout(() => {
    if (opener.isConnected) {
      opener.focus();
      return;
    }
    for (const selector of FALLBACK_SELECTORS) {
      const fallback = document.querySelector<HTMLElement>(selector);
      if (fallback) {
        fallback.focus();
        return;
      }
    }
  }, 0);
}

/**
 * Open state of one overlay that returns focus to whatever had it when the overlay opened (the button that was
 * clicked, or the element that was focused when a shortcut fired). Fluent only restores focus for triggers it renders,
 * and a controlled dialog has none. When the opener has gone (a menu item), focus goes to the account button, so a
 * keyboard user is never left on the page body.
 */
export function useOverlayState(): readonly [boolean, (open: boolean) => void] {
  const [open, setOpenState] = useState(false);
  const isOpen = useRef(false);
  const opener = useRef<HTMLElement | null>(null);
  const setOpen = useCallback((next: boolean) => {
    if (next === isOpen.current) return;
    isOpen.current = next;
    if (next) {
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
    } else {
      const target = opener.current;
      opener.current = null;
      if (target) focusAfterClose(target);
    }
    setOpenState(next);
  }, []);
  return [open, setOpen] as const;
}
