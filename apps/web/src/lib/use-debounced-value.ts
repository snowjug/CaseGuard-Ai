'use client';

import { useEffect, useState } from 'react';

/** Returns `value` after it has been stable for `delayMs` (the update happens in a timer callback, never in render). */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
