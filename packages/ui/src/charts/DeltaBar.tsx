'use client';

import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { ArrowDownIcon, ArrowUpIcon, MinusIcon } from 'lucide-react';
import { formatNumber } from '../format';
import { useSafeId } from '../hooks/useSafeId';
import { ProvenanceBadge } from '../primitives/ProvenanceBadge';
import { SvgPatternDefs, patternUrl } from '../primitives/SvgPatternDefs';
import { cg } from '../tokens/cg';
import { CHART_FONT_SIZE, ChartTable, useChartStyles, useElementWidth } from './ChartParts';
import { estimateTextWidth, linearScale, niceDomain } from './scales';

const useStyles = makeStyles({
  head: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: cg.space[2],
  },
  label: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.text,
  },
  delta: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: cg.space[1],
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: 'tabular-nums',
  },
  note: { margin: 0, fontSize: tokens.fontSizeBase200, color: cg.textMuted },
});

export interface DeltaBarProps {
  /** The measure being compared, for example "Time to diagnosis". Names the figure. */
  label: string;
  /** What actually happened. */
  actual: number;
  /** The simulated alternative. Always labelled as simulated. */
  counterfactual: number;
  /** Estimated range of the simulated value (whisker). */
  counterfactualLow?: number | null;
  counterfactualHigh?: number | null;
  /** Which direction is an improvement (default `lower`, as for time, effort and cost). */
  better?: 'lower' | 'higher';
  format?: (value: number) => string;
  actualLabel?: string;
  counterfactualLabel?: string;
  width?: number;
  className?: string;
}

/** Difference between the simulated and actual value. Exported for unit tests. */
export function computeDelta(
  actual: number,
  counterfactual: number,
  better: 'lower' | 'higher',
): { delta: number; percent: number | null; verdict: 'better' | 'worse' | 'no change' } {
  const delta = counterfactual - actual;
  const percent = actual === 0 ? null : (delta / Math.abs(actual)) * 100;
  if (delta === 0) return { delta, percent, verdict: 'no change' };
  const improved = better === 'lower' ? delta < 0 : delta > 0;
  return { delta, percent, verdict: improved ? 'better' : 'worse' };
}

/**
 * Actual vs counterfactual for one measure: a solid bar for what happened and a hatched, dashed bar (with a range
 * whisker) for the simulated alternative, followed by the delta in words. The simulated bar is always labelled.
 */
export function DeltaBar({
  label,
  actual,
  counterfactual,
  counterfactualLow = null,
  counterfactualHigh = null,
  better = 'lower',
  format = (n) => formatNumber(n, { maximumFractionDigits: 1 }),
  actualLabel = 'Actual',
  counterfactualLabel = 'Simulated',
  width: fixedWidth,
  className,
}: DeltaBarProps) {
  const styles = useStyles();
  const chart = useChartStyles();
  const idPrefix = useSafeId('db');
  const [measureRef, measured] = useElementWidth<HTMLDivElement>(420);
  const width = Math.max(220, fixedWidth ?? measured);
  const hasRange =
    counterfactualLow !== null &&
    counterfactualHigh !== null &&
    counterfactualHigh >= counterfactualLow;

  const top = Math.max(actual, counterfactual, hasRange ? counterfactualHigh : 0, 0);
  const domain = niceDomain(0, top <= 0 ? 1 : top, 4);
  const gutter =
    Math.ceil(
      Math.max(
        estimateTextWidth(actualLabel, CHART_FONT_SIZE),
        estimateTextWidth(counterfactualLabel, CHART_FONT_SIZE),
      ),
    ) + 14;
  const valueRoom =
    Math.ceil(
      Math.max(
        estimateTextWidth(format(actual), CHART_FONT_SIZE),
        estimateTextWidth(format(hasRange ? counterfactualHigh : counterfactual), CHART_FONT_SIZE),
      ),
    ) + 14;
  const scale = linearScale(domain, [gutter, Math.max(gutter + 40, width - valueRoom)]);
  const rowH = 26;
  const gap = 10;
  const height = rowH * 2 + gap + 4;

  const { delta, percent, verdict } = computeDelta(actual, counterfactual, better);
  const DeltaIcon = delta === 0 ? MinusIcon : delta < 0 ? ArrowDownIcon : ArrowUpIcon;
  const verdictTone =
    verdict === 'better'
      ? cg.tone.productive.fg
      : verdict === 'worse'
        ? cg.tone.unsupported.fg
        : cg.textSecondary;
  const deltaSign = delta > 0 ? '+' : delta < 0 ? '-' : '';
  const deltaText = `${deltaSign}${format(Math.abs(delta))}${percent === null ? '' : ` (${formatNumber(percent, { signed: true, maximumFractionDigits: 0 })}%)`}`;
  const alt = `${label}: ${actualLabel} ${format(actual)}; ${counterfactualLabel} ${format(counterfactual)}${hasRange ? `, estimated range ${format(counterfactualLow)} to ${format(counterfactualHigh)}` : ''}; ${verdict}, ${deltaText}`;

  const zero = scale(0);
  const actualEnd = scale(actual);
  const simEnd = scale(counterfactual);
  const rowY = [0, rowH + gap];

  return (
    <figure className={mergeClasses(chart.figure, className)}>
      <div className={styles.head}>
        <figcaption className={styles.label}>{label}</figcaption>
        <span className={styles.delta} style={{ color: verdictTone }}>
          <DeltaIcon aria-hidden="true" />
          {deltaText} · {verdict}
        </span>
      </div>
      <div ref={measureRef} className={chart.frame}>
        <svg
          role="img"
          aria-label={alt}
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          className={chart.svg}
        >
          <SvgPatternDefs idPrefix={idPrefix} tones={['simulated']} kinds={['hatch']} />
          <line x1={zero} x2={zero} y1={0} y2={height} stroke={cg.borderControl} strokeWidth={1} />
          <text
            x={gutter - 8}
            y={(rowY[0] ?? 0) + rowH / 2}
            textAnchor="end"
            dominantBaseline="middle"
            fill={cg.text}
            fontSize={CHART_FONT_SIZE}
          >
            {actualLabel}
          </text>
          <rect
            x={zero}
            y={rowY[0] ?? 0}
            width={Math.max(actualEnd - zero, 2)}
            height={rowH}
            rx={4}
            fill={cg.tone.actual.solid}
            stroke={cg.tone.actual.solid}
          />
          <text
            x={actualEnd + 8}
            y={(rowY[0] ?? 0) + rowH / 2}
            dominantBaseline="middle"
            fill={cg.text}
            fontSize={CHART_FONT_SIZE}
            fontWeight={600}
          >
            {format(actual)}
          </text>

          <text
            x={gutter - 8}
            y={(rowY[1] ?? 0) + rowH / 2}
            textAnchor="end"
            dominantBaseline="middle"
            fill={cg.tone.simulated.fg}
            fontSize={CHART_FONT_SIZE}
          >
            {counterfactualLabel}
          </text>
          <rect
            x={zero}
            y={rowY[1] ?? 0}
            width={Math.max(simEnd - zero, 2)}
            height={rowH}
            rx={4}
            fill={patternUrl(idPrefix, 'hatch', 'simulated')}
            stroke={cg.tone.simulated.solid}
            strokeWidth={1.75}
            strokeDasharray="5 3"
          />
          {hasRange ? (
            <g stroke={cg.text} strokeWidth={1.5}>
              <line
                x1={scale(counterfactualLow)}
                x2={scale(counterfactualHigh)}
                y1={(rowY[1] ?? 0) + rowH / 2}
                y2={(rowY[1] ?? 0) + rowH / 2}
              />
              <line
                x1={scale(counterfactualLow)}
                x2={scale(counterfactualLow)}
                y1={(rowY[1] ?? 0) + rowH / 2 - 5}
                y2={(rowY[1] ?? 0) + rowH / 2 + 5}
              />
              <line
                x1={scale(counterfactualHigh)}
                x2={scale(counterfactualHigh)}
                y1={(rowY[1] ?? 0) + rowH / 2 - 5}
                y2={(rowY[1] ?? 0) + rowH / 2 + 5}
              />
            </g>
          ) : null}
          <text
            x={scale(hasRange ? counterfactualHigh : counterfactual) + 8}
            y={(rowY[1] ?? 0) + rowH / 2}
            dominantBaseline="middle"
            fill={cg.text}
            fontSize={CHART_FONT_SIZE}
            fontWeight={600}
          >
            {format(counterfactual)}
          </text>
        </svg>
      </div>
      <p className={styles.note}>
        <ProvenanceBadge kind="simulated" /> The simulated value is a model estimate
        {hasRange ? ` (range ${format(counterfactualLow)} to ${format(counterfactualHigh)})` : ''},
        not something that happened.
      </p>
      <ChartTable
        caption={alt}
        headers={['Series', 'Value', 'Low', 'High']}
        rows={[
          [actualLabel, format(actual), '', ''],
          [
            counterfactualLabel,
            format(counterfactual),
            hasRange ? format(counterfactualLow) : '',
            hasRange ? format(counterfactualHigh) : '',
          ],
          ['Difference', deltaText, '', verdict],
        ]}
      />
    </figure>
  );
}
