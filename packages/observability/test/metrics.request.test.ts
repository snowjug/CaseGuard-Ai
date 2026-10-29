import { RequestMetricsSchema } from '@caseguard/schemas';
import { describe, expect, it } from 'vitest';
import { buildRequestMetrics, estimateQuantile } from '../src';
import { setupProduct as setup } from './helpers/product';

function populated(): { build: () => ReturnType<typeof buildRequestMetrics> } {
  const { product, registry } = setup();
  const traffic: [string, string, number, number, number][] = [
    ['GET', '/api/v1/cases', 200, 20, 40],
    ['GET', '/api/v1/cases', 500, 3000, 2],
    ['POST', '/api/v1/cases', 201, 80, 3],
    ['GET', '/api/v1/system/health', 200, 5, 10],
  ];
  for (const [method, route, statusCode, durationMs, repeat] of traffic) {
    for (let i = 0; i < repeat; i += 1) {
      product.recordHttpRequest({ method, route, statusCode, durationMs });
    }
  }
  product.recordModelCall({
    agent: 'a',
    provider: 'azure-openai',
    status: 'succeeded',
    latencyMs: 1000,
    tokenSource: 'measured',
  });
  product.recordModelCall({
    agent: 'a',
    provider: 'azure-openai',
    status: 'timed_out',
    latencyMs: 3000,
    tokenSource: 'measured',
  });
  product.recordModelCall({
    agent: 'a',
    provider: 'deterministic',
    status: 'cache_hit',
    latencyMs: 2,
    tokenSource: 'estimated',
  });
  product.recordAuthFailure('invalid_signature');
  product.recordForbidden('case:delete');
  product.recordRateLimitHit('ai');
  product.recordRateLimitHit('ip');
  product.recordInjectionFlag('case_note');
  return { build: () => buildRequestMetrics(registry, { since: '2026-10-29T08:00:00.000Z' }) };
}

describe('request metrics DTO', () => {
  it('[NFR-OBS-01] satisfies RequestMetricsSchema with consistent totals, errors and security counts', () => {
    const result = populated().build();
    expect(RequestMetricsSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      since: '2026-10-29T08:00:00.000Z',
      totalRequests: 55,
      errorRequests: 2,
      modelExecutions: { total: 3, failures: 1 },
      securityEvents: { authFailures: 1, forbidden: 1, rateLimited: 2, injectionFlags: 1 },
    });
    expect(result.errorRate).toBeCloseTo(2 / 55, 10);
    expect(result.modelExecutions.avgLatencyMs).toBeGreaterThan(0);
  });

  it('[NFR-OBS-01] estimates percentiles within the observed range and orders routes by traffic', () => {
    const result = populated().build();
    expect(result.latencyMs.p50).toBeLessThanOrEqual(result.latencyMs.p95);
    expect(result.latencyMs.p95).toBeLessThanOrEqual(result.latencyMs.p99);
    expect(result.latencyMs.p99).toBeLessThanOrEqual(result.latencyMs.max);
    expect(result.latencyMs.max).toBe(3000);
    expect(result.byRoute.map((r) => `${r.method} ${r.route}`)).toEqual([
      'GET /api/v1/cases',
      'GET /api/v1/system/health',
      'POST /api/v1/cases',
    ]);
    expect(result.byRoute[0]).toMatchObject({ count: 42, errors: 2 });
    expect(result.byRoute[1]?.p95Ms).toBeLessThanOrEqual(10);
  });

  it('[NFR-OBS-01] limits the number of routes returned', () => {
    const { product, registry } = setup();
    for (let i = 0; i < 30; i += 1) {
      product.recordHttpRequest({
        method: 'GET',
        route: `/r/${i}`,
        statusCode: 200,
        durationMs: 1,
      });
    }
    expect(
      buildRequestMetrics(registry, { since: '2026-01-01T00:00:00.000Z', maxRoutes: 5 }).byRoute,
    ).toHaveLength(5);
  });

  it('[NFR-OBS-01] is valid and all-zero for a registry that has seen no traffic', () => {
    const { registry } = setup();
    const result = buildRequestMetrics(registry, { since: '2026-01-01T00:00:00.000Z' });
    expect(RequestMetricsSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      totalRequests: 0,
      errorRequests: 0,
      errorRate: 0,
      byRoute: [],
      latencyMs: { p50: 0, p95: 0, p99: 0, max: 0 },
    });
  });

  it('[NFR-OBS-01] interpolates quantiles inside a bucket and uses the maximum for the overflow bucket', () => {
    const histogram = {
      buckets: [
        { le: 1, count: 0 },
        { le: 2, count: 10 },
        { le: 4, count: 10 },
      ],
      count: 12,
      sum: 0,
      max: 9,
    };
    expect(estimateQuantile(histogram, 0.5)).toBeCloseTo(1.6, 10);
    expect(estimateQuantile(histogram, 0.99)).toBe(9);
    expect(estimateQuantile({ buckets: [], count: 0, sum: 0, max: 0 }, 0.5)).toBe(0);
    expect(
      estimateQuantile({ buckets: [{ le: 10, count: 1 }], count: 1, sum: 0.2, max: 0.2 }, 0.99),
    ).toBeLessThanOrEqual(0.2);
  });
});
