/** A label value as callers supply it; everything is rendered as a string. */
export type LabelValue = string | number | boolean;

/** Labels accepted by an instrument: only its declared names, all optional (a missing label renders as empty). */
export type LabelValues<L extends string = string> = { readonly [K in L]?: LabelValue };

/** Kind of instrument. */
export type MetricType = 'counter' | 'gauge' | 'histogram';

/** Static description of a metric. */
export interface MetricDescriptor {
  readonly name: string;
  readonly type: MetricType;
  readonly help: string;
  /** UCUM-style unit used by the OpenTelemetry mirror (`s`, `1`, `By`). */
  readonly unit?: string;
  readonly labelNames: readonly string[];
  /** Finite upper bounds of a histogram; the `+Inf` bucket is implicit. */
  readonly buckets?: readonly number[];
  /** True for gauges computed at scrape time. */
  readonly observable?: boolean;
}

/** One counter or gauge series in a snapshot. */
export interface ScalarSeriesSnapshot {
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

/** One histogram series in a snapshot. */
export interface HistogramSeriesSnapshot {
  readonly labels: Readonly<Record<string, string>>;
  /** Cumulative counts per finite upper bound (`le`). */
  readonly buckets: readonly { readonly le: number; readonly count: number }[];
  readonly sum: number;
  /** Total observations; equals the implicit `+Inf` bucket. */
  readonly count: number;
  /** Largest observation, used to bound quantile estimates. */
  readonly max: number;
}

/** Snapshot of a counter or gauge. */
export interface ScalarMetricSnapshot extends MetricDescriptor {
  readonly type: 'counter' | 'gauge';
  readonly series: readonly ScalarSeriesSnapshot[];
}

/** Snapshot of a histogram. */
export interface HistogramMetricSnapshot extends MetricDescriptor {
  readonly type: 'histogram';
  readonly buckets: readonly number[];
  readonly series: readonly HistogramSeriesSnapshot[];
}

/** Snapshot of any metric. */
export type MetricSnapshot = ScalarMetricSnapshot | HistogramMetricSnapshot;

/** JSON snapshot of every metric; the Prometheus text is rendered from this same structure. */
export interface MetricsSnapshot {
  readonly generatedAt: string;
  readonly metrics: readonly MetricSnapshot[];
}

/** One recorded sample, delivered to subscribers (the OpenTelemetry mirror). */
export interface MetricEvent {
  readonly kind: MetricType;
  readonly name: string;
  /** Labels after the cardinality guard, keyed by label name. */
  readonly labels: Readonly<Record<string, string>>;
  /** Counter: the increment. Gauge: the new absolute value. Histogram: the observation. */
  readonly value: number;
}

/** Callback receiving every recorded sample (see `MetricsRegistry.subscribe`). */
export type MetricListener = (event: MetricEvent) => void;

/** Monotonic counter; labels follow the metric definition. */
export interface Counter<L extends string = never> {
  readonly name: string;
  /** Adds `by` (default 1, must be a finite number >= 0) to the labelled series. */
  inc(labels?: LabelValues<L>, by?: number): void;
  /** Current value of the labelled series (0 when it has never been incremented). */
  get(labels?: LabelValues<L>): number;
  /** Sum over every series of this counter. */
  total(): number;
}

/** Value that can go up and down. */
export interface Gauge<L extends string = never> {
  readonly name: string;
  set(value: number, labels?: LabelValues<L>): void;
  inc(labels?: LabelValues<L>, by?: number): void;
  dec(labels?: LabelValues<L>, by?: number): void;
  get(labels?: LabelValues<L>): number;
}

/** Distribution over fixed buckets. */
export interface Histogram<L extends string = never> {
  readonly name: string;
  readonly buckets: readonly number[];
  /** Records one observation (a finite number >= 0). */
  observe(value: number, labels?: LabelValues<L>): void;
  /**
   * Starts a timer on the registry's monotonic clock. The returned function records the elapsed time in
   * seconds (merging `extra` labels over `labels`) and returns it; later calls return the same value.
   */
  startTimer(labels?: LabelValues<L>): (extra?: LabelValues<L>) => number;
  /** Observation count and sum of the labelled series. */
  get(labels?: LabelValues<L>): { readonly count: number; readonly sum: number };
}

/** One sample returned by an observable gauge's `collect` callback. */
export interface ObservedValue<L extends string> {
  readonly labels?: LabelValues<L>;
  readonly value: number;
}

/** Handle to a gauge computed at scrape time (derived values such as ratios). */
export interface ObservableGauge {
  readonly name: string;
}
