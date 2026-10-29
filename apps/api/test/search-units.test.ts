import type { SearchConfig } from '@caseguard/config';
import { SearchResultSchema } from '@caseguard/schemas';
import { describe, expect, it, vi } from 'vitest';
import type { SearchHit } from '../src/db';
import { ValidationFailedError } from '../src/errors';
import {
  AZURE_SEARCH_API_VERSION,
  AZURE_SEARCH_SCOPE,
  AZURE_SEARCH_TIMEOUT_MS,
  SearchProviderError,
  buildSearchUrl,
  createAzureSearchClient,
  createSearchService,
  hrefFor,
  mapDocuments,
  normalizeQuery,
  tenantFilter,
  toSearchResult,
  type AzureSearchClient,
  type AzureSearchOutcome,
  type SearchContext,
  type SearchCredential,
  type SearchProviderFailure,
} from '../src/services/search';

const CONTOSO = 'tenant_contoso_support';
const ENDPOINT = 'https://example-search.search.windows.net';
const INDEX = 'caseguard-test';

const hit = (overrides: Partial<SearchHit> = {}): SearchHit => ({
  type: 'case',
  id: 'case_alpha',
  caseId: 'case_alpha',
  title: 'Sign-in outage',
  snippet: 'Users cannot sign in.',
  score: 0.5,
  ...overrides,
});

describe('[FR-UX-04] result links (pure)', () => {
  it('links every kind of hit to the web route that shows it', () => {
    expect(hrefFor(hit({ type: 'case', id: 'case_alpha' }))).toBe('/cases/case_alpha');
    expect(hrefFor(hit({ type: 'skill', id: 'skill_proxy', caseId: null }))).toBe(
      '/skills/skill_proxy',
    );
    expect(hrefFor(hit({ type: 'claim', id: 'clm_1' }))).toBe(
      '/cases/case_alpha/evidence?sel=clm_1',
    );
    expect(hrefFor(hit({ type: 'hypothesis', id: 'hyp_1' }))).toBe(
      '/cases/case_alpha/hypotheses?sel=hyp_1',
    );
    expect(hrefFor(hit({ type: 'event', id: 'evt_03' }))).toBe(
      '/cases/case_alpha/timeline?sel=evt_03',
    );
    expect(hrefFor(hit({ type: 'warning', id: 'wrn_1' }))).toBe(
      '/cases/case_alpha/quality?sel=wrn_1',
    );
  });

  it('encodes identifiers and never builds a broken link for a case-scoped hit without a case', () => {
    expect(hrefFor(hit({ type: 'case', id: 'a b/c?d' }))).toBe('/cases/a%20b%2Fc%3Fd');
    expect(hrefFor(hit({ type: 'event', id: 'e/1', caseId: 'c 1' }))).toBe(
      '/cases/c%201/timeline?sel=e%2F1',
    );
    expect(hrefFor(hit({ type: 'claim', id: 'clm_1', caseId: null }))).toBe('/cases');
  });

  it('maps a hit to a schema-valid result: masked credentials, bounded text, same score', () => {
    const long = 'x'.repeat(500);
    const result = toSearchResult(
      hit({
        title: `Token ${'Bearer abcdefghijklmnopqrstuvwxyz0123456789'} leaked`,
        snippet: long,
        score: 0.8123,
      }),
    );
    expect(SearchResultSchema.parse(result)).toEqual(result);
    expect(result.title).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(result.title).toContain('REDACTED');
    expect(Array.from(result.snippet)).toHaveLength(300);
    expect(result.score).toBe(0.8123);
    expect(result.href).toBe('/cases/case_alpha');
  });
});

describe('[FR-UX-04] query normalisation (pure)', () => {
  it('collapses blanks, drops control characters and trims', () => {
    expect(normalizeQuery('  sign-in \t  outage\u0000 ')).toBe('sign-in outage');
  });

  it('rejects text that is empty once cleaned (422 with the field path)', () => {
    for (const text of ['', ' ', '   ', 'a', ' a ', '\u0000\u0001']) {
      try {
        normalizeQuery(text);
        expect.unreachable(`"${text}" should be rejected`);
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationFailedError);
        expect((error as ValidationFailedError).issues[0]?.path).toBe('query.q');
      }
    }
    expect(normalizeQuery('ab')).toBe('ab');
    expect(normalizeQuery('日本')).toBe('日本');
  });
});

describe('[NFR-SEC-04] Azure AI Search request building (pure)', () => {
  it('targets the documented REST endpoint with the pinned API version', () => {
    const url = buildSearchUrl({ endpoint: ENDPOINT, index: INDEX });
    expect(url.href).toBe(
      `${ENDPOINT}/indexes/${INDEX}/docs/search?api-version=${AZURE_SEARCH_API_VERSION}`,
    );
    expect(AZURE_SEARCH_API_VERSION).toBe('2024-07-01');
    expect(AZURE_SEARCH_SCOPE).toBe('https://search.azure.com/.default');
    expect(AZURE_SEARCH_TIMEOUT_MS).toBe(3000);
    // A path on the configured endpoint is ignored: only the origin is used.
    expect(buildSearchUrl({ endpoint: `${ENDPOINT}/anything?x=1`, index: INDEX }).pathname).toBe(
      `/indexes/${INDEX}/docs/search`,
    );
  });

  it.each([
    ['http scheme', 'http://example-search.search.windows.net'],
    ['another domain', 'https://example-search.example.com'],
    ['look-alike suffix', 'https://example-search.search.windows.net.evil.example'],
    ['bare service domain', 'https://search.windows.net'],
    ['IP literal', 'https://10.0.0.4'],
    ['metadata address', 'https://169.254.169.254'],
    ['embedded credentials', 'https://user:pw@example-search.search.windows.net'],
    ['non-default port', 'https://example-search.search.windows.net:8443'],
    ['not a URL', 'example-search'],
    ['empty', ''],
  ])('refuses an unsafe endpoint (%s)', (_label, endpoint) => {
    try {
      buildSearchUrl({ endpoint, index: INDEX });
      expect.unreachable('the endpoint should be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(SearchProviderError);
      expect((error as SearchProviderError).failure).toBe('unsafe_endpoint');
      expect((error as SearchProviderError).message).not.toContain(endpoint || 'never-empty-match');
    }
  });

  it.each(['', 'Caseguard', 'a/b', '../x', 'x?y=1', '-bad', 'a'.repeat(129)])(
    'refuses an invalid index name (%j)',
    (index) => {
      expect(() => buildSearchUrl({ endpoint: ENDPOINT, index })).toThrow(SearchProviderError);
    },
  );

  it('always filters by tenant, with the id validated and quote-escaped', () => {
    expect(tenantFilter(CONTOSO)).toBe(`tenantId eq '${CONTOSO}'`);
    for (const hostile of ["x' or tenantId ne 'y", 'a b', '', "o'brien"]) {
      expect(() => tenantFilter(hostile)).toThrow(SearchProviderError);
    }
  });

  it('maps documents, normalising scores and discarding malformed or foreign-tenant ones', () => {
    const outcome = mapDocuments(
      [
        {
          '@search.score': 3,
          id: 'case_a',
          tenantId: CONTOSO,
          type: 'case',
          title: 'A',
          snippet: 's',
        },
        {
          '@search.score': 1,
          id: 'tenant_contoso_support:event:evt_1',
          entityId: 'evt_1',
          tenantId: CONTOSO,
          type: 'event',
          caseId: 'case_a',
          title: 'E',
        },
        {
          '@search.score': 0.5,
          id: 'skill_1',
          tenantId: CONTOSO,
          type: 'skill',
          caseId: 'case_a',
          title: 'S',
        },
        {
          '@search.score': 9,
          id: 'case_x',
          tenantId: 'tenant_fabrikam_lab',
          type: 'case',
          title: 'FOREIGN',
        },
        { '@search.score': 'high', id: 'bad', tenantId: CONTOSO, type: 'case', title: 'B' },
        { id: 'no-score', tenantId: CONTOSO, type: 'case', title: 'B' },
        null,
        'text',
      ],
      CONTOSO,
    );
    expect(outcome.droppedForeignTenant).toBe(1);
    expect(outcome.droppedInvalid).toBe(4);
    expect(outcome.hits).toEqual([
      { type: 'case', id: 'case_a', caseId: 'case_a', title: 'A', snippet: 's', score: 0.75 },
      { type: 'event', id: 'evt_1', caseId: 'case_a', title: 'E', snippet: '', score: 0.5 },
      { type: 'skill', id: 'skill_1', caseId: null, title: 'S', snippet: '', score: 0.3333 },
    ]);
    expect(JSON.stringify(outcome)).not.toContain('FOREIGN');
  });
});

interface Recorded {
  readonly url: string;
  readonly init: RequestInit;
  readonly body: Record<string, unknown>;
}

function recordingFetch(respond: (call: Recorded) => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const fetchFake: typeof fetch = async (input, init = {}) => {
    const call: Recorded = {
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      init,
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {},
    };
    calls.push(call);
    return respond(call);
  };
  return { fetch: fetchFake, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function credential(token: string | null = 'fake-token-not-a-secret') {
  const getToken = vi.fn(async (_scope: string, _options?: { abortSignal?: AbortSignal }) =>
    token === null ? null : { token },
  );
  const fake: SearchCredential = { getToken };
  return { credential: fake, getToken };
}

const sampleDocument = {
  '@search.score': 2,
  id: 'case_alpha',
  tenantId: CONTOSO,
  type: 'case',
  title: 'Sign-in outage',
  snippet: 'Users cannot sign in.',
};

const request = { tenantId: CONTOSO, text: 'sign-in outage', limit: 5 };

async function failureOf(run: () => Promise<unknown>): Promise<SearchProviderError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof SearchProviderError) return error;
    throw error;
  }
  throw new Error('Expected a SearchProviderError');
}

describe('[NFR-SEC-04] Azure AI Search client (injected fake fetch and credential only)', () => {
  it('POSTs the tenant-filtered query with a bearer token and never follows redirects', async () => {
    const { fetch: fakeFetch, calls } = recordingFetch(() => json({ value: [sampleDocument] }));
    const { credential: fakeCredential, getToken } = credential();
    const client = createAzureSearchClient({
      endpoint: ENDPOINT,
      index: INDEX,
      credential: fakeCredential,
      fetch: fakeFetch,
    });

    const outcome = await client.search(request);
    expect(outcome.hits).toEqual([
      {
        type: 'case',
        id: 'case_alpha',
        caseId: 'case_alpha',
        title: 'Sign-in outage',
        snippet: 'Users cannot sign in.',
        score: 0.6667,
      },
    ]);

    expect(getToken).toHaveBeenCalledTimes(1);
    expect(getToken.mock.calls[0]?.[0]).toBe('https://search.azure.com/.default');
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(`${ENDPOINT}/indexes/${INDEX}/docs/search?api-version=2024-07-01`);
    expect(call?.init.method).toBe('POST');
    expect(call?.init.redirect).toBe('error');
    expect(call?.init.headers).toMatchObject({
      authorization: 'Bearer fake-token-not-a-secret',
      'content-type': 'application/json',
    });
    expect(call?.body).toMatchObject({
      search: 'sign-in outage',
      top: 5,
      filter: `tenantId eq '${CONTOSO}'`,
      queryType: 'simple',
      searchMode: 'all',
    });
    expect(call?.body.select).toBe('id,tenantId,type,entityId,caseId,title,snippet');
  });

  it('uses the tenant of the caller in the filter, for every tenant', async () => {
    const { fetch: fakeFetch, calls } = recordingFetch(() => json({ value: [] }));
    const client = createAzureSearchClient({
      endpoint: ENDPOINT,
      index: INDEX,
      credential: credential().credential,
      fetch: fakeFetch,
    });
    await client.search({ ...request, tenantId: 'tenant_fabrikam_lab' });
    expect(calls[0]?.body.filter).toBe("tenantId eq 'tenant_fabrikam_lab'");
  });

  it('discards documents of another tenant even though the filter should have excluded them', async () => {
    const { fetch: fakeFetch } = recordingFetch(() =>
      json({
        value: [
          sampleDocument,
          {
            ...sampleDocument,
            id: 'case_other',
            tenantId: 'tenant_fabrikam_lab',
            title: 'FOREIGN',
          },
          { nonsense: true },
        ],
      }),
    );
    const client = createAzureSearchClient({
      endpoint: ENDPOINT,
      index: INDEX,
      credential: credential().credential,
      fetch: fakeFetch,
    });
    const outcome = await client.search(request);
    expect(outcome.hits.map((entry) => entry.id)).toEqual(['case_alpha']);
    expect(outcome).toMatchObject({ droppedForeignTenant: 1, droppedInvalid: 1 });
  });

  it('refuses an unsafe endpoint before any credential or network use', async () => {
    const { fetch: fakeFetch, calls } = recordingFetch(() => json({ value: [] }));
    const { credential: fakeCredential, getToken } = credential();
    const client = createAzureSearchClient({
      endpoint: 'https://evil.example.com',
      index: INDEX,
      credential: fakeCredential,
      fetch: fakeFetch,
    });
    expect((await failureOf(() => client.search(request))).failure).toBe('unsafe_endpoint');
    expect(getToken).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('refuses a tenant id that cannot be quoted safely before any network use', async () => {
    const { fetch: fakeFetch, calls } = recordingFetch(() => json({ value: [] }));
    const client = createAzureSearchClient({
      endpoint: ENDPOINT,
      index: INDEX,
      credential: credential().credential,
      fetch: fakeFetch,
    });
    expect(
      (await failureOf(() => client.search({ ...request, tenantId: "x' or 1 eq 1" }))).failure,
    ).toBe('invalid_tenant');
    expect(calls).toHaveLength(0);
  });

  it('fails with a typed, secret-free error when the token is missing or the service refuses', async () => {
    const withToken = (token: string | null, respond: () => Response) =>
      createAzureSearchClient({
        endpoint: ENDPOINT,
        index: INDEX,
        credential: credential(token).credential,
        fetch: recordingFetch(respond).fetch,
      });

    expect(
      (await failureOf(() => withToken(null, () => json({ value: [] })).search(request))).failure,
    ).toBe('auth');
    expect(
      (await failureOf(() => withToken('', () => json({ value: [] })).search(request))).failure,
    ).toBe('auth');

    for (const status of [401, 403, 429, 500, 503]) {
      const error = await failureOf(() =>
        withToken('fake-token-not-a-secret', () =>
          json({ error: 'sign-in outage secret detail' }, status),
        ).search(request),
      );
      expect(error.failure).toBe('http_error');
      expect(error.status).toBe(status);
      expect(error.message).not.toContain('fake-token-not-a-secret');
      expect(error.message).not.toContain('sign-in outage');
      expect(error.message).not.toContain('example-search');
    }
  });

  it('rejects bodies that are not the expected shape or are too large', async () => {
    const client = (respond: () => Response) =>
      createAzureSearchClient({
        endpoint: ENDPOINT,
        index: INDEX,
        credential: credential().credential,
        fetch: recordingFetch(respond).fetch,
      });
    const failures: [string, () => Response, SearchProviderFailure][] = [
      ['not JSON', () => new Response('<html>nope</html>', { status: 200 }), 'invalid_response'],
      ['wrong shape', () => json({ results: [] }), 'invalid_response'],
      [
        'declared too large',
        () => new Response('{}', { status: 200, headers: { 'content-length': '5000000' } }),
        'too_large',
      ],
      [
        'streamed too large',
        () => new Response(`{"value":[],"pad":"${'x'.repeat(1_100_000)}"}`, { status: 200 }),
        'too_large',
      ],
    ];
    for (const [label, respond, expected] of failures) {
      const error = await failureOf(() => client(respond).search(request));
      expect(error.failure, label).toBe(expected);
    }
  });

  it('gives up after the deadline, even when fetch or the credential ignore the abort signal', async () => {
    const hangingFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    const slowFetch = createAzureSearchClient({
      endpoint: ENDPOINT,
      index: INDEX,
      credential: credential().credential,
      fetch: hangingFetch,
      timeoutMs: 25,
    });
    expect((await failureOf(() => slowFetch.search(request))).failure).toBe('timeout');

    const stuckCredential: SearchCredential = { getToken: () => new Promise(() => undefined) };
    const slowToken = createAzureSearchClient({
      endpoint: ENDPOINT,
      index: INDEX,
      credential: stuckCredential,
      fetch: recordingFetch(() => json({ value: [] })).fetch,
      timeoutMs: 25,
    });
    expect((await failureOf(() => slowToken.search(request))).failure).toBe('timeout');
  });

  it('stops when the caller goes away', async () => {
    const hangingFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    const client = createAzureSearchClient({
      endpoint: ENDPOINT,
      index: INDEX,
      credential: credential().credential,
      fetch: hangingFetch,
    });
    const controller = new AbortController();
    const pending = failureOf(() => client.search({ ...request, signal: controller.signal }));
    controller.abort();
    expect((await pending).failure).toBe('aborted');
  });

  it('reports a network failure as a typed error without the underlying message', async () => {
    const client = createAzureSearchClient({
      endpoint: ENDPOINT,
      index: INDEX,
      credential: credential().credential,
      fetch: async () => {
        throw new TypeError('connect ECONNREFUSED 10.1.2.3:443 Bearer fake-token-not-a-secret');
      },
    });
    const error = await failureOf(() => client.search(request));
    expect(error.failure).toBe('network');
    expect(error.message).not.toContain('10.1.2.3');
    expect(error.message).not.toContain('fake-token-not-a-secret');
  });
});

function fakeContext(overrides: {
  readonly search?: SearchConfig;
  readonly lexical?: () => Promise<SearchHit[]>;
  readonly aborted?: boolean;
}) {
  const recordRetrieval = vi.fn();
  const query = vi.fn(
    overrides.lexical ?? (async () => [hit({ id: 'case_lex', caseId: 'case_lex' })]),
  );
  const warn = vi.fn();
  const error = vi.fn();
  const controller = new AbortController();
  if (overrides.aborted === true) controller.abort();
  const ctx = {
    repos: { search: { query } },
    auth: { tenantId: CONTOSO },
    metrics: { recordRetrieval },
    logger: { warn, error },
    signal: controller.signal,
    config: { search: overrides.search ?? ({ provider: 'lexical' } as const) },
  } as unknown as SearchContext;
  return { ctx, query, recordRetrieval, warn, error };
}

const AZURE_CONFIG: SearchConfig = {
  provider: 'azure-ai-search',
  endpoint: ENDPOINT,
  index: INDEX,
};

function clockFrom(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

const outcomeOf = (hits: SearchHit[]): AzureSearchOutcome => ({
  hits,
  droppedInvalid: 0,
  droppedForeignTenant: 0,
});

describe('[FR-UX-04] search service (fake context)', () => {
  it('uses the lexical repository by default, applies the limit and records retrieval latency', async () => {
    const { ctx, query, recordRetrieval } = fakeContext({
      lexical: async () => [
        hit({ id: 'a', caseId: 'a' }),
        hit({ id: 'b', caseId: 'b' }),
        hit({ id: 'c', caseId: 'c' }),
      ],
    });
    const service = createSearchService({ monotonicMs: clockFrom(100, 112) });
    const results = await service.search(ctx, { text: '  sign-in   outage ', limit: 2 });
    expect(query).toHaveBeenCalledWith({ text: 'sign-in outage', limit: 2 });
    expect(results.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(results[0]?.href).toBe('/cases/a');
    expect(recordRetrieval).toHaveBeenCalledWith('lexical', 'ok', 12);
    expect(recordRetrieval).toHaveBeenCalledTimes(1);
  });

  it('rejects a query that is too short before touching any provider', async () => {
    const { ctx, query, recordRetrieval } = fakeContext({ search: AZURE_CONFIG });
    const create = vi.fn();
    const service = createSearchService({ createAzureClient: create });
    await expect(service.search(ctx, { text: '  a ', limit: 5 })).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
    expect(query).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(recordRetrieval).not.toHaveBeenCalled();
  });

  it('prefers Azure AI Search when configured and passes the caller tenant and signal', async () => {
    const { ctx, query, recordRetrieval } = fakeContext({ search: AZURE_CONFIG });
    const search = vi.fn(async () =>
      outcomeOf([hit({ type: 'skill', id: 'skill_1', caseId: null })]),
    );
    const create = vi.fn((): AzureSearchClient => ({ search }));
    const service = createSearchService({
      createAzureClient: create,
      monotonicMs: clockFrom(0, 7),
    });
    const results = await service.search(ctx, { text: 'proxy', limit: 3 });
    expect(results.map((entry) => entry.href)).toEqual(['/skills/skill_1']);
    expect(query).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith({ endpoint: ENDPOINT, index: INDEX });
    expect(search).toHaveBeenCalledWith({
      tenantId: CONTOSO,
      text: 'proxy',
      limit: 3,
      signal: ctx.signal,
    });
    expect(recordRetrieval).toHaveBeenCalledWith('azure-ai-search', 'ok', 7);
  });

  it('builds the Azure client once per configuration and reuses it', async () => {
    const first = fakeContext({ search: AZURE_CONFIG });
    const search = vi.fn(async () => outcomeOf([]));
    const create = vi.fn((): AzureSearchClient => ({ search }));
    const service = createSearchService({ createAzureClient: create });
    await service.search(first.ctx, { text: 'proxy', limit: 3 });
    await service.search(first.ctx, { text: 'proxy again', limit: 3 });
    expect(create).toHaveBeenCalledTimes(1);
    const moved = fakeContext({ search: { ...AZURE_CONFIG, index: 'other-index' } });
    await service.search(moved.ctx, { text: 'proxy', limit: 3 });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it.each<SearchProviderFailure>(['timeout', 'http_error', 'auth', 'network', 'unsafe_endpoint'])(
    'falls back to lexical search when Azure fails (%s), visible only as a fallback metric',
    async (failure) => {
      const { ctx, query, recordRetrieval, warn } = fakeContext({ search: AZURE_CONFIG });
      const create = (): AzureSearchClient => ({
        search: async () => {
          throw new SearchProviderError(failure);
        },
      });
      const service = createSearchService({
        createAzureClient: create,
        monotonicMs: clockFrom(10, 14, 20, 21),
      });
      const results = await service.search(ctx, { text: 'secret-customer-phrase', limit: 4 });

      expect(query).toHaveBeenCalledWith({ text: 'secret-customer-phrase', limit: 4 });
      expect(results.map((entry) => entry.id)).toEqual(['case_lex']);
      expect(Object.keys(results[0] ?? {}).sort()).toEqual(
        ['caseId', 'href', 'id', 'score', 'snippet', 'title', 'type'].sort(),
      );
      expect(recordRetrieval).toHaveBeenNthCalledWith(1, 'azure-ai-search', 'fallback', 4);
      expect(recordRetrieval).toHaveBeenNthCalledWith(2, 'lexical', 'ok', 1);
      expect(recordRetrieval).not.toHaveBeenCalledWith('azure-ai-search', 'ok', expect.anything());
      expect(warn).toHaveBeenCalledWith({ failure }, expect.any(String));
      expect(JSON.stringify([warn.mock.calls])).not.toContain('secret-customer-phrase');
    },
  );

  it('treats an unexpected error from the client as a failure too, without logging its text', async () => {
    const { ctx, recordRetrieval, warn } = fakeContext({ search: AZURE_CONFIG });
    const create = (): AzureSearchClient => ({
      search: async () => {
        throw new Error('boom with Bearer fake-token-not-a-secret');
      },
    });
    const results = await createSearchService({ createAzureClient: create }).search(ctx, {
      text: 'proxy',
      limit: 2,
    });
    expect(results).toHaveLength(1);
    expect(recordRetrieval).toHaveBeenCalledWith('azure-ai-search', 'fallback', expect.any(Number));
    expect(warn).toHaveBeenCalledWith({ failure: 'unexpected' }, expect.any(String));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('fake-token-not-a-secret');
  });

  it('does not fall back for a caller that has already gone away', async () => {
    const { ctx, query, recordRetrieval } = fakeContext({ search: AZURE_CONFIG, aborted: true });
    const create = (): AzureSearchClient => ({
      search: async () => {
        throw new SearchProviderError('aborted');
      },
    });
    await expect(
      createSearchService({ createAzureClient: create }).search(ctx, { text: 'proxy', limit: 2 }),
    ).rejects.toBeInstanceOf(SearchProviderError);
    expect(query).not.toHaveBeenCalled();
    expect(recordRetrieval).not.toHaveBeenCalled();
  });

  it('logs foreign-tenant and malformed documents by count and keeps only the clean hits', async () => {
    const { ctx, error, warn } = fakeContext({ search: AZURE_CONFIG });
    const create = (): AzureSearchClient => ({
      search: async () => ({ hits: [hit()], droppedInvalid: 2, droppedForeignTenant: 3 }),
    });
    const results = await createSearchService({ createAzureClient: create }).search(ctx, {
      text: 'proxy',
      limit: 5,
    });
    expect(results).toHaveLength(1);
    expect(error).toHaveBeenCalledWith({ discarded: 3 }, expect.stringContaining('another tenant'));
    expect(warn).toHaveBeenCalledWith({ discarded: 2 }, expect.stringContaining('malformed'));
  });

  it('records a lexical failure and rethrows it', async () => {
    const { ctx, recordRetrieval } = fakeContext({
      lexical: async () => {
        throw new Error('database unavailable');
      },
    });
    await expect(createSearchService().search(ctx, { text: 'proxy', limit: 2 })).rejects.toThrow(
      'database unavailable',
    );
    expect(recordRetrieval).toHaveBeenCalledWith('lexical', 'error', expect.any(Number));
  });
});
