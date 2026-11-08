'use client';

import { Card, Skeleton, VisuallyHidden, cg } from '@caseguard/ui';
import { makeStyles } from '@fluentui/react-components';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: cg.space[6] },
  summary: { gap: cg.space[4], '@media (max-width: 639px)': { padding: cg.space[4] } },
  row: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: cg.space[3] },
  facts: {
    display: 'grid',
    gap: `${cg.space[3]} ${cg.space[6]}`,
    gridTemplateColumns: 'repeat(auto-fit, minmax(132px, 1fr))',
    paddingTop: cg.space[4],
    borderTop: `1px solid ${cg.borderSubtle}`,
  },
  fact: { display: 'flex', flexDirection: 'column', gap: cg.space[2] },
  layout: {
    display: 'grid',
    gap: cg.space[6],
    gridTemplateColumns: 'minmax(0, 1fr)',
    alignItems: 'start',
    '@media (min-width: 900px)': { gridTemplateColumns: '220px minmax(0, 1fr)' },
  },
  nav: {
    display: 'none',
    '@media (min-width: 900px)': { display: 'flex', flexDirection: 'column', gap: cg.space[3] },
  },
  card: { gap: cg.space[4] },
  field: { display: 'flex', flexDirection: 'column', gap: cg.space[2] },
  fields: { display: 'flex', flexDirection: 'column', gap: cg.space[4] },
});

/** A settings section while it loads: its heading and lines, then a few rows of fields. */
function SectionShape() {
  const styles = useStyles();
  return (
    <Card className={styles.card}>
      <Skeleton width="34%" height={20} />
      <Skeleton width="56%" height={14} />
      <div className={styles.row}>
        <Skeleton width={84} height={26} radius="pill" />
        <Skeleton width={96} height={26} radius="pill" />
      </div>
      <div className={styles.fields}>
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className={styles.field}>
            <Skeleton width={`${28 + ((index * 7) % 20)}%`} height={14} />
            <Skeleton width="100%" height={40} radius="md" />
          </div>
        ))}
      </div>
    </Card>
  );
}

/** Placeholder with the shape of a loaded section (shown while the settings load inside the page). */
export function SectionSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-live="polite">
      <VisuallyHidden>Loading the settings…</VisuallyHidden>
      <SectionShape />
    </div>
  );
}

/** Placeholder for the whole page while permissions load: the summary card, the section list and one section. */
export function GovernanceSkeleton() {
  const styles = useStyles();
  return (
    <div className={styles.root} role="status" aria-busy="true" aria-live="polite">
      <VisuallyHidden>Loading settings and audit…</VisuallyHidden>
      <Card hero padding="lg" className={styles.summary}>
        <div className={styles.row}>
          <Skeleton width={40} height={40} radius="md" />
          <Skeleton width={120} height={16} />
        </div>
        <Skeleton width="44%" height={30} />
        <Skeleton width="60%" height={16} />
        <div className={styles.facts}>
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className={styles.fact}>
              <Skeleton width="45%" height={12} />
              <Skeleton width="70%" height={18} />
            </div>
          ))}
        </div>
      </Card>
      <div className={styles.layout}>
        <div className={styles.nav}>
          <Skeleton height={440} radius="lg" />
        </div>
        <SectionShape />
      </div>
    </div>
  );
}
