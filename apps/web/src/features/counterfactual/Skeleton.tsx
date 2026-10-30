'use client';

import { LoadingSkeleton, cg } from '@caseguard/ui';
import { makeStyles } from '@fluentui/react-components';

const useStyles = makeStyles({
  root: {
    display: 'grid',
    gap: cg.space[4],
    gridTemplateColumns: 'minmax(0, 1fr)',
    alignItems: 'start',
    '@media (min-width: 1100px)': { gridTemplateColumns: 'minmax(300px, 1fr) minmax(0, 3fr)' },
  },
  column: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
});

/** Same shape as the loaded Lab: the fork list beside the fork, its boundary, its paths and the comparison. */
export function LabSkeleton() {
  const styles = useStyles();
  return (
    <div className={styles.root} aria-busy="true">
      <LoadingSkeleton variant="list" count={6} label="Loading the decision forks" />
      <div className={styles.column}>
        <LoadingSkeleton variant="card" count={1} label="Loading the selected fork" />
        <LoadingSkeleton variant="card" count={1} label="Loading the temporal boundary" />
        <LoadingSkeleton variant="chart" count={1} label="Loading the comparison" />
      </div>
    </div>
  );
}
