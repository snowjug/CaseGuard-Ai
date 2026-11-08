'use client';

import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { NumberTicker } from '../motion/NumberTicker';
import { STATUS_META, type BadgeStatus } from '../primitives/status-meta';
import { cg } from '../tokens/cg';
import { formatNumber } from '../format';
import { ChartTable } from './ChartParts';
import { arcPath } from './paths';

export type ScoreStatus = 'good' | 'watch' | 'poor' | 'unknown';

const STATUS: Record<ScoreStatus, { badge: BadgeStatus; label: string }> = {
  good: { badge: 'productive', label: 'Good' },
  watch: { badge: 'uncertain', label: 'Watch' },
  poor: { badge: 'unsupported', label: 'Needs attention' },
  unknown: { badge: 'missing', label: 'Not enough data' },
};

const useStyles = makeStyles({
  root: {
    display: 'inline-flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: cg.space[2],
    color: cg.text,
  },
  dial: { position: 'relative', display: 'block' },
  svg: { display: 'block', overflow: 'visible' },
  center: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
  },
  value: {
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.03em',
    lineHeight: 1,
    fontVariantNumeric: 'tabular-nums',
    color: cg.text,
  },
  of: { marginTop: cg.space[1], fontSize: tokens.fontSizeBase200, color: cg.textSecondary },
  caption: { fontSize: tokens.fontSizeBase200, color: cg.textSecondary, textAlign: 'center' },
});

export interface ScoreRingProps {
  /** The score, or `null` when there is not enough data (an empty ring is drawn). */
  value: number | null;
  /** Estimated range, drawn as a dashed outer arc. */
  low?: number | null;
  high?: number | null;
  /** Scale maximum (default 100). */
  max?: number;
  /** Names the score for assistive technology, for example "Case Quality Index". */
  label: string;
  /** Pixel size of the square canvas (default 132). */
  size?: number;
  status?: ScoreStatus;
  /** The status in the page's own words (a quality band, say), so one card never names it twice in two ways. */
  statusLabel?: string;
  /** Text in the middle of the ring; defaults to the rounded value. */
  valueText?: string;
  /** Small caption under the ring (for example "Estimated"). */
  caption?: string;
  className?: string;
}

/**
 * Gauge for a bounded score. The status is stated in words and by the arc's end-cap icon pattern, and the estimated
 * range is a separate dashed arc, so meaning never rests on colour alone.
 */
export function ScoreRing({
  value,
  low = null,
  high = null,
  max = 100,
  label,
  size = 132,
  status = 'unknown',
  statusLabel,
  valueText,
  caption,
  className,
}: ScoreRingProps) {
  const styles = useStyles();
  const meta = STATUS_META[STATUS[status].badge];
  const statusWords = statusLabel ?? STATUS[status].label;
  const tone = cg.tone[meta.tone];
  const stroke = 12;
  const centre = size / 2;
  const ringRadius = centre - stroke / 2 - 8;
  const rangeRadius = centre - 3;
  const angle = (n: number): number => (Math.min(Math.max(n, 0), max) / max) * 360;
  const hasValue = value !== null && Number.isFinite(value);
  const hasRange = low !== null && high !== null && high >= low;
  const shown = valueText ?? (hasValue ? formatNumber(value, { maximumFractionDigits: 0 }) : '—');
  const alt = `${label}: ${hasValue ? shown : 'not enough data'}${hasValue ? ` out of ${max}` : ''}, ${statusWords}${hasRange ? `, estimated range ${formatNumber(low, { maximumFractionDigits: 0 })} to ${formatNumber(high, { maximumFractionDigits: 0 })}` : ''}`;
  const StatusIcon = meta.icon;

  return (
    <figure className={mergeClasses(styles.root, className)} style={{ margin: 0 }}>
      <div className={styles.dial} style={{ width: size, height: size }}>
        <svg
          role="img"
          aria-label={alt}
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          className={styles.svg}
          style={{
            filter: hasValue
              ? `drop-shadow(0 0 ${Math.round(size / 9)}px color-mix(in srgb, ${tone.solid} 34%, transparent))`
              : undefined,
          }}
        >
          <circle
            cx={centre}
            cy={centre}
            r={ringRadius}
            fill="none"
            stroke={cg.surfaceSunken}
            strokeWidth={stroke}
          />
          <circle
            cx={centre}
            cy={centre}
            r={ringRadius}
            fill="none"
            stroke={cg.borderSubtle}
            strokeWidth={1}
            strokeOpacity={0.9}
          />
          {hasValue && value > 0 ? (
            <path
              d={arcPath(centre, centre, ringRadius, 0, angle(value))}
              pathLength={100}
              className="cg-ring-arc"
              fill="none"
              stroke={tone.solid}
              strokeWidth={stroke}
              strokeLinecap="round"
            />
          ) : null}
          {hasRange ? (
            <path
              d={arcPath(
                centre,
                centre,
                rangeRadius,
                angle(low),
                Math.max(angle(high), angle(low) + 2),
              )}
              fill="none"
              stroke={tone.solid}
              strokeWidth={3}
              strokeDasharray="2 3"
              strokeLinecap="butt"
            />
          ) : null}
        </svg>
        <div className={styles.center} aria-hidden="true">
          <span className={styles.value} style={{ fontSize: size * 0.3 }}>
            {valueText !== undefined || !hasValue ? (
              shown
            ) : (
              <NumberTicker
                value={value}
                format={(n) => formatNumber(n, { maximumFractionDigits: 0 })}
              />
            )}
          </span>
          <span className={styles.of}>{hasValue ? `of ${max}` : 'no data'}</span>
        </div>
      </div>
      <figcaption className={styles.caption}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: cg.space[1],
            color: tone.fg,
            fontWeight: 600,
          }}
        >
          <StatusIcon aria-hidden="true" />
          {statusWords}
        </span>
        {caption ? <span> · {caption}</span> : null}
      </figcaption>
      <ChartTable
        caption={alt}
        headers={['Measure', 'Value']}
        rows={[
          [label, hasValue ? shown : 'not enough data'],
          ['Status', statusWords],
          ...(hasRange
            ? [
                ['Estimated low', formatNumber(low, { maximumFractionDigits: 0 })],
                ['Estimated high', formatNumber(high, { maximumFractionDigits: 0 })],
              ]
            : []),
        ]}
      />
    </figure>
  );
}
