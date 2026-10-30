'use client';

import { LoadingSkeleton, cg } from '@caseguard/ui';
import { makeStyles } from '@fluentui/react-components';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: cg.space[6] },
  band: {
    display: 'grid',
    gap: cg.space[4],
    gridTemplateColumns: 'minmax(0, 1fr)',
    '@media (min-width: 1100px)': { gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 2fr)' },
  },
});

/** Placeholder with the same shape as the loaded Command Center (metrics, then two bands of panels). */
export function CommandCenterSkeleton() {
  const styles = useStyles();
  return (
    <div className={styles.root} aria-busy="true">
      <LoadingSkeleton variant="card" count={1} label="Loading the active case" />
      <LoadingSkeleton variant="metric" count={7} label="Loading metrics" />
      <div className={styles.band}>
        <LoadingSkeleton variant="list" count={3} label="Loading warnings" />
        <LoadingSkeleton variant="card" count={1} label="Loading the leading hypothesis" />
      </div>
      <div className={styles.band}>
        <LoadingSkeleton variant="list" count={3} label="Loading missing evidence" />
        <LoadingSkeleton variant="table" count={4} label="Loading recent cases" />
      </div>
    </div>
  );
}
