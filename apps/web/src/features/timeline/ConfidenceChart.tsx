'use client';

import type { HypothesesResponse, TimelineResponse } from '@caseguard/schemas';
import {
  EmptyState,
  LineChart,
  Notice,
  Panel,
  ProvenanceBadge,
  formatDateTimeUtc,
  formatProbability,
  type LineChartEvent,
  type LineSeries,
} from '@caseguard/ui';
import { ArrowTrendingRegular } from '@fluentui/react-icons';
import { useMemo, type ReactNode } from 'react';

export interface ConfidenceChartProps {
  series: TimelineResponse['hypothesisSeries'];
  /** Hypothesis records (with their 10-90% bands) when they could be loaded; the chart works without them. */
  hypotheses: HypothesesResponse['items'] | undefined;
  /** Decision forks to mark on the time axis. */
  forks: readonly LineChartEvent[];
  /** The zoom window: points and markers outside it are not drawn. */
  from: string | null;
  to: string | null;
  asOf: string | null;
  /** The instant the API cut the evidence at (its own `asOf`): what an earlier view really shows, never the request. */
  cutAt?: string | null | undefined;
  /** Shown above the chart, for example the notice that the likely ranges could not be computed right now. */
  limited?: ReactNode;
}

const inWindow = (at: string, from: string | null, to: string | null): boolean => {
  const ms = Date.parse(at);
  return (from === null || ms >= Date.parse(from)) && (to === null || ms <= Date.parse(to));
};

/**
 * How the engine's belief in each competing hypothesis changed event by event. Values are model estimates, labelled as
 * such. The leading hypothesis also shows its 10 to 90 percent range when the hypothesis records are available. With a
 * time cursor the series stops at the cursor: later points are never drawn.
 */
export function ConfidenceChart({
  series,
  hypotheses,
  forks,
  from,
  to,
  asOf,
  cutAt,
  limited,
}: ConfidenceChartProps) {
  const lines = useMemo<LineSeries[]>(() => {
    const leading = series[0];
    const band = new Map<string, { low: number; high: number }>();
    const record = leading
      ? hypotheses?.find((item) => item.id === leading.hypothesisId)
      : undefined;
    for (const point of record?.timeline ?? [])
      band.set(point.at, { low: point.low, high: point.high });
    return series.map((item, index) => ({
      id: item.hypothesisId,
      label: item.name,
      points: item.points
        .filter((point) => inWindow(point.at, from, to))
        .map((point) => {
          const range = index === 0 ? band.get(point.at) : undefined;
          return {
            x: point.at,
            y: point.confidence,
            ...(range ? { low: range.low, high: range.high } : {}),
          };
        }),
    }));
  }, [series, hypotheses, from, to]);
  const markers = useMemo(
    () => forks.filter((fork) => inWindow(String(fork.x), from, to)),
    [forks, from, to],
  );
  const hasPoints = lines.some((line) => line.points.length > 0);

  return (
    <Panel
      title="Hypothesis confidence over time"
      level={2}
      description={
        asOf
          ? cutAt
            ? `How likely each hypothesis looked, up to ${formatDateTimeUtc(cutAt)}, the last event recorded by the moment you chose.`
            : 'How likely each hypothesis looked at the moment you chose.'
          : 'How likely each competing hypothesis looked after each event.'
      }
      actions={<ProvenanceBadge kind="estimated" />}
      help={`Each line is the engine's estimate of how likely a hypothesis is, updated after every observation. The shaded band is the leading hypothesis's 10 to 90 percent range from a seeded simulation. These are model estimates from an authored knowledge pack, not statistical truth. Numbered markers show decision forks.${
        asOf
          ? ' In an earlier view the range is worked out from the case, the knowledge pack and the events visible at that moment, not read from the stored analysis, so it cannot be compared number for number with the range of the whole record.'
          : ''
      }`}
    >
      {limited}
      {hasPoints ? (
        <LineChart
          title="Hypothesis confidence over time (model estimates)"
          series={lines}
          yDomain={[0, 1]}
          yFormat={(value) => formatProbability(value)}
          events={markers}
          bandLabel="Likely range (10 to 90 percent)"
          height={260}
        />
      ) : (
        <EmptyState
          compact
          headingLevel={3}
          icon={<ArrowTrendingRegular />}
          title="No confidence values yet"
          description={
            from || to
              ? 'No update falls inside the zoom window. Clear the zoom to see the whole case.'
              : 'Hypothesis confidence appears once the first events have been analysed.'
          }
        />
      )}
      <Notice variant="model-estimate" compact>
        Confidence values are model estimates, not statistical truth.
      </Notice>
    </Panel>
  );
}
