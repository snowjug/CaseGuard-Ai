'use client';

import {
  BentoGrid,
  BentoItem,
  Card,
  Skeleton,
  SkeletonText,
  VisuallyHidden,
  cg,
} from '@caseguard/ui';
import { makeStyles } from '@fluentui/react-components';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  toolbar: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: cg.space[3] },
  field: { display: 'flex', flexDirection: 'column', gap: cg.space[2], flex: '1 1 200px' },
  cell: { height: '100%' },
  card: { height: '100%', boxSizing: 'border-box', gap: cg.space[4] },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  body: { display: 'flex', flexDirection: 'column', gap: cg.space[2] },
  facts: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: cg.space[4],
    paddingTop: cg.space[4],
    borderTop: `1px solid ${cg.borderSubtle}`,
  },
  fact: { display: 'flex', flexDirection: 'column', gap: cg.space[2] },
  hero: {
    display: 'grid',
    gap: cg.space[8],
    gridTemplateColumns: 'minmax(0, 1fr)',
    '@media (min-width: 1280px)': { gridTemplateColumns: 'minmax(0, 7fr) minmax(0, 5fr)' },
  },
  steps: { display: 'flex', gap: cg.space[4], flexWrap: 'wrap' },
  step: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: cg.space[2] },
  col: { display: 'flex', flexDirection: 'column', gap: cg.space[3] },
  tabs: { display: 'flex', gap: cg.space[4], paddingBlock: cg.space[3], overflow: 'hidden' },
});

/** Placeholder with the shape of the loaded library: the filter row, then a grid of skill cards. */
export function LibrarySkeleton() {
  const styles = useStyles();
  return (
    <div role="status" aria-busy="true" aria-live="polite" className={styles.root}>
      <VisuallyHidden>Loading skills…</VisuallyHidden>
      <div className={styles.toolbar} aria-hidden="true">
        <div className={styles.field}>
          <Skeleton width={56} height={13} />
          <Skeleton height={40} radius="md" />
        </div>
        <div className={styles.field}>
          <Skeleton width={48} height={13} />
          <Skeleton height={40} radius="md" />
        </div>
      </div>
      <BentoGrid aria-hidden="true">
        {Array.from({ length: 6 }, (_, index) => (
          <BentoItem key={index} span={12} spanSm={6} spanLg={4}>
            <div className={styles.cell}>
              <Card className={styles.card}>
                <div className={styles.head}>
                  <Skeleton width={40} height={40} radius="md" />
                  <Skeleton width={92} height={26} radius="pill" />
                </div>
                <div className={styles.body}>
                  <Skeleton width="45%" height={12} />
                  <Skeleton width="92%" height={18} />
                  <Skeleton width="64%" height={18} />
                  <SkeletonText lines={2} />
                </div>
                <div className={styles.facts}>
                  <div className={styles.fact}>
                    <Skeleton width="72%" height={12} />
                    <Skeleton width="40%" height={22} />
                  </div>
                  <div className={styles.fact}>
                    <Skeleton width="50%" height={12} />
                    <Skeleton width="56%" height={22} />
                  </div>
                </div>
              </Card>
            </div>
          </BentoItem>
        ))}
      </BentoGrid>
    </div>
  );
}

/** Placeholder for the skill page: the stepper and the expected benefit, then the tabs and two content cards. */
export function SkillDetailSkeleton() {
  const styles = useStyles();
  return (
    <div role="status" aria-busy="true" aria-live="polite" className={styles.root}>
      <VisuallyHidden>Loading the skill…</VisuallyHidden>
      <div aria-hidden="true" className={styles.root}>
        <Card hero padding="lg">
          <div className={styles.hero}>
            <div className={styles.col}>
              <Skeleton width="38%" height={20} />
              <div className={styles.steps}>
                {Array.from({ length: 7 }, (_, index) => (
                  <div key={index} className={styles.step}>
                    <Skeleton width={24} height={24} radius="pill" />
                    <Skeleton width={56} height={12} />
                  </div>
                ))}
              </div>
              <SkeletonText lines={2} />
            </div>
            <div className={styles.col}>
              <Skeleton width="42%" height={20} />
              <Skeleton width="60%" height={48} radius="md" />
              <Skeleton height={10} radius="pill" />
              <Skeleton width="70%" height={13} />
            </div>
          </div>
        </Card>
        <div className={styles.tabs}>
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} width={84} height={20} />
          ))}
        </div>
        <Card className={styles.col}>
          <Skeleton width="30%" height={20} />
          <SkeletonText lines={4} />
        </Card>
        <Card className={styles.col}>
          <Skeleton width="34%" height={20} />
          <SkeletonText lines={3} />
        </Card>
      </div>
    </div>
  );
}
