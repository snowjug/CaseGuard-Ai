import { createConnection, type AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConflictError } from '../src/errors';
import type { Database } from '../src/db';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS } from '../src/db/testing';
import { DenialAuditThrottle } from '../src/http/denial-throttle';
import { hashRequest, idempotencyScope } from '../src/http/idempotency';
import type { HandlerMap, UploadedFile } from '../src/http/route-binder';
import {
  CONTOSO,
  PERSONAS,
  createHarness,
  openSharedDatabase,
  type Harness,
} from './support/app-harness';
import { fakeJob, multipartBody } from './support/fixtures';

/*
 * Regression tests for the API core review: throttling before authentication, denial-audit bounds,
 * truncated uploads, proxy trust, idempotency scoping and failure handling after a commit.
 */

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
  // The first harness of a file pays for loading every module of the application, which can exceed the
  // per-test timeout on a busy machine: take that cost here, where the startup timeout applies.
  await harness();
}, TEST_DATABASE_STARTUP_TIMEOUT_MS);

afterAll(async () => {
  for (const created of harnesses) await created.close();
  await database.close();
});

let keySequence = 0;
/** The database is shared by every test of the file, so each test needs keys no other one used. */
const uniqueKey = (label: string): string =>
  `${label}-${Date.now().toString(36)}-${(keySequence += 1)}`;

const analysisHandlers = (counter: { calls: number }): HandlerMap => ({
  'analysis.start': async ({ params }) => {
    counter.calls += 1;
    return { job: fakeJob(params.caseId), runId: null, reused: false };
  },
});

const startAnalysis = (
  h: Harness,
  persona: string,
  options: { key?: string; query?: string; caseId?: string } = {},
) =>
  h.call(persona, {
    method: 'POST',
    url: `/api/v1/cases/${options.caseId ?? 'case_1'}/analysis${options.query ?? ''}`,
    headers: options.key === undefined ? {} : { 'idempotency-key': options.key },
    payload: {},
  });

async function denialsOf(h: Harness, userId: string, routeId: string) {
  const page = await h.repos(CONTOSO).audit.list({ limit: 200 });
  return page.items.filter(
    (event) =>
      event.action === 'access.denied' && event.actorId === userId && event.targetId === routeId,
  );
}

/** Makes one repository method fail for every request context built after this call. */
function breakRepository<K extends 'audit' | 'idempotency'>(
  h: Harness,
  repository: K,
  method: string,
): void {
  const original = h.infra.repos.forTenant.bind(h.infra.repos);
  vi.spyOn(h.infra.repos, 'forTenant').mockImplementation((scope) => {
    const repos = original(scope);
    const broken = Object.assign(Object.create(repos[repository]) as object, {
      [method]: () => Promise.reject(new Error('connection lost')),
    });
    return { ...repos, [repository]: broken };
  });
}

describe('throttling runs before authentication', () => {
  it('throttles requests that fail authentication', async () => {
    const h = await harness({ env: { RATE_LIMIT_MAX: '3', RATE_LIMIT_WINDOW_MS: '60000' } });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      statuses.push(
        (await h.call('user_does_not_exist', { method: 'GET', url: '/api/v1/me' })).statusCode,
      );
    }
    expect(statuses).toEqual([401, 401, 401, 429, 429, 429]);
  });

  it('throttles requests that are refused for lack of a permission', async () => {
    const h = await harness({ env: { RATE_LIMIT_MAX: '3', RATE_LIMIT_WINDOW_MS: '60000' } });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      statuses.push((await startAnalysis(h, PERSONAS.manager)).statusCode);
    }
    expect(statuses).toEqual([403, 403, 403, 429, 429]);
  });
});

describe('denial audit events are bounded', () => {
  it('records the first refusal per caller and route in a window and counts the rest', async () => {
    const h = await harness();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      expect((await startAnalysis(h, PERSONAS.manager)).statusCode).toBe(403);
    }
    const first = await denialsOf(h, PERSONAS.manager, 'analysis.start');
    const recordedBefore = first.length;
    expect(first[0]?.details).not.toHaveProperty('suppressedSincePrevious');

    h.clock.advance(61_000);
    expect((await startAnalysis(h, PERSONAS.manager)).statusCode).toBe(403);
    const later = await denialsOf(h, PERSONAS.manager, 'analysis.start');
    expect(later.length).toBe(recordedBefore + 1);
    expect(later.some((event) => event.details.suppressedSincePrevious === 5)).toBe(true);
  });

  it('keeps counting refusals of different callers and routes separately', async () => {
    const h = await harness();
    await startAnalysis(h, PERSONAS.manager);
    await startAnalysis(h, PERSONAS.reviewer);
    await h.call(PERSONAS.engineer, { method: 'GET', url: '/api/v1/audit' });
    expect((await denialsOf(h, PERSONAS.manager, 'analysis.start')).length).toBeGreaterThan(0);
    expect((await denialsOf(h, PERSONAS.reviewer, 'analysis.start')).length).toBeGreaterThan(0);
    expect((await denialsOf(h, PERSONAS.engineer, 'governance.audit')).length).toBeGreaterThan(0);
  });

  it.each(['%20bad%20id', 'a%2Fb', '%3Cscript%3E', 'x'.repeat(121), '%00'])(
    'refuses with 403 and audits without the case id when it is malformed (%s)',
    async (segment) => {
      const h = await harness();
      const res = await h.call(PERSONAS.manager, {
        method: 'POST',
        url: `/api/v1/cases/${segment}/analysis`,
        payload: {},
      });
      expect(res.statusCode).toBe(403);
      const recorded = (await denialsOf(h, PERSONAS.manager, 'analysis.start')).find(
        (event) => event.correlationId === res.headers['x-request-id'],
      );
      expect(recorded).toMatchObject({ outcome: 'denied', caseId: null });
    },
  );

  it('still answers 403 when the denial cannot be written to the audit trail', async () => {
    const h = await harness();
    breakRepository(h, 'audit', 'append');
    const res = await startAnalysis(h, PERSONAS.manager);
    expect(res.statusCode).toBe(403);
    expect(res.data.code).toBe('forbidden');
    expect(h.logs().some((line) => line.event === 'audit.write_failed')).toBe(true);
  });
});

describe('uploads', () => {
  const captured: { file: UploadedFile | null } = { file: null };
  const uploadHandlers: HandlerMap = {
    'ingestion.previewFile': async ({ file }) => {
      captured.file = file;
      throw new ConflictError('captured for the test');
    },
  };
  const LIMIT = 2048;
  const BOUNDARY = '----cgboundary';
  const MULTIPART = { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` };

  /** A multipart body whose file part is `size` bytes, split into the given chunks of file content. */
  function streamedBody(size: number, splitAt: number | null) {
    const head = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="evidence.json"\r\n` +
        'Content-Type: application/json\r\n\r\n',
    );
    const content = Buffer.alloc(size, 0x78);
    const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
    const chunks =
      splitAt === null
        ? [Buffer.concat([head, content, tail])]
        : [
            Buffer.concat([head, content.subarray(0, splitAt)]),
            Buffer.concat([content.subarray(splitAt), tail]),
          ];
    return { chunks, length: chunks.reduce((sum, chunk) => sum + chunk.length, 0) };
  }

  it('accepts a file of exactly the limit and refuses one byte more', async () => {
    const h = await harness({ handlers: uploadHandlers, env: { UPLOAD_MAX_BYTES: String(LIMIT) } });
    const send = (size: number) => {
      const { payload, headers } = multipartBody([
        {
          name: 'file',
          filename: 'case.json',
          type: 'application/json',
          content: 'x'.repeat(size),
        },
      ]);
      return h.call(PERSONAS.engineer, {
        method: 'POST',
        url: '/api/v1/ingestion/preview-file',
        headers,
        payload,
      });
    };
    expect((await send(LIMIT)).statusCode).toBe(409);
    expect(captured.file?.bytes.length).toBe(LIMIT);
    const over = await send(LIMIT + 1);
    expect(over.statusCode).toBe(413);
    expect(over.data.code).toBe('payload_too_large');
  });

  it('never hands over a file cut at the limit when the cut falls on a chunk boundary', async () => {
    const h = await harness({ handlers: uploadHandlers, env: { UPLOAD_MAX_BYTES: String(LIMIT) } });
    captured.file = null;
    const { chunks } = streamedBody(LIMIT + 500, LIMIT);
    // The second chunk arrives after the first was consumed, as it does over a network.
    const slow = Readable.from(
      (async function* () {
        for (const chunk of chunks) {
          yield chunk;
          await sleep(40);
        }
      })(),
    );
    const res = await h.call(PERSONAS.engineer, {
      method: 'POST',
      url: '/api/v1/ingestion/preview-file',
      headers: MULTIPART,
      payload: slow,
    });
    expect(res.statusCode).toBe(413);
    expect(res.data.code).toBe('payload_too_large');
    expect(captured.file).toBeNull();
  });

  it('refuses an upload whose declared length is far beyond the limit without reading it', async () => {
    const h = await harness({ handlers: uploadHandlers, env: { UPLOAD_MAX_BYTES: String(LIMIT) } });
    captured.file = null;
    const { payload, headers } = multipartBody([
      { name: 'file', filename: 'case.json', type: 'application/json', content: '{}' },
    ]);
    const res = await h.call(PERSONAS.engineer, {
      method: 'POST',
      url: '/api/v1/ingestion/preview-file',
      headers: { ...headers, 'content-length': String(50 * 1024 * 1024) },
      payload,
    });
    expect(res.statusCode).toBe(413);
    expect(res.headers.connection).toBe('close');
    expect(captured.file).toBeNull();
  });

  it('answers 400, not 500, for a multipart body that ends before it is complete', async () => {
    const h = await harness({ handlers: uploadHandlers });
    const cut = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.json"\r\n\r\n{"a":`,
    );
    const res = await h.call(PERSONAS.engineer, {
      method: 'POST',
      url: '/api/v1/ingestion/preview-file',
      headers: MULTIPART,
      payload: cut,
    });
    expect(res.statusCode).toBe(400);
    expect(res.data.code).toBe('validation_failed');
    const failures = (await h.repos(CONTOSO).audit.list({ limit: 50 })).items.filter(
      (event) => event.outcome === 'failure' && event.correlationId === res.headers['x-request-id'],
    );
    expect(failures).toEqual([]);
  });

  it('answers 400 for a multipart envelope without a boundary', async () => {
    const h = await harness({ handlers: uploadHandlers });
    const res = await h.call(PERSONAS.engineer, {
      method: 'POST',
      url: '/api/v1/ingestion/preview-file',
      headers: { 'content-type': 'multipart/form-data' },
      payload: 'not multipart',
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  describe('over a real socket', () => {
    async function connect(h: Harness): Promise<number> {
      await h.app.listen({ host: '127.0.0.1', port: 0 });
      return (h.app.server.address() as AddressInfo).port;
    }

    function rawPost(
      port: number,
      persona: string,
      chunks: readonly Buffer[],
      options: { pauseMs: number; abortAfterFirstChunk?: boolean },
    ): Promise<string> {
      return new Promise((resolve, reject) => {
        const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const socket = createConnection({ host: '127.0.0.1', port });
        let received = '';
        socket.setNoDelay(true);
        socket.on('data', (data) => {
          received += data.toString('latin1');
        });
        socket.on('close', () => resolve(received));
        socket.on('error', reject);
        socket.on('connect', () => {
          void (async () => {
            socket.write(
              'POST /api/v1/ingestion/preview-file HTTP/1.1\r\nHost: localhost\r\n' +
                `x-cg-persona: ${persona}\r\ncontent-type: ${MULTIPART['content-type']}\r\n` +
                `content-length: ${length}\r\nconnection: close\r\n\r\n`,
            );
            for (const [index, chunk] of chunks.entries()) {
              socket.write(chunk);
              await sleep(options.pauseMs);
              if (options.abortAfterFirstChunk === true && index === 0) {
                socket.destroy();
                resolve(received);
                return;
              }
            }
          })();
        });
      });
    }

    it('refuses an oversized file even when the packets split it exactly at the limit', async () => {
      const h = await harness({
        handlers: uploadHandlers,
        env: { UPLOAD_MAX_BYTES: String(LIMIT) },
      });
      captured.file = null;
      const port = await connect(h);
      const { chunks } = streamedBody(LIMIT + 300, LIMIT);
      const response = await rawPost(port, PERSONAS.engineer, chunks, { pauseMs: 60 });
      expect(response).toMatch(/^HTTP\/1\.1 413 /);
      expect(response).toContain('payload_too_large');
      expect(captured.file).toBeNull();
    });

    it('survives a client that disconnects in the middle of an upload', async () => {
      const h = await harness({ handlers: uploadHandlers });
      const port = await connect(h);
      const { chunks } = streamedBody(1500, 700);
      await rawPost(port, PERSONAS.engineer, chunks, { pauseMs: 40, abortAfterFirstChunk: true });
      await sleep(150);
      const probe = await h.app.inject({ method: 'GET', url: '/livez' });
      expect(probe.statusCode).toBe(200);
      expect(h.logs().some((line) => line.msg === 'unhandled error')).toBe(false);
    });
  });
});

describe('proxy trust', () => {
  const asClient = (h: Harness, spoofed: string, client: string) =>
    h.call(PERSONAS.engineer, {
      method: 'GET',
      url: '/api/v1/me',
      headers: { 'x-forwarded-for': `${spoofed}, ${client}` },
    });

  it('with a hop count, ignores what a client put in front of the proxy address', async () => {
    const h = await harness({
      env: { TRUST_PROXY: '1', RATE_LIMIT_MAX: '3', RATE_LIMIT_WINDOW_MS: '60000' },
    });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      statuses.push((await asClient(h, `198.51.100.${attempt}`, '203.0.113.9')).statusCode);
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429, 429]);
    // A different client behind the same proxy has its own allowance.
    expect((await asClient(h, '198.51.100.1', '203.0.113.10')).statusCode).toBe(200);
  });

  it('without a trusted proxy, ignores X-Forwarded-For entirely', async () => {
    const h = await harness({ env: { RATE_LIMIT_MAX: '3', RATE_LIMIT_WINDOW_MS: '60000' } });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      statuses.push(
        (await asClient(h, `198.51.100.${attempt}`, `203.0.113.${attempt}`)).statusCode,
      );
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });

  it('with a list of proxy addresses, trusts forwarded addresses only from those proxies', async () => {
    const h = await harness({
      env: { TRUST_PROXY: '10.0.0.0/8', RATE_LIMIT_MAX: '2', RATE_LIMIT_WINDOW_MS: '60000' },
    });
    // The test client connects from 127.0.0.1, which is not in the list: its header is not believed.
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      statuses.push((await asClient(h, '198.51.100.1', `203.0.113.${attempt}`)).statusCode);
    }
    expect(statuses).toEqual([200, 200, 429, 429]);
  });
});

describe('client address header (API behind the web tier)', () => {
  const asClient = (h: Harness, address: string | null, extra: Record<string, string> = {}) =>
    h.call(PERSONAS.engineer, {
      method: 'GET',
      url: '/api/v1/me',
      headers: { ...(address === null ? {} : { 'x-cg-client-ip': address }), ...extra },
    });

  it('counts each address the web tier reports separately when the header is trusted', async () => {
    const h = await harness({
      env: {
        TRUST_CLIENT_IP_HEADER: 'true',
        RATE_LIMIT_MAX: '2',
        RATE_LIMIT_WINDOW_MS: '60000',
      },
    });
    const first = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      first.push((await asClient(h, '203.0.113.7')).statusCode);
    }
    expect(first).toEqual([200, 200, 429, 429]);
    // Another visitor behind the same web replica has their own allowance.
    expect((await asClient(h, '203.0.113.8')).statusCode).toBe(200);
    expect((await asClient(h, '2001:db8::1')).statusCode).toBe(200);
  });

  it('ignores the header unless it is trusted: a client cannot pick its own bucket', async () => {
    const h = await harness({ env: { RATE_LIMIT_MAX: '2', RATE_LIMIT_WINDOW_MS: '60000' } });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      statuses.push((await asClient(h, `203.0.113.${attempt}`)).statusCode);
    }
    expect(statuses).toEqual([200, 200, 429, 429]);
  });

  it.each([
    ['not an address', 'not-an-ip'],
    ['a list', '203.0.113.1, 203.0.113.2'],
    ['an address with a port', '203.0.113.1:443'],
    ['an overlong value', '1'.repeat(60)],
    ['an empty value', ''],
  ])('falls back to the peer address for %s', async (_label, value) => {
    const h = await harness({
      env: {
        TRUST_CLIENT_IP_HEADER: 'true',
        RATE_LIMIT_MAX: '2',
        RATE_LIMIT_WINDOW_MS: '60000',
      },
    });
    // Different malformed values all land in the peer's single bucket.
    const statuses = [
      (await asClient(h, value)).statusCode,
      (await asClient(h, `${value} `)).statusCode,
      (await asClient(h, null)).statusCode,
    ];
    expect(statuses).toEqual([200, 200, 429]);
  });

  it('limits unauthenticated attempts per reported address as well', async () => {
    const h = await harness({
      env: {
        TRUST_CLIENT_IP_HEADER: 'true',
        RATE_LIMIT_MAX: '2',
        RATE_LIMIT_WINDOW_MS: '60000',
      },
    });
    const attempt = (address: string) =>
      h.call('user_does_not_exist', {
        method: 'GET',
        url: '/api/v1/me',
        headers: { 'x-cg-client-ip': address },
      });
    expect([
      (await attempt('198.51.100.5')).statusCode,
      (await attempt('198.51.100.5')).statusCode,
      (await attempt('198.51.100.5')).statusCode,
    ]).toEqual([401, 401, 429]);
    expect((await attempt('198.51.100.6')).statusCode).toBe(401);
  });
});

describe('idempotency', () => {
  it('keeps a key private to the user who chose it', async () => {
    const counter = { calls: 0 };
    const h = await harness({ handlers: analysisHandlers(counter) });
    const key = uniqueKey('private');
    const engineer = await startAnalysis(h, PERSONAS.engineer, { key });
    const admin = await startAnalysis(h, PERSONAS.admin, { key });
    expect(engineer.statusCode).toBe(202);
    expect(admin.statusCode).toBe(202);
    expect(admin.headers['idempotent-replayed']).toBeUndefined();
    expect(counter.calls).toBe(2);

    const again = await startAnalysis(h, PERSONAS.engineer, { key });
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(counter.calls).toBe(2);
  });

  it('lets one user register a key without blocking the same key for another user', async () => {
    const counter = { calls: 0 };
    const h = await harness({ handlers: analysisHandlers(counter) });
    const key = uniqueKey('squat');
    const squatter = await startAnalysis(h, PERSONAS.admin, { key, caseId: 'case_other' });
    expect(squatter.statusCode).toBe(202);
    const victim = await startAnalysis(h, PERSONAS.engineer, { key, caseId: 'case_1' });
    expect(victim.statusCode).toBe(202);
  });

  it('marks the audit event of a replay and leaves the original unmarked', async () => {
    const h = await harness({ handlers: analysisHandlers({ calls: 0 }) });
    const key = uniqueKey('replay-audit');
    const first = await startAnalysis(h, PERSONAS.engineer, { key });
    const replay = await startAnalysis(h, PERSONAS.engineer, { key });
    expect(replay.headers['idempotent-replayed']).toBe('true');

    const events = (await h.repos(CONTOSO).audit.list({ limit: 100 })).items.filter(
      (event) => event.action === 'api.analysis.start',
    );
    const original = events.find((event) => event.correlationId === first.headers['x-request-id']);
    const repeated = events.find((event) => event.correlationId === replay.headers['x-request-id']);
    expect(original?.details).not.toHaveProperty('replayed');
    expect(repeated?.details).toMatchObject({ replayed: true });
  });

  it('hashes a request that carries an unvalidated query string', async () => {
    const counter = { calls: 0 };
    const h = await harness({ handlers: analysisHandlers(counter) });
    const key = uniqueKey('query');
    const first = await startAnalysis(h, PERSONAS.engineer, { key, query: '?utm=1' });
    expect(first.statusCode).toBe(202);
    const replay = await startAnalysis(h, PERSONAS.engineer, { key, query: '?utm=1' });
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(counter.calls).toBe(1);
    const different = await startAnalysis(h, PERSONAS.engineer, { key, query: '?utm=2' });
    expect(different.statusCode).toBe(422);
    expect(different.data.code).toBe('idempotency_conflict');
  });

  it('answers 422, not 500, when an idempotent body is nested absurdly deep', async () => {
    const h = await harness({
      handlers: {
        'cases.create': async () => {
          throw new ConflictError('must not run');
        },
      },
    });
    let nested: unknown = 'leaf';
    for (let level = 0; level < 300; level += 1) nested = [nested];
    const res = await h.call(PERSONAS.engineer, {
      method: 'POST',
      url: '/api/v1/cases',
      headers: { 'idempotency-key': uniqueKey('deep') },
      payload: { source: { type: 'bundle', bundle: nested } },
    });
    expect(res.statusCode).toBe(422);
    expect(res.data.code).toBe('validation_failed');
  });

  it('returns the result, and keeps the key reserved, when the response cannot be stored', async () => {
    const counter = { calls: 0 };
    const h = await harness({ handlers: analysisHandlers(counter) });
    breakRepository(h, 'idempotency', 'complete');
    const key = uniqueKey('complete-fails');
    const first = await startAnalysis(h, PERSONAS.engineer, { key });
    expect(first.statusCode).toBe(202);
    expect(h.logs().some((line) => line.event === 'idempotency.complete_failed')).toBe(true);

    // The retry must not run the work again: the key is still reserved.
    const retry = await startAnalysis(h, PERSONAS.engineer, { key });
    expect(retry.statusCode).toBe(409);
    expect(counter.calls).toBe(1);
  });

  it('frees the key when the handler itself fails, so the client can retry', async () => {
    let attempts = 0;
    const h = await harness({
      handlers: {
        'analysis.start': async ({ params }) => {
          attempts += 1;
          if (attempts === 1) throw new ConflictError('first attempt fails');
          return { job: fakeJob(params.caseId), runId: null, reused: false };
        },
      },
    });
    const key = uniqueKey('retry');
    expect((await startAnalysis(h, PERSONAS.engineer, { key })).statusCode).toBe(409);
    expect((await startAnalysis(h, PERSONAS.engineer, { key })).statusCode).toBe(202);
    expect(attempts).toBe(2);
  });

  it('does not turn a success into an error when its audit event cannot be written', async () => {
    const counter = { calls: 0 };
    const h = await harness({ handlers: analysisHandlers(counter) });
    breakRepository(h, 'audit', 'append');
    const res = await startAnalysis(h, PERSONAS.engineer, { key: uniqueKey('audit-fails') });
    expect(res.statusCode).toBe(202);
    expect(counter.calls).toBe(1);
    expect(h.logs().some((line) => line.event === 'audit.write_failed')).toBe(true);
  });

  it('scopes keys by route and user without storing the user id', () => {
    const scope = idempotencyScope('analysis.start', 'user_ava_engineer');
    expect(scope).toMatch(/^analysis\.start:[a-f0-9]{24}$/);
    expect(scope).not.toContain('ava');
    expect(idempotencyScope('analysis.start', 'user_riley_reviewer')).not.toBe(scope);
    expect(idempotencyScope('skills.extract', 'user_ava_engineer')).not.toBe(scope);
  });

  it('fingerprints requests by content, not by object identity or key order', () => {
    const base = {
      routeId: 'analysis.start',
      params: { caseId: 'c1' },
      query: {},
      file: undefined,
    };
    const one = hashRequest({ ...base, body: { a: 1, b: [1, 2] } });
    expect(hashRequest({ ...base, body: { b: [1, 2], a: 1 } })).toBe(one);
    expect(hashRequest({ ...base, body: { a: 2, b: [1, 2] } })).not.toBe(one);
    expect(
      hashRequest({ ...base, body: {}, file: { sha256: 'a'.repeat(64), name: 'x.json' } }),
    ).not.toBe(hashRequest({ ...base, body: {} }));
  });
});

describe('errors Fastify raises before routing', () => {
  it('answers a malformed URL with a problem, the usual headers and no echo of the path', async () => {
    const h = await harness();
    const res = await h.call(null, { method: 'GET', url: '/%' });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.data).toMatchObject({
      code: 'validation_failed',
      status: 400,
      detail: 'The request URL is not valid',
    });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-request-id']).toBe(res.data.correlationId);
    expect(res.body).not.toContain('%');
  });
});

describe('DenialAuditThrottle', () => {
  it('admits the first refusal of a key and suppresses the rest of the window', () => {
    let now = 1_000;
    const throttle = new DenialAuditThrottle(60_000, () => now);
    expect(throttle.admit('a')).toEqual({ write: true, suppressed: 0 });
    for (let index = 0; index < 4; index += 1) {
      expect(throttle.admit('a')).toEqual({ write: false, suppressed: 0 });
    }
    expect(throttle.admit('b')).toEqual({ write: true, suppressed: 0 });
    now += 60_000;
    expect(throttle.admit('a')).toEqual({ write: true, suppressed: 4 });
    expect(throttle.admit('a')).toEqual({ write: false, suppressed: 0 });
  });

  it('forgets the oldest keys instead of growing without bound', () => {
    const throttle = new DenialAuditThrottle(60_000, () => 5_000, 3);
    for (const key of ['a', 'b', 'c', 'd']) throttle.admit(key);
    // "a" was evicted, so it is admitted again; "d" is still inside its window.
    expect(throttle.admit('a').write).toBe(true);
    expect(throttle.admit('d').write).toBe(false);
  });
});
