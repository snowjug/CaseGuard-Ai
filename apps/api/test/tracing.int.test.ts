import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/db';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS } from '../src/db/testing';
import { startTelemetry, type Telemetry } from '../src/telemetry';
import {
  CONTOSO,
  PERSONAS,
  createHarness,
  openSharedDatabase,
  type Harness,
} from './support/app-harness';
import {
  createFakeDistro,
  fakeConnectionString,
  type FakeDistro,
} from './support/telemetry-support';

/*
 * The whole API with the telemetry export started through startTelemetry, against a fake distro that
 * registers an in-memory tracer and meter the way the real one registers its SDK. Nothing here reaches Azure.
 */

/** Every label name the product metrics declare; a new, possibly unbounded, name must be added here on purpose. */
const ALLOWED_METRIC_LABELS = new Set([
  'method',
  'route',
  'status_class',
  'component',
  'code',
  'kind',
  'status',
  'reason',
  'queue',
  'agent',
  'provider',
  'direction',
  'source',
  'result',
  'outcome',
  'operation',
  'permission',
  'limiter',
  'transition',
  'metric',
  'service',
  'version',
  'commit',
]);

let database: Database;
let harness: Harness;
let fake: FakeDistro;
let telemetry: Telemetry;

beforeAll(async () => {
  database = await openSharedDatabase();
  fake = createFakeDistro();
  harness = await createHarness({
    database,
    env: { APPLICATIONINSIGHTS_CONNECTION_STRING: fakeConnectionString() },
  });
  // The order of main(): infrastructure first (it owns the logger and the registry), then telemetry.
  telemetry = await startTelemetry({
    config: harness.config,
    logger: harness.infra.logger,
    metrics: harness.infra.metrics,
    loadDistro: () => Promise.resolve(fake.distro),
    env: {},
  });
}, TEST_DATABASE_STARTUP_TIMEOUT_MS);

afterAll(async () => {
  await telemetry.shutdown();
  await harness.close();
  fake.cleanup();
  await database.close();
});

afterEach(() => {
  fake.tracing()?.provider.reset();
});

function finishedSpans() {
  return fake.tracing()?.provider.finished ?? [];
}

describe('the API with telemetry export on', () => {
  it('[NFR-OBS-02] started the exporter once, from the configuration', () => {
    expect(telemetry.enabled).toBe(true);
    expect(fake.useCalls).toHaveLength(1);
    expect(fake.useCalls[0]?.options.azureMonitorExporterOptions?.connectionString).toBe(
      fakeConnectionString(),
    );
  });

  it('[NFR-OBS-01] exports one span per request, named by route id, with no identifier of a user, tenant or case', async () => {
    const caseId = 'case_does_not_exist_001';
    const calls = [
      await harness.call(PERSONAS.engineer, { method: 'GET', url: '/api/v1/me' }),
      await harness.call(PERSONAS.engineer, {
        method: 'GET',
        url: `/api/v1/cases/${caseId}?view=full`,
      }),
      await harness.call(null, { method: 'GET', url: '/api/v1/me' }),
      await harness.call(PERSONAS.engineer, { method: 'GET', url: `/api/v1/nowhere/${caseId}` }),
    ];
    expect(calls.map((call) => call.statusCode)).toEqual([200, 404, 401, 404]);
    await vi.waitFor(() => expect(finishedSpans()).toHaveLength(4));

    const spans = finishedSpans();
    expect(
      spans.map((span) => `${span.name} ${String(span.attributes['http.response.status_code'])}`),
    ).toEqual([
      'GET session.me 200',
      'GET cases.get 404',
      'GET session.me 401',
      'GET unmatched 404',
    ]);
    const allowed = new Set([
      'http.request.method',
      'http.route',
      'http.response.status_code',
      'cg.request_id',
      'cg.route_id',
    ]);
    for (const span of spans)
      for (const key of Object.keys(span.attributes)) expect(allowed.has(key)).toBe(true);
    const everything = JSON.stringify(spans);
    for (const leak of [caseId, 'view=full', PERSONAS.engineer, CONTOSO, 'x-cg-persona']) {
      expect(everything).not.toContain(leak);
    }
    // Rejections are plain statuses: only server errors become error spans.
    expect(spans.map((span) => Number(span.status.code))).toEqual([0, 0, 0, 0]);
    expect(spans.flatMap((span) => span.exceptions)).toEqual([]);
  });

  it('[NFR-OBS-01] writes the span ids on the log lines of the request, so a trace and its logs join up', async () => {
    const response = await harness.call(PERSONAS.engineer, {
      method: 'GET',
      url: '/api/v1/me',
      headers: { 'x-request-id': 'req_int_trace_0001' },
    });
    expect(response.statusCode).toBe(200);
    await vi.waitFor(() => expect(finishedSpans()).toHaveLength(1));

    const [span] = finishedSpans();
    const lines = harness.logs().filter((line) => line['requestId'] === 'req_int_trace_0001');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line['traceId']).toBe(span?.spanContext().traceId);
      expect(line['spanId']).toBe(span?.spanContext().spanId);
    }
  });

  it('[NFR-OBS-01] does not trace the orchestrator probes', async () => {
    for (const url of ['/livez', '/healthz', '/readyz']) {
      expect((await harness.call(null, { method: 'GET', url })).statusCode).toBe(200);
    }

    expect(finishedSpans()).toHaveLength(0);
  });

  it('[NFR-SEC-06] mirrors only bounded metric labels: no tenant, user, case, request or URL value', async () => {
    harness.infra.metrics.recordAuthFailure('invalid_token');
    await harness.call(PERSONAS.engineer, {
      method: 'GET',
      url: '/api/v1/cases/case_does_not_exist_001',
    });
    await harness.call(PERSONAS.engineer, { method: 'GET', url: '/api/v1/me?probe=1' });
    await harness.call(null, { method: 'GET', url: '/api/v1/me' });

    const meter = fake.meter();
    const instruments =
      meter?.instruments.filter((instrument) => instrument.name.startsWith('caseguard_')) ?? [];
    expect(instruments.length).toBeGreaterThan(10);
    const attributeSets = instruments.flatMap((instrument) =>
      instrument.calls.map((call) => call.attributes ?? {}),
    );
    expect(attributeSets.length).toBeGreaterThan(0);
    for (const attributes of attributeSets) {
      for (const [key, value] of Object.entries(attributes)) {
        expect(ALLOWED_METRIC_LABELS.has(key), `label "${key}"`).toBe(true);
        expect(String(value)).not.toMatch(/tenant_|user_|case_|req_|\?|probe=/);
      }
    }
    const routes = new Set(
      instruments
        .filter((instrument) => instrument.name.startsWith('caseguard_http_request'))
        .flatMap((instrument) => instrument.calls.map((call) => call.attributes?.['route'])),
    );
    // Route patterns and the two fixed fallbacks; a concrete URL would not match.
    expect(
      [...routes].every((route) => /^(\/[A-Za-z0-9/:._-]*|unmatched|other)$/.test(String(route))),
    ).toBe(true);
  });

  it('[NFR-OBS-02] flushes once on shutdown and stops mirroring afterwards', async () => {
    await telemetry.shutdown();
    await telemetry.shutdown();
    expect(fake.shutdownCalls()).toBe(1);

    const before = fake.meter()?.find('caseguard_auth_failures')?.calls.length ?? 0;
    harness.infra.metrics.recordAuthFailure('invalid_token');
    expect(fake.meter()?.find('caseguard_auth_failures')?.calls.length ?? 0).toBe(before);
  });
});
