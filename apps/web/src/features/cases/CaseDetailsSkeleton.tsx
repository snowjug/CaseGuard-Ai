'use client';

import { Card, Skeleton, VisuallyHidden, cg } from '@caseguard/ui';
import { makeStyles } from '@fluentui/react-components';

const useStyles = makeStyles({
  page: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  hero: { gap: cg.space[6] },
  heroHead: { display: 'flex', justifyContent: 'space-between', gap: cg.space[3] },
  facts: {
    display: 'grid',
    gap: `${cg.space[4]} ${cg.space[6]}`,
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    '@media (min-width: 1024px)': { gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' },
  },
  fact: { display: 'flex', flexDirection: 'column', gap: cg.space[2] },
  tiles: {
    display: 'grid',
    gap: cg.space[3],
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    '@media (min-width: 640px)': { gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' },
    '@media (min-width: 1024px)': { gridTemplateColumns: 'repeat(5, minmax(0, 1fr))' },
  },
  columns: {
    display: 'grid',
    gap: cg.space[4],
    gridTemplateColumns: 'minmax(0, 1fr)',
    alignItems: 'start',
    '@media (min-width: 1100px)': { gridTemplateColumns: 'minmax(0, 7fr) minmax(0, 5fr)' },
  },
  side: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  rows: { display: 'flex', flexDirection: 'column', gap: cg.space[3] },
});

/**
 * The loading state of Case details, in the shape of the page: the key facts card with its numbers, then the case
 * structure beside the folded sections. The region says it is busy; the shapes are hidden from assistive technology.
 */
export function CaseDetailsSkeleton() {
  const styles = useStyles();
  return (
    <div role="status" aria-busy="true" aria-live="polite" className={styles.page}>
      <VisuallyHidden>Loading the case…</VisuallyHidden>
      <Card hero padding="lg" aria-hidden="true" className={styles.hero}>
        <div className={styles.heroHead}>
          <Skeleton width={120} height={24} />
          <Skeleton width={92} height={22} radius="pill" />
        </div>
        <div className={styles.facts}>
          {Array.from({ length: 8 }, (_, index) => (
            <div key={index} className={styles.fact}>
              <Skeleton width="42%" height={12} />
              <Skeleton width="78%" height={18} />
            </div>
          ))}
        </div>
        <div className={styles.tiles}>
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} height={88} radius="md" />
          ))}
        </div>
      </Card>
      <div className={styles.columns}>
        <Card aria-hidden="true" className={styles.hero}>
          <div className={styles.rows}>
            <Skeleton width="34%" height={22} />
            <Skeleton width="62%" height={14} />
          </div>
          <div className={styles.rows}>
            {Array.from({ length: 5 }, (_, index) => (
              <Skeleton key={index} height={32} radius="md" />
            ))}
          </div>
        </Card>
        <div className={styles.side}>
          <Card aria-hidden="true">
            <Skeleton height={40} radius="md" />
          </Card>
          <Card aria-hidden="true" className={styles.hero}>
            <Skeleton width="48%" height={20} />
            <div className={styles.rows}>
              {Array.from({ length: 3 }, (_, index) => (
                <Skeleton key={index} height={32} radius="md" />
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
