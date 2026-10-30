import { describe, expect, it } from 'vitest';
import {
  CounterfactualScenarioSchema,
  SkillContentSchema,
  SkillDnaSchema,
  SkillVersionSchema,
  type CounterfactualScenario,
} from '@caseguard/schemas';
import {
  deriveSeedSkills,
  extractSkillCandidates,
  generateCounterfactuals,
  type SkillExtractionInput,
} from '../src';
import { CONFIG, eventBySuffix } from './helpers';
import { CASEY, ONE, TWO, makeOp, seeded, toSeedCase } from './skills-fixtures';

const fork = ONE.analysis.forks.find((f) => f.eventId === eventBySuffix(ONE, 'e03').id);
if (!fork) throw new Error('Case One must have a fork at e03');
const generated = generateCounterfactuals({
  analysis: ONE.analysis,
  fork,
  strategies: ['balanced', 'lowest_customer_effort', 'fastest_diagnosis'],
  events: ONE.normalized.events,
  resolution: ONE.normalized.resolution,
  pack: ONE.pack,
  config: CONFIG,
  ctx: ONE.ctx,
  rolloutCount: 60,
});
const accepted = generated.scenarios.map((s) => ({ ...s, reviewState: 'confirmed' as const }));
const baseInput = (over: Partial<SkillExtractionInput> = {}): SkillExtractionInput => ({
  analysis: ONE.analysis,
  fork,
  scenarios: accepted,
  events: ONE.normalized.events,
  resolution: ONE.normalized.resolution,
  pack: ONE.pack,
  config: CONFIG,
  ctx: { ...ONE.ctx, createdBy: 'user_ava_engineer' },
  caseInfo: { workload: ONE.bundle.case.workload, product: ONE.bundle.case.product },
  caseReference: ONE.bundle.case.reference,
  synthetic: true,
  options: { rolloutCount: 60 },
  ...over,
});

describe('SkillDNA extraction from an eligible fork and a valid scenario', () => {
  const { draft } = seeded();
  const content = draft.version.content;

  it('[FR-SK-01] produces a draft that satisfies the shared schemas and starts as Discovered', () => {
    expect(() => SkillDnaSchema.parse(draft.skill)).not.toThrow();
    expect(() => SkillVersionSchema.parse(draft.version)).not.toThrow();
    expect(() => SkillContentSchema.parse(content)).not.toThrow();
    expect(draft.skill.lifecycle).toBe('discovered');
    expect(draft.skill.reviewer).toBeNull();
    expect(draft.skill.validationStatus).toBe('unvalidated');
    expect(draft.version).toMatchObject({
      version: '1.0.0',
      sequence: 1,
      changeType: 'initial',
      state: 'active',
      parentVersionId: null,
    });
    expect(draft.skill.currentVersionId).toBe(draft.version.id);
    expect(draft.skill.synthetic).toBe(true);
  });

  it('[FR-SK-01] distils the isolate-pre-authentication ladder with templates from the pack', () => {
    expect(content.name).toBe(
      'Isolate a pre-authentication failure before pursuing identity policy',
    );
    expect(content.decisionSequence.map((s) => s.actionKey)).toEqual([
      'act.request-minimal-scoping',
      'act.check-service-health',
      'act.signin-log-correlation',
      'act.dns-resolver-comparison',
    ]);
    const byKey = (k: string) => ONE.pack.actions.get(k);
    const kql = content.queryTemplates.find((t) => t.language === 'kql');
    const ps = content.queryTemplates.find((t) => t.language === 'powershell');
    expect(kql?.template).toBe(byKey('act.signin-log-correlation')?.templates.kql);
    expect(ps?.template).toBe(byKey('act.dns-resolver-comparison')?.templates.powershell);
    expect(kql?.parameters.map((p) => p.name)).toContain('window_start_utc');
    expect(content.candidateActions.map((a) => a.actionKey)).toContain('act.proxy-node-comparison');
    const proxy = content.candidateActions.find((a) => a.actionKey === 'act.proxy-node-comparison');
    expect(proxy?.whenToUse).toMatch(/not yet validated/i);
  });

  it('[FR-SK-01] covers every required section: conditions, evidence, safety, alternatives and criteria', () => {
    expect(content.triggerConditions.some((c) => c.required)).toBe(true);
    expect(content.exclusions.map((c) => c.signalId)).toEqual(
      expect.arrayContaining([
        'sig.server-side-failure-records-present',
        'sig.single-user-scope',
        'sig.service-health-incident',
      ]),
    );
    expect(content.minimumEvidence.map((m) => m.requirementId)).toEqual(
      ONE.pack.pack.policies.minimumEvidenceForEscalation,
    );
    expect(content.stopConditions.length).toBeGreaterThan(2);
    expect(content.escalationConditions[0]).toMatch(/minimum evidence/i);
    expect(content.successConditions[0]).toMatch(/consistent with/);
    expect(content.safetyConstraints.join(' ')).toMatch(/never run a remediation/i);
    expect(content.knownFailureModes.length).toBeGreaterThan(0);
    expect(content.cheaperAlternatives?.[0]).toMatchObject({
      insteadOfActionKey: 'act.request-har-capture',
      useActionKey: 'act.request-minimal-scoping',
      estimated: true,
    });
    expect(content.validationCriteria?.length).toBeGreaterThan(3);
    expect(content.applicability?.validatedOnCases).toBe(1);
  });

  it('[FR-SK-01] labels every estimate: confidence, branch probabilities, benefit', () => {
    expect(content.confidence.score).toBeLessThanOrEqual(0.6);
    expect(content.confidence.rationale).toMatch(/model estimate/i);
    const benefit = content.expectedBenefit;
    expect(benefit?.estimated).toBe(true);
    expect(benefit?.simulated).toBe(true);
    expect(benefit?.caveats.join(' ')).toMatch(/estimated, not measured/i);
    for (const range of [benefit?.timeSavedMinutes, benefit?.customerEffortSavedMinutes]) {
      expect(range?.low).toBeLessThanOrEqual(range?.mid ?? 0);
      expect(range?.mid).toBeLessThanOrEqual(range?.high ?? 0);
    }
    expect(benefit?.timeSavedMinutes.mid).toBeGreaterThan(0);
    for (const step of content.decisionSequence) {
      const total = step.branches.reduce((s, b) => s + (b.probability ?? 0), 0);
      const given = step.branches.reduce((s, b) => s + (b.hindsightProbability ?? 0), 0);
      expect(Math.abs(total - 1)).toBeLessThan(0.02);
      expect(Math.abs(given - 1)).toBeLessThan(0.02);
    }
  });

  it('[FR-CF-02] triggers are observable at the decision time and the hindsight parts are marked', () => {
    const observedAtFork = new Set(
      ONE.analysis.evidence
        .filter((e) => fork.informationAvailable.evidenceIds.includes(e.id))
        .map((e) => e.signalId),
    );
    const required = content.triggerConditions.filter((c) => c.required);
    expect(required.length).toBeGreaterThan(0);
    for (const c of required) expect(observedAtFork.has(c.signalId ?? '')).toBe(true);
    const hindsightTriggers = content.triggerConditions.filter((c) =>
      /hindsight-informed/.test(c.description),
    );
    expect(hindsightTriggers.length).toBeGreaterThan(0);
    for (const c of hindsightTriggers) expect(c.required).toBe(false);

    const p = draft.provenance;
    expect(p.hindsight).toMatchObject({
      used: true,
      resolutionHypothesisKey: 'hyp.dns-resolution',
    });
    // The notice has to stay true of the code; `skills-hindsight.test.ts` pins every clause against matching.
    expect(p.hindsight.notice).toMatch(/do take part in matching/);
    expect(p.hindsight.notice).toMatch(/only against what the matched case had recorded/);
    expect(p.hindsight.notice).toMatch(
      /branch probabilities and the other listed parts never decide/,
    );
    expect(p.hindsight.parts).toEqual(
      expect.arrayContaining([
        'exclusions',
        'decisionSequence.*.branches.hindsightProbability',
        'expectedBenefit',
      ]),
    );
    for (const c of hindsightTriggers)
      expect(p.hindsight.parts).toContain(`triggerConditions.${c.id}`);
    for (const c of required) expect(p.decisionTimeParts).toContain(`triggerConditions.${c.id}`);
    expect(p).toMatchObject({
      caseId: ONE.ctx.caseId,
      forkId: fork.id,
      analysisRunId: ONE.ctx.runId,
      labels: { simulated: true, estimated: true, synthetic: true },
    });
    expect(content.sourceCases[0]).toMatchObject({ caseId: ONE.ctx.caseId, role: 'origin' });
    expect(content.sourceCases[0]?.reference).toContain(fork.id);
    expect(content.provenance).toEqual(p);
  });

  it('never copies case identifiers (users, resolver addresses, node names) into the skill', () => {
    const text = JSON.stringify(content);
    expect(text).not.toMatch(
      /contoso-synthetic\.invalid|10\.20\.1\.\d+|u\.patel|c\.ellis|m\.rao|proxy-rtm/i,
    );
  });

  it('[FR-SK-01] is deterministic: the same inputs give identical drafts and ids', () => {
    const a = extractSkillCandidates(baseInput());
    const b = extractSkillCandidates(baseInput());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.candidates.length).toBeGreaterThanOrEqual(1);
    expect(a.candidates.length).toBeLessThanOrEqual(3);
    const ids = a.candidates.map((c) => c.skill.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(a.candidates[0]?.skill.id).toMatch(/^skl_[a-f0-9]{24}$/);
  });

  it('[FR-SK-01] the seed derivation is a pure, reproducible function of the two synthetic cases', () => {
    const again = deriveSeedSkills({
      caseOne: toSeedCase(ONE),
      caseTwo: toSeedCase(TWO),
      proposer: CASEY,
      op: makeOp('seed'),
      rolloutCount: 60,
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(JSON.stringify(again.value)).toBe(JSON.stringify(seeded()));
    expect(again.value.draft.skill.lifecycle).toBe('discovered');
    expect(again.value.previewMutation?.version.state).toBe('proposed');
    expect(again.value.previewMutation?.version.changeType).toBe('mutation');
  });
});

describe('extraction refusals (never from rejected, invalid or ineligible inputs)', () => {
  const scenario = accepted[0] as CounterfactualScenario;
  const reasonsOf = (input: SkillExtractionInput) =>
    extractSkillCandidates(input)
      .refusals.flatMap((r) => r.reasons)
      .join(' | ');

  it('[FR-SK-01] the scenarios used here satisfy the scenario contract', () => {
    for (const s of accepted) expect(() => CounterfactualScenarioSchema.parse(s)).not.toThrow();
  });

  it('refuses a rejected scenario', () => {
    const result = extractSkillCandidates(
      baseInput({ scenarios: [{ ...scenario, reviewState: 'rejected' }] }),
    );
    expect(result.candidates).toHaveLength(0);
    expect(reasonsOf(baseInput({ scenarios: [{ ...scenario, reviewState: 'rejected' }] }))).toMatch(
      /rejected this scenario/,
    );
  });

  it('refuses invalid, failed or leaky scenarios', () => {
    const invalid = { ...scenario, validity: { ...scenario.validity, valid: false } };
    const failed = { ...scenario, status: 'failed' as const };
    const leaky = {
      ...scenario,
      boundary: {
        ...scenario.boundary,
        leakCheck: { ...scenario.boundary.leakCheck, passed: false, futureReferencesFound: 2 },
      },
    };
    for (const s of [invalid, failed, leaky]) {
      expect(extractSkillCandidates(baseInput({ scenarios: [s] })).candidates).toHaveLength(0);
    }
    expect(reasonsOf(baseInput({ scenarios: [invalid] }))).toMatch(/validity checks/);
    expect(reasonsOf(baseInput({ scenarios: [failed] }))).toMatch(/not completed/);
    expect(reasonsOf(baseInput({ scenarios: [leaky] }))).toMatch(/leak check/);
  });

  it('refuses an ineligible or rejected fork', () => {
    const ineligible = {
      ...fork,
      eligibility: {
        ...fork.eligibility,
        eligible: false,
        reasons: ['Impact below the threshold.'],
      },
    };
    expect(extractSkillCandidates(baseInput({ fork: ineligible })).candidates).toHaveLength(0);
    expect(reasonsOf(baseInput({ fork: ineligible }))).toMatch(/not eligible/);
    expect(
      extractSkillCandidates(baseInput({ fork: { ...fork, reviewState: 'rejected' } })).candidates,
    ).toHaveLength(0);
  });

  it('requires reviewer acceptance by default and allows pending scenarios only when told to', () => {
    const pending = [{ ...scenario, reviewState: 'pending' as const }];
    expect(extractSkillCandidates(baseInput({ scenarios: pending })).candidates).toHaveLength(0);
    expect(reasonsOf(baseInput({ scenarios: pending }))).toMatch(/not been accepted/);
    const relaxed = extractSkillCandidates(
      baseInput({
        scenarios: pending,
        options: { requireAcceptedReview: false, rolloutCount: 60 },
      }),
    );
    expect(relaxed.candidates).toHaveLength(1);
    expect(relaxed.candidates[0]?.skill.lifecycle).toBe('discovered');
  });

  it('refuses a case without a validated resolution and a scenario from another fork', () => {
    expect(reasonsOf(baseInput({ resolution: null }))).toMatch(/no recorded resolution/);
    const unvalidated = ONE.normalized.resolution && {
      ...ONE.normalized.resolution,
      validation: ONE.normalized.resolution.validation && {
        ...ONE.normalized.resolution.validation,
        outcome: 'partial' as const,
      },
    };
    expect(reasonsOf(baseInput({ resolution: unvalidated }))).toMatch(/not validated as confirmed/);
    expect(reasonsOf(baseInput({ scenarios: [{ ...scenario, forkId: 'fork_other' }] }))).toMatch(
      /different fork/,
    );
    expect(
      extractSkillCandidates(baseInput({ scenarios: [] })).refusals[0]?.reasons.join(' '),
    ).toMatch(/No scenario/);
  });
});
