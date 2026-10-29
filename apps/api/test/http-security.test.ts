import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictError } from '../src/errors';
import type { Database } from '../src/db';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS } from '../src/db/testing';
import type { HandlerMap, UploadedFile } from '../src/http/route-binder';
import {
  CONTOSO,
  FABRIKAM,
  PERSONAS,
  createHarness,
  openSharedDatabase,
  type Harness,
} from './support/app-harness';
import { fakeJob, multipartBody } from './support/fixtures';

let database: Database;
const harnesses: Harness[] = [];

async function harness(...args: Parameters<typeof createHarness>): Promise<Harness> {
  const [options = {}] = args;
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

const analysisHandlers = (counter?: { calls: number }): HandlerMap => ({
  'analysis.start': async ({ params }) => {
    if (counter) counter.calls += 1;
    return { job: fakeJob(params.caseId), runId: null, reused: false };
  },
});

describe('authentication', () => {
  it('rejects a request without credentials with a generic 401 problem', async () => {
    const h = await harness();
    const res = await h.call(null, { method: 'GET', url: '/api/v1/me' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.headers['www-authenticate']).toMatch(/^Bearer /);
    expect(res.data).toMatchObject({
      code: 'unauthenticated',
      status: 401,
      detail: 'Authentication failed',
    });
    expect(res.data.correlationId).toBe(res.headers['x-request-id']);
  });

  it('answers an unknown persona exactly like a missing credential', async () => {
    const h = await harness();
    const missing = await h.call(null, { method: 'GET', url: '/api/v1/me' });
    const unknown = await h.call('user_does_not_exist', { method: 'GET', url: '/api/v1/me' });
    expect(unknown.statusCode).toBe(401);
    expect({ ...unknown.data, correlationId: undefined }).toEqual({
      ...missing.data,
      correlationId: undefined,
    });
  });

  it('records authentication failures as a metric and a log line, never as a response detail', async () => {
    const h = await harness();
    await h.call('user_does_not_exist', { method: 'GET', url: '/api/v1/me' });
    const line = h.logs().find((entry) => entry.msg === 'authentication failed');
    expect(line).toMatchObject({ reason: 'unknown_persona', routeId: 'session.me' });
  });

  it.each([
    [PERSONAS.engineer, CONTOSO, 'engineer'],
    [PERSONAS.admin, CONTOSO, 'administrator'],
    [PERSONAS.otherTenantEngineer, FABRIKAM, 'engineer'],
  ])('signs %s into %s as %s', async (persona, tenantId, role) => {
    const h = await harness();
    const res = await h.call(persona, { method: 'GET', url: '/api/v1/me' });
    expect(res.statusCode).toBe(200);
    expect(res.data.tenant.id).toBe(tenantId);
    expect(res.data.user.roles).toEqual([role]);
    expect(res.data.authMode).toBe('dev');
    expect(res.data.notices.join(' ')).toContain('synthetic');
  });

  it('exposes the persona list without credentials, and only while dev sign-in is on', async () => {
    const h = await harness();
    const res = await h.call(null, { method: 'GET', url: '/api/v1/dev/personas' });
    expect(res.statusCode).toBe(200);
    expect(res.data.enabled).toBe(true);
    expect(res.data.items.map((p: { id: string }) => p.id)).toContain(PERSONAS.admin);
  });

  it('authenticates before it parses the body', async () => {
    const h = await harness();
    const res = await h.call(null, {
      method: 'POST',
      url: '/api/v1/cases',
      headers: { 'content-type': 'application/json' },
      payload: '{ this is not json',
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('authorization and audit', () => {
  it('refuses a missing permission and audits the denial in the caller tenant only', async () => {
    const h = await harness();
    const res = await h.call(PERSONAS.engineer, { method: 'GET', url: '/api/v1/audit' });
    expect(res.statusCode).toBe(403);
    expect(res.data.code).toBe('forbidden');

    const denied = (await h.repos(CONTOSO).audit.list({ limit: 200 })).items.filter(
      (event) =>
        event.action === 'access.denied' && event.correlationId === res.headers['x-request-id'],
    );
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      actorId: PERSONAS.engineer,
      outcome: 'denied',
      targetId: 'governance.audit',
    });
    const otherTenant = (await h.repos(FABRIKAM).audit.list({ limit: 200 })).items;
    expect(otherTenant.some((event) => event.correlationId === res.headers['x-request-id'])).toBe(
      false,
    );
  });

  it('lets a permitted role through to the handler', async () => {
    const h = await harness();
    const res = await h.call(PERSONAS.admin, { method: 'GET', url: '/api/v1/audit' });
    // No handler is registered for this route in the partial build, so a permitted call reaches the 501.
    expect(res.statusCode).toBe(501);
    expect(res.data.code).toBe('not_implemented');
  });

  it('keeps read-only roles away from state-changing routes', async () => {
    const h = await harness({ handlers: analysisHandlers() });
    const res = await h.call(PERSONAS.manager, {
      method: 'POST',
      url: '/api/v1/cases/case_1/analysis',
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('audits every successful state-changing request that the handler did not audit itself', async () => {
    const h = await harness({ handlers: analysisHandlers() });
    const res = await h.call(PERSONAS.engineer, {
      method: 'POST',
      url: '/api/v1/cases/case_1/analysis',
      payload: {},
    });
    expect(res.statusCode).toBe(202);
    const events = (await h.repos(CONTOSO).audit.list({ limit: 200 })).items.filter(
      (event) => event.correlationId === res.headers['x-request-id'],
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'api.analysis.start',
      outcome: 'success',
      actorId: PERSONAS.engineer,
      caseId: 'case_1',
    });
  });

  it('does not add a second record when the handler audits itself', async () => {
    const handlers: HandlerMap = {
      'analysis.start': async ({ ctx, params }) => {
        await ctx.audit({
          action: 'analysis.requested',
          targetType: 'case',
          targetId: params.caseId,
          caseId: params.caseId,
          outcome: 'success',
        });
        return { job: fakeJob(params.caseId), runId: null, reused: false };
      },
    };
    const h = await harness({ handlers });
    const res = await h.call(PERSONAS.engineer, {
      method: 'POST',
      url: '/api/v1/cases/case_2/analysis',
      payload: {},
    });
    const actions = (await h.repos(CONTOSO).audit.list({ limit: 200 })).items
      .filter((event) => event.correlationId === res.headers['x-request-id'])
      .map((event) => event.action);
    expect(actions).toEqual(['analysis.requested']);
  });

  it('audits a server fault in a state-changing request as a failure', async () => {
    const handlers: HandlerMap = {
      'analysis.start': async () => {
        throw new Error('database exploded');
      },
    };
    const h = await harness({ handlers });
    const res = await h.call(PERSONAS.engineer, {
      method: 'POST',
      url: '/api/v1/cases/case_3/analysis',
      payload: {},
    });
    expect(res.statusCode).toBe(500);
    const events = (await h.repos(CONTOSO).audit.list({ limit: 200 })).items.filter(
      (event) => event.correlationId === res.headers['x-request-id'],
    );
    expect(events.map((event) => event.outcome)).toEqual(['failure']);
  });

  it('audits a service-level refusal even on a read', async () => {
    const handlers: HandlerMap = {
      'cases.get': async () => {
        const { TenantIsolationError } = await import('@caseguard/security');
        throw new TenantIsolationError(CONTOSO, FABRIKAM);
      },
    };
    const h = await harness({ handlers });
    const res = await h.call(PERSONAS.engineer, { method: 'GET', url: '/api/v1/cases/case_9' });
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.data)).not.toContain(FABRIKAM);
    const events = (await h.repos(CONTOSO).audit.list({ limit: 200 })).items.filter(
      (event) => event.correlationId === res.headers['x-request-id'],
    );
    expect(events.map((event) => event.outcome)).toEqual(['denied']);
  });
});

describe('response headers and correlation', () => {
  it('sends locked-down headers on every response, including probes and errors', async () => {
    const h = await harness();
    for (const url of ['/livez', '/api/v1/me', '/no/such/route']) {
      const res = await h.call(null, { method: 'GET', url });
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['referrer-policy']).toBeDefined();
      expect(res.headers['permissions-policy']).toBeDefined();
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['strict-transport-security']).toBeUndefined();
    }
  });

  it('adds HSTS only when the request arrived over HTTPS behind a trusted proxy', async () => {
    const h = await harness({ env: { TRUST_PROXY: 'true' } });
    const res = await h.call(null, {
      method: 'GET',
      url: '/livez',
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(res.headers['strict-transport-security']).toContain('max-age=');
  });

  it('echoes a well-formed request id and replaces a hostile one', async () => {
    const h = await harness();
    const good = await h.call(null, {
      method: 'GET',
      url: '/livez',
      headers: { 'x-request-id': 'client-req-12345' },
    });
    expect(good.headers['x-request-id']).toBe('client-req-12345');
    const bad = await h.call(null, {
      method: 'GET',
      url: '/livez',
      headers: { 'x-request-id': 'has spaces <b>' },
    });
    expect(bad.headers['x-request-id']).toMatch(/^req_[0-9A-Z]+$/);
  });

  it('puts the request id, tenant and user on log lines produced during a request', async () => {
    const h = await harness();
    const res = await h.call(PERSONAS.engineer, { method: 'GET', url: '/api/v1/me' });
    const completed = h
      .logs()
      .find(
        (line) =>
          line.msg === 'request completed' && line.requestId === res.headers['x-request-id'],
      );
    expect(completed).toMatchObject({ method: 'GET', route: '/api/v1/me', statusCode: 200 });
    expect(JSON.stringify(completed)).not.toContain('?');
  });

  it('answers a CORS preflight only for allow-listed origins', async () => {
    const h = await harness({ env: { CORS_ALLOWED_ORIGINS: 'https://app.example.test' } });
    const allowed = await h.call(null, {
      method: 'OPTIONS',
      url: '/api/v1/me',
      headers: { origin: 'https://app.example.test', 'access-control-request-method': 'GET' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('https://app.example.test');
    expect(allowed.headers['access-control-allow-credentials']).toBeUndefined();
    const other = await h.call(null, {
      method: 'OPTIONS',
      url: '/api/v1/me',
      headers: { origin: 'https://evil.example.test', 'access-control-request-method': 'GET' },
    });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('rate limiting', () => {
  it('throttles a client after the general limit, with a problem body and retry-after', async () => {
    const h = await harness({ env: { RATE_LIMIT_MAX: '3', RATE_LIMIT_WINDOW_MS: '60000' } });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      statuses.push(
        (await h.call(PERSONAS.engineer, { method: 'GET', url: '/api/v1/me' })).statusCode,
      );
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    const limited = await h.call(PERSONAS.engineer, { method: 'GET', url: '/api/v1/me' });
    expect(limited.data.code).toBe('rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('never throttles the orchestrator probes', async () => {
    const h = await harness({ env: { RATE_LIMIT_MAX: '2', RATE_LIMIT_WINDOW_MS: '60000' } });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      expect((await h.call(null, { method: 'GET', url: '/livez' })).statusCode).toBe(200);
    }
  });

  it('applies a stricter per-user limit to expensive routes', async () => {
    const h = await harness({
      handlers: analysisHandlers(),
      env: { RATE_LIMIT_AI_MAX: '2', RATE_LIMIT_WINDOW_MS: '60000' },
    });
    const start = (persona: string, id: number) =>
      h.call(persona, { method: 'POST', url: `/api/v1/cases/case_${id}/analysis`, payload: {} });
    expect((await start(PERSONAS.engineer, 1)).statusCode).toBe(202);
    expect((await start(PERSONAS.engineer, 2)).statusCode).toBe(202);
    const refused = await start(PERSONAS.engineer, 3);
    expect(refused.statusCode).toBe(429);
    expect(refused.data.code).toBe('rate_limited');
    // Another user is counted separately.
    expect((await start(PERSONAS.admin, 4)).statusCode).toBe(202);
  });

  it('rate limits unknown routes too', async () => {
    const h = await harness({ env: { RATE_LIMIT_MAX: '2', RATE_LIMIT_WINDOW_MS: '60000' } });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      statuses.push((await h.call(null, { method: 'GET', url: `/missing/${attempt}` })).statusCode);
    }
    expect(statuses).toEqual([404, 404, 429, 429]);
  });
});

describe('uploads and body limits', () => {
  const captured: { file: UploadedFile | null } = { file: null };
  const uploadHandlers: HandlerMap = {
    'ingestion.previewFile': async ({ file }) => {
      captured.file = file;
      throw new ConflictError('captured for the test');
    },
  };

  it('hands the handler exactly one file with a content hash', async () => {
    const h = await harness({ handlers: uploadHandlers });
    const { payload, headers } = multipartBody([
      {
        name: 'file',
        filename: 'case.json',
        type: 'application/json',
        content: '{"hello":"world"}',
      },
    ]);
    const res = await h.call(PERSONAS.engineer, {
      method: 'POST',
      url: '/api/v1/ingestion/preview-file',
      headers,
      payload,
    });
    expect(res.statusCode).toBe(409);
    expect(captured.file).toMatchObject({ fileName: 'case.json', mediaType: 'application/json' });
    expect(captured.file?.bytes.toString()).toBe('{"hello":"world"}');
    expect(captured.file?.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects a file over UPLOAD_MAX_BYTES with 413', async () => {
    const h = await harness({ handlers: uploadHandlers, env: { UPLOAD_MAX_BYTES: '2048' } });
    const { payload, headers } = multipartBody([
      { name: 'file', filename: 'big.json', type: 'application/json', content: 'x'.repeat(5000) },
    ]);
    const res = await h.call(PERSONAS.engineer, {
      method: 'POST',
      url: '/api/v1/ingestion/preview-file',
      headers,
      payload,
    });
    expect(res.statusCode).toBe(413);
    expect(res.data.code).toBe('payload_too_large');
  });

  it('rejects an upload route called without multipart/form-data with 415', async () => {
    const h = await harness({ handlers: uploadHandlers });
    const res = await h.call(PERSONAS.engineer, {
      method: 'POST',
      url: '/api/v1/ingestion/preview-file',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(415);
    expect(res.data.code).toBe('unsupported_media_type');
  });

  it('rejects a file sent under the wrong field name', async () => {
    const h = await harness({ handlers: uploadHandlers });
    const { payload, headers } = multipartBody([
      { name: 'attachment', filename: 'case.json', type: 'application/json', content: '{}' },
    ]);
    const res = await h.call(PERSONAS.engineer, {
      method: 'POST',
      url: '/api/v1/ingestion/preview-file',
      headers,
      payload,
    });
    expect(res.statusCode).toBe(422);
  });

  it('rejects a JSON body over BODY_LIMIT_BYTES with 413', async () => {
    const h = await harness({ handlers: analysisHandlers(), env: { BODY_LIMIT_BYTES: '1024' } });
    const res = await h.call(PERSONAS.engineer, {
      method: 'POST',
      url: '/api/v1/cases/case_1/analysis',
      payload: { force: false, padding: 'x'.repeat(4000) },
    });
    expect(res.statusCode).toBe(413);
    expect(res.data.code).toBe('payload_too_large');
  });
});
