import { escapeHelp, escapeLabelValue } from './labels';
import type { HistogramSeriesSnapshot, MetricSnapshot, MetricsSnapshot } from './types';

/** Content type of the text exposition format that `renderPrometheus` produces. */
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** Sample value per the text format: integers and floats as JS prints them, plus `NaN`, `+Inf`, `-Inf`. */
export function formatSampleValue(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return '+Inf';
  if (value === Number.NEGATIVE_INFINITY) return '-Inf';
  return Object.is(value, -0) ? '0' : String(value);
}

function renderLabels(
  names: readonly string[],
  labels: Readonly<Record<string, string>>,
  extra?: { readonly name: string; readonly value: string },
): string {
  const pairs: string[] = [];
  for (const name of names) {
    const value = labels[name];
    if (value !== undefined && value !== '') pairs.push(`${name}="${escapeLabelValue(value)}"`);
  }
  if (extra !== undefined) pairs.push(`${extra.name}="${escapeLabelValue(extra.value)}"`);
  return pairs.length === 0 ? '' : `{${pairs.join(',')}}`;
}

function renderHistogramSeries(
  name: string,
  labelNames: readonly string[],
  series: HistogramSeriesSnapshot,
  lines: string[],
): void {
  for (const bucket of series.buckets) {
    const labels = renderLabels(labelNames, series.labels, {
      name: 'le',
      value: String(bucket.le),
    });
    lines.push(`${name}_bucket${labels} ${formatSampleValue(bucket.count)}`);
  }
  const infinity = renderLabels(labelNames, series.labels, { name: 'le', value: '+Inf' });
  lines.push(`${name}_bucket${infinity} ${formatSampleValue(series.count)}`);
  const plain = renderLabels(labelNames, series.labels);
  lines.push(`${name}_sum${plain} ${formatSampleValue(series.sum)}`);
  lines.push(`${name}_count${plain} ${formatSampleValue(series.count)}`);
}

function renderMetric(metric: MetricSnapshot, lines: string[]): void {
  lines.push(`# HELP ${metric.name} ${escapeHelp(metric.help)}`);
  lines.push(`# TYPE ${metric.name} ${metric.type}`);
  if (metric.type === 'histogram') {
    for (const series of metric.series) {
      renderHistogramSeries(metric.name, metric.labelNames, series, lines);
    }
    return;
  }
  for (const series of metric.series) {
    lines.push(
      `${metric.name}${renderLabels(metric.labelNames, series.labels)} ${formatSampleValue(series.value)}`,
    );
  }
}

/** Renders a snapshot as Prometheus text exposition format 0.0.4 (always ends with a newline). */
export function renderSnapshot(snapshot: MetricsSnapshot): string {
  const lines: string[] = [];
  for (const metric of snapshot.metrics) renderMetric(metric, lines);
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/** Renders any source that can produce a snapshot (normally a `MetricsRegistry`). */
export function renderPrometheus(source: { snapshot(): MetricsSnapshot }): string {
  return renderSnapshot(source.snapshot());
}
