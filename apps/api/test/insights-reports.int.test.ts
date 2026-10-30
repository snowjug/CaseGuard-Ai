import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AnalyticsOverviewSchema,
  EfficiencyOverviewSchema,
  ModelExecutionWithUsageSchema,
} from '@caseguard/schemas';
import type { Database } from '../src/db';
import { getAnalyticsOverview } from '../src/services/analytics';
import { caseProcessOf, tokenProcessOf, type TokenProcess } from '../src/services/efficiency';
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
import {
  STORY_TIMEOUT_MS,
  allAudit,
  apiOf,
  demoState,
  seedPortfolio,
  type SeededStory,
  type TestApi,
} from './insights-support';

/*
 * Efficiency, executions and analytics over HTTP with the real handlers, after the portfolio story was
 * played through `demo.seed`: what they report is compared with what the services stored, the other
 * tenant never appears, a second seed changes nothing, and neither logs nor audit details carry case text.
 */

let database: Database;
let h: Harness;
let api: TestApi;
let story: SeededStory;

beforeAll(async () => {
  database = await openSharedDatabase();
  h = await createHarness({ database });
  api = apiOf(h);
  story = await seedPortfolio(h, api);
}, STORY_TIMEOUT_MS);

afterAll(async () => {
  await h.close();
  await database.close();
});

describe('[FR-INS-05] efficiency, executions and analytics after the portfolio story', () => {
  it('reports efficiency from what the AI service recorded, consistent with the execution list', async () => {
    const overview = EfficiencyOverviewSchema.parse(
      (await api.get(PERSONAS.manager, '/efficiency/overview')).data,
    );
    const items: Json[] = [];
    let cursor = '';
    do {
      const page = await api.get(PERSONAS.manager, `/model-executions?limit=50${cursor}`);
      items.push(...page.data.items);
      cursor =
        page.data.nextCursor === null ? '' : `&cursor=${encodeURIComponent(page.data.nextCursor)}`;
    } while (cursor !== '');
    for (const item of items)
      expect(ModelExecutionWithUsageSchema.safeParse(item).success).toBe(true);

    const sum = (pick: (item: Json) => number): number =>
      items.reduce<number>((total, item) => total + pick(item), 0);
    expect(items.length).toBeGreaterThan(5);
    expect(overview.totals.executions).toBe(items.length);
    expect(overview.totals.promptTokens).toBe(sum((i) => Number(i.usage?.promptTokens ?? 0)));
    expect(overview.totals.completionTokens).toBe(
      sum((i) => Number(i.usage?.completionTokens ?? 0)),
    );
    expect(overview.byAgent.reduce((total, agent) => total + agent.executions, 0)).toBe(
      items.length,
    );
    expect(overview.byModel.reduce((total, model) => total + model.executions, 0)).toBe(
      items.length,
    );
    expect(overview.labels).toEqual({ simulated: true, estimated: true });
    expect(overview.budgets).toMatchObject({
      perCaseMaxTokens: null,
      perDayMaxTokens: null,
      consumedToday: overview.totals.totalTokens,
    });
    expect(overview.circuitBreakers).toEqual([]);
    expect(overview.totals.estimatedCostUsd).toBeNull();
    expect(overview.notes.join(' ')).toMatch(/simulated/i);

    const parts = (
      await Promise.all(
        [story.caseOneId, story.caseTwoId].map((id) => h.repos(CONTOSO).analysis.listMetrics(id)),
      )
    ).map(tokenProcessOf);
    expect(overview.caseProcess).toEqual(
      caseProcessOf(
        null,
        parts.filter((part): part is TokenProcess => part !== null),
      ),
    );
    expect(overview.caseProcess.caseId).toBeNull();
  });

  it('scopes efficiency and executions to one case, and filters executions by agent', async () => {
    const { caseOneId } = story;
    const one = EfficiencyOverviewSchema.parse(
      (await api.get(PERSONAS.engineer, `/efficiency/overview?caseId=${caseOneId}`)).data,
    );
    const listed = await api.get(
      PERSONAS.engineer,
      `/model-executions?caseId=${caseOneId}&limit=200`,
    );
    expect(one.totals.executions).toBe(listed.data.items.length);
    expect(listed.data.items.every((item: Json) => item.caseId === caseOneId)).toBe(true);
    expect(one.caseProcess.caseId).toBe(caseOneId);

    const agent = one.byAgent[0]?.agent ?? 'timeline_analyzer';
    const byAgent = await api.get(PERSONAS.engineer, `/model-executions?agent=${agent}&limit=200`);
    expect(byAgent.data.items.length).toBeGreaterThan(0);
    expect(byAgent.data.items.every((item: Json) => item.agent === agent)).toBe(true);

    const first = await api.get(PERSONAS.engineer, '/model-executions?limit=2');
    expect(first.data.items).toHaveLength(2);
    expect(first.data.nextCursor).not.toBeNull();
    const second = await api.get(
      PERSONAS.engineer,
      `/model-executions?limit=2&cursor=${encodeURIComponent(first.data.nextCursor)}`,
    );
    expect((second.data.items as Json[]).map((i) => i.id as string)).not.toEqual(
      expect.arrayContaining((first.data.items as Json[]).map((i) => i.id as string)),
    );
  });

  it('aggregates analytics for two synthetic cases, shows the thin cohort and names no person', async () => {
    const res = await api.get(PERSONAS.manager, '/analytics/overview');
    const analytics = AnalyticsOverviewSchema.parse(res.data);
    expect(analytics.cohort).toMatchObject({
      caseCount: 2,
      analyzedCaseCount: 2,
      syntheticCaseCount: 2,
    });
    expect(analytics.cohort.note).toMatch(/n=2/);

    const forks = (
      await Promise.all(
        [story.caseOneId, story.caseTwoId].map((id) => h.repos(CONTOSO).analysis.listForks(id)),
      )
    ).flat();
    expect(forks.length).toBeGreaterThanOrEqual(3);
    expect(analytics.forkCategories.reduce((sum, row) => sum + row.count, 0)).toBe(forks.length);
    expect(analytics.forkCategories.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(1, 1);
    expect(analytics.skillAdoption).toEqual({
      totalSkills: 1,
      published: 1,
      pilotOrValidated: 0,
      matchedCases: 1,
      appliedCases: 1,
    });
    expect(
      analytics.skillEffectiveness.map((s) => [s.skillId, s.applications, s.synthetic]),
    ).toEqual([[story.skillId, 1, true]]);
    expect(analytics.counterfactualAcceptance).toMatchObject({
      reviewed: 1,
      accepted: 1,
      rejected: 0,
      rate: 1,
    });
    expect(analytics.reviewerDisagreement).toMatchObject({ reviewedClaims: 0, rate: null });
    expect(analytics.qualityTrend.reduce((sum, row) => sum + row.caseCount, 0)).toBe(2);

    const text = JSON.stringify(res.data);
    expect(text).not.toMatch(/user_[a-z_]+/);
    expect(text).not.toMatch(/\(synthetic\)|@/);
    expect(text).not.toContain('Pune and Leeds');
  });
});

describe('[FR-INS-06] isolation, idempotency and privacy of the seeded workspace', () => {
  it('keeps the other tenant out of every answer', async () => {
    const { caseOneId, caseTwoId, skillId } = story;
    const eve = PERSONAS.otherTenantEngineer;
    const center = await api.get(eve, `/command-center?caseId=${caseOneId}`);
    expect(center.statusCode).toBe(200);
    expect(center.data).toMatchObject({
      activeCase: null,
      recentCases: [],
      skillMatch: null,
      leadingHypothesis: null,
    });
    const everything = JSON.stringify([
      center.data,
      (await api.get(eve, '/efficiency/overview')).data,
      (await api.get(eve, '/model-executions')).data,
    ]);
    for (const secret of [caseOneId, caseTwoId, skillId, 'CG-SYN-1001', 'CG-SYN-1002'])
      expect(everything).not.toContain(secret);
    expect(
      (await api.get(eve, `/efficiency/overview?caseId=${caseOneId}`)).data.totals.executions,
    ).toBe(0);
    expect((await api.get(eve, `/model-executions?caseId=${caseOneId}`)).data.items).toEqual([]);
    expect(await demoState(api, eve)).toMatchObject({
      caseOneId: null,
      caseTwoId: null,
      skillId: null,
      seededAt: null,
    });
    expect((await getAnalyticsOverview(contextFor(h, eve))).cohort.caseCount).toBe(0);
    expect((await h.repos(FABRIKAM).cases.counts()).total).toBe(0);
  });

  it('is a no-op the second time: same state, no new job, no new data, one more audit event', async () => {
    const before = await demoState(api);
    const jobs = (await h.repos(CONTOSO).jobs.list({ kind: 'demo_seed', limit: 10 })).items.length;
    const res = await api.post(PERSONAS.admin, '/demo/seed', { profile: 'portfolio' });
    expect(res.statusCode).toBe(200);
    expect(await demoState(api)).toEqual(before);
    expect((await h.repos(CONTOSO).cases.counts()).total).toBe(2);
    expect((await h.repos(CONTOSO).skills.list({ limit: 10 })).items).toHaveLength(1);
    expect((await h.repos(CONTOSO).jobs.list({ kind: 'demo_seed', limit: 10 })).items).toHaveLength(
      jobs,
    );

    const seeds = (await allAudit(h))
      .filter((event) => event.action === 'demo.seed')
      .sort((a, b) => a.sequence - b.sequence);
    expect(seeds.map((event) => event.outcome)).toEqual(['success', 'success']);
    expect(seeds[1]?.details).toEqual({ profile: 'portfolio', noop: true, completedSteps: 13 });
    expect(Object.keys(seeds[0]?.details ?? {}).sort()).toEqual([
      'caseOneId',
      'caseTwoId',
      'jobId',
      'performed',
      'profile',
      'skillId',
      'skipped',
    ]);
  });

  it('never put case text or a person’s words in the logs or the audit details, and kept the chain intact', async () => {
    const logs = JSON.stringify(h.logs());
    for (const phrase of [
      'Pune and Leeds',
      'Could you please',
      'The path is realistic',
      'Adopted for review',
    ])
      expect(logs).not.toContain(phrase);
    const details = JSON.stringify((await allAudit(h)).map((event) => event.details));
    for (const phrase of ['Pune and Leeds', 'The path is realistic', 'Approved after the pilot'])
      expect(details).not.toContain(phrase);
    expect((await h.repos(CONTOSO).audit.verify()).valid).toBe(true);
  });
});
