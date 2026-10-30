'use client';

import { LoadingSkeleton, cg } from '@caseguard/ui';
import { makeStyles } from '@fluentui/react-components';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: cg.space[4] },
});

/** Placeholder with the shape of a loaded section: a panel with a header and a few fields. */
export function SectionSkeleton() {
  const styles = useStyles();
  return (
    <div className={styles.root} aria-busy="true">
      <LoadingSkeleton variant="card" count={1} label="Loading the configuration" />
      <LoadingSkeleton variant="table" count={4} label="Loading settings" />
    </div>
  );
}

/** Placeholder for the whole page while permissions load: the section list and one section. */
export function GovernanceSkeleton() {
  return <SectionSkeleton />;
}
