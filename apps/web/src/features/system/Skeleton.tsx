'use client';

import { LoadingSkeleton, cg } from '@caseguard/ui';
import { makeStyles } from '@fluentui/react-components';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: cg.space[6] },
  band: {
    display: 'grid',
    gap: cg.space[4],
    gridTemplateColumns: 'minmax(0, 1fr)',
    '@media (min-width: 1100px)': { gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' },
  },
});

/** Placeholder with the same shape as the loaded System Health page. */
export function SystemHealthSkeleton() {
  const styles = useStyles();
  return (
    <div className={styles.root} aria-busy="true">
      <LoadingSkeleton variant="card" count={1} label="Loading overall status" />
      <LoadingSkeleton variant="table" count={6} label="Loading dependencies" />
      <div className={styles.band}>
        <LoadingSkeleton variant="card" count={1} label="Loading the AI provider status" />
        <LoadingSkeleton variant="card" count={1} label="Loading migrations" />
      </div>
      <LoadingSkeleton variant="card" count={2} label="Loading request metrics" />
    </div>
  );
}
