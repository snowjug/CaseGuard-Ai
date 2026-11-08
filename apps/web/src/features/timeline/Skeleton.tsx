'use client';

import { Card, Skeleton, VisuallyHidden, cg } from '@caseguard/ui';
import { makeStyles } from '@fluentui/react-components';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  chart: { gap: cg.space[3] },
  filters: { display: 'flex', flexWrap: 'wrap', gap: cg.space[2] },
  entry: { display: 'flex', gap: cg.space[3], alignItems: 'stretch' },
  when: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    width: '96px',
    flexShrink: 0,
    '@media (max-width: 639px)': { display: 'none' },
  },
  card: { flex: 1, gap: cg.space[2] },
  row: { display: 'flex', gap: cg.space[2], alignItems: 'center' },
});

/**
 * What stands in for the chart and the events while a moment loads, in their shape. The time cursor bar is not part of
 * it: it stays on screen, so a person who is moving the cursor keeps their place.
 */
export function TimelineSkeleton() {
  const styles = useStyles();
  return (
    <div className={styles.stack} role="status" aria-busy="true" aria-live="polite">
      <VisuallyHidden>Loading the events…</VisuallyHidden>
      <Card className={styles.chart}>
        <Skeleton width="28%" height={18} />
        <Skeleton height={168} radius="md" />
      </Card>
      <div className={styles.filters}>
        <Skeleton width={96} height={32} radius="md" />
        <Skeleton width={160} height={32} radius="md" />
        <Skeleton width={128} height={32} radius="md" />
        <Skeleton width={104} height={40} radius="md" />
      </div>
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className={styles.entry}>
          <div className={styles.when}>
            <Skeleton width="80%" height={12} />
            <Skeleton width="60%" height={12} />
          </div>
          <Card className={styles.card}>
            <div className={styles.row}>
              <Skeleton width={88} height={14} />
              <Skeleton width={120} height={14} />
            </div>
            <Skeleton width="55%" height={18} />
            <Skeleton height={12} />
            <Skeleton width="70%" height={12} />
          </Card>
        </div>
      ))}
    </div>
  );
}
