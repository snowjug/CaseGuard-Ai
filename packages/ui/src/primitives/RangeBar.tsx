'use client';

import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { cg } from '../tokens/cg';
import type { ToneName } from '../tokens/palette';
import { formatNumber, formatProbability } from '../format';
import { ProvenanceBadge } from './ProvenanceBadge';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: cg.space[1], width: '100%' },
  track: {
    position: 'relative',
    height: '10px',
    borderRadius: cg.radius.pill,
    backgroundColor: cg.surfaceSunken,
    border: `1px solid ${cg.borderSubtle}`,
  },
  band: {
    position: 'absolute',
    top: '-1px',
    bottom: '-1px',
    minWidth: '4px',
    borderRadius: cg.radius.pill,
  },
  marker: {
    position: 'absolute',
    top: '-5px',
    width: '4px',
    height: '18px',
    transform: 'translateX(-50%)',
    borderRadius: cg.radius.pill,
  },
  caption: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: `0 ${cg.space[2]}`,
    fontSize: tokens.fontSizeBase200,
    color: cg.textSecondary,
    fontVariantNumeric: 'tabular-nums',
  },
  scale: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: tokens.fontSizeBase200,
    color: cg.textMuted,
    fontVariantNumeric: 'tabular-nums',
  },
});

export interface RangeBarProps {
  /** Point estimate; drawn as a marker. `null` hides the marker. */
  value: number | null;
  /** Lower and upper bound of the estimated range (same unit as `value`). */
  low: number | null;
  high: number | null;
  /** Scale minimum and maximum (default 0 to 100). */
  min?: number;
  max?: number;
  /** Names the quantity for assistive technology, for example "Resolution Confidence". */
  label: string;
  /** Formats numbers in the text alternative and caption. */
  format?: (value: number) => string;
  tone?: ToneName;
  /** Show the scale ends under the bar. */
  showScale?: boolean;
  /** Show the "value, range low to high" caption under the bar (default true). */
  showCaption?: boolean;
  className?: string;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/**
 * Range with a point estimate on a bounded scale: a hatched band for the range and a marker for the value.
 * The hatch (not only colour) marks it as an uncertainty range; the text alternative states all three numbers.
 */
export function RangeBar({
  value,
  low,
  high,
  min = 0,
  max = 100,
  label,
  format = (n) => formatNumber(n, { maximumFractionDigits: 1 }),
  tone = 'brand',
  showScale = false,
  showCaption = true,
  className,
}: RangeBarProps) {
  const styles = useStyles();
  const t = cg.tone[tone];
  const span = max - min;
  const position = (n: number): number => (span > 0 ? clamp01((n - min) / span) * 100 : 0);
  const hasRange = low !== null && high !== null && high >= low;

  const parts: string[] = [];
  if (value !== null) parts.push(`estimate ${format(value)}`);
  if (hasRange) parts.push(`range ${format(low)} to ${format(high)}`);
  parts.push(`scale ${format(min)} to ${format(max)}`);
  const alt = `${label}: ${parts.join(', ')}`;

  return (
    <div className={mergeClasses(styles.root, className)}>
      <div className={styles.track} role="img" aria-label={alt}>
        {hasRange ? (
          <span
            aria-hidden="true"
            className={styles.band}
            style={{
              left: `${position(low)}%`,
              width: `${Math.max(position(high) - position(low), 0)}%`,
              border: `1px solid ${t.border}`,
              backgroundColor: t.tint,
              backgroundImage: `repeating-linear-gradient(45deg, color-mix(in srgb, ${t.solid} 62%, transparent) 0 2px, transparent 2px 6px)`,
            }}
          />
        ) : null}
        {value !== null ? (
          <span
            aria-hidden="true"
            className={styles.marker}
            style={{
              left: `${position(value)}%`,
              backgroundColor: t.solid,
              boxShadow: `0 0 0 2px ${cg.surface}`,
            }}
          />
        ) : null}
      </div>
      {showScale ? (
        <div className={styles.scale} aria-hidden="true">
          <span>{format(min)}</span>
          <span>{format(max)}</span>
        </div>
      ) : null}
      {showCaption && (value !== null || hasRange) ? (
        <div className={styles.caption} aria-hidden="true">
          {value !== null ? <span>{format(value)}</span> : null}
          {hasRange ? (
            <span>
              range {format(low)}–{format(high)}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export interface ConfidenceBandProps {
  /** Model-estimated confidence in [0, 1]. */
  confidence: number;
  low: number;
  high: number;
  /** What the confidence is about, for example the hypothesis name. */
  label: string;
  /** Show the "Estimated" badge (default true): confidence is never statistical truth. */
  showBadge?: boolean;
  className?: string;
}

/** Confidence in [0, 1] with its range, always labelled as a model estimate. */
export function ConfidenceBand({
  confidence,
  low,
  high,
  label,
  showBadge = true,
  className,
}: ConfidenceBandProps) {
  return (
    <div className={className}>
      <RangeBar
        value={confidence * 100}
        low={low * 100}
        high={high * 100}
        min={0}
        max={100}
        label={`Confidence in ${label}`}
        format={(n) => formatProbability(n / 100)}
        tone="hypothesis"
        showCaption
      />
      {showBadge ? <ProvenanceBadge kind="estimated" label="Model estimate" /> : null}
    </div>
  );
}
