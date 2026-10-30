import type { SearchConfig } from '@caseguard/config';
import { describe, expect, it, vi } from 'vitest';
import type { SearchHit } from '../src/db';
import { ValidationFailedError } from '../src/errors';
import {
  SearchProviderError,
  createSearchService,
  type AzureSearchClient,
  type AzureSearchOutcome,
  type SearchContext,
  type SearchProviderFailure,
} from '../src/services/search';
import { CONTOSO, ENDPOINT, INDEX, hit } from './search-support';

function fakeContext(overrides: {
  readonly search?: SearchConfig;
  readonly lexical?: () => Promise<SearchHit[]>;
  readonly aborted?: boolean;
}) {
  const recordRetrieval = vi.fn();
  const recordError = vi.fn();
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
    metrics: { recordRetrieval, recordError },
    logger: { warn, error },
    signal: controller.signal,
    config: { search: overrides.search ?? ({ provider: 'lexical' } as const) },
  } as unknown as SearchContext;
  return { ctx, query, recordRetrieval, recordError, warn, error };
}

const AZURE_CONFIG: SearchConfig = {
  provider: 'azure-ai-search',
  endpoint: ENDPOINT,
  index: INDEX,
};

/** A monotonic clock that returns the given readings in order (the last one repeats). */
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

  it('answers nothing, and does not fall back, for a caller that has already gone away', async () => {
    const { ctx, query, recordRetrieval, warn } = fakeContext({
      search: AZURE_CONFIG,
      aborted: true,
    });
    const create = (): AzureSearchClient => ({
      search: async () => {
        throw new SearchProviderError('aborted');
      },
    });
    const results = await createSearchService({ createAzureClient: create }).search(ctx, {
      text: 'proxy',
      limit: 2,
    });
    expect(results).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    expect(recordRetrieval).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs foreign-tenant and malformed documents by count and keeps only the clean hits', async () => {
    const { ctx, error, warn, recordError } = fakeContext({ search: AZURE_CONFIG });
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
    const codes = recordError.mock.calls.map(([component, code]) => `${component}:${code}`);
    expect(codes.filter((code) => code === 'search:foreign_tenant_document')).toHaveLength(3);
    expect(codes.filter((code) => code === 'search:invalid_document')).toHaveLength(2);
    expect(codes).toHaveLength(5);
  });

  it('drops hits that break the result contract, by count only, and still answers', async () => {
    const { ctx, warn, recordError } = fakeContext({ search: AZURE_CONFIG });
    // A client that skips the adapter's own checks: whatever it returns is checked again.
    const create = (): AzureSearchClient => ({
      search: async () =>
        outcomeOf([
          hit({ id: 'clm_1', type: 'claim', caseId: 'case 0001', title: 'SECRET-TITLE-ONE' }),
          hit({ id: 'case_ok', caseId: 'case_ok', title: 'Fine' }),
          hit({ id: '', caseId: '', title: 'SECRET-TITLE-TWO' }),
          hit({ id: 'x'.repeat(121), caseId: 'x'.repeat(121) }),
          {
            ...hit({ id: 'case_two', caseId: 'case_two' }),
            title: undefined,
          } as unknown as SearchHit,
        ]),
    });
    const results = await createSearchService({ createAzureClient: create }).search(ctx, {
      text: 'proxy',
      limit: 10,
    });
    expect(results.map((entry) => entry.id)).toEqual(['case_ok']);
    expect(warn).toHaveBeenCalledWith(
      { provider: 'azure-ai-search', discarded: 4 },
      expect.stringContaining('result contract'),
    );
    expect(recordError.mock.calls).toEqual(Array(4).fill(['search', 'invalid_result']));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET-TITLE');
  });

  it('applies the limit to the hits that are left after the unusable ones are gone', async () => {
    const { ctx } = fakeContext({ search: AZURE_CONFIG });
    const create = (): AzureSearchClient => ({
      search: async () =>
        outcomeOf([
          hit({ id: 'bad id', caseId: 'bad id' }),
          hit({ id: 'a', caseId: 'a' }),
          hit({ id: 'b', caseId: 'b' }),
          hit({ id: 'c', caseId: 'c' }),
          hit({ id: 'd', caseId: 'd' }),
        ]),
    });
    const service = createSearchService({ createAzureClient: create });
    const results = await service.search(ctx, { text: 'proxy', limit: 3 });
    expect(results.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
  });

  it('falls back to lexical search when the index answered with documents but none can be used', async () => {
    const { ctx, query, recordRetrieval, warn } = fakeContext({ search: AZURE_CONFIG });
    const create = (): AzureSearchClient => ({
      search: async () => ({ hits: [], droppedInvalid: 2, droppedForeignTenant: 1 }),
    });
    const service = createSearchService({
      createAzureClient: create,
      monotonicMs: clockFrom(10, 14, 20, 21),
    });
    const results = await service.search(ctx, { text: 'proxy', limit: 4 });
    expect(results.map((entry) => entry.id)).toEqual(['case_lex']);
    expect(query).toHaveBeenCalledWith({ text: 'proxy', limit: 4 });
    expect(recordRetrieval).toHaveBeenNthCalledWith(1, 'azure-ai-search', 'fallback', 4);
    expect(recordRetrieval).toHaveBeenNthCalledWith(2, 'lexical', 'ok', 1);
    expect(recordRetrieval).not.toHaveBeenCalledWith('azure-ai-search', 'ok', expect.anything());
    expect(warn).toHaveBeenCalledWith({ failure: 'no_usable_documents' }, expect.any(String));
  });

  it('does not fall back when the index simply has nothing for the query', async () => {
    const { ctx, query, recordRetrieval } = fakeContext({ search: AZURE_CONFIG });
    const create = (): AzureSearchClient => ({ search: async () => outcomeOf([]) });
    const results = await createSearchService({ createAzureClient: create }).search(ctx, {
      text: 'proxy',
      limit: 4,
    });
    expect(results).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    expect(recordRetrieval).toHaveBeenCalledWith('azure-ai-search', 'ok', expect.any(Number));
  });

  it('checks lexical hits against the contract too, and says which provider they came from', async () => {
    const { ctx, warn, recordError } = fakeContext({
      lexical: async () => [
        hit({ id: 'bad id', caseId: 'bad id' }),
        hit({ id: 'case_good', caseId: 'case_good' }),
      ],
    });
    const results = await createSearchService().search(ctx, { text: 'proxy', limit: 5 });
    expect(results.map((entry) => entry.id)).toEqual(['case_good']);
    expect(warn).toHaveBeenCalledWith(
      { provider: 'lexical', discarded: 1 },
      expect.stringContaining('result contract'),
    );
    expect(recordError).toHaveBeenCalledWith('search', 'invalid_result');
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
