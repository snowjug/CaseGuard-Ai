import { SearchResultSchema } from '@caseguard/schemas';
import { describe, expect, it } from 'vitest';
import { ValidationFailedError } from '../src/errors';
import {
  AZURE_SEARCH_API_VERSION,
  AZURE_SEARCH_SCOPE,
  AZURE_SEARCH_TIMEOUT_MS,
  SearchProviderError,
  buildSearchUrl,
  hrefFor,
  mapDocuments,
  normalizeQuery,
  tenantFilter,
  toSearchResult,
} from '../src/services/search';
import { CONTOSO, ENDPOINT, INDEX, hit } from './search-support';

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
    const result = toSearchResult(
      hit({
        title: 'Token Bearer abcdefghijklmnopqrstuvwxyz0123456789 leaked',
        snippet: 'x'.repeat(500),
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
