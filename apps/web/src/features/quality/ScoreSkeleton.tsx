'use client';

import { BentoGrid, BentoItem, Card, Skeleton, VisuallyHidden, cg } from '@caseguard/ui';
import { makeStyles, mergeClasses } from '@fluentui/react-components';

const useStyles = makeStyles({
  card: { height: '100%', boxSizing: 'border-box', gap: cg.space[4] },
  hero: { alignItems: 'center', gap: cg.space[6] },
  center: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: cg.space[3],
    width: '100%',
  },
  // Only the alpha of a mask counts: the middle is cut out, so the disc reads as the ring it stands in for.
  ring: {
    display: 'inline-flex',
    maskImage: `radial-gradient(circle, transparent 0 66%, ${cg.text} 67%)`,
    WebkitMaskImage: `radial-gradient(circle, transparent 0 66%, ${cg.text} 67%)`,
  },
  row: { display: 'flex', flexDirection: 'column', gap: cg.space[2], paddingBlock: cg.space[3] },
  rowHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: cg.space[3],
  },
  item: { display: 'flex', flexDirection: 'column', gap: cg.space[2], paddingBlock: cg.space[3] },
});

const DIMENSIONS = [0, 1, 2, 3, 4, 5] as const;
const ITEMS = [0, 1, 2] as const;

/**
 * The Score's result while it loads: a ring and its words beside the six meters, then the two lists. It has the shape of
 * the finished layout, so nothing moves when the figures arrive. The region is busy and announced once.
 */
export function ScoreSkeleton({ label = 'Loading the score' }: { label?: string }) {
  const styles = useStyles();
  return (
    <div role="status" aria-busy="true" aria-live="polite">
      <VisuallyHidden>{label}…</VisuallyHidden>
      <BentoGrid>
        <BentoItem span={12} spanLg={5}>
          <Card hero padding="lg" className={mergeClasses(styles.card, styles.hero)}>
            <Skeleton width={128} height={16} />
            <div className={styles.center}>
              <span aria-hidden="true" className={styles.ring}>
                <Skeleton width={192} height={192} radius="pill" />
              </span>
              <Skeleton width="70%" height={18} />
              <Skeleton width="50%" height={14} />
              <Skeleton width="85%" height={56} radius="md" />
            </div>
          </Card>
        </BentoItem>
        <BentoItem span={12} spanLg={7}>
          <Card className={styles.card}>
            <Skeleton width="40%" height={20} />
            {DIMENSIONS.map((row) => (
              <div key={row} className={styles.row}>
                <div className={styles.rowHead}>
                  <Skeleton width="45%" height={16} />
                  <Skeleton width={40} height={22} />
                </div>
                <Skeleton height={8} radius="pill" />
                <Skeleton width="60%" height={12} />
              </div>
            ))}
          </Card>
        </BentoItem>
        {[0, 1].map((column) => (
          <BentoItem key={column} span={12} spanLg={6}>
            <Card className={styles.card}>
              <Skeleton width="45%" height={20} />
              {ITEMS.map((row) => (
                <div key={row} className={styles.item}>
                  <Skeleton width="65%" height={16} />
                  <Skeleton height={12} />
                  <Skeleton width="80%" height={12} />
                  <Skeleton width="50%" height={28} radius="sm" />
                </div>
              ))}
            </Card>
          </BentoItem>
        ))}
      </BentoGrid>
    </div>
  );
}
