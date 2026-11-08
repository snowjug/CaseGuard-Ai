'use client';

import { useReducedMotion } from '../theme/motion';

/**
 * False when animation must not run: the OS asks for reduced motion (and the user has not allowed it in settings), or the
 * user switched reduced motion on. Components then render their final state at once.
 */
export function useMotionEnabled(): boolean {
  return !useReducedMotion();
}
