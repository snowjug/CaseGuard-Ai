import { SearchResultSchema, type SearchResult } from '@caseguard/schemas';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/db';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS, resetTestDatabase } from '../src/db/testing';
import type { Infrastructure } from '../src/infrastructure';
import { searchRoutes } from '../src/routes/search';
import { createAzureSearchClient, type SearchCredential } from '../src/services/search';
import { buildIngestInput, buildSkill, buildSkillVersion } from './builders';
import {
  CONTOSO,
  FABRIKAM,
  PERSONAS,
  createHarness,
  openSharedDatabase,
  type Harness,
} from './support/app-harness';

const API = '/api/v1';
const SECRET = 'Bearer abcdefghijklmnopqrstuvwxyz0123456789';
const ALL_CONTOSO_ROLES = [
  PERSONAS.engineer,
  PERSONAS.reviewer,
  PERSONAS.manager,
  PERSONAS.curator,
  PERSONAS.admin,
];

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

beforeEach(async () => {
  await resetTestDatabase(database);
});

/** Contoso: a case, one of its events and a skill that all mention "zephyrquartz"; Fabrikam has its own case. */
async function seed(h: Harness): Promise<void> {
  const contoso = h.repos(CONTOSO);
  const input = buildIngestInput({
    caseId: 'case_alpha',
    receivedSeed: 'a',
    title: 'Zephyrquartz sign-in outage',
  });
  const events = input.events.map((event, index) =>
    index === 2
      ? {
          ...event,
          title: 'Resolver check',
          body: `The zephyrquartz resolver timed out ${SECRET} for all users.`,
        }
      : event,
  );
  await contoso.cases.ingest({ ...input, events });
  await contoso.skills.create({
    skill: buildSkill({
      id: 'skill_zq',
      key: 'zephyrquartz-diagnosis',
      name: 'Zephyrquartz diagnosis',
      currentVersionId: 'skillv_zq_1',
    }),
    version: buildSkillVersion({ id: 'skillv_zq_1', skillId: 'skill_zq' }),
  });
  await h.repos(FABRIKAM).cases.ingest(
    buildIngestInput({
      tenantId: FABRIKAM,
      caseId: 'case_fab',
      receivedSeed: 'f',
      title: 'Zephyrquartz FABRIKAM-ONLY outage',
    }),
  );
}

async function search(h: Harness, query: string, persona: string | null = PERSONAS.engineer) {
  return h.call(persona, { method: 'GET', url: `${API}/search?${query}` });
}

const itemsOf = (data: { items: SearchResult[] }): SearchResult[] =>
  data.items.map((item) => SearchResultSchema.parse(item));

describe('[FR-UX-04] search.global (lexical)', () => {
  it('returns schema-valid, ranked, tenant-scoped results with links to the real web routes', async () => {
    const h = await harness();
    await seed(h);
    const res = await search(h, 'q=zephyrquartz');
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.data)).toEqual(['items']);
    const items = itemsOf(res.data);

    const byType = new Map(items.map((item) => [item.type, item]));
    expect(byType.get('case')).toMatchObject({
      id: 'case_alpha',
      caseId: 'case_alpha',
      href: '/cases/case_alpha',
    });
    expect(byType.get('event')).toMatchObject({
      id: 'evt_03',
      caseId: 'case_alpha',
      href: '/cases/case_alpha/timeline?sel=evt_03',
    });
    expect(byType.get('skill')).toMatchObject({
      id: 'skill_zq',
      caseId: null,
      href: '/skills/skill_zq',
    });
    expect(items.map((item) => item.score)).toEqual(
      [...items.map((item) => item.score)].sort((a, b) => b - a),
    );
    for (const item of items) {
      expect(item.snippet.length).toBeLessThanOrEqual(300);
      expect(item.title).not.toContain('FABRIKAM');
    }
  });

  it('applies the limit and keeps the best match first', async () => {
    const h = await harness();
    await seed(h);
    const one = await search(h, 'q=zephyrquartz&limit=1');
    expect(itemsOf(one.data)).toHaveLength(1);
    const all = await search(h, 'q=zephyrquartz&limit=25');
    expect(itemsOf(all.data)[0]?.id).toBe(itemsOf(one.data)[0]?.id);
    expect(itemsOf(all.data).length).toBeGreaterThan(1);
    const none = await search(h, 'q=nonexistentterm');
    expect(none.data).toEqual({ items: [] });
  });

  it('[NFR-SEC-05] never returns a credential that is still in stored text', async () => {
    const h = await harness();
    await seed(h);
    const res = await search(h, 'q=zephyrquartz');
    expect(JSON.stringify(res.data)).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    const event = itemsOf(res.data).find((item) => item.type === 'event');
    expect(event?.snippet).toContain('zephyrquartz');
  });

  it('is available to every role that can read cases and refused without a credential', async () => {
    const h = await harness();
    await seed(h);
    for (const persona of ALL_CONTOSO_ROLES) {
      expect((await search(h, 'q=zephyrquartz', persona)).statusCode).toBe(200);
    }
    const anonymous = await search(h, 'q=zephyrquartz', null);
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.data.code).toBe('unauthenticated');
  });

  it('rejects empty, too short and out-of-range requests with 422', async () => {
    const h = await harness();
    for (const query of [
      'q=a',
      '',
      'limit=5',
      'q=%20%20%20',
      'q=zephyrquartz&limit=0',
      'q=zephyrquartz&limit=26',
      'q=zephyrquartz&limit=abc',
      `q=${'x'.repeat(201)}`,
    ]) {
      const res = await search(h, query);
      expect(res.statusCode, query).toBe(422);
      expect(res.data.code).toBe('validation_failed');
    }
    const blank = await search(h, 'q=%20%20%20');
    expect(blank.data.errors[0].path).toBe('query.q');
  });

  it('[NFR-SEC-01] never shows one tenant the other’s cases, in either direction', async () => {
    const h = await harness();
    await seed(h);
    const mine = await search(h, 'q=zephyrquartz');
    expect(JSON.stringify(mine.data)).not.toContain('FABRIKAM-ONLY');
    expect(itemsOf(mine.data).some((item) => item.id === 'case_fab')).toBe(false);

    const theirs = await search(h, 'q=zephyrquartz', PERSONAS.otherTenantEngineer);
    expect(theirs.statusCode).toBe(200);
    const items = itemsOf(theirs.data);
    expect(items.map((item) => [item.type, item.id])).toEqual([['case', 'case_fab']]);
    expect(JSON.stringify(theirs.data)).not.toContain('case_alpha');
    expect(JSON.stringify(theirs.data)).not.toContain('skill_zq');
  });

  it('records retrieval latency by provider and never logs or audits the query', async () => {
    const h = await harness();
    await seed(h);
    await search(h, 'q=zephyrquartz');
    expect(
      h.infra.metrics.retrievalDuration.get({ provider: 'lexical', outcome: 'ok' }).count,
    ).toBe(1);
    expect(JSON.stringify(h.logs())).not.toContain('zephyrquartz');
    const audit = await h.repos(CONTOSO).audit.list({ limit: 50 });
    expect(JSON.stringify(audit.items)).not.toContain('zephyrquartz');
  });
});

/** A fake Azure AI Search service: records requests and answers from a script. */
const urlOf = (input: string | URL | Request): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

function fakeAzure(respond: (body: Record<string, unknown>) => Response) {
  const requests: { url: string; body: Record<string, unknown>; authorization: string }[] = [];
  const credential: SearchCredential = {
    getToken: async () => ({ token: 'fake-token-not-a-secret' }),
  };
  const fetchFake: typeof fetch = async (input, init = {}) => {
    const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<
      string,
      unknown
    >;
    const headers = init.headers as Record<string, string>;
    requests.push({ url: urlOf(input), body, authorization: headers.authorization ?? '' });
    return respond(body);
  };
  return { requests, credential, fetch: fetchFake };
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const AZURE_SEARCH_ENV = {
  SEARCH_PROVIDER: 'azure-ai-search',
  AZURE_SEARCH_ENDPOINT: 'https://example-search.search.windows.net',
  AZURE_SEARCH_INDEX: 'caseguard-test',
};

function azureHarness(
  fake: ReturnType<typeof fakeAzure>,
  env: Record<string, string> = AZURE_SEARCH_ENV,
) {
  // The route factory does not use the infrastructure; the harness supplies the real context per request.
  const routes = searchRoutes({} as Infrastructure, {
    createAzureClient: (settings) =>
      createAzureSearchClient({ ...settings, credential: fake.credential, fetch: fake.fetch }),
  });
  return harness({ env, handlers: routes });
}

describe('[FR-UX-04] search.global (Azure AI Search, implemented and validated against mocks only)', () => {
  const doc = (tenantId: string, id: string, title: string) => ({
    '@search.score': 4,
    id,
    tenantId,
    type: 'case',
    title,
    snippet: `Snippet of ${title}`,
  });

  it('answers from the external index with the caller’s tenant filter and a bearer token', async () => {
    const fake = fakeAzure(() =>
      jsonResponse({ value: [doc(CONTOSO, 'case_ext', 'External hit')] }),
    );
    const h = await azureHarness(fake);
    const res = await search(h, 'q=proxy&limit=3');
    expect(res.statusCode).toBe(200);
    expect(itemsOf(res.data)).toEqual([
      {
        type: 'case',
        id: 'case_ext',
        caseId: 'case_ext',
        title: 'External hit',
        snippet: 'Snippet of External hit',
        href: '/cases/case_ext',
        score: 0.8,
      },
    ]);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({
      url: 'https://example-search.search.windows.net/indexes/caseguard-test/docs/search?api-version=2024-07-01',
      authorization: 'Bearer fake-token-not-a-secret',
      body: { search: 'proxy', top: 3, filter: `tenantId eq '${CONTOSO}'` },
    });
    const retrieval = h.infra.metrics.retrievalDuration;
    expect(retrieval.get({ provider: 'azure-ai-search', outcome: 'ok' }).count).toBe(1);
    expect(retrieval.get({ provider: 'lexical', outcome: 'ok' }).count).toBe(0);

    await search(h, 'q=proxy', PERSONAS.otherTenantEngineer);
    expect(fake.requests[1]?.body.filter).toBe(`tenantId eq '${FABRIKAM}'`);
  });

  it('never returns a document of another tenant, even if the index ignores the filter', async () => {
    const fake = fakeAzure(() =>
      jsonResponse({
        value: [
          doc(CONTOSO, 'case_ext', 'External hit'),
          doc(FABRIKAM, 'case_foreign', 'FOREIGN-TITLE'),
        ],
      }),
    );
    const h = await azureHarness(fake);
    const res = await search(h, 'q=proxy');
    expect(itemsOf(res.data).map((item) => item.id)).toEqual(['case_ext']);
    expect(JSON.stringify(res.data)).not.toContain('FOREIGN-TITLE');
    expect(
      h
        .logs()
        .some((line) => line.level === 'error' && String(line.msg).includes('another tenant')),
    ).toBe(true);
  });

  it('falls back to lexical search when the service fails, recorded only in the retrieval metric', async () => {
    const fake = fakeAzure(() => jsonResponse({ error: 'unavailable' }, 503));
    const h = await azureHarness(fake);
    await seed(h);

    const res = await search(h, 'q=zephyrquartz');
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.data)).toEqual(['items']);
    const items = itemsOf(res.data);
    expect(items.some((item) => item.id === 'case_alpha')).toBe(true);
    expect(items.every((item) => item.id !== 'case_fab')).toBe(true);

    const retrieval = h.infra.metrics.retrievalDuration;
    expect(retrieval.get({ provider: 'azure-ai-search', outcome: 'fallback' }).count).toBe(1);
    expect(retrieval.get({ provider: 'azure-ai-search', outcome: 'ok' }).count).toBe(0);
    expect(retrieval.get({ provider: 'lexical', outcome: 'ok' }).count).toBe(1);
    const warning = h.logs().find((line) => String(line.msg).includes('Azure AI Search failed'));
    expect(warning).toMatchObject({ failure: 'http_error' });
    expect(JSON.stringify(h.logs())).not.toContain('zephyrquartz');
  });

  it('refuses to call an endpoint outside *.search.windows.net and uses lexical search instead', async () => {
    const fake = fakeAzure(() => jsonResponse({ value: [] }));
    const h = await azureHarness(fake, {
      ...AZURE_SEARCH_ENV,
      AZURE_SEARCH_ENDPOINT: 'https://evil.example.com',
    });
    await seed(h);
    const res = await search(h, 'q=zephyrquartz');
    expect(res.statusCode).toBe(200);
    expect(itemsOf(res.data).some((item) => item.id === 'case_alpha')).toBe(true);
    expect(fake.requests).toHaveLength(0);
    expect(
      h.infra.metrics.retrievalDuration.get({ provider: 'azure-ai-search', outcome: 'fallback' })
        .count,
    ).toBe(1);
    expect(
      h.logs().find((line) => String(line.msg).includes('Azure AI Search failed')),
    ).toMatchObject({ failure: 'unsafe_endpoint' });
  });
});
