'use client';

import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { formatNumber, formatPercent } from '../format';
import { useSafeId } from '../hooks/useSafeId';
import { SvgPatternDefs, patternUrl, type SvgPatternKind } from '../primitives/SvgPatternDefs';
import { cg } from '../tokens/cg';
import type { ToneName } from '../tokens/palette';
import { ChartTable, useChartStyles, useElementWidth } from './ChartParts';
import { cumulative } from './scales';

export type StackedPattern = SvgPatternKind | 'solid' | 'outline';

export interface StackedSegment {
  key: string;
  label: string;
  value: number;
  /** Colour role; defaults to a rotation of the chart palette. */
  tone?: ToneName;
  /** Texture; defaults to a rotation (solid, hatch, dots, cross-hatch, outline) so segments differ without colour. */
  pattern?: StackedPattern;
}

export interface StackedBarProps {
  /** What the bar answers, for example "Where the avoidable effort comes from". Names the figure. */
  title: string;
  segments: readonly StackedSegment[];
  /** Explicit denominator. When larger than the sum, the remainder is drawn as an empty dashed segment. */
  total?: number;
  valueFormat?: (value: number) => string;
  height?: number;
  width?: number;
  /** Header of the value column in the data table. */
  valueLabel?: string;
  className?: string;
}

const DEFAULT_PATTERNS: readonly StackedPattern[] = [
  'solid',
  'hatch',
  'dots',
  'crosshatch',
  'outline',
];
const DEFAULT_TONES: readonly ToneName[] = [
  'brand',
  'evidence',
  'hypothesis',
  'productive',
  'uncertain',
  'simulated',
];

const useStyles = makeStyles({
  list: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
    gap: `${cg.space[1]} ${cg.space[4]}`,
    margin: 0,
    padding: 0,
    listStyle: 'none',
    fontSize: tokens.fontSizeBase200,
    color: cg.textSecondary,
  },
  item: { display: 'flex', alignItems: 'center', gap: cg.space[2], minWidth: 0 },
  swatch: { flexShrink: 0 },
  text: { minWidth: 0, overflowWrap: 'anywhere' },
  value: {
    marginLeft: cg.space[1],
    color: cg.text,
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: 'tabular-nums',
  },
});

/** Shares of the total in percent, for the text alternative. Exported for unit tests. */
export function segmentShares(segments: readonly { value: number }[], total?: number): number[] {
  const sum = segments.reduce((acc, s) => acc + Math.max(0, s.value), 0);
  const denominator = Math.max(total ?? sum, sum);
  if (denominator <= 0) return segments.map(() => 0);
  return segments.map((s) => (Math.max(0, s.value) / denominator) * 100);
}

/**
 * Single stacked bar with one textured segment per part. The legend lists every segment with its value and share,
 * so the numbers never depend on reading the graphic.
 */
export function StackedBar({
  title,
  segments,
  total,
  valueFormat = (n) => formatNumber(n, { maximumFractionDigits: 1 }),
  height = 28,
  width: fixedWidth,
  valueLabel = 'Value',
  className,
}: StackedBarProps) {
  const styles = useStyles();
  const chart = useChartStyles();
  const idPrefix = useSafeId('sb');
  const [measureRef, measured] = useElementWidth<HTMLDivElement>(560);
  const width = Math.max(160, fixedWidth ?? measured);

  const shares = segmentShares(segments, total);
  const sum = segments.reduce((acc, s) => acc + Math.max(0, s.value), 0);
  const remainder = total !== undefined && total > sum ? total - sum : 0;
  const denominator = Math.max(total ?? sum, sum);
  const gap = 2;
  const usable = width - gap * Math.max(0, segments.length + (remainder > 0 ? 1 : 0) - 1);

  const resolved = segments.map((s, i) => ({
    ...s,
    tone: s.tone ?? DEFAULT_TONES[i % DEFAULT_TONES.length] ?? 'brand',
    pattern: s.pattern ?? DEFAULT_PATTERNS[i % DEFAULT_PATTERNS.length] ?? 'solid',
    share: shares[i] ?? 0,
  }));
  const tones = [...new Set(resolved.map((s) => s.tone))];

  const summary =
    segments.length === 0 || denominator <= 0
      ? `${title}: no data to plot`
      : `${title}: ${resolved.map((s) => `${s.label} ${formatPercent(s.share, 0)}`).join(', ')}${remainder > 0 ? `, remainder ${formatPercent((remainder / denominator) * 100, 0)}` : ''}`;

  const fillFor = (tone: ToneName, pattern: StackedPattern): { fill: string; stroke: string } => {
    const color = cg.tone[tone];
    if (pattern === 'outline') return { fill: 'none', stroke: color.solid };
    if (pattern === 'solid') return { fill: color.solid, stroke: color.solid };
    return { fill: patternUrl(idPrefix, pattern, tone), stroke: color.solid };
  };

  const starts = cumulative(resolved.map((s) => Math.max(0, s.value)));
  const offsetOf = (index: number): number =>
    ((starts[index] ?? sum) / (denominator || 1)) * usable + index * gap;
  return (
    <figure className={mergeClasses(chart.figure, className)}>
      <figcaption className={chart.caption}>{title}</figcaption>
      <div ref={measureRef} className={chart.frame}>
        <svg
          role="img"
          aria-label={summary}
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          className={chart.svg}
        >
          <SvgPatternDefs
            idPrefix={idPrefix}
            tones={tones}
            kinds={['hatch', 'dots', 'crosshatch']}
          />
          {denominator <= 0 ? (
            <rect
              x={0.75}
              y={0.75}
              width={width - 1.5}
              height={height - 1.5}
              rx={6}
              fill="none"
              stroke={cg.borderControl}
              strokeDasharray="4 3"
            />
          ) : (
            <>
              {resolved.map((segment, index) => {
                const w = Math.max(0, (Math.max(0, segment.value) / denominator) * usable);
                if (w <= 0) return null;
                const paint = fillFor(segment.tone, segment.pattern);
                return (
                  <g key={segment.key}>
                    <title>{`${segment.label}: ${valueFormat(segment.value)} (${formatPercent(segment.share, 0)})`}</title>
                    <rect
                      x={offsetOf(index) + 0.75}
                      y={0.75}
                      width={Math.max(w - 1.5, 0.5)}
                      height={height - 1.5}
                      rx={4}
                      fill={paint.fill}
                      stroke={paint.stroke}
                      strokeWidth={1.5}
                    />
                  </g>
                );
              })}
              {remainder > 0 ? (
                <rect
                  x={offsetOf(resolved.length) + 0.75}
                  y={0.75}
                  width={Math.max((remainder / denominator) * usable - 1.5, 0.5)}
                  height={height - 1.5}
                  rx={4}
                  fill="none"
                  stroke={cg.borderControl}
                  strokeDasharray="4 3"
                  strokeWidth={1.5}
                />
              ) : null}
            </>
          )}
        </svg>
      </div>
      <ul className={styles.list} aria-label={`${title} breakdown`}>
        {resolved.map((segment) => {
          const paint = fillFor(segment.tone, segment.pattern);
          return (
            <li key={segment.key} className={styles.item}>
              <svg
                className={styles.swatch}
                width="22"
                height="12"
                viewBox="0 0 22 12"
                aria-hidden="true"
                focusable="false"
              >
                <rect
                  x="1"
                  y="1"
                  width="20"
                  height="10"
                  rx="2"
                  fill={paint.fill}
                  stroke={paint.stroke}
                  strokeWidth={1.25}
                />
              </svg>
              <span className={styles.text}>
                {segment.label}
                <span className={styles.value}>
                  {valueFormat(segment.value) === formatPercent(segment.share, 0)
                    ? valueFormat(segment.value)
                    : `${valueFormat(segment.value)} · ${formatPercent(segment.share, 0)}`}
                </span>
              </span>
            </li>
          );
        })}
        {remainder > 0 ? (
          <li className={styles.item}>
            <svg
              className={styles.swatch}
              width="22"
              height="12"
              viewBox="0 0 22 12"
              aria-hidden="true"
              focusable="false"
            >
              <rect
                x="1"
                y="1"
                width="20"
                height="10"
                rx="2"
                fill="none"
                stroke={cg.borderControl}
                strokeDasharray="3 2"
                strokeWidth={1.25}
              />
            </svg>
            <span className={styles.text}>
              Remainder
              <span className={styles.value}>{valueFormat(remainder)}</span>
            </span>
          </li>
        ) : null}
      </ul>
      <ChartTable
        caption={summary}
        headers={['Part', valueLabel, 'Share']}
        rows={resolved.map((s) => [s.label, valueFormat(s.value), formatPercent(s.share, 1)])}
      />
    </figure>
  );
}
