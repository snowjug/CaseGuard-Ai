'use client';

import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import {
  ArrowDownRegular,
  ArrowRightRegular,
  ArrowUpRegular,
  SubtractRegular,
} from '@fluentui/react-icons';
import { METRIC_DEFINITIONS, type MetricCard as MetricCardModel } from '@caseguard/schemas';
import { useId } from 'react';
import { VisuallyHidden } from '../a11y/VisuallyHidden';
import { formatMetricValue, formatNumber, NOT_AVAILABLE } from '../format';
import { UiLink } from '../link-context';
import { cg } from '../tokens/cg';
import { DefinitionPopover } from './HelpButton';
import { ProvenanceBadge } from './ProvenanceBadge';
import { RangeBar } from './RangeBar';
import { StatusBadge } from './StatusBadge';
import type { BadgeStatus } from './status-meta';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    minWidth: 0,
    padding: cg.space[4],
    borderRadius: cg.radius.lg,
    backgroundColor: cg.surface,
    border: `1px solid ${cg.borderSubtle}`,
    boxShadow: cg.shadowLow,
    color: cg.text,
  },
  top: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: cg.space[2] },
  label: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.textSecondary,
  },
  valueRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: `${cg.space[1]} ${cg.space[3]}`,
  },
  value: {
    fontSize: tokens.fontSizeHero800,
    lineHeight: tokens.lineHeightHero800,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.01em',
    fontVariantNumeric: 'tabular-nums',
    overflowWrap: 'anywhere',
  },
  // Long displays such as "7.4 bits/1k tokens" step down a size so they stay on one or two lines.
  valueMedium: { fontSize: tokens.fontSizeHero700, lineHeight: tokens.lineHeightHero700 },
  valueSmall: { fontSize: tokens.fontSizeBase600, lineHeight: tokens.lineHeightBase600 },
  trend: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: cg.space[1],
    fontSize: tokens.fontSizeBase300,
    fontVariantNumeric: 'tabular-nums',
  },
  range: { display: 'flex', flexDirection: 'column', gap: cg.space[1] },
  rangeLabel: { margin: 0, fontSize: tokens.fontSizeBase200, color: cg.textMuted },
  badges: { display: 'flex', flexWrap: 'wrap', gap: cg.space[1] },
  link: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: cg.space[1],
    alignSelf: 'flex-start',
    marginTop: 'auto',
    color: cg.textLink,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    textDecoration: 'none',
    ':hover': { textDecoration: 'underline' },
  },
});

const STATUS_MAP: Record<MetricCardModel['status'], { badge: BadgeStatus; label: string }> = {
  good: { badge: 'productive', label: 'Good' },
  watch: { badge: 'uncertain', label: 'Watch' },
  poor: { badge: 'unsupported', label: 'Needs attention' },
  unknown: { badge: 'missing', label: 'Not enough data' },
};

/** Whether a movement in `direction` is an improvement for the metric (null when unknown). */
function trendJudgement(
  key: string,
  direction: 'up' | 'down' | 'flat',
): 'improving' | 'worsening' | 'steady' | null {
  if (direction === 'flat') return 'steady';
  const definition = (
    METRIC_DEFINITIONS as Record<string, { higherIsBetter: boolean } | undefined>
  )[key];
  if (!definition) return null;
  const up = direction === 'up';
  return up === definition.higherIsBetter ? 'improving' : 'worsening';
}

export interface MetricCardProps {
  /** The card exactly as returned by `dashboard.commandCenter` (`MetricCard` schema). */
  metric: MetricCardModel;
  /** Heading level of the card title so the page outline stays logical (default 3). */
  headingLevel?: 2 | 3 | 4;
  className?: string;
}

/**
 * Metric card: value, status, trend, estimated range, definition popover, provenance badges and an evidence
 * click-through. Nothing here is computed beyond formatting: values come from the API untouched.
 */
export function MetricCard({ metric, headingLevel = 3, className }: MetricCardProps) {
  const styles = useStyles();
  const headingId = useId();
  const Heading = `h${headingLevel}` as const;
  const status = STATUS_MAP[metric.status];
  const valueSizeClass =
    metric.display.length <= 7
      ? undefined
      : metric.display.length <= 12
        ? styles.valueMedium
        : styles.valueSmall;
  const range = metric.range;
  const domain: [number, number] =
    metric.unit === 'score' || metric.unit === 'percent'
      ? [0, 100]
      : [0, Math.max(range?.high ?? 0, metric.value ?? 0, 1) * 1.15];
  const judgement = metric.trend ? trendJudgement(metric.key, metric.trend.direction) : null;
  const trendTone =
    judgement === 'improving'
      ? cg.tone.productive.fg
      : judgement === 'worsening'
        ? cg.tone.unsupported.fg
        : cg.textSecondary;
  const TrendIcon =
    metric.trend?.direction === 'up'
      ? ArrowUpRegular
      : metric.trend?.direction === 'down'
        ? ArrowDownRegular
        : SubtractRegular;

  return (
    <div
      role="group"
      aria-labelledby={headingId}
      className={mergeClasses(styles.root, className)}
      data-metric={metric.key}
    >
      <div className={styles.top}>
        <Heading id={headingId} className={styles.label}>
          {metric.label}
        </Heading>
        <DefinitionPopover
          term={metric.label}
          definition={metric.definition}
          formula={metric.formula}
          note={
            metric.estimated
              ? 'This is a model estimate shown with its range. It is not a measured fact.'
              : undefined
          }
        />
      </div>

      <div className={styles.valueRow}>
        {metric.value === null ? (
          <>
            <span aria-hidden="true" className={styles.value}>
              {NOT_AVAILABLE}
            </span>
            <VisuallyHidden>No value available</VisuallyHidden>
          </>
        ) : (
          <span className={mergeClasses(styles.value, valueSizeClass)}>{metric.display}</span>
        )}
        <StatusBadge status={status.badge} label={status.label} />
      </div>

      {metric.trend ? (
        <span className={styles.trend} style={{ color: trendTone }}>
          <TrendIcon aria-hidden="true" />
          <span>
            {formatNumber(metric.trend.delta, { signed: true, maximumFractionDigits: 2 })}{' '}
            {metric.trend.label}
          </span>
          {judgement ? <VisuallyHidden>({judgement})</VisuallyHidden> : null}
        </span>
      ) : null}

      {range ? (
        <div className={styles.range}>
          <RangeBar
            value={metric.value}
            low={range.low}
            high={range.high}
            min={domain[0]}
            max={domain[1]}
            label={`${metric.label} estimated range`}
            format={(n) => formatMetricValue(n, metric.unit)}
            tone="brand"
            showCaption={false}
          />
          <p className={styles.rangeLabel}>
            Estimated range {formatMetricValue(range.low, metric.unit)} to{' '}
            {formatMetricValue(range.high, metric.unit)}
          </p>
        </div>
      ) : null}

      {metric.estimated || metric.synthetic ? (
        <div className={styles.badges}>
          {metric.estimated ? <ProvenanceBadge kind="estimated" /> : null}
          {metric.synthetic ? <ProvenanceBadge kind="synthetic" /> : null}
        </div>
      ) : null}

      {metric.evidenceLink ? (
        <UiLink href={metric.evidenceLink.href} className={styles.link}>
          {metric.evidenceLink.label}
          <ArrowRightRegular aria-hidden="true" />
        </UiLink>
      ) : null}
    </div>
  );
}
