'use client';

import { useSyncExternalStore } from 'react';

/** CSS variable carrying the presenter strip's height in pixels, so `main` and the toasts can keep clear of it. */
export const PRESENTER_HEIGHT_VAR = '--cg-presenter-height';

/** The height assumed until the strip has measured itself. */
export const PRESENTER_HEIGHT_FALLBACK_PX = 104;

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  return () => observer.disconnect();
}

function read(): number {
  const value = Number.parseFloat(
    document.documentElement.style.getPropertyValue(PRESENTER_HEIGHT_VAR),
  );
  return Number.isFinite(value) ? value : PRESENTER_HEIGHT_FALLBACK_PX;
}

/** The presenter strip's current height while presenting (it publishes it), and 0 when not presenting. */
export function usePresenterHeight(presenting: boolean): number {
  const height = useSyncExternalStore(subscribe, read, () => PRESENTER_HEIGHT_FALLBACK_PX);
  return presenting ? height : 0;
}
