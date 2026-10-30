/* eslint-disable @typescript-eslint/no-unsafe-return -- response bodies are parsed JSON, typed `Json` by the harness */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COMPARISON_NOTICE,
  computeQualityReview,
  createFullView,
  getCompiledPack,
  runDeterministicAnalysis,
  type CompiledPack,
  type DeterministicAnalysis,
  type EngineContext,
} from '@caseguard/domain';
import {
  DEFAULT_ACTION_VALUE_CONFIG,
  DEFAULT_QUALITY_CONFIG,
  EVIDENCE_CATEGORIES,
  METRIC_KEYS,
  TWIN_SECTIONS,
  type AnalysisRun,
  type CaseEvent,
  type CaseResolution,
} from '@caseguard/schemas';
import type { Database } from '../src/db';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS } from '../src/db/testing';
import { ENGINE_BUDGET_WINDOW_MS } from '../src/services/engine-budget';
import { ViewCache, compareCases, overrideAction, reviewClaim } from '../src/services/views';
import { buildIngestInput } from './builders';
import {
  CONTOSO,
  FABRIKAM,
  PERSONAS,
  createHarness,
  openSharedDatabase,
  type Harness,
  type Json,
} from './support/app-harness';
import { contextFor } from './support/context';
import { SAMPLE_FILES, ingestSample } from './support/samples';
import { eventBySuffix, ingestOpenCase } from './views-support';

const ONE = 'case_views_one';
const TWO = 'case_views_two';
const OPEN = 'case_views_open';
const FRESH = 'case_views_fresh';
const ODD = 'case_views_odd';
const FOREIGN = 'case_views_foreign';
const END_OF_TIME = '2027-01-01T00:00:00Z';

let database: Database;
let h: Harness;
let oneEvents: CaseEvent[];
let pack: CompiledPack;
let referenceOne: Reference;
let referenceTwo: Reference;

interface Reference {
  readonly analysis: DeterministicAnalysis;
  readonly quality: ReturnType<typeof computeQualityReview>;
}

const refCtx = (caseId: string): EngineContext => ({
  tenantId: CONTOSO,
  caseId,
  runId: 'run_reference',
  now: '2026-10-29T00:00:00.000Z',
  createdBy: 'system:test',
  seed: 'reference',
});

/** What the engine produces on its own for a whole case: the reference the served views must agree with. */
function engineReference(
  events: CaseEvent[],
  resolution: CaseResolution | null,
  caseId: string,
): Reference {
  const analysis = runDeterministicAnalysis({
    view: createFullView(events, resolution),
    pack,
    config: DEFAULT_ACTION_VALUE_CONFIG,
    ctx: refCtx(caseId),
  });
  const quality = computeQualityReview({
    analysis,
    pack,
    ctx: refCtx(caseId),
    config: DEFAULT_QUALITY_CONFIG,
    actionConfig: DEFAULT_ACTION_VALUE_CONFIG,
  });
  return { analysis, quality };
}

beforeAll(async () => {
  database = await openSharedDatabase();
  h = await createHarness({ database });
  const repos = h.repos(CONTOSO);
  const one = await ingestSample(repos, SAMPLE_FILES.caseOne, { tenantId: CONTOSO, caseId: ONE });
  const two = await ingestSample(repos, SAMPLE_FILES.caseTwo, { tenantId: CONTOSO, caseId: TWO });
  await ingestSample(h.repos(FABRIKAM), SAMPLE_FILES.caseTwo, {
    tenantId: FABRIKAM,
    caseId: FOREIGN,
  });
  // An investigation still in progress, whose live warnings are therefore still open.
  await ingestOpenCase(repos, CONTOSO, OPEN);
  // A case that was never analysed, and one whose workload has no knowledge pack.
  await repos.cases.ingest(
    buildIngestInput({
      tenantId: CONTOSO,
      caseId: FRESH,
      workload: 'teams-authentication',
      receivedSeed: 'fresh',
    }),
  );
  await repos.cases.ingest(
    buildIngestInput({
      tenantId: CONTOSO,
      caseId: ODD,
      workload: 'quantum-routing',
      receivedSeed: 'odd',
    }),
  );

  oneEvents = one.events;
  const compiled = getCompiledPack(one.case.workload);
  if (compiled === null) throw new Error('The sample workload has no knowledge pack');
  pack = compiled;
  referenceOne = engineReference(one.events, one.resolution, ONE);
  referenceTwo = engineReference(two.events, two.resolution, TWO);

  const ctx = contextFor(h, PERSONAS.engineer);
  await h.infra.services.analysis.analyzeCase(ctx, ONE);
  await h.infra.services.analysis.analyzeCase(ctx, TWO);
  await h.infra.services.analysis.analyzeCase(ctx, OPEN);
}, TEST_DATABASE_STARTUP_TIMEOUT_MS);

afterAll(async () => {
  await h.close();
  await database.close();
});

const api = (caseId: string, path = ''): string => `/api/v1/cases/${caseId}${path}`;
/**
 * Every request starts with a full engine budget (the clock jumps a window), so the instants these
 * tests scan are never throttled; the metering is tested in views-temporal.test.ts.
 */
const get = (url: string, persona: string | null = PERSONAS.reviewer) => {
  h.clock.advance(ENGINE_BUDGET_WINDOW_MS);
  return h.call(persona, { method: 'GET', url });
};
const post = (url: string, body: unknown, persona: string | null = PERSONAS.reviewer) => {
  h.clock.advance(ENGINE_BUDGET_WINDOW_MS);
  return h.call(persona, { method: 'POST', url, payload: body as object });
};

async function latestRun(caseId: string): Promise<AnalysisRun> {
  const run = await h.repos(CONTOSO).analysis.getLatestRun(caseId);
  if (run === null) throw new Error(`${caseId} has no analysis run`);
  return run;
}

/** Every page of a paginated GET, following the cursors. */
async function pages(url: string, persona: string = PERSONAS.reviewer): Promise<Json[]> {
  const out: Json[] = [];
  let cursor: string | null = null;
  do {
    const sep = url.includes('?') ? '&' : '?';
    const res: Json = await get(
      cursor === null ? url : `${url}${sep}cursor=${encodeURIComponent(cursor)}`,
      persona,
    );
    expect(res.statusCode, JSON.stringify(res.data)).toBe(200);
    out.push(res.data);
    cursor = res.data.nextCursor;
  } while (cursor !== null && out.length < 200);
  return out;
}

const allClaims = async (caseId: string, query = 'limit=25'): Promise<Json[]> =>
  (await pages(api(caseId, `/evidence?${query}`))).flatMap((page) => page.items);

// ------------------------------------------------------------------------------------------
// access control, isolation and validation

const READ_PATHS = [
  '/twin',
  '/timeline',
  '/events/e03',
  '/evidence',
  '/hypotheses',
  '/actions',
  '/action-values',
  '/forks',
  '/graph',
  '/quality',
  '/metrics',
  '/warnings',
  '/coaching',
];
const QUALITY_PATHS = ['/quality', '/metrics', '/coaching'];

describe('access control', () => {
  it('[NFR-SEC-02] refuses anonymous callers on every route', async () => {
    for (const path of READ_PATHS) {
      expect((await get(api(ONE, path), null)).statusCode, path).toBe(401);
    }
    const forkId = (await get(api(ONE, '/forks'))).data.items[0].id;
    expect((await get(api(ONE, `/forks/${forkId}`), null)).statusCode).toBe(401);
    expect((await get(`/api/v1/compare?caseIds=${ONE},${TWO}`, null)).statusCode).toBe(401);
    const bodies: [string, unknown][] = [
      [
        '/claims/clm_x/review',
        { category: 'confirmed_fact', reason: 'because', expectedVersion: 1 },
      ],
      ['/warnings/wrn_x/dismiss', { reason: 'because', expectedVersion: 1 }],
      [
        '/action-values/override',
        { asOf: '2026-03-09T09:41:00Z', actionKey: 'x', rank: 1, reason: 'because' },
      ],
    ];
    for (const [path, body] of bodies) {
      expect((await post(api(ONE, path), body, null)).statusCode, path).toBe(401);
    }
  });

  it('[NFR-SEC-02] lets a role without quality:read read the case but not its quality views', async () => {
    for (const path of QUALITY_PATHS) {
      const res = await get(api(ONE, path), PERSONAS.curator);
      expect(res.statusCode, path).toBe(403);
      expect(res.data.code).toBe('forbidden');
    }
    for (const path of READ_PATHS.filter((p) => !QUALITY_PATHS.includes(p))) {
      expect((await get(api(ONE, path), PERSONAS.curator)).statusCode, path).toBe(200);
    }
  });

  it('[NFR-SEC-02] keeps reviews to the roles that hold the permission, and audits a refusal', async () => {
    const claim = (await allClaims(ONE))[0];
    const review = {
      category: 'confirmed_fact',
      reason: 'Checked the source text',
      expectedVersion: claim.version,
    };
    for (const persona of [PERSONAS.manager, PERSONAS.engineer, PERSONAS.curator]) {
      const res = await post(api(ONE, `/claims/${claim.id}/review`), review, persona);
      expect(res.statusCode, persona).toBe(403);
    }
    const warning = (await get(api(OPEN, '/warnings?state=open'))).data.items[0];
    const dismissal = { reason: 'Not relevant here', expectedVersion: warning.version };
    for (const persona of [PERSONAS.manager, PERSONAS.reviewer, PERSONAS.curator]) {
      const res = await post(api(OPEN, `/warnings/${warning.id}/dismiss`), dismissal, persona);
      expect(res.statusCode, persona).toBe(403);
    }
    const override = {
      asOf: '2026-03-09T09:41:00Z',
      actionKey: 'act.request-har-capture',
      rank: 1,
      reason: 'Prefer this',
    };
    for (const persona of [PERSONAS.manager, PERSONAS.engineer, PERSONAS.curator]) {
      const res = await post(api(ONE, '/action-values/override'), override, persona);
      expect(res.statusCode, persona).toBe(403);
    }
    const denied = (await h.repos(CONTOSO).audit.list({ action: 'access.denied', limit: 50 }))
      .items;
    expect(denied.some((event) => event.actorId === PERSONAS.manager && event.caseId === ONE)).toBe(
      true,
    );
    // Nothing was changed by the refused calls.
    expect((await allClaims(ONE))[0].version).toBe(claim.version);
  });

  it('[NFR-SEC-02] restricts the comparison to roles with analytics:read', async () => {
    const url = `/api/v1/compare?caseIds=${ONE},${TWO}`;
    for (const persona of [PERSONAS.engineer, PERSONAS.reviewer, PERSONAS.curator]) {
      expect((await get(url, persona)).statusCode, persona).toBe(403);
    }
    for (const persona of [PERSONAS.manager, PERSONAS.admin]) {
      expect((await get(url, persona)).statusCode, persona).toBe(200);
    }
  });
});

describe('tenant isolation', () => {
  it('[NFR-SEC-01] answers 404 to another tenant on every read route', async () => {
    for (const path of READ_PATHS) {
      const res = await get(api(ONE, path), PERSONAS.otherTenantEngineer);
      expect(res.statusCode, path).toBe(404);
      expect(res.data.code).toBe('not_found');
    }
    const fork = (await get(api(ONE, '/forks'))).data.items[0];
    const foreignFork = await get(api(ONE, `/forks/${fork.id}`), PERSONAS.otherTenantEngineer);
    expect(foreignFork.statusCode).toBe(404);
    // And the other way round: this tenant cannot see the other tenant's case either.
    for (const path of ['/twin', '/timeline', '/evidence', '/quality']) {
      expect((await get(api(FOREIGN, path), PERSONAS.reviewer)).statusCode, path).toBe(404);
    }
  });

  it('[NFR-SEC-01] cannot dismiss, review or override across tenants', async () => {
    const warning = (await get(api(OPEN, '/warnings?state=open'))).data.items[0];
    const res = await post(
      api(OPEN, `/warnings/${warning.id}/dismiss`),
      { reason: 'Trying across tenants', expectedVersion: warning.version },
      PERSONAS.otherTenantEngineer,
    );
    expect(res.statusCode).toBe(404);
    expect((await get(api(OPEN, '/warnings?state=open'))).data.items[0].state).toBe('open');

    // The permission check refuses first over HTTP, so the services are called directly.
    const foreign = contextFor(h, PERSONAS.otherTenantEngineer);
    const claim = (await allClaims(ONE))[0];
    await expect(
      reviewClaim(foreign, ONE, claim.id, {
        category: 'confirmed_fact',
        reason: 'across tenants',
        expectedVersion: claim.version,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      overrideAction(foreign, { cache: new ViewCache() }, ONE, {
        asOf: '2026-03-09T09:41:00Z',
        actionKey: 'act.request-har-capture',
        rank: 1,
        reason: 'across tenants',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('[NFR-SEC-01] answers 404 for a comparison when either case belongs to another tenant', async () => {
    const manager = contextFor(h, PERSONAS.manager);
    await expect(compareCases(manager, { caseIds: `${ONE},${FOREIGN}` })).rejects.toMatchObject({
      code: 'not_found',
    });
    const foreign = contextFor(h, PERSONAS.otherTenantEngineer);
    await expect(compareCases(foreign, { caseIds: `${ONE},${TWO}` })).rejects.toMatchObject({
      code: 'not_found',
    });
    const mixed = await get(`/api/v1/compare?caseIds=${ONE},${FOREIGN}`, PERSONAS.manager);
    expect(mixed.statusCode).toBe(404);
    const missing = await get(
      `/api/v1/compare?caseIds=${ONE},case_does_not_exist`,
      PERSONAS.manager,
    );
    expect(missing.statusCode).toBe(404);
  });
});

describe('validation', () => {
  const ASOF_PATHS = [
    '/twin',
    '/timeline',
    '/events/e03',
    '/evidence',
    '/hypotheses',
    '/actions',
    '/action-values',
    '/forks',
    '/graph',
    '/quality',
    '/metrics',
    '/warnings',
  ];

  it('[NFR-SEC-05] rejects a malformed asOf with a 422 problem on every time-aware route', async () => {
    for (const path of ASOF_PATHS) {
      for (const bad of ['yesterday', '2026-03-09', '2026-03-09T09:41:00+02:00', '']) {
        const res = await get(api(ONE, `${path}?asOf=${encodeURIComponent(bad)}`));
        expect(res.statusCode, `${path} ${bad}`).toBe(422);
        expect(res.data.code).toBe('validation_failed');
      }
    }
  });

  it('[FR-UX-04] rejects bad pagination, filters and cursors', async () => {
    for (const query of [
      'limit=0',
      'limit=201',
      'limit=abc',
      'category=bogus',
      'reviewState=bogus',
      'cursor=not-a-cursor',
    ]) {
      expect((await get(api(ONE, `/evidence?${query}`))).statusCode, query).toBe(422);
      expect(
        (await get(api(ONE, `/evidence?asOf=${END_OF_TIME}&${query}`))).statusCode,
        `as of: ${query}`,
      ).toBe(422);
    }
    for (const query of [
      'limit=0',
      'types=bogus',
      'types=customer_email,bogus',
      'roles=bogus',
      'category=bogus',
      'from=2026-03-09T12:00:00Z&to=2026-03-09T09:00:00Z',
      'cursor=not-a-cursor',
      'from=today',
    ]) {
      expect((await get(api(ONE, `/timeline?${query}`))).statusCode, query).toBe(422);
    }
    expect((await get(api(ONE, '/warnings?state=bogus'))).statusCode).toBe(422);
    expect((await get(api(ONE, '/action-values?forkId=has%20space'))).statusCode).toBe(422);
    // A cursor minted for another list is refused, not misread.
    const events = await get(api(ONE, '/timeline?limit=3'));
    const cursor = encodeURIComponent(events.data.nextCursor);
    expect((await get(api(ONE, `/evidence?limit=3&cursor=${cursor}`))).statusCode).toBe(422);
  });

  it('[NFR-SEC-05] rejects malformed review bodies', async () => {
    const claim = (await allClaims(ONE))[0];
    const url = api(ONE, `/claims/${claim.id}/review`);
    const good = {
      category: 'confirmed_fact',
      reason: 'Checked the source',
      expectedVersion: claim.version,
    };
    for (const body of [
      {},
      { ...good, category: 'bogus' },
      { ...good, reason: 'abc' },
      { ...good, reason: '          ' },
      { ...good, reason: 'x'.repeat(1001) },
      { ...good, expectedVersion: 0 },
      { ...good, expectedVersion: 'one' },
      { category: good.category, reason: good.reason },
    ]) {
      expect((await post(url, body)).statusCode, JSON.stringify(body).slice(0, 80)).toBe(422);
    }
    const warning = (await get(api(OPEN, '/warnings?state=open'))).data.items[0];
    for (const body of [
      {},
      { reason: 'abc', expectedVersion: 1 },
      { reason: '        ', expectedVersion: warning.version },
      { reason: 'Fine reason' },
    ]) {
      const res = await post(api(OPEN, `/warnings/${warning.id}/dismiss`), body, PERSONAS.engineer);
      expect(res.statusCode, JSON.stringify(body)).toBe(422);
    }
    const base = { asOf: '2026-03-09T09:41:00Z', actionKey: 'a', rank: 1, reason: 'Prefer this' };
    for (const body of [
      {},
      { ...base, asOf: 'now' },
      { ...base, rank: 0 },
      { ...base, rank: 51 },
      { ...base, reason: '        ' },
      { asOf: base.asOf, rank: 1, reason: base.reason },
    ]) {
      const res = await post(api(ONE, '/action-values/override'), body);
      expect(res.statusCode, JSON.stringify(body)).toBe(422);
    }
  });

  it('[NFR-SEC-05] rejects anything but exactly two different case ids for a comparison', async () => {
    const bad = [
      ONE,
      `${ONE},${TWO},${FRESH}`,
      `${ONE},${ONE}`,
      `${ONE},`,
      ',',
      'a',
      `${ONE},bad id`,
    ];
    for (const ids of bad) {
      const res = await get(`/api/v1/compare?caseIds=${encodeURIComponent(ids)}`, PERSONAS.manager);
      expect(res.statusCode, ids).toBe(422);
    }
    expect((await get('/api/v1/compare', PERSONAS.manager)).statusCode).toBe(422);
  });

  it('[NFR-SEC-05] answers 404 for an unknown case, fork, event, claim, warning or scenario', async () => {
    for (const path of READ_PATHS) {
      expect((await get(api('case_does_not_exist', path))).statusCode, path).toBe(404);
    }
    expect((await get(api(ONE, '/forks/fork_missing'))).statusCode).toBe(404);
    expect((await get(api(ONE, '/events/e999'))).statusCode).toBe(404);
    expect((await get(api(ONE, '/events/g03'))).statusCode).toBe(404);
    expect((await get(api(ONE, '/graph?scenarioId=cfs_missing'))).statusCode).toBe(404);
    expect((await get(api(ONE, '/timeline?scenarioId=cfs_missing'))).statusCode).toBe(404);
    expect((await get(api(ONE, '/action-values?forkId=fork_missing'))).statusCode).toBe(404);
    const claim = await post(api(ONE, '/claims/clm_missing/review'), {
      category: 'confirmed_fact',
      reason: 'No such claim',
      expectedVersion: 1,
    });
    expect(claim.statusCode).toBe(404);
    const warning = await post(
      api(ONE, '/warnings/wrn_missing/dismiss'),
      { reason: 'No such warning', expectedVersion: 1 },
      PERSONAS.engineer,
    );
    expect(warning.statusCode).toBe(404);
  });
});

describe('a case that has not been analysed', () => {
  it('[FR-UX-03] answers 409 with a clear next step on every artefact view', async () => {
    for (const path of READ_PATHS.filter((p) => !p.startsWith('/events'))) {
      const res = await get(api(FRESH, path));
      expect(res.statusCode, path).toBe(409);
      expect(res.data.code).toBe('conflict');
      expect(res.data.detail).toBe('This case has not been analysed yet. Start an analysis first.');
    }
    expect((await get(api(FRESH, '/timeline?asOf=2030-01-01T00:00:00Z'))).statusCode).toBe(409);
    expect((await get(api(FRESH, '/forks/fork_x'))).statusCode).toBe(409);
    const claim = await post(api(FRESH, '/claims/clm_x/review'), {
      category: 'confirmed_fact',
      reason: 'Nothing to review',
      expectedVersion: 1,
    });
    expect(claim.statusCode).toBe(409);
  });

  it('[FR-TL-02] still serves the immutable event record, with no derived claims', async () => {
    const first = (await h.repos(CONTOSO).cases.getAllEvents(FRESH))[0];
    expect(first).toBeDefined();
    const res = await get(api(FRESH, `/events/${first?.id}`));
    expect(res.statusCode).toBe(200);
    expect(res.data.event.id).toBe(first?.id);
    expect(res.data.claims).toEqual([]);
    expect(res.data.evidence).toEqual([]);
    // A case that cannot be analysed at all (no knowledge pack for its workload) still has its record.
    const odd = (await h.repos(CONTOSO).cases.getAllEvents(ODD))[0];
    expect((await get(api(ODD, `/events/${odd?.id}`))).statusCode).toBe(200);
  });

  it('[FR-AN-02] compares a case that has no metrics yet without inventing numbers', async () => {
    const res = await get(`/api/v1/compare?caseIds=${FRESH},${ONE}`, PERSONAS.manager);
    expect(res.statusCode).toBe(200);
    for (const row of res.data.rows) {
      expect(row.values[0].value).toBeNull();
      expect(row.betterCaseId).toBeNull();
    }
  });
});

// ------------------------------------------------------------------------------------------
// the views over a stored analysis

describe('digital twin', () => {
  it('[FR-TWIN-02] serves the stored twin with provenance on every field', async () => {
    const res = await get(api(ONE, '/twin'));
    expect(res.statusCode).toBe(200);
    const run = await latestRun(ONE);
    expect(res.data.caseId).toBe(ONE);
    expect(res.data.analysisRunId).toBe(run.id);
    expect(res.data.asOf).toBeNull();
    expect(res.data.withheldFutureEventCount).toBe(0);
    expect(res.data.fields.length).toBeGreaterThan(10);
    for (const field of res.data.fields) {
      expect(field.method).toBeDefined();
      expect(field.extractedAt).toBeDefined();
      expect(field.reviewStatus).toBe('pending');
      expect(field.confidence).toBeGreaterThanOrEqual(0);
      expect(field.confidence).toBeLessThanOrEqual(1);
    }
    expect(Object.keys(res.data.sectionCounts).sort()).toEqual([...TWIN_SECTIONS].sort());
    expect(res.data).toEqual(await h.repos(CONTOSO).analysis.getTwin(ONE));
  });
});

describe('timeline', () => {
  it('[FR-TL-01][FR-TL-04][FR-TL-05] lists every event in record order with delays, repeats and hypothesis series', async () => {
    const res = await get(api(ONE, '/timeline?limit=200'));
    expect(res.statusCode).toBe(200);
    expect(res.data.caseId).toBe(ONE);
    expect(res.data.asOf).toBeNull();
    expect(res.data.total).toBe(oneEvents.length);
    expect(res.data.nextCursor).toBeNull();
    expect(res.data.withheldFutureEventCount).toBe(0);
    expect(res.data.events.map((event: Json) => event.id)).toEqual(
      oneEvents.map((event) => event.id),
    );
    expect(res.data.delays.length).toBeGreaterThan(0);
    expect(res.data.repeats.length).toBeGreaterThan(0);
    expect(res.data.hypothesisSeries.length).toBeGreaterThan(0);
    expect(res.data.hypothesisSeries.length).toBeLessThanOrEqual(5);
    expect(res.data.simulatedEvents).toEqual([]);
    expect(res.data.events.every((event: Json) => event.simulated === false)).toBe(true);
    // The earliest meaningful fork sits on e03; the premature remediation is flagged destructive.
    const e03 = res.data.events.find((event: Json) => event.id.endsWith('e03'));
    expect(e03.forkIds.length).toBeGreaterThan(0);
    expect(res.data.events.some((event: Json) => event.destructive)).toBe(true);
    expect(res.data.knownAtAsOf.claimCount).toBe(referenceOne.analysis.claims.length);
    expect(res.data.knownAtAsOf.evidenceCount).toBe(referenceOne.analysis.evidence.length);

    // Recomputing the whole record under the stored run gives exactly the stored artefact ids.
    const repos = h.repos(CONTOSO);
    const storedClaims = (await repos.analysis.listClaims(ONE, { limit: 200 })).items;
    const onTimeline = new Set(res.data.events.flatMap((event: Json) => event.claimIds));
    expect(onTimeline).toEqual(
      new Set(storedClaims.filter((claim) => claim.eventId !== null).map((claim) => claim.id)),
    );
    const forkIds = res.data.events.flatMap((event: Json) => event.forkIds);
    expect(new Set(forkIds)).toEqual(
      new Set((await repos.analysis.listForks(ONE)).map((f) => f.id)),
    );
    const evidenceIds = res.data.events.flatMap((event: Json) => event.evidenceIds);
    expect(new Set(evidenceIds)).toEqual(
      new Set((await repos.analysis.listEvidence(ONE)).map((item) => item.id)),
    );
  });

  it('[FR-TL-01] shows the efficient case as a shorter, quieter timeline', async () => {
    const res = await get(api(TWO, '/timeline?limit=200'));
    expect(res.data.total).toBe(referenceTwo.analysis.view.events.length);
    expect(res.data.events.every((event: Json) => event.forkIds.length === 0)).toBe(true);
  });

  it('[FR-TL-01] filters by event type, participant role, evidence category and hypothesis', async () => {
    const all = (await get(api(ONE, '/timeline?limit=200'))).data.events as Json[];
    const emails = (await get(api(ONE, '/timeline?types=customer_email&limit=200'))).data;
    expect(emails.events.length).toBe(oneEvents.filter((e) => e.type === 'customer_email').length);
    expect(emails.events.every((event: Json) => event.type === 'customer_email')).toBe(true);
    expect(emails.total).toBe(emails.events.length);

    const both = (await get(api(ONE, '/timeline?types=customer_email,escalation&limit=200'))).data;
    expect(both.events.length).toBe(
      oneEvents.filter((e) => e.type === 'customer_email' || e.type === 'escalation').length,
    );

    const engineers = (await get(api(ONE, '/timeline?roles=support_engineer&limit=200'))).data;
    expect(engineers.events.length).toBe(
      oneEvents.filter((e) => e.participantRole === 'support_engineer').length,
    );

    const assumptions = (await get(api(ONE, '/timeline?category=engineer_assumption&limit=200')))
      .data;
    expect(assumptions.events.length).toBeGreaterThan(0);
    expect(assumptions.events.length).toBeLessThan(all.length);
    expect(
      assumptions.events.every((event: Json) => event.categories.includes('engineer_assumption')),
    ).toBe(true);

    const hypotheses = (await get(api(ONE, '/hypotheses'))).data.items;
    const dns = hypotheses.find((item: Json) => item.key === 'hyp.dns-resolution');
    const related = (await get(api(ONE, `/timeline?hypothesisId=${dns.id}&limit=200`))).data;
    expect(related.events.length).toBeGreaterThan(0);
    expect(related.events.length).toBeLessThan(all.length);
    const unknown = await get(api(ONE, '/timeline?hypothesisId=hyp_unknown&limit=200'));
    expect(unknown.data.events).toEqual([]);
  });

  it('[FR-TL-02] zooms into a window and never reaches beyond asOf', async () => {
    const from = eventBySuffix(oneEvents, 'e05').timestamp;
    const to = eventBySuffix(oneEvents, 'e09').timestamp;
    const zoom = (await get(api(ONE, `/timeline?from=${from}&to=${to}&limit=200`))).data;
    expect(zoom.events.map((event: Json) => event.id)).toEqual(
      oneEvents.filter((e) => e.timestamp >= from && e.timestamp <= to).map((e) => e.id),
    );
    const asOf = eventBySuffix(oneEvents, 'e07').timestamp;
    const clamped = (await get(api(ONE, `/timeline?from=${from}&to=${to}&asOf=${asOf}&limit=200`)))
      .data;
    expect(clamped.events.map((event: Json) => event.id)).toEqual(
      oneEvents.filter((e) => e.timestamp >= from && e.timestamp <= asOf).map((e) => e.id),
    );
  });

  it('[FR-UX-04] pages with opaque cursors without gaps or repeats, and keeps delays on their page', async () => {
    const list = await pages(api(ONE, '/timeline?limit=7'));
    expect(list.length).toBe(Math.ceil(oneEvents.length / 7));
    const ids = list.flatMap((page) => page.events.map((event: Json) => event.id));
    expect(ids).toEqual(oneEvents.map((event) => event.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(list.every((page) => page.total === oneEvents.length)).toBe(true);
    expect(list.at(-1)?.nextCursor).toBeNull();
    for (const page of list) {
      const onPage = new Set(page.events.map((event: Json) => event.id));
      expect(page.delays.every((delay: Json) => onPage.has(delay.toEventId))).toBe(true);
      expect(page.repeats.every((repeat: Json) => onPage.has(repeat.eventId))).toBe(true);
    }
    // Filters and paging compose.
    const filtered = await pages(api(ONE, '/timeline?types=customer_email&limit=3'));
    expect(filtered.flatMap((page) => page.events).length).toBe(
      oneEvents.filter((e) => e.type === 'customer_email').length,
    );
  });

  it('[FR-TL-03] overlays the simulated events of a stored scenario, labelled simulated', async () => {
    const scenario = (await h.repos(CONTOSO).counterfactuals.list(ONE))[0];
    expect(scenario).toBeDefined();
    const res = await get(api(ONE, `/timeline?scenarioId=${scenario?.id}&limit=200`));
    expect(res.statusCode).toBe(200);
    expect(res.data.simulatedEvents.length).toBe(scenario?.steps.length);
    expect(
      res.data.simulatedEvents.every(
        (event: Json) => event.simulated === true && event.scenarioId === scenario?.id,
      ),
    ).toBe(true);
    expect(res.data.events.every((event: Json) => event.simulated === false)).toBe(true);
    // A scenario of another case is not found through this one.
    const other = (await h.repos(CONTOSO).counterfactuals.list(TWO))[0];
    if (other !== undefined) {
      expect((await get(api(ONE, `/timeline?scenarioId=${other.id}`))).statusCode).toBe(404);
    }
  });
});

describe('source events', () => {
  it('[FR-TL-02] returns an event with the claims and evidence derived from it and its replies', async () => {
    const e03 = eventBySuffix(oneEvents, 'e03');
    const e04 = eventBySuffix(oneEvents, 'e04');
    const res = await get(api(ONE, `/events/${e03.id}`));
    expect(res.statusCode).toBe(200);
    expect(res.data.event.id).toBe(e03.id);
    expect(res.data.event.body).toBe(e03.body);
    expect(res.data.claims.every((claim: Json) => claim.eventId === e03.id)).toBe(true);
    expect(res.data.evidence.every((item: Json) => item.eventId === e03.id)).toBe(true);
    expect(res.data.responses.map((reply: Json) => reply.id)).toEqual([e04.id]);
    expect(res.data.inResponseTo).toBeNull();

    const reply = await get(api(ONE, `/events/${e04.id}`));
    expect(reply.data.inResponseTo).toMatchObject({ id: e03.id, type: e03.type });
    expect(reply.data.claims.length + reply.data.evidence.length).toBeGreaterThan(0);
    // Every claim and evidence row the ledger holds for the event is on it.
    const ledger = await allClaims(ONE, 'limit=200');
    expect(reply.data.claims.map((claim: Json) => claim.id).sort()).toEqual(
      ledger
        .filter((claim) => claim.eventId === e04.id)
        .map((claim) => claim.id)
        .sort(),
    );
  });
});

describe('evidence ledger', () => {
  it('[FR-EV-01] counts claims in the eight categories and returns the evidence they cite', async () => {
    const run = await latestRun(ONE);
    const res = await get(api(ONE, '/evidence?limit=200'));
    expect(res.statusCode).toBe(200);
    expect(res.data.asOf).toBeNull();
    expect(Object.keys(res.data.counts).sort()).toEqual([...EVIDENCE_CATEGORIES].sort());
    const total = Object.values(res.data.counts as Record<string, number>).reduce(
      (a, b) => a + b,
      0,
    );
    expect(total).toBe(run.counts.claims);
    expect(res.data.items.length).toBe(Math.min(200, run.counts.claims));
    const cited = new Set(res.data.evidence.map((item: Json) => item.id));
    for (const claim of res.data.items) {
      for (const id of [...claim.supportingEvidenceIds, ...claim.contradictingEvidenceIds]) {
        expect(cited.has(id), `${claim.id} cites ${id}`).toBe(true);
      }
      expect(claim.aiCategory).toBeDefined();
      expect(claim.reviewState).toBe('pending');
    }
    expect(res.data.missing.length).toBeGreaterThan(0);
  });

  it('[FR-UX-04] pages the ledger with opaque cursors, in time order, without repeats', async () => {
    const run = await latestRun(ONE);
    const claims = await allClaims(ONE, 'limit=17');
    expect(claims.length).toBe(run.counts.claims);
    expect(new Set(claims.map((claim) => claim.id)).size).toBe(claims.length);
    const stamps = claims.map((claim) => Date.parse(claim.timestamp));
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);
  });

  it('[FR-EV-02] filters the ledger by category, review state, hypothesis and text', async () => {
    const claims = await allClaims(ONE, 'limit=200');
    const category =
      claims.find((claim) => claim.category === 'engineer_assumption')?.category ??
      'customer_reported';
    const byCategory = await allClaims(ONE, `category=${category}&limit=200`);
    expect(byCategory.length).toBe(claims.filter((claim) => claim.category === category).length);
    expect(byCategory.every((claim) => claim.category === category)).toBe(true);

    expect((await allClaims(ONE, 'reviewState=pending&limit=200')).length).toBe(claims.length);
    expect(await allClaims(ONE, 'reviewState=corrected&limit=200')).toEqual([]);

    const hypotheses = (await get(api(ONE, '/hypotheses'))).data.items;
    const dns = hypotheses.find((item: Json) => item.key === 'hyp.dns-resolution');
    const related = await allClaims(ONE, `hypothesisId=${dns.id}&limit=200`);
    expect(related.length).toBeGreaterThan(0);
    // Claims relate to a hypothesis by its knowledge-pack key; the filter accepts the record id or the key.
    const names = (claim: Json): boolean =>
      claim.relatedHypothesisIds.some((id: string) => id === dns.id || id === dns.key);
    expect(related.every(names)).toBe(true);
    expect(related.length).toBe(claims.filter(names).length);
    const byKey = await allClaims(ONE, `hypothesisId=${dns.key}&limit=200`);
    expect(byKey.map((claim) => claim.id)).toEqual(related.map((claim) => claim.id));

    const needle =
      String(claims.find((claim) => claim.text.length > 20)?.text).split(' ')[2] ?? 'dns';
    const found = await allClaims(ONE, `q=${encodeURIComponent(needle)}&limit=200`);
    expect(found.length).toBeGreaterThan(0);
    for (const claim of found) {
      const haystack = `${claim.text} ${claim.subject ?? ''}`.toLowerCase();
      expect(haystack).toContain(needle.toLowerCase());
    }
  });
});

describe('hypotheses and actions', () => {
  it('[FR-HY-01] ranks the competing hypotheses and presents confidence as a model estimate', async () => {
    const res = await get(api(ONE, '/hypotheses'));
    expect(res.statusCode).toBe(200);
    expect(res.data.asOf).toBeNull();
    expect(res.data.notice).toMatch(/model estimates/i);
    const items = res.data.items as Json[];
    expect(items.length).toBe(referenceOne.analysis.hypotheses.length);
    expect(items.every((item) => item.modelEstimate === true)).toBe(true);
    const confidences = items.map((item) => item.currentConfidence);
    expect([...confidences].sort((a, b) => b - a)).toEqual(confidences);
    // The engine's own verdict: the DNS resolver policy is the confirmed root cause of Case One.
    const leader = [...referenceOne.analysis.hypotheses].sort(
      (a, b) => b.currentConfidence - a.currentConfidence,
    )[0];
    expect(items[0].key).toBe(leader?.key);
    expect(items[0].key).toBe('hyp.dns-resolution');
    expect(items[0].currentStatus).toBe('confirmed');
    expect(res.data.links.length).toBeGreaterThan(0);
    expect(res.data.evidence.length).toBeGreaterThan(0);
    expect(res.data.missing.length).toBeGreaterThan(0);

    const two = (await get(api(TWO, '/hypotheses'))).data.items;
    const leaderTwo = [...referenceTwo.analysis.hypotheses].sort(
      (a, b) => b.currentConfidence - a.currentConfidence,
    )[0];
    expect(two[0].key).toBe(leaderTwo?.key);
  });

  it('[FR-TL-04] lists the actions taken, in order, matching the engine', async () => {
    const res = await get(api(ONE, '/actions'));
    expect(res.statusCode).toBe(200);
    expect(res.data.items.map((action: Json) => action.id)).toEqual(
      referenceOne.analysis.actions.map((action) => action.id),
    );
    const sequences = res.data.items.map((action: Json) => action.sequence);
    expect([...sequences].sort((a: number, b: number) => a - b)).toEqual(sequences);
    expect(res.data.items.some((action: Json) => action.isRepeat)).toBe(true);
    expect(res.data.items.some((action: Json) => action.destructive)).toBe(true);
  });
});

describe('decision forks', () => {
  it('[FR-FK-01][FR-FK-03] finds the forks the engine finds, with e03 the earliest meaningful one', async () => {
    const res = await get(api(ONE, '/forks'));
    expect(res.statusCode).toBe(200);
    expect(res.data.items.map((fork: Json) => fork.id).sort()).toEqual(
      referenceOne.analysis.forks.map((fork) => fork.id).sort(),
    );
    expect(res.data.items.length).toBeGreaterThanOrEqual(3);
    const earliest = res.data.items.find(
      (fork: Json) => fork.id === res.data.earliestMeaningfulForkId,
    );
    expect(earliest.eventId.endsWith('e03')).toBe(true);
    expect(earliest.isEarliestMeaningful).toBe(true);
    expect(res.data.items.filter((fork: Json) => fork.isEarliestMeaningful)).toHaveLength(1);
    for (const fork of res.data.items) {
      expect(fork.eligibility.boundary).toBe(fork.timestamp);
      expect(fork.alternatives.length).toBeLessThanOrEqual(6);
      expect(fork.consequences.actual.estimated).toBe(true);
    }
  });

  it('[FR-FK-01] finds no fork in the efficient case', async () => {
    const res = await get(api(TWO, '/forks'));
    expect(res.data.items).toEqual([]);
    expect(res.data.earliestMeaningfulForkId).toBeNull();
    expect(referenceTwo.analysis.forks).toHaveLength(0);
  });

  it('[FR-CF-07] returns hindsight only to callers entitled to it, labelled as such', async () => {
    const reviewer = (await get(api(ONE, '/forks'), PERSONAS.reviewer)).data.items as Json[];
    const hindsight = reviewer.filter((fork) => fork.retrospective !== null);
    expect(hindsight.length).toBeGreaterThan(0);
    for (const fork of hindsight) {
      expect(fork.retrospective.usedHindsight).toBe(true);
      expect(fork.retrospective.outcomeSummary).toMatch(/^Hindsight:/);
    }
    for (const persona of [PERSONAS.engineer, PERSONAS.manager, PERSONAS.curator]) {
      const items = (await get(api(ONE, '/forks'), persona)).data.items as Json[];
      expect(
        items.every((fork) => fork.retrospective === null),
        persona,
      ).toBe(true);
      // Everything else is identical: only the hindsight is withheld.
      expect(items.map((fork) => ({ ...fork, retrospective: null }))).toEqual(
        reviewer.map((fork) => ({ ...fork, retrospective: null })),
      );
    }
  });

  it('[FR-FK-02] returns one fork, equal to its list entry for the same caller', async () => {
    for (const persona of [PERSONAS.reviewer, PERSONAS.engineer]) {
      const list = (await get(api(ONE, '/forks'), persona)).data.items as Json[];
      const res = await get(api(ONE, `/forks/${list[1]?.id}`), persona);
      expect(res.statusCode).toBe(200);
      expect(res.data).toEqual(list[1]);
    }
  });
});

describe('investigation graph', () => {
  it('[FR-UX-02] draws the problem, evidence, hypotheses, actual path and forks within the node limit', async () => {
    const res = await get(api(ONE, '/graph'));
    expect(res.statusCode).toBe(200);
    expect(res.data.asOf).toBeNull();
    expect(res.data.scenarioId).toBeNull();
    expect(res.data.nodes.length).toBeLessThanOrEqual(res.data.nodeLimit);
    expect(res.data.nodeLimit).toBe(160);
    expect(res.data.truncated).toBe(false);
    expect(res.data.lanes.map((lane: Json) => lane.id)).toEqual([
      'problem',
      'evidence',
      'hypothesis',
      'actual',
      'counterfactual',
      'outcome',
      'skill',
    ]);
    const kinds = new Set(res.data.nodes.map((node: Json) => node.kind));
    for (const kind of ['problem', 'evidence', 'hypothesis', 'action', 'fork', 'outcome']) {
      expect(kinds.has(kind), kind).toBe(true);
    }
    expect(res.data.nodes.some((node: Json) => node.simulated)).toBe(false);
    // A fork is drawn on the action it branches from.
    const { actions, forks } = referenceOne.analysis;
    const drawable = forks.filter((fork) => actions.some((a) => a.eventId === fork.eventId));
    expect(res.data.nodes.filter((node: Json) => node.kind === 'fork')).toHaveLength(
      drawable.length,
    );
    const ids = new Set(res.data.nodes.map((node: Json) => node.id));
    for (const edge of res.data.edges) expect(ids.has(edge.from) && ids.has(edge.to)).toBe(true);
    expect(res.data.summary).toMatch(/simulated/i);

    const two = (await get(api(TWO, '/graph'))).data;
    expect(two.nodes.some((node: Json) => node.kind === 'fork')).toBe(false);
  });

  it('[FR-UX-02] overlays a stored scenario as simulated nodes and dashed connectors', async () => {
    const scenario = (await h.repos(CONTOSO).counterfactuals.list(ONE))[0];
    const res = await get(api(ONE, `/graph?scenarioId=${scenario?.id}`));
    expect(res.statusCode).toBe(200);
    expect(res.data.scenarioId).toBe(scenario?.id);
    const simulated = res.data.nodes.filter((node: Json) => node.simulated);
    expect(simulated.length).toBeGreaterThan(scenario?.steps.length ?? 0);
    expect(simulated.every((node: Json) => ['counterfactual', 'outcome'].includes(node.lane))).toBe(
      true,
    );
    const dashed = res.data.edges.filter((edge: Json) => edge.kind === 'counterfactual');
    expect(dashed.length).toBeGreaterThan(0);
    expect(dashed.every((edge: Json) => edge.simulated)).toBe(true);
    const real = res.data.nodes.filter((node: Json) => !node.simulated);
    expect(real.every((node: Json) => node.lane !== 'counterfactual')).toBe(true);
    const foreign = (await h.repos(CONTOSO).counterfactuals.list(TWO))[0];
    if (foreign !== undefined) {
      expect((await get(api(ONE, `/graph?scenarioId=${foreign.id}`))).statusCode).toBe(404);
    }
  });
});

describe('quality, metrics and coaching', () => {
  it('[FR-QI-01] scores the costly case low and the efficient one high, as the engine does', async () => {
    const one = (await get(api(ONE, '/quality'))).data;
    const two = (await get(api(TWO, '/quality'))).data;
    expect(one.asOf).toBeNull();
    expect(one.estimated).toBe(true);
    expect(one.compositeScore).toBe(referenceOne.quality.compositeScore);
    expect(two.compositeScore).toBe(referenceTwo.quality.compositeScore);
    expect(one.compositeScore).toBeLessThan(60);
    expect(two.compositeScore).toBeGreaterThan(85);
    expect(one.dimensions).toHaveLength(6);
    expect(one.penalties.length).toBeGreaterThan(two.penalties.length);
    expect(one.improvements.length).toBeGreaterThan(0);
    expect(one.estimatedScoreAfterImprovements.score).toBeGreaterThan(one.compositeScore);
    const weights = Object.values(one.weights as Record<string, number>);
    expect(weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);
    expect(one.uncertaintyNote).toMatch(/estimate/i);
  });

  it('[FR-ASE-01] serves the seven metric estimates, all labelled as estimates', async () => {
    const res = await get(api(ONE, '/metrics'));
    expect(res.statusCode).toBe(200);
    expect(res.data.items.map((metric: Json) => metric.key)).toEqual([...METRIC_KEYS]);
    expect(res.data.items.every((metric: Json) => metric.estimated === true)).toBe(true);
    const quality = (await get(api(ONE, '/quality'))).data;
    const cqi = res.data.items.find((metric: Json) => metric.key === 'case_quality_index');
    expect(cqi.value).toBe(quality.compositeScore);
    const ase = res.data.items.find((metric: Json) => metric.key === 'avoidable_support_effort');
    expect(ase.ase.components.length).toBeGreaterThan(0);
    expect(ase.ase.method.length).toBeGreaterThan(20);
    expect(ase.value).toBeGreaterThan(0);

    const two = (await get(api(TWO, '/metrics'))).data.items;
    expect(two.find((metric: Json) => metric.key === 'avoidable_support_effort').value).toBe(0);
  });

  it('[FR-CO-01] serves a supportive coaching report with its limits', async () => {
    const run = await latestRun(ONE);
    const res = await get(api(ONE, '/coaching'));
    expect(res.statusCode).toBe(200);
    expect(res.data.caseId).toBe(ONE);
    expect(res.data.analysisRunId).toBe(run.id);
    expect(res.data.summary.length).toBeGreaterThan(20);
    expect(res.data.notice).toMatch(/not a performance rating/i);
    expect(res.data.missedOpportunity).not.toBeNull();
    expect(res.data.confidence.level).toBeDefined();
    expect(res.data.limitations.length).toBeGreaterThan(0);
  });
});

describe('live warnings', () => {
  it('[FR-LQ-01] lists ranked, evidence-linked warnings and filters them by state', async () => {
    // A finished case has resolved every warning by its end; the unfinished one still has open ones.
    const finished = (await get(api(ONE, '/warnings'))).data.items as Json[];
    expect(finished.length).toBeGreaterThan(0);
    expect(finished.every((warning) => warning.state === 'resolved')).toBe(true);
    expect((await get(api(ONE, '/warnings?state=open'))).data.items).toEqual([]);

    const all = (await get(api(OPEN, '/warnings'))).data.items as Json[];
    expect(all.length).toBeGreaterThan(0);
    expect(all.map((warning) => warning.rank)).toEqual(all.map((_, index) => index + 1));
    const open = (await get(api(OPEN, '/warnings?state=open'))).data.items as Json[];
    const resolved = (await get(api(OPEN, '/warnings?state=resolved'))).data.items as Json[];
    const dismissed = (await get(api(OPEN, '/warnings?state=dismissed'))).data.items as Json[];
    expect(open.length + resolved.length + dismissed.length).toBe(all.length);
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((warning) => warning.state === 'open')).toBe(true);
    expect(open.some((warning) => warning.evidence.length > 0)).toBe(true);
    expect(open.every((warning) => warning.suggestedAction.length > 0)).toBe(true);
    const explicit = (await get(api(OPEN, '/warnings?state=all'))).data.items as Json[];
    expect(explicit.map((w) => w.id)).toEqual(all.map((w) => w.id));
  });

  it('[FR-LQ-02] shows the warnings that were open at an instant of the finished case', async () => {
    const asOf = eventBySuffix(oneEvents, 'e07').timestamp;
    const res = await get(api(ONE, `/warnings?asOf=${asOf}&state=open`));
    expect(res.data.items.length).toBeGreaterThan(0);
    expect(res.data.items.every((warning: Json) => warning.state === 'open')).toBe(true);
    expect(res.data.items.every((warning: Json) => warning.resolvedAt === null)).toBe(true);
  });
});

describe('comparison of two cases', () => {
  it('[FR-AN-02] compares the stored estimates, labelled, without ranking people', async () => {
    const res = await get(`/api/v1/compare?caseIds=${ONE},${TWO}`, PERSONAS.manager);
    expect(res.statusCode).toBe(200);
    expect(res.data.cases.map((summary: Json) => summary.id)).toEqual([ONE, TWO]);
    expect(res.data.rows.map((row: Json) => row.metric)).toEqual([...METRIC_KEYS]);
    expect(res.data.labels).toEqual({ synthetic: true, estimated: true });
    expect(res.data.notice).toBe(COMPARISON_NOTICE);
    expect(res.data.narrative.length).toBeGreaterThan(1);
    expect(res.data.narrative.join(' ')).toMatch(/estimates?/i);

    const quality = res.data.rows.find((row: Json) => row.metric === 'case_quality_index');
    expect(quality.values.map((value: Json) => value.caseId)).toEqual([ONE, TWO]);
    expect(quality.values[0].value).toBe(referenceOne.quality.compositeScore);
    expect(quality.values[1].value).toBe(referenceTwo.quality.compositeScore);
    expect(quality.betterCaseId).toBe(TWO);
    expect(quality.note).toMatch(/estimates/i);

    expect(res.data.cases[0].qualityIndex).toBe(referenceOne.quality.compositeScore);
    // The comparison is between cases: no participant, alias or person appears in it.
    expect(res.body).not.toMatch(/support engineer|customer admin|participantAlias/i);
    expect(res.data.skillReuse).toBeNull();

    const reversed = (await get(`/api/v1/compare?caseIds=${TWO},${ONE}`, PERSONAS.manager)).data;
    expect(reversed.cases.map((summary: Json) => summary.id)).toEqual([TWO, ONE]);
    const flipped = reversed.rows.find((row: Json) => row.metric === 'case_quality_index');
    expect(flipped.betterCaseId).toBe(TWO);
  });
});

// ------------------------------------------------------------------------------------------
// reviews, corrections and overrides

describe('claim review', () => {
  it('[FR-EV-03] corrects a classification, preserving the original and auditing it', async () => {
    const claims = await allClaims(ONE, 'limit=200');
    const claim = claims.find((item) => item.category === 'engineer_assumption') ?? claims[0];
    const target = claim.category === 'confirmed_fact' ? 'customer_reported' : 'confirmed_fact';
    const reason = '  Reason-token-7f3a: the customer stated this and nobody verified it  ';

    const res = await post(api(ONE, `/claims/${claim.id}/review`), {
      category: target,
      reason,
      expectedVersion: claim.version,
    });
    expect(res.statusCode, JSON.stringify(res.data)).toBe(200);
    expect(res.data.id).toBe(claim.id);
    expect(res.data.category).toBe(target);
    expect(res.data.reviewedCategory).toBe(target);
    expect(res.data.aiCategory).toBe(claim.aiCategory);
    expect(res.data.reviewState).toBe('corrected');
    expect(res.data.reviewReason).toBe(reason.trim());
    expect(res.data.reviewedBy).toBe(PERSONAS.reviewer);
    expect(res.data.version).toBe(claim.version + 1);

    // The ledger shows the correction next to the preserved machine classification.
    const stored = (await allClaims(ONE, 'limit=200')).find((item) => item.id === claim.id);
    expect(stored).toMatchObject({
      category: target,
      aiCategory: claim.aiCategory,
      reviewState: 'corrected',
    });
    const corrected = await allClaims(ONE, 'reviewState=corrected&limit=200');
    expect(corrected.map((item) => item.id)).toEqual([claim.id]);
    const counts = (await get(api(ONE, '/evidence'))).data.counts;
    expect(counts[target]).toBe(claims.filter((item) => item.category === target).length + 1);

    // The decision is a review record that keeps the machine value.
    const decisions = (await h.repos(CONTOSO).reviews.list({ caseId: ONE, limit: 50 })).items;
    const decision = decisions.find((d) => d.targetType === 'claim' && d.targetId === claim.id);
    expect(decision).toMatchObject({
      decision: 'correct',
      reason: reason.trim(),
      reviewerId: PERSONAS.reviewer,
      reviewerRole: 'reviewer',
      originalValue: { category: claim.category, aiCategory: claim.aiCategory },
      newValue: { category: target },
    });

    // The audit event is tenant-scoped, names ids, categories and versions, and holds no free text.
    const audit = (await h.repos(CONTOSO).audit.list({ action: 'claim.reviewed', limit: 20 }))
      .items;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      tenantId: CONTOSO,
      actorId: PERSONAS.reviewer,
      actorRole: 'reviewer',
      targetType: 'claim',
      targetId: claim.id,
      caseId: ONE,
      outcome: 'success',
    });
    expect(audit[0]?.details).toMatchObject({
      aiCategory: claim.aiCategory,
      fromCategory: claim.category,
      toCategory: target,
      reviewState: 'corrected',
      expectedVersion: claim.version,
      version: claim.version + 1,
    });
    expect(JSON.stringify(audit[0]?.details)).not.toContain('Reason-token-7f3a');
    expect(h.logs().some((line) => JSON.stringify(line).includes('Reason-token-7f3a'))).toBe(false);
    const foreign = await h.repos(FABRIKAM).audit.list({ action: 'claim.reviewed', limit: 20 });
    expect(foreign.items).toHaveLength(0);
    // The binder did not add a second, generic record for the same call.
    const generic = await h.repos(CONTOSO).audit.list({ action: 'api.claims.review', limit: 20 });
    expect(generic.items).toHaveLength(0);
  });

  it('[FR-EV-03] refuses a stale version with a 409 and records nothing', async () => {
    const claim = (await allClaims(ONE, 'reviewState=corrected&limit=200'))[0];
    const before = (await h.repos(CONTOSO).reviews.list({ caseId: ONE, limit: 100 })).items.length;
    const res = await post(api(ONE, `/claims/${claim.id}/review`), {
      category: 'diagnostic_evidence',
      reason: 'Using the old version of the claim',
      expectedVersion: claim.version - 1,
    });
    expect(res.statusCode).toBe(409);
    expect(res.data.code).toBe('version_conflict');
    const after = (await h.repos(CONTOSO).reviews.list({ caseId: ONE, limit: 100 })).items.length;
    expect(after).toBe(before);
    const same = (await allClaims(ONE, 'reviewState=corrected&limit=200'))[0];
    expect(same.version).toBe(claim.version);
  });

  it('[FR-EV-03] records a confirmation when the reviewer agrees with the machine classification', async () => {
    const claim = (await allClaims(ONE, 'reviewState=pending&limit=200'))[0];
    const res = await post(api(ONE, `/claims/${claim.id}/review`), {
      category: claim.aiCategory,
      reason: 'Checked against the source text',
      expectedVersion: claim.version,
    });
    expect(res.statusCode).toBe(200);
    expect(res.data.reviewState).toBe('confirmed');
    const decisions = (await h.repos(CONTOSO).reviews.list({ caseId: ONE, limit: 50 })).items;
    expect(decisions.find((item) => item.targetId === claim.id)?.decision).toBe('confirm');
  });

  it('[FR-EV-03] lays the correction over an as-of ledger with its stored version', async () => {
    const corrected = (await allClaims(ONE, 'reviewState=corrected&limit=200'))[0];
    const view = await allClaims(ONE, `asOf=${END_OF_TIME}&limit=40`);
    expect(view.find((item) => item.id === corrected.id)).toMatchObject({
      category: corrected.category,
      aiCategory: corrected.aiCategory,
      reviewState: 'corrected',
      reviewedBy: PERSONAS.reviewer,
      version: corrected.version,
    });
    expect(view.length).toBe(referenceOne.analysis.claims.length);
  });
});

describe('warning dismissal', () => {
  it('[FR-LQ-01] dismisses an open warning with a reason, version-checked and audited', async () => {
    const warning = (await get(api(OPEN, '/warnings?state=open'))).data.items[0];
    const reason = 'Reason-token-91bc: the customer confirmed the failure time by phone';
    const res = await post(
      api(OPEN, `/warnings/${warning.id}/dismiss`),
      { reason, expectedVersion: warning.version },
      PERSONAS.engineer,
    );
    expect(res.statusCode, JSON.stringify(res.data)).toBe(200);
    expect(res.data.state).toBe('dismissed');
    expect(res.data.dismissal).toMatchObject({ by: PERSONAS.engineer, reason });
    expect(res.data.version).toBe(warning.version + 1);
    expect(res.data.ruleId).toBe(warning.ruleId);

    const dismissed = (await get(api(OPEN, '/warnings?state=dismissed'))).data.items;
    expect(dismissed.map((item: Json) => item.id)).toEqual([warning.id]);
    const stillOpen = (await get(api(OPEN, '/warnings?state=open'))).data.items;
    expect(stillOpen.map((item: Json) => item.id)).not.toContain(warning.id);

    const decisions = (await h.repos(CONTOSO).reviews.list({ caseId: OPEN, limit: 50 })).items;
    expect(decisions.find((item) => item.targetType === 'warning')).toMatchObject({
      targetId: warning.id,
      decision: 'dismiss',
      reason,
      reviewerRole: 'engineer',
      originalValue: { state: 'open' },
      newValue: { state: 'dismissed' },
    });
    const audit = (await h.repos(CONTOSO).audit.list({ action: 'warning.dismissed', limit: 20 }))
      .items;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      tenantId: CONTOSO,
      actorId: PERSONAS.engineer,
      targetId: warning.id,
      caseId: OPEN,
    });
    expect(audit[0]?.details).toMatchObject({
      ruleId: warning.ruleId,
      category: warning.category,
      version: warning.version + 1,
    });
    expect(JSON.stringify(audit[0]?.details)).not.toContain('Reason-token-91bc');
    expect(h.logs().some((line) => JSON.stringify(line).includes('Reason-token-91bc'))).toBe(false);
    const foreign = await h.repos(FABRIKAM).audit.list({ action: 'warning.dismissed', limit: 20 });
    expect(foreign.items).toHaveLength(0);
  });

  it('[FR-LQ-01] refuses a stale version and a warning that is no longer open, both with 409', async () => {
    const dismissed = (await get(api(OPEN, '/warnings?state=dismissed'))).data.items[0];
    const stale = await post(
      api(OPEN, `/warnings/${dismissed.id}/dismiss`),
      { reason: 'Dismissing with an old version', expectedVersion: dismissed.version - 1 },
      PERSONAS.engineer,
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.data.code).toBe('version_conflict');
    const again = await post(
      api(OPEN, `/warnings/${dismissed.id}/dismiss`),
      { reason: 'Dismissing it a second time', expectedVersion: dismissed.version },
      PERSONAS.engineer,
    );
    expect(again.statusCode).toBe(409);
    expect(again.data.code).toBe('conflict');
    expect(again.data.detail).toBe('This warning can no longer be dismissed');
    // A warning that resolved by itself cannot be dismissed either.
    const resolved = (await get(api(ONE, '/warnings?state=resolved'))).data.items[0];
    const late = await post(
      api(ONE, `/warnings/${resolved.id}/dismiss`),
      { reason: 'Dismissing a resolved warning', expectedVersion: resolved.version },
      PERSONAS.engineer,
    );
    expect(late.statusCode).toBe(409);
    expect(late.data.code).toBe('conflict');
    expect(late.data.detail).toBe('This warning can no longer be dismissed');
  });

  it('[FR-LQ-02] answers a dismissal from an as-of list with a neutral 409 when the warning resolved since', async () => {
    // At e07 the replay shows warnings open that the finished case has long since resolved.
    const asOf = eventBySuffix(oneEvents, 'e07').timestamp;
    const open = (await get(api(ONE, `/warnings?asOf=${asOf}&state=open`))).data.items as Json[];
    expect(open.length).toBeGreaterThan(0);
    const stored = (await get(api(ONE, '/warnings?state=all'))).data.items as Json[];
    expect(stored.find((item) => item.id === open[0]?.id)?.state).toBe('resolved');

    const reviewsBefore = (await h.repos(CONTOSO).reviews.list({ caseId: ONE, limit: 200 })).items;
    const auditBefore = (
      await h.repos(CONTOSO).audit.list({ action: 'warning.dismissed', limit: 50 })
    ).items;
    const secret = 'Reason-token-d51a: the customer still cannot sign in';
    const res = await post(
      api(ONE, `/warnings/${open[0]?.id}/dismiss`),
      { reason: secret, expectedVersion: open[0]?.version },
      PERSONAS.engineer,
    );
    expect(res.statusCode).toBe(409);
    expect(res.data.code).toBe('conflict');
    // The answer is the same wherever the request came from: it does not say that the warning has
    // resolved, nor why or when, which the window this client was looking at did not know.
    expect(res.data.detail).toBe('This warning can no longer be dismissed');
    expect(res.body).not.toMatch(/resolved|resolution|only open/i);
    expect(res.body).not.toContain('Reason-token-d51a');
    // Nothing was recorded.
    expect((await h.repos(CONTOSO).reviews.list({ caseId: ONE, limit: 200 })).items).toHaveLength(
      reviewsBefore.length,
    );
    expect(
      (await h.repos(CONTOSO).audit.list({ action: 'warning.dismissed', limit: 50 })).items,
    ).toHaveLength(auditBefore.length);
  });

  it('[FR-LQ-02] lays the stored version over an as-of replay, so a dismissal from it is checked', async () => {
    const dismissed = (await get(api(OPEN, '/warnings?state=dismissed'))).data.items[0];
    const replayed = (await get(api(OPEN, `/warnings?asOf=${END_OF_TIME}`))).data.items;
    const same = replayed.find((item: Json) => item.id === dismissed.id);
    expect(same).toBeDefined();
    expect(same.version).toBe(dismissed.version);
    expect(same.createdAt).toBe(dismissed.createdAt);
  });
});

describe('action value', () => {
  it('[FR-AV-01] ranks safe candidates with the transparent calculation and its sensitivity', async () => {
    const res = await get(api(ONE, '/action-values'));
    expect(res.statusCode).toBe(200);
    expect(res.data.asOf).toBe(oneEvents[oneEvents.length - 1]?.timestamp);
    expect(res.data.formula).toMatch(/not a scientific law/i);
    expect(res.data.notice).toMatch(/safety policy/i);
    expect(res.data.configVersion).toBe(DEFAULT_ACTION_VALUE_CONFIG.version);
    const candidates = res.data.candidates as Json[];
    expect(candidates.length).toBeGreaterThan(2);
    expect(candidates.map((entry) => entry.rank)).toEqual(candidates.map((_, index) => index + 1));
    for (const entry of candidates) {
      expect(entry.safety.allowed).toBe(true);
      expect(entry.override).toBeNull();
      expect(entry.sensitivity.scenarios.length).toBeGreaterThan(0);
      expect(Object.keys(entry.normalized).sort()).toEqual([
        'confidence',
        'customer',
        'information',
        'relevance',
        'risk',
        'time',
        'token',
      ]);
    }
    const scores = candidates.map((entry) => entry.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    const blocked = res.data.blocked as Json[];
    expect(blocked.every((entry) => entry.safety.allowed === false)).toBe(true);
    expect(blocked.every((entry) => entry.safety.blockedReasons.length > 0)).toBe(true);
    const posterior = res.data.posterior as Json[];
    expect(posterior.reduce((sum, item) => sum + item.confidence, 0)).toBeCloseTo(1, 1);
    expect(posterior[0].key).toBe('hyp.dns-resolution');
  });

  it('[FR-AV-01] evaluates just before a fork decision, taking precedence over asOf', async () => {
    const forks = (await get(api(ONE, '/forks'))).data;
    const fork = forks.items.find((item: Json) => item.id === forks.earliestMeaningfulForkId);
    const res = await get(api(ONE, `/action-values?forkId=${fork.id}&asOf=2026-03-12T00:00:00Z`));
    expect(res.statusCode).toBe(200);
    expect(res.data.asOf).toBe(fork.timestamp);
    // The belief at the decision is the fork's own record of it.
    for (const entry of fork.posteriorAtDecision) {
      const served = res.data.posterior.find((item: Json) => item.key === entry.key);
      expect(served.confidence).toBeCloseTo(entry.confidence, 3);
    }
    const later = (
      await get(api(ONE, `/action-values?asOf=${eventBySuffix(oneEvents, 'e24').timestamp}`))
    ).data;
    expect(later.posterior[0].confidence).toBeGreaterThan(res.data.posterior[0].confidence);
  });

  it('[FR-AV-02] records a reviewer override next to the machine rank and audits it', async () => {
    const instant = (await get(api(ONE, '/action-values'))).data;
    const target = instant.candidates[2];
    const reason = 'Reason-token-c04d: the customer cannot run captures this week';

    const res = await post(api(ONE, '/action-values/override'), {
      asOf: instant.asOf,
      actionKey: target.actionKey,
      rank: 1,
      reason,
    });
    expect(res.statusCode, JSON.stringify(res.data)).toBe(200);
    const served = res.data.candidates.find((entry: Json) => entry.actionKey === target.actionKey);
    expect(served.override).toMatchObject({ rank: 1, reason, by: PERSONAS.reviewer });
    // The machine rank and score are preserved, and the list keeps the machine order.
    expect(served.rank).toBe(target.rank);
    expect(served.score).toBe(target.score);
    expect(res.data.candidates.map((entry: Json) => entry.actionKey)).toEqual(
      instant.candidates.map((entry: Json) => entry.actionKey),
    );
    expect(res.data.candidates.filter((entry: Json) => entry.override !== null)).toHaveLength(1);

    // It persists, and a newer decision for the same action replaces it.
    h.clock.advance(60_000);
    const second = await post(api(ONE, '/action-values/override'), {
      asOf: instant.asOf,
      actionKey: target.actionKey,
      rank: 2,
      reason: 'On reflection the second place is right',
    });
    expect(second.statusCode).toBe(200);
    const again = (await get(api(ONE, `/action-values?asOf=${instant.asOf}`))).data;
    const current = again.candidates.find((entry: Json) => entry.actionKey === target.actionKey);
    expect(current.override.rank).toBe(2);
    // Another instant is untouched.
    const elsewhere = eventBySuffix(oneEvents, 'e07').timestamp;
    const other = (await get(api(ONE, `/action-values?asOf=${elsewhere}`))).data;
    expect(other.candidates.every((entry: Json) => entry.override === null)).toBe(true);

    const reviews = (await h.repos(CONTOSO).reviews.list({ caseId: ONE, limit: 100 })).items;
    const decisions = reviews.filter((item) => item.targetType === 'action_value');
    expect(decisions).toHaveLength(2);
    // Newest first: the earlier decision keeps the machine value it replaced.
    expect(decisions[1]).toMatchObject({
      decision: 'override',
      reason,
      reviewerId: PERSONAS.reviewer,
      originalValue: { rank: target.rank },
      newValue: { rank: 1 },
    });
    const audit = (
      await h.repos(CONTOSO).audit.list({ action: 'actionvalue.overridden', limit: 20 })
    ).items;
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({
      tenantId: CONTOSO,
      actorId: PERSONAS.reviewer,
      caseId: ONE,
      targetId: target.actionKey,
    });
    expect(audit[0]?.details).toMatchObject({
      actionKey: target.actionKey,
      machineRank: target.rank,
    });
    expect(JSON.stringify(audit.map((event) => event.details))).not.toContain('Reason-token-c04d');
  });

  it('[FR-AV-03] never lets an override rank an action the safety policy blocks', async () => {
    const instant = (await get(api(ONE, '/action-values'))).data;
    const blocked = instant.blocked[0];
    expect(blocked).toBeDefined();
    const res = await post(api(ONE, '/action-values/override'), {
      asOf: instant.asOf,
      actionKey: blocked.actionKey,
      rank: 1,
      reason: 'Try to rank a blocked action',
    });
    expect(res.statusCode).toBe(422);
    expect(res.data.detail).toMatch(/safety policy/i);
    const unknown = await post(api(ONE, '/action-values/override'), {
      asOf: instant.asOf,
      actionKey: 'act.does-not-exist',
      rank: 1,
      reason: 'Try an unknown action',
    });
    expect(unknown.statusCode).toBe(422);
    const beyond = await post(api(ONE, '/action-values/override'), {
      asOf: instant.asOf,
      actionKey: instant.candidates[0].actionKey,
      rank: instant.candidates.length + 1,
      reason: 'Rank beyond the list',
    });
    expect(beyond.statusCode).toBe(422);
    const after = (await get(api(ONE, '/action-values'))).data;
    expect(after.blocked.every((entry: Json) => entry.override === null)).toBe(true);
  });
});

describe('reviewer corrections survive a forced re-analysis', () => {
  it('[FR-EV-03] keeps a corrected claim, its preserved machine value and an override', async () => {
    const before = (await allClaims(ONE, 'reviewState=corrected&limit=200'))[0];
    const runBefore = await latestRun(ONE);

    const ctx = contextFor(h, PERSONAS.engineer);
    const outcome = await h.infra.services.analysis.analyzeCase(ctx, ONE, { force: true });
    expect(outcome.reused).toBe(false);
    expect(outcome.run.id).not.toBe(runBefore.id);

    const after = (await allClaims(ONE, 'limit=200')).find((claim) => claim.id === before.id);
    expect(after).toMatchObject({
      category: before.category,
      reviewedCategory: before.reviewedCategory,
      aiCategory: before.aiCategory,
      reviewState: 'corrected',
      reviewReason: before.reviewReason,
      reviewedBy: PERSONAS.reviewer,
    });
    expect(after.version).toBe(before.version + 1);
    const corrected = await allClaims(ONE, 'reviewState=corrected&limit=200');
    expect(corrected.map((claim) => claim.id)).toEqual([before.id]);

    // Overrides are review decisions keyed by instant and action, so they survive as well, and the
    // views follow the new run: the as-of ledger carries the same correction.
    const instant = (await get(api(ONE, '/action-values'))).data;
    expect(instant.candidates.filter((entry: Json) => entry.override !== null)).toHaveLength(1);
    const view = await allClaims(ONE, `asOf=${END_OF_TIME}&limit=40`);
    expect(view.find((claim) => claim.id === before.id)).toMatchObject({
      category: before.category,
      reviewState: 'corrected',
      version: before.version + 1,
    });
    expect((await latestRun(ONE)).id).toBe(outcome.run.id);
    expect((await get(api(ONE, '/twin'))).data.analysisRunId).toBe(outcome.run.id);
    const asOfTwin = await get(api(ONE, `/twin?asOf=${END_OF_TIME}`));
    expect(asOfTwin.data.analysisRunId).toBe(outcome.run.id);
  });

  it('[FR-LQ-01] keeps a dismissed warning dismissed while its condition still fires', async () => {
    const before = (await get(api(OPEN, '/warnings?state=dismissed'))).data.items[0];
    const runBefore = await latestRun(OPEN);
    const ctx = contextFor(h, PERSONAS.engineer);
    const outcome = await h.infra.services.analysis.analyzeCase(ctx, OPEN, { force: true });
    expect(outcome.run.id).not.toBe(runBefore.id);

    const dismissed = (await get(api(OPEN, '/warnings?state=dismissed'))).data.items;
    expect(dismissed.map((warning: Json) => warning.id)).toEqual([before.id]);
    expect(dismissed[0].dismissal).toEqual(before.dismissal);
    expect(dismissed[0].version).toBe(before.version + 1);
    const open = (await get(api(OPEN, '/warnings?state=open'))).data.items;
    expect(open.map((warning: Json) => warning.id)).not.toContain(before.id);
  });

  it('[FR-TL-06] still gives the same quality for the whole record and for an instant after it', async () => {
    const stored = (await get(api(ONE, '/quality'))).data;
    const late = (await get(api(ONE, `/quality?asOf=${END_OF_TIME}`))).data;
    expect(late.compositeScore).toBe(stored.compositeScore);
    expect(late.asOf).toBe(END_OF_TIME);
  });

  it('[FR-TL-06] keeps a reviewer decision made after the window out of it, label and note alike', async () => {
    const window = eventBySuffix(oneEvents, 'e07').timestamp;
    const inWindowClaims = (await allClaims(ONE, 'reviewState=pending&limit=200')).filter(
      (item) => item.eventId !== null && Date.parse(item.timestamp) <= Date.parse(window),
    );
    expect(inWindowClaims.length).toBeGreaterThan(1);
    const [earlier, later] = [inWindowClaims[0], inWindowClaims[1]];
    const flip = (item: Json) =>
      item.aiCategory === 'confirmed_fact' ? 'customer_reported' : 'confirmed_fact';
    const visibleNote = 'Reason-token-77aa: checked against the first reply';
    const hindsightNote = 'Reason-token-5e1d: later logs showed that the resolver cache was stale';
    const windowLedger = () => allClaims(ONE, `asOf=${window}&limit=200`);
    const pristine = await windowLedger();

    // A review made before the window is part of it.
    h.clock.set('2026-02-01T00:00:00.000Z');
    const early = await post(api(ONE, `/claims/${earlier.id}/review`), {
      category: flip(earlier),
      reason: visibleNote,
      expectedVersion: earlier.version,
    });
    expect(early.statusCode, JSON.stringify(early.data)).toBe(200);
    const withEarly = await windowLedger();
    expect(withEarly.find((item) => item.id === earlier.id)).toMatchObject({
      category: flip(earlier),
      reviewState: 'corrected',
      reviewReason: visibleNote,
      reviewedBy: PERSONAS.reviewer,
    });
    const countsAfterEarly = (await get(api(ONE, `/evidence?asOf=${window}`))).data.counts;

    // A review made long after it, as a reviewer looking back at a finished case would, is not.
    h.clock.set('2026-06-01T00:00:00.000Z');
    const target = flip(later);
    const reviewed = await post(api(ONE, `/claims/${later.id}/review`), {
      category: target,
      reason: hindsightNote,
      expectedVersion: later.version,
    });
    expect(reviewed.statusCode, JSON.stringify(reviewed.data)).toBe(200);

    // The window is exactly what it was before that review: the machine classification, still
    // pending, no note, no reviewer, no later timestamp. Only the version (for the lock) moved.
    const afterwards = await windowLedger();
    expect(afterwards).toEqual(
      withEarly.map((item) =>
        item.id === later.id ? { ...item, version: reviewed.data.version } : item,
      ),
    );
    const seen = afterwards.find((item) => item.id === later.id);
    expect(seen).toMatchObject({
      reviewState: 'pending',
      reviewedCategory: null,
      reviewReason: null,
      reviewedBy: null,
      reviewedAt: null,
      version: later.version + 1,
    });
    expect(seen.category).toBe(seen.aiCategory);
    const pending = pristine.find((item) => item.id === later.id);
    expect(seen).toEqual({ ...pending, version: later.version + 1 });

    // Counts, filters, the event detail and the timeline follow the same rule.
    const countsOf = async () => (await get(api(ONE, `/evidence?asOf=${window}`))).data.counts;
    expect(await countsOf()).toEqual(countsAfterEarly);
    const byCategory = await allClaims(ONE, `asOf=${window}&category=${seen.aiCategory}&limit=200`);
    expect(byCategory.map((item) => item.id)).toContain(later.id);
    const corrected = await allClaims(ONE, `asOf=${window}&reviewState=corrected&limit=200`);
    expect(corrected.map((item) => item.id)).toContain(earlier.id);
    expect(corrected.map((item) => item.id)).not.toContain(later.id);
    const detail = (await get(api(ONE, `/events/${later.eventId}?asOf=${window}`))).data;
    expect(detail.claims.find((item: Json) => item.id === later.id)).toMatchObject({
      reviewState: 'pending',
      reviewReason: null,
      reviewedBy: null,
    });
    const timeline = (await get(api(ONE, `/timeline?asOf=${window}&limit=200`))).data;
    for (const body of [afterwards, detail, timeline]) {
      const text = JSON.stringify(body);
      expect(text).not.toContain('Reason-token-5e1d');
      expect(text).not.toContain('2026-06-01');
    }

    // From the review onwards, and in the whole record, the decision is part of the view.
    for (const view of [
      await allClaims(ONE, `asOf=${END_OF_TIME}&limit=200`),
      await allClaims(ONE, 'limit=200'),
    ]) {
      expect(view.find((item) => item.id === later.id)).toMatchObject({
        category: target,
        reviewState: 'corrected',
        reviewReason: hindsightNote,
        reviewedBy: PERSONAS.reviewer,
      });
    }
  });

  it('[FR-AV-02] shows an override inside a window only once it was decided, and the whole record the latest', async () => {
    const last = eventBySuffix(oneEvents, 'e31').timestamp;
    const ranked = (await get(api(ONE, '/action-values'))).data;
    // The whole-record ranking is the ranking at the last event.
    expect(ranked.asOf).toBe(last);
    expect(ranked.candidates.length).toBeGreaterThan(3);
    const target = ranked.candidates[3];
    const decide = async (rank: number, reason: string) => {
      const res = await post(api(ONE, '/action-values/override'), {
        asOf: last,
        actionKey: target.actionKey,
        rank,
        reason,
      });
      expect(res.statusCode, JSON.stringify(res.data)).toBe(200);
      return res.data.candidates.find((entry: Json) => entry.actionKey === target.actionKey)
        .override;
    };
    const overrideAt = async (path: string) => {
      const res = (await get(api(ONE, `/action-values${path}`))).data;
      return res.candidates.find((entry: Json) => entry.actionKey === target.actionKey).override;
    };

    // Decided while the case was still running: part of the window.
    h.clock.set(new Date(Date.parse(last) - 3_600_000).toISOString());
    const first = await decide(2, 'Reason-token-1c3d: the customer cannot run captures this week');
    expect(first).toMatchObject({ rank: 2, by: PERSONAS.reviewer });
    // Decided long after the window, with hindsight.
    h.clock.set('2026-07-01T00:00:00.000Z');
    const hindsight =
      'Reason-token-9e7f: the resolver query would have found the root cause on day one';
    expect(await decide(1, hindsight)).toMatchObject({ rank: 1, reason: hindsight });

    // The whole record shows the latest decision.
    expect(await overrideAt('')).toMatchObject({
      rank: 1,
      reason: hindsight,
      by: PERSONAS.reviewer,
    });
    // The window ending at that instant shows the latest decision made by then, and nothing of the
    // later one: not its reason, not its rank, not who made it or when.
    const windowed = await overrideAt(`?asOf=${last}`);
    expect(windowed).toMatchObject({ rank: 2, by: PERSONAS.reviewer, at: first.at });
    expect(Date.parse(windowed.at)).toBeLessThanOrEqual(Date.parse(last));
    const body = (await get(api(ONE, `/action-values?asOf=${last}`))).body;
    for (const text of [hindsight, 'Reason-token-9e7f', '2026-07-01']) {
      expect(body).not.toContain(text);
    }
    // The same instant spelled with milliseconds is the same window.
    expect(await overrideAt(`?asOf=${last.replace('Z', '.000Z')}`)).toMatchObject({ rank: 2 });
    // Another instant has no decision of its own.
    const instant = eventBySuffix(oneEvents, 'e30').timestamp;
    const otherInstant = (await get(api(ONE, `/action-values?asOf=${instant}`))).data;
    expect(otherInstant.candidates.every((entry: Json) => entry.override === null)).toBe(true);
  });

  it('[FR-AV-02] keeps an override made after a fork out of the ranking at that fork', async () => {
    const fork = (await get(api(ONE, '/forks'))).data.items.find(
      (item: Json) => item.isEarliestMeaningful,
    );
    const ranked = (await get(api(ONE, `/action-values?asOf=${fork.timestamp}`))).data;
    const target = ranked.candidates[0];
    h.clock.set('2026-07-02T00:00:00.000Z');
    const secret = 'Reason-token-4b2a: we should have captured the resolver cache at once';
    const res = await post(api(ONE, '/action-values/override'), {
      asOf: fork.timestamp,
      actionKey: target.actionKey,
      rank: 1,
      reason: secret,
    });
    expect(res.statusCode, JSON.stringify(res.data)).toBe(200);
    for (const path of [`?forkId=${fork.id}`, `?asOf=${fork.timestamp}`]) {
      const view = await get(api(ONE, `/action-values${path}`));
      expect(view.data.asOf).toBe(fork.timestamp);
      expect(view.data.candidates.every((entry: Json) => entry.override === null)).toBe(true);
      expect(view.body).not.toContain('Reason-token-4b2a');
      expect(view.body).not.toContain('2026-07-02');
    }
  });
});
