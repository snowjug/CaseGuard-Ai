'use client';

import { LoadingSkeleton, cg } from '@caseguard/ui';
import { makeStyles } from '@fluentui/react-components';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: cg.space[4] },
});

/** Placeholder with the shape of the loaded library: the filter bar, then skill cards. */
export function LibrarySkeleton() {
  const styles = useStyles();
  return (
    <div className={styles.root} aria-busy="true">
      <LoadingSkeleton variant="list" count={3} label="Loading skills" />
    </div>
  );
}

/** Placeholder for the skill page: header summary, then a lifecycle and a content panel. */
export function SkillDetailSkeleton() {
  const styles = useStyles();
  return (
    <div className={styles.root} aria-busy="true">
      <LoadingSkeleton variant="card" count={1} label="Loading the skill" />
      <LoadingSkeleton variant="list" count={3} label="Loading the lifecycle" />
      <LoadingSkeleton variant="card" count={2} label="Loading the skill definition" />
    </div>
  );
}
