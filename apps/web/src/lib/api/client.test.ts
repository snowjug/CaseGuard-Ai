import { ROUTES } from '@caseguard/schemas';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from './client';
import { ApiError, describeError } from './errors';
import { staleTimeFor } from './query-keys';

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function problem(status: number, code: string, extra: Record<string, unknown> = {}): Response {
  return json(
    { type: `https://caseguard.invalid/problems/${code}`, title: code, status, code, ...extra },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

const noSleep = (): Promise<void> => Promise.resolve();

function lastRequest(fetchMock: ReturnType<typeof vi.fn>): {
  url: string;
  init: RequestInit & { headers: Headers };
} {
  const call = fetchMock.mock.calls.at(-1) as [string, RequestInit & { headers: Headers }];
  return { url: call[0], init: call[1] };
}

describe('[FR-API-01] callApi: request construction', () => {
  it('builds the path from params and the query string from query, skipping empty values', async () => {
    const fetchMock = vi.fn(async () => json({ items: [], nextCursor: null }));
    const client = createApiClient({ fetch: fetchMock, newCorrelationId: () => 'corr-1' });
    await client.call('cases.list', { query: { limit: 25, status: 'open', q: '' } });
    expect(lastRequest(fetchMock).url).toBe(`${ROUTES['cases.list'].path}?limit=25&status=open`);

    await client.call('analysis.latest', { params: { caseId: 'case 1/β' } }).catch(() => undefined);
    expect(lastRequest(fetchMock).url).toBe(
      `/api/v1/cases/${encodeURIComponent('case 1/β')}/analysis`,
    );
  });

  it('sends a correlation id and JSON accept header, and a JSON body with a content type', async () => {
    const fetchMock = vi.fn(async () => json({ deleted: true }));
    const client = createApiClient({ fetch: fetchMock, newCorrelationId: () => 'corr-42' });
    await client
      .call('warnings.dismiss', {
        params: { caseId: 'case_1', warningId: 'warn_1' },
        body: { reason: 'Customer confirmed it is resolved', expectedVersion: 1 },
      })
      .catch(() => undefined);
    const { init } = lastRequest(fetchMock);
    expect(init.method).toBe('POST');
    expect(init.headers.get('x-correlation-id')).toBe('corr-42');
    expect(init.headers.get('accept')).toBe('application/json');
    expect(init.headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      reason: 'Customer confirmed it is resolved',
      expectedVersion: 1,
    });
  });

  it('adds an Idempotency-Key to idempotent writes only, and honours a caller-supplied key', async () => {
    const fetchMock = vi.fn(async () => json({}));
    const client = createApiClient({ fetch: fetchMock, newIdempotencyKey: () => 'generated-key' });
    await client
      .call('analysis.start', { params: { caseId: 'case_1' }, body: { force: false } })
      .catch(() => undefined);
    expect(lastRequest(fetchMock).init.headers.get('idempotency-key')).toBe('generated-key');

    await client
      .call('analysis.start', {
        params: { caseId: 'case_1' },
        body: { force: false },
        idempotencyKey: 'mine',
      })
      .catch(() => undefined);
    expect(lastRequest(fetchMock).init.headers.get('idempotency-key')).toBe('mine');

    await client.call('cases.get', { params: { caseId: 'case_1' } }).catch(() => undefined);
    expect(lastRequest(fetchMock).init.headers.has('idempotency-key')).toBe(false);
    await client.call('cases.delete', { params: { caseId: 'case_1' } }).catch(() => undefined);
    expect(lastRequest(fetchMock).init.headers.has('idempotency-key')).toBe(false);
  });

  it('injects the identity headers from the active auth provider on every request', async () => {
    const fetchMock = vi.fn(async () => json({}));
    const getAuthHeaders = vi.fn(async () => ({ 'x-cg-persona': 'persona_reviewer' }));
    const client = createApiClient({ fetch: fetchMock, getAuthHeaders });
    await client.call('session.me').catch(() => undefined);
    await client.call('session.me').catch(() => undefined);
    expect(getAuthHeaders).toHaveBeenCalledTimes(2);
    expect(lastRequest(fetchMock).init.headers.get('x-cg-persona')).toBe('persona_reviewer');
  });

  it('prefixes a base URL when configured and always uses same-origin credentials', async () => {
    const fetchMock = vi.fn(async () => json({}));
    await createApiClient({ fetch: fetchMock, baseUrl: 'https://app.example.test/' })
      .call('session.me')
      .catch(() => undefined);
    expect(lastRequest(fetchMock).url).toBe('https://app.example.test/api/v1/me');
    expect(lastRequest(fetchMock).init.credentials).toBe('same-origin');
  });
});

describe('[FR-API-02] callApi: failures', () => {
  it('parses RFC 9457 Problem Details into an ApiError with status, code, correlation id and issues', async () => {
    const fetchMock = vi.fn(async () =>
      problem(422, 'validation_failed', {
        detail: 'Reason is too short',
        correlationId: 'srv-9',
        errors: [{ path: 'reason', message: 'Must be at least 5 characters' }],
      }),
    );
    const client = createApiClient({ fetch: fetchMock });
    const error = await client
      .call('warnings.dismiss', {
        params: { caseId: 'c', warningId: 'w' },
        body: { reason: 'okay then', expectedVersion: 1 },
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(422);
    expect(apiError.code).toBe('validation_failed');
    expect(apiError.correlationId).toBe('srv-9');
    expect(apiError.message).toBe('Reason is too short');
    expect(apiError.issues).toEqual([{ path: 'reason', message: 'Must be at least 5 characters' }]);
  });

  it('falls back to the request correlation id and a safe message when the body is not Problem Details', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('<html>bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }),
    );
    const client = createApiClient({
      fetch: fetchMock,
      newCorrelationId: () => 'corr-7',
      maxRetries: 0,
    });
    const error = (await client.call('session.me').catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(502);
    expect(error.code).toBe('upstream_unavailable');
    expect(error.correlationId).toBe('corr-7');
    expect(error.isUnavailable).toBe(true);
    expect(error.message).not.toContain('<html>');
  });

  it('reports an unreachable server as a network error', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const error = (await createApiClient({ fetch: fetchMock, maxRetries: 0 })
      .call('session.me')
      .catch((e: unknown) => e)) as ApiError;
    expect(error.isNetwork).toBe(true);
    expect(error.status).toBe(0);
  });

  function hangingFetch() {
    const state = { aborted: false };
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const fail = (): void => {
            state.aborted = true;
            reject(new DOMException('Aborted', 'AbortError'));
          };
          if (init.signal?.aborted) fail();
          else init.signal?.addEventListener('abort', fail);
        }),
    );
    return { fetchMock: fetchMock as unknown as typeof fetch, state };
  }

  it('times out slow requests with a typed error and aborts the underlying fetch', async () => {
    vi.useFakeTimers();
    const { fetchMock, state } = hangingFetch();
    const client = createApiClient({ fetch: fetchMock, timeoutMs: 1000, maxRetries: 0 });
    const pending = client.call('session.me').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1001);
    const error = (await pending) as ApiError;
    expect(error.isTimeout).toBe(true);
    expect(state.aborted).toBe(true);
    vi.useRealTimers();
  });

  it('rethrows the caller abort untouched so TanStack Query can cancel quietly', async () => {
    const controller = new AbortController();
    const { fetchMock } = hangingFetch();
    const client = createApiClient({ fetch: fetchMock, maxRetries: 0 });
    const pending = client
      .call('session.me', { signal: controller.signal })
      .catch((e: unknown) => e);
    controller.abort();
    const error = await pending;
    expect(error).not.toBeInstanceOf(ApiError);
    expect((error as Error).name).toBe('AbortError');
  });
});

describe('[FR-API-03] callApi: retries', () => {
  it('retries idempotent reads on transient failures with backoff, then succeeds', async () => {
    const sleep = vi.fn(noSleep);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(problem(503, 'unavailable'))
      .mockResolvedValueOnce(problem(503, 'unavailable'))
      .mockResolvedValueOnce(json({ items: [], nextCursor: null }));
    const client = createApiClient({ fetch: fetchMock, sleep, random: () => 0.5 });
    await expect(client.call('cases.list')).resolves.toEqual({ items: [], nextCursor: null });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('does not retry client errors', async () => {
    const fetchMock = vi.fn(async () => problem(404, 'not_found'));
    await expect(
      createApiClient({ fetch: fetchMock, sleep: noSleep }).call('cases.get', {
        params: { caseId: 'x' },
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry the web server reporting that it is not configured to reach the API', async () => {
    const fetchMock = vi.fn(async () =>
      problem(502, 'upstream_not_configured', { detail: 'API_INTERNAL_URL is not set.' }),
    );
    const error = (await createApiClient({ fetch: fetchMock, sleep: noSleep })
      .call('session.me')
      .catch((e: unknown) => e)) as ApiError;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.isMisconfigured).toBe(true);
    expect(error.isRetryable).toBe(false);
    expect(describeError(error)).toContain('API_INTERNAL_URL');
  });

  it('never retries a non-idempotent write, even on a network failure', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const client = createApiClient({ fetch: fetchMock, sleep: noSleep });
    await expect(
      client.call('cases.delete', { params: { caseId: 'case_1' } }),
    ).rejects.toMatchObject({ code: 'network_error' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a keyed idempotent write once and reuses the same key', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(problem(503, 'unavailable'))
      .mockResolvedValueOnce(json({}));
    const client = createApiClient({
      fetch: fetchMock,
      sleep: noSleep,
      newIdempotencyKey: () => 'k-1',
    });
    await client
      .call('analysis.start', { params: { caseId: 'case_1' }, body: { force: false } })
      .catch(() => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const keys = fetchMock.mock.calls.map((call) =>
      (call[1] as { headers: Headers }).headers.get('idempotency-key'),
    );
    expect(keys).toEqual(['k-1', 'k-1']);
  });
});

describe('[FR-API-04] callApi: response validation', () => {
  const badCases = { items: 'not an array', nextCursor: null };

  it('rejects data that violates the route schema when validation is always on', async () => {
    const client = createApiClient({
      fetch: vi.fn(async () => json(badCases)),
      validation: 'always',
    });
    await expect(client.call('cases.list')).rejects.toMatchObject({
      code: 'response_contract_violation',
    });
  });

  it('lets the data through when validation is off (production default)', async () => {
    const client = createApiClient({ fetch: vi.fn(async () => json(badCases)), validation: 'off' });
    await expect(client.call('cases.list')).resolves.toEqual(badCases);
  });

  it('in sampled mode reports drift in the console but keeps the page working', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = createApiClient({
      fetch: vi.fn(async () => json(badCases)),
      validation: 'sample',
      random: () => 0,
    });
    await expect(client.call('cases.list')).resolves.toEqual(badCases);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('catches a malformed request before any network call in development', async () => {
    const fetchMock = vi.fn();
    const client = createApiClient({ fetch: fetchMock, validation: 'always' });
    await expect(
      client.call('warnings.dismiss', {
        params: { caseId: 'c', warningId: 'w' },
        body: { reason: 'no', expectedVersion: 1 },
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a multipart route without its file', async () => {
    const client = createApiClient({ fetch: vi.fn() });
    await expect(client.call('ingestion.previewFile')).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });
});

describe('query freshness', () => {
  it('gives job polling no cache and read models a short one', () => {
    expect(staleTimeFor('jobs.get')).toBe(0);
    expect(staleTimeFor('cases.list')).toBeGreaterThan(0);
  });
});
