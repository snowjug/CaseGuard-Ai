'use client';

import { LoadingSkeleton, cg } from '@caseguard/ui';
import { makeStyles } from '@fluentui/react-components';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: cg.space[6] },
});

/** Placeholder with the shape of the loaded Demo Guide: progress, notices, then the ordered steps. */
export function DemoGuideSkeleton() {
  const styles = useStyles();
  return (
    <div className={styles.root} aria-busy="true">
      <LoadingSkeleton variant="card" count={1} label="Loading demo progress" />
      <LoadingSkeleton variant="list" count={5} label="Loading the demo steps" />
    </div>
  );
}
