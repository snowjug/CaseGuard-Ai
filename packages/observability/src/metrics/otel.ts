import {
  createNoopMeter,
  metrics as otelMetrics,
  type Attributes,
  type Meter,
  type ObservableResult,
} from '@opentelemetry/api';
import type { MetricsRegistry } from './registry';
import type { MetricDescriptor, MetricEvent, MetricType } from './types';

/** Instrumentation scope under which mirrored instruments are created. */
export const METER_NAME = '@caseguard/observability';

/** Handle returned by `bindMetricsToOtel`. */
export interface OtelBinding {
  /** False when no meter was available (no SDK registered): nothing is mirrored and no cost is added. */
  readonly active: boolean;
  /** Stops mirroring and detaches observable callbacks. Safe to call more than once. */
  dispose(): void;
}

const INACTIVE_BINDING: OtelBinding = {
  active: false,
  dispose() {
    // Nothing was bound, so there is nothing to release.
  },
};

/**
 * Name of the OpenTelemetry instrument for a registry metric: counters lose the Prometheus `_total`
 * suffix (exporters add it back), everything else keeps its name.
 */
export function otelInstrumentName(name: string, type: MetricType): string {
  return type === 'counter' && name.endsWith('_total') ? name.slice(0, -'_total'.length) : name;
}

type Recorder = (value: number, attributes: Attributes) => void;

function createRecorder(meter: Meter, descriptor: MetricDescriptor): Recorder | undefined {
  const name = otelInstrumentName(descriptor.name, descriptor.type);
  const options = {
    description: descriptor.help,
    ...(descriptor.unit === undefined ? {} : { unit: descriptor.unit }),
  };
  switch (descriptor.type) {
    case 'counter': {
      const counter = meter.createCounter(name, options);
      return (value, attributes) => counter.add(value, attributes);
    }
    case 'gauge': {
      const gauge = meter.createGauge(name, options);
      return (value, attributes) => gauge.record(value, attributes);
    }
    case 'histogram': {
      const histogram = meter.createHistogram(name, {
        ...options,
        ...(descriptor.buckets
          ? { advice: { explicitBucketBoundaries: [...descriptor.buckets] } }
          : {}),
      });
      return (value, attributes) => histogram.record(value, attributes);
    }
    default:
      return undefined;
  }
}

/**
 * Mirrors the registry into OpenTelemetry instruments so Application Insights (or any OTLP backend)
 * receives the same product metrics. Counters, gauges and histograms are forwarded as they are
 * recorded, with the guarded labels as attributes; derived gauges become observable gauges. Current
 * counter and gauge values are replayed once at bind time. Histogram observations recorded before
 * binding are not replayed.
 *
 * Without `meter` the global meter provider is used; when none is registered (no OpenTelemetry SDK)
 * this returns an inactive binding and does nothing. Call it after the SDK has started: the API does
 * not hand out proxy meters, so a provider registered later is not picked up.
 */
export function bindMetricsToOtel(registry: MetricsRegistry, meter?: Meter): OtelBinding {
  const target = meter ?? otelMetrics.getMeter(METER_NAME);
  if (meter === undefined && target === createNoopMeter()) return INACTIVE_BINDING;

  const recorders = new Map<string, Recorder | undefined>();
  const descriptors = new Map<string, MetricDescriptor>();
  const refresh = (): void => {
    for (const descriptor of registry.describe()) descriptors.set(descriptor.name, descriptor);
  };
  refresh();

  const recorderFor = (name: string): Recorder | undefined => {
    if (recorders.has(name)) return recorders.get(name);
    if (!descriptors.has(name)) refresh();
    const descriptor = descriptors.get(name);
    const recorder =
      descriptor === undefined || descriptor.observable === true
        ? undefined
        : createRecorder(target, descriptor);
    recorders.set(name, recorder);
    return recorder;
  };

  const unsubscribe = registry.subscribe((event: MetricEvent) => {
    recorderFor(event.name)?.(event.value, event.labels);
  });

  const detachments: (() => void)[] = [];
  for (const descriptor of descriptors.values()) {
    if (descriptor.observable !== true) continue;
    const gauge = target.createObservableGauge(descriptor.name, {
      description: descriptor.help,
      ...(descriptor.unit === undefined ? {} : { unit: descriptor.unit }),
    });
    const callback = (result: ObservableResult): void => {
      for (const sample of registry.observe(descriptor.name))
        result.observe(sample.value, sample.labels);
    };
    gauge.addCallback(callback);
    detachments.push(() => gauge.removeCallback(callback));
  }

  // Replay current state so instruments created after metrics were recorded start consistent.
  for (const metric of registry.snapshot().metrics) {
    if (metric.type === 'histogram' || metric.observable === true) continue;
    const recorder = recorderFor(metric.name);
    for (const series of metric.series) {
      if (metric.type === 'counter' && series.value <= 0) continue;
      recorder?.(series.value, series.labels);
    }
  }

  let disposed = false;
  return {
    active: true,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      for (const detach of detachments) detach();
    },
  };
}
