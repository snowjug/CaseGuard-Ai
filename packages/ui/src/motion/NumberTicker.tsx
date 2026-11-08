'use client';

import { animate } from 'motion/react';
import { useLayoutEffect, useRef } from 'react';
import { motion } from '../tokens/static';
import { useMotionEnabled } from './useMotionEnabled';

export interface NumberTickerProps {
  value: number;
  /** Formats the number shown, for example `(n) => formatNumber(n, { maximumFractionDigits: 0 })`. Default: whole numbers. */
  format?: (value: number) => string;
  className?: string;
}

const whole = (value: number): string => String(Math.round(value));

/**
 * A number that counts up to its value in 300 ms when it first appears and again when the value changes. The final text
 * is what renders (and what assistive technology reads); reduced motion shows it at once and never animates.
 */
export function NumberTicker({ value, format = whole, className }: NumberTickerProps) {
  const enabled = useMotionEnabled();
  const node = useRef<HTMLSpanElement | null>(null);
  const shown = useRef<number | null>(null);
  const formatRef = useRef(format);
  useLayoutEffect(() => {
    formatRef.current = format;
  });

  useLayoutEffect(() => {
    const text = node.current?.firstChild;
    const from = shown.current ?? 0;
    shown.current = value;
    if (!enabled || !text || from === value) return undefined;
    // The text node is updated in place so React keeps owning it.
    const controls = animate(from, value, {
      duration: motion.max / 1000,
      ease: motion.curve,
      onUpdate: (latest) => {
        text.nodeValue = formatRef.current(latest);
      },
      onComplete: () => {
        text.nodeValue = formatRef.current(value);
      },
    });
    return () => {
      controls.stop();
      text.nodeValue = formatRef.current(value);
    };
  }, [value, enabled]);

  return (
    <span ref={node} className={className}>
      {format(value)}
    </span>
  );
}
