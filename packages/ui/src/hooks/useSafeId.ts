'use client';

import { useId } from 'react';

/** `useId()` stripped to characters that are safe in `url(#id)` references and CSS selectors. */
export function useSafeId(prefix = 'cg'): string {
  const raw = useId();
  return `${prefix}-${raw.replace(/[^a-zA-Z0-9_-]/g, '')}`;
}
