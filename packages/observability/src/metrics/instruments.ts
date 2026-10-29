import { elapsedMs, type MonotonicClock } from '../clock';
import { LabelGuard, OVERFLOW_LABEL_VALUE, type LabelLimits } from './labels';
import type {
  Counter,
  Gauge,
  Histogram,
  HistogramMetricSnapshot,
  HistogramSeriesSnapshot,
  LabelValues,
  MetricDescriptor,
  MetricEvent,
  MetricSnapshot,
  MetricType,
  ObservableGauge,
  ObservedValue,
  ScalarMetricSnapshot,
  ScalarSeriesSnapshot,
} from './types';

/** What an instrument needs from the registry that owns it. */
export interface InstrumentHost {
  readonly monotonic: MonotonicClock;
  readonly maxSeriesPerMetric: number;
  hasListeners(): boolean;
  emit(event: MetricEvent): void;
  reportOverflow(metric: string): void;
  reportError(error: unknown): void;
}

export interface InstrumentConfig<L extends string> {
  readonly name: string;
  readonly help: string;
  readonly unit?: string | undefined;
  readonly labelNames: readonly L[];
  readonly limits: LabelLimits;
}

/** Everything the registry needs from any instrument. */
export interface RegisteredInstrument {
  readonly name: string;
  describe(): MetricDescriptor;
  snapshot(): MetricSnapshot;
  reset(): void;
}

interface Series {
  readonly labelValues: readonly string[];
}

interface ScalarSeries extends Series {
  value: number;
}

interface HistogramSeries extends Series {
  /** Non-cumulative counts per bucket; the last slot is the implicit `+Inf` bucket. */
  readonly counts: number[];
  sum: number;
  count: number;
  max: number;
}

function assertFinite(value: number, what: string, metric: string): void {
  if (!Number.isFinite(value))
    throw new RangeError(`${what} for metric "${metric}" must be a finite number`);
}

/** Only non-empty labels are exposed: an empty label value is the same as an absent label. */
function visibleLabels(
  names: readonly string[],
  values: readonly string[],
): Record<string, string> {
  const labels: Record<string, string> = {};
  names.forEach((name, index) => {
    const value = values[index];
    if (value !== undefined && value !== '') labels[name] = value;
  });
  return labels;
}

function compareValues(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? '';
    const right = b[i] ?? '';
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

abstract class Instrument<L extends string, S extends Series> implements RegisteredInstrument {
  readonly name: string;
  readonly help: string;
  readonly unit: string | undefined;
  readonly labelNames: readonly L[];
  protected readonly series = new Map<string, S>();
  private readonly labelNameSet: ReadonlySet<string>;
  private readonly guard: LabelGuard;

  protected constructor(
    protected readonly host: InstrumentHost,
    config: InstrumentConfig<L>,
  ) {
    this.name = config.name;
    this.help = config.help;
    this.unit = config.unit;
    this.labelNames = config.labelNames;
    this.labelNameSet = new Set(config.labelNames);
    this.guard = new LabelGuard(config.limits);
  }

  protected abstract createSeries(labelValues: readonly string[]): S;
  abstract snapshot(): MetricSnapshot;
  abstract describe(): MetricDescriptor;

  /** Unlabelled metrics expose a zero sample from the start (for example "leak check failures: 0"). */
  protected init(): void {
    if (this.labelNames.length === 0) this.seriesFor(undefined);
  }

  reset(): void {
    this.series.clear();
    this.guard.reset();
    this.init();
  }

  protected seriesFor(labels: LabelValues<L> | undefined): S {
    const values = this.resolveValues(labels);
    const key = JSON.stringify(values);
    const existing = this.series.get(key);
    if (existing !== undefined) return existing;
    if (this.series.size >= this.host.maxSeriesPerMetric) return this.overflowSeries();
    const created = this.createSeries(values);
    this.series.set(key, created);
    return created;
  }

  protected peekSeries(labels: LabelValues<L> | undefined): S | undefined {
    this.assertKnownLabels(labels);
    const values = this.labelNames.map((name) => this.guard.lookup(name, labels?.[name]));
    return this.series.get(JSON.stringify(values));
  }

  protected emit(kind: MetricType, series: Series, value: number): void {
    if (!this.host.hasListeners()) return;
    this.host.emit({
      kind,
      name: this.name,
      labels: visibleLabels(this.labelNames, series.labelValues),
      value,
    });
  }

  protected labelsOf(series: Series): Record<string, string> {
    return visibleLabels(this.labelNames, series.labelValues);
  }

  protected sortedSeries(): S[] {
    return [...this.series.values()].sort((a, b) => compareValues(a.labelValues, b.labelValues));
  }

  protected baseDescriptor(type: MetricType): MetricDescriptor {
    return {
      name: this.name,
      type,
      help: this.help,
      ...(this.unit === undefined ? {} : { unit: this.unit }),
      labelNames: this.labelNames,
    };
  }

  private assertKnownLabels(labels: LabelValues<L> | undefined): void {
    if (labels === undefined) return;
    for (const key of Object.keys(labels)) {
      if (!this.labelNameSet.has(key)) {
        throw new TypeError(`Unknown label "${key}" for metric "${this.name}"`);
      }
    }
  }

  private resolveValues(labels: LabelValues<L> | undefined): string[] {
    this.assertKnownLabels(labels);
    const before = this.guard.overflowed;
    const values = this.labelNames.map((name) => this.guard.normalize(name, labels?.[name]));
    if (this.guard.overflowed !== before) this.host.reportOverflow(this.name);
    return values;
  }

  /** Series budget exhausted: new label combinations collapse into one `other` series. */
  private overflowSeries(): S {
    this.host.reportOverflow(this.name);
    const values = this.labelNames.map(() => OVERFLOW_LABEL_VALUE);
    const key = JSON.stringify(values);
    let series = this.series.get(key);
    if (series === undefined) {
      series = this.createSeries(values);
      this.series.set(key, series);
    }
    return series;
  }
}

export class CounterInstrument<L extends string>
  extends Instrument<L, ScalarSeries>
  implements Counter<L>
{
  constructor(host: InstrumentHost, config: InstrumentConfig<L>) {
    super(host, config);
    this.init();
  }

  protected createSeries(labelValues: readonly string[]): ScalarSeries {
    return { labelValues, value: 0 };
  }

  inc(labels?: LabelValues<L>, by = 1): void {
    assertFinite(by, 'Increment', this.name);
    if (by < 0) throw new RangeError(`Counter "${this.name}" cannot decrease`);
    const series = this.seriesFor(labels);
    series.value += by;
    this.emit('counter', series, by);
  }

  get(labels?: LabelValues<L>): number {
    return this.peekSeries(labels)?.value ?? 0;
  }

  total(): number {
    let sum = 0;
    for (const series of this.series.values()) sum += series.value;
    return sum;
  }

  describe(): MetricDescriptor {
    return this.baseDescriptor('counter');
  }

  snapshot(): ScalarMetricSnapshot {
    return {
      ...this.baseDescriptor('counter'),
      type: 'counter',
      series: this.sortedSeries().map((series): ScalarSeriesSnapshot => ({
        labels: this.labelsOf(series),
        value: series.value,
      })),
    };
  }
}

export class GaugeInstrument<L extends string>
  extends Instrument<L, ScalarSeries>
  implements Gauge<L>
{
  constructor(host: InstrumentHost, config: InstrumentConfig<L>) {
    super(host, config);
    this.init();
  }

  protected createSeries(labelValues: readonly string[]): ScalarSeries {
    return { labelValues, value: 0 };
  }

  set(value: number, labels?: LabelValues<L>): void {
    assertFinite(value, 'Gauge value', this.name);
    const series = this.seriesFor(labels);
    series.value = value;
    this.emit('gauge', series, value);
  }

  inc(labels?: LabelValues<L>, by = 1): void {
    assertFinite(by, 'Increment', this.name);
    const series = this.seriesFor(labels);
    series.value += by;
    this.emit('gauge', series, series.value);
  }

  dec(labels?: LabelValues<L>, by = 1): void {
    assertFinite(by, 'Decrement', this.name);
    this.inc(labels, -by);
  }

  get(labels?: LabelValues<L>): number {
    return this.peekSeries(labels)?.value ?? 0;
  }

  describe(): MetricDescriptor {
    return this.baseDescriptor('gauge');
  }

  snapshot(): ScalarMetricSnapshot {
    return {
      ...this.baseDescriptor('gauge'),
      type: 'gauge',
      series: this.sortedSeries().map((series): ScalarSeriesSnapshot => ({
        labels: this.labelsOf(series),
        value: series.value,
      })),
    };
  }
}

export interface HistogramConfig<L extends string> extends InstrumentConfig<L> {
  readonly buckets: readonly number[];
}

export function assertBuckets(metric: string, buckets: readonly number[]): void {
  if (buckets.length === 0 || buckets.length > 50) {
    throw new RangeError(`Histogram "${metric}" needs between 1 and 50 buckets`);
  }
  buckets.forEach((bound, index) => {
    if (!Number.isFinite(bound))
      throw new RangeError(`Histogram "${metric}" has a non-finite bucket`);
    const previous = buckets[index - 1];
    if (previous !== undefined && bound <= previous) {
      throw new RangeError(`Histogram "${metric}" buckets must be strictly increasing`);
    }
  });
}

export class HistogramInstrument<L extends string>
  extends Instrument<L, HistogramSeries>
  implements Histogram<L>
{
  readonly buckets: readonly number[];

  constructor(host: InstrumentHost, config: HistogramConfig<L>) {
    super(host, config);
    assertBuckets(config.name, config.buckets);
    this.buckets = [...config.buckets];
    this.init();
  }

  protected createSeries(labelValues: readonly string[]): HistogramSeries {
    return {
      labelValues,
      counts: new Array<number>(this.buckets.length + 1).fill(0),
      sum: 0,
      count: 0,
      max: 0,
    };
  }

  observe(value: number, labels?: LabelValues<L>): void {
    assertFinite(value, 'Observation', this.name);
    if (value < 0) throw new RangeError(`Histogram "${this.name}" cannot observe a negative value`);
    const series = this.seriesFor(labels);
    let index = this.buckets.findIndex((bound) => value <= bound);
    if (index === -1) index = this.buckets.length;
    series.counts[index] = (series.counts[index] ?? 0) + 1;
    series.sum += value;
    series.count += 1;
    if (value > series.max) series.max = value;
    this.emit('histogram', series, value);
  }

  startTimer(labels?: LabelValues<L>): (extra?: LabelValues<L>) => number {
    const start = this.host.monotonic();
    let recorded: number | undefined;
    return (extra) => {
      if (recorded !== undefined) return recorded;
      const seconds = elapsedMs(start, this.host.monotonic()) / 1000;
      recorded = seconds;
      this.observe(seconds, { ...labels, ...extra });
      return seconds;
    };
  }

  get(labels?: LabelValues<L>): { readonly count: number; readonly sum: number } {
    const series = this.peekSeries(labels);
    return { count: series?.count ?? 0, sum: series?.sum ?? 0 };
  }

  describe(): MetricDescriptor {
    return { ...this.baseDescriptor('histogram'), buckets: this.buckets };
  }

  snapshot(): HistogramMetricSnapshot {
    return {
      ...this.baseDescriptor('histogram'),
      type: 'histogram',
      buckets: this.buckets,
      series: this.sortedSeries().map((series): HistogramSeriesSnapshot => {
        let cumulative = 0;
        return {
          labels: this.labelsOf(series),
          buckets: this.buckets.map((le, index) => {
            cumulative += series.counts[index] ?? 0;
            return { le, count: cumulative };
          }),
          sum: series.sum,
          count: series.count,
          max: series.max,
        };
      }),
    };
  }
}

export type Collect<L extends string> = () => number | readonly ObservedValue<L>[];

/** Gauge evaluated at scrape time. Collection errors are reported, never thrown at the scraper. */
export class ObservableGaugeInstrument<L extends string>
  implements RegisteredInstrument, ObservableGauge
{
  readonly name: string;
  readonly help: string;
  readonly unit: string | undefined;
  readonly labelNames: readonly L[];
  private readonly guard: LabelGuard;

  constructor(
    private readonly host: InstrumentHost,
    config: InstrumentConfig<L>,
    private readonly collect: Collect<L>,
  ) {
    this.name = config.name;
    this.help = config.help;
    this.unit = config.unit;
    this.labelNames = config.labelNames;
    this.guard = new LabelGuard(config.limits);
  }

  /** Current samples (also used by the OpenTelemetry mirror's observable callbacks). */
  observe(): { labels: Record<string, string>; value: number }[] {
    let observed: number | readonly ObservedValue<L>[];
    try {
      observed = this.collect();
    } catch (error) {
      this.host.reportError(error);
      return [];
    }
    const entries = typeof observed === 'number' ? [{ value: observed }] : observed;
    const samples: { labels: Record<string, string>; value: number }[] = [];
    for (const entry of entries) {
      if (!Number.isFinite(entry.value)) {
        this.host.reportError(
          new RangeError(`Observable gauge "${this.name}" produced a non-finite value`),
        );
        continue;
      }
      const labelEntry = 'labels' in entry ? entry.labels : undefined;
      const values = this.labelNames.map((name) => this.guard.normalize(name, labelEntry?.[name]));
      samples.push({ labels: visibleLabels(this.labelNames, values), value: entry.value });
    }
    return samples;
  }

  reset(): void {
    this.guard.reset();
  }

  describe(): MetricDescriptor {
    return {
      name: this.name,
      type: 'gauge',
      help: this.help,
      ...(this.unit === undefined ? {} : { unit: this.unit }),
      labelNames: this.labelNames,
      observable: true,
    };
  }

  snapshot(): ScalarMetricSnapshot {
    const series = this.observe().sort((a, b) =>
      compareValues(Object.values(a.labels), Object.values(b.labels)),
    );
    return { ...this.describe(), type: 'gauge', series };
  }
}
