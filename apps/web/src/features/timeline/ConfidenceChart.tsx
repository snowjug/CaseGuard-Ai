'use client';

import type { HypothesesResponse, TimelineResponse } from '@caseguard/schemas';
import {
  EmptyState,
  LineChart,
  Panel,
  ProvenanceBadge,
  formatDateTimeUtc,
  formatProbability,
  useMediaQuery,
  type LineChartEvent,
  type LineSeries,
} from '@caseguard/ui';
import { TrendingUpIcon } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';

export interface ConfidenceChartProps {
  series: TimelineResponse['hypothesisSeries'];
  /** Hypothesis records (with their 10-90% bands) when they could be loaded; the chart works without them. */
  hypotheses: HypothesesResponse['items'] | undefined;
  /** Key decisions to mark on the time axis. */
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
 * How the engine's belief in each possible cause changed event by event, as one compact chart. Values are model
 * estimates, labelled as such. The leading cause also shows its 10 to 90 percent range when the hypothesis records are
 * available. With a time cursor the series stops at the cursor: later points are never drawn.
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
  // On a phone the numbered markers and their long list would be most of the chart: the key decisions are flagged on the
  // event rows below anyway.
  const phone = useMediaQuery('(max-width: 639px)', false);
  const hasPoints = lines.some((line) => line.points.length > 0);

  return (
    <Panel
      title="Confidence over time"
      level={2}
      description={
        asOf
          ? cutAt
            ? `How likely each possible cause looked, up to ${formatDateTimeUtc(cutAt)}, the last event recorded by the moment you chose.`
            : 'How likely each possible cause looked at the moment you chose.'
          : 'How likely each possible cause looked after each event.'
      }
      actions={<ProvenanceBadge kind="estimated" />}
      help={`Each line is the engine's estimate of how likely a possible cause is, updated after every observation. The shaded band is the leading cause's 10 to 90 percent range from a seeded simulation. These are model estimates from an authored knowledge pack, not statistical truth. Numbered markers show key decisions (on a phone they are left out: every key decision is flagged on its event below).${
        asOf
          ? ' In an earlier view the range is worked out from the case, the knowledge pack and the events visible at that moment, not read from the stored analysis, so it cannot be compared number for number with the range of the whole record.'
          : ''
      }`}
    >
      {limited}
      {hasPoints ? (
        <LineChart
          title="Confidence in each possible cause over time (model estimates)"
          hideTitle
          series={lines}
          yDomain={[0, 1]}
          yFormat={(value) => formatProbability(value)}
          events={phone ? [] : markers}
          bandLabel="Likely range (10 to 90 percent)"
          height={200}
        />
      ) : (
        <EmptyState
          compact
          headingLevel={3}
          icon={<TrendingUpIcon />}
          title="No confidence values yet"
          description={
            from || to
              ? 'No update falls inside the zoom window. Clear the zoom to see the whole case.'
              : 'Confidence appears once the first events have been analysed.'
          }
        />
      )}
    </Panel>
  );
}
