'use client';

import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { ArrowDownIcon, ArrowUpIcon, MinusIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { VisuallyHidden } from '../a11y/VisuallyHidden';
import { NOT_AVAILABLE } from '../format';
import { NumberTicker } from '../motion/NumberTicker';
import { HelpButton } from '../primitives/HelpButton';
import { StatusBadge } from '../primitives/StatusBadge';
import type { BadgeStatus } from '../primitives/status-meta';
import { cg } from '../tokens/cg';
import { Card } from './Card';

const useStyles = makeStyles({
  root: { gap: cg.space[3] },
  top: { display: 'flex', alignItems: 'center', gap: cg.space[2], minWidth: 0 },
  icon: { display: 'inline-flex', color: cg.tone.brand.fg, fontSize: '1.25em' },
  label: {
    margin: 0,
    flex: '1 1 auto',
    minWidth: 0,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightMedium,
    color: cg.textSecondary,
  },
  valueRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    gap: `${cg.space[1]} ${cg.space[3]}`,
  },
  value: {
    fontSize: tokens.fontSizeHero700,
    lineHeight: tokens.lineHeightHero700,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.02em',
    fontVariantNumeric: 'tabular-nums',
    color: cg.text,
  },
  unit: {
    fontSize: tokens.fontSizeBase300,
    color: cg.textSecondary,
    fontWeight: tokens.fontWeightMedium,
  },
  delta: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: cg.space[1],
    margin: 0,
    fontSize: tokens.fontSizeBase200,
    fontVariantNumeric: 'tabular-nums',
  },
});

export type StatJudgement = 'improving' | 'worsening' | 'steady';

export interface StatCardProps {
  label: string;
  /** The number, or `null` when there is nothing to show (an em dash appears). */
  value: number | null;
  /** How the number is written, for example `(n) => formatNumber(n, { maximumFractionDigits: 1 })`. Default: whole numbers. */
  format?: (value: number) => string;
  /** Text after the number: `/ 100`, `%`, `min`. */
  unit?: string;
  status?: BadgeStatus;
  /** The status in words; defaults to the status name. */
  statusLabel?: string;
  /** What changed and against what, in words ("+6 points since the last case"). */
  delta?: { text: string; judgement: StatJudgement };
  /** The definition, shown in a popover; the card itself never needs it to make sense. */
  help?: ReactNode;
  icon?: ReactNode;
  footer?: ReactNode;
  /** Heading level of the label, so the page outline stays logical (default 3). */
  headingLevel?: 2 | 3 | 4;
  className?: string;
}

const JUDGEMENT = {
  improving: { icon: ArrowUpIcon, tone: 'productive' },
  worsening: { icon: ArrowDownIcon, tone: 'unsupported' },
  steady: { icon: MinusIcon, tone: 'neutral' },
} as const;

/** A number that matters: a label, the value (it counts up when it appears), its status in words, and what changed. */
export function StatCard({
  label,
  value,
  format,
  unit,
  status,
  statusLabel,
  delta,
  help,
  icon,
  footer,
  headingLevel = 3,
  className,
}: StatCardProps) {
  const styles = useStyles();
  const Heading = `h${headingLevel}` as const;
  const judgement = delta ? JUDGEMENT[delta.judgement] : null;
  const DeltaIcon = judgement?.icon;
  return (
    <Card className={mergeClasses(styles.root, className)}>
      <div className={styles.top}>
        {icon ? (
          <span aria-hidden="true" className={styles.icon}>
            {icon}
          </span>
        ) : null}
        <Heading className={styles.label}>{label}</Heading>
        {help ? (
          <HelpButton label={`About ${label}`} title={label}>
            {help}
          </HelpButton>
        ) : null}
      </div>
      <div className={styles.valueRow}>
        {value === null ? (
          <>
            <span aria-hidden="true" className={styles.value}>
              {NOT_AVAILABLE}
            </span>
            <VisuallyHidden>No value available</VisuallyHidden>
          </>
        ) : (
          <span className={styles.value}>
            <NumberTicker value={value} {...(format ? { format } : {})} />
          </span>
        )}
        {unit && value !== null ? <span className={styles.unit}>{unit}</span> : null}
        {status ? (
          <StatusBadge status={status} {...(statusLabel ? { label: statusLabel } : {})} />
        ) : null}
      </div>
      {delta && judgement && DeltaIcon ? (
        <p className={styles.delta} style={{ color: cg.tone[judgement.tone].fg }}>
          <DeltaIcon aria-hidden="true" />
          <span>{delta.text}</span>
          <VisuallyHidden>({delta.judgement})</VisuallyHidden>
        </p>
      ) : null}
      {footer}
    </Card>
  );
}
