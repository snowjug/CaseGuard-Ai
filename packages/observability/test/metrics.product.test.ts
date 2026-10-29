import { describe, expect, it } from 'vitest';
import { METRIC_NAMES, statusClass } from '../src';
import { setupProduct as setup } from './helpers/product';

describe('product metric catalogue', () => {
  it('[NFR-OBS-01] registers every documented metric with HELP and TYPE', () => {
    const { families } = setup();
    const declared = new Set(families().map((family) => family.name));
    for (const name of Object.values(METRIC_NAMES)) expect(declared.has(name), name).toBe(true);
    for (const family of families()) {
      expect(family.help, family.name).toBeTruthy();
      expect(family.type, family.name).toBeDefined();
    }
  });

  it('[NFR-OBS-01] follows Prometheus naming: counters end in _total, durations in _seconds', () => {
    const { registry } = setup();
    for (const metric of registry.describe()) {
      if (metric.type === 'counter') expect(metric.name, metric.name).toMatch(/_total$/);
      if (metric.type === 'histogram') expect(metric.name, metric.name).toMatch(/_seconds$/);
    }
  });

  it('[FR-CF-02] [NFR-OBS-01] exposes counterfactual leak-check failures at 0 from the start', () => {
    const { sample, product } = setup();
    expect(sample(METRIC_NAMES.leakCheckFailures)).toBe(0);
    product.recordLeakCheckFailure(0);
    product.recordLeakCheckFailure(Number.NaN);
    expect(sample(METRIC_NAMES.leakCheckFailures)).toBe(0);
    product.recordLeakCheckFailure();
    expect(sample(METRIC_NAMES.leakCheckFailures)).toBe(1);
  });

  it('[NFR-OBS-01] publishes build identity and process start time from the injected clock', () => {
    const { sample, clock } = setup();
    expect(
      sample(METRIC_NAMES.buildInfo, {
        service: 'caseguard-api',
        version: '1.2.3',
        commit: 'abc1234',
      }),
    ).toBe(1);
    expect(sample(METRIC_NAMES.processStartTime)).toBe(clock.now() / 1000);
  });
});

describe('http metrics', () => {
  it.each([
    [100, '1xx'],
    [200, '2xx'],
    [204, '2xx'],
    [304, '3xx'],
    [404, '4xx'],
    [429, '4xx'],
    [503, '5xx'],
    [99, 'other'],
    [600, 'other'],
    [200.5, 'other'],
    [Number.NaN, 'other'],
  ])('[NFR-OBS-01] maps status %s to class %s', (code, expected) => {
    expect(statusClass(code)).toBe(expected);
  });

  it('[NFR-OBS-01] counts requests and observes durations by method, route pattern and status class', () => {
    const { product, sample } = setup();
    product.recordHttpRequest({
      method: 'get',
      route: '/api/v1/cases/:caseId',
      statusCode: 200,
      durationMs: 12,
    });
    product.recordHttpRequest({
      method: 'GET',
      route: '/api/v1/cases/:caseId',
      statusCode: 500,
      durationMs: 3000,
    });
    product.recordHttpRequest({ method: 'BREW', route: undefined, statusCode: 404, durationMs: 1 });
    const labels = { method: 'GET', route: '/api/v1/cases/:caseId', status_class: '2xx' };
    expect(sample(METRIC_NAMES.httpRequests, labels)).toBe(1);
    expect(sample(METRIC_NAMES.httpRequests, { ...labels, status_class: '5xx' })).toBe(1);
    expect(
      sample(METRIC_NAMES.httpRequests, {
        method: 'OTHER',
        route: 'unmatched',
        status_class: '4xx',
      }),
    ).toBe(1);
    expect(sample(`${METRIC_NAMES.httpDuration}_count`, labels)).toBe(1);
    expect(sample(`${METRIC_NAMES.httpDuration}_sum`, labels)).toBeCloseTo(0.012, 10);
  });

  it('[NFR-OBS-01] still counts a request whose duration is unusable, without throwing', () => {
    const { product, sample } = setup();
    expect(() =>
      product.recordHttpRequest({ method: 'GET', route: '/x', statusCode: 200, durationMs: -5 }),
    ).not.toThrow();
    expect(() =>
      product.recordHttpRequest({
        method: 'GET',
        route: '/x',
        statusCode: 200,
        durationMs: Number.NaN,
      }),
    ).not.toThrow();
    expect(sample(METRIC_NAMES.httpRequests, { route: '/x' })).toBe(2);
    expect(sample(`${METRIC_NAMES.httpDuration}_count`, { route: '/x' })).toBeUndefined();
  });
});

describe('model metrics', () => {
  const base = {
    agent: 'hypothesis_generator',
    provider: 'azure-openai',
    latencyMs: 800,
    tokenSource: 'measured' as const,
  };

  it('[NFR-OBS-01] records calls, latency and tokens split into measured versus estimated', () => {
    const { product, sample } = setup();
    product.recordModelCall({
      ...base,
      status: 'succeeded',
      promptTokens: 1200,
      completionTokens: 300,
      cachedTokens: 200,
    });
    product.recordModelCall({
      ...base,
      provider: 'deterministic',
      status: 'succeeded',
      tokenSource: 'estimated',
      promptTokens: 500,
      completionTokens: 100,
    });
    const labels = { agent: 'hypothesis_generator', provider: 'azure-openai', source: 'measured' };
    expect(sample(METRIC_NAMES.modelTokens, { ...labels, direction: 'input' })).toBe(1200);
    expect(sample(METRIC_NAMES.modelTokens, { ...labels, direction: 'output' })).toBe(300);
    expect(sample(METRIC_NAMES.modelTokens, { ...labels, direction: 'cached' })).toBe(200);
    expect(
      sample(METRIC_NAMES.modelTokens, {
        agent: 'hypothesis_generator',
        provider: 'deterministic',
        source: 'estimated',
        direction: 'input',
      }),
    ).toBe(500);
    expect(
      sample(METRIC_NAMES.modelTokens, { source: 'measured', provider: 'deterministic' }),
    ).toBeUndefined();
    expect(
      sample(METRIC_NAMES.modelCalls, {
        agent: 'hypothesis_generator',
        provider: 'azure-openai',
        status: 'succeeded',
      }),
    ).toBe(1);
    expect(sample(`${METRIC_NAMES.modelDuration}_count`, { provider: 'azure-openai' })).toBe(1);
    expect(sample(`${METRIC_NAMES.modelDuration}_sum`, { provider: 'azure-openai' })).toBeCloseTo(
      0.8,
      10,
    );
  });

  it('[NFR-OBS-01] skips unusable token counts instead of throwing in the model-call path', () => {
    const { product, sample } = setup();
    expect(() =>
      product.recordModelCall({
        ...base,
        status: 'succeeded',
        promptTokens: -1,
        completionTokens: Number.NaN,
        cachedTokens: 0,
        latencyMs: Number.NaN,
      }),
    ).not.toThrow();
    expect(sample(METRIC_NAMES.modelCalls, { status: 'succeeded' })).toBe(1);
    expect(sample(METRIC_NAMES.modelTokens, { direction: 'input' })).toBeUndefined();
    expect(sample(`${METRIC_NAMES.modelDuration}_count`, {})).toBeUndefined();
  });

  it('[NFR-OBS-01] derives the cache hit ratio from lookups and hides it until the first lookup', () => {
    const { product, sample, families } = setup();
    expect(families().find((f) => f.name === METRIC_NAMES.modelCacheHitRatio)?.samples).toEqual([]);
    product.recordModelCall({ ...base, status: 'cache_hit', latencyMs: 2 });
    for (let i = 0; i < 3; i += 1) {
      product.recordModelCall({ ...base, status: 'succeeded', cacheHit: false });
    }
    product.recordModelCall({ ...base, status: 'succeeded' });
    expect(sample(METRIC_NAMES.modelCacheLookups, { result: 'hit' })).toBe(1);
    expect(sample(METRIC_NAMES.modelCacheLookups, { result: 'miss' })).toBe(3);
    expect(sample(METRIC_NAMES.modelCacheHitRatio)).toBe(0.25);
  });

  it('[NFR-OBS-01] counts fallbacks and validation failures by agent and kind', () => {
    const { product, sample } = setup();
    product.recordModelCall({
      ...base,
      status: 'rejected_by_validation',
      fallbackReason: 'provider_unavailable',
      validationFailures: ['schema', 'citation', 'schema'],
    });
    expect(
      sample(METRIC_NAMES.modelFallbacks, {
        agent: 'hypothesis_generator',
        reason: 'provider_unavailable',
      }),
    ).toBe(1);
    expect(sample(METRIC_NAMES.modelValidationFailures, { kind: 'schema' })).toBe(2);
    expect(sample(METRIC_NAMES.modelValidationFailures, { kind: 'citation' })).toBe(1);
    expect(sample(METRIC_NAMES.modelValidationFailures, { kind: 'policy' })).toBeUndefined();
  });
});

describe('job, security and infrastructure metrics', () => {
  it('[NFR-OBS-01] tracks active jobs, duration, outcome and failure reasons; finishing twice is a no-op', () => {
    const { product, sample, monotonic } = setup();
    const first = product.startJob('case_analysis');
    const second = product.startJob('case_analysis');
    expect(sample(METRIC_NAMES.jobsActive, { kind: 'case_analysis' })).toBe(2);
    monotonic.advance(4000);
    first.finish('succeeded');
    first.finish('failed', 'ignored');
    monotonic.advance(1000);
    second.finish('failed', 'timeout');
    expect(sample(METRIC_NAMES.jobsActive, { kind: 'case_analysis' })).toBe(0);
    expect(
      sample(`${METRIC_NAMES.jobDuration}_sum`, { kind: 'case_analysis', status: 'succeeded' }),
    ).toBe(4);
    expect(
      sample(`${METRIC_NAMES.jobDuration}_sum`, { kind: 'case_analysis', status: 'failed' }),
    ).toBe(5);
    expect(sample(METRIC_NAMES.jobFailures, { kind: 'case_analysis', reason: 'timeout' })).toBe(1);
    expect(sample(METRIC_NAMES.jobFailures, { reason: 'ignored' })).toBeUndefined();
  });

  it('[NFR-OBS-01] records queue depth, analysis duration, db queries and retrieval latency', () => {
    const { product, sample } = setup();
    product.setQueueDepth('analysis', 7);
    product.setQueueDepth('analysis', -1);
    product.recordAnalysis(2500, 'succeeded');
    product.recordDbQuery('select_case', 3);
    product.recordRetrieval('lexical', 'ok', 20);
    expect(sample(METRIC_NAMES.queueDepth, { queue: 'analysis' })).toBe(7);
    expect(sample(`${METRIC_NAMES.analysisDuration}_sum`, { outcome: 'succeeded' })).toBe(2.5);
    expect(sample(`${METRIC_NAMES.dbQueryDuration}_count`, { operation: 'select_case' })).toBe(1);
    expect(
      sample(`${METRIC_NAMES.retrievalDuration}_count`, { provider: 'lexical', outcome: 'ok' }),
    ).toBe(1);
  });

  it('[NFR-SEC-06] [NFR-OBS-01] counts auth failures, forbidden requests, rate-limit hits and injection flags', () => {
    const { product, sample } = setup();
    product.recordAuthFailure('token_expired');
    product.recordAuthFailure('token_expired');
    product.recordForbidden('case:delete');
    product.recordRateLimitHit('ip');
    product.recordInjectionFlag('case_note');
    product.recordError('ingestion', 'unsafe_content');
    product.recordSkillTransition('approve', 'success');
    expect(sample(METRIC_NAMES.authFailures, { reason: 'token_expired' })).toBe(2);
    expect(sample(METRIC_NAMES.forbidden, { permission: 'case:delete' })).toBe(1);
    expect(sample(METRIC_NAMES.rateLimitHits, { limiter: 'ip' })).toBe(1);
    expect(sample(METRIC_NAMES.injectionFlags, { source: 'case_note' })).toBe(1);
    expect(sample(METRIC_NAMES.errors, { component: 'ingestion', code: 'unsafe_content' })).toBe(1);
    expect(
      sample(METRIC_NAMES.skillTransitions, { transition: 'approve', outcome: 'success' }),
    ).toBe(1);
  });

  it('[NFR-OBS-01] keeps route cardinality bounded: 250 distinct routes fold into "other"', () => {
    const { product, families } = setup();
    for (let i = 0; i < 250; i += 1) {
      product.recordHttpRequest({
        method: 'GET',
        route: `/r/${i}`,
        statusCode: 200,
        durationMs: 1,
      });
    }
    const routes = new Set(
      families()
        .find((f) => f.name === METRIC_NAMES.httpRequests)
        ?.samples.map((s) => s.labels.route),
    );
    expect(routes.size).toBe(201);
    expect(routes.has('other')).toBe(true);
  });
});
