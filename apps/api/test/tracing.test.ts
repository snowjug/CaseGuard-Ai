import { request as httpRequest, type ClientRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acceptRequestId,
  getActiveTraceIds,
  getContextLogFields,
  hasTracerProvider,
  newRequestId,
} from '@caseguard/observability';
import {
  installInMemoryTracing,
  type InMemoryTracing,
  type InstallTracingOptions,
  type RecordedSpan,
} from '@caseguard/observability/testing';
import '../src/http/fastify-types';
import { registerLifecycle } from '../src/http/lifecycle';
import { registerTracing, type TracingOptions } from '../src/http/tracing';
import { createRig, type Rig } from './support/telemetry-support';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT_ID = '00f067aa0ba902b7';
const BEARER = ['Authorization:', 'Bearer', 'fakeBearerToken0123456789abcdef'].join(' ');
const DB_URL = ['postgres://app_fake', ':', 'fakeP4ssw0rdXyz', '@db.example.test:5432/cg'].join('');

interface Observed {
  active: ReturnType<typeof getActiveTraceIds>;
  fields: ReturnType<typeof getContextLogFields>;
}

interface TestApp {
  readonly app: FastifyInstance;
  readonly rig: Rig;
  /** What the handler of `GET /api/v1/cases/:caseId` saw while it ran. */
  readonly observed: Observed[];
}

let tracing: InMemoryTracing | undefined;
let app: FastifyInstance | undefined;

function install(options?: InstallTracingOptions): InMemoryTracing {
  tracing = installInMemoryTracing(options);
  return tracing;
}

afterEach(async () => {
  tracing?.uninstall();
  tracing = undefined;
  await app?.close();
  app = undefined;
});

function createServer(rig: Rig): FastifyInstance {
  const loggerInstance: FastifyBaseLogger = rig.logger;
  return Fastify({
    loggerInstance,
    logController: new LogController({
      disableRequestLogging: true,
      requestIdLogLabel: 'requestId',
    }),
    genReqId: (request) => acceptRequestId(request.headers['x-request-id']) ?? newRequestId(),
  });
}

async function buildTestApp(tracingOptions?: TracingOptions): Promise<TestApp> {
  const rig = createRig();
  const observed: Observed[] = [];
  const instance = createServer(rig);
  registerLifecycle(instance, rig);
  registerTracing(instance, rig, tracingOptions);

  instance.get('/api/v1/me', { config: { routeId: 'session.me' } }, () => ({ ok: true }));
  instance.get('/api/v1/cases/:caseId', { config: { routeId: 'cases.get' } }, async (request) => {
    observed.push({ active: getActiveTraceIds(), fields: getContextLogFields() });
    await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 8)));
    request.log.info({ event: 'test.handler' }, 'inside the handler');
    return { ok: true };
  });
  instance.post('/api/v1/cases', { config: { routeId: 'cases.create' } }, () => {
    throw Object.assign(new Error('The request body is not valid'), { statusCode: 422 });
  });
  instance.delete('/api/v1/cases/:caseId', { config: { routeId: 'cases.delete' } }, () => {
    throw new Error(`upstream failed: ${BEARER} while using ${DB_URL}`);
  });
  instance.get('/livez', () => ({ status: 'up' }));
  instance.get('/healthz', () => ({ status: 'up' }));
  instance.get('/readyz', () => ({ status: 'up' }));
  await instance.ready();
  app = instance;
  return { app: instance, rig, observed };
}

function onlySpan(installed: InMemoryTracing): RecordedSpan {
  expect(installed.spans).toHaveLength(1);
  const [span] = installed.spans;
  if (span === undefined) throw new Error('expected one span');
  return span;
}

async function untilEnded(span: RecordedSpan): Promise<void> {
  await vi.waitFor(() => expect(span.endCount).toBeGreaterThan(0), { timeout: 2_000 });
}

describe('registerTracing spans', () => {
  it('[NFR-OBS-01] creates one SERVER span per request named after the route id, with only the allow-listed attributes', async () => {
    const installed = install();
    const { app: server } = await buildTestApp();

    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/cases/case_secret_42?token=abc123&q=ssn-123-45-6789',
      headers: { 'x-request-id': 'req_trace_test_0001' },
    });

    expect(response.statusCode).toBe(200);
    const span = onlySpan(installed);
    await untilEnded(span);
    expect(span.name).toBe('GET cases.get');
    expect(span.kind).toBe(1);
    expect(span.attributes).toEqual({
      'http.request.method': 'GET',
      'http.route': '/api/v1/cases/:caseId',
      'cg.route_id': 'cases.get',
      'cg.request_id': 'req_trace_test_0001',
      'http.response.status_code': 200,
    });
    expect(span.endCount).toBe(1);
  });

  it('[NFR-SEC-06] never lets a URL, a case id or a query string reach any span', async () => {
    const installed = install();
    const { app: server } = await buildTestApp();

    for (const url of [
      '/api/v1/cases/case_secret_42?token=abc123&q=ssn',
      '/api/v1/cases/case_secret_43#fragment',
      '/api/v1/unknown/case_secret_44?x=1',
      '/api/v1/cases/%2e%2e/case_secret_45',
    ]) {
      await server.inject({ method: 'GET', url });
    }
    await vi.waitFor(() => expect(installed.provider.finished).toHaveLength(4));

    const everything = JSON.stringify(installed.spans);
    for (const leak of ['case_secret', 'token', 'abc123', 'ssn', 'fragment', 'x=1', '%2e']) {
      expect(everything).not.toContain(leak);
    }
    expect(installed.spans.map((span) => span.name).sort()).toEqual([
      'GET cases.get',
      'GET cases.get',
      'GET unmatched',
      'GET unmatched',
    ]);
  });

  it('[NFR-OBS-01] names a request that matched no route "unmatched" and records its 404', async () => {
    const installed = install();
    const { app: server } = await buildTestApp();

    const response = await server.inject({ method: 'GET', url: '/no/such/path?x=1' });

    expect(response.statusCode).toBe(404);
    const span = onlySpan(installed);
    await untilEnded(span);
    expect(span.name).toBe('GET unmatched');
    expect(span.attributes['http.response.status_code']).toBe(404);
    expect(span.attributes).not.toHaveProperty('http.route');
    expect(span.attributes).not.toHaveProperty('cg.route_id');
  });

  it('[NFR-OBS-01] continues the trace of an inbound traceparent', async () => {
    const installed = install();
    const { app: server } = await buildTestApp();

    await server.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { traceparent: `00-${TRACE_ID}-${PARENT_ID}-01`, tracestate: 'vendor=opaque' },
    });

    const span = onlySpan(installed);
    expect(span.spanContext().traceId).toBe(TRACE_ID);
    expect(span.parentSpanId).toBe(PARENT_ID);
    expect(span.parentIsRemote).toBe(true);
  });

  it.each([
    ['upper-case', `00-${TRACE_ID.toUpperCase()}-${PARENT_ID}-01`],
    ['all-zero ids', `00-${'0'.repeat(32)}-${'0'.repeat(16)}-01`],
    ['too short', '00-abc-def-01'],
    ['version ff', `ff-${TRACE_ID}-${PARENT_ID}-01`],
    ['trailing junk', `00-${TRACE_ID}-${PARENT_ID}-01-junk`],
  ])('[NFR-SEC-06] starts a new trace when the traceparent is %s', async (_label, traceparent) => {
    const installed = install();
    const { app: server } = await buildTestApp();

    await server.inject({ method: 'GET', url: '/api/v1/me', headers: { traceparent } });

    const span = onlySpan(installed);
    expect(span.spanContext().traceId).not.toBe(TRACE_ID);
    expect(span.parentSpanId).toBeUndefined();
  });

  it('[NFR-OBS-01] ends each span only once the response is finished', async () => {
    const installed = install();
    const rig = createRig();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let handlerStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => (handlerStarted = resolve));
    const instance = createServer(rig);
    registerLifecycle(instance, rig);
    registerTracing(instance, rig);
    instance.get('/api/v1/cases/:caseId', { config: { routeId: 'cases.get' } }, async () => {
      handlerStarted();
      await gate;
      return { ok: true };
    });
    await instance.ready();
    app = instance;

    const pending = instance.inject({ method: 'GET', url: '/api/v1/cases/case_1' });
    await started;
    expect(onlySpan(installed).endCount).toBe(0);
    release();
    await pending;

    await untilEnded(onlySpan(installed));
    expect(onlySpan(installed).endCount).toBe(1);
  });
});

describe('registerTracing outcomes', () => {
  it('[NFR-OBS-01] marks a 5xx span as an error and records the failure with every secret scrubbed and no stack', async () => {
    const installed = install();
    const { app: server } = await buildTestApp();

    const response = await server.inject({ method: 'DELETE', url: '/api/v1/cases/case_9' });

    expect(response.statusCode).toBe(500);
    const span = onlySpan(installed);
    await untilEnded(span);
    expect(span.name).toBe('DELETE cases.delete');
    expect(span.attributes['http.response.status_code']).toBe(500);
    expect(span.status.code).toBe(2);
    expect(span.exceptions).toHaveLength(1);
    const exported = JSON.stringify([span.status, span.events]);
    expect(exported).not.toContain('fakeBearerToken0123456789abcdef');
    expect(exported).not.toContain('fakeP4ssw0rdXyz');
    expect(exported).not.toContain('stacktrace');
  });

  it('[NFR-OBS-01] records a 4xx as a status code only: no error status, no exception', async () => {
    const installed = install();
    const { app: server } = await buildTestApp();

    const response = await server.inject({ method: 'POST', url: '/api/v1/cases', payload: {} });

    expect(response.statusCode).toBe(422);
    const span = onlySpan(installed);
    await untilEnded(span);
    expect(span.attributes['http.response.status_code']).toBe(422);
    expect(span.status.code).toBe(0);
    expect(span.exceptions).toHaveLength(0);
  });

  it('[NFR-OBS-01] ends the span without a status code when the client goes away, and only once', async () => {
    const installed = install();
    const rig = createRig();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let handlerStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => (handlerStarted = resolve));

    const instance = createServer(rig);
    registerLifecycle(instance, rig);
    registerTracing(instance, rig);
    instance.get('/api/v1/cases/:caseId', { config: { routeId: 'cases.get' } }, async () => {
      handlerStarted();
      await gate;
      return { ok: true };
    });
    await instance.listen({ port: 0, host: '127.0.0.1' });
    app = instance;
    const { port } = instance.server.address() as AddressInfo;

    const clientErrors: Error[] = [];
    const client: ClientRequest = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/api/v1/cases/case_abort_1?secret=1',
    });
    client.on('error', (error) => clientErrors.push(error));
    client.end();
    await started;
    client.destroy();

    const span = onlySpan(installed);
    await untilEnded(span);
    expect(span.attributes).not.toHaveProperty('http.response.status_code');
    expect(span.status.code).toBe(0);
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(span.endCount).toBe(1);
  });
});

describe('registerTracing probes', () => {
  it('[NFR-OBS-01] does not trace the orchestrator probes', async () => {
    const installed = install();
    const { app: server } = await buildTestApp();

    for (const url of ['/livez', '/healthz', '/readyz']) {
      expect((await server.inject({ method: 'GET', url })).statusCode).toBe(200);
    }

    expect(installed.spans).toHaveLength(0);
  });

  it('[NFR-OBS-01] traces them when the ignore list says so', async () => {
    const installed = install();
    const { app: server } = await buildTestApp({ ignoreRoutes: new Set() });

    await server.inject({ method: 'GET', url: '/livez' });

    const span = onlySpan(installed);
    expect(span.name).toBe('GET /livez');
  });
});

describe('registerTracing log correlation', () => {
  it('[NFR-OBS-01] puts the span ids on the log lines written while the request runs', async () => {
    const installed = install();
    const { app: server, rig, observed } = await buildTestApp();

    await server.inject({
      method: 'GET',
      url: '/api/v1/cases/case_1',
      headers: {
        'x-request-id': 'req_trace_test_0002',
        traceparent: `00-${TRACE_ID}-${PARENT_ID}-01`,
      },
    });

    const span = onlySpan(installed);
    const line = rig.events().find((event) => event['event'] === 'test.handler');
    expect(line).toMatchObject({
      requestId: 'req_trace_test_0002',
      traceId: TRACE_ID,
      spanId: span.spanContext().spanId,
    });
    expect(observed[0]?.active).toMatchObject({
      traceId: TRACE_ID,
      spanId: span.spanContext().spanId,
    });
    expect(observed[0]?.fields.spanId).toBe(span.spanContext().spanId);
  });

  it('[NFR-OBS-01] also tags the access-log line of the finished request', async () => {
    const installed = install();
    const { app: server, rig } = await buildTestApp();

    await server.inject({ method: 'GET', url: '/api/v1/me' });

    const span = onlySpan(installed);
    await untilEnded(span);
    const line = rig.events().find((event) => event['event'] === 'http.request');
    expect(line).toMatchObject({
      route: '/api/v1/me',
      statusCode: 200,
      traceId: span.spanContext().traceId,
      spanId: span.spanContext().spanId,
    });
  });

  it('[NFR-OBS-01] keeps concurrent requests apart: each log line carries the span of its own request', async () => {
    const installed = install();
    const { app: server, rig } = await buildTestApp();

    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        server.inject({
          method: 'GET',
          url: `/api/v1/cases/case_${index}`,
          headers: { 'x-request-id': `req_parallel_${String(index).padStart(4, '0')}` },
        }),
      ),
    );
    await vi.waitFor(() => expect(installed.provider.finished).toHaveLength(12));

    const spanByRequest = new Map(
      installed.spans.map((span) => [span.attributes['cg.request_id'], span.spanContext().spanId]),
    );
    const lines = rig.events().filter((event) => event['event'] === 'test.handler');
    expect(lines).toHaveLength(12);
    for (const line of lines)
      expect(line['spanId']).toBe(spanByRequest.get(line['requestId'] as string));
    expect(new Set(spanByRequest.values()).size).toBe(12);
  });
});

describe('registerTracing without an OpenTelemetry SDK', () => {
  it('[NFR-OBS-01] does no span work: no active span, and the generated correlation ids stay as they were', async () => {
    const { app: server, rig, observed } = await buildTestApp();
    expect(hasTracerProvider()).toBe(false);

    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/cases/case_1',
      headers: { traceparent: `00-${TRACE_ID}-${PARENT_ID}-01` },
    });

    expect(response.statusCode).toBe(200);
    expect(observed[0]?.active).toBeUndefined();
    // The correlation context still continues the caller's trace, with a span id of its own.
    expect(observed[0]?.fields.traceId).toBe(TRACE_ID);
    expect(observed[0]?.fields.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(observed[0]?.fields.spanId).not.toBe(PARENT_ID);
    expect(rig.events().some((event) => event['event'] === 'telemetry.tracing_failed')).toBe(false);
  });
});

describe('registerTracing failure isolation', () => {
  it('[NFR-OBS-01] never fails a request when the tracer throws: counts every failure, reports it once', async () => {
    install({
      sample: () => {
        throw new TypeError('sampler exploded');
      },
    });
    const { app: server, rig } = await buildTestApp();

    const statuses = [];
    for (let index = 0; index < 3; index += 1) {
      statuses.push((await server.inject({ method: 'GET', url: '/api/v1/me' })).statusCode);
    }

    expect(statuses).toEqual([200, 200, 200]);
    expect(rig.errorCount('telemetry', 'span_failed')).toBe(3);
    const warnings = rig.events().filter((event) => event['event'] === 'telemetry.tracing_failed');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ level: 'warn', code: 'TypeError' });
    expect(JSON.stringify(warnings[0])).not.toContain('sampler exploded');
  });

  it('[NFR-OBS-01] never fails a request when ending the span throws', async () => {
    install({
      onEnd: () => {
        throw new RangeError('processor exploded');
      },
    });
    const { app: server, rig } = await buildTestApp();

    const response = await server.inject({ method: 'GET', url: '/api/v1/me' });

    expect(response.statusCode).toBe(200);
    await vi.waitFor(() => expect(rig.errorCount('telemetry', 'span_failed')).toBeGreaterThan(0));
    expect(
      rig.events().filter((event) => event['event'] === 'telemetry.tracing_failed'),
    ).toMatchObject([{ code: 'RangeError' }]);
  });
});
