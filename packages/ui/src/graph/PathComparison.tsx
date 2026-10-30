'use client';

import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { BranchForkRegular } from '@fluentui/react-icons';
import { useMemo } from 'react';
import { ChartTable, useElementWidth } from '../charts/ChartParts';
import { DeltaBar } from '../charts/DeltaBar';
import { cumulative, niceTicks } from '../charts/scales';
import { ScrollRegion } from '../a11y/ScrollRegion';
import { formatDuration } from '../format';
import { useSafeId } from '../hooks/useSafeId';
import { ProvenanceBadge } from '../primitives/ProvenanceBadge';
import { SvgPatternDefs, patternUrl } from '../primitives/SvgPatternDefs';
import { STATUS_META, type BadgeStatus } from '../primitives/status-meta';
import { cg } from '../tokens/cg';
import { shapePath, wrapLabel, type NodeShape } from './geometry';
import { KIND_META } from './node-meta';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: cg.space[3], margin: 0, minWidth: 0 },
  head: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: cg.space[2],
  },
  title: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.text,
  },
  scroller: {
    overflowX: 'auto',
    borderRadius: cg.radius.lg,
    border: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surface,
    padding: cg.space[2],
  },
  note: { margin: 0, fontSize: tokens.fontSizeBase200, color: cg.textMuted },
  strip: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
    gap: cg.space[4],
  },
  stripCard: {
    padding: cg.space[3],
    borderRadius: cg.radius.lg,
    border: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surface,
  },
});

export type PathStepKind = 'action' | 'evidence' | 'outcome' | 'fork';

export interface PathStep {
  id: string;
  label: string;
  kind?: PathStepKind;
  status?: BadgeStatus;
  /** Minutes this step took, including waiting before it. Drives the duration scale. */
  durationMinutes?: number | null;
  detail?: string;
}

export interface PathTrack {
  /** Track name, for example "Actual path" or "Simulated path". */
  label: string;
  steps: readonly PathStep[];
  /** Authoritative total from the API; otherwise the sum of the step durations is shown. */
  totalMinutes?: number | null;
}

export interface PathMetricDelta {
  key: string;
  label: string;
  actual: number;
  counterfactual: number;
  low?: number | null;
  high?: number | null;
  better?: 'lower' | 'higher';
  format?: (value: number) => string;
}

export interface PathComparisonProps {
  /** What actually happened, full path including the fork step. */
  actual: PathTrack;
  /** The simulated alternative: only the steps *after* the fork. Always drawn dashed and hatched. */
  counterfactual: PathTrack;
  /** Id of the actual step at which the two paths diverge. */
  forkStepId?: string | null;
  /** Names the fork, for example "Escalated before collecting logs". */
  forkLabel?: string;
  /** Per-metric actual-vs-simulated comparisons, drawn with `DeltaBar`. */
  metrics?: readonly PathMetricDelta[];
  title?: string;
  className?: string;
}

const PITCH = 124;
const GUTTER = 120;
const ROW_ACTUAL = 34;
const ROW_SIM = 178;
const MARKER_SCALE = 0.72;
const SCALE_TOP = 262;
const LABEL_WIDTH = PITCH - 14;

const SHAPE_FOR: Record<PathStepKind, NodeShape> = {
  action: 'square',
  evidence: 'circle',
  outcome: 'stadium',
  fork: 'diamond',
};

/** Sum of known step durations (minutes) or `null` when none is known. */
export function sumDurations(steps: readonly PathStep[]): number | null {
  let total = 0;
  let known = false;
  for (const step of steps) {
    if (
      step.durationMinutes !== null &&
      step.durationMinutes !== undefined &&
      Number.isFinite(step.durationMinutes)
    ) {
      total += step.durationMinutes;
      known = true;
    }
  }
  return known ? total : null;
}

/**
 * Two horizontal tracks: what happened (solid connectors) and the simulated alternative from the fork (dashed,
 * hatched, always labelled Simulated), with a fork marker, truncated step labels, a shared duration scale and a
 * strip of actual-vs-simulated metric deltas. Plain typed props: any page can feed it.
 */
export function PathComparison({
  actual,
  counterfactual,
  forkStepId = null,
  forkLabel,
  metrics = [],
  title = 'Actual path compared with the simulated alternative',
  className,
}: PathComparisonProps) {
  const styles = useStyles();
  const idPrefix = useSafeId('pc');
  const [measureRef, measured] = useElementWidth<HTMLDivElement>(900);

  const forkIndex = forkStepId ? actual.steps.findIndex((s) => s.id === forkStepId) : -1;
  const columns = Math.max(
    actual.steps.length,
    forkIndex >= 0 ? forkIndex + 1 + counterfactual.steps.length : counterfactual.steps.length,
    1,
  );
  const innerWidth = GUTTER + columns * PITCH + 16;
  const width = Math.max(innerWidth, 0);
  const height = SCALE_TOP + 74;

  const xOf = (column: number): number => GUTTER + column * PITCH + PITCH / 2;

  const actualTotal = actual.totalMinutes ?? sumDurations(actual.steps);
  const prefixMinutes =
    forkIndex >= 0 ? (sumDurations(actual.steps.slice(0, forkIndex + 1)) ?? 0) : 0;
  const simSteps = counterfactual.steps;
  const simOwn = sumDurations(simSteps);
  const simTotal = counterfactual.totalMinutes ?? (simOwn === null ? null : prefixMinutes + simOwn);
  const scaleMax = Math.max(actualTotal ?? 0, simTotal ?? 0);
  const scaleLeft = GUTTER;
  const scaleWidth = Math.max(120, columns * PITCH - 16);
  const scaleX = (minutes: number): number =>
    scaleLeft + (scaleMax === 0 ? 0 : (minutes / scaleMax) * scaleWidth);

  const simStart = forkIndex >= 0 ? forkIndex + 1 : 0;
  const summary = useMemo(() => {
    const a = `${actual.label}: ${actual.steps.length} steps${actualTotal === null ? '' : `, ${formatDuration(actualTotal)} in total`}`;
    const s = `${counterfactual.label} (simulated): ${simSteps.length} steps${simTotal === null ? '' : `, ${formatDuration(simTotal)} in total`}`;
    const f =
      forkIndex >= 0
        ? ` The paths diverge after step ${forkIndex + 1}${forkLabel ? `, ${forkLabel}` : ''}.`
        : '';
    return `${title}. ${a}. ${s}.${f}`;
  }, [actual, counterfactual, actualTotal, simTotal, simSteps.length, forkIndex, forkLabel, title]);

  const renderMarker = (
    step: PathStep,
    cx: number,
    cy: number,
    simulated: boolean,
    isFork: boolean,
  ) => {
    const kind: PathStepKind = isFork ? 'fork' : (step.kind ?? 'action');
    const shape = SHAPE_FOR[kind];
    const status = step.status ?? 'neutral';
    const t = simulated
      ? cg.tone.simulated
      : isFork
        ? cg.tone.fork
        : kind === 'evidence'
          ? cg.tone.evidence
          : cg.tone.actual;
    const fill = simulated
      ? patternUrl(idPrefix, 'hatch', 'simulated')
      : isFork || kind !== 'outcome'
        ? t.solid
        : t.tint;
    const iconColor = simulated
      ? cg.tone.simulated.fg
      : isFork || kind !== 'outcome'
        ? t.onSolid
        : t.fg;
    const StatusIcon = STATUS_META[status].icon;
    const Icon = isFork
      ? BranchForkRegular
      : kind === 'outcome'
        ? KIND_META.outcome.icon
        : kind === 'evidence'
          ? KIND_META.evidence.icon
          : simulated
            ? KIND_META.counterfactual_step.icon
            : KIND_META.action.icon;
    return (
      <g aria-hidden="true">
        <path
          d={shapePath(shape, cx, cy, MARKER_SCALE)}
          fill={fill}
          stroke={t.solid}
          strokeWidth={2}
          strokeDasharray={simulated ? '4 3' : undefined}
          strokeLinejoin="round"
        />
        <Icon x={cx - 8} y={cy - 8} width={16} height={16} fill={iconColor} />
        {status !== 'neutral' ? (
          <g>
            <circle
              cx={cx + 15}
              cy={cy - 15}
              r={8}
              fill={cg.surface}
              stroke={cg.tone[STATUS_META[status].tone].solid}
              strokeWidth={1.5}
            />
            <StatusIcon
              x={cx + 9.5}
              y={cy - 20.5}
              width={11}
              height={11}
              fill={cg.tone[STATUS_META[status].tone].fg}
            />
          </g>
        ) : null}
      </g>
    );
  };

  const renderLabel = (step: PathStep, cx: number, top: number, simulated: boolean) => {
    const lines = wrapLabel(step.label, LABEL_WIDTH, 12, 3);
    return (
      <text
        textAnchor="middle"
        fontSize={12}
        fill={cg.text}
        stroke={cg.surface}
        strokeWidth={4}
        strokeLinejoin="round"
        paintOrder="stroke"
      >
        <title>{step.detail ? `${step.label}: ${step.detail}` : step.label}</title>
        {lines.map((line, i) => (
          <tspan key={i} x={cx} y={top + i * 15}>
            {line}
          </tspan>
        ))}
        {step.durationMinutes !== null && step.durationMinutes !== undefined ? (
          <tspan
            x={cx}
            y={top + lines.length * 15}
            fill={simulated ? cg.tone.simulated.fg : cg.textSecondary}
            fontWeight={600}
          >
            +{formatDuration(step.durationMinutes)}
          </tspan>
        ) : null}
      </text>
    );
  };

  const ticks = scaleMax > 0 ? niceTicks(0, scaleMax, 5).filter((t) => t <= scaleMax) : [];
  const ribbonY = SCALE_TOP;
  const actualDurations = actual.steps.map((step) => step.durationMinutes ?? 0);
  const actualStarts = cumulative(actualDurations);
  const actualSegments = actual.steps.map((step, i) => ({
    id: step.id,
    from: actualStarts[i] ?? 0,
    to: (actualStarts[i] ?? 0) + (actualDurations[i] ?? 0),
  }));
  const simDurations = simSteps.map((step) => step.durationMinutes ?? 0);
  const simStarts = cumulative(simDurations);
  const simSegments = simSteps.map((step, i) => ({
    id: step.id,
    from: prefixMinutes + (simStarts[i] ?? 0),
    to: prefixMinutes + (simStarts[i] ?? 0) + (simDurations[i] ?? 0),
  }));

  const tableRows: (string | number)[][] = [
    ...actual.steps.map((s, i) => [
      `${actual.label} ${i + 1}`,
      s.label,
      s.durationMinutes === null || s.durationMinutes === undefined
        ? ''
        : formatDuration(s.durationMinutes),
      s.status ? STATUS_META[s.status].label : '',
      i === forkIndex ? 'Fork: paths diverge after this step' : '',
    ]),
    ...simSteps.map((s, i) => [
      `${counterfactual.label} ${i + 1} (simulated)`,
      s.label,
      s.durationMinutes === null || s.durationMinutes === undefined
        ? ''
        : formatDuration(s.durationMinutes),
      s.status ? STATUS_META[s.status].label : '',
      '',
    ]),
  ];

  return (
    <figure className={mergeClasses(styles.root, className)} aria-label={title}>
      <div className={styles.head}>
        <figcaption className={styles.title}>{title}</figcaption>
        <ProvenanceBadge kind="simulated" label="Simulated alternative" />
      </div>
      <div ref={measureRef} />
      <ScrollRegion
        label={`${title}, scrollable`}
        className={styles.scroller}
        style={{ maxWidth: Math.max(measured, 320) }}
      >
        <svg
          role="img"
          aria-label={summary}
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          style={{ display: 'block' }}
        >
          <SvgPatternDefs idPrefix={idPrefix} tones={['simulated']} kinds={['hatch']} />
          <defs>
            <marker
              id={`${idPrefix}-a`}
              viewBox="0 0 12 12"
              refX="10"
              refY="6"
              markerWidth="11"
              markerHeight="11"
              markerUnits="userSpaceOnUse"
              orient="auto"
            >
              <path d="M1 1.5L11 6L1 10.5Z" fill={cg.tone.actual.solid} />
            </marker>
            <marker
              id={`${idPrefix}-s`}
              viewBox="0 0 12 12"
              refX="10"
              refY="6"
              markerWidth="11"
              markerHeight="11"
              markerUnits="userSpaceOnUse"
              orient="auto"
            >
              <path d="M1 1.5L11 6L1 10.5Z" fill={cg.tone.simulated.solid} />
            </marker>
          </defs>

          <text
            x={12}
            y={ROW_ACTUAL}
            dominantBaseline="middle"
            fontSize={12}
            fontWeight={600}
            fill={cg.text}
          >
            {actual.label}
          </text>
          <text
            x={12}
            y={ROW_SIM}
            dominantBaseline="middle"
            fontSize={12}
            fontWeight={600}
            fill={cg.tone.simulated.fg}
          >
            {counterfactual.label}
          </text>
          <text
            x={12}
            y={ROW_SIM + 16}
            dominantBaseline="middle"
            fontSize={12}
            fill={cg.tone.simulated.fg}
          >
            Simulated
          </text>

          {forkIndex >= 0 ? (
            <line
              x1={GUTTER - 8}
              x2={xOf(forkIndex)}
              y1={ROW_SIM}
              y2={ROW_SIM}
              stroke={cg.borderControl}
              strokeWidth={1.5}
              strokeDasharray="1.5 5"
              strokeLinecap="round"
            />
          ) : null}
          {forkIndex >= 0 ? (
            <text x={GUTTER - 4} y={ROW_SIM + 22} fontSize={12} fill={cg.textMuted}>
              Same as actual up to the fork
            </text>
          ) : null}

          {actual.steps.slice(0, -1).map((step, i) => (
            <line
              key={`a-${step.id}`}
              x1={xOf(i) + 22}
              x2={xOf(i + 1) - 24}
              y1={ROW_ACTUAL}
              y2={ROW_ACTUAL}
              stroke={cg.tone.actual.solid}
              strokeWidth={2.5}
              markerEnd={`url(#${idPrefix}-a)`}
            />
          ))}

          {forkIndex >= 0 && simSteps.length > 0 ? (
            <g>
              <path
                d={`M${xOf(forkIndex) + PITCH / 2} ${ROW_ACTUAL}V${ROW_SIM - 12}Q${xOf(forkIndex) + PITCH / 2} ${ROW_SIM} ${xOf(forkIndex) + PITCH / 2 + 12} ${ROW_SIM}H${xOf(simStart) - 26}`}
                fill="none"
                stroke={patternUrl(idPrefix, 'hatch', 'simulated')}
                strokeWidth={8}
                strokeDasharray="8 5"
              />
              <path
                d={`M${xOf(forkIndex) + PITCH / 2} ${ROW_ACTUAL}V${ROW_SIM - 12}Q${xOf(forkIndex) + PITCH / 2} ${ROW_SIM} ${xOf(forkIndex) + PITCH / 2 + 12} ${ROW_SIM}H${xOf(simStart) - 26}`}
                fill="none"
                stroke={cg.tone.simulated.solid}
                strokeWidth={2.5}
                strokeDasharray="8 5"
                markerEnd={`url(#${idPrefix}-s)`}
              />
            </g>
          ) : null}
          {simSteps.slice(0, -1).map((step, i) => (
            <line
              key={`s-${step.id}`}
              x1={xOf(simStart + i) + 22}
              x2={xOf(simStart + i + 1) - 24}
              y1={ROW_SIM}
              y2={ROW_SIM}
              stroke={cg.tone.simulated.solid}
              strokeWidth={2.5}
              strokeDasharray="8 5"
              markerEnd={`url(#${idPrefix}-s)`}
            />
          ))}

          {actual.steps.map((step, i) => (
            <g key={step.id}>
              {renderMarker(step, xOf(i), ROW_ACTUAL, false, i === forkIndex)}
              {renderLabel(step, xOf(i), ROW_ACTUAL + 34, false)}
            </g>
          ))}
          {simSteps.map((step, i) => (
            <g key={step.id}>
              {renderMarker(step, xOf(simStart + i), ROW_SIM, true, false)}
              {renderLabel(step, xOf(simStart + i), ROW_SIM + 34, true)}
            </g>
          ))}

          {forkIndex >= 0 ? (
            <g aria-hidden="true">
              <rect
                x={xOf(forkIndex) - 54}
                y={4}
                width={108}
                height={20}
                rx={10}
                fill={cg.tone.fork.tint}
                stroke={cg.tone.fork.solid}
                strokeWidth={1.5}
              />
              <text
                x={xOf(forkIndex)}
                y={14.5}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize={12}
                fontWeight={600}
                fill={cg.tone.fork.fg}
              >
                Decision fork
              </text>
            </g>
          ) : null}

          <text x={12} y={ribbonY - 14} fontSize={12} fontWeight={600} fill={cg.textSecondary}>
            Elapsed time
          </text>
          {scaleMax > 0 ? (
            <g aria-hidden="true">
              <line
                x1={scaleLeft}
                x2={scaleLeft + scaleWidth}
                y1={ribbonY + 54}
                y2={ribbonY + 54}
                stroke={cg.borderControl}
              />
              {ticks.map((tick) => (
                <g key={tick}>
                  <line
                    x1={scaleX(tick)}
                    x2={scaleX(tick)}
                    y1={ribbonY - 4}
                    y2={ribbonY + 58}
                    stroke={cg.borderSubtle}
                  />
                  <text
                    x={scaleX(tick)}
                    y={ribbonY + 70}
                    textAnchor="middle"
                    fontSize={12}
                    fill={cg.textSecondary}
                  >
                    {formatDuration(tick)}
                  </text>
                </g>
              ))}
              <text x={12} y={ribbonY + 12} dominantBaseline="middle" fontSize={12} fill={cg.text}>
                Actual
              </text>
              {actualSegments.map((seg) => (
                <rect
                  key={seg.id}
                  x={scaleX(seg.from) + 0.5}
                  y={ribbonY}
                  width={Math.max(scaleX(seg.to) - scaleX(seg.from) - 1, 0)}
                  height={16}
                  rx={3}
                  fill={cg.tone.actual.solid}
                />
              ))}
              {actualTotal !== null ? (
                <text
                  x={scaleX(actualTotal) + 8}
                  y={ribbonY + 12}
                  dominantBaseline="middle"
                  fontSize={12}
                  fontWeight={600}
                  fill={cg.text}
                >
                  {formatDuration(actualTotal)}
                </text>
              ) : null}
              <text
                x={12}
                y={ribbonY + 38}
                dominantBaseline="middle"
                fontSize={12}
                fill={cg.tone.simulated.fg}
              >
                Simulated
              </text>
              {prefixMinutes > 0 ? (
                <rect
                  x={scaleX(0) + 0.5}
                  y={ribbonY + 26}
                  width={Math.max(scaleX(prefixMinutes) - scaleX(0) - 1, 0)}
                  height={16}
                  rx={3}
                  fill="none"
                  stroke={cg.borderControl}
                  strokeDasharray="3 3"
                />
              ) : null}
              {simSegments.map((seg) => (
                <rect
                  key={seg.id}
                  x={scaleX(seg.from) + 0.5}
                  y={ribbonY + 26}
                  width={Math.max(scaleX(seg.to) - scaleX(seg.from) - 1, 0)}
                  height={16}
                  rx={3}
                  fill={patternUrl(idPrefix, 'hatch', 'simulated')}
                  stroke={cg.tone.simulated.solid}
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                />
              ))}
              {simTotal !== null ? (
                <text
                  x={scaleX(simTotal) + 8}
                  y={ribbonY + 38}
                  dominantBaseline="middle"
                  fontSize={12}
                  fontWeight={600}
                  fill={cg.tone.simulated.fg}
                >
                  {formatDuration(simTotal)}
                </text>
              ) : null}
            </g>
          ) : (
            <text x={GUTTER} y={ribbonY + 20} fontSize={12} fill={cg.textMuted}>
              Step durations are not available for these paths.
            </text>
          )}
        </svg>
      </ScrollRegion>
      <p className={styles.note}>
        Solid connectors are what happened. Dashed, hatched connectors are a simulation that uses
        only the information available at the fork; it is an estimate, not a fact.
      </p>
      {metrics.length > 0 ? (
        <div
          className={styles.strip}
          role="group"
          aria-label="Metric differences between actual and simulated paths"
        >
          {metrics.map((metric) => (
            <div key={metric.key} className={styles.stripCard}>
              <DeltaBar
                label={metric.label}
                actual={metric.actual}
                counterfactual={metric.counterfactual}
                counterfactualLow={metric.low ?? null}
                counterfactualHigh={metric.high ?? null}
                better={metric.better ?? 'lower'}
                {...(metric.format ? { format: metric.format } : {})}
              />
            </div>
          ))}
        </div>
      ) : null}
      <ChartTable
        caption={summary}
        headers={['Step', 'Label', 'Duration', 'Status', 'Note']}
        rows={tableRows}
      />
    </figure>
  );
}
