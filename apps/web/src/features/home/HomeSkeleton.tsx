'use client';

import { BentoGrid, BentoItem, Card, Skeleton, SkeletonText, cg } from '@caseguard/ui';
import { makeStyles } from '@fluentui/react-components';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: cg.space[6] },
  hero: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[8] },
  copy: { display: 'flex', flexDirection: 'column', gap: cg.space[3], flex: '1 1 260px' },
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[3] },
});

/** The Home layout while it loads: the hero with its ring, the fix list, three figures, two lists. */
export function HomeSkeleton() {
  const styles = useStyles();
  return (
    <div className={styles.root} aria-busy="true" aria-label="Loading Home" role="status">
      <Skeleton height={64} radius="lg" />
      <BentoGrid>
        <BentoItem span={12} spanLg={7}>
          <Card hero padding="lg">
            <div className={styles.hero}>
              <Skeleton width={176} height={176} radius="pill" />
              <div className={styles.copy}>
                <Skeleton width={120} height={14} />
                <Skeleton width="80%" height={24} />
                <SkeletonText lines={2} />
                <Skeleton width={140} height={40} radius="md" />
              </div>
            </div>
          </Card>
        </BentoItem>
        <BentoItem span={12} spanLg={5}>
          <Card padding="lg">
            <div className={styles.stack}>
              <Skeleton width={120} height={22} />
              <Skeleton height={72} radius="md" />
              <Skeleton height={72} radius="md" />
              <Skeleton height={72} radius="md" />
            </div>
          </Card>
        </BentoItem>
        {[0, 1, 2].map((index) => (
          <BentoItem key={index} span={12} spanSm={4}>
            <Card padding="md">
              <div className={styles.stack}>
                <Skeleton width="60%" height={14} />
                <Skeleton width={96} height={36} />
                <Skeleton width="80%" height={14} />
              </div>
            </Card>
          </BentoItem>
        ))}
        {[0, 1].map((index) => (
          <BentoItem key={`list-${index}`} span={12} spanLg={6}>
            <Card padding="lg">
              <div className={styles.stack}>
                <Skeleton width={140} height={20} />
                <Skeleton height={48} radius="md" />
                <Skeleton height={48} radius="md" />
                <Skeleton height={48} radius="md" />
              </div>
            </Card>
          </BentoItem>
        ))}
      </BentoGrid>
    </div>
  );
}
