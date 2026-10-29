import type { RequestMetrics } from '@caseguard/schemas';
import { MODEL_FAILURE_STATUSES, METRIC_NAMES } from './product';
import type {
  HistogramMetricSnapshot,
  HistogramSeriesSnapshot,
  MetricsSnapshot,
  ScalarMetricSnapshot,
} from './types';

/** Source of a snapshot: a `MetricsRegistry` or anything shaped like one. */
export interface SnapshotSource {
  snapshot(): MetricsSnapshot;
}

/** Options for `buildRequestMetrics`. */
export interface RequestMetricsOptions {
  /** ISO timestamp from which the counters were collected (process start). */
  readonly since: string;
  /** Maximum number of routes returned in `byRoute`. The DTO allows 100. */
  readonly maxRoutes?: number;
}

interface MergedHistogram {
  /** Cumulative counts per finite upper bound. */
  buckets: { le: number; count: number }[];
  count: number;
  sum: number;
  max: number;
}

function emptyHistogram(): MergedHistogram {
  return { buckets: [], count: 0, sum: 0, max: 0 };
}

function mergeInto(target: MergedHistogram, series: HistogramSeriesSnapshot): void {
  if (target.buckets.length === 0) {
    target.buckets = series.buckets.map((bucket) => ({ le: bucket.le, count: 0 }));
  }
  series.buckets.forEach((bucket, index) => {
    const slot = target.buckets[index];
    if (slot !== undefined) slot.count += bucket.count;
  });
  target.count += series.count;
  target.sum += series.sum;
  target.max = Math.max(target.max, series.max);
}

/**
 * Quantile estimate from cumulative buckets by linear interpolation inside the bucket (the same idea as
 * Prometheus `histogram_quantile`), bounded by the largest observation so it never overshoots reality.
 * It is an estimate: resolution is the bucket width.
 */
export function estimateQuantile(histogram: MergedHistogram, quantile: number): number {
  if (histogram.count === 0) return 0;
  const rank = quantile * histogram.count;
  let previousCount = 0;
  let previousBound = 0;
  for (const bucket of histogram.buckets) {
    if (bucket.count >= rank) {
      const inBucket = bucket.count - previousCount;
      const upper = Math.min(bucket.le, histogram.max);
      if (inBucket <= 0) return upper;
      const fraction = (rank - previousCount) / inBucket;
      return Math.min(previousBound + (bucket.le - previousBound) * fraction, histogram.max);
    }
    previousCount = bucket.count;
    previousBound = bucket.le;
  }
  return histogram.max;
}

const toMilliseconds = (seconds: number): number => Math.round(seconds * 1_000_000) / 1000;

const failureStatuses: ReadonlySet<string> = MODEL_FAILURE_STATUSES;

function scalar(snapshot: MetricsSnapshot, name: string): ScalarMetricSnapshot | undefined {
  const metric = snapshot.metrics.find((candidate) => candidate.name === name);
  return metric !== undefined && metric.type !== 'histogram' ? metric : undefined;
}

function histogram(snapshot: MetricsSnapshot, name: string): HistogramMetricSnapshot | undefined {
  const metric = snapshot.metrics.find((candidate) => candidate.name === name);
  return metric?.type === 'histogram' ? metric : undefined;
}

function sum(
  metric: ScalarMetricSnapshot | undefined,
  include?: (labels: Readonly<Record<string, string>>) => boolean,
): number {
  let total = 0;
  for (const series of metric?.series ?? []) {
    if (include === undefined || include(series.labels)) total += series.value;
  }
  return Math.round(total);
}

/**
 * Builds the `GET /system/metrics` DTO from the in-process registry. "Errors" are 5xx responses; 4xx
 * (auth, validation, rate limits) are reported under `securityEvents` instead. Percentiles are
 * estimates interpolated from histogram buckets.
 */
export function buildRequestMetrics(
  source: SnapshotSource,
  options: RequestMetricsOptions,
): RequestMetrics {
  const snapshot = source.snapshot();
  const requests = scalar(snapshot, METRIC_NAMES.httpRequests);
  const durations = histogram(snapshot, METRIC_NAMES.httpDuration);

  const totalRequests = sum(requests);
  const errorRequests = sum(requests, (labels) => labels.status_class === '5xx');

  const overall = emptyHistogram();
  const perRoute = new Map<string, { route: string; method: string; hist: MergedHistogram }>();
  for (const series of durations?.series ?? []) {
    mergeInto(overall, series);
    const route = series.labels.route ?? 'unmatched';
    const method = series.labels.method ?? 'OTHER';
    const key = `${method} ${route}`;
    const entry = perRoute.get(key) ?? { route, method, hist: emptyHistogram() };
    mergeInto(entry.hist, series);
    perRoute.set(key, entry);
  }

  const routeCounts = new Map<string, { count: number; errors: number }>();
  for (const series of requests?.series ?? []) {
    const key = `${series.labels.method ?? 'OTHER'} ${series.labels.route ?? 'unmatched'}`;
    const entry = routeCounts.get(key) ?? { count: 0, errors: 0 };
    entry.count += series.value;
    if (series.labels.status_class === '5xx') entry.errors += series.value;
    routeCounts.set(key, entry);
  }

  const byRoute = [...routeCounts.entries()]
    .map(([key, counts]) => {
      const detail = perRoute.get(key);
      const [method = 'OTHER', ...rest] = key.split(' ');
      return {
        route: detail?.route ?? rest.join(' '),
        method: detail?.method ?? method,
        count: Math.round(counts.count),
        errors: Math.round(counts.errors),
        p95Ms: detail === undefined ? 0 : toMilliseconds(estimateQuantile(detail.hist, 0.95)),
      };
    })
    .sort(
      (a, b) =>
        b.count - a.count || a.route.localeCompare(b.route) || a.method.localeCompare(b.method),
    )
    .slice(0, options.maxRoutes ?? 100);

  const modelCalls = scalar(snapshot, METRIC_NAMES.modelCalls);
  const modelLatency = emptyHistogram();
  for (const series of histogram(snapshot, METRIC_NAMES.modelDuration)?.series ?? []) {
    mergeInto(modelLatency, series);
  }

  return {
    since: options.since,
    totalRequests,
    errorRequests,
    errorRate: totalRequests === 0 ? 0 : Math.min(1, errorRequests / totalRequests),
    latencyMs: {
      p50: toMilliseconds(estimateQuantile(overall, 0.5)),
      p95: toMilliseconds(estimateQuantile(overall, 0.95)),
      p99: toMilliseconds(estimateQuantile(overall, 0.99)),
      max: toMilliseconds(overall.max),
    },
    byRoute,
    modelExecutions: {
      total: sum(modelCalls),
      failures: sum(modelCalls, (labels) => failureStatuses.has(labels.status ?? '')),
      avgLatencyMs:
        modelLatency.count === 0 ? 0 : toMilliseconds(modelLatency.sum / modelLatency.count),
    },
    securityEvents: {
      authFailures: sum(scalar(snapshot, METRIC_NAMES.authFailures)),
      forbidden: sum(scalar(snapshot, METRIC_NAMES.forbidden)),
      rateLimited: sum(scalar(snapshot, METRIC_NAMES.rateLimitHits)),
      injectionFlags: sum(scalar(snapshot, METRIC_NAMES.injectionFlags)),
    },
  };
}
