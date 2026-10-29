import {
  systemClock,
  systemMonotonicClock,
  toIsoTimestamp,
  type Clock,
  type MonotonicClock,
} from '../clock';
import {
  CounterInstrument,
  GaugeInstrument,
  HistogramInstrument,
  ObservableGaugeInstrument,
  type Collect,
  type InstrumentConfig,
  type InstrumentHost,
} from './instruments';
import { assertLabelNames, assertMetricName } from './labels';
import { renderSnapshot } from './prometheus';
import type {
  Counter,
  Gauge,
  Histogram,
  MetricDescriptor,
  MetricEvent,
  MetricListener,
  MetricsSnapshot,
  ObservableGauge,
} from './types';

/** Name of the self-monitoring counter that reports label-cardinality overflow per metric. */
export const OVERFLOW_METRIC_NAME = 'caseguard_metrics_label_overflow_total';

/** Options for `createMetricsRegistry`. */
export interface MetricsRegistryOptions {
  readonly clock?: Clock;
  /** Monotonic clock for `Histogram.startTimer`. Inject a fake in tests. */
  readonly monotonic?: MonotonicClock;
  /** Distinct values each label may take before new ones fold into `other`. Default 50. */
  readonly maxLabelValues?: number;
  /** Series one metric may hold before new combinations fold into one `other` series. Default 1000. */
  readonly maxSeriesPerMetric?: number;
  /** Receives subscriber and collection failures; they are never thrown into the recording call. */
  readonly onError?: (error: unknown) => void;
}

/** Definition of a counter or gauge. */
export interface MetricDefinition<L extends string = never> {
  /** Prometheus metric name; counters end in `_total`, durations in `_seconds`. */
  readonly name: string;
  readonly help: string;
  readonly labelNames?: readonly L[];
  /** Unit for the OpenTelemetry mirror (`s`, `1`, `By`). */
  readonly unit?: string;
  /** Overrides the registry-wide distinct-value budget for every label of this metric. */
  readonly maxLabelValues?: number;
  /** Per-label distinct-value budgets (for example a larger one for `route`). */
  readonly labelValueLimits?: Readonly<Partial<Record<L, number>>>;
}

/** Definition of a histogram. */
export interface HistogramDefinition<L extends string = never> extends MetricDefinition<L> {
  /** Strictly increasing finite upper bounds; `+Inf` is implicit. */
  readonly buckets: readonly number[];
}

/** Definition of a gauge computed at scrape time. */
export interface ObservableGaugeDefinition<L extends string = never> extends MetricDefinition<L> {
  /** Called on every scrape or snapshot; return one number or labelled samples. */
  readonly collect: Collect<L>;
}

type AnyInstrument =
  | CounterInstrument<string>
  | GaugeInstrument<string>
  | HistogramInstrument<string>
  | ObservableGaugeInstrument<string>;

const DEFAULT_MAX_LABEL_VALUES = 50;
const DEFAULT_MAX_SERIES = 1000;

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * In-process metrics registry: counters, gauges and fixed-bucket histograms with a cardinality guard,
 * Prometheus text and JSON snapshot output, and a subscription feed for the OpenTelemetry mirror.
 * Create one per process and inject it; there is no global registry.
 */
export class MetricsRegistry implements InstrumentHost {
  readonly monotonic: MonotonicClock;
  readonly maxSeriesPerMetric: number;
  private readonly clock: Clock;
  private readonly defaultMaxLabelValues: number;
  private readonly instruments = new Map<string, AnyInstrument>();
  private readonly listeners = new Set<MetricListener>();
  private readonly overflowCounter: Counter<'metric'>;
  private failures = 0;

  constructor(private readonly options: MetricsRegistryOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.monotonic = options.monotonic ?? systemMonotonicClock;
    this.defaultMaxLabelValues = options.maxLabelValues ?? DEFAULT_MAX_LABEL_VALUES;
    this.maxSeriesPerMetric = options.maxSeriesPerMetric ?? DEFAULT_MAX_SERIES;
    this.overflowCounter = this.counter({
      name: OVERFLOW_METRIC_NAME,
      help: 'Samples whose label value was replaced by "other" because the label exceeded its cardinality budget.',
      labelNames: ['metric'],
      maxLabelValues: 500,
    });
  }

  /** Subscription feed used by `bindMetricsToOtel`; returns the unsubscribe function. */
  subscribe(listener: MetricListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  hasListeners(): boolean {
    return this.listeners.size > 0;
  }

  emit(event: MetricEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.reportError(error);
      }
    }
  }

  reportOverflow(metric: string): void {
    if (metric !== OVERFLOW_METRIC_NAME) this.overflowCounter.inc({ metric });
  }

  reportError(error: unknown): void {
    this.failures += 1;
    this.options.onError?.(error);
  }

  /** Number of subscriber or collection failures absorbed so far. */
  get internalErrorCount(): number {
    return this.failures;
  }

  counter<const L extends string = never>(definition: MetricDefinition<L>): Counter<L> {
    const existing = this.existing(definition);
    if (existing !== undefined) {
      if (existing instanceof CounterInstrument) return existing;
      throw this.conflict(definition.name);
    }
    const instrument = new CounterInstrument<L>(this, this.config(definition));
    this.instruments.set(definition.name, instrument);
    return instrument;
  }

  gauge<const L extends string = never>(definition: MetricDefinition<L>): Gauge<L> {
    const existing = this.existing(definition);
    if (existing !== undefined) {
      if (existing instanceof GaugeInstrument) return existing;
      throw this.conflict(definition.name);
    }
    const instrument = new GaugeInstrument<L>(this, this.config(definition));
    this.instruments.set(definition.name, instrument);
    return instrument;
  }

  histogram<const L extends string = never>(definition: HistogramDefinition<L>): Histogram<L> {
    const existing = this.existing(definition);
    if (existing !== undefined) {
      if (
        existing instanceof HistogramInstrument &&
        sameStrings(existing.buckets.map(String), definition.buckets.map(String))
      ) {
        return existing;
      }
      throw this.conflict(definition.name);
    }
    const instrument = new HistogramInstrument<L>(this, {
      ...this.config(definition),
      buckets: definition.buckets,
    });
    this.instruments.set(definition.name, instrument);
    return instrument;
  }

  observableGauge<const L extends string = never>(
    definition: ObservableGaugeDefinition<L>,
  ): ObservableGauge {
    const existing = this.existing(definition);
    if (existing !== undefined) {
      if (existing instanceof ObservableGaugeInstrument) return existing;
      throw this.conflict(definition.name);
    }
    const instrument = new ObservableGaugeInstrument<L>(
      this,
      this.config(definition),
      definition.collect,
    );
    this.instruments.set(definition.name, instrument);
    return instrument;
  }

  /** Static descriptions of every metric, sorted by name. */
  describe(): MetricDescriptor[] {
    return [...this.instruments.values()]
      .map((instrument) => instrument.describe())
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Current samples of an observable gauge (used by the OpenTelemetry mirror). */
  observe(name: string): { labels: Record<string, string>; value: number }[] {
    const instrument = this.instruments.get(name);
    return instrument instanceof ObservableGaugeInstrument ? instrument.observe() : [];
  }

  /** JSON snapshot of every metric, sorted by name with deterministic series order. */
  snapshot(): MetricsSnapshot {
    const metrics = [...this.instruments.values()]
      .map((instrument) => instrument.snapshot())
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { generatedAt: toIsoTimestamp(this.clock()), metrics };
  }

  /** Prometheus text exposition format 0.0.4. */
  renderPrometheus(): string {
    return renderSnapshot(this.snapshot());
  }

  /** Zeroes every metric and forgets seen label values; definitions and subscribers are kept. */
  reset(): void {
    for (const instrument of this.instruments.values()) instrument.reset();
    this.failures = 0;
  }

  private config<L extends string>(definition: MetricDefinition<L>): InstrumentConfig<L> {
    const labelNames = definition.labelNames ?? [];
    assertMetricName(definition.name);
    assertLabelNames(definition.name, labelNames, ['le', 'quantile']);
    return {
      name: definition.name,
      help: definition.help,
      unit: definition.unit,
      labelNames,
      limits: {
        defaultMax: definition.maxLabelValues ?? this.defaultMaxLabelValues,
        ...(definition.labelValueLimits ? { overrides: definition.labelValueLimits } : {}),
      },
    };
  }

  /** Returns the already registered instrument when the label set matches; throws when it differs. */
  private existing<L extends string>(definition: MetricDefinition<L>): AnyInstrument | undefined {
    const found = this.instruments.get(definition.name);
    if (found === undefined) return undefined;
    if (!sameStrings(found.labelNames, definition.labelNames ?? []))
      throw this.conflict(definition.name);
    return found;
  }

  private conflict(name: string): Error {
    return new Error(`Metric "${name}" is already registered with a different definition`);
  }
}

/** Creates a registry. Inject the clock (and monotonic clock) in tests. */
export function createMetricsRegistry(options: MetricsRegistryOptions = {}): MetricsRegistry {
  return new MetricsRegistry(options);
}
