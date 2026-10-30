import { SearchResultSchema, type SearchResult } from '@caseguard/schemas';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database, SearchHit } from '../src/db';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS, resetTestDatabase } from '../src/db/testing';
import type { Infrastructure } from '../src/infrastructure';
import { searchRoutes } from '../src/routes/search';
import {
  createAzureSearchClient,
  mapDocuments,
  type AzureSearchClient,
  type SearchCredential,
} from '../src/services/search';
import { buildIngestInput } from './builders';
import {
  CONTOSO,
  FABRIKAM,
  PERSONAS,
  createHarness,
  openSharedDatabase,
  type Harness,
} from './support/app-harness';

/*
 * search.global with documents of an external index that cannot be shown. A fake Azure AI Search
 * (`fetch` and credential) feeds the real adapter, service, route and response serializer; the index is
 * implemented and validated against mocks only.
 */

const API = '/api/v1';
const ENV = {
  SEARCH_PROVIDER: 'azure-ai-search',
  AZURE_SEARCH_ENDPOINT: 'https://example-search.search.windows.net',
  AZURE_SEARCH_INDEX: 'caseguard-test',
};

let database: Database;
const harnesses: Harness[] = [];

async function harness(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  const created = await createHarness({ database, env: ENV, ...options });
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

beforeEach(async () => {
  await resetTestDatabase(database);
});

const search = (h: Harness, query: string, persona: string = PERSONAS.engineer) =>
  h.call(persona, { method: 'GET', url: `${API}/search?${query}` });

const itemsOf = (data: { items: SearchResult[] }): SearchResult[] =>
  data.items.map((item) => SearchResultSchema.parse(item));

/** The index answers with these documents whatever the query and `top` say. */
function azureHarness(documents: unknown[]): Promise<Harness> {
  const credential: SearchCredential = {
    getToken: async () => ({ token: 'fake-token-not-a-secret' }),
  };
  const fetchFake: typeof fetch = async () =>
    new Response(JSON.stringify({ value: documents }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const routes = searchRoutes({} as Infrastructure, {
    createAzureClient: (settings) =>
      createAzureSearchClient({ ...settings, credential, fetch: fetchFake }),
  });
  return harness({ handlers: routes });
}

/** A client of the search service that is not the real adapter (the route factory ignores `infra`). */
const clientHarness = (client: AzureSearchClient): Promise<Harness> =>
  harness({ handlers: searchRoutes({} as Infrastructure, { createAzureClient: () => client }) });

const doc = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  '@search.score': 4,
  tenantId: CONTOSO,
  title: 'Resolver timeout',
  snippet: 'The resolver timed out.',
  ...overrides,
});

const USABLE = [
  doc({ id: 'case_ext', type: 'case', title: 'Sign-in outage' }),
  doc({
    id: 'idx:evt_9',
    entityId: 'evt_9',
    type: 'event',
    caseId: 'case_ext',
    title: 'Resolver check',
  }),
  doc({ id: 'skill_ext', type: 'skill', caseId: null, title: 'Proxy diagnosis' }),
  doc({
    id: 'hyp_ext',
    type: 'hypothesis',
    caseId: 'case_ext',
    title: '<b>DNS</b> misconfiguration',
    snippet: '<p>See <a href="javascript:evil()">the resolver</a>.</p><script>alert(1)</script>',
  }),
];

const UNUSABLE = [
  // The review probe: a case id that is not an id.
  doc({ id: 'clm_space', type: 'claim', caseId: 'case 0001', title: 'DROP-SPACE' }),
  doc({ id: '', type: 'case', title: 'DROP-EMPTY' }),
  doc({ id: 'x'.repeat(121), type: 'case', title: 'DROP-LONG' }),
  doc({ id: 'evt_nocase', type: 'event', title: 'DROP-NOCASE' }),
  doc({ id: 'evt_html', type: 'event', caseId: 'case_ext', title: '<script>alert(1)</script>' }),
  { id: 'case_notitle', tenantId: CONTOSO, type: 'case', '@search.score': 1 },
  { tenantId: CONTOSO, type: 'case', title: 'DROP-NOID', '@search.score': 1 },
  doc({ id: 'odd_type', type: 'folder', title: 'DROP-TYPE' }),
  'not an object',
  null,
];

const FOREIGN = doc({
  id: 'case_foreign',
  tenantId: FABRIKAM,
  type: 'case',
  title: 'FOREIGN-TITLE',
});

/** Usable and unusable documents interleaved, with one of another tenant among them. */
const MIXED = [
  UNUSABLE[0],
  USABLE[0],
  UNUSABLE[1],
  USABLE[1],
  UNUSABLE[2],
  FOREIGN,
  UNUSABLE[3],
  USABLE[2],
  UNUSABLE[4],
  UNUSABLE[5],
  USABLE[3],
  UNUSABLE[6],
  UNUSABLE[7],
  UNUSABLE[8],
  UNUSABLE[9],
];

const DROPPED_MARKERS = ['DROP-', 'FOREIGN-TITLE', 'case 0001', 'clm_space', 'evt_nocase'];

describe('[FR-UX-04] search.global with documents of the index that cannot be shown', () => {
  it('answers 200 with only the usable documents, through the real response serializer', async () => {
    const h = await azureHarness(MIXED);
    const res = await search(h, 'q=proxy&limit=25');
    expect(res.statusCode).toBe(200);
    const items = itemsOf(res.data);
    expect(items.map((item) => [item.type, item.id, item.caseId, item.href])).toEqual([
      ['case', 'case_ext', 'case_ext', '/cases/case_ext'],
      ['event', 'evt_9', 'case_ext', '/cases/case_ext/timeline?sel=evt_9'],
      ['skill', 'skill_ext', null, '/skills/skill_ext'],
      ['hypothesis', 'hyp_ext', 'case_ext', '/cases/case_ext/hypotheses?sel=hyp_ext'],
    ]);
    // Markup is shown as plain text.
    expect(items[3]).toMatchObject({ title: 'DNS misconfiguration', snippet: 'See the resolver.' });
    const body = JSON.stringify(res.data);
    for (const marker of [...DROPPED_MARKERS, '<', 'javascript:']) {
      expect(body, marker).not.toContain(marker);
    }
  });

  it('counts what it dropped in a warning log and in the error metric, never by content', async () => {
    const h = await azureHarness(MIXED);
    await search(h, 'q=proxy');
    const errors = h.infra.metrics.errors;
    expect(errors.get({ component: 'search', code: 'invalid_document' })).toBe(10);
    expect(errors.get({ component: 'search', code: 'foreign_tenant_document' })).toBe(1);
    expect(errors.get({ component: 'search', code: 'invalid_result' })).toBe(0);

    const logs = h.logs();
    expect(logs.find((line) => String(line.msg).includes('malformed documents'))).toMatchObject({
      level: 'warn',
      discarded: 10,
    });
    expect(logs.find((line) => String(line.msg).includes('another tenant'))).toMatchObject({
      level: 'error',
      discarded: 1,
    });
    const text = JSON.stringify(logs);
    for (const marker of DROPPED_MARKERS) expect(text, marker).not.toContain(marker);
    expect(text).not.toContain('proxy');

    const retrieval = h.infra.metrics.retrievalDuration;
    expect(retrieval.get({ provider: 'azure-ai-search', outcome: 'ok' }).count).toBe(1);
    expect(retrieval.get({ provider: 'azure-ai-search', outcome: 'fallback' }).count).toBe(0);
  });

  it('applies the limit to the usable documents, in index order', async () => {
    const h = await azureHarness(MIXED);
    const two = await search(h, 'q=proxy&limit=2');
    expect(two.statusCode).toBe(200);
    expect(itemsOf(two.data).map((item) => item.id)).toEqual(['case_ext', 'evt_9']);
    const one = await search(h, 'q=proxy&limit=1');
    expect(itemsOf(one.data).map((item) => item.id)).toEqual(['case_ext']);
  });

  it('survives a case id that is not an id (the review probe) from a client of its own', async () => {
    const documents = [
      doc({ id: 'clm_1', type: 'claim', caseId: 'case 0001' }),
      doc({ id: 'case_ok', type: 'case', title: 'Fine' }),
    ];
    const h = await clientHarness({
      search: async (request) => mapDocuments(documents, request.tenantId),
    });
    const res = await search(h, 'q=dns');
    expect(res.statusCode).toBe(200);
    expect(itemsOf(res.data).map((item) => item.id)).toEqual(['case_ok']);
  });

  it('drops hits that break the result contract even when the client skipped its own checks', async () => {
    const broken = {
      type: 'claim',
      id: 'clm_1',
      caseId: 'case 0001',
      title: 'DROP-CONTRACT',
      snippet: '',
      score: 0.5,
    };
    const fine = {
      type: 'case',
      id: 'case_ok',
      caseId: 'case_ok',
      title: 'Fine',
      snippet: '',
      score: 0.5,
    };
    const hits = [broken, fine, { ...broken, id: '' }] as SearchHit[];
    const h = await clientHarness({
      search: async () => ({ hits, droppedInvalid: 0, droppedForeignTenant: 0 }),
    });
    const res = await search(h, 'q=dns');
    expect(res.statusCode).toBe(200);
    expect(itemsOf(res.data).map((item) => item.id)).toEqual(['case_ok']);
    expect(h.infra.metrics.errors.get({ component: 'search', code: 'invalid_result' })).toBe(2);
    expect(JSON.stringify(h.logs())).not.toContain('DROP-CONTRACT');
  });

  it('uses the lexical results when every document of the index is unusable', async () => {
    const h = await azureHarness(UNUSABLE);
    await h.repos(CONTOSO).cases.ingest(
      buildIngestInput({
        caseId: 'case_alpha',
        receivedSeed: 'a',
        title: 'Zephyrquartz sign-in outage',
      }),
    );
    const res = await search(h, 'q=zephyrquartz');
    expect(res.statusCode).toBe(200);
    expect(itemsOf(res.data).some((item) => item.id === 'case_alpha')).toBe(true);
    const retrieval = h.infra.metrics.retrievalDuration;
    expect(retrieval.get({ provider: 'azure-ai-search', outcome: 'fallback' }).count).toBe(1);
    expect(retrieval.get({ provider: 'azure-ai-search', outcome: 'ok' }).count).toBe(0);
    expect(retrieval.get({ provider: 'lexical', outcome: 'ok' }).count).toBe(1);
    expect(h.logs().find((line) => String(line.msg).includes('no usable documents'))).toMatchObject(
      { failure: 'no_usable_documents' },
    );
  });

  it('answers an empty list, without falling back, when the index has nothing for the query', async () => {
    const h = await azureHarness([]);
    const res = await search(h, 'q=zephyrquartz');
    expect(res.statusCode).toBe(200);
    expect(res.data).toEqual({ items: [] });
    const retrieval = h.infra.metrics.retrievalDuration;
    expect(retrieval.get({ provider: 'azure-ai-search', outcome: 'ok' }).count).toBe(1);
    expect(retrieval.get({ provider: 'azure-ai-search', outcome: 'fallback' }).count).toBe(0);
    expect(retrieval.get({ provider: 'lexical', outcome: 'ok' }).count).toBe(0);
  });

  it('bounds long text so that it always fits the response contract', async () => {
    const h = await azureHarness([
      doc({
        id: 'case_long',
        type: 'case',
        title: '😀'.repeat(1500),
        snippet: '😀'.repeat(15_000),
      }),
    ]);
    const res = await search(h, 'q=emoji');
    expect(res.statusCode).toBe(200);
    const [item] = itemsOf(res.data);
    expect(Array.from(item?.title ?? '')).toHaveLength(300);
    expect(Array.from(item?.snippet ?? '')).toHaveLength(300);
  });
});
