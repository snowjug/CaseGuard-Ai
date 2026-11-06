'use client';

import { Card, Skeleton, VisuallyHidden, cg } from '@caseguard/ui';
import { makeStyles } from '@fluentui/react-components';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  hero: {
    display: 'grid',
    gap: cg.space[6],
    gridTemplateColumns: 'minmax(0, 1fr)',
    alignItems: 'center',
    '@media (min-width: 900px)': { gridTemplateColumns: 'minmax(0, 1fr) 280px' },
  },
  text: { display: 'flex', flexDirection: 'column', gap: cg.space[3] },
  row: { display: 'flex', gap: cg.space[2], alignItems: 'center' },
  rows: { padding: 0 },
  other: {
    display: 'grid',
    gap: cg.space[3],
    padding: `${cg.space[4]} ${cg.space[6]}`,
    borderBottom: `1px solid ${cg.borderSubtle}`,
    ':last-child': { borderBottom: 0 },
  },
  chart: { gap: cg.space[3] },
});

/** Same shape as the loaded screen: the leading cause, the other causes as rows, the chart and the next-test row. */
export function ArenaSkeleton() {
  const styles = useStyles();
  return (
    <div className={styles.root} role="status" aria-busy="true" aria-live="polite">
      <VisuallyHidden>Loading the possible causes…</VisuallyHidden>
      <Card hero padding="lg">
        <div className={styles.hero}>
          <div className={styles.text}>
            <div className={styles.row}>
              <Skeleton width={88} height={26} radius="pill" />
              <Skeleton width={112} height={12} />
            </div>
            <Skeleton width="70%" height={30} />
            <Skeleton height={14} />
            <Skeleton width="55%" height={14} />
            <Skeleton width={128} height={40} radius="md" />
          </div>
          <Skeleton height={148} radius="lg" />
        </div>
      </Card>
      <Card padding="none" className={styles.rows}>
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className={styles.other}>
            <Skeleton width="45%" height={18} />
            <Skeleton height={10} radius="pill" />
          </div>
        ))}
      </Card>
      <Card className={styles.chart}>
        <Skeleton width="28%" height={18} />
        <Skeleton height={200} radius="md" />
      </Card>
      <Skeleton height={56} radius="lg" />
    </div>
  );
}
