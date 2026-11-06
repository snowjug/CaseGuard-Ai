'use client';

import { Card, Skeleton, VisuallyHidden, cg } from '@caseguard/ui';
import { makeStyles } from '@fluentui/react-components';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  head: { display: 'flex', justifyContent: 'space-between', gap: cg.space[6] },
  titles: { display: 'flex', flexDirection: 'column', gap: cg.space[2], flex: 1 },
  legend: { display: 'flex', flexWrap: 'wrap', gap: cg.space[2] },
  row: { display: 'flex', gap: cg.space[3], alignItems: 'center' },
  filters: { display: 'flex', flexWrap: 'wrap', gap: cg.space[2] },
  grow: { flex: '1 1 240px' },
  list: { padding: 0 },
  claim: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    padding: `${cg.space[4]} ${cg.space[6]}`,
    borderBottom: `1px solid ${cg.borderSubtle}`,
    ':last-child': { borderBottom: 0 },
  },
});

/**
 * What stands in for the coverage card and the claims while a moment loads, in their shape. The time cursor bar is not
 * part of it: it stays on screen, so a person who is moving the cursor keeps their place.
 */
export function LedgerSkeleton() {
  const styles = useStyles();
  return (
    <div className={styles.stack} role="status" aria-busy="true" aria-live="polite">
      <VisuallyHidden>Loading the claims…</VisuallyHidden>
      <Card hero className={styles.stack}>
        <div className={styles.head}>
          <div className={styles.titles}>
            <Skeleton width="30%" height={20} />
            <Skeleton width="55%" height={14} />
          </div>
          <Skeleton width={96} height={40} radius="md" />
        </div>
        <Skeleton height={20} radius="md" />
        <div className={styles.legend}>
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} width={112} height={32} radius="sm" />
          ))}
        </div>
      </Card>
      <div className={styles.filters}>
        <Skeleton height={40} radius="md" className={styles.grow} />
        <Skeleton width={104} height={40} radius="md" />
      </div>
      <Card padding="none" className={styles.list}>
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className={styles.claim}>
            <div className={styles.row}>
              <Skeleton width={128} height={22} radius="pill" />
              <Skeleton width={96} height={22} radius="pill" />
            </div>
            <Skeleton height={14} />
            <Skeleton width="72%" height={14} />
            <Skeleton width="38%" height={12} />
          </div>
        ))}
      </Card>
    </div>
  );
}
