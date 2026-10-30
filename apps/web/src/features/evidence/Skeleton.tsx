'use client';

import { LoadingSkeleton, cg } from '@caseguard/ui';
import { makeStyles } from '@fluentui/react-components';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
});

/**
 * What stands in for the categories and the claims while a moment loads. The time cursor and the panel beside it are not
 * part of it: they stay on screen, so a person who is moving the cursor keeps their place.
 */
export function LedgerSkeleton() {
  const styles = useStyles();
  return (
    <div className={styles.stack}>
      <LoadingSkeleton variant="metric" count={4} label="Loading the evidence categories" />
      <LoadingSkeleton variant="list" count={5} label="Loading the claims" />
    </div>
  );
}
