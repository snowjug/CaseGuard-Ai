'use client';

import { LoadingSkeleton, SkeletonBlock, cg } from '@caseguard/ui';
import { makeStyles } from '@fluentui/react-components';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: cg.space[6] },
  head: { display: 'flex', flexDirection: 'column', gap: cg.space[2] },
  columns: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
    gap: cg.space[4],
  },
});

/** Generic page skeleton: header, a row of metrics and two panels. Used by `loading.tsx`. */
export function PageSkeleton({ label = 'Loading page' }: { label?: string }) {
  const styles = useStyles();
  return (
    <div className={styles.root} aria-busy="true">
      <div className={styles.head}>
        <SkeletonBlock width="38%" height={28} />
        <SkeletonBlock width="62%" height={16} />
      </div>
      <LoadingSkeleton variant="metric" count={4} label={label} />
      <div className={styles.columns}>
        <LoadingSkeleton variant="card" count={1} label="Loading panel" />
        <LoadingSkeleton variant="list" count={4} label="Loading list" />
      </div>
    </div>
  );
}
