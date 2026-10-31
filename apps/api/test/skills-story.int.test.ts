/* eslint-disable @typescript-eslint/no-unsafe-return -- response bodies are parsed JSON, typed `Json` by the harness */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CONFORMANCE_HIGH,
  buildGuidedPlan,
  checkConformance,
  createFullView,
  createTemporalView,
  estimateSkillImpact,
  getCompiledPack,
  impactPrecedentOf,
  matchSkills,
  runDeterministicAnalysis,
  toMatchConformance,
  type EngineContext,
  type SkillImpactEstimate,
} from '@caseguard/domain';
import { DEFAULT_ACTION_VALUE_CONFIG } from '@caseguard/schemas';
import type { Database } from '../src/db';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS } from '../src/db/testing';
import { SkillApplier } from '../src/services/skills/application';
import { CaseMatcher } from '../src/services/skills/matching';
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
  GatedReplays,
  acceptScenario,
  allAuditEvents,
  apiOf,
  earliestForkScenarios,
  ingestAndAnalyse,
  ingestCaseTwoCopy,
  moveSkill,
  runValidation,
  settledJob,
  type TestApi,
} from './skills-support';

/*
 * The signature path of the product, driven only through HTTP with the real personas:
 * Case One -> accepted counterfactual -> extracted SkillDNA -> governance gates (with refusals) ->
 * published -> Case Two is re-analysed and the skill applies as of its first email -> guided plan ->
 * high, non-blaming conformance -> a proposed (never applied) mutation v1.1.0.
 * Every number is compared with what the domain engine itself produces for the same input.
 */

const ONE = 'case_story_one';
const TWO = 'case_story_two';

// Words that would turn a description of a route into a judgement of a person (as in the domain tests).
const BLAME =
  /\b(wrong|mistake|poor(ly)?|bad(ly)?|blame\w*|punish\w*|violat\w*|non-?complian\w*|negligen\w*|careless\w*|should have|must have|ignored|neglect\w*|incompeten\w*|underperform\w*|penali[sz]\w*|fault\w*|deviat\w*|failed to|failure to)\b/i;

// Free text typed by people. It must live on the review records only, never in audit details or logs.
const MARKERS = {
  accept: 'MARKER-ACCEPT-3f9a every step uses only what was known before the decision',
  draft: 'MARKER-DRAFT-71c2 adopted for review',
  denied: 'MARKER-DENIED-5be8 trying to skip ahead',
  publish: 'MARKER-PUBLISH-90d4 approved after the pilot and regression runs',
  mutation: 'MARKER-MUTATION-a2e6 not approved yet',
} as const;

let database: Database;
let h: Harness;
let api: TestApi;

// State handed from one step of the story to the next.
let forkId = '';
let scenarios: Json[] = [];
let accepted: Json;
let skillId = '';
let previousRunId = '';
let wholeMatch: Json;
let appliedMatch: Json;

beforeAll(async () => {
  database = await openSharedDatabase();
  h = await createHarness({ database });
  api = apiOf(h);
  await ingestAndAnalyse(h, { one: ONE, two: TWO });
}, TEST_DATABASE_STARTUP_TIMEOUT_MS);

afterAll(async () => {
  await h.close();
  await database.close();
});

const audits = (tenantId = CONTOSO) => allAuditEvents(h, tenantId);

/** A stored case replayed through the domain on exactly the input its latest analysis used. */
async function replayThroughDomain(caseId: string, workload: string) {
  const repos = h.repos(CONTOSO);
  const [events, run, resolution] = await Promise.all([
    repos.cases.getAllEvents(caseId),
    repos.analysis.getLatestRun(caseId),
    repos.cases.getResolution(caseId),
  ]);
  const pack = getCompiledPack(workload);
  if (pack === null || run === null) throw new Error('missing pack or run');
  const ctx = {
    tenantId: CONTOSO,
    caseId,
    runId: run.id,
    now: run.startedAt,
    createdBy: 'system:analysis',
    seed: run.inputHash,
  } satisfies EngineContext;
  const analysis = runDeterministicAnalysis({
    view: createFullView(events, resolution),
    pack,
    config: DEFAULT_ACTION_VALUE_CONFIG,
    ctx,
  });
  return { events, pack, ctx, analysis };
}

/** The domain's impact estimate for Case Two, anchored where the skill first applies (its first email). */
function impactOfCaseTwo(
  detail: Json,
  { events, pack, ctx, analysis }: Awaited<ReturnType<typeof replayThroughDomain>>,
): SkillImpactEstimate {
  const anchor = events[0]?.timestamp ?? '';
  const last = events[events.length - 1]?.timestamp ?? '';
  const plan = buildGuidedPlan({
    skill: detail.skill,
    version: detail.currentVersion,
    analysisAsOf: analysis,
    asOf: anchor,
    pack,
    config: DEFAULT_ACTION_VALUE_CONFIG,
    ctx,
  });
  const conformance = checkConformance({
    version: detail.currentVersion,
    analysis,
    pack,
    config: DEFAULT_ACTION_VALUE_CONFIG,
    caseId: TWO,
    appliedAt: anchor,
    throughAt: last,
  });
  return estimateSkillImpact({
    plan,
    version: detail.currentVersion,
    analysis,
    pack,
    config: DEFAULT_ACTION_VALUE_CONFIG,
    ctx,
    synthetic: true,
    conformance,
  });
}

describe('Case One: a better path, reviewed by a person', () => {
  it(
    'generates the paths for the earliest fork inside the temporal boundary',
    { timeout: 120_000 },
    async () => {
      const found = await earliestForkScenarios(h, api, ONE);
      forkId = found.forkId;
      expect(found.scenarios).toHaveLength(3);

      const started = await api.post(
        PERSONAS.engineer,
        `/cases/${ONE}/forks/${forkId}/counterfactuals`,
        {},
      );
      expect(started.statusCode).toBe(202);
      expect(started.data.job.kind).toBe('counterfactual');
      const job = await settledJob(h, api, started.data.job.id);
      expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
      expect(job.progress.stages.map((s: Json) => s.id)).toEqual([
        'load',
        'simulate',
        'validate',
        'save',
      ]);
      expect(job.resultRef).toEqual({ type: 'fork', id: forkId });

      const list = await api.get(
        PERSONAS.engineer,
        `/cases/${ONE}/counterfactuals?forkId=${forkId}`,
      );
      scenarios = list.data.items;
      expect(scenarios.map((s) => s.strategy).sort()).toEqual([
        'balanced',
        'fastest_diagnosis',
        'lowest_customer_effort',
      ]);

      const events = await h.repos(CONTOSO).cases.getAllEvents(ONE);
      const fork = (await h.repos(CONTOSO).analysis.listForks(ONE)).find((f) => f.id === forkId);
      const forkEvent = events.find((e) => e.id === fork?.eventId);
      if (fork === undefined || forkEvent === undefined) throw new Error('fork event missing');
      const before = events.filter((e) => e.timestamp < forkEvent.timestamp);
      const fromDecision = events.filter((e) => e.timestamp >= forkEvent.timestamp);
      for (const scenario of scenarios) {
        // The engine decided the status and stored its checks as they are.
        expect(scenario.status).toBe('completed');
        expect(scenario.boundary.asOf).toBe(fork.timestamp);
        expect(scenario.boundary.leakCheck).toMatchObject({
          passed: true,
          futureReferencesFound: 0,
          resolutionExcluded: true,
        });
        expect(scenario.validity.valid).toBe(true);
        expect(scenario.boundary.eventIds.slice().sort()).toEqual(before.map((e) => e.id).sort());
        expect(scenario.labels).toEqual({ simulated: true, estimated: true });
        expect(scenario.modelExecutionId).not.toBeNull();
        // No event from the decision moment onwards leaks into the simulated steps: neither its id
        // nor its timestamp (the steps' own simulated times are offsets from the decision instant).
        const text = JSON.stringify([
          scenario.steps.map(({ simulatedAt: _simulatedAt, ...step }: Json) => step),
          scenario.branchNotes,
        ]);
        for (const later of fromDecision) {
          expect(text).not.toContain(`"${later.id}"`);
          expect(text).not.toContain(later.timestamp);
        }
      }
    },
  );

  it('keeps hindsight apart and lets only reviewers see or judge it', async () => {
    const balanced = scenarios.find((s) => s.strategy === 'balanced');
    expect(balanced).toBeDefined();
    const url = `/cases/${ONE}/counterfactuals/${balanced?.id}`;

    expect((await api.get(PERSONAS.engineer, `${url}/hindsight`)).statusCode).toBe(403);
    expect(
      (
        await api.post(PERSONAS.engineer, `${url}/review`, {
          decision: 'accept',
          reason: MARKERS.accept,
          expectedVersion: balanced?.version,
        })
      ).statusCode,
    ).toBe(403);

    const hindsight = await api.get(PERSONAS.reviewer, `${url}/hindsight`);
    expect(hindsight.statusCode).toBe(200);
    expect(hindsight.data).toMatchObject({
      scenarioId: balanced?.id,
      caseId: ONE,
      usedFinalResolution: true,
    });
    expect(hindsight.data.notice).toMatch(/Post-hoc/);
    // Generation never saw it: the stored scenario carries no hindsight field or wording.
    expect(JSON.stringify(balanced)).not.toMatch(/usedFinalResolution|Post-hoc evaluation/);
  });

  it('the reviewer accepts the earliest-fork scenario with a reason', async () => {
    const balanced = scenarios.find((s) => s.strategy === 'balanced');
    const res = await acceptScenario(api, ONE, balanced, MARKERS.accept);
    expect(res.statusCode).toBe(200);
    expect(res.data).toMatchObject({
      reviewState: 'confirmed',
      reviewedBy: PERSONAS.reviewer,
      reviewReason: MARKERS.accept,
    });
    accepted = res.data;
    const decisions = await h.repos(CONTOSO).reviews.list({ caseId: ONE, limit: 20 });
    expect(decisions.items.find((d) => d.targetId === accepted.id)).toMatchObject({
      targetType: 'counterfactual',
      decision: 'confirm',
      reviewerId: PERSONAS.reviewer,
      reviewerRole: 'reviewer',
    });
  });
});

describe('SkillDNA is extracted only from what a reviewer accepted', () => {
  it('refuses a scenario nobody accepted, with the engine’s reasons', async () => {
    const pending = scenarios.find((s) => s.strategy === 'fastest_diagnosis');
    const res = await api.post(PERSONAS.engineer, `/cases/${ONE}/skills/extract`, {
      scenarioId: pending?.id,
    });
    expect(res.statusCode).toBe(422);
    expect(res.data.code).toBe('validation_failed');
    expect(res.data.errors.map((e: Json) => e.message)).toContain(
      'The scenario has not been accepted by a reviewer yet.',
    );
  });

  it(
    'extracts a draft skill from the accepted scenario (discovered, never published)',
    { timeout: 120_000 },
    async () => {
      const res = await api.post(PERSONAS.engineer, `/cases/${ONE}/skills/extract`, {
        scenarioId: accepted.id,
      });
      expect(res.statusCode).toBe(202);
      expect(res.data.job.kind).toBe('skill_extraction');
      const job = await settledJob(h, api, res.data.job.id);
      expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
      expect(job.resultRef.type).toBe('skill');
      skillId = job.resultRef.id;

      // Asking again is answered by the same job and creates nothing new.
      const again = await api.post(PERSONAS.engineer, `/cases/${ONE}/skills/extract`, {
        scenarioId: accepted.id,
      });
      expect(again.data.job.id).toBe(res.data.job.id);
      expect((await api.get(PERSONAS.engineer, '/skills')).data.items).toHaveLength(1);

      const detail = await api.get(PERSONAS.engineer, `/skills/${skillId}`);
      expect(detail.statusCode).toBe(200);
      expect(detail.data.skill).toMatchObject({
        lifecycle: 'discovered',
        currentVersion: '1.0.0',
        validationStatus: 'unvalidated',
        createdBy: PERSONAS.engineer,
        synthetic: true,
        sourceCaseIds: [ONE],
      });
      const content = detail.data.currentVersion.content;
      expect(content.provenance).toMatchObject({
        caseId: ONE,
        forkId,
        scenarioId: accepted.id,
        hindsight: { used: true },
        labels: { simulated: true, estimated: true, synthetic: true },
      });
      expect(content.expectedBenefit).toMatchObject({ estimated: true, simulated: true });
    },
  );
});

describe('the lifecycle gates, with the people the rules require', () => {
  it('refuses callers without the permission, and steps that are not in the graph (audited)', async () => {
    const forbidden = await api.post(PERSONAS.engineer, `/skills/${skillId}/transition`, {
      toState: 'draft',
      reason: MARKERS.denied,
      expectedVersion: 1,
    });
    expect(forbidden.statusCode).toBe(403);

    const illegal = await moveSkill(
      api,
      PERSONAS.reviewer,
      skillId,
      'simulation_tested',
      MARKERS.denied,
    );
    expect(illegal.statusCode).toBe(409);
    expect(illegal.data.code).toBe('conflict');
    const denied = (await audits()).filter(
      (e) => e.action === 'skill.transition_denied' && e.targetId === skillId,
    );
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      outcome: 'denied',
      actorId: PERSONAS.reviewer,
      details: {
        fromState: 'discovered',
        toState: 'simulation_tested',
        code: 'illegal_transition',
      },
    });
  });

  it('the curator drafts it; skipping the simulation test is refused (412); a stale version is a conflict', async () => {
    h.clock.advance(60_000);
    const drafted = await moveSkill(api, PERSONAS.curator, skillId, 'draft', MARKERS.draft);
    expect(drafted.statusCode).toBe(200);
    expect(drafted.data.skill.lifecycle).toBe('draft');

    h.clock.advance(60_000);
    const skipped = await moveSkill(
      api,
      PERSONAS.reviewer,
      skillId,
      'simulation_tested',
      MARKERS.denied,
    );
    expect(skipped.statusCode).toBe(412);
    expect(skipped.data.code).toBe('precondition_failed');
    expect(skipped.data.detail).toMatch(/simulation test/i);

    const stale = await api.post(PERSONAS.reviewer, `/skills/${skillId}/transition`, {
      toState: 'simulation_tested',
      reason: MARKERS.denied,
      expectedVersion: 1,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.data.code).toBe('version_conflict');
    const failure = (await audits()).filter(
      (e) => e.action === 'skill.transition_denied' && e.outcome === 'failure',
    );
    expect(failure).toHaveLength(1);
  });

  it('a simulation run on the origin case alone is informative only: it never opens the gate', async () => {
    h.clock.advance(60_000);
    const narrow = await runValidation(api, PERSONAS.reviewer, skillId, {
      kind: 'simulation_test',
      caseId: ONE,
    });
    expect(narrow.statusCode).toBe(200);
    expect(narrow.data).toMatchObject({
      kind: 'simulation_test',
      scope: 'case',
      outcome: 'inconclusive',
      caseId: ONE,
    });
    // Its checks are the real ones: on the origin case the guided path did improve on the record.
    expect((narrow.data.checks as Json[]).every((c) => c.passed === true)).toBe(true);
    const recorded = (await audits()).find(
      (e) => e.action === 'skill.validation_recorded' && e.details.validationId === narrow.data.id,
    );
    expect(recorded?.details).toMatchObject({ scope: 'case', outcome: 'inconclusive' });

    h.clock.advance(60_000);
    const refused = await moveSkill(
      api,
      PERSONAS.reviewer,
      skillId,
      'simulation_tested',
      MARKERS.denied,
    );
    expect(refused.statusCode).toBe(412);
    expect(refused.data.code).toBe('precondition_failed');
    expect(refused.data.detail).toMatch(/A full simulation test has not been run/);
    expect((await api.get(PERSONAS.engineer, `/skills/${skillId}`)).data.skill.lifecycle).toBe(
      'draft',
    );
  });

  it('runs the simulation test and walks to the pilot', { timeout: 120_000 }, async () => {
    h.clock.advance(60_000);
    const test = await runValidation(api, PERSONAS.reviewer, skillId, { kind: 'simulation_test' });
    expect(test.statusCode).toBe(200);
    expect(test.data).toMatchObject({
      kind: 'simulation_test',
      outcome: 'passed',
      synthetic: true,
      executedBy: PERSONAS.reviewer,
    });
    expect(test.data.checks.map((c: Json) => c.id)).toContain(`CG-SYN-1001:temporal-integrity`);

    for (const [persona, toState] of [
      [PERSONAS.reviewer, 'simulation_tested'],
      [PERSONAS.reviewer, 'expert_reviewed'],
      [PERSONAS.curator, 'pilot'],
    ] as const) {
      h.clock.advance(60_000);
      const moved = await moveSkill(api, persona, skillId, toState);
      expect(moved.statusCode, `${toState}: ${JSON.stringify(moved.data)}`).toBe(200);
      expect(moved.data.skill.lifecycle).toBe(toState);
    }

    // Skipping the regression suite is refused even for a curator who holds skill:validate.
    h.clock.advance(60_000);
    const noRegression = await moveSkill(api, PERSONAS.curator, skillId, 'validated');
    expect(noRegression.statusCode).toBe(412);
    expect(noRegression.data.detail).toMatch(/regression/i);
  });

  it('a regression run on one case never satisfies the gate, nor replaces the verdict of a full run', async () => {
    const version = (await api.get(PERSONAS.engineer, `/skills/${skillId}`)).data.currentVersion;
    const oneCase = async () => {
      h.clock.advance(60_000);
      const res = await runValidation(api, PERSONAS.reviewer, skillId, {
        kind: 'regression',
        caseId: TWO,
      });
      expect(res.statusCode).toBe(200);
      expect(res.data).toMatchObject({ scope: 'case', outcome: 'inconclusive', caseId: TWO });
      expect((res.data.checks as Json[]).every((c) => c.passed === true)).toBe(true);
    };

    // 1. Only a run on one case exists: the gate says a full regression has not been run.
    await oneCase();
    h.clock.advance(60_000);
    const narrowOnly = await moveSkill(api, PERSONAS.reviewer, skillId, 'validated');
    expect(narrowOnly.statusCode).toBe(412);
    expect(narrowOnly.data.code).toBe('precondition_failed');
    expect(narrowOnly.data.detail).toMatch(/A full regression has not been run/);

    // 2. A full run failed (a failure of the whole suite cannot be produced from the samples, so the
    // record is stored directly: it is what the gate reads). A later pass on one case does not undo it.
    const at = h.clock.advance(60_000).toISOString();
    await h.repos(CONTOSO).skills.addValidation({
      tenantId: CONTOSO,
      createdAt: at,
      updatedAt: at,
      createdBy: PERSONAS.reviewer,
      version: 1,
      id: 'skval_story_failed_full_run',
      skillId,
      versionId: version.id,
      kind: 'regression',
      outcome: 'failed',
      caseId: null,
      scope: 'full',
      checks: [
        {
          id: 'CG-SYN-9001:does-not-match',
          passed: false,
          detail: 'It matched an irrelevant case.',
        },
      ],
      executedBy: PERSONAS.reviewer,
      executedAt: at,
      synthetic: true,
    });
    await oneCase();
    h.clock.advance(60_000);
    const stillBlocked = await moveSkill(api, PERSONAS.reviewer, skillId, 'validated');
    expect(stillBlocked.statusCode).toBe(412);
    expect(stillBlocked.data.detail).toMatch(
      /latest regression for version 1\.0\.0 did not pass \(failed\)/,
    );
    expect((await api.get(PERSONAS.engineer, `/skills/${skillId}`)).data.skill.lifecycle).toBe(
      'pilot',
    );
  });

  it(
    'validates, refuses the same person approving twice, and publishes only with a third person',
    { timeout: 120_000 },
    async () => {
      h.clock.advance(60_000);
      const regression = await runValidation(api, PERSONAS.reviewer, skillId, {
        kind: 'regression',
      });
      expect(regression.statusCode).toBe(200);
      expect(regression.data).toMatchObject({ kind: 'regression', outcome: 'passed' });
      h.clock.advance(60_000);
      expect((await moveSkill(api, PERSONAS.reviewer, skillId, 'validated')).statusCode).toBe(200);

      // The curator approved the pilot, so the curator cannot publish; the reviewer lacks the permission.
      h.clock.advance(60_000);
      const samePerson = await moveSkill(
        api,
        PERSONAS.curator,
        skillId,
        'published',
        MARKERS.denied,
      );
      expect(samePerson.statusCode).toBe(403);
      const lacksPermission = await moveSkill(
        api,
        PERSONAS.reviewer,
        skillId,
        'published',
        MARKERS.denied,
      );
      expect(lacksPermission.statusCode).toBe(403);
      const engineer = await moveSkill(
        api,
        PERSONAS.engineer,
        skillId,
        'published',
        MARKERS.denied,
      );
      expect(engineer.statusCode).toBe(403);
      const refusals = (await audits()).filter((e) => e.action === 'skill.publish_denied');
      expect(refusals.map((e) => e.actorId).sort()).toEqual(
        [PERSONAS.curator, PERSONAS.reviewer].sort(),
      );
      expect(refusals.every((e) => e.outcome === 'denied' && e.targetId === skillId)).toBe(true);
      expect((await api.get(PERSONAS.engineer, `/skills/${skillId}`)).data.skill.lifecycle).toBe(
        'validated',
      );

      h.clock.advance(60_000);
      const published = await moveSkill(api, PERSONAS.admin, skillId, 'published', MARKERS.publish);
      expect(published.statusCode).toBe(200);
      expect(published.data.skill).toMatchObject({
        lifecycle: 'published',
        validationStatus: 'validated',
        reviewer: PERSONAS.reviewer,
      });
      const approvals = published.data.approvals as Json[];
      expect(approvals.map((a) => a.toState)).toEqual([
        'draft',
        'simulation_tested',
        'expert_reviewed',
        'pilot',
        'validated',
        'published',
      ]);
      const people = new Set(
        approvals
          .filter((a) => ['expert_reviewed', 'pilot', 'published'].includes(a.toState))
          .map((a) => a.approver),
      );
      expect(people.size).toBe(3);
      expect(people.has(published.data.skill.createdBy)).toBe(false);
      expect(
        (await audits()).find((e) => e.action === 'skill.published' && e.targetId === skillId),
      ).toMatchObject({ outcome: 'success', actorId: PERSONAS.admin });
    },
  );
});

describe('Case Two: the validated skill applies', () => {
  it(
    're-analyses Case Two (the skill library is part of the analysis input) into a new run',
    { timeout: 120_000 },
    async () => {
      previousRunId = (await h.repos(CONTOSO).analysis.getLatestRun(TWO))?.id ?? '';
      const res = await api.post(PERSONAS.engineer, `/cases/${TWO}/analysis`, {});
      expect(res.statusCode).toBe(202);
      expect(res.data.reused).toBe(false);
      const job = await settledJob(h, api, res.data.job.id);
      expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
      expect(job.resultRef.id).not.toBe(previousRunId);
    },
  );

  it('matches as of the first email, from that email alone, exactly as the engine does', async () => {
    const events = await h.repos(CONTOSO).cases.getAllEvents(TWO);
    const first = events[0];
    if (first === undefined) throw new Error('Case Two has no events');
    const asOf = first.timestamp;

    const res = await api.get(PERSONAS.engineer, `/cases/${TWO}/skill-matches?asOf=${asOf}`);
    expect(res.statusCode).toBe(200);
    expect(res.data.items).toHaveLength(1);
    const match = res.data.items[0];
    expect(match).toMatchObject({
      skillId,
      skillName: 'Isolate a pre-authentication failure before pursuing identity policy',
      lifecycle: 'published',
      applicability: 'applies',
      asOf,
      applied: false,
    });
    expect(match.score).toBeGreaterThan(0.7);
    expect(match.score).toBeLessThan(0.8);
    expect(match.unmatchedTriggers.map((t: Json) => t.id)).toEqual(['trg-error-name-not-resolved']);
    expect(match.recommendedSteps.find((s: Json) => s.status === 'recommended_next')).toMatchObject(
      {
        actionKey: 'act.request-minimal-scoping',
      },
    );

    // The same match, computed straight from the domain on the same input.
    const skill = (await api.get(PERSONAS.engineer, `/skills/${skillId}`)).data;
    const pack = getCompiledPack(skill.skill.workload);
    if (pack === null) throw new Error('missing pack');
    const engineCtx: EngineContext = {
      tenantId: CONTOSO,
      caseId: TWO,
      runId: 'run_expected',
      now: asOf,
      createdBy: 'system:test',
      seed: 'expected',
    };
    const expected = matchSkills({
      skills: [{ skill: skill.skill, version: skill.currentVersion }],
      analysisAsOf: { view: createTemporalView(events, asOf) },
      asOf,
      pack,
      config: DEFAULT_ACTION_VALUE_CONFIG,
      ctx: engineCtx,
      caseInfo: { workload: skill.skill.workload, product: skill.skill.product },
    }).matches[0];
    expect(expected).toBeDefined();
    expect(match).toMatchObject({
      score: expected?.score,
      applicability: expected?.applicability,
      matchedTriggers: expected?.matchedTriggers,
      unmatchedTriggers: expected?.unmatchedTriggers,
      recommendedSteps: expected?.recommendedSteps,
    });

    // Only evidence that existed by then was used, and an as-of match is never stored.
    const evidence = await h.repos(CONTOSO).analysis.listEvidence(TWO);
    const timeOf = new Map(events.map((e) => [e.id, e.timestamp]));
    const used = (match.matchedTriggers as Json[]).flatMap((t) => t.evidenceIds as string[]);
    expect(used.length).toBeGreaterThan(0);
    for (const id of used) {
      const eventId = evidence.find((e) => e.id === id)?.eventId ?? '';
      expect((timeOf.get(eventId) ?? '9999') <= asOf).toBe(true);
    }
    const stored = await h.repos(CONTOSO).skills.listMatchesForCase(TWO);
    expect(stored.some((m) => m.asOf === asOf)).toBe(false);
  });

  it('shows the whole-case match, which is stored, and applies the guided plan once', async () => {
    const list = await api.get(PERSONAS.engineer, `/cases/${TWO}/skill-matches`);
    expect(list.statusCode).toBe(200);
    expect(list.data.items).toHaveLength(1);
    wholeMatch = list.data.items[0];
    expect(wholeMatch).toMatchObject({ skillId, applicability: 'applies', applied: false });
    const events = await h.repos(CONTOSO).cases.getAllEvents(TWO);
    expect(wholeMatch.asOf).toBe(events[events.length - 1]?.timestamp);
    expect((await h.repos(CONTOSO).skills.getMatch(TWO, wholeMatch.id))?.skillId).toBe(skillId);

    h.clock.advance(60_000);
    const res = await api.post(
      PERSONAS.engineer,
      `/cases/${TWO}/skill-matches/${wholeMatch.id}/apply`,
    );
    expect(res.statusCode).toBe(200);
    appliedMatch = res.data;
    expect(appliedMatch).toMatchObject({ applied: true, appliedBy: PERSONAS.engineer });

    // Idempotent: the second call changes nothing and is not audited as another application.
    h.clock.advance(60_000);
    const again = await api.post(
      PERSONAS.engineer,
      `/cases/${TWO}/skill-matches/${wholeMatch.id}/apply`,
    );
    expect(again.statusCode).toBe(200);
    expect(again.data.appliedAt).toBe(appliedMatch.appliedAt);
    const applications = (await audits()).filter(
      (e) => e.action === 'skill.applied' && e.caseId === TWO,
    );
    expect(applications).toHaveLength(1);
  });

  it('conformance on the finished case is high and describes the route, never the person', async () => {
    const conformance = appliedMatch.conformance;
    expect(conformance.score).toBeGreaterThanOrEqual(CONFORMANCE_HIGH);
    expect(conformance.stepsFollowed).toBeGreaterThanOrEqual(3);
    expect(conformance.stepsFollowed).toBeLessThanOrEqual(conformance.stepsTotal);
    expect(JSON.stringify(appliedMatch)).not.toMatch(BLAME);

    // The same figure the domain computes from the recorded steps.
    const events = await h.repos(CONTOSO).cases.getAllEvents(TWO);
    const skill = (await api.get(PERSONAS.engineer, `/skills/${skillId}`)).data;
    const pack = getCompiledPack(skill.skill.workload);
    const last = events[events.length - 1]?.timestamp ?? '';
    if (pack === null) throw new Error('missing pack');
    const expected = toMatchConformance(
      checkConformance({
        version: skill.currentVersion,
        analysis: { view: createTemporalView(events, last) },
        pack,
        config: DEFAULT_ACTION_VALUE_CONFIG,
        caseId: TWO,
        appliedAt: events[0]?.timestamp ?? null,
        throughAt: last,
      }),
    );
    expect(conformance).toEqual(expected);
  });

  it(
    'records effectiveness as an estimate, labelled synthetic, equal to the domain impact estimate',
    { timeout: 120_000 },
    async () => {
      const detail = (await api.get(PERSONAS.engineer, `/skills/${skillId}`)).data;
      const effectiveness = detail.skill.effectiveness;
      expect(effectiveness).toMatchObject({
        applications: 1,
        estimated: true,
        synthetic: true,
        conformanceAvg: appliedMatch.conformance.score,
      });
      expect(effectiveness.matchedCases).toBeGreaterThanOrEqual(1);
      expect(effectiveness.notes.join(' ')).toMatch(/estimate/i);
      expect(detail.notices.join(' ')).toMatch(/estimates, not measurements/);
      expect(detail.matches).toEqual([
        expect.objectContaining({ caseId: TWO, applicability: 'applies', applied: true }),
      ]);

      // Anchored where the skill first applies (the first email), like the domain's own impact test.
      const impact = impactOfCaseTwo(
        detail,
        await replayThroughDomain(TWO, detail.skill.workload as string),
      );
      expect(effectiveness.avgTimeToDiagnosisMinutes).toBe(impact.recorded?.timeToDiagnosisMinutes);
      expect(effectiveness.baselineAvgTimeToDiagnosisMinutes).toBe(
        Math.round(impact.baseline.metrics.timeToDiagnosisMinutes.mid * 100) / 100,
      );
    },
  );

  it(
    'also compares Case Two with the recorded path of the case the skill came from, and says what that is',
    { timeout: 120_000 },
    async () => {
      const detail = (await api.get(PERSONAS.engineer, `/skills/${skillId}`)).data;
      const effectiveness = detail.skill.effectiveness;
      const block = effectiveness.precedent;
      expect(block).toBeDefined();
      // One application, compared with the one case the skill came from.
      expect(block).toMatchObject({ cases: 1, references: ['CG-SYN-1001'] });
      expect(block.avgTimeToDiagnosisMinutes).toBe(effectiveness.avgTimeToDiagnosisMinutes);

      // The direction of the story: faster than the recorded path it learned from, with fewer tokens and
      // evidence that is no less complete. The simulated baseline above says otherwise (it has no
      // waiting between steps), which is why both are named.
      expect(block.avgTimeToDiagnosisMinutes).toBeLessThan(
        block.precedentAvgTimeToDiagnosisMinutes,
      );
      expect(block.tokenChangePct).toBeLessThan(0);
      expect(block.evidenceCompletenessPoints).toBeGreaterThanOrEqual(0);
      expect(effectiveness.avgTimeToDiagnosisMinutes).toBeGreaterThan(
        effectiveness.baselineAvgTimeToDiagnosisMinutes,
      );

      // Every figure is what the domain measures for the two cases on the stored input.
      const workload = detail.skill.workload as string;
      const impact = impactOfCaseTwo(detail, await replayThroughDomain(TWO, workload));
      const origin = await replayThroughDomain(ONE, workload);
      const precedent = impactPrecedentOf({
        reference: 'CG-SYN-1001',
        analysis: origin.analysis,
        pack: origin.pack,
        minimumEvidence: detail.currentVersion.content.minimumEvidence.map(
          (m: Json) => m.requirementId as string,
        ),
      });
      const recorded = impact.recorded;
      if (precedent === null || recorded === null) throw new Error('the domain measured no path');
      const round1 = (x: number) => Math.round(x * 10) / 10;
      expect(block.precedentAvgTimeToDiagnosisMinutes).toBe(
        Math.round(precedent.timeToDiagnosisMinutes * 100) / 100,
      );
      expect(block.tokenChangePct).toBe(
        round1(
          ((recorded.tokenEstimate - precedent.tokenEstimate) / precedent.tokenEstimate) * 100,
        ),
      );
      expect(block.evidenceCompletenessPoints).toBe(
        round1((recorded.evidenceCompleteness - precedent.evidenceCompleteness) * 100),
      );

      // The simulated comparison keeps every figure and its own honesty text.
      const baselineTokens = impact.baseline.metrics.tokenEstimate.mid;
      expect(effectiveness.estimatedTokenSavingsPct).toBe(
        round1(((baselineTokens - recorded.tokenEstimate) / baselineTokens) * 100),
      );
      expect(effectiveness.baselineAvgTimeToDiagnosisMinutes).toBe(
        Math.round(impact.baseline.metrics.timeToDiagnosisMinutes.mid * 100) / 100,
      );
      expect(effectiveness).toMatchObject({ estimated: true, synthetic: true, applications: 1 });

      // Honest labelling: what the comparison is, and both bases named, never a measured effect.
      expect(block.basis).toBe(
        'Compared with the recorded path of the case the skill came from (1 earlier case); different cases, no control group: an estimate, not a measurement.',
      );
      const notes = effectiveness.notes as string[];
      expect(notes[0]).toMatch(/model estimates, not measurements/);
      expect(notes.join(' ')).toMatch(
        /seeded simulation of the knowledge-pack policy without the skill/,
      );
      expect(notes.join(' ')).toMatch(
        /recorded path of the case the skill came from \(a different case/,
      );
      expect(JSON.stringify(effectiveness)).not.toMatch(BLAME);
      expect(JSON.stringify(effectiveness)).not.toMatch(
        /(thanks to the skill|because of the skill|proves|guarantee)/i,
      );
    },
  );
});

describe('Case Two also teaches the skill: a mutation is only ever proposed', () => {
  it(
    'proposes v1.1.0 as a proposal, with a human-readable diff, and leaves the published skill alone',
    { timeout: 120_000 },
    async () => {
      h.clock.advance(60_000);
      const res = await api.post(PERSONAS.curator, `/skills/${skillId}/mutations`, {
        sourceCaseId: TWO,
      });
      expect(res.statusCode).toBe(202);
      expect(res.data.job.kind).toBe('skill_mutation');
      const job = await settledJob(h, api, res.data.job.id);
      expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
      expect(job.resultRef.type).toBe('skill_version');
      // The same request is answered by the same job.
      const again = await api.post(PERSONAS.curator, `/skills/${skillId}/mutations`, {
        sourceCaseId: TWO,
      });
      expect(again.data.job.id).toBe(res.data.job.id);

      const detail = (await api.get(PERSONAS.engineer, `/skills/${skillId}`)).data;
      expect(detail.proposedVersion).toMatchObject({
        version: '1.1.0',
        state: 'proposed',
        changeType: 'mutation',
        parentVersionId: detail.currentVersion.id,
        createdBy: PERSONAS.curator,
      });
      expect(detail.currentVersion).toMatchObject({ version: '1.0.0', state: 'active' });
      expect(detail.skill).toMatchObject({
        lifecycle: 'published',
        currentVersion: '1.0.0',
        hasProposedMutation: true,
      });
      expect(
        detail.proposedVersion.content.sourceCases.map((s: Json) => [
          s.role,
          s.reference.split(' ')[0],
        ]),
      ).toEqual([
        ['origin', 'CG-SYN-1001'],
        ['mutation_source', 'CG-SYN-1002'],
      ]);

      const diff = await api.get(
        PERSONAS.engineer,
        `/skills/${skillId}/diff?fromVersionId=${detail.currentVersion.id}&toVersionId=${detail.proposedVersion.id}`,
      );
      expect(diff.statusCode).toBe(200);
      expect(diff.data).toMatchObject({ fromVersion: '1.0.0', toVersion: '1.1.0' });
      const lines = (diff.data.changes as Json[]).map((c) => c.summary as string);
      expect(lines).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^Added trigger condition: Client reports a connection timeout/),
          expect.stringMatching(
            /^Added query template: Compare sign-in connectivity through each proxy node \(PowerShell\)/,
          ),
        ]),
      );
    },
  );

  it('never applies it without an approval: not by the proposer, not without validated content', async () => {
    const detail = (await api.get(PERSONAS.engineer, `/skills/${skillId}`)).data;
    const proposed = detail.proposedVersion;
    const decide = (persona: string, decision: string) =>
      api.post(persona, `/skills/${skillId}/versions/${proposed.id}/decision`, {
        decision,
        reason: MARKERS.mutation,
        expectedVersion: detail.skill.version,
      });

    // The curator proposed it, so the curator cannot approve it (separation of duties).
    const byProposer = await decide(PERSONAS.curator, 'approve');
    expect(byProposer.statusCode).toBe(403);
    expect(byProposer.data.reason).toBe('separation_of_duties');
    // A distinct approver still needs simulation and regression runs on the proposed content.
    const unvalidated = await decide(PERSONAS.admin, 'approve');
    expect(unvalidated.statusCode).toBe(412);
    expect(unvalidated.data.reason).toBe('gate_failed');
    expect(unvalidated.data.detail).toMatch(/simulation test/i);

    const after = (await api.get(PERSONAS.engineer, `/skills/${skillId}`)).data;
    expect(after.skill).toMatchObject({ currentVersion: '1.0.0', hasProposedMutation: true });
    expect(after.proposedVersion).toMatchObject({ version: '1.1.0', state: 'proposed' });
    // The match for Case Two still uses the published version.
    const matches = (await api.get(PERSONAS.engineer, `/cases/${TWO}/skill-matches`)).data.items;
    expect(matches[0].skillVersion).toBe('1.0.0');
    const denied = (await audits()).filter((e) => e.action === 'skill.version_decision_denied');
    expect(denied.map((e) => e.actorId).sort()).toEqual([PERSONAS.admin, PERSONAS.curator].sort());
  });
});

describe('what the story leaves behind', () => {
  it('audits every step in the tenant’s chain without any free text, and keeps the other tenant out', async () => {
    const events = await audits();
    const actions = new Set(events.map((e) => e.action));
    for (const action of [
      'counterfactual.generated',
      'counterfactual.reviewed',
      'skill.extracted',
      'skill.transitioned',
      'skill.published',
      'skill.validation_recorded',
      'skill.applied',
      'skill.mutation_proposed',
      'skill.transition_denied',
      'skill.publish_denied',
      'skill.version_decision_denied',
      'access.denied',
    ]) {
      expect(actions.has(action), action).toBe(true);
    }
    const everything = JSON.stringify(events.map((e) => e.details));
    for (const marker of Object.values(MARKERS)) expect(everything).not.toContain(marker);
    expect(JSON.stringify(h.logs())).not.toMatch(/MARKER-/);
    expect((await h.repos(CONTOSO).audit.verify()).valid).toBe(true);

    const other = (await h.repos(FABRIKAM).audit.list({ limit: 200 })).items;
    expect(other.filter((e) => /^(skill|counterfactual)\./.test(e.action))).toEqual([]);
  });

  it('keeps tenants apart: the other tenant sees none of it', async () => {
    const eve = PERSONAS.otherTenantEngineer;
    expect((await api.get(eve, `/skills/${skillId}`)).statusCode).toBe(404);
    expect((await api.get(eve, '/skills')).data.items).toEqual([]);
    expect((await api.get(eve, `/cases/${ONE}/counterfactuals`)).statusCode).toBe(404);
    expect((await api.get(eve, `/cases/${TWO}/skill-matches`)).statusCode).toBe(404);
    expect(
      (await api.post(eve, `/cases/${ONE}/skills/extract`, { scenarioId: accepted.id })).statusCode,
    ).toBe(404);
  });
});

describe('when the case the skill came from is erased', () => {
  const [THREE, FOUR] = ['case_story_three', 'case_story_four'];

  it(
    'still applies the skill, without a precedent and without an error, and says why',
    { timeout: 240_000 },
    async () => {
      await ingestCaseTwoCopy(h, THREE, 'CG-SYN-1003');
      await ingestCaseTwoCopy(h, FOUR, 'CG-SYN-1004');
      const detailOf = async (): Promise<Json> =>
        (await api.get(PERSONAS.engineer, `/skills/${skillId}`)).data;
      const apply = async (caseId: string): Promise<Json> => {
        h.clock.advance(60_000);
        const res = await api.post(PERSONAS.engineer, `/cases/${caseId}/skills/apply`, {
          skillId,
        });
        expect(res.statusCode, JSON.stringify(res.data)).toBe(200);
        expect(res.data).toMatchObject({ caseId, applied: true, appliedBy: PERSONAS.engineer });
        return res.data;
      };

      // While Case One exists, every application is compared with its recorded path. Case Two is
      // re-measured when the next application is recorded, and that measurement is kept for a while.
      await apply(THREE);
      const before = (await detailOf()).skill.effectiveness;
      expect(before).toMatchObject({ applications: 2 });
      expect(before.precedent).toMatchObject({ cases: 2, references: ['CG-SYN-1001'] });

      // An administrator erases Case One. The skill keeps naming it as its source, but the path is gone.
      expect(await h.repos(CONTOSO).cases.delete(ONE)).toBe(true);
      await apply(FOUR);

      const detail = await detailOf();
      const after = detail.skill.effectiveness;
      expect(detail.skill.sourceCaseIds).toEqual([ONE]);
      expect(after).toMatchObject({ applications: 3, estimated: true, synthetic: true });
      // Case Two and Case Three were compared with the precedent a moment ago; nothing of that is
      // carried over once the path it was measured on is gone.
      expect('precedent' in after).toBe(false);
      expect(after.notes).toContain(
        'The recorded path of the case the skill came from is not available, so 3 applications have no comparison with it.',
      );
      expect(after.notes.join(' ')).not.toMatch(/Two bases are shown/);
      // The simulated comparison is untouched, for every application.
      expect(after.avgTimeToDiagnosisMinutes).not.toBeNull();
      expect(after.baselineAvgTimeToDiagnosisMinutes).not.toBeNull();
      expect(after.notes[0]).toMatch(/model estimates, not measurements/);
      // Nothing about the missing case was a failure: it was not logged as one, and nothing was refused.
      expect(JSON.stringify(h.logs())).not.toMatch(/could not be measured/);
      const applications = (await audits()).filter(
        (e) => e.action === 'skill.applied' && e.caseId === FOUR,
      );
      expect(applications).toHaveLength(1);
      expect(applications[0]).toMatchObject({ outcome: 'success', actorId: PERSONAS.engineer });
    },
  );
});

describe('applications of one skill that run at the same time', () => {
  const [FIVE, SIX, SEVEN] = ['case_story_five', 'case_story_six', 'case_story_seven'];
  const skillRecord = async (): Promise<Json> =>
    (await api.get(PERSONAS.engineer, `/skills/${skillId}`)).data.skill;
  const applicationsAudited = async (caseId: string) =>
    (await audits()).filter((e) => e.action === 'skill.applied' && e.caseId === caseId);

  it(
    'counts an application that commits while another is being measured, and audits each once',
    { timeout: 300_000 },
    async () => {
      await ingestCaseTwoCopy(h, FIVE, 'CG-SYN-1005');
      await ingestCaseTwoCopy(h, SIX, 'CG-SYN-1006');
      const before = await skillRecord();

      // One request measures Case Five. While it measures the earlier applications (it has read the list
      // of them by then and holds the version of the skill), another request applies the skill to Case Six
      // and commits. The gate is a replay loader that holds the first replay of any other case.
      const gate = new GatedReplays((caseId) => caseId !== FIVE);
      const slow = new SkillApplier(gate, new CaseMatcher());
      h.clock.advance(60_000);
      const mine = slow.apply(contextFor(h, PERSONAS.engineer), FIVE, skillId);
      await gate.reached;

      h.clock.advance(60_000);
      const curator = contextFor(h, PERSONAS.curator);
      const theirs = await curator.services.skills.applyToCase(curator, SIX, skillId);
      expect(theirs).toMatchObject({ caseId: SIX, applied: true, appliedBy: PERSONAS.curator });
      gate.release();
      expect(await mine).toMatchObject({
        caseId: FIVE,
        applied: true,
        appliedBy: PERSONAS.engineer,
      });

      // Neither application is missing from the aggregate, and the skill was written once for each.
      const after = await skillRecord();
      expect(after.effectiveness.applications).toBe(before.effectiveness.applications + 2);
      expect(after.effectiveness.matchedCases).toBeGreaterThanOrEqual(
        before.effectiveness.applications + 2,
      );
      expect(after.version).toBe(before.version + 2);
      expect(await applicationsAudited(FIVE)).toHaveLength(1);
      expect(await applicationsAudited(SIX)).toHaveLength(1);
      const matches = (await api.get(PERSONAS.engineer, `/skills/${skillId}`)).data.matches;
      const appliedCases = (matches as Json[]).filter((m) => m.applied).map((m) => m.caseId);
      expect(appliedCases).toEqual(expect.arrayContaining([FIVE, SIX]));
    },
  );

  it(
    'audits one application, not two, when the same match is applied twice at once',
    { timeout: 300_000 },
    async () => {
      await ingestCaseTwoCopy(h, SEVEN, 'CG-SYN-1007');
      const before = await skillRecord();
      const [matchBefore] = await h.repos(CONTOSO).skills.listMatchesForCase(SEVEN);
      expect(matchBefore).toMatchObject({ caseId: SEVEN, applied: false });

      // Two requests measure Case Seven side by side and are let go together, so both are about to record it.
      const gate = new GatedReplays((caseId) => caseId === SEVEN, 2);
      const applier = new SkillApplier(gate, new CaseMatcher());
      h.clock.advance(60_000);
      const both = Promise.all([
        applier.apply(contextFor(h, PERSONAS.engineer), SEVEN, skillId),
        applier.apply(contextFor(h, PERSONAS.curator), SEVEN, skillId),
      ]);
      await gate.reached;
      gate.release();
      const [first, second] = await both;

      // The one that committed first is who applied it; the other sees exactly that.
      expect(first).toMatchObject({ caseId: SEVEN, applied: true });
      expect(second).toEqual(first);
      expect([PERSONAS.engineer, PERSONAS.curator]).toContain(first.appliedBy);
      const events = await applicationsAudited(SEVEN);
      expect(events).toHaveLength(1);
      expect(events[0]?.actorId).toBe(first.appliedBy);
      const stored = await h.repos(CONTOSO).skills.getMatch(SEVEN, first.id);
      // Written once: the stored match moved one version on, and belongs to the one who recorded it.
      expect(stored).toMatchObject({
        applied: true,
        appliedBy: first.appliedBy,
        version: (matchBefore?.version ?? 0) + 1,
      });
      const after = await skillRecord();
      expect(after.effectiveness.applications).toBe(before.effectiveness.applications + 1);
      expect(after.version).toBe(before.version + 1);
    },
  );
});
