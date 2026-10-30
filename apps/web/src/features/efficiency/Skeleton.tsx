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

/** Placeholder with the shape of the loaded monitor: usage tiles, two bands of panels, then the tables. */
export function EfficiencySkeleton() {
  const styles = useStyles();
  return (
    <div className={styles.root} aria-busy="true">
      <LoadingSkeleton variant="metric" count={4} label="Loading token usage" />
      <div className={styles.band}>
        <LoadingSkeleton variant="chart" label="Loading savings" />
        <LoadingSkeleton variant="list" count={3} label="Loading budgets" />
      </div>
      <LoadingSkeleton variant="table" count={5} label="Loading usage by agent" />
    </div>
  );
}
