'use client';

import { ScrollRegion, SvgPatternDefs, cg, patternUrl, useSafeId } from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { useMemo } from 'react';
import { type Chronology } from '../model/chronology';
import { layoutStrip, type StripShape } from '../model/strip';

const useStyles = makeStyles({
  figure: { margin: 0, display: 'flex', flexDirection: 'column', gap: cg.space[2], minWidth: 0 },
  scroller: {
    borderRadius: cg.radius.md,
    border: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surface,
  },
  svg: { display: 'block', minWidth: '720px', width: '100%', height: 'auto' },
  caption: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    fontSize: tokens.fontSizeBase200,
    color: cg.textSecondary,
  },
  legend: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: `${cg.space[1]} ${cg.space[4]}`,
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  legendItem: { display: 'inline-flex', alignItems: 'center', gap: cg.space[1] },
  note: { margin: 0, color: cg.textMuted },
});

const LANE_TONE = {
  customer: cg.tone.evidence,
  engineer: cg.tone.actual,
  system: cg.tone.neutral,
  decisions: cg.tone.fork,
} as const;

function Shape({
  shape,
  x,
  y,
  size,
  fill,
  stroke,
}: {
  shape: StripShape;
  x: number;
  y: number;
  size: number;
  fill: string;
  stroke: string;
}) {
  const common = { fill, stroke, strokeWidth: 1.5, strokeLinejoin: 'round' as const };
  if (shape === 'circle') return <circle cx={x} cy={y} r={size} {...common} />;
  if (shape === 'square')
    return <rect x={x - size} y={y - size} width={size * 2} height={size * 2} rx={2} {...common} />;
  if (shape === 'triangle')
    return (
      <path
        d={`M${x} ${y - size - 1}L${x + size + 1} ${y + size}L${x - size - 1} ${y + size}Z`}
        {...common}
      />
    );
  return (
    <path d={`M${x} ${y - size}L${x + size} ${y}L${x} ${y + size}L${x - size} ${y}Z`} {...common} />
  );
}

function LegendShape({ shape, tone }: { shape: StripShape; tone: keyof typeof LANE_TONE }) {
  const colors = LANE_TONE[tone];
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <Shape
        shape={shape}
        x={8}
        y={8}
        size={shape === 'diamond' ? 7 : 5}
        fill={colors.solid}
        stroke={colors.border}
      />
    </svg>
  );
}

/**
 * The chronology as a picture: a row per side (customer, engineer, system), the key events as markers whose shape tells
 * the side as well as their row, the numbered decision points above them, the meaningful waits as shaded bands, and the
 * days along the bottom. It stands for the list under it, which has the same events in words: the picture itself is one
 * image with the whole summary as its text. The spacing is compressed (not to scale) and says so.
 */
export function ChronologyStrip({ chronology }: { chronology: Chronology }) {
  const styles = useStyles();
  const prefix = useSafeId('strip');
  const geometry = useMemo(() => layoutStrip(chronology), [chronology]);
  const { rows, plot, axis } = geometry;
  return (
    <figure className={styles.figure}>
      <ScrollRegion label="Chronology strip, scrollable" className={styles.scroller}>
        <svg
          role="img"
          aria-label={`Chronology strip. ${chronology.summary}`}
          className={styles.svg}
          viewBox={`0 0 ${geometry.width} ${geometry.height}`}
        >
          <SvgPatternDefs idPrefix={prefix} tones={['uncertain']} kinds={['dots']} />
          {rows.map((row, index) => (
            <g key={row.id} aria-hidden="true">
              <rect
                x={0}
                y={row.y}
                width={geometry.width}
                height={row.height}
                fill={index % 2 === 0 ? cg.surfaceSunken : cg.surface}
              />
              <text
                x={12}
                y={row.y + row.height / 2}
                dominantBaseline="middle"
                fontSize={13}
                fontWeight={600}
                fill={cg.text}
              >
                {row.label}
              </text>
              <line
                x1={plot.x1}
                x2={plot.x2}
                y1={row.y + row.height / 2}
                y2={row.y + row.height / 2}
                stroke={cg.borderSubtle}
              />
            </g>
          ))}
          {geometry.waits.map((wait) => (
            <g key={wait.id} aria-hidden="true">
              <rect
                x={wait.x}
                y={plot.y1}
                width={wait.width}
                height={plot.y2 - plot.y1}
                fill={patternUrl(prefix, 'dots', 'uncertain')}
                stroke={cg.tone.uncertain.solid}
                strokeDasharray="4 3"
                strokeOpacity={0.7}
              />
              {wait.label ? (
                <text
                  x={wait.x + wait.width / 2}
                  y={plot.y1 + 14}
                  textAnchor="middle"
                  fontSize={12}
                  fontWeight={600}
                  fill={cg.tone.uncertain.fg}
                  stroke={cg.surface}
                  strokeWidth={3}
                  paintOrder="stroke"
                >
                  {wait.label}
                </text>
              ) : null}
            </g>
          ))}
          {geometry.ticks.map((tick) => (
            <line
              key={tick.id}
              aria-hidden="true"
              x1={tick.x}
              x2={tick.x}
              y1={tick.y1}
              y2={tick.y2}
              stroke={cg.textMuted}
              strokeWidth={1.5}
              strokeLinecap="round"
            />
          ))}
          {geometry.markers.map((marker) => {
            const tone = LANE_TONE[marker.lane];
            const resolution = marker.reasons.includes('resolution');
            return (
              <g key={marker.id} aria-hidden="true">
                <title>{marker.title}</title>
                {resolution ? (
                  <circle
                    cx={marker.x}
                    cy={marker.y}
                    r={12}
                    fill="none"
                    stroke={cg.tone.productive.solid}
                    strokeWidth={2}
                  />
                ) : null}
                <Shape
                  shape={marker.shape}
                  x={marker.x}
                  y={marker.y}
                  size={marker.kind === 'decision' ? 10 : 6}
                  fill={tone.solid}
                  stroke={cg.surface}
                />
                {marker.number !== null ? (
                  <text
                    x={marker.x}
                    y={marker.y}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={12}
                    fontWeight={700}
                    fill={tone.onSolid}
                  >
                    {marker.number}
                  </text>
                ) : null}
              </g>
            );
          })}
          <g aria-hidden="true">
            <line x1={plot.x1} x2={plot.x2} y1={axis.y} y2={axis.y} stroke={cg.borderControl} />
            {axis.days.map((day) => (
              <g key={day.label}>
                <line x1={day.x} x2={day.x} y1={axis.y} y2={axis.y + 6} stroke={cg.borderControl} />
                <text
                  x={day.x}
                  y={axis.y + 22}
                  textAnchor="middle"
                  fontSize={12}
                  fill={cg.textSecondary}
                >
                  {day.label}
                </text>
              </g>
            ))}
          </g>
        </svg>
      </ScrollRegion>
      <figcaption className={styles.caption}>
        <ul className={styles.legend} aria-label="Legend">
          <li className={styles.legendItem}>
            <LegendShape shape="circle" tone="customer" /> Customer
          </li>
          <li className={styles.legendItem}>
            <LegendShape shape="square" tone="engineer" /> Engineer
          </li>
          <li className={styles.legendItem}>
            <LegendShape shape="triangle" tone="system" /> System
          </li>
          <li className={styles.legendItem}>
            <LegendShape shape="diamond" tone="decisions" /> Decision point (numbered)
          </li>
          <li className={styles.legendItem}>
            <svg width="22" height="14" viewBox="0 0 22 14" aria-hidden="true">
              <SvgPatternDefs idPrefix={`${prefix}-key`} tones={['uncertain']} kinds={['dots']} />
              <rect
                x="1"
                y="1"
                width="20"
                height="12"
                fill={patternUrl(`${prefix}-key`, 'dots', 'uncertain')}
                stroke={cg.tone.uncertain.solid}
                strokeDasharray="4 3"
              />
            </svg>{' '}
            Meaningful wait
          </li>
        </ul>
        <p className={styles.note}>
          Not to scale: the spacing is compressed so events close together stay readable beside a
          long wait. The list below has the same events in words, with their exact times.
        </p>
      </figcaption>
    </figure>
  );
}
