import { describe, expect, it, vi } from 'vitest';
import {
  createMetricsRegistry,
  formatSampleValue,
  OVERFLOW_METRIC_NAME,
  PROMETHEUS_CONTENT_TYPE,
  renderPrometheus,
  type MetricEvent,
} from '../src';
import { createManualClock, createManualMonotonic } from './helpers/fakes';
import { parsePrometheus } from './helpers/prometheus';

function registry(options: Parameters<typeof createMetricsRegistry>[0] = {}) {
  const clock = createManualClock(Date.parse('2026-10-29T09:14:14.599Z'));
  const monotonic = createManualMonotonic();
  return {
    registry: createMetricsRegistry({ clock: clock.now, monotonic: monotonic.now, ...options }),
    clock,
    monotonic,
  };
}

describe('counters', () => {
  it('[NFR-OBS-01] count per label set, default to +1, and expose get() and total()', () => {
    const { registry: r } = registry();
    const requests = r.counter({
      name: 'app_requests_total',
      help: 'Requests.',
      labelNames: ['route', 'status'],
    });
    requests.inc({ route: '/a', status: 200 });
    requests.inc({ route: '/a', status: 200 }, 4);
    requests.inc({ route: '/b', status: 500 });
    expect(requests.get({ route: '/a', status: 200 })).toBe(5);
    expect(requests.get({ route: '/b', status: 500 })).toBe(1);
    expect(requests.get({ route: '/never', status: 200 })).toBe(0);
    expect(requests.total()).toBe(6);
  });

  it.each([
    ['negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('[NFR-OBS-01] refuse a %s increment so a counter can never decrease', (_name, by) => {
    const { registry: r } = registry();
    const counter = r.counter({ name: 'x_total', help: 'x' });
    expect(() => counter.inc(undefined, by)).toThrow(RangeError);
    expect(counter.get()).toBe(0);
  });

  it('[NFR-OBS-01] expose an unlabelled counter at 0 before its first increment', () => {
    const { registry: r } = registry();
    r.counter({ name: 'caseguard_leak_total', help: 'Must stay zero.' });
    const family = parsePrometheus(r.renderPrometheus()).find(
      (f) => f.name === 'caseguard_leak_total',
    );
    expect(family?.samples).toEqual([{ name: 'caseguard_leak_total', labels: {}, value: 0 }]);
  });

  it('[NFR-OBS-01] reject unknown labels loudly instead of dropping them', () => {
    const { registry: r } = registry();
    const counter = r.counter({ name: 'c_total', help: 'c', labelNames: ['a'] });
    expect(() => counter.inc({ b: 'x' } as never)).toThrow(TypeError);
    expect(() => counter.get({ b: 'x' } as never)).toThrow(TypeError);
  });
});

describe('gauges', () => {
  it('[NFR-OBS-01] set, increase and decrease, and may go negative', () => {
    const { registry: r } = registry();
    const gauge = r.gauge({ name: 'jobs_active', help: 'Active.', labelNames: ['kind'] });
    gauge.set(5, { kind: 'a' });
    gauge.inc({ kind: 'a' });
    gauge.dec({ kind: 'a' }, 3);
    gauge.dec({ kind: 'b' });
    expect(gauge.get({ kind: 'a' })).toBe(3);
    expect(gauge.get({ kind: 'b' })).toBe(-1);
  });

  it('[NFR-OBS-01] reject non-finite values', () => {
    const { registry: r } = registry();
    const gauge = r.gauge({ name: 'g', help: 'g' });
    expect(() => gauge.set(Number.NaN)).toThrow(RangeError);
    expect(() => gauge.inc(undefined, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('histograms', () => {
  it('[NFR-OBS-01] bucket with inclusive upper bounds, cumulative output, sum, count and max', () => {
    const { registry: r } = registry();
    const histogram = r.histogram({
      name: 'latency_seconds',
      help: 'Latency.',
      buckets: [0.1, 0.5, 1],
    });
    for (const value of [0.05, 0.1, 0.3, 0.5, 0.7, 2, 10]) histogram.observe(value);
    const metric = r.snapshot().metrics.find((m) => m.name === 'latency_seconds');
    expect(metric?.type).toBe('histogram');
    const series = metric?.type === 'histogram' ? metric.series[0] : undefined;
    expect(series?.buckets).toEqual([
      { le: 0.1, count: 2 },
      { le: 0.5, count: 4 },
      { le: 1, count: 5 },
    ]);
    expect(series?.count).toBe(7);
    expect(series?.sum).toBeCloseTo(13.65, 10);
    expect(series?.max).toBe(10);
    expect(histogram.get()).toEqual({ count: 7, sum: series?.sum });
  });

  it.each([
    ['negative', -0.001],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('[NFR-OBS-01] reject a %s observation', (_name, value) => {
    const { registry: r } = registry();
    const histogram = r.histogram({ name: 'h_seconds', help: 'h', buckets: [1] });
    expect(() => histogram.observe(value)).toThrow(RangeError);
    expect(histogram.get().count).toBe(0);
  });

  it.each([
    ['empty', []],
    ['not increasing', [1, 1]],
    ['decreasing', [2, 1]],
    ['non-finite', [1, Number.POSITIVE_INFINITY]],
    ['too many', Array.from({ length: 51 }, (_u, i) => i + 1)],
  ])('[NFR-OBS-01] reject %s bucket definitions', (_name, buckets) => {
    const { registry: r } = registry();
    expect(() => r.histogram({ name: 'bad_seconds', help: 'bad', buckets })).toThrow(RangeError);
  });

  it('[NFR-OBS-01] time with the injected monotonic clock, once, merging extra labels', () => {
    const { registry: r, monotonic } = registry();
    const histogram = r.histogram({
      name: 't_seconds',
      help: 't',
      labelNames: ['op', 'outcome'],
      buckets: [0.5, 1, 5],
    });
    const stop = histogram.startTimer({ op: 'read' });
    monotonic.advance(2500);
    expect(stop({ outcome: 'ok' })).toBe(2.5);
    monotonic.advance(1000);
    expect(stop({ outcome: 'error' })).toBe(2.5);
    expect(histogram.get({ op: 'read', outcome: 'ok' })).toEqual({ count: 1, sum: 2.5 });
    expect(histogram.get({ op: 'read', outcome: 'error' }).count).toBe(0);
  });

  it('[NFR-OBS-01] never produce a negative duration when the clock runs backwards', () => {
    const { registry: r, monotonic } = registry();
    const histogram = r.histogram({ name: 'b_seconds', help: 'b', buckets: [1] });
    const stop = histogram.startTimer();
    monotonic.advance(-500);
    expect(stop()).toBe(0);
  });
});

describe('registration', () => {
  it('[NFR-OBS-01] returns the same instrument for an identical definition and rejects conflicts', () => {
    const { registry: r } = registry();
    const first = r.counter({ name: 'dup_total', help: 'dup', labelNames: ['a'] });
    const second = r.counter({ name: 'dup_total', help: 'dup', labelNames: ['a'] });
    first.inc({ a: 'x' });
    expect(second.get({ a: 'x' })).toBe(1);
    expect(() => r.counter({ name: 'dup_total', help: 'dup', labelNames: ['b'] })).toThrow(
      /already registered/,
    );
    expect(() => r.gauge({ name: 'dup_total', help: 'dup', labelNames: ['a'] })).toThrow(
      /already registered/,
    );
    r.histogram({ name: 'h_seconds', help: 'h', buckets: [1, 2] });
    expect(() => r.histogram({ name: 'h_seconds', help: 'h', buckets: [1, 3] })).toThrow(
      /already registered/,
    );
  });

  it.each([
    ['metric name with a dash', () => ({ name: 'bad-name', help: 'x' })],
    ['metric name starting with a digit', () => ({ name: '1bad', help: 'x' })],
    [
      'label with a dash',
      () => ({ name: 'ok_total', help: 'x', labelNames: ['bad-label'] as const }),
    ],
    [
      'label with a reserved prefix',
      () => ({ name: 'ok2_total', help: 'x', labelNames: ['__reserved'] as const }),
    ],
    ['duplicate labels', () => ({ name: 'ok3_total', help: 'x', labelNames: ['a', 'a'] as const })],
    ['reserved label le', () => ({ name: 'ok4_total', help: 'x', labelNames: ['le'] as const })],
  ])('[NFR-OBS-01] reject a %s', (_name, definition) => {
    const { registry: r } = registry();
    expect(() => r.counter(definition())).toThrow(TypeError);
  });
});

describe('cardinality guard', () => {
  it('[NFR-OBS-01] folds label values beyond the budget into "other" and keeps earlier values intact', () => {
    const { registry: r } = registry({ maxLabelValues: 3 });
    const counter = r.counter({ name: 'guarded_total', help: 'g', labelNames: ['user'] });
    for (const user of ['a', 'b', 'c', 'd', 'e']) counter.inc({ user });
    counter.inc({ user: 'a' });
    counter.inc({ user: 'f' });
    expect(counter.get({ user: 'a' })).toBe(2);
    expect(counter.get({ user: 'b' })).toBe(1);
    expect(counter.get({ user: 'other' })).toBe(3);
    expect(counter.get({ user: 'd' })).toBe(3);
    expect(counter.total()).toBe(7);
    const text = r.renderPrometheus();
    expect(text).toContain('guarded_total{user="other"} 3');
    expect(text).not.toContain('user="d"');
  });

  it('[NFR-OBS-01] reports every overflow on a self-monitoring counter named after the metric', () => {
    const { registry: r } = registry({ maxLabelValues: 1 });
    const counter = r.counter({ name: 'noisy_total', help: 'n', labelNames: ['id'] });
    counter.inc({ id: 'a' });
    counter.inc({ id: 'b' });
    counter.inc({ id: 'c' });
    const overflow = parsePrometheus(r.renderPrometheus()).find(
      (family) => family.name === OVERFLOW_METRIC_NAME,
    );
    expect(overflow?.samples).toEqual([
      { name: OVERFLOW_METRIC_NAME, labels: { metric: 'noisy_total' }, value: 2 },
    ]);
  });

  it('[NFR-OBS-01] supports per-label budgets', () => {
    const { registry: r } = registry({ maxLabelValues: 2 });
    const counter = r.counter({
      name: 'budget_total',
      help: 'b',
      labelNames: ['route', 'method'],
      labelValueLimits: { route: 5 },
    });
    for (const route of ['/1', '/2', '/3', '/4', '/5']) counter.inc({ route, method: 'GET' });
    counter.inc({ route: '/6', method: 'GET' });
    counter.inc({ route: '/1', method: 'POST' });
    counter.inc({ route: '/1', method: 'PUT' });
    expect(counter.get({ route: '/5', method: 'GET' })).toBe(1);
    expect(counter.get({ route: 'other', method: 'GET' })).toBe(1);
    expect(counter.get({ route: '/1', method: 'POST' })).toBe(1);
    expect(counter.get({ route: '/1', method: 'other' })).toBe(1);
    expect(counter.total()).toBe(8);
  });

  it('[NFR-OBS-01] does not spend the label budget on reads', () => {
    const { registry: r } = registry({ maxLabelValues: 2 });
    const counter = r.counter({ name: 'reads_total', help: 'r', labelNames: ['k'] });
    for (const k of ['x', 'y', 'z']) expect(counter.get({ k })).toBe(0);
    counter.inc({ k: 'a' });
    counter.inc({ k: 'b' });
    expect(counter.get({ k: 'a' })).toBe(1);
    expect(counter.get({ k: 'b' })).toBe(1);
    const overflow = parsePrometheus(r.renderPrometheus()).find(
      (family) => family.name === OVERFLOW_METRIC_NAME,
    );
    expect(overflow?.samples).toEqual([]);
  });

  it('[NFR-OBS-01] collapses new label combinations into one "other" series once the series budget is spent', () => {
    const { registry: r } = registry({ maxSeriesPerMetric: 3, maxLabelValues: 100 });
    const counter = r.counter({ name: 'series_total', help: 's', labelNames: ['a', 'b'] });
    for (let i = 0; i < 10; i += 1) counter.inc({ a: `a${i}`, b: `b${i}` });
    const series = (r.snapshot().metrics.find((m) => m.name === 'series_total')?.series ?? []) as {
      labels: Record<string, string>;
      value: number;
    }[];
    expect(series).toHaveLength(4);
    expect(series.find((s) => s.labels.a === 'other' && s.labels.b === 'other')?.value).toBe(7);
  });

  it('[NFR-OBS-01] coerces numbers and booleans, truncates long values and treats missing labels as absent', () => {
    const { registry: r } = registry();
    const counter = r.counter({
      name: 'coerce_total',
      help: 'c',
      labelNames: ['code', 'flag', 'long', 'missing'],
    });
    counter.inc({ code: 200, flag: true, long: 'x'.repeat(500) });
    const sample = parsePrometheus(r.renderPrometheus()).find((f) => f.name === 'coerce_total')
      ?.samples[0];
    expect(sample?.labels).toEqual({ code: '200', flag: 'true', long: 'x'.repeat(128) });
  });
});

describe('prometheus text exposition', () => {
  it('[NFR-OBS-01] is parseable by a strict parser, deterministic and newline-terminated', () => {
    const { registry: r } = registry();
    r.counter({ name: 'z_total', help: 'Z.', labelNames: ['k'] }).inc({ k: 'b' });
    r.counter({ name: 'a_total', help: 'A.', labelNames: ['k'] }).inc({ k: 'z' });
    r.counter({ name: 'a_total', help: 'A.', labelNames: ['k'] }).inc({ k: 'a' });
    r.gauge({ name: 'm_gauge', help: 'M.' }).set(-1.5);
    const text = renderPrometheus(r);
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toBe(r.renderPrometheus());
    const families = parsePrometheus(text);
    const names = families.map((family) => family.name);
    expect(names).toEqual([...names].sort());
    expect(families.find((f) => f.name === 'a_total')?.samples.map((s) => s.labels.k)).toEqual([
      'a',
      'z',
    ]);
    expect(families.find((f) => f.name === 'm_gauge')).toMatchObject({
      type: 'gauge',
      help: 'M.',
      samples: [{ value: -1.5 }],
    });
    expect(PROMETHEUS_CONTENT_TYPE).toBe('text/plain; version=0.0.4; charset=utf-8');
  });

  it('[NFR-OBS-01] escapes backslashes, quotes and newlines in label values and HELP text', () => {
    const { registry: r } = registry();
    const hostile = 'a"b\\c\nd,e}f{g=h é 日本';
    r.counter({
      name: 'esc_total',
      help: 'Line one\nline two \\ backslash',
      labelNames: ['v'],
    }).inc({ v: hostile });
    const text = r.renderPrometheus();
    expect(text).toContain('# HELP esc_total Line one\\nline two \\\\ backslash');
    expect(text.split('\n').filter((line) => line.startsWith('esc_total{'))).toHaveLength(1);
    const family = parsePrometheus(text).find((f) => f.name === 'esc_total');
    expect(family?.help).toBe('Line one\nline two \\ backslash');
    expect(family?.samples[0]?.labels.v).toBe(hostile);
  });

  it('[NFR-OBS-01] renders histograms with cumulative buckets, +Inf, _sum and _count', () => {
    const { registry: r } = registry();
    const histogram = r.histogram({
      name: 'h_seconds',
      help: 'H.',
      labelNames: ['op'],
      buckets: [0.1, 1],
    });
    for (const value of [0.05, 0.5, 5]) histogram.observe(value, { op: 'read' });
    const family = parsePrometheus(r.renderPrometheus()).find((f) => f.name === 'h_seconds');
    expect(family?.type).toBe('histogram');
    expect(family?.samples.map((s) => [s.name, s.labels.le, s.value])).toEqual([
      ['h_seconds_bucket', '0.1', 1],
      ['h_seconds_bucket', '1', 2],
      ['h_seconds_bucket', '+Inf', 3],
      ['h_seconds_sum', undefined, 5.55],
      ['h_seconds_count', undefined, 3],
    ]);
    const buckets =
      family?.samples.filter((s) => s.name === 'h_seconds_bucket').map((s) => s.value) ?? [];
    expect(buckets).toEqual([...buckets].sort((a, b) => a - b));
  });

  it('[NFR-OBS-01] formats special sample values per the text format', () => {
    expect(formatSampleValue(Number.NaN)).toBe('NaN');
    expect(formatSampleValue(Number.POSITIVE_INFINITY)).toBe('+Inf');
    expect(formatSampleValue(Number.NEGATIVE_INFINITY)).toBe('-Inf');
    expect(formatSampleValue(-0)).toBe('0');
    expect(formatSampleValue(0.1)).toBe('0.1');
    expect(formatSampleValue(1e21)).toBe('1e+21');
    expect(Number(formatSampleValue(1e21))).toBe(1e21);
  });
});

describe('json snapshot, reset and subscriptions', () => {
  it('[NFR-OBS-01] produces a deterministic JSON snapshot stamped by the injected clock', () => {
    const { registry: r } = registry();
    r.counter({ name: 'b_total', help: 'B', labelNames: ['k'] }).inc({ k: 'x' }, 2);
    r.gauge({ name: 'a_gauge', help: 'A', unit: '1' }).set(7);
    const snapshot = r.snapshot();
    expect(snapshot.generatedAt).toBe('2026-10-29T09:14:14.599Z');
    expect(snapshot.metrics.map((m) => m.name)).toEqual([
      'a_gauge',
      'b_total',
      OVERFLOW_METRIC_NAME,
    ]);
    expect(snapshot.metrics[0]).toMatchObject({
      type: 'gauge',
      unit: '1',
      series: [{ labels: {}, value: 7 }],
    });
    expect(snapshot.metrics[1]).toMatchObject({
      type: 'counter',
      series: [{ labels: { k: 'x' }, value: 2 }],
    });
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it('[NFR-OBS-01] reset zeroes values, forgets label budgets and keeps definitions', () => {
    const { registry: r } = registry({ maxLabelValues: 1 });
    const counter = r.counter({ name: 'r_total', help: 'r', labelNames: ['k'] });
    const plain = r.counter({ name: 'plain_total', help: 'p' });
    counter.inc({ k: 'a' });
    counter.inc({ k: 'b' });
    plain.inc(undefined, 3);
    r.reset();
    expect(counter.total()).toBe(0);
    expect(plain.get()).toBe(0);
    counter.inc({ k: 'b' });
    expect(counter.get({ k: 'b' })).toBe(1);
    expect(
      parsePrometheus(r.renderPrometheus()).find((f) => f.name === 'plain_total')?.samples[0]
        ?.value,
    ).toBe(0);
  });

  it('[NFR-OBS-01] delivers guarded samples to subscribers until they unsubscribe', () => {
    const { registry: r } = registry({ maxLabelValues: 1 });
    const events: MetricEvent[] = [];
    const unsubscribe = r.subscribe((event) => events.push(event));
    const counter = r.counter({ name: 's_total', help: 's', labelNames: ['k'] });
    const gauge = r.gauge({ name: 's_gauge', help: 's' });
    const histogram = r.histogram({ name: 's_seconds', help: 's', buckets: [1] });
    counter.inc({ k: 'a' }, 2);
    counter.inc({ k: 'b' });
    gauge.inc();
    gauge.inc();
    histogram.observe(0.5);
    expect(events.filter((e) => e.name !== OVERFLOW_METRIC_NAME)).toEqual([
      { kind: 'counter', name: 's_total', labels: { k: 'a' }, value: 2 },
      { kind: 'counter', name: 's_total', labels: { k: 'other' }, value: 1 },
      { kind: 'gauge', name: 's_gauge', labels: {}, value: 1 },
      { kind: 'gauge', name: 's_gauge', labels: {}, value: 2 },
      { kind: 'histogram', name: 's_seconds', labels: {}, value: 0.5 },
    ]);
    unsubscribe();
    counter.inc({ k: 'a' });
    expect(events.filter((e) => e.name === 's_total')).toHaveLength(2);
  });

  it('[NFR-OBS-01] absorbs a failing subscriber, reports it and keeps recording', () => {
    const onError = vi.fn();
    const { registry: r } = registry({ onError });
    r.subscribe(() => {
      throw new Error('subscriber exploded');
    });
    const counter = r.counter({ name: 'f_total', help: 'f' });
    expect(() => counter.inc()).not.toThrow();
    expect(counter.get()).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(r.internalErrorCount).toBe(1);
  });
});

describe('observable gauges', () => {
  it('[NFR-OBS-01] are evaluated at scrape time, support labels and obey the cardinality guard', () => {
    const { registry: r } = registry({ maxLabelValues: 1 });
    let depth = 4;
    r.observableGauge({
      name: 'queue_depth',
      help: 'Depth.',
      labelNames: ['queue'],
      collect: () => [
        { labels: { queue: 'a' }, value: depth },
        { labels: { queue: 'b' }, value: 1 },
      ],
    });
    const read = () =>
      parsePrometheus(r.renderPrometheus())
        .find((f) => f.name === 'queue_depth')
        ?.samples.map((s) => [s.labels.queue, s.value]);
    expect(read()).toEqual([
      ['a', 4],
      ['other', 1],
    ]);
    depth = 9;
    expect(read()).toEqual([
      ['a', 9],
      ['other', 1],
    ]);
  });

  it('[NFR-OBS-01] report a throwing or non-finite collector instead of failing the scrape', () => {
    const errors: unknown[] = [];
    const { registry: r } = registry({ onError: (error) => errors.push(error) });
    r.observableGauge({
      name: 'broken',
      help: 'b',
      collect: () => {
        throw new Error('collector exploded');
      },
    });
    r.observableGauge({ name: 'nan_gauge', help: 'n', collect: () => Number.NaN });
    expect(() => r.renderPrometheus()).not.toThrow();
    expect(errors).toHaveLength(2);
    const families = parsePrometheus(r.renderPrometheus());
    expect(families.find((f) => f.name === 'broken')?.samples).toEqual([]);
    expect(families.find((f) => f.name === 'nan_gauge')?.samples).toEqual([]);
  });
});
