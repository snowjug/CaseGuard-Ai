'use client';

import { mergeClasses } from '@fluentui/react-components';
import { useMemo, useState } from 'react';
import { VisuallyHidden } from '../a11y/VisuallyHidden';
import { formatDateTimeUtc, formatDayMonthUtc, formatNumber, formatTimeUtc } from '../format';
import { useSafeId } from '../hooks/useSafeId';
import { SvgPatternDefs, patternUrl } from '../primitives/SvgPatternDefs';
import { cg } from '../tokens/cg';
import type { ToneName } from '../tokens/palette';
import {
  CHART_FONT_SIZE,
  ChartInspector,
  ChartLegend,
  ChartTable,
  MarkerGlyph,
  SERIES_DASHES,
  SERIES_MARKERS,
  useChartStyles,
  useElementWidth,
  type LegendEntry,
} from './ChartParts';
import { bandPath, linePath, type Point } from './paths';
import { estimateTextWidth, extent, linearScale, niceDomain, niceTicks } from './scales';

export interface LinePoint {
  /** Position on the x axis: epoch milliseconds, an ISO timestamp (time axis) or a plain number. */
  x: number | string;
  y: number;
  /** Optional range around `y` (confidence band). A series draws a band only if every point has both. */
  low?: number;
  high?: number;
}

export interface LineSeries {
  id: string;
  label: string;
  points: readonly LinePoint[];
}

export interface LineChartEvent {
  x: number | string;
  label: string;
}

export interface LineChartProps {
  /** What the chart answers, for example "Hypothesis confidence over time". Names the figure. */
  title: string;
  series: readonly LineSeries[];
  /** Fixed y domain, for example `[0, 1]` for probabilities. Derived from the data when omitted. */
  yDomain?: readonly [number, number];
  yFormat?: (value: number) => string;
  /** `time` treats x as UTC timestamps. Defaults to `time` when any x is a string. */
  xKind?: 'time' | 'number';
  xFormat?: (value: number) => string;
  /** Vertical markers such as decision forks or escalations; numbered and listed under the chart. */
  events?: readonly LineChartEvent[];
  /** Name of the band, for example "Confidence range". */
  bandLabel?: string;
  height?: number;
  /** Fixed pixel width; measured from the container when omitted. */
  width?: number;
  /** Hide the visible title (it still names the figure). */
  hideTitle?: boolean;
  className?: string;
}

const SERIES_TONES: readonly ToneName[] = [
  'brand',
  'evidence',
  'hypothesis',
  'productive',
  'uncertain',
  'simulated',
];

interface PreparedPoint {
  x: number;
  y: number;
  low: number | undefined;
  high: number | undefined;
}
interface PreparedSeries {
  id: string;
  label: string;
  index: number;
  points: PreparedPoint[];
  hasBand: boolean;
}

function toMs(x: number | string): number {
  return typeof x === 'number' ? x : Date.parse(x);
}

/** Drops invalid points and sorts by x. Exported for unit tests. */
export function prepareSeries(series: readonly LineSeries[]): PreparedSeries[] {
  return series.map((s, index) => {
    const points = s.points
      .map((p): PreparedPoint => ({ x: toMs(p.x), y: p.y, low: p.low, high: p.high }))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
      .sort((a, b) => a.x - b.x);
    const hasBand =
      points.length > 0 && points.every((p) => p.low !== undefined && p.high !== undefined);
    return { id: s.id, label: s.label, index, points, hasBand };
  });
}

/** Accessible summary of every series. Exported for unit tests. */
export function summarizeLineChart(
  title: string,
  series: readonly PreparedSeries[],
  formatY: (n: number) => string,
  formatX: (n: number) => string,
): string {
  const populated = series.filter((s) => s.points.length > 0);
  if (populated.length === 0) return `${title}: no data to plot`;
  const parts = populated.map((s) => {
    const first = s.points[0];
    const last = s.points[s.points.length - 1];
    if (!first || !last) return s.label;
    if (s.points.length === 1)
      return `${s.label}: one value, ${formatY(first.y)} at ${formatX(first.x)}`;
    const delta = last.y - first.y;
    const trend = delta === 0 ? 'unchanged' : delta > 0 ? 'rising' : 'falling';
    return `${s.label}: ${s.points.length} points from ${formatY(first.y)} at ${formatX(first.x)} to ${formatY(last.y)} at ${formatX(last.x)}, ${trend}`;
  });
  return `${title}. ${parts.join('. ')}.`;
}

/**
 * Multi-series line chart with optional confidence bands and numbered event markers.
 * Series differ by colour, dash pattern and marker shape; bands are hatched. Keyboard users inspect values with the
 * focusable slider overlay (arrows, Home, End); screen reader users get the summary and a full data table.
 */
export function LineChart({
  title,
  series: rawSeries,
  yDomain,
  yFormat = (n) => formatNumber(n, { maximumFractionDigits: 2 }),
  xKind,
  xFormat,
  events = [],
  bandLabel = 'Range',
  height = 240,
  width: fixedWidth,
  hideTitle = false,
  className,
}: LineChartProps) {
  const styles = useChartStyles();
  const idPrefix = useSafeId('lc');
  const [measureRef, measured] = useElementWidth<HTMLDivElement>(640);
  const width = Math.max(240, fixedWidth ?? measured);
  const [cursor, setCursor] = useState<number | null>(null);

  const series = useMemo(() => prepareSeries(rawSeries), [rawSeries]);
  const isTime = xKind
    ? xKind === 'time'
    : rawSeries.some((s) => s.points.some((p) => typeof p.x === 'string'));

  const allX = useMemo(
    () => [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))].sort((a, b) => a - b),
    [series],
  );
  const xRange = extent(allX);
  const spanMs = xRange ? xRange[1] - xRange[0] : 0;

  const formatX = (value: number): string => {
    if (xFormat) return xFormat(value);
    if (!isTime) return formatNumber(value, { maximumFractionDigits: 2 });
    return spanMs < 36 * 3_600_000
      ? formatTimeUtc(value)
      : formatDayMonthUtc(value, spanMs > 300 * 86_400_000);
  };
  const formatXLong = (value: number): string =>
    xFormat ? xFormat(value) : isTime ? formatDateTimeUtc(value) : formatX(value);

  const valueExtent = extent(
    series.flatMap((s) =>
      s.points.flatMap((p) => [
        p.y,
        ...(p.low !== undefined ? [p.low] : []),
        ...(p.high !== undefined ? [p.high] : []),
      ]),
    ),
  );
  const domain: [number, number] = yDomain
    ? [yDomain[0], yDomain[1]]
    : valueExtent
      ? niceDomain(valueExtent[0], valueExtent[1], 5)
      : [0, 1];
  const yTicks = niceTicks(domain[0], domain[1], 5);

  const longestTick = yTicks.reduce(
    (max, t) => Math.max(max, estimateTextWidth(yFormat(t), CHART_FONT_SIZE)),
    0,
  );
  const margin = {
    top: events.length > 0 ? 24 : 10,
    right: 14,
    bottom: 28,
    left: Math.ceil(longestTick) + 14,
  };
  const plotW = Math.max(40, width - margin.left - margin.right);
  const plotH = Math.max(40, height - margin.top - margin.bottom);

  const xScale = linearScale(xRange ?? [0, 1], [margin.left, margin.left + plotW]);
  const yScale = linearScale(domain, [margin.top + plotH, margin.top]);

  const xTickCount = Math.max(2, Math.min(7, Math.floor(plotW / 96)));
  const xTicks: number[] = !xRange
    ? []
    : xRange[0] === xRange[1]
      ? [xRange[0]]
      : isTime
        ? Array.from(
            { length: xTickCount },
            (_, i) => xRange[0] + ((xRange[1] - xRange[0]) * i) / (xTickCount - 1),
          )
        : niceTicks(xRange[0], xRange[1], xTickCount).filter(
            (t) => t >= xRange[0] && t <= xRange[1],
          );

  const eventList = events
    .map((e, i) => ({ number: i + 1, x: toMs(e.x), label: e.label }))
    .filter((e) => Number.isFinite(e.x) && xRange !== null && e.x >= xRange[0] && e.x <= xRange[1]);

  const summary = summarizeLineChart(title, series, yFormat, formatXLong);
  const populated = series.filter((s) => s.points.length > 0);
  const anyBand = populated.some((s) => s.hasBand);
  const tonesUsed = [
    ...new Set(
      series
        .filter((s) => s.hasBand)
        .map((s) => SERIES_TONES[s.index % SERIES_TONES.length] ?? 'brand'),
    ),
  ];

  const colorOf = (index: number): string =>
    cg.series[index % cg.series.length] ?? cg.tone.brand.solid;
  const coords = (s: PreparedSeries): Point[] => s.points.map((p) => [xScale(p.x), yScale(p.y)]);

  const cursorX = cursor !== null ? allX[cursor] : undefined;
  const cursorValues =
    cursorX === undefined
      ? []
      : series.map((s) => ({ series: s, point: s.points.find((p) => p.x === cursorX) }));
  const cursorText =
    cursorX === undefined
      ? ''
      : `${formatXLong(cursorX)}: ${cursorValues
          .map(
            ({ series: s, point }) =>
              `${s.label} ${point ? yFormat(point.y) : 'no value'}${point?.low !== undefined && point.high !== undefined ? ` (range ${yFormat(point.low)} to ${yFormat(point.high)})` : ''}`,
          )
          .join(', ')}`;

  const indexFromPointer = (px: number): number => {
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    allX.forEach((x, i) => {
      const distance = Math.abs(xScale(x) - px);
      if (distance < bestDistance) {
        best = i;
        bestDistance = distance;
      }
    });
    return best;
  };

  const legend: LegendEntry[] = [
    ...populated.map((s) => ({
      key: s.id,
      label: s.label,
      swatch: (
        <>
          <path
            d="M1 6H27"
            stroke={colorOf(s.index)}
            strokeWidth={2}
            strokeDasharray={SERIES_DASHES[s.index % SERIES_DASHES.length]}
            fill="none"
          />
          <MarkerGlyph
            shape={SERIES_MARKERS[s.index % SERIES_MARKERS.length] ?? 'circle'}
            x={14}
            y={6}
            radius={3.25}
            color={colorOf(s.index)}
          />
        </>
      ),
    })),
    ...(anyBand
      ? [
          {
            key: '__band',
            label: bandLabel,
            swatch: (
              <rect
                x="1"
                y="1"
                width="26"
                height="10"
                rx="2"
                fill={patternUrl(idPrefix, 'hatch', tonesUsed[0] ?? 'brand')}
                stroke={cg.borderControl}
                strokeWidth={1}
              />
            ),
          },
        ]
      : []),
  ];

  const tableHeaders = [
    'When',
    ...populated.flatMap((s) =>
      s.hasBand ? [s.label, `${s.label} low`, `${s.label} high`] : [s.label],
    ),
  ];
  const tableRows = allX.map((x) => [
    formatXLong(x),
    ...populated.flatMap((s) => {
      const p = s.points.find((candidate) => candidate.x === x);
      const value = p ? yFormat(p.y) : '';
      return s.hasBand
        ? [
            value,
            p?.low !== undefined ? yFormat(p.low) : '',
            p?.high !== undefined ? yFormat(p.high) : '',
          ]
        : [value];
    }),
  ]);

  return (
    <figure className={mergeClasses(styles.figure, className)}>
      <figcaption className={hideTitle ? undefined : styles.caption}>
        {hideTitle ? <VisuallyHidden>{title}</VisuallyHidden> : title}
      </figcaption>
      <div ref={measureRef} className={styles.frame}>
        <svg
          role="img"
          aria-label={summary}
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          className={styles.svg}
        >
          <SvgPatternDefs idPrefix={idPrefix} tones={tonesUsed} kinds={['hatch']} />
          {populated.length === 0 ? (
            <text x={width / 2} y={height / 2} textAnchor="middle" className={styles.empty}>
              No data to plot yet
            </text>
          ) : (
            <>
              {yTicks.map((tick) => (
                <g key={`y-${tick}`}>
                  <line
                    x1={margin.left}
                    x2={margin.left + plotW}
                    y1={yScale(tick)}
                    y2={yScale(tick)}
                    stroke={cg.borderSubtle}
                    strokeWidth={1}
                  />
                  <text
                    x={margin.left - 8}
                    y={yScale(tick)}
                    textAnchor="end"
                    dominantBaseline="middle"
                    fill={cg.textSecondary}
                    fontSize={CHART_FONT_SIZE}
                  >
                    {yFormat(tick)}
                  </text>
                </g>
              ))}
              {xTicks.map((tick) => (
                <text
                  key={`x-${tick}`}
                  x={xScale(tick)}
                  y={margin.top + plotH + 18}
                  textAnchor="middle"
                  fill={cg.textSecondary}
                  fontSize={CHART_FONT_SIZE}
                >
                  {formatX(tick)}
                </text>
              ))}
              <line
                x1={margin.left}
                x2={margin.left + plotW}
                y1={margin.top + plotH}
                y2={margin.top + plotH}
                stroke={cg.borderControl}
                strokeWidth={1}
              />

              {populated
                .filter((s) => s.hasBand && s.points.length > 1)
                .map((s) => {
                  const upper: Point[] = s.points.map((p) => [xScale(p.x), yScale(p.high ?? p.y)]);
                  const lower: Point[] = s.points.map((p) => [xScale(p.x), yScale(p.low ?? p.y)]);
                  const tone = SERIES_TONES[s.index % SERIES_TONES.length] ?? 'brand';
                  return (
                    <path
                      key={`band-${s.id}`}
                      d={bandPath(upper, lower)}
                      fill={patternUrl(idPrefix, 'hatch', tone)}
                      stroke={colorOf(s.index)}
                      strokeOpacity={0.5}
                      strokeWidth={1}
                    />
                  );
                })}
              {populated
                .filter((s) => s.hasBand && s.points.length === 1)
                .map((s) => {
                  const p = s.points[0];
                  if (!p) return null;
                  return (
                    <line
                      key={`whisker-${s.id}`}
                      x1={xScale(p.x)}
                      x2={xScale(p.x)}
                      y1={yScale(p.low ?? p.y)}
                      y2={yScale(p.high ?? p.y)}
                      stroke={colorOf(s.index)}
                      strokeWidth={3}
                      strokeLinecap="round"
                    />
                  );
                })}

              {eventList.map((e) => (
                <g key={`ev-${e.number}`}>
                  <line
                    x1={xScale(e.x)}
                    x2={xScale(e.x)}
                    y1={margin.top - 4}
                    y2={margin.top + plotH}
                    stroke={cg.textMuted}
                    strokeWidth={1}
                    strokeDasharray="3 3"
                  />
                  <circle
                    cx={xScale(e.x)}
                    cy={margin.top - 12}
                    r={9}
                    fill={cg.surface}
                    stroke={cg.textSecondary}
                    strokeWidth={1.5}
                  />
                  <text
                    x={xScale(e.x)}
                    y={margin.top - 12}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill={cg.text}
                    fontSize={CHART_FONT_SIZE}
                    fontWeight={600}
                  >
                    {e.number}
                  </text>
                </g>
              ))}

              {populated.map((s) => (
                <g key={s.id}>
                  {s.points.length > 1 ? (
                    <path
                      d={linePath(coords(s))}
                      fill="none"
                      stroke={colorOf(s.index)}
                      strokeWidth={2.25}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                      strokeDasharray={SERIES_DASHES[s.index % SERIES_DASHES.length]}
                    />
                  ) : null}
                  {s.points.length <= 40
                    ? s.points.map((p) => (
                        <MarkerGlyph
                          key={p.x}
                          shape={SERIES_MARKERS[s.index % SERIES_MARKERS.length] ?? 'circle'}
                          x={xScale(p.x)}
                          y={yScale(p.y)}
                          radius={3.5}
                          color={colorOf(s.index)}
                        />
                      ))
                    : null}
                </g>
              ))}

              {cursorX !== undefined ? (
                <g aria-hidden="true">
                  <line
                    x1={xScale(cursorX)}
                    x2={xScale(cursorX)}
                    y1={margin.top}
                    y2={margin.top + plotH}
                    stroke={cg.text}
                    strokeWidth={1}
                  />
                  {cursorValues.map(({ series: s, point }) =>
                    point ? (
                      <circle
                        key={s.id}
                        cx={xScale(point.x)}
                        cy={yScale(point.y)}
                        r={5.5}
                        fill="none"
                        stroke={cg.text}
                        strokeWidth={2}
                      />
                    ) : null,
                  )}
                </g>
              ) : null}
            </>
          )}
        </svg>
        {allX.length > 1 ? (
          <ChartInspector
            label={`Inspect values: ${title}`}
            count={allX.length}
            index={cursor}
            onIndexChange={setCursor}
            valueText={cursorText}
            height={height}
            indexFromPointer={indexFromPointer}
          />
        ) : null}
        {cursorX !== undefined ? (
          <div
            aria-hidden="true"
            className={styles.tooltip}
            style={{
              top: margin.top,
              left: xScale(cursorX) > width * 0.6 ? undefined : xScale(cursorX) + 12,
              right: xScale(cursorX) > width * 0.6 ? width - xScale(cursorX) + 12 : undefined,
            }}
          >
            <div className={styles.tooltipTitle}>{formatXLong(cursorX)}</div>
            {cursorValues.map(({ series: s, point }) => (
              <div key={s.id}>
                {s.label}: {point ? yFormat(point.y) : 'â€”'}
                {point?.low !== undefined && point.high !== undefined
                  ? ` (${yFormat(point.low)}â€“${yFormat(point.high)})`
                  : ''}
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <ChartLegend entries={legend} label={`${title} legend`} />
      {eventList.length > 0 ? (
        <ol
          style={{
            margin: 0,
            paddingLeft: 0,
            listStyle: 'none',
            display: 'flex',
            flexWrap: 'wrap',
            gap: '4px 16px',
            fontSize: CHART_FONT_SIZE,
            color: cg.textSecondary,
          }}
        >
          {eventList.map((e) => (
            <li key={e.number}>
              <strong style={{ color: cg.text }}>{e.number}</strong> {e.label} ({formatXLong(e.x)})
            </li>
          ))}
        </ol>
      ) : null}
      <ChartTable
        caption={summary}
        headers={tableHeaders}
        rows={[
          ...tableRows,
          ...eventList.map((e) => [`Event ${e.number}: ${e.label}`, formatXLong(e.x)]),
        ]}
      />
    </figure>
  );
}
