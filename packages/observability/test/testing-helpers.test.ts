import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bindMetricsToOtel,
  createMetricsRegistry,
  createProductMetrics,
  getActiveTraceIds,
  hasTracerProvider,
  METRIC_NAMES,
  withSpan,
} from '../src';
import {
  installInMemoryTracing,
  installRecordingMeter,
  type InMemoryTracing,
  type InstalledMeter,
} from '../src/testing';

let tracing: InMemoryTracing | undefined;
let meter: InstalledMeter | undefined;

afterEach(() => {
  tracing?.uninstall();
  meter?.uninstall();
  tracing = undefined;
  meter = undefined;
  trace.disable();
  context.disable();
});

describe('in-memory tracing test double', () => {
  it('[NFR-OBS-01] registers as the global provider and removes itself again', () => {
    expect(hasTracerProvider()).toBe(false);
    tracing = installInMemoryTracing();
    expect(hasTracerProvider()).toBe(true);
    tracing.uninstall();
    expect(hasTracerProvider()).toBe(false);
  });

  it('[NFR-OBS-01] replaces a provider that was registered before instead of silently keeping it', () => {
    const first = installInMemoryTracing();
    const second = installInMemoryTracing();
    tracing = second;

    trace.getTracer('probe').startSpan('after-replace').end();

    expect(first.spans).toHaveLength(0);
    expect(second.spans.map((span) => span.name)).toEqual(['after-replace']);
  });

  it('[NFR-OBS-01] hands out deterministic, valid ids and links children to their parent', () => {
    tracing = installInMemoryTracing();
    const tracer = trace.getTracer('probe');

    const parent = tracer.startSpan('parent', { kind: SpanKind.SERVER });
    const child = context.with(trace.setSpan(context.active(), parent), () =>
      tracer.startSpan('child'),
    );
    tracer.startSpan('other', { root: true });
    parent.end();
    child.end();

    const [parentSpan, childSpan, otherSpan] = tracing.spans;
    expect(parentSpan?.spanContext()).toMatchObject({
      traceId: '00000000000000000000000000000001',
      spanId: '0000000000000001',
    });
    expect(childSpan?.spanContext().traceId).toBe(parentSpan?.spanContext().traceId);
    expect(childSpan?.parentSpanId).toBe(parentSpan?.spanContext().spanId);
    expect(otherSpan?.parentSpanId).toBeUndefined();
    expect(otherSpan?.spanContext().traceId).not.toBe(parentSpan?.spanContext().traceId);
    expect(parentSpan?.kind).toBe(SpanKind.SERVER);
    expect(tracing.provider.finished.map((span) => span.name)).toEqual(['parent', 'child']);
  });

  it('[NFR-OBS-01] supports every startActiveSpan form and makes the span active inside', () => {
    tracing = installInMemoryTracing();
    const tracer = trace.getTracer('probe');

    const seen = [
      tracer.startActiveSpan('a', () => getActiveTraceIds()?.spanId),
      tracer.startActiveSpan('b', { kind: SpanKind.CLIENT }, () => getActiveTraceIds()?.spanId),
      tracer.startActiveSpan('c', {}, context.active(), () => getActiveTraceIds()?.spanId),
    ];

    expect(seen).toEqual(tracing.spans.map((span) => span.spanContext().spanId));
    expect(tracing.spans.map((span) => span.kind)).toEqual([undefined, SpanKind.CLIENT, undefined]);
    expect(getActiveTraceIds()).toBeUndefined();
  });

  it('[NFR-OBS-01] records attributes, events, exceptions, status and the end count', () => {
    tracing = installInMemoryTracing();
    const span = trace.getTracer('probe').startSpan('work', { attributes: { first: 1 } });

    span.setAttribute('second', 'two');
    span.setAttributes({ third: true, skipped: undefined });
    span.addEvent('checkpoint', { step: 1 });
    span.recordException(new TypeError('bad input'));
    span.recordException('plain text');
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'failed' });
    span.updateName('renamed');
    expect(span.isRecording()).toBe(true);
    span.end();
    span.end();

    const [recorded] = tracing.spans;
    expect(recorded?.name).toBe('renamed');
    expect(recorded?.attributes).toEqual({ first: 1, second: 'two', third: true });
    expect(recorded?.events.map((event) => event.name)).toEqual([
      'checkpoint',
      'exception',
      'exception',
    ]);
    expect(recorded?.events[1]?.attributes).toMatchObject({
      'exception.type': 'TypeError',
      'exception.message': 'bad input',
    });
    expect(recorded?.events[2]?.attributes).toEqual({ 'exception.message': 'plain text' });
    expect(recorded?.status).toEqual({ code: SpanStatusCode.ERROR, message: 'failed' });
    expect(recorded?.endCount).toBe(2);
    expect(recorded?.isRecording()).toBe(false);
  });

  it('[NFR-OBS-01] sampled-out spans keep valid ids but are not stored', () => {
    tracing = installInMemoryTracing({ sample: (name) => name !== 'dropped' });
    const tracer = trace.getTracer('probe');

    const dropped = tracer.startSpan('dropped');
    tracer.startSpan('kept').end();

    expect(dropped.isRecording()).toBe(false);
    expect(dropped.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(tracing.spans.map((span) => span.name)).toEqual(['kept']);
    expect(tracing.provider.unsampled).toHaveLength(1);
  });

  it('[NFR-OBS-01] calls onEnd after every end() and lets a failure reach the caller, like a faulty processor', () => {
    const ended: string[] = [];
    tracing = installInMemoryTracing({
      onEnd: (span) => {
        ended.push(span.name);
        if (span.name === 'bad') throw new RangeError('processor failed');
      },
    });
    const tracer = trace.getTracer('probe');

    tracer.startSpan('good').end();
    expect(() => tracer.startSpan('bad').end()).toThrow('processor failed');

    expect(ended).toEqual(['good', 'bad']);
  });

  it('[NFR-OBS-01] can be installed without a context manager, like an SDK that has none', () => {
    tracing = installInMemoryTracing({ contextManager: false });
    const tracer = trace.getTracer('probe');

    const seen = tracer.startActiveSpan('a', () => getActiveTraceIds());

    expect(seen).toBeUndefined();
    expect(tracing.spans).toHaveLength(1);
  });

  it('[NFR-OBS-01] works with withSpan: one span per call, ended, error recorded and rethrown', async () => {
    tracing = installInMemoryTracing();

    await expect(
      withSpan('db.query', { table: 'cases' }, async () => {
        throw new Error('db down');
      }),
    ).rejects.toThrow('db down');

    const [span] = tracing.spans;
    expect(span?.name).toBe('db.query');
    expect(span?.attributes).toEqual({ table: 'cases' });
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.endCount).toBe(1);
    expect(tracing.provider.tracerNames).toContain('@caseguard/observability');
  });

  it('[NFR-OBS-01] reset() forgets recorded spans', () => {
    tracing = installInMemoryTracing();
    trace.getTracer('probe').startSpan('x').end();
    tracing.provider.reset();

    expect(tracing.spans).toHaveLength(0);
    expect(tracing.provider.tracerNames).toHaveLength(0);
  });
});

describe('recording meter test double', () => {
  it('[NFR-OBS-01] records the calls made on counters, gauges and histograms', () => {
    meter = installRecordingMeter();
    const created = meter.meter;

    created.createCounter('c').add(2, { a: 'x' });
    created.createGauge('g').record(5);
    created.createHistogram('h', { unit: 's' }).record(0.25, { b: 'y' });
    created.createUpDownCounter('u').add(1);

    expect(meter.find('c')?.calls).toEqual([{ kind: 'add', value: 2, attributes: { a: 'x' } }]);
    expect(meter.find('g')?.calls).toEqual([{ kind: 'record', value: 5, attributes: undefined }]);
    expect(meter.find('h')?.options).toEqual({ unit: 's' });
    expect(meter.find('missing')).toBeUndefined();
  });

  it('[NFR-OBS-01] runs observable callbacks on demand and detaches them', () => {
    meter = installRecordingMeter();
    const gauge = meter.meter.createObservableGauge('o');
    const callback = (result: { observe(value: number): void }): void => result.observe(7);
    gauge.addCallback(callback);

    expect(meter.observeAll('o')).toEqual([{ value: 7, attributes: undefined }]);
    gauge.removeCallback(callback);
    expect(meter.observeAll('o')).toEqual([]);
  });

  it('[NFR-OBS-01] is what bindMetricsToOtel finds when it is called without a meter', () => {
    const registry = createMetricsRegistry();
    const products = createProductMetrics(registry, { service: 'caseguard-api', version: '0.0.0' });

    expect(bindMetricsToOtel(registry).active).toBe(false);

    meter = installRecordingMeter();
    const binding = bindMetricsToOtel(registry);
    products.recordAuthFailure('invalid_token');

    expect(binding.active).toBe(true);
    expect(meter.find('caseguard_auth_failures')?.calls).toHaveLength(1);
    expect(meter.find(METRIC_NAMES.buildInfo)).toBeDefined();
    binding.dispose();
  });
});
