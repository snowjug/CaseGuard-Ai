'use client';

import { METRIC_DEFINITIONS } from '@caseguard/schemas';
import {
  ButtonLink,
  DefinitionPopover,
  LoadingSkeleton,
  NumberTicker,
  ProvenanceBadge,
  RangeBar,
  StatusBadge,
  cg,
  formatNumber,
  type BadgeStatus,
} from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { ArrowRightIcon } from 'lucide-react';
import { caseHref } from '../../../lib/deep-links';
import { useMetricsHandle } from '../hooks';
import { PartState, SectionFrame } from './shared';

const useStyles = makeStyles({
  row: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: `${cg.space[4]} ${cg.space[6]}`,
  },
  figure: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    flex: '1 1 280px',
    maxWidth: '480px',
    minWidth: 0,
  },
  value: { display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: cg.space[2] },
  number: {
    fontSize: tokens.fontSizeHero800,
    lineHeight: tokens.lineHeightHero800,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.03em',
    fontVariantNumeric: 'tabular-nums',
    color: cg.text,
  },
  unit: { fontSize: tokens.fontSizeBase300, color: cg.textMuted },
  text: {
    margin: 0,
    maxWidth: '64ch',
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
  },
});

const STATUS: Record<'good' | 'watch' | 'poor' | 'unknown', { badge: BadgeStatus; label: string }> =
  {
    good: { badge: 'productive', label: 'Good' },
    watch: { badge: 'uncertain', label: 'Fair' },
    poor: { badge: 'unsupported', label: 'Poor' },
    unknown: { badge: 'missing', label: 'Not enough data' },
  };

const whole = (value: number): string => formatNumber(value, { maximumFractionDigits: 0 });

/**
 * Evidence: how well the statements in the case are backed by what is on record (the evidence integrity estimate), with
 * its range, and the way into the evidence itself. Every statement elsewhere in the review opens its own evidence.
 */
export function EvidenceSection({ caseId }: { caseId: string }) {
  const styles = useStyles();
  const metrics = useMetricsHandle(caseId);
  const metric =
    metrics.source.kind === 'ready'
      ? (metrics.source.data.find((item) => item.key === 'evidence_integrity') ?? null)
      : null;
  const status = metric ? STATUS[metric.status] : null;
  return (
    <SectionFrame
      id="evidence"
      title="Evidence"
      description="How well the statements in this case are backed by what is on record."
      badges={<ProvenanceBadge kind="estimated" />}
    >
      {metrics.source.kind !== 'ready' ? (
        <PartState
          handle={metrics}
          what="the evidence summary"
          skeleton={
            <LoadingSkeleton variant="text" count={2} label="Loading the evidence summary" />
          }
        />
      ) : metric && metric.value !== null && status ? (
        <div className={styles.row}>
          <div className={styles.figure}>
            <div className={styles.value}>
              <span className={styles.number}>
                <NumberTicker value={metric.value} format={whole} />
              </span>
              <span className={styles.unit}>out of 100</span>
              <StatusBadge status={status.badge} label={status.label} />
              <DefinitionPopover
                term="Evidence integrity"
                definition={METRIC_DEFINITIONS.evidence_integrity.definition}
                formula={METRIC_DEFINITIONS.evidence_integrity.formula}
              />
            </div>
            {metric.low !== null && metric.high !== null ? (
              <RangeBar
                value={metric.value}
                low={metric.low}
                high={metric.high}
                label="Evidence integrity"
                format={whole}
              />
            ) : null}
          </div>
          <ButtonLink
            href={caseHref(caseId, 'evidence')}
            variant="secondary"
            icon={<ArrowRightIcon />}
            iconPosition="end"
          >
            Open evidence
          </ButtonLink>
        </div>
      ) : (
        <div className={styles.row}>
          <p className={styles.text}>
            The evidence summary has no figure for this case yet. Every statement in this review
            still opens the messages it rests on.
          </p>
          <ButtonLink href={caseHref(caseId, 'evidence')} variant="secondary">
            Open evidence
          </ButtonLink>
        </div>
      )}
    </SectionFrame>
  );
}
