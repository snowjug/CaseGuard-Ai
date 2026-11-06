'use client';

import { LoadingSkeleton, SkeletonBlock, cg } from '@caseguard/ui';
import { makeStyles } from '@fluentui/react-components';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  toolbar: { display: 'flex', flexWrap: 'wrap', gap: cg.space[3] },
  columns: {
    display: 'grid',
    gap: cg.space[4],
    gridTemplateColumns: 'minmax(0, 1fr)',
    '@media (min-width: 1100px)': { gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 2fr)' },
  },
});

/** Placeholder with the same layout as the case list: the search row and a table. */
export function CasesSkeleton() {
  const styles = useStyles();
  return (
    <div className={styles.stack}>
      <div className={styles.toolbar} aria-hidden="true">
        <SkeletonBlock width={320} height={40} />
        <SkeletonBlock width={110} height={40} />
        <SkeletonBlock width={220} height={40} />
      </div>
      <LoadingSkeleton variant="table" count={6} label="Loading cases" />
    </div>
  );
}

/** Placeholder with the same layout as the case overview. */
export function CaseOverviewSkeleton() {
  const styles = useStyles();
  return (
    <div className={styles.stack}>
      <LoadingSkeleton variant="card" label="Loading the case" />
      <div className={styles.columns}>
        <LoadingSkeleton variant="list" count={5} label="Loading the digital twin" />
        <LoadingSkeleton variant="card" label="Loading the analysis" />
      </div>
    </div>
  );
}
