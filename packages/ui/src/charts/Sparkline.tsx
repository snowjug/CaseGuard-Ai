'use client';

import { mergeClasses } from '@fluentui/react-components';
import { cg } from '../tokens/cg';
import type { ToneName } from '../tokens/palette';
import { formatNumber } from '../format';
import { ChartTable, useChartStyles } from './ChartParts';
import { linePath, type Point } from './paths';
import { extent, linearScale, niceDomain } from './scales';

export interface SparklinePoint {
  /** Label of the point for the data table (a date, a run id...). */
  label?: string;
  value: number;
}

export interface SparklineProps {
  /** Ordered values (oldest first), as numbers or labelled points. */
  values: readonly (number | SparklinePoint)[];
  /** What the sparkline shows; becomes the start of the text alternative: "CQI over the last 6 runs". */
  label: string;
  width?: number;
  height?: number;
  tone?: ToneName;
  /** Formats values in the text alternative and data table. */
  format?: (value: number) => string;
  className?: string;
}

const normalise = (values: SparklineProps['values']): SparklinePoint[] =>
  values
    .map((v, index): SparklinePoint =>
      typeof v === 'number'
        ? { value: v, label: `Point ${index + 1}` }
        : { ...v, label: v.label ?? `Point ${index + 1}` },
    )
    .filter((p) => Number.isFinite(p.value));

/** Text alternative for a series: count, first and last values, range and net change. Pure, so it is unit tested. */
export function summarizeSeries(
  label: string,
  points: readonly { value: number }[],
  format: (n: number) => string,
): string {
  if (points.length === 0) return `${label}: no data`;
  const first = points[0]?.value ?? 0;
  const last = points[points.length - 1]?.value ?? 0;
  if (points.length === 1) return `${label}: a single value, ${format(first)}`;
  const range = extent(points.map((p) => p.value));
  const change = last - first;
  const direction = change === 0 ? 'unchanged' : change > 0 ? 'up' : 'down';
  return `${label}: ${points.length} points, from ${format(first)} to ${format(last)} (${direction}), lowest ${format(range?.[0] ?? first)}, highest ${format(range?.[1] ?? last)}`;
}

/**
 * Tiny inline trend. It answers one question: "which way is this moving?". A single point is drawn as a dot,
 * no data as a dashed baseline. The accessible equivalent is the `aria-label` plus a hidden data table.
 */
export function Sparkline({
  values,
  label,
  width = 96,
  height = 28,
  tone = 'brand',
  format = (n) => formatNumber(n, { maximumFractionDigits: 2 }),
  className,
}: SparklineProps) {
  const styles = useChartStyles();
  const points = normalise(values);
  const color = cg.tone[tone].solid;
  const pad = 3;
  const summary = summarizeSeries(label, points, format);

  const xs = linearScale([0, Math.max(points.length - 1, 1)], [pad, width - pad]);
  const range = extent(points.map((p) => p.value));
  const ys = linearScale(range ? niceDomain(range[0], range[1], 3) : [0, 1], [height - pad, pad]);
  const coordinates: Point[] = points.map((p, i) => [
    points.length === 1 ? width / 2 : xs(i),
    ys(p.value),
  ]);
  const lastPoint = coordinates[coordinates.length - 1];

  return (
    <span
      className={mergeClasses(styles.frame, className)}
      style={{ display: 'inline-block', width, height }}
    >
      <svg
        role="img"
        aria-label={summary}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className={styles.svg}
      >
        {points.length === 0 ? (
          <line
            x1={pad}
            x2={width - pad}
            y1={height / 2}
            y2={height / 2}
            stroke={cg.borderControl}
            strokeWidth={1.5}
            strokeDasharray="3 3"
          />
        ) : (
          <>
            {points.length > 1 ? (
              <path
                d={linePath(coordinates)}
                fill="none"
                stroke={color}
                strokeWidth={1.75}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ) : null}
            {lastPoint ? (
              <circle
                cx={lastPoint[0]}
                cy={lastPoint[1]}
                r={2.75}
                fill={color}
                stroke={cg.surface}
                strokeWidth={1.25}
              />
            ) : null}
          </>
        )}
      </svg>
      <ChartTable
        caption={summary}
        headers={['Point', 'Value']}
        rows={points.map((p) => [p.label ?? '', format(p.value)])}
      />
    </span>
  );
}
