'use client';

import type { MetricCard } from '@caseguard/schemas';
import {
  BentoItem,
  BlurFade,
  ProvenanceBadge,
  StatCard,
  cg,
  formatNumber,
  type BadgeStatus,
  type StatJudgement,
} from '@caseguard/ui';
import { makeStyles } from '@fluentui/react-components';

const useStyles = makeStyles({
  footer: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
});

interface Figure {
  key: string;
  label: string;
  unit: string;
  /** True when a lower figure is the better one (time that could have been saved). */
  lowerIsBetter?: boolean;
}

/** The three figures that answer "how is it going": what could have been saved, how sound the evidence is, how well it was reasoned. */
const FIGURES: readonly Figure[] = [
  {
    key: 'avoidable_support_effort',
    label: 'Time that could have been saved',
    unit: '%',
    lowerIsBetter: true,
  },
  { key: 'evidence_integrity', label: 'Evidence integrity', unit: '/ 100' },
  { key: 'reasoning_efficiency', label: 'Reasoning efficiency', unit: '/ 100' },
];

const STATUS: Record<MetricCard['status'], { status: BadgeStatus; label: string }> = {
  good: { status: 'productive', label: 'Good' },
  watch: { status: 'uncertain', label: 'Fair' },
  poor: { status: 'unsupported', label: 'Poor' },
  unknown: { status: 'missing', label: 'Not enough data' },
};

function judgement(metric: MetricCard, lowerIsBetter: boolean): StatJudgement {
  const direction = metric.trend?.direction;
  if (!direction || direction === 'flat') return 'steady';
  const better = lowerIsBetter ? direction === 'down' : direction === 'up';
  return better ? 'improving' : 'worsening';
}

/** "58.3 points higher than the previous analysed case", in words; the arrow beside it follows the same direction. */
function deltaText(metric: MetricCard): string | null {
  const trend = metric.trend;
  if (!trend) return null;
  if (trend.direction === 'flat') return 'No change since the previous case';
  const size = formatNumber(Math.abs(trend.delta), { maximumFractionDigits: 1 });
  return `${size} points ${trend.direction === 'up' ? 'higher' : 'lower'} than the previous case`;
}

/** Three numbers, each with its status in words, what changed and a definition in a popover. Missing metrics are skipped. */
export function KeyNumbers({ metrics }: { metrics: readonly MetricCard[] }) {
  const styles = useStyles();
  return (
    <>
      {FIGURES.map((pick, index) => {
        const metric = metrics.find((item) => item.key === pick.key);
        if (!metric) return null;
        const status = STATUS[metric.status];
        const text = deltaText(metric);
        return (
          <BentoItem key={pick.key} span={12} spanSm={4}>
            <BlurFade index={3 + index}>
              <StatCard
                label={pick.label}
                value={metric.value}
                format={(n) => formatNumber(n, { maximumFractionDigits: 0 })}
                unit={pick.unit}
                status={status.status}
                statusLabel={status.label}
                {...(text && metric.trend
                  ? {
                      delta: {
                        text,
                        judgement: judgement(metric, pick.lowerIsBetter ?? false),
                        direction: metric.trend.direction,
                      },
                    }
                  : {})}
                help={metric.definition}
                footer={
                  metric.estimated || metric.range ? (
                    <span className={styles.footer}>
                      {metric.estimated ? <ProvenanceBadge kind="estimated" /> : null}
                      {metric.range
                        ? `Range ${formatNumber(metric.range.low, { maximumFractionDigits: 0 })} to ${formatNumber(metric.range.high, { maximumFractionDigits: 0 })}`
                        : null}
                    </span>
                  ) : undefined
                }
              />
            </BlurFade>
          </BentoItem>
        );
      })}
    </>
  );
}
