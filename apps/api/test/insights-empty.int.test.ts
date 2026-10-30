import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AnalyticsOverviewSchema,
  CommandCenterSchema,
  EfficiencyOverviewSchema,
  METRIC_KEYS,
} from '@caseguard/schemas';
import type { Database } from '../src/db';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS } from '../src/db/testing';
import { PERSONAS, createHarness, openSharedDatabase, type Harness } from './support/app-harness';
import { apiOf, completedSteps, demoState, type TestApi } from './insights-support';

/*
 * The insight routes over HTTP with the real handlers on an empty tenant (every answer valid, honest
 * and empty), who may read what, and which malformed requests are refused.
 */

let database: Database;
let h: Harness;
let api: TestApi;

beforeAll(async () => {
  database = await openSharedDatabase();
  h = await createHarness({ database });
  api = apiOf(h);
}, TEST_DATABASE_STARTUP_TIMEOUT_MS);

afterAll(async () => {
  await h.close();
  await database.close();
});

const ALL_ROLES = [
  PERSONAS.engineer,
  PERSONAS.reviewer,
  PERSONAS.manager,
  PERSONAS.curator,
  PERSONAS.admin,
];
const READ_ROUTES: readonly { url: string; allowed: readonly string[] }[] = [
  { url: '/command-center', allowed: ALL_ROLES },
  {
    url: '/efficiency/overview',
    allowed: [PERSONAS.engineer, PERSONAS.reviewer, PERSONAS.manager, PERSONAS.admin],
  },
  {
    url: '/model-executions',
    allowed: [PERSONAS.engineer, PERSONAS.reviewer, PERSONAS.manager, PERSONAS.admin],
  },
  { url: '/analytics/overview', allowed: [PERSONAS.manager, PERSONAS.admin] },
  { url: '/demo/state', allowed: ALL_ROLES },
];

describe('[FR-INS-01] an empty tenant', () => {
  it('answers the command center with seven "not available" cards and where to start', async () => {
    const res = await api.get(PERSONAS.engineer, '/command-center');
    expect(res.statusCode).toBe(200);
    const center = CommandCenterSchema.parse(res.data);
    expect(center).toMatchObject({
      activeCase: null,
      leadingHypothesis: null,
      skillMatch: null,
      recentCases: [],
      openWarnings: [],
      criticalMissingEvidence: [],
      skillCandidates: [],
    });
    expect(center.metrics.map((card) => card.key)).toEqual([...METRIC_KEYS]);
    for (const card of center.metrics)
      expect(card).toMatchObject({
        value: null,
        status: 'unknown',
        estimated: true,
        trend: null,
        caseId: null,
      });
    expect(center.systemHealth).toMatchObject({
      status: 'healthy',
      unhealthy: 0,
      providerKind: 'deterministic',
      providerSimulated: true,
    });
    expect(center.notices.join(' ')).toMatch(/no cases yet/i);
  });

  it('answers efficiency, executions and analytics with zeros, empty lists and notes, never an error', async () => {
    const overview = EfficiencyOverviewSchema.parse(
      (await api.get(PERSONAS.manager, '/efficiency/overview')).data,
    );
    expect(overview.totals).toMatchObject({
      executions: 0,
      totalTokens: 0,
      estimatedCostUsd: null,
    });
    expect(overview).toMatchObject({ byAgent: [], byModel: [], circuitBreakers: [] });
    expect(overview.budgets).toMatchObject({
      perCaseMaxTokens: null,
      perDayMaxTokens: null,
      consumedToday: 0,
    });
    expect(overview.labels).toEqual({ simulated: true, estimated: true });
    expect(overview.notes.join(' ')).toMatch(/no model execution has been recorded/i);

    const executions = await api.get(PERSONAS.manager, '/model-executions');
    expect(executions.statusCode).toBe(200);
    expect(executions.data).toMatchObject({ items: [], nextCursor: null });

    const analytics = AnalyticsOverviewSchema.parse(
      (await api.get(PERSONAS.manager, '/analytics/overview')).data,
    );
    expect(analytics.cohort).toMatchObject({ caseCount: 0, analyzedCaseCount: 0 });
    expect(analytics.responsibleUseNotice.length).toBeGreaterThan(20);
  });

  it('shows all 13 story steps incomplete with the first as the next action', async () => {
    const guide = await demoState(api, PERSONAS.manager);
    expect(guide.steps).toHaveLength(13);
    expect(completedSteps(guide)).toEqual([]);
    expect(guide).toMatchObject({
      seededAt: null,
      caseOneId: null,
      caseTwoId: null,
      skillId: null,
      provider: 'deterministic',
      providerSimulated: true,
    });
    expect(guide.steps.filter((step) => step.isNextAction).map((step) => step.order)).toEqual([1]);
  });

  it('treats an unknown case id as no case instead of failing (a page may remember a deleted case)', async () => {
    const center = await api.get(PERSONAS.engineer, '/command-center?caseId=case_does_not_exist');
    expect(center.statusCode).toBe(200);
    expect(center.data.activeCase).toBeNull();
    const efficiency = await api.get(
      PERSONAS.engineer,
      '/efficiency/overview?caseId=case_does_not_exist',
    );
    expect(efficiency.statusCode).toBe(200);
    expect(efficiency.data.notes[0]).toMatch(/requested case was not found/i);
  });
});

describe('[FR-INS-02] who may read what, and what is refused', () => {
  it.each(READ_ROUTES)(
    '$url: permissions come from the contract and anonymous callers get a 401',
    async ({ url, allowed }) => {
      expect((await api.get(null, url)).statusCode).toBe(401);
      for (const persona of ALL_ROLES) {
        const res = await api.get(persona, url);
        expect(res.statusCode, `${persona} ${url}`).toBe(allowed.includes(persona) ? 200 : 403);
      }
    },
  );

  it('rejects malformed ids, page sizes and agents with a 422', async () => {
    for (const url of [
      '/command-center?caseId=../etc',
      '/efficiency/overview?caseId=a%20b',
      '/model-executions?limit=0',
      '/model-executions?limit=1000',
      '/model-executions?agent=not_an_agent',
    ]) {
      const res = await api.get(PERSONAS.manager, url);
      expect(res.statusCode, url).toBe(422);
    }
  });
});
