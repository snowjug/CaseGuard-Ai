'use client';

import { LoadingSkeleton, cg } from '@caseguard/ui';
import { makeStyles } from '@fluentui/react-components';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: cg.space[4] },
  band: {
    display: 'grid',
    gap: cg.space[4],
    gridTemplateColumns: 'minmax(0, 1fr)',
    alignItems: 'start',
    '@media (min-width: 1100px)': { gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 3fr)' },
  },
});

/** Same shape as the loaded Arena: the chart, the ranked list beside the detail, then the action ranking. */
export function ArenaSkeleton() {
  const styles = useStyles();
  return (
    <div className={styles.root} aria-busy="true">
      <LoadingSkeleton variant="chart" count={1} label="Loading the confidence chart" />
      <div className={styles.band}>
        <LoadingSkeleton variant="list" count={5} label="Loading the hypotheses" />
        <LoadingSkeleton variant="card" count={1} label="Loading the selected hypothesis" />
      </div>
      <LoadingSkeleton variant="table" count={4} label="Loading the action ranking" />
    </div>
  );
}
