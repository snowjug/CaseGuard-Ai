import { describe, expect, it } from 'vitest';
import {
  CounterfactualQualitySchema,
  CounterfactualScenarioSchema,
  type CounterfactualScenario,
  type CounterfactualStrategy,
  type KnowledgeAction,
} from '@caseguard/schemas';
import {
  assessScenarioQuality,
  basisOf,
  generateCounterfactuals,
  illustrativeReason,
  MIN_DIAGNOSIS_SHARE,
  RELIABILITY_FLOOR,
  skillApplicabilityFor,
  stepFeasibility,
  withSkillApplicability,
  type FeasibilityInput,
  type ScenarioQualityInput,
} from '../src';
import { CASE_ONE, CONFIG, eventBySuffix, prepareCase } from './helpers';

const p = prepareCase(CASE_ONE);
const STRATEGIES: CounterfactualStrategy[] = [
  'balanced',
  'lowest_customer_effort',
  'fastest_diagnosis',
];

const fork = p.analysis.forks.find((f) => f.eventId === eventBySuffix(p, 'e09').id);
if (!fork) throw new Error('the sample has no fork at e09');
const scenarios = generateCounterfactuals({
  analysis: p.analysis,
  fork,
  strategies: STRATEGIES,
  events: p.normalized.events,
  resolution: p.normalized.resolution,
  pack: p.pack,
  config: CONFIG,
  ctx: p.ctx,
  rolloutCount: 60,
}).scenarios;

const actions = [...p.pack.actions.values()];
const readOnlyEngineerAction = actions.find(
  (a) => a.executor === 'engineer' && a.operationalRisk === 0 && !a.destructive,
) as KnowledgeAction;
const customerAction = actions.find((a) => a.executor.startsWith('customer')) as KnowledgeAction;

const easy = (over: Partial<KnowledgeAction> = {}): KnowledgeAction => ({
  ...readOnlyEngineerAction,
  requires: [],
  requiresApproval: false,
  destructive: false,
  operationalRisk: 0,
  reliability: 0.95,
  ...over,
});

const feasibilityInput = (over: Partial<FeasibilityInput> = {}): FeasibilityInput => ({
  riskCeiling: 0.5,
  availableAtBoundary: new Set(),
  producedEarlier: new Map(),
  requirementLabel: (id) => `the “${id}” evidence`,
  ...over,
});

describe('whether a step could have been taken (stepFeasibility)', () => {
  it('a read-only engineer step with nothing to wait for is feasible and says nothing', () => {
    expect(stepFeasibility(easy(), feasibilityInput())).toEqual({
      level: 'feasible',
      conditions: [],
    });
  });

  it('a step the customer has to do depends on them, with the time the estimate assumes', () => {
    const result = stepFeasibility(easy({ ...customerAction }), feasibilityInput());
    expect(result.level).toBe('feasible_with_conditions');
    const { min, typical, max } = customerAction.timeMinutes;
    expect(result.conditions.join(' ')).toContain(
      `about ${typical} minutes (between ${min} and ${max})`,
    );
  });

  it('a step that needs approval, or is not read-only, or often fails is conditional', () => {
    expect(stepFeasibility(easy({ requiresApproval: true }), feasibilityInput())).toMatchObject({
      level: 'feasible_with_conditions',
      conditions: ['Someone has to approve it before it is run.'],
    });
    expect(stepFeasibility(easy({ operationalRisk: 0.2 }), feasibilityInput())).toMatchObject({
      level: 'feasible_with_conditions',
      conditions: [expect.stringMatching(/not read-only \(risk about 20%\)/)],
    });
    expect(
      stepFeasibility(easy({ reliability: RELIABILITY_FLOOR - 0.2 }), feasibilityInput()),
    ).toMatchObject({
      level: 'feasible_with_conditions',
      conditions: [expect.stringMatching(/usable result in about 50% of attempts/)],
    });
  });

  it('a destructive step, or one at the risk ceiling, is not feasible', () => {
    expect(stepFeasibility(easy({ destructive: true }), feasibilityInput()).level).toBe(
      'not_feasible',
    );
    const atCeiling = stepFeasibility(easy({ operationalRisk: 0.5 }), feasibilityInput());
    expect(atCeiling.level).toBe('not_feasible');
    expect(atCeiling.conditions.join(' ')).toMatch(/at or above the ceiling/);
  });

  it('a prerequisite that held, that an earlier step produces, or that nobody provides', () => {
    const needs = easy({ requires: ['req.sample-users'] });
    expect(
      stepFeasibility(
        needs,
        feasibilityInput({ availableAtBoundary: new Set(['req.sample-users']) }),
      ).level,
    ).toBe('feasible');

    const later = stepFeasibility(
      needs,
      feasibilityInput({
        producedEarlier: new Map([['req.sample-users', 'Ask for scoping data']]),
      }),
    );
    expect(later.level).toBe('feasible_with_conditions');
    expect(later.conditions[0]).toMatch(/comes from “Ask for scoping data” earlier in the path/);

    const missing = stepFeasibility(needs, feasibilityInput());
    expect(missing.level).toBe('not_feasible');
    expect(missing.conditions[0]).toMatch(/no earlier step of the path produces/);
  });

  it('the worst condition decides the level, and the list is bounded', () => {
    const result = stepFeasibility(
      easy({
        ...customerAction,
        requiresApproval: true,
        destructive: true,
        requires: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
        reliability: 0.1,
      }),
      feasibilityInput(),
    );
    expect(result.level).toBe('not_feasible');
    expect(result.conditions.length).toBeLessThanOrEqual(8);
  });
});

describe('what a generated path rests on', () => {
  it('every scenario of the sample carries a valid quality block and a feasibility for each step', () => {
    expect(scenarios).toHaveLength(3);
    for (const scenario of scenarios) {
      expect(() => CounterfactualScenarioSchema.parse(scenario)).not.toThrow();
      expect(() => CounterfactualQualitySchema.parse(scenario.quality)).not.toThrow();
      for (const step of scenario.steps) expect(step.feasibility).toBeDefined();
    }
  });

  it('the recorded side is measured; no part of the alternative is measured or a model estimate', () => {
    for (const scenario of scenarios) {
      const parts = scenario.quality?.basis.parts ?? [];
      const recorded = parts.filter((part) => part.what.startsWith('Recorded path: elapsed'));
      expect(recorded.map((part) => part.basis)).toEqual(['measured']);
      for (const part of parts.filter((part) => part.what.startsWith('Alternative path'))) {
        expect(part.basis).toBe(scenario.quality?.basis.scenario);
        expect(['deterministic_estimate', 'illustrative']).toContain(part.basis);
      }
    }
  });

  it('an estimate claims a range and an illustration claims no saving, by the same rule', () => {
    for (const scenario of scenarios) {
      const reason = illustrativeReason({
        steps: scenario.steps,
        validity: scenario.validity,
        rollouts: scenario.rollouts,
      });
      const quality = scenario.quality as NonNullable<CounterfactualScenario['quality']>;
      expect(quality.basis.scenario).toBe(
        reason === null ? 'deterministic_estimate' : 'illustrative',
      );
      expect(quality.timeSavedClaim).toBe(reason === null ? 'estimated_range' : 'none');
      expect(basisOf(scenario)).toBe(quality.basis.scenario);
    }
  });

  it('the path level is the worst step, and each reason names its step', () => {
    for (const scenario of scenarios) {
      const rank = { feasible: 0, feasible_with_conditions: 1, not_feasible: 2 } as const;
      const worst = scenario.steps.reduce(
        (level, step) =>
          rank[step.feasibility?.level ?? 'feasible'] > rank[level]
            ? (step.feasibility?.level ?? 'feasible')
            : level,
        'feasible' as keyof typeof rank,
      );
      expect(scenario.quality?.feasibility.level).toBe(worst);
      for (const reason of scenario.quality?.feasibility.reasons ?? []) {
        expect(reason).toMatch(/^Step \d+ \(.+\): /);
      }
    }
  });

  it('nothing it says claims an exact or guaranteed saving', () => {
    const overclaim =
      /\b(exactly|precisely|guarantee[ds]?|certain(?:ly)?|definitely|proves?|proven|will save|would have saved)\b/i;
    for (const scenario of scenarios) {
      const quality = scenario.quality as NonNullable<CounterfactualScenario['quality']>;
      const texts = [
        scenario.summary,
        quality.basis.summary,
        ...quality.basis.parts.flatMap((part) => [part.what, part.note]),
        ...quality.feasibility.reasons,
        ...quality.constraints,
        ...quality.validation,
        quality.skillApplicability.note,
      ];
      for (const text of texts) expect(text, text).not.toMatch(overclaim);
      expect(quality.validation.join(' ')).toMatch(/ranges?; do not quote a single figure/);
    }
  });
});

describe('when a path is an illustration and not an estimate', () => {
  const real = scenarios[0] as CounterfactualScenario;
  const input = (over: Partial<ScenarioQualityInput> = {}): ScenarioQualityInput => ({
    strategy: 'balanced',
    steps: real.steps,
    actions: real.steps.map((step) => p.pack.actions.get(step.actionKey) as KnowledgeAction),
    validity: { valid: true, checks: [] },
    comparison: { level: 'medium', score: 0.6 },
    rollouts: { count: 60, seed: 's', diagnosisReachedShare: 0.9 },
    eventCount: 5,
    ...over,
  });

  it('a path that reached a diagnosis in most runs is a computed estimate', () => {
    const quality = assessScenarioQuality(input());
    expect(quality.basis.scenario).toBe('deterministic_estimate');
    expect(quality.timeSavedClaim).toBe('estimated_range');
    expect(quality.validation[0]).not.toMatch(/Do not use this path/);
  });

  it('too few runs reaching a diagnosis makes it an illustration with no saving claimed', () => {
    const quality = assessScenarioQuality(
      input({
        rollouts: { count: 60, seed: 's', diagnosisReachedShare: MIN_DIAGNOSIS_SHARE - 0.01 },
      }),
    );
    expect(quality.basis.scenario).toBe('illustrative');
    expect(quality.timeSavedClaim).toBe('none');
    expect(quality.basis.summary).toMatch(/only 49% of 60 simulated runs/);
    expect(quality.validation[0]).toMatch(/^Do not use this path to estimate a saving/);
  });

  it('a failed validity check, or no step at all, is an illustration that names why', () => {
    const failed = assessScenarioQuality(
      input({
        validity: {
          valid: false,
          checks: [
            { id: 'steps-safe', passed: false, detail: 'x' },
            { id: 'reproducible', passed: true, detail: 'y' },
          ],
        },
      }),
    );
    expect(failed.basis.scenario).toBe('illustrative');
    expect(failed.basis.summary).toMatch(/a validity check failed \(steps-safe\)/);

    const empty = assessScenarioQuality(input({ steps: [], actions: [] }));
    expect(empty.basis.scenario).toBe('illustrative');
    expect(empty.basis.summary).toMatch(/no supported next step could be ranked/);
    expect(empty.feasibility.level).toBe('feasible');
  });

  it('constraints name the strategy, the customer and approval, and validation follows them', () => {
    const balanced = assessScenarioQuality(input());
    const effort = assessScenarioQuality(input({ strategy: 'lowest_customer_effort' }));
    const fastest = assessScenarioQuality(input({ strategy: 'fastest_diagnosis' }));
    expect(effort.constraints.length).toBe(balanced.constraints.length + 1);
    expect(effort.constraints[0]).toMatch(/leaves out steps that ask a lot of the customer/);
    expect(fastest.constraints[0]).toMatch(/favours elapsed time/);
    expect(balanced.constraints[0]).toMatch(/Only what was recorded before the decision moment/);

    const needsCustomer = assessScenarioQuality(
      input({ steps: real.steps.slice(0, 1), actions: [customerAction] }),
    );
    expect(needsCustomer.constraints.join(' ')).toMatch(/1 step depends on the customer/);
    expect(needsCustomer.validation.join(' ')).toMatch(/customer could have done step 1/);

    const approval = assessScenarioQuality(
      input({
        steps: [real.steps[0], real.steps[0]] as CounterfactualScenario['steps'],
        actions: [easy({ requiresApproval: true }), easy({ requiresApproval: true })],
      }),
    );
    expect(approval.constraints.join(' ')).toMatch(/2 steps need approval before they can be run/);
    expect(approval.validation.join(' ')).toMatch(/Get the approval step 1/);
  });
});

describe('whether a skill would have helped at the decision moment', () => {
  type Match = Parameters<typeof skillApplicabilityFor>[1][number];
  const path = (evidenceIds: string[], firstAction = 'act.first') => ({
    boundary: { evidenceIds },
    steps: [{ actionKey: firstAction }, { actionKey: 'act.second' }],
  });
  const trigger = (id: string, weight: number, evidenceIds: string[]) => ({
    id,
    description: id,
    weight,
    evidenceIds,
  });
  const step = (actionKey: string | null) => ({
    stepId: 's',
    title: 't',
    instruction: 'i',
    actionKey,
    status: 'recommended_next' as const,
    rationale: 'r',
    actionValue: null,
  });
  const match = (over: Partial<Match> = {}): Match => ({
    skillId: 'skl_a',
    skillName: 'Isolate a pre-authentication failure',
    applicability: 'applies',
    matchedTriggers: [trigger('t1', 0.6, ['evd_1']), trigger('t2', 0.4, ['evd_2'])],
    unmatchedTriggers: [],
    exclusionsHit: [],
    recommendedSteps: [step('act.first')],
    ...over,
  });

  it('with no skill, or none resembling the case then, there is no matching skill', () => {
    expect(skillApplicabilityFor(path(['evd_1', 'evd_2']), []).status).toBe('no_matching_skill');
    expect(
      skillApplicabilityFor(path(['evd_1', 'evd_2']), [
        match({ applicability: 'not_applicable' }),
        match({ skillId: 'skl_b', exclusionsHit: [{ id: 'x', description: 'x' }] }),
      ]).status,
    ).toBe('no_matching_skill');
  });

  it('a skill whose triggers held and which recommends the first step applies', () => {
    const result = skillApplicabilityFor(path(['evd_1', 'evd_2']), [match()]);
    expect(result.status).toBe('applies');
    expect(result.skills).toEqual([
      {
        skillId: 'skl_a',
        name: 'Isolate a pre-authentication failure',
        triggerCoverage: 1,
        recommendsFirstStep: true,
      },
    ]);
    expect(result.note).toContain('Isolate a pre-authentication failure');
  });

  it('a skill that recommends another first step, or whose triggers only partly held, partially applies', () => {
    expect(
      skillApplicabilityFor(path(['evd_1', 'evd_2']), [
        match({ recommendedSteps: [step('act.other')] }),
      ]).status,
    ).toBe('partially_applies');
    const partial = skillApplicabilityFor(path(['evd_1']), [match()]);
    expect(partial.status).toBe('partially_applies');
    expect(partial.skills[0]?.triggerCoverage).toBe(0.6);
  });

  it('a trigger counts only when all its evidence was recorded before the decision moment', () => {
    // evd_2 was recorded after the boundary, and a trigger with no evidence behind it is not counted.
    const result = skillApplicabilityFor(path(['evd_1']), [
      match({ matchedTriggers: [trigger('t1', 0.3, ['evd_1']), trigger('t2', 0.7, ['evd_2'])] }),
      match({ skillId: 'skl_b', matchedTriggers: [trigger('t3', 1, [])] }),
    ]);
    expect(result.status).toBe('no_matching_skill');
  });

  it('lists at most five skills, best first, and leaves the path unchanged', () => {
    const many = ['e', 'a', 'd', 'b', 'c', 'f'].map((id, index) =>
      match({
        skillId: `skl_${id}`,
        matchedTriggers: [trigger('t', 1, ['evd_1'])],
        unmatchedTriggers: index === 0 ? [{ id: 'u', description: 'u', weight: 0.5 }] : [],
      }),
    );
    const result = skillApplicabilityFor(path(['evd_1']), many);
    expect(result.skills).toHaveLength(5);
    expect(result.skills.map((skill) => skill.skillId)).toEqual([
      'skl_a',
      'skl_b',
      'skl_c',
      'skl_d',
      'skl_f',
    ]);
  });

  it('sets only the skill part of a scenario, and leaves a scenario without a quality block alone', () => {
    const base = scenarios[0] as CounterfactualScenario;
    const annotated = withSkillApplicability(base, [
      match({
        recommendedSteps: [step(base.steps[0]?.actionKey ?? null)],
        matchedTriggers: [trigger('t1', 1, base.boundary.evidenceIds.slice(0, 1))],
      }),
    ]);
    expect(annotated.quality?.skillApplicability.status).toBe(
      base.boundary.evidenceIds.length > 0 ? 'applies' : 'no_matching_skill',
    );
    expect({ ...annotated, quality: undefined }).toEqual({ ...base, quality: undefined });
    expect({ ...annotated.quality, skillApplicability: undefined }).toEqual({
      ...base.quality,
      skillApplicability: undefined,
    });

    const { quality: _unused, ...legacy } = base;
    expect(withSkillApplicability(legacy as CounterfactualScenario, [match()])).toBe(legacy);
  });
});
