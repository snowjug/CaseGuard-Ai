import {
  createNoopMeter,
  metrics as otelMetrics,
  type Meter,
  type MeterProvider,
} from '@opentelemetry/api';
import { afterEach, describe, expect, it } from 'vitest';
import { bindMetricsToOtel, METRIC_NAMES, otelInstrumentName } from '../src';
import { createFakeMeter } from './helpers/otel';
import { setupProduct as setup } from './helpers/product';

describe('OpenTelemetry mirror', () => {
  afterEach(() => {
    otelMetrics.disable();
  });

  it('[NFR-OBS-01] mirrors counters, gauges and histograms with guarded labels and OTEL-style names', () => {
    const { registry, product } = setup();
    const fake = createFakeMeter();
    const binding = bindMetricsToOtel(registry, fake.meter);
    expect(binding.active).toBe(true);

    product.recordHttpRequest({
      method: 'GET',
      route: '/api/v1/cases',
      statusCode: 200,
      durationMs: 25,
    });
    product.startJob('case_analysis');

    const counter = fake.find('caseguard_http_requests');
    expect(counter?.type).toBe('counter');
    expect(counter?.options).toMatchObject({ unit: '1' });
    expect(counter?.calls).toEqual([
      {
        kind: 'add',
        value: 1,
        attributes: { method: 'GET', route: '/api/v1/cases', status_class: '2xx' },
      },
    ]);
    const histogram = fake.find(METRIC_NAMES.httpDuration);
    expect(histogram?.type).toBe('histogram');
    expect(histogram?.options).toMatchObject({
      unit: 's',
      advice: {
        explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      },
    });
    expect(histogram?.calls[0]).toMatchObject({ kind: 'record', value: 0.025 });
    expect(fake.find(METRIC_NAMES.jobsActive)?.calls).toEqual([
      { kind: 'record', value: 1, attributes: { kind: 'case_analysis' } },
    ]);
    expect(otelInstrumentName('x_total', 'counter')).toBe('x');
    expect(otelInstrumentName('x_total', 'gauge')).toBe('x_total');
    binding.dispose();
  });

  it('[NFR-OBS-01] replays current counter and gauge values at bind time but not histograms', () => {
    const { registry, product } = setup();
    product.recordAuthFailure('token_expired');
    product.recordAuthFailure('token_expired');
    product.recordHttpRequest({ method: 'GET', route: '/x', statusCode: 200, durationMs: 1 });
    const fake = createFakeMeter();
    bindMetricsToOtel(registry, fake.meter);
    expect(fake.find('caseguard_auth_failures')?.calls).toEqual([
      { kind: 'add', value: 2, attributes: { reason: 'token_expired' } },
    ]);
    expect(fake.find(METRIC_NAMES.buildInfo)?.calls[0]).toMatchObject({ kind: 'record', value: 1 });
    expect(fake.find('caseguard_counterfactual_leak_check_failures')?.calls).toEqual([]);
    expect(fake.find(METRIC_NAMES.httpDuration)?.calls ?? []).toEqual([]);
  });

  it('[NFR-OBS-01] exposes derived gauges as observable gauges and stops mirroring after dispose', () => {
    const { registry, product } = setup();
    const fake = createFakeMeter();
    const binding = bindMetricsToOtel(registry, fake.meter);
    product.recordModelCall({
      agent: 'a',
      provider: 'p',
      status: 'cache_hit',
      latencyMs: 1,
      tokenSource: 'estimated',
    });
    expect(fake.observeAll(METRIC_NAMES.modelCacheHitRatio)).toEqual([
      { value: 1, attributes: {} },
    ]);
    binding.dispose();
    binding.dispose();
    const before = fake.find('caseguard_model_calls')?.calls.length ?? 0;
    product.recordModelCall({
      agent: 'a',
      provider: 'p',
      status: 'succeeded',
      latencyMs: 1,
      tokenSource: 'estimated',
    });
    expect(fake.find('caseguard_model_calls')?.calls.length ?? 0).toBe(before);
    expect(fake.observeAll(METRIC_NAMES.modelCacheHitRatio)).toEqual([]);
    expect(registry.hasListeners()).toBe(false);
  });

  it('[NFR-OBS-01] is a safe no-op when no OpenTelemetry SDK is registered', () => {
    const { registry, product } = setup();
    const binding = bindMetricsToOtel(registry);
    expect(binding.active).toBe(false);
    expect(registry.hasListeners()).toBe(false);
    expect(() => binding.dispose()).not.toThrow();
    expect(() => product.recordAuthFailure('x')).not.toThrow();
  });

  it('[NFR-OBS-01] tolerates the API no-op meter without throwing', () => {
    const { registry, product } = setup();
    const binding = bindMetricsToOtel(registry, createNoopMeter());
    expect(binding.active).toBe(true);
    expect(() => {
      product.recordHttpRequest({ method: 'GET', route: '/x', statusCode: 200, durationMs: 1 });
      product.recordModelCall({
        agent: 'a',
        provider: 'p',
        status: 'succeeded',
        latencyMs: 1,
        tokenSource: 'measured',
        promptTokens: 5,
      });
    }).not.toThrow();
    binding.dispose();
  });

  it('[NFR-OBS-01] uses the global meter provider once an SDK has registered one', () => {
    const { registry, product } = setup();
    const fake = createFakeMeter();
    const provider: MeterProvider = { getMeter: (): Meter => fake.meter };
    otelMetrics.setGlobalMeterProvider(provider);
    const binding = bindMetricsToOtel(registry);
    expect(binding.active).toBe(true);
    product.recordRateLimitHit('ip');
    expect(fake.find('caseguard_rate_limit_hits')?.calls).toEqual([
      { kind: 'add', value: 1, attributes: { limiter: 'ip' } },
    ]);
    binding.dispose();
  });
});
