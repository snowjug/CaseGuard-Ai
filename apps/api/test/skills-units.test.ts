import { describe, expect, it } from 'vitest';
import {
  SKILL_ERROR_HTTP,
  buildSkillDetail,
  createFullView,
  extractSkillCandidates,
  generateCounterfactuals,
  getCompiledPack,
  runDeterministicAnalysis,
  skillFail,
  skillOk,
  type EngineContext,
  type ExtractionRefusal,
  type SkillActor,
  type SkillChangeSet,
  type SkillDraft,
  type SkillErrorCode,
} from '@caseguard/domain';
import {
  DEFAULT_ACTION_VALUE_CONFIG,
  DEFAULT_QUALITY_CONFIG,
  type CounterfactualScenario,
  type DecisionFork,
  type SkillApproval,
  type SkillValidation,
} from '@caseguard/schemas';
import { toProblem } from '../src/http/problem';
import type { AnalysisInputs } from '../src/services/analysis';
import type { CaseReplay } from '../src/services/counterfactuals/replay';
import {
  SELF_APPROVAL_MESSAGE,
  guardSelfApproval,
  orderValidations,
} from '../src/services/skills/aggregate';
import { auditEventOf } from '../src/services/skills/audit';
import { withSelfApprovalGuard } from '../src/services/skills/detail';
import { refusalIssues, skillErrorToAppError } from '../src/services/skills/errors';
import { clampAsOf } from '../src/services/skills/matching';
import { extractionPreflight, isAccepted } from '../src/services/skills/preflight';
import {
  buildSkillUsage,
  firstApplicableAt,
  lastEventAtOf,
  matchedOnlyRecord,
} from '../src/services/skills/usage';
import { regressionExpectation } from '../src/services/skills/validation';
import { SAMPLE_FILES, normalizeSample } from './support/samples';

/* Pure unit tests: the engine runs on the real synthetic cases, nothing touches a database. */

const TENANT = 'tenant_unit';
const pack = getCompiledPack('teams-authentication');
if (pack === null) throw new Error('the teams-authentication pack is missing');

const one = normalizeSample(SAMPLE_FILES.caseOne, { tenantId: TENANT, caseId: 'case_unit_one' });
const two = normalizeSample(SAMPLE_FILES.caseTwo, { tenantId: TENANT, caseId: 'case_unit_two' });
const contextOf = (caseId: string, runId: string): EngineContext => ({
  tenantId: TENANT,
  caseId,
  runId,
  now: '2026-01-15T09:00:00.000Z',
  createdBy: 'user_ava_engineer',
  seed: `seed-${caseId}`,
});
const ctxOne = contextOf('case_unit_one', 'run_unit_1');
const ctxTwo = contextOf('case_unit_two', 'run_unit_2');
const analyse = (normalized: typeof one, ctx: EngineContext) =>
  runDeterministicAnalysis({
    view: createFullView(normalized.events, normalized.resolution),
    pack,
    config: DEFAULT_ACTION_VALUE_CONFIG,
    ctx,
  });
const analysisOne = analyse(one, ctxOne);
const analysisTwo = analyse(two, ctxTwo);
const fork = analysisOne.forks.find((f) => f.isEarliestMeaningful) ?? analysisOne.forks[0];
if (fork === undefined) throw new Error('Case One has no fork');
const generated = generateCounterfactuals({
  analysis: analysisOne,
  fork,
  strategies: ['balanced'],
  events: one.events,
  resolution: one.resolution,
  pack,
  config: DEFAULT_ACTION_VALUE_CONFIG,
  ctx: ctxOne,
});
const pending = generated.scenarios[0];
if (pending === undefined) throw new Error('no scenario');

const extract = (
  scenario: CounterfactualScenario,
  forkUsed: DecisionFork = fork,
): { candidates: SkillDraft[]; refusals: ExtractionRefusal[] } =>
  extractSkillCandidates({
    analysis: analysisOne,
    fork: forkUsed,
    scenarios: [scenario],
    events: one.events,
    resolution: one.resolution,
    pack,
    config: DEFAULT_ACTION_VALUE_CONFIG,
    ctx: ctxOne,
    caseInfo: { workload: one.case.workload, product: one.case.product },
    caseReference: one.case.reference,
    synthetic: true,
  });

const accepted: CounterfactualScenario = { ...pending, reviewState: 'confirmed' };
const draft = extract(accepted).candidates[0];
if (draft === undefined) throw new Error('no draft skill');

describe('refusals keep the status and Problem Details code the domain documents', () => {
  it('maps every domain error code to its documented HTTP status and code', () => {
    for (const code of Object.keys(SKILL_ERROR_HTTP) as SkillErrorCode[]) {
      const result = toProblem(
        skillErrorToAppError({
          code,
          message: 'A state, a version or a permission.',
          details: {},
          audit: null,
        }),
        { requestId: 'req_unit' },
      );
      expect(result.status, code).toBe(SKILL_ERROR_HTTP[code].status);
      expect(result.problem.code, code).toBe(SKILL_ERROR_HTTP[code].problemCode);
    }
  });

  it('records permission and separation-of-duties refusals as denials, and conflicts as failures', () => {
    const denied = (code: SkillErrorCode) =>
      toProblem(skillErrorToAppError({ code, message: 'm', details: {}, audit: null }), {
        requestId: 'r',
      }).denied;
    expect(denied('forbidden')).toBe(true);
    expect(denied('separation_of_duties')).toBe(true);
    expect(denied('gate_failed')).toBe(false);
    expect(denied('version_conflict')).toBe(false);
  });

  it('lists every engine refusal reason as its own problem entry, bounded', () => {
    const refusals: ExtractionRefusal[] = [
      { scenarioId: 'scn_a', reasons: ['First reason.', 'Second reason.'] },
      { scenarioId: null, reasons: ['No scenario was provided.'] },
    ];
    expect(refusalIssues(refusals)).toEqual([
      { path: 'scenario.scn_a', message: 'First reason.' },
      { path: 'scenario.scn_a', message: 'Second reason.' },
      { path: 'scenario', message: 'No scenario was provided.' },
    ]);
    const many = [{ scenarioId: 'scn_b', reasons: Array.from({ length: 80 }, (_, i) => `r${i}`) }];
    expect(refusalIssues(many)).toHaveLength(50);
    const problem = toProblem(
      skillErrorToAppError({
        code: 'extraction_refused',
        message: 'Refused.',
        details: { refusals },
        audit: null,
      }),
      { requestId: 'r' },
    );
    expect(problem.problem.errors).toHaveLength(3);
  });
});

describe('what reaches the audit trail', () => {
  const payload = {
    action: 'skill.transitioned',
    targetType: 'skill' as const,
    targetId: 'skl_1',
    caseId: null,
    outcome: 'success' as const,
    actorId: 'user_casey_curator',
    occurredAt: '2026-01-15T09:00:00.000Z',
    details: {
      fromState: 'draft',
      toState: 'pilot',
      reason: 'Free text written by a person.',
      sourceCaseReference: 'CG-SYN-1002',
    },
  };

  it('replaces the reviewer’s reason of a success by a flag and drops case references', () => {
    const event = auditEventOf(payload);
    expect(event.details).toEqual({ fromState: 'draft', toState: 'pilot', reasonRecorded: true });
    expect(event).toMatchObject({
      action: 'skill.transitioned',
      targetId: 'skl_1',
      outcome: 'success',
    });
    expect(payload.details.reason).toBe('Free text written by a person.');
  });

  it('keeps the domain’s own sentence on a refusal, which is what explains a denial', () => {
    const event = auditEventOf({
      ...payload,
      outcome: 'denied',
      details: {
        code: 'gate_failed',
        reason: 'No simulation test has been run for version 1.0.0.',
      },
    });
    expect(event.details).toEqual({
      code: 'gate_failed',
      reason: 'No simulation test has been run for version 1.0.0.',
    });
  });
});

describe('extraction pre-flight agrees with the domain', () => {
  const variants: [string, CounterfactualScenario, DecisionFork][] = [
    ['not accepted yet', pending, fork],
    ['accepted', accepted, fork],
    ['corrected by a reviewer', { ...pending, reviewState: 'corrected' }, fork],
    ['rejected by a reviewer', { ...pending, reviewState: 'rejected' }, fork],
    [
      'rejected by the engine',
      {
        ...accepted,
        status: 'rejected',
        validity: { valid: false, checks: [{ id: 'steps-safe', passed: false, detail: 'x' }] },
        boundary: {
          ...accepted.boundary,
          leakCheck: { ...accepted.boundary.leakCheck, passed: false, futureReferencesFound: 1 },
        },
      },
      fork,
    ],
    ['failed', { ...accepted, status: 'failed' }, fork],
    [
      'an ineligible fork',
      accepted,
      {
        ...fork,
        eligibility: {
          ...fork.eligibility,
          eligible: false,
          reasons: ['Impact 0.1 versus threshold 0.3.'],
        },
      },
    ],
    ['a reviewer-rejected fork', accepted, { ...fork, reviewState: 'rejected' }],
    ['another fork’s scenario', { ...accepted, forkId: 'fork_other' }, fork],
  ];

  it.each(variants)(
    'gives the same reasons as extractSkillCandidates: %s',
    (_name, scenario, forkUsed) => {
      const reasons = extract(scenario, forkUsed).refusals[0]?.reasons ?? [];
      expect(extractionPreflight({ caseId: 'case_unit_one', scenario, fork: forkUsed })).toEqual(
        reasons,
      );
    },
  );

  it('explains a fork that is gone, and treats only confirmed and corrected scenarios as accepted', () => {
    expect(
      extractionPreflight({ caseId: 'case_unit_one', scenario: accepted, fork: null }),
    ).toEqual(['The decision fork of this scenario no longer exists in the stored analysis.']);
    expect(isAccepted({ reviewState: 'confirmed' })).toBe(true);
    expect(isAccepted({ reviewState: 'corrected' })).toBe(true);
    expect(isAccepted({ reviewState: 'pending' })).toBe(false);
    expect(isAccepted({ reviewState: 'rejected' })).toBe(false);
  });
});

describe('four-eyes on approvals the data tier records', () => {
  const approval = (over: Partial<SkillApproval>): SkillApproval => ({
    tenantId: TENANT,
    createdAt: '2026-01-15T09:00:00.000Z',
    updatedAt: '2026-01-15T09:00:00.000Z',
    createdBy: 'user_casey_curator',
    version: 1,
    id: 'skp_1',
    skillId: 'skl_1',
    versionId: 'skv_1',
    fromState: 'discovered',
    toState: 'draft',
    decision: 'approved',
    approver: 'user_casey_curator',
    requestedBy: 'user_ava_engineer',
    reason: 'ok ok',
    decidedAt: '2026-01-15T09:00:00.000Z',
    ...over,
  });
  const change = (approvals: SkillApproval[]): SkillChangeSet => ({
    skill: draft.skill,
    previousSkillVersion: 1,
    newVersions: [],
    versionStates: [],
    validations: [],
    approvals,
    audit: [],
  });
  const context = {
    actor: { id: 'user_casey_curator', permissions: [] } satisfies SkillActor,
    op: { tenantId: TENANT, now: '2026-01-15T09:00:00.000Z', nextId: (p: string) => `${p}_1` },
    fromState: 'discovered',
  };

  it('passes an approval by someone else, a rejection and a refusal through unchanged', () => {
    const fine = skillOk(change([approval({})]));
    expect(guardSelfApproval(fine, context)).toBe(fine);
    const rejection = skillOk(
      change([approval({ decision: 'rejected', approver: 'user_ava_engineer' })]),
    );
    expect(guardSelfApproval(rejection, context)).toBe(rejection);
    const refused = skillFail<SkillChangeSet>('forbidden', 'No.');
    expect(guardSelfApproval(refused, context)).toBe(refused);
  });

  it('refuses the requester approving, as an audited separation-of-duties denial', () => {
    const self = skillOk(change([approval({ approver: 'user_ava_engineer' })]));
    const result = guardSelfApproval(self, context);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: 'separation_of_duties',
      message: SELF_APPROVAL_MESSAGE,
    });
    expect(result.error.audit).toMatchObject({
      action: 'skill.transition_denied',
      outcome: 'denied',
      actorId: 'user_casey_curator',
      targetId: 'skl_1',
      details: { fromState: 'discovered', toState: 'draft', code: 'separation_of_duties' },
    });
    const publish = guardSelfApproval(
      skillOk(change([approval({ approver: 'user_ava_engineer', toState: 'published' })])),
      context,
    );
    expect(publish.ok ? null : publish.error.audit?.action).toBe('skill.publish_denied');
  });

  it('shows the creator the approving steps as unavailable, and everyone else the domain’s answer', () => {
    const everything: SkillActor['permissions'] = [
      'skill:extract',
      'skill:review',
      'skill:validate',
      'skill:approve',
      'skill:publish',
      'skill:retire',
    ];
    const creator: SkillActor = { id: draft.skill.createdBy, permissions: everything };
    const aggregate = {
      skill: draft.skill,
      versions: [draft.version],
      validations: [],
      approvals: [],
    };
    const built = buildSkillDetail({ aggregate, actor: creator });
    if (!built.ok) throw new Error('detail failed');
    const draftOption = built.value.transitions.find((t) => t.toState === 'draft');
    expect(draftOption?.allowed).toBe(true); // the domain alone would let the creator take the step

    const guarded = withSelfApprovalGuard(built.value, draft.skill, creator);
    expect(guarded.transitions.find((t) => t.toState === 'draft')).toMatchObject({
      allowed: false,
      reason: SELF_APPROVAL_MESSAGE,
    });
    // Withdrawing a skill is recorded as a rejection, which the data tier allows.
    expect(guarded.transitions.find((t) => t.toState === 'retired')).toEqual(
      built.value.transitions.find((t) => t.toState === 'retired'),
    );
    const other: SkillActor = { id: 'user_casey_curator', permissions: everything };
    expect(withSelfApprovalGuard(built.value, draft.skill, other)).toBe(built.value);
  });
});

describe('the validation history the domain reads', () => {
  const validation = (id: string, executedAt: string, createdAt = executedAt): SkillValidation => ({
    tenantId: TENANT,
    createdAt,
    updatedAt: createdAt,
    createdBy: 'user_riley_reviewer',
    version: 1,
    id,
    skillId: 'skl_1',
    versionId: 'skv_1',
    kind: 'simulation_test',
    outcome: 'passed',
    caseId: null,
    checks: [],
    executedBy: 'user_riley_reviewer',
    executedAt,
    synthetic: true,
  });

  it('puts the oldest first and breaks ties by creation time and then id', () => {
    const t = '2026-01-15T09:00:00.000Z';
    const ordered = orderValidations([
      validation('skval_b', t),
      validation('skval_c', '2026-01-15T10:00:00.000Z'),
      validation('skval_a', t),
      validation('skval_d', t, '2026-01-15T08:00:00.000Z'),
    ]);
    expect(ordered.map((v) => v.id)).toEqual(['skval_d', 'skval_a', 'skval_b', 'skval_c']);
  });
});

describe('regression expectations', () => {
  it('requires the source cases to stay non-breaking, and infers the rest from what the skill does', () => {
    for (const role of ['origin', 'validation', 'mutation_source'] as const) {
      expect(regressionExpectation(role, 'not_applicable')).toBe('non_breaking');
      expect(regressionExpectation(role, 'improves')).toBe('non_breaking');
    }
    expect(regressionExpectation(undefined, 'not_applicable')).toBe('not_applicable');
    for (const verdict of ['improves', 'equivalent', 'slower', 'safe_stop', 'breaking'] as const) {
      expect(regressionExpectation(undefined, verdict)).toBe('non_breaking');
    }
  });
});

describe('matching by moment', () => {
  it('never reaches past the last recorded event', () => {
    const last = '2026-04-14T16:10:00Z';
    expect(clampAsOf('2026-04-14T09:00:00Z', last)).toBe('2026-04-14T09:00:00Z');
    expect(clampAsOf('2026-04-14T16:10:00.000Z', last)).toBe('2026-04-14T16:10:00.000Z');
    expect(clampAsOf('2099-01-01T00:00:00Z', last)).toBe(last);
  });
});

describe('what an application contributes to effectiveness', () => {
  const inputs: AnalysisInputs = {
    caseRecord: two.case,
    source: two.source,
    events: two.events,
    resolution: two.resolution,
    pack,
    actionConfig: DEFAULT_ACTION_VALUE_CONFIG,
    qualityConfig: DEFAULT_QUALITY_CONFIG,
    skills: [],
    unitPrices: { inputPer1kUsd: null, outputPer1kUsd: null, cachedInputPer1kUsd: null },
  };
  const replay: CaseReplay = {
    run: {
      tenantId: TENANT,
      createdAt: ctxTwo.now,
      updatedAt: ctxTwo.now,
      createdBy: 'system:analysis',
      version: 1,
      id: ctxTwo.runId,
      caseId: ctxTwo.caseId,
      status: 'succeeded',
      provider: 'deterministic',
      model: 'deterministic-knowledge-pack',
      simulated: true,
      knowledgePackId: pack.pack.id,
      knowledgePackVersion: pack.pack.version,
      qualityConfigVersion: '1',
      actionValueConfigVersion: '1',
      inputHash: 'hash',
      startedAt: ctxTwo.now,
      completedAt: ctxTwo.now,
      counts: {
        events: 0,
        evidence: 0,
        claims: 0,
        hypotheses: 0,
        actions: 0,
        forks: 0,
        warnings: 0,
        modelExecutions: 0,
      },
      error: null,
    },
    inputs,
    engineCtx: ctxTwo,
    analysis: analysisTwo,
  };
  const entry = {
    skill: { ...draft.skill, lifecycle: 'published' as const },
    version: draft.version,
  };

  it('anchors at the first moment the skill applies, using only what was known then', () => {
    expect(firstApplicableAt(replay, entry)).toBe(two.events[0]?.timestamp);
    expect(lastEventAtOf(replay)).toBe(two.events[two.events.length - 1]?.timestamp);
  });

  it('records the recorded path against the estimated baseline, as estimates', () => {
    const usage = buildSkillUsage({ replay, entry, applied: true });
    expect(usage.anchorAt).toBe(two.events[0]?.timestamp);
    expect(usage.impact.labels).toEqual({ estimated: true, simulated: true, synthetic: true });
    expect(usage.record).toMatchObject({
      skillId: draft.skill.id,
      versionId: draft.version.id,
      caseId: 'case_unit_two',
      synthetic: true,
      matched: true,
      applied: true,
      suggestionsOffered: usage.conformance.stagesTotal,
      suggestionsAccepted: usage.conformance.stagesFollowed,
      conformanceScore: usage.conformance.score,
    });
    expect(usage.record.timeToDiagnosisMinutes).toBe(usage.impact.recorded?.timeToDiagnosisMinutes);
    expect(usage.record.baselineTimeToDiagnosisMinutes).toBe(
      usage.impact.baseline.metrics.timeToDiagnosisMinutes.mid,
    );
    expect(usage.conformance.score).toBeGreaterThanOrEqual(0.75);
  });

  it('counts a match that was only offered as matched, with no measures', () => {
    expect(
      matchedOnlyRecord({ skillId: 's', versionId: 'v', caseId: 'c', synthetic: false }),
    ).toEqual({
      skillId: 's',
      versionId: 'v',
      caseId: 'c',
      synthetic: false,
      matched: true,
      applied: false,
      suggestionsOffered: 0,
      suggestionsAccepted: 0,
      timeToDiagnosisMinutes: null,
      baselineTimeToDiagnosisMinutes: null,
      tokenEstimate: null,
      baselineTokenEstimate: null,
      evidenceCompleteness: null,
      baselineEvidenceCompleteness: null,
      conformanceScore: null,
    });
  });
});
