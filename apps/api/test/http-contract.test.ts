import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROUTES, type RouteId } from '@caseguard/schemas';
import {
  BudgetExceededError,
  NotFoundError,
  ValidationFailedError,
  VersionConflictError,
} from '../src/errors';
import type { Database } from '../src/db';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS } from '../src/db/testing';
import type { HandlerMap } from '../src/http/route-binder';
import { buildIngestInput } from './builders';
import {
  CONTOSO,
  PERSONAS,
  createHarness,
  openSharedDatabase,
  type Harness,
} from './support/app-harness';
import { fakeJob } from './support/fixtures';

let database: Database;
const harnesses: Harness[] = [];

async function harness(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  const created = await createHarness({ database, ...options });
  harnesses.push(created);
  return created;
}

beforeAll(async () => {
  database = await openSharedDatabase();
}, TEST_DATABASE_STARTUP_TIMEOUT_MS);

afterAll(async () => {
  for (const created of harnesses) await created.close();
  await database.close();
});

const emptyPage = { items: [], nextCursor: null };

describe('request validation', () => {
  it('reports every invalid query field with its location', async () => {
    const h = await harness({ handlers: { 'cases.list': async () => emptyPage } });
    const res = await h.call(PERSONAS.engineer, { method: 'GET', url: '/api/v1/cases?limit=abc' });
    expect(res.statusCode).toBe(422);
    expect(res.data.code).toBe('validation_failed');
    expect(res.data.errors.map((issue: { path: string }) => issue.path)).toContain('query.limit');
  });

  it('rejects a malformed path parameter before the handler runs', async () => {
    let called = false;
    const h = await harness({
      handlers: {
        'cases.get': async () => {
          called = true;
          throw new NotFoundError('Case');
        },
      },
    });
    const res = await h.call(PERSONAS.engineer, {
      method: 'GET',
      url: '/api/v1/cases/%20bad%20id',
    });
    expect(res.statusCode).toBe(422);
    expect(res.data.errors[0].path).toBe('params.caseId');
    expect(called).toBe(false);
  });

  it('validates the body even when the route has no handler yet', async () => {
    const h = await harness({ handlers: {} });
    const res = await h.call(PERSONAS.engineer, {
      method: 'POST',
      url: '/api/v1/ingestion/preview',
      payload: { source: { type: 'nonsense' } },
    });
    expect(res.statusCode).toBe(422);
    expect(
      res.data.errors.some((issue: { path: string }) => issue.path.startsWith('body.source')),
    ).toBe(true);
  });

  it('hands the handler parsed values: defaults applied, unknown fields dropped', async () => {
    const seen: { query?: unknown; body?: unknown } = {};
    const handlers: HandlerMap = {
      'cases.list': async ({ query }) => {
        seen.query = query;
        return emptyPage;
      },
      'analysis.start': async ({ body, params }) => {
        seen.body = body;
        return { job: fakeJob(params.caseId), runId: null, reused: false };
      },
    };
    const h = await harness({ handlers });
    await h.call(PERSONAS.engineer, { method: 'GET', url: '/api/v1/cases' });
    expect(seen.query).toMatchObject({ limit: 50 });
    await h.call(PERSONAS.engineer, {
      method: 'POST',
      url: '/api/v1/cases/case_1/analysis',
      payload: { force: true, isAdmin: true },
    });
    expect(seen.body).toEqual({ force: true });
  });

  it('accepts a body-less POST when every body field has a default', async () => {
    const seen: { body?: unknown } = {};
    const h = await harness({
      handlers: {
        'analysis.start': async ({ body, params }) => {
          seen.body = body;
          return { job: fakeJob(params.caseId), runId: null, reused: false };
        },
      },
    });
    const res = await h.call(PERSONAS.engineer, {
      method: 'POST',
      url: '/api/v1/cases/case_1/analysis',
    });
    expect(res.statusCode).toBe(202);
    expect(seen.body).toEqual({ force: false });
  });

  it('answers malformed JSON with a 400 that does not echo the payload', async () => {
    const h = await harness({ handlers: { 'analysis.start': async () => ({}) as never } });
    const res = await h.call(PERSONAS.engineer, {
      method: 'POST',
      url: '/api/v1/cases/case_1/analysis',
      headers: { 'content-type': 'application/json' },
      payload: '{"force": tru-secret-token',
    });
    expect(res.statusCode).toBe(400);
    expect(res.data.code).toBe('validation_failed');
    expect(res.body).not.toContain('tru-secret-token');
  });

  it('refuses prototype-poisoning payloads', async () => {
    let called = false;
    const h = await harness({
      handlers: {
        'analysis.start': async () => {
          called = true;
          return {} as never;
        },
      },
    });
    const res = await h.call(PERSONAS.engineer, {
      method: 'POST',
      url: '/api/v1/cases/case_1/analysis',
      headers: { 'content-type': 'application/json' },
      payload: '{"__proto__": {"polluted": true}}',
    });
    expect(res.statusCode).toBe(400);
    expect(called).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('response contract', () => {
  it('drops fields that are not part of the documented response', async () => {
    const h = await harness({
      handlers: {
        'cases.list': async () =>
          ({ items: [], nextCursor: null, internalNote: 'do not leak' }) as never,
      },
    });
    const res = await h.call(PERSONAS.engineer, { method: 'GET', url: '/api/v1/cases' });
    expect(res.statusCode).toBe(200);
    expect(res.data).toEqual(emptyPage);
  });

  it('turns a response that breaks the contract into a generic 500, never into leaked data', async () => {
    const h = await harness({
      handlers: {
        'cases.list': async () =>
          ({ items: [{ ssn: 'top-secret-value' }], nextCursor: null }) as never,
      },
    });
    const res = await h.call(PERSONAS.engineer, { method: 'GET', url: '/api/v1/cases' });
    expect(res.statusCode).toBe(500);
    expect(res.data.code).toBe('internal');
    expect(res.body).not.toContain('top-secret-value');
    expect(h.logs().some((line) => line.msg === 'unhandled error')).toBe(true);
  });
});

describe('error handling', () => {
  it('maps domain errors to their status, code and a safe message', async () => {
    const cases: [Error, number, string][] = [
      [new NotFoundError('Case', 'case_404'), 404, 'not_found'],
      [new VersionConflictError('Skill', 1, 2), 409, 'version_conflict'],
      [
        new ValidationFailedError('Bad input', [{ path: 'body.name', message: 'Required' }]),
        422,
        'validation_failed',
      ],
      [new BudgetExceededError('Daily token budget reached'), 429, 'budget_exceeded'],
    ];
    for (const [error, status, code] of cases) {
      const h = await harness({
        handlers: {
          'cases.get': async () => {
            throw error;
          },
        },
      });
      const res = await h.call(PERSONAS.engineer, { method: 'GET', url: '/api/v1/cases/case_1' });
      expect(res.statusCode).toBe(status);
      expect(res.data.code).toBe(code);
      expect(res.data.correlationId).toBe(res.headers['x-request-id']);
    }
  });

  it('hides unexpected errors from clients and from the logs of their secrets', async () => {
    const h = await harness({
      handlers: {
        'cases.get': async () => {
          throw new Error('connect failed for postgres://svc:hunter2@db.internal:5432/app');
        },
      },
    });
    const res = await h.call(PERSONAS.engineer, { method: 'GET', url: '/api/v1/cases/case_1' });
    expect(res.statusCode).toBe(500);
    expect(res.data.detail).toContain('correlation id');
    expect(res.body).not.toContain('hunter2');
    expect(res.body).not.toContain('postgres');
    const logged = h.logs().find((line) => line.msg === 'unhandled error');
    expect(logged).toMatchObject({ routeId: 'cases.get', code: 'internal', status: 500 });
    expect(JSON.stringify(h.logs())).not.toContain('hunter2');
  });

  it('answers unknown routes with a problem that does not reflect the path', async () => {
    const h = await harness();
    const res = await h.call(PERSONAS.engineer, {
      method: 'GET',
      url: '/api/v1/<script>alert(1)</script>',
    });
    expect(res.statusCode).toBe(404);
    expect(res.data.code).toBe('not_found');
    expect(res.body).not.toContain('script');
  });

  it('answers a documented route without a handler with 501, not a crash', async () => {
    const h = await harness({ handlers: {} });
    const res = await h.call(PERSONAS.engineer, { method: 'GET', url: '/api/v1/cases' });
    expect(res.statusCode).toBe(501);
    expect(res.data.code).toBe('not_implemented');
  });

  it('refuses to start in a build that claims to be complete but is not', async () => {
    await expect(createHarness({ database, handlers: {}, requireComplete: true })).rejects.toThrow(
      /Routes without a handler/,
    );
  });
});

describe('idempotency', () => {
  const key = 'idem-key-0001-abcd';

  // A response about a case that does not exist is deliberately not stored (the case may have been
  // erased while the request ran), so the replay tests need a case that does.
  beforeAll(async () => {
    const setup = await harness();
    await setup
      .repos(CONTOSO)
      .cases.ingest(buildIngestInput({ tenantId: CONTOSO, caseId: 'case_7' }));
  }, TEST_DATABASE_STARTUP_TIMEOUT_MS);

  function startAnalysis(
    h: Harness,
    persona: string,
    headers: Record<string, string>,
    body: object = {},
  ) {
    return h.call(persona, {
      method: 'POST',
      url: '/api/v1/cases/case_7/analysis',
      headers,
      payload: body,
    });
  }

  it('replays the stored response for a repeated key without running the handler again', async () => {
    let calls = 0;
    const h = await harness({
      handlers: {
        'analysis.start': async ({ params }) => {
          calls += 1;
          return {
            job: fakeJob(params.caseId, { id: `job_call_${calls}` }),
            runId: null,
            reused: false,
          };
        },
      },
    });
    const first = await startAnalysis(h, PERSONAS.engineer, { 'idempotency-key': `${key}-a` });
    const second = await startAnalysis(h, PERSONAS.engineer, { 'idempotency-key': `${key}-a` });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(second.data).toEqual(first.data);
    expect(calls).toBe(1);
  });

  it('rejects the same key used for a different request', async () => {
    let calls = 0;
    const h = await harness({
      handlers: {
        'analysis.start': async ({ params }) => {
          calls += 1;
          return { job: fakeJob(params.caseId), runId: null, reused: false };
        },
      },
    });
    await startAnalysis(h, PERSONAS.engineer, { 'idempotency-key': `${key}-b` }, { force: false });
    const conflict = await startAnalysis(
      h,
      PERSONAS.engineer,
      { 'idempotency-key': `${key}-b` },
      { force: true },
    );
    expect(conflict.statusCode).toBe(422);
    expect(conflict.data.code).toBe('idempotency_conflict');
    expect(calls).toBe(1);
  });

  it('scopes keys to the tenant: another tenant reusing a key runs its own request', async () => {
    let calls = 0;
    const h = await harness({
      handlers: {
        'analysis.start': async ({ params }) => {
          calls += 1;
          return { job: fakeJob(params.caseId), runId: null, reused: false };
        },
      },
    });
    await startAnalysis(h, PERSONAS.engineer, { 'idempotency-key': `${key}-c` });
    const other = await startAnalysis(h, PERSONAS.otherTenantEngineer, {
      'idempotency-key': `${key}-c`,
    });
    expect(other.statusCode).toBe(202);
    expect(other.headers['idempotent-replayed']).toBeUndefined();
    expect(calls).toBe(2);
  });

  it('frees the key when the first attempt fails so the client can retry', async () => {
    let calls = 0;
    const h = await harness({
      handlers: {
        'analysis.start': async ({ params }) => {
          calls += 1;
          if (calls === 1) throw new Error('transient');
          return { job: fakeJob(params.caseId), runId: null, reused: false };
        },
      },
    });
    const failed = await startAnalysis(h, PERSONAS.engineer, { 'idempotency-key': `${key}-d` });
    expect(failed.statusCode).toBe(500);
    const retried = await startAnalysis(h, PERSONAS.engineer, { 'idempotency-key': `${key}-d` });
    expect(retried.statusCode).toBe(202);
    expect(calls).toBe(2);
  });

  it('refuses a second identical request while the first is still running', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const h = await harness({
      handlers: {
        'analysis.start': async ({ params }) => {
          calls += 1;
          await gate;
          return { job: fakeJob(params.caseId), runId: null, reused: false };
        },
      },
    });
    const first = startAnalysis(h, PERSONAS.engineer, { 'idempotency-key': `${key}-e` });
    // Wait until the first request has reserved the key and is inside the handler.
    while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await startAnalysis(h, PERSONAS.engineer, { 'idempotency-key': `${key}-e` });
    expect(second.statusCode).toBe(409);
    release();
    expect((await first).statusCode).toBe(202);
    expect(calls).toBe(1);
  });

  it('does not deduplicate requests that carry no key', async () => {
    let calls = 0;
    const h = await harness({
      handlers: {
        'analysis.start': async ({ params }) => {
          calls += 1;
          return { job: fakeJob(params.caseId), runId: null, reused: false };
        },
      },
    });
    await startAnalysis(h, PERSONAS.engineer, {});
    await startAnalysis(h, PERSONAS.engineer, {});
    expect(calls).toBe(2);
  });

  it.each(['short', 'has spaces in it!', 'x'.repeat(200)])(
    'rejects the malformed key %s',
    async (bad) => {
      const h = await harness({ handlers: { 'analysis.start': async () => ({}) as never } });
      const res = await startAnalysis(h, PERSONAS.engineer, { 'idempotency-key': bad });
      expect(res.statusCode).toBe(422);
      expect(res.data.errors[0].path).toBe('header.idempotency-key');
    },
  );
});

describe('health probes', () => {
  it('answers liveness without credentials and without touching dependencies', async () => {
    const h = await harness();
    for (const url of ['/livez', '/healthz']) {
      const res = await h.call(null, { method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.data).toMatchObject({ status: 'up', service: 'caseguard-api' });
    }
  });

  it('reports readiness from the dependency checks, with names and states but no error text', async () => {
    const h = await harness();
    const res = await h.call(null, { method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.data.ready).toBe(true);
    const names = res.data.checks.map((check: { name: string }) => check.name);
    expect(names).toEqual(expect.arrayContaining(['database', 'migrations', 'storage']));
    expect(JSON.stringify(res.data)).not.toContain('detail');
  });

  it('returns 503 when a critical dependency is down and does not say why', async () => {
    const h = await harness();
    h.infra.health.register({
      name: 'broken_dependency',
      kind: 'database',
      critical: true,
      check: () => {
        throw new Error('password=hunter2 refused by 10.0.0.5');
      },
    });
    const res = await h.call(null, { method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.data.ready).toBe(false);
    expect(res.body).not.toContain('hunter2');
    expect(res.body).not.toContain('10.0.0.5');
    // Liveness must not follow a dependency outage, or the orchestrator would restart a healthy process.
    expect((await h.call(null, { method: 'GET', url: '/livez' })).statusCode).toBe(200);
  });
});

describe('OpenAPI document', () => {
  it('documents every route of the contract with its method, status and security', async () => {
    const h = await harness();
    const res = await h.call(null, { method: 'GET', url: '/api/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    const spec = res.data;
    expect(spec.openapi).toMatch(/^3\.1/);

    const missing: string[] = [];
    for (const [id, route] of Object.entries(ROUTES) as [RouteId, (typeof ROUTES)[RouteId]][]) {
      const path = route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
      const operation = spec.paths?.[path]?.[route.method.toLowerCase()];
      if (!operation) {
        missing.push(id);
        continue;
      }
      const status = String(('status' in route ? route.status : undefined) ?? 200);
      expect(operation.responses?.[status], `${id} documents status ${status}`).toBeDefined();
      if (id === 'dev.personas') expect(operation.security).toEqual([]);
      else expect(operation.security, `${id} documents authentication`).toBeDefined();
    }
    expect(missing).toEqual([]);
    expect(spec.components.securitySchemes.bearerAuth).toBeDefined();
  });
});
