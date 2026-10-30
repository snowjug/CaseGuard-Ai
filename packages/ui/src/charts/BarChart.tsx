'use client';

import { mergeClasses } from '@fluentui/react-components';
import { useState } from 'react';
import { formatNumber } from '../format';
import { useSafeId } from '../hooks/useSafeId';
import { SvgPatternDefs, patternUrl, type SvgPatternKind } from '../primitives/SvgPatternDefs';
import { cg } from '../tokens/cg';
import type { ToneName } from '../tokens/palette';
import {
  CHART_FONT_SIZE,
  ChartInspector,
  ChartLegend,
  ChartTable,
  useChartStyles,
  useElementWidth,
  type LegendEntry,
} from './ChartParts';
import {
  bandScale,
  estimateTextWidth,
  extent,
  linearScale,
  niceDomain,
  niceTicks,
  truncateToWidth,
} from './scales';

export interface BarDatum {
  key: string;
  label: string;
  value: number;
  /** Optional range whisker (for estimates). */
  low?: number;
  high?: number;
  /** Colour role. Also picks the texture: simulated = hatch, uncertain = dots, unsupported = cross-hatch. */
  tone?: ToneName;
  /** Extra text for the tooltip and data table. */
  note?: string;
}

export interface BarChartProps {
  /** What the chart answers. Names the figure. */
  title: string;
  data: readonly BarDatum[];
  /** Horizontal bars read best with long labels (default). */
  orientation?: 'horizontal' | 'vertical';
  valueFormat?: (value: number) => string;
  /** Fixed value axis maximum (for example 100). */
  max?: number;
  /** Header of the value column in the data table. */
  valueLabel?: string;
  height?: number;
  width?: number;
  hideTitle?: boolean;
  className?: string;
}

/** Texture that accompanies a tone, so bars never depend on colour alone. */
export function patternForTone(tone: ToneName): SvgPatternKind | 'solid' {
  switch (tone) {
    case 'simulated':
      return 'hatch';
    case 'uncertain':
      return 'dots';
    case 'unsupported':
      return 'crosshatch';
    default:
      return 'solid';
  }
}

const ROW = 30;

/** Accessible summary: counts and the largest / smallest bars. Exported for unit tests. */
export function summarizeBars(
  title: string,
  data: readonly BarDatum[],
  format: (n: number) => string,
): string {
  if (data.length === 0) return `${title}: no data to plot`;
  const sorted = [...data].sort((a, b) => b.value - a.value);
  const top = sorted[0];
  const bottom = sorted[sorted.length - 1];
  if (!top || !bottom) return `${title}: no data to plot`;
  if (data.length === 1) return `${title}: one bar, ${top.label} ${format(top.value)}`;
  return `${title}: ${data.length} bars. Highest ${top.label}, ${format(top.value)}. Lowest ${bottom.label}, ${format(bottom.value)}`;
}

/**
 * Bar chart with optional range whiskers. Bars carry value labels, a texture per tone and a keyboard inspector;
 * the accessible equivalent is a text summary plus a hidden data table.
 */
export function BarChart({
  title,
  data,
  orientation = 'horizontal',
  valueFormat = (n) => formatNumber(n, { maximumFractionDigits: 1 }),
  max,
  valueLabel = 'Value',
  height: fixedHeight,
  width: fixedWidth,
  hideTitle = false,
  className,
}: BarChartProps) {
  const styles = useChartStyles();
  const idPrefix = useSafeId('bc');
  const [measureRef, measured] = useElementWidth<HTMLDivElement>(560);
  const [cursor, setCursor] = useState<number | null>(null);
  const width = Math.max(240, fixedWidth ?? measured);
  const horizontal = orientation === 'horizontal';

  const values = data.flatMap((d) => [d.value, ...(d.high !== undefined ? [d.high] : [])]);
  const valueExtent = extent(values);
  const upper = max ?? (valueExtent ? niceDomain(0, Math.max(valueExtent[1], 0), 5)[1] : 1);
  const domain: [number, number] = [Math.min(0, valueExtent?.[0] ?? 0), upper === 0 ? 1 : upper];
  const ticks = niceTicks(domain[0], domain[1], 5);

  const labelFont = CHART_FONT_SIZE;
  const longestLabel = data.reduce((m, d) => Math.max(m, estimateTextWidth(d.label, labelFont)), 0);
  const longestValue = data.reduce(
    (m, d) => Math.max(m, estimateTextWidth(valueFormat(d.high ?? d.value), labelFont)),
    0,
  );
  const longestTick = ticks.reduce(
    (m, tick) => Math.max(m, estimateTextWidth(valueFormat(tick), labelFont)),
    0,
  );
  const gutter = horizontal ? Math.min(Math.ceil(longestLabel) + 12, Math.floor(width * 0.42)) : 40;
  const margin = horizontal
    ? { top: 6, right: Math.ceil(longestValue) + 18, bottom: 26, left: gutter }
    : { top: 22, right: 8, bottom: 40, left: Math.ceil(longestTick) + 12 };
  const height =
    fixedHeight ??
    (horizontal ? Math.max(90, data.length * ROW + margin.top + margin.bottom) : 240);
  const plotW = Math.max(40, width - margin.left - margin.right);
  const plotH = Math.max(40, height - margin.top - margin.bottom);

  const valueScale = horizontal
    ? linearScale(domain, [margin.left, margin.left + plotW])
    : linearScale(domain, [margin.top + plotH, margin.top]);
  const bands = bandScale(
    data.length,
    horizontal ? [margin.top, margin.top + plotH] : [margin.left, margin.left + plotW],
    horizontal ? 0.3 : 0.35,
  );
  const zero = valueScale(0);

  const summary = summarizeBars(title, data, valueFormat);
  const tonesUsed = [...new Set(data.map((d) => d.tone ?? 'brand'))];
  const colorFor = (d: BarDatum): string => cg.tone[d.tone ?? 'brand'].solid;

  const legend: LegendEntry[] = tonesUsed
    .filter((tone) => patternForTone(tone) !== 'solid' || tonesUsed.length > 1)
    .map((tone) => {
      const pattern = patternForTone(tone);
      return {
        key: tone,
        label:
          tone === 'simulated'
            ? 'Simulated'
            : tone === 'uncertain'
              ? 'Uncertain'
              : tone === 'unsupported'
                ? 'Unsupported'
                : tone.charAt(0).toUpperCase() + tone.slice(1),
        swatch: (
          <rect
            x="1"
            y="1"
            width="26"
            height="10"
            rx="2"
            fill={pattern === 'solid' ? cg.tone[tone].solid : patternUrl(idPrefix, pattern, tone)}
            stroke={cg.tone[tone].solid}
            strokeWidth={1.25}
          />
        ),
      };
    });

  const focused = cursor !== null ? data[cursor] : undefined;
  const cursorText = focused
    ? `${focused.label}: ${valueFormat(focused.value)}${focused.low !== undefined && focused.high !== undefined ? `, range ${valueFormat(focused.low)} to ${valueFormat(focused.high)}` : ''}${focused.note ? `. ${focused.note}` : ''}`
    : '';

  const indexFromPointer = (px: number, py: number): number => {
    const position = horizontal ? py : px;
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    bands.forEach((band, i) => {
      const distance = Math.abs(band.center - position);
      if (distance < bestDistance) {
        best = i;
        bestDistance = distance;
      }
    });
    return best;
  };

  return (
    <figure className={mergeClasses(styles.figure, className)}>
      <figcaption className={hideTitle ? undefined : styles.caption}>{title}</figcaption>
      <div ref={measureRef} className={styles.frame}>
        <svg
          role="img"
          aria-label={summary}
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          className={styles.svg}
        >
          <SvgPatternDefs
            idPrefix={idPrefix}
            tones={tonesUsed}
            kinds={['hatch', 'dots', 'crosshatch']}
          />
          {data.length === 0 ? (
            <text x={width / 2} y={height / 2} textAnchor="middle" className={styles.empty}>
              No data to plot yet
            </text>
          ) : (
            <>
              {ticks.map((tick) => {
                const pos = valueScale(tick);
                return horizontal ? (
                  <g key={tick}>
                    <line
                      x1={pos}
                      x2={pos}
                      y1={margin.top}
                      y2={margin.top + plotH}
                      stroke={cg.borderSubtle}
                      strokeWidth={1}
                    />
                    <text
                      x={pos}
                      y={margin.top + plotH + 16}
                      textAnchor="middle"
                      fill={cg.textSecondary}
                      fontSize={CHART_FONT_SIZE}
                    >
                      {valueFormat(tick)}
                    </text>
                  </g>
                ) : (
                  <g key={tick}>
                    <line
                      x1={margin.left}
                      x2={margin.left + plotW}
                      y1={pos}
                      y2={pos}
                      stroke={cg.borderSubtle}
                      strokeWidth={1}
                    />
                    <text
                      x={margin.left - 6}
                      y={pos + 4}
                      textAnchor="end"
                      fill={cg.textSecondary}
                      fontSize={CHART_FONT_SIZE}
                    >
                      {valueFormat(tick)}
                    </text>
                  </g>
                );
              })}
              {data.map((d, i) => {
                const band = bands[i];
                if (!band) return null;
                const pattern = patternForTone(d.tone ?? 'brand');
                const tone = d.tone ?? 'brand';
                const fill =
                  pattern === 'solid' ? colorFor(d) : patternUrl(idPrefix, pattern, tone);
                const end = valueScale(d.value);
                const rect = horizontal
                  ? {
                      x: Math.min(zero, end),
                      y: band.start,
                      width: Math.max(Math.abs(end - zero), 2),
                      height: band.size,
                    }
                  : {
                      x: band.start,
                      y: Math.min(zero, end),
                      width: band.size,
                      height: Math.max(Math.abs(end - zero), 2),
                    };
                const isFocused = cursor === i;
                const whisker = d.low !== undefined && d.high !== undefined;
                const labelText = horizontal
                  ? truncateToWidth(d.label, gutter - 12, labelFont)
                  : truncateToWidth(d.label, band.size + 16, labelFont);
                return (
                  <g key={d.key}>
                    <title>{`${d.label}: ${valueFormat(d.value)}`}</title>
                    <rect
                      {...rect}
                      rx={3}
                      fill={fill}
                      stroke={colorFor(d)}
                      strokeWidth={isFocused ? 3 : 1.5}
                    />
                    {whisker ? (
                      horizontal ? (
                        <g stroke={cg.text} strokeWidth={1.5}>
                          <line
                            x1={valueScale(d.low ?? 0)}
                            x2={valueScale(d.high ?? 0)}
                            y1={band.center}
                            y2={band.center}
                          />
                          <line
                            x1={valueScale(d.low ?? 0)}
                            x2={valueScale(d.low ?? 0)}
                            y1={band.center - 4}
                            y2={band.center + 4}
                          />
                          <line
                            x1={valueScale(d.high ?? 0)}
                            x2={valueScale(d.high ?? 0)}
                            y1={band.center - 4}
                            y2={band.center + 4}
                          />
                        </g>
                      ) : (
                        <g stroke={cg.text} strokeWidth={1.5}>
                          <line
                            y1={valueScale(d.low ?? 0)}
                            y2={valueScale(d.high ?? 0)}
                            x1={band.center}
                            x2={band.center}
                          />
                          <line
                            y1={valueScale(d.low ?? 0)}
                            y2={valueScale(d.low ?? 0)}
                            x1={band.center - 4}
                            x2={band.center + 4}
                          />
                          <line
                            y1={valueScale(d.high ?? 0)}
                            y2={valueScale(d.high ?? 0)}
                            x1={band.center - 4}
                            x2={band.center + 4}
                          />
                        </g>
                      )
                    ) : null}
                    {horizontal ? (
                      <>
                        <text
                          x={margin.left - 8}
                          y={band.center}
                          textAnchor="end"
                          dominantBaseline="middle"
                          fill={cg.text}
                          fontSize={labelFont}
                        >
                          {labelText}
                        </text>
                        <text
                          x={valueScale(d.high ?? d.value) + 8}
                          y={band.center}
                          dominantBaseline="middle"
                          fill={cg.text}
                          fontSize={labelFont}
                          fontWeight={600}
                        >
                          {valueFormat(d.value)}
                        </text>
                      </>
                    ) : (
                      <>
                        <text
                          x={band.center}
                          y={margin.top + plotH + 16}
                          textAnchor="middle"
                          fill={cg.text}
                          fontSize={labelFont}
                        >
                          {labelText}
                        </text>
                        <text
                          x={band.center}
                          y={valueScale(d.high ?? d.value) - 8}
                          textAnchor="middle"
                          fill={cg.text}
                          fontSize={labelFont}
                          fontWeight={600}
                        >
                          {valueFormat(d.value)}
                        </text>
                      </>
                    )}
                  </g>
                );
              })}
              <line
                x1={horizontal ? zero : margin.left}
                x2={horizontal ? zero : margin.left + plotW}
                y1={horizontal ? margin.top : zero}
                y2={horizontal ? margin.top + plotH : zero}
                stroke={cg.borderControl}
                strokeWidth={1}
              />
            </>
          )}
        </svg>
        <ChartInspector
          label={`Inspect bars: ${title}`}
          count={data.length}
          index={cursor}
          onIndexChange={setCursor}
          valueText={cursorText}
          height={height}
          indexFromPointer={indexFromPointer}
          axis={horizontal ? 'y' : 'x'}
        />
      </div>
      <ChartLegend entries={legend} label={`${title} legend`} />
      <ChartTable
        caption={summary}
        headers={['Category', valueLabel, 'Low', 'High', 'Note']}
        rows={data.map((d) => [
          d.label,
          valueFormat(d.value),
          d.low !== undefined ? valueFormat(d.low) : '',
          d.high !== undefined ? valueFormat(d.high) : '',
          d.note ?? '',
        ])}
      />
    </figure>
  );
}
