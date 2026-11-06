'use client';

import { Card, Skeleton, VisuallyHidden, cg } from '@caseguard/ui';
import { makeStyles } from '@fluentui/react-components';

const useStyles = makeStyles({
  page: { display: 'flex', flexDirection: 'column', gap: cg.space[6], minWidth: 0 },
  chips: { display: 'flex', gap: cg.space[3], overflow: 'hidden' },
  hero: { gap: cg.space[6] },
  body: {
    display: 'grid',
    gap: cg.space[6],
    gridTemplateColumns: 'minmax(0, 1fr)',
    '@media (min-width: 1024px)': { gridTemplateColumns: 'minmax(0, 7fr) minmax(0, 5fr)' },
  },
  column: { display: 'flex', flexDirection: 'column', gap: cg.space[3], minWidth: 0 },
  tabs: { display: 'flex', gap: cg.space[4] },
});

/** The loading state of What if, in the shape of the screen: the decisions, the answer beside its decision, the tabs. */
export function LabSkeleton() {
  const styles = useStyles();
  return (
    <div role="status" aria-busy="true" aria-live="polite" className={styles.page}>
      <VisuallyHidden>Loading the key decisions…</VisuallyHidden>
      <div className={styles.column} aria-hidden="true">
        <Skeleton width={180} height={20} />
        <div className={styles.chips}>
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} width={272} height={96} radius="md" />
          ))}
        </div>
      </div>
      <Card hero padding="lg" aria-hidden="true" className={styles.hero}>
        <Skeleton width="46%" height={26} />
        <div className={styles.body}>
          <div className={styles.column}>
            <Skeleton width={220} height={14} />
            <Skeleton width={260} height={52} />
            <Skeleton width="70%" height={14} />
            <Skeleton height={14} radius="pill" />
            <Skeleton height={14} radius="pill" />
          </div>
          <div className={styles.column}>
            <Skeleton width={90} height={12} />
            <Skeleton width="80%" height={20} />
            <Skeleton height={14} />
            <Skeleton width="88%" height={14} />
          </div>
        </div>
      </Card>
      <div className={styles.column} aria-hidden="true">
        <div className={styles.tabs}>
          {[0, 1, 2, 3, 4].map((index) => (
            <Skeleton key={index} width={96} height={20} />
          ))}
        </div>
        <Card>
          <Skeleton width="38%" height={20} />
          <Skeleton height={180} radius="md" />
        </Card>
      </div>
    </div>
  );
}
