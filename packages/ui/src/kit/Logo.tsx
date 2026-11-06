'use client';

import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { useId } from 'react';
import { cg } from '../tokens/cg';

const useStyles = makeStyles({
  root: { display: 'inline-flex', alignItems: 'center', gap: cg.space[2], color: cg.text },
  word: {
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.02em',
    lineHeight: '1',
  },
  accent: { color: cg.tone.brand.fg },
  glow: { filter: `drop-shadow(0 4px 12px ${cg.glow})` },
});

export interface LogoProps {
  /** Pixel size of the mark (default 28). */
  size?: number;
  /** Show the "CaseGuard AI" wordmark next to the mark (default true). */
  wordmark?: boolean;
  className?: string;
}

/** The CaseGuard mark (a shield with a check, in the accent) and its wordmark. */
export function Logo({ size = 28, wordmark = true, className }: LogoProps) {
  const styles = useStyles();
  const gradient = useId();
  return (
    <span className={mergeClasses(styles.root, className)}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        role={wordmark ? undefined : 'img'}
        aria-label={wordmark ? undefined : 'CaseGuard AI'}
        aria-hidden={wordmark ? true : undefined}
        className={styles.glow}
      >
        <defs>
          <linearGradient
            id={gradient}
            x1="6"
            y1="2"
            x2="26"
            y2="30"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" stopColor={cg.tone.brand.fg} />
            <stop offset="1" stopColor={cg.tone.brand.solid} />
          </linearGradient>
        </defs>
        <path
          d="M16 2.5 5 6.7v8.1c0 6.6 4.3 11.6 11 14.7 6.7-3.1 11-8.1 11-14.7V6.7L16 2.5Z"
          fill={`url(#${gradient})`}
        />
        <path
          d="m11 16.2 3.6 3.6 6.6-7.2"
          fill="none"
          stroke={cg.tone.brand.onSolid}
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {wordmark ? (
        <span className={styles.word}>
          CaseGuard <span className={styles.accent}>AI</span>
        </span>
      ) : null}
    </span>
  );
}
