'use client';

import { useEffect, useState } from 'react';

/**
 * A countdown in whole seconds for a server-requested delay (`Retry-After`). `set(seconds)` starts it; it ticks down by
 * itself, stops at zero and stops when the component unmounts.
 */
export function useRetryCountdown(
  initialSeconds = 0,
): readonly [number, (seconds: number) => void] {
  const [remaining, setRemaining] = useState(initialSeconds);
  const active = remaining > 0;
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setRemaining((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return [remaining, setRemaining] as const;
}
