'use client';

import { makeStyles } from '@fluentui/react-components';
import { VisuallyHidden } from '../a11y/VisuallyHidden';
import { Card } from '../kit/Card';
import { Skeleton } from '../kit/Skeleton';
import { cg } from '../tokens/cg';

const useStyles = makeStyles({
  region: { display: 'flex', flexDirection: 'column', gap: cg.space[3], width: '100%' },
  card: { gap: cg.space[3] },
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
export function SkeletonBlock({ width = '100%', height = 16, className }: SkeletonBlockProps) {
  return <Skeleton width={width} height={height} {...(className ? { className } : {})} />;
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
 * once; the shapes themselves are hidden from it. Prefer a skeleton shaped like the real screen when there is one.
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
            <Card key={i} className={styles.card}>
              <Skeleton width="55%" height={14} />
              <Skeleton width="40%" height={32} />
              <Skeleton width="70%" height={10} />
            </Card>
          ))}
        </div>
      );
      break;
    }
    case 'card': {
      content = (
        <Card className={styles.card}>
          <Skeleton width="40%" height={18} />
          <Skeleton height={12} />
          <Skeleton width="85%" height={12} />
          <Skeleton width="60%" height={12} />
        </Card>
      );
      break;
    }
    case 'table': {
      content = (
        <Card className={styles.card}>
          <Skeleton width="30%" height={16} />
          {Array.from({ length: count ?? 5 }, (_, i) => (
            <div key={i} className={styles.tableRow}>
              <Skeleton height={14} />
              <Skeleton height={14} />
              <Skeleton height={14} />
              <Skeleton height={14} />
            </div>
          ))}
        </Card>
      );
      break;
    }
    case 'chart': {
      content = (
        <Card className={styles.card}>
          <Skeleton width="35%" height={16} />
          <Skeleton height={180} radius="md" />
        </Card>
      );
      break;
    }
    case 'list': {
      content = (
        <Card className={styles.card}>
          {Array.from({ length: count ?? 4 }, (_, i) => (
            <div key={i} className={styles.row}>
              <Skeleton width={32} height={32} radius="pill" />
              <div className={styles.region}>
                <Skeleton width="60%" height={14} />
                <Skeleton width="85%" height={12} />
              </div>
            </div>
          ))}
        </Card>
      );
      break;
    }
    case 'graph': {
      content = (
        <Card className={styles.card}>
          <Skeleton width="30%" height={16} />
          <Skeleton height={320} radius="md" />
        </Card>
      );
      break;
    }
    default: {
      content = (
        <div className={styles.region}>
          {Array.from({ length: count ?? 3 }, (_, i) => (
            <Skeleton key={i} width={i === (count ?? 3) - 1 ? '60%' : '100%'} height={14} />
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
