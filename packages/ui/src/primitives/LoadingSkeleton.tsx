'use client';

import { makeStyles, mergeClasses } from '@fluentui/react-components';
import type { CSSProperties } from 'react';
import { VisuallyHidden } from '../a11y/VisuallyHidden';
import { cg } from '../tokens/cg';

const useStyles = makeStyles({
  region: { display: 'flex', flexDirection: 'column', gap: cg.space[3], width: '100%' },
  block: {
    display: 'block',
    borderRadius: cg.radius.sm,
    backgroundColor: cg.surfaceSunken,
    // The shimmer (animated gradient) comes from the global `.cg-shimmer` class and stops under reduced motion.
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[3],
    padding: cg.space[4],
    borderRadius: cg.radius.lg,
    backgroundColor: cg.surface,
    border: `1px solid ${cg.borderSubtle}`,
  },
  grid: {
    display: 'grid',
    gap: cg.space[4],
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
  },
  row: { display: 'flex', alignItems: 'center', gap: cg.space[3] },
  tableRow: {
    display: 'grid',
    gridTemplateColumns: '2fr 1fr 1fr 1fr',
    gap: cg.space[3],
    alignItems: 'center',
    padding: `${cg.space[2]} 0`,
  },
});

export type SkeletonVariant = 'text' | 'metric' | 'card' | 'table' | 'chart' | 'list' | 'graph';

export interface SkeletonBlockProps {
  width?: string | number;
  height?: string | number;
  radius?: string;
  className?: string;
}

/** A single shimmering placeholder block. Decorative: wrap in a `LoadingSkeleton` region for the announcement. */
export function SkeletonBlock({
  width = '100%',
  height = 16,
  radius,
  className,
}: SkeletonBlockProps) {
  const styles = useStyles();
  const style: CSSProperties = { width, height, ...(radius ? { borderRadius: radius } : {}) };
  return (
    <span
      aria-hidden="true"
      className={mergeClasses(styles.block, 'cg-shimmer', className)}
      style={style}
    />
  );
}

export interface LoadingSkeletonProps {
  /**
   * `text` lines, a `metric` card, a generic `card`, a `table`, a `chart`, a `list` of rows or the `graph` canvas.
   */
  variant?: SkeletonVariant;
  /** Number of repeated items (lines, metric cards, table rows...). */
  count?: number;
  /** Announced to screen readers, for example "Loading metrics". */
  label?: string;
  className?: string;
}

/**
 * Skeleton placeholder region. It is a polite `status` with `aria-busy`, so assistive technology hears the label
 * once; the shapes themselves are hidden from it.
 */
export function LoadingSkeleton({
  variant = 'text',
  count,
  label = 'Loading',
  className,
}: LoadingSkeletonProps) {
  const styles = useStyles();
  let content;
  switch (variant) {
    case 'metric': {
      content = (
        <div className={styles.grid}>
          {Array.from({ length: count ?? 4 }, (_, i) => (
            <div key={i} className={styles.card}>
              <SkeletonBlock width="55%" height={14} />
              <SkeletonBlock width="40%" height={32} />
              <SkeletonBlock width="70%" height={10} />
            </div>
          ))}
        </div>
      );
      break;
    }
    case 'card': {
      content = (
        <div className={styles.card}>
          <SkeletonBlock width="40%" height={18} />
          <SkeletonBlock height={12} />
          <SkeletonBlock width="85%" height={12} />
          <SkeletonBlock width="60%" height={12} />
        </div>
      );
      break;
    }
    case 'table': {
      content = (
        <div className={styles.card}>
          <SkeletonBlock width="30%" height={16} />
          {Array.from({ length: count ?? 5 }, (_, i) => (
            <div key={i} className={styles.tableRow}>
              <SkeletonBlock height={14} />
              <SkeletonBlock height={14} />
              <SkeletonBlock height={14} />
              <SkeletonBlock height={14} />
            </div>
          ))}
        </div>
      );
      break;
    }
    case 'chart': {
      content = (
        <div className={styles.card}>
          <SkeletonBlock width="35%" height={16} />
          <SkeletonBlock height={180} radius="8px" />
        </div>
      );
      break;
    }
    case 'list': {
      content = (
        <div className={styles.card}>
          {Array.from({ length: count ?? 4 }, (_, i) => (
            <div key={i} className={styles.row}>
              <SkeletonBlock width={32} height={32} radius="999px" />
              <div className={styles.region}>
                <SkeletonBlock width="60%" height={14} />
                <SkeletonBlock width="85%" height={12} />
              </div>
            </div>
          ))}
        </div>
      );
      break;
    }
    case 'graph': {
      content = (
        <div className={styles.card}>
          <SkeletonBlock width="30%" height={16} />
          <SkeletonBlock height={320} radius="12px" />
        </div>
      );
      break;
    }
    default: {
      content = (
        <div className={styles.region}>
          {Array.from({ length: count ?? 3 }, (_, i) => (
            <SkeletonBlock key={i} width={i === (count ?? 3) - 1 ? '60%' : '100%'} height={14} />
          ))}
        </div>
      );
    }
  }
  return (
    <div role="status" aria-busy="true" aria-live="polite" className={className}>
      <VisuallyHidden>{label}…</VisuallyHidden>
      {content}
    </div>
  );
}
