'use client';

import { makeStyles, mergeClasses } from '@fluentui/react-components';
import type { CSSProperties } from 'react';
import { cg } from '../tokens/cg';

const useStyles = makeStyles({
  block: { display: 'block', maxWidth: '100%', backgroundColor: cg.surfaceSunken },
  text: { display: 'flex', flexDirection: 'column', gap: cg.space[2] },
});

type SkeletonRadius = 'sm' | 'md' | 'lg' | 'pill';

export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  /** Corner radius from the scale (default `sm`, 8 px). */
  radius?: SkeletonRadius;
  className?: string;
}

/**
 * A loading placeholder: a quiet block with a slow shimmer that stops when the data arrives. Build a screen's skeleton from
 * these in the shape of the real layout, so nothing jumps when the content appears. Hidden from assistive technology; the
 * region that loads carries `aria-busy`.
 */
export function Skeleton({ width = '100%', height = 16, radius = 'sm', className }: SkeletonProps) {
  const styles = useStyles();
  const style: CSSProperties = { width, height, borderRadius: cg.radius[radius] };
  return (
    <span
      aria-hidden="true"
      className={mergeClasses('cg-shimmer', styles.block, className)}
      style={style}
    />
  );
}

export interface SkeletonTextProps {
  /** Number of lines; the last one is shorter. */
  lines?: number;
  className?: string;
}

/** A paragraph-shaped placeholder. */
export function SkeletonText({ lines = 3, className }: SkeletonTextProps) {
  const styles = useStyles();
  return (
    <span aria-hidden="true" className={mergeClasses(styles.text, className)}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          height={14}
          width={index === lines - 1 && lines > 1 ? '62%' : '100%'}
        />
      ))}
    </span>
  );
}
