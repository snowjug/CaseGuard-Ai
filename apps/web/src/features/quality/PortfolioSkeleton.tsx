'use client';

import { LoadingSkeleton, cg } from '@caseguard/ui';
import { makeStyles } from '@fluentui/react-components';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: cg.space[4] },
  band: {
    display: 'grid',
    gap: cg.space[4],
    gridTemplateColumns: 'minmax(0, 1fr)',
    '@media (min-width: 1100px)': { gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' },
  },
});

/** Placeholder with the shape of the loaded analytics: cohort, then bands of charts. */
export function PortfolioSkeleton() {
  const styles = useStyles();
  return (
    <div className={styles.root} aria-busy="true">
      <LoadingSkeleton variant="metric" count={3} label="Loading the cohort" />
      <div className={styles.band}>
        <LoadingSkeleton variant="chart" label="Loading quality over time" />
        <LoadingSkeleton variant="chart" label="Loading decision-fork categories" />
      </div>
      <div className={styles.band}>
        <LoadingSkeleton variant="chart" label="Loading evidence gaps" />
        <LoadingSkeleton variant="chart" label="Loading avoidable-effort patterns" />
      </div>
      <LoadingSkeleton variant="list" count={3} label="Loading skill adoption" />
    </div>
  );
}
