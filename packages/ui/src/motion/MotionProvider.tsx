'use client';

import { MotionConfig } from 'motion/react';
import type { ReactNode } from 'react';
import { motion } from '../tokens/static';
import { useMotionEnabled } from './useMotionEnabled';

/**
 * App-wide defaults for every Motion animation: the shared duration and ease-out, and no transform or layout animation
 * at all while reduced motion is on. Mounted once by `CaseGuardThemeProvider`.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  const enabled = useMotionEnabled();
  return (
    <MotionConfig
      reducedMotion={enabled ? 'never' : 'always'}
      transition={{ duration: motion.base / 1000, ease: motion.curve }}
    >
      {children}
    </MotionConfig>
  );
}
