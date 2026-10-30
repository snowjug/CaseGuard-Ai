import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommandCenterSchema,
  METRIC_KEYS,
  type CaseWarning,
  type MissingEvidence,
} from '@caseguard/schemas';
import type { Database } from '../src/db';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS } from '../src/db/testing';
import { LIST_LIMITS } from '../src/services/dashboard/picks';
import { STORY_STAGES } from '../src/services/demo/story';
import {
  at,
  buildIngestInput,
  buildMissingEvidence,
  buildSnapshot,
  buildWarning,
} from './builders';
import {
  CONTOSO,
  FABRIKAM,
  PERSONAS,
  createHarness,
  openSharedDatabase,
  type Harness,
  type Json,
} from './support/app-harness';
import {
  STORY_TIMEOUT_MS,
  allAudit,
  apiOf,
  completedSteps,
  seedPortfolio,
  type TestApi,
} from './insights-support';

/*
 * The command center over HTTP with the real handler, after the portfolio story was played through
 * `demo.seed` by the story's personas, and from a stored analysis for the lists the story leaves empty.
 * Numbers are compared with what the engine stored, never with constants the engine could change.
 */

let database: Database;
let h: Harness;
let api: TestApi;
let caseOneId = '';
let caseTwoId = '';
let skillId = '';

beforeAll(async () => {
  database = await openSharedDatabase();
  h = await createHarness({ database });
  api = apiOf(h);
}, TEST_DATABASE_STARTUP_TIMEOUT_MS);

afterAll(async () => {
  await h.close();
  await database.close();
});

describe('[FR-INS-03] after the portfolio story was played as its personas', () => {
  it(
    'seeds through the route in one demo_seed job, with every step done',
    { timeout: STORY_TIMEOUT_MS },
    async () => {
      const story = await seedPortfolio(h, api);
      ({ caseOneId, caseTwoId, skillId } = story);
      const { state } = story;
      expect(completedSteps(state)).toEqual(state.steps.map((step) => step.order));
      expect(state.steps.filter((step) => step.isNextAction).map((step) => step.id)).toEqual([
        'compare-outcomes',
      ]);
      expect(state.seededAt).not.toBeNull();
      expect(state.notices.join(' ')).toMatch(/synthetic.*deterministic offline engine.*Azure/is);

      const jobs = await api.get(PERSONAS.engineer, '/jobs?kind=demo_seed');
      expect(jobs.data.items).toHaveLength(1);
      const [job] = jobs.data.items as Json[];
      expect(job).toMatchObject({
        kind: 'demo_seed',
        status: 'succeeded',
        cancellable: false,
        caseId: null,
        createdBy: PERSONAS.admin,
      });
      expect((job.progress.stages as Json[]).map((stage) => stage.id as string)).toEqual(
        STORY_STAGES.map((stage) => stage.id),
      );
      expect((job.progress.stages as Json[]).every((stage) => stage.status === 'done')).toBe(true);
    },
  );

  it('did every step as the persona it names, with four-eyes on the skill', async () => {
    const audit = await allAudit(h);
    const actors = (action: string): string[] =>
      audit.filter((event) => event.action === action).map((event) => event.actorId);
    expect(actors('case.ingested')).toEqual([PERSONAS.engineer, PERSONAS.engineer]);
    expect(actors('counterfactual.reviewed')).toEqual([PERSONAS.reviewer]);
    expect(actors('skill.extracted')).toEqual([PERSONAS.engineer]);
    expect(actors('skill.published')).toEqual([PERSONAS.admin]);
    expect(actors('skill.applied')).toEqual([PERSONAS.engineer]);

    const skill = await h.repos(CONTOSO).skills.get(skillId);
    const approvals = await h.repos(CONTOSO).skills.listApprovals(skillId);
    const by = (toState: string) =>
      approvals.find((a) => a.toState === toState && a.decision === 'approved')?.approver;
    expect(skill).toMatchObject({
      lifecycle: 'published',
      createdBy: PERSONAS.engineer,
      hasProposedMutation: true,
    });
    expect([by('expert_reviewed'), by('pilot'), by('published')]).toEqual([
      PERSONAS.reviewer,
      PERSONAS.curator,
      PERSONAS.admin,
    ]);
    expect(new Set([skill?.createdBy, by('pilot'), by('published')]).size).toBe(3);

    // Case Two also taught the skill, but the refinement is only a proposal until someone else approves it.
    const detail = await api.get(PERSONAS.engineer, `/skills/${skillId}`);
    expect(detail.data.currentVersion).toMatchObject({ state: 'active' });
    expect(detail.data.proposedVersion).toMatchObject({
      state: 'proposed',
      changeType: 'mutation',
      parentVersionId: detail.data.currentVersion.id,
    });
    expect(detail.data.skill.lifecycle).toBe('published');
  });

  it('shows Case Two by default, every card from its stored estimate, with trends against Case One', async () => {
    const res = await api.get(PERSONAS.manager, '/command-center');
    expect(res.statusCode).toBe(200);
    const center = CommandCenterSchema.parse(res.data);
    expect(center.activeCase?.id).toBe(caseTwoId);
    expect(center.recentCases.map((c) => c.id)).toEqual([caseTwoId, caseOneId]);

    const two = await h.repos(CONTOSO).analysis.listMetrics(caseTwoId);
    const one = await h.repos(CONTOSO).analysis.listMetrics(caseOneId);
    expect(center.metrics.map((card) => card.key)).toEqual([...METRIC_KEYS]);
    for (const card of center.metrics) {
      const own = two.find((estimate) => estimate.key === card.key);
      const earlier = one.find((estimate) => estimate.key === card.key);
      expect(card, card.key).toMatchObject({
        value: own?.value,
        status: own?.status,
        estimated: true,
        synthetic: true,
        caseId: caseTwoId,
        definition: own?.definition,
      });
      expect(card.evidenceLink?.href, card.key).toContain(caseTwoId);
      const earlierValue = earlier?.value ?? null;
      if (card.value !== null && earlierValue !== null) {
        expect(card.trend?.delta, card.key).toBeCloseTo(card.value - earlierValue, 2);
        expect(card.trend?.label, card.key).toContain('CG-SYN-1001');
      } else {
        expect(card.trend, card.key).toBeNull();
      }
    }
    expect(center.metrics.some((card) => card.trend !== null)).toBe(true);
    const cqi = (metrics: typeof two) =>
      metrics.find((e) => e.key === 'case_quality_index')?.value ?? 0;
    expect(cqi(two) - cqi(one)).toBeGreaterThan(30);

    const [match] = await h.repos(CONTOSO).skills.listMatchesForCase(caseTwoId);
    expect(center.skillMatch).toEqual({
      skillId,
      name: match?.skillName,
      version: match?.skillVersion,
      score: match?.score,
      applicability: 'applies',
      caseId: caseTwoId,
    });
    expect(center.skillCandidates).toEqual([]);
    expect(center.systemHealth).toMatchObject({
      status: 'healthy',
      providerKind: 'deterministic',
      providerSimulated: true,
    });
    expect(center.notices.join(' ')).toMatch(/CG-SYN-1001.*only 2 analysed case/i);
  });

  it('shows Case One on request: no trend for the oldest case, its own warnings and missing evidence', async () => {
    const res = await api.get(PERSONAS.engineer, `/command-center?caseId=${caseOneId}`);
    const center = CommandCenterSchema.parse(res.data);
    expect(center.activeCase?.id).toBe(caseOneId);
    expect(center.metrics.every((card) => card.trend === null && card.caseId === caseOneId)).toBe(
      true,
    );
    expect(center.skillMatch).toBeNull();

    const repos = h.repos(CONTOSO).analysis;
    // The finished story case ends with its warnings resolved, so the lists are compared with what was
    // stored for it (the fixture test below proves the non-empty paths).
    const open = await repos.listWarnings(caseOneId, { state: 'open' });
    expect(center.openWarnings.length).toBe(Math.min(open.length, LIST_LIMITS.warnings));
    expect(center.openWarnings.every((w) => w.state === 'open' && w.caseId === caseOneId)).toBe(
      true,
    );
    expect(center.activeCase?.openWarningCount).toBe(open.length);
    const missing = await repos.listMissing(caseOneId);
    const critical = missing.filter((m) => m.criticality === 'critical' && m.resolvedAt === null);
    expect(center.criticalMissingEvidence.map((m) => m.id).sort()).toEqual(
      critical
        .slice(0, LIST_LIMITS.missing)
        .map((m) => m.id)
        .sort(),
    );
    expect(center.criticalMissingEvidence.every((m) => m.caseId === caseOneId)).toBe(true);

    const [leader] = [...(await repos.listHypotheses(caseOneId))].sort(
      (a, b) => b.currentConfidence - a.currentConfidence,
    );
    expect(center.leadingHypothesis).toMatchObject({
      hypothesisId: leader?.id,
      confidence: leader?.currentConfidence,
      caseId: caseOneId,
    });
    const stored = await repos.listMetrics(caseOneId);
    for (const card of center.metrics) {
      expect(card.value, card.key).toBe(stored.find((e) => e.key === card.key)?.value ?? null);
    }
  });

  it('tells the story the demo promises, from what the engine stored', async () => {
    const analysis = h.repos(CONTOSO).analysis;
    const value = async (caseId: string, key: string): Promise<number | null> =>
      (await analysis.listMetrics(caseId)).find((estimate) => estimate.key === key)?.value ?? null;
    // The demo script's figures (quality about 36 then 99, about 60% avoidable effort, 9 forks then none),
    // with room for the engine to move a little without silently breaking the story.
    expect((await analysis.listForks(caseOneId)).length).toBeGreaterThanOrEqual(5);
    expect(await analysis.listForks(caseTwoId)).toEqual([]);
    expect(await value(caseOneId, 'case_quality_index')).toBeLessThan(50);
    expect(await value(caseTwoId, 'case_quality_index')).toBeGreaterThan(85);
    expect(await value(caseOneId, 'avoidable_support_effort')).toBeGreaterThan(40);
    expect(await value(caseOneId, 'avoidable_support_effort')).toBeLessThan(80);
  });
});

describe('[FR-INS-04] warnings and missing evidence from a stored analysis', () => {
  // The finished story has no open warning left, so a stored fixture (a case of the other tenant)
  // proves what the story cannot: the engine's rank order, the limit, and unresolved critical evidence only.
  const CASE_ID = 'case_fixture_open_warnings';
  const RANKS = [7, 3, 10, 1, 5, 9, 2, 8, 4, 6];
  const warning = (rank: number, state: CaseWarning['state']): CaseWarning =>
    buildWarning({
      tenantId: FABRIKAM,
      caseId: CASE_ID,
      id: `warn_fixture_${rank}`,
      ruleId: `rule.fixture-${rank}`,
      fingerprint: `fp.fixture.${rank}`,
      title: `Fixture warning ${rank}`,
      rank,
      state,
      ...(state === 'resolved'
        ? { resolvedAt: at(40), resolvedReason: 'Resolved in the fixture' }
        : {}),
    });
  const missing = (name: string, criticality: MissingEvidence['criticality'], resolved: boolean) =>
    buildMissingEvidence({
      id: `miss_fixture_${name}`,
      requirementId: `req.fixture.${name}`,
      label: `Fixture evidence ${name}`,
      criticality,
      resolvedAt: resolved ? at(50) : null,
    });

  it('lists the open warnings in the engine’s rank order, at most eight, and only unresolved critical evidence', async () => {
    const input = buildIngestInput({ tenantId: FABRIKAM, caseId: CASE_ID });
    const repos = h.repos(FABRIKAM);
    await repos.cases.ingest(input);
    await repos.analysis.saveSnapshot({
      ...buildSnapshot(input, {
        warnings: [...RANKS.map((rank) => warning(rank, 'open')), warning(11, 'resolved')],
      }),
      missing: [
        missing('logs', 'critical', false),
        missing('scope', 'critical', false),
        missing('done', 'critical', true),
        missing('minor', 'important', false),
      ],
    });

    const center = CommandCenterSchema.parse(
      (await api.get(PERSONAS.otherTenantEngineer, '/command-center')).data,
    );
    expect(center.activeCase).toMatchObject({ id: CASE_ID, openWarningCount: RANKS.length });
    expect(center.openWarnings.map((w) => w.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(center.openWarnings.every((w) => w.state === 'open' && w.caseId === CASE_ID)).toBe(true);
    expect(center.criticalMissingEvidence.map((m) => m.id).sort()).toEqual([
      'miss_fixture_logs',
      'miss_fixture_scope',
    ]);
    expect(center.criticalMissingEvidence.every((m) => m.caseId === CASE_ID)).toBe(true);
  });

  it('keeps that case out of the answers of the tenant that does not own it', async () => {
    for (const url of ['/command-center', `/command-center?caseId=${CASE_ID}`]) {
      const res = await api.get(PERSONAS.engineer, url);
      expect(res.statusCode, url).toBe(200);
      expect(res.data.activeCase.id, url).toBe(caseTwoId);
      expect(JSON.stringify(res.data), url).not.toMatch(/case_fixture|warn_fixture|miss_fixture/);
    }
  });
});
