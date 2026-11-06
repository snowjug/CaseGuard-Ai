'use client';

import { BentoGrid, BentoItem, Card, Skeleton, VisuallyHidden, cg } from '@caseguard/ui';
import { makeStyles } from '@fluentui/react-components';

const useStyles = makeStyles({
  figures: {
    display: 'grid',
    gap: cg.space[4],
    gridTemplateColumns: 'minmax(0, 1fr)',
    height: '100%',
    '@media (min-width: 640px)': { gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' },
    '@media (min-width: 1024px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
  },
  card: { height: '100%', boxSizing: 'border-box', gap: cg.space[3] },
});

const PANELS = [0, 1, 2, 3] as const;

/** Placeholder with the shape of the loaded page: three figures beside the trend chart, then the panels. */
export function PortfolioSkeleton() {
  const styles = useStyles();
  return (
    <div role="status" aria-busy="true" aria-live="polite">
      <VisuallyHidden>Loading quality trends…</VisuallyHidden>
      <BentoGrid>
        <BentoItem span={12} spanLg={4}>
          <div className={styles.figures}>
            {[0, 1, 2].map((figure) => (
              <Card key={figure} className={styles.card}>
                <Skeleton width="55%" height={14} />
                <Skeleton width="35%" height={40} />
                <Skeleton width="75%" height={12} />
              </Card>
            ))}
          </div>
        </BentoItem>
        <BentoItem span={12} spanLg={8}>
          <Card glow className={styles.card}>
            <Skeleton width="30%" height={18} />
            <Skeleton width="55%" height={14} />
            <Skeleton height={220} radius="md" />
          </Card>
        </BentoItem>
        {PANELS.map((panel) => (
          <BentoItem key={panel} span={12} spanLg={6}>
            <Card className={styles.card}>
              <Skeleton width="40%" height={18} />
              <Skeleton width="65%" height={14} />
              <Skeleton height={140} radius="md" />
            </Card>
          </BentoItem>
        ))}
      </BentoGrid>
    </div>
  );
}
