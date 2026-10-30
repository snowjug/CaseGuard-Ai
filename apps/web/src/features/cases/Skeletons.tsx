'use client';

import { LoadingSkeleton, SkeletonBlock, cg } from '@caseguard/ui';
import { makeStyles } from '@fluentui/react-components';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  toolbar: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: cg.space[3],
    padding: cg.space[3],
    borderRadius: cg.radius.lg,
    border: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surface,
  },
  columns: {
    display: 'grid',
    gap: cg.space[4],
    gridTemplateColumns: 'minmax(0, 1fr)',
    '@media (min-width: 1100px)': { gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 2fr)' },
  },
});

/** Placeholder with the same layout as the case list: filter bar and a table. */
export function CasesSkeleton() {
  const styles = useStyles();
  return (
    <div className={styles.stack}>
      <div className={styles.toolbar} aria-hidden="true">
        <SkeletonBlock width={260} height={32} />
        <SkeletonBlock width={160} height={32} />
        <SkeletonBlock width={160} height={32} />
        <SkeletonBlock width={160} height={32} />
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
