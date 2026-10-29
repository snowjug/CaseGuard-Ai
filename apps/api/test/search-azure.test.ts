import { describe, expect, it, vi } from 'vitest';
import {
  SearchProviderError,
  createAzureSearchClient,
  type SearchCredential,
  type SearchProviderFailure,
} from '../src/services/search';
import { CONTOSO, ENDPOINT, INDEX } from './search-support';

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

/** A fetch that never answers but honours the abort signal, like the real one. */
const hangingFetch: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });

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
    const error = await failureOf(() => client.search({ ...request, tenantId: "x' or 1 eq 1" }));
    expect(error.failure).toBe('invalid_tenant');
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

    const noToken = await failureOf(() =>
      withToken(null, () => json({ value: [] })).search(request),
    );
    expect(noToken.failure).toBe('auth');
    const emptyToken = await failureOf(() =>
      withToken('', () => json({ value: [] })).search(request),
    );
    expect(emptyToken.failure).toBe('auth');

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
