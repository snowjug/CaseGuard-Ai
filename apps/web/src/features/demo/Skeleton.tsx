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
  steps: { display: 'flex', flexDirection: 'column', gap: cg.space[6] },
  step: { display: 'flex', gap: cg.space[4] },
  stepText: { display: 'flex', flexDirection: 'column', gap: cg.space[2], flex: '1 1 auto' },
});

/** Placeholder with the shape of the loaded page: the progress card, then the ordered steps. */
export function DemoGuideSkeleton() {
  const styles = useStyles();
  return (
    <div className={styles.root} role="status" aria-busy="true" aria-live="polite">
      <VisuallyHidden>Loading demo progress…</VisuallyHidden>
      <VisuallyHidden>Loading the demo steps…</VisuallyHidden>
      <Card hero padding="lg" className={styles.summary}>
        <div className={styles.row}>
          <Skeleton width={40} height={40} radius="md" />
          <Skeleton width={96} height={16} />
        </div>
        <Skeleton width="42%" height={30} />
        <Skeleton height={10} radius="pill" />
        <div className={styles.row}>
          <Skeleton width={176} height={26} radius="pill" />
          <Skeleton width={88} height={26} radius="pill" />
        </div>
        <div className={styles.facts}>
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className={styles.fact}>
              <Skeleton width="45%" height={12} />
              <Skeleton width="70%" height={18} />
            </div>
          ))}
        </div>
      </Card>
      <div className={styles.steps}>
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className={styles.step}>
            <Skeleton width={36} height={36} radius="pill" />
            <div className={styles.stepText}>
              <Skeleton width={`${34 + ((index * 9) % 24)}%`} height={18} />
              <Skeleton width="72%" height={14} />
              <Skeleton width={128} height={32} radius="sm" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
