import { describe, expect, it } from 'vitest';
import { DemoStepSchema } from '@caseguard/schemas';
import { deriveSteps } from '../src/services/demo/derive';
import { STEP_SPECS } from '../src/services/demo/steps';
import type { CaseFacts, DemoFacts } from '../src/services/demo/types';

// Words that would turn a description of a route into a judgement of a person (as in the domain tests).
const BLAME =
  /\b(wrong|mistake|poor(ly)?|bad(ly)?|blame\w*|punish\w*|violat\w*|negligen\w*|careless\w*|should have|must have|ignored|neglect\w*|incompeten\w*|underperform\w*|fault\w*|failed to|failure to)\b/i;

const STORY_IDS = [
  'import-case-one',
  'reconstruct-timeline',
  'build-evidence-ledger',
  'compare-hypotheses',
  'find-decision-forks',
  'accept-better-path',
  'calculate-metrics',
  'generate-skill',
  'approve-skill',
  'import-case-two',
  'skill-applies',
  'second-investigation',
  'compare-outcomes',
];

function caseFacts(id: string, overrides: Partial<CaseFacts> = {}): CaseFacts {
  return {
    id,
    reference: `REF-${id}`,
    analyzed: true,
    claimCount: 40,
    hypothesisCount: 3,
    forkCount: 9,
    earliestForkId: 'fork_1',
    acceptedScenarioId: 'scn_1',
    qualityAssessed: true,
    metricCount: 7,
    ...overrides,
  };
}

/** Facts in which exactly the first `n` steps of the story have happened (step 13 comes with step 12). */
function factsThrough(n: number): DemoFacts {
  const caseOne =
    n < 1
      ? null
      : caseFacts('case_one', {
          analyzed: n >= 2,
          claimCount: n >= 3 ? 40 : 0,
          hypothesisCount: n >= 4 ? 3 : 0,
          forkCount: n >= 5 ? 9 : 0,
          acceptedScenarioId: n >= 6 ? 'scn_1' : null,
          qualityAssessed: n >= 7,
          metricCount: n >= 7 ? 7 : 0,
        });
  const skill =
    n < 8
      ? null
      : {
          id: 'skill_1',
          lifecycle: n >= 9 ? ('published' as const) : ('discovered' as const),
          governedPublication: n >= 9,
        };
  const caseTwo =
    n < 10
      ? null
      : caseFacts('case_two', {
          analyzed: n >= 11,
          metricCount: n >= 11 ? 7 : 0,
          qualityAssessed: n >= 11,
        });
  const followUpMatch =
    n < 11 ? null : { applies: true, applied: n >= 12, hasConformance: n >= 12 };
  return { caseOne, caseTwo, skill, followUpMatch };
}

const completedFlags = (n: number): boolean[] =>
  STEP_SPECS.map((_spec, index) => index < n || (n === 12 && index === 12));

describe('[FR-DEMO-01] the 13 steps of the required story', () => {
  const steps = deriveSteps(factsThrough(0));

  it('are the story, in order, each valid for the contract with a persona, notes and an action', () => {
    expect(steps.map((step) => step.id)).toEqual(STORY_IDS);
    expect(steps.map((step) => step.order)).toEqual(STORY_IDS.map((_id, index) => index + 1));
    for (const step of steps) {
      expect(DemoStepSchema.safeParse(step).success, step.id).toBe(true);
      expect(step.presenterNotes.length, step.id).toBeGreaterThan(40);
      expect(step.actionLabel.length, step.id).toBeGreaterThan(3);
    }
    expect(new Set(steps.map((step) => step.persona))).toEqual(
      new Set(['engineer', 'reviewer', 'manager', 'skill_curator']),
    );
  });

  it('describe the route, never the person, and say what is simulated or estimated', () => {
    for (const step of steps) {
      expect(`${step.title} ${step.description} ${step.presenterNotes}`, step.id).not.toMatch(
        BLAME,
      );
    }
    for (const id of [
      'accept-better-path',
      'calculate-metrics',
      'skill-applies',
      'second-investigation',
      'compare-outcomes',
    ]) {
      const step = steps.find((candidate) => candidate.id === id);
      expect(step?.presenterNotes, id).toMatch(/simulated|estimate/i);
    }
  });
});

describe('[FR-DEMO-02] progress comes from stored facts', () => {
  it('starts at step one: only it is enabled and the next action, every later step names why it is locked', () => {
    const steps = deriveSteps(factsThrough(0));
    expect(steps.filter((step) => step.completed)).toEqual([]);
    expect(steps.filter((step) => step.enabled).map((step) => step.order)).toEqual([1]);
    expect(steps.filter((step) => step.isNextAction).map((step) => step.order)).toEqual([1]);
    expect(steps[0]?.lockedReason).toBeNull();
    for (const step of steps.slice(1)) {
      expect(step.lockedReason, step.id).toBe('Complete step 1 first: Import Case One.');
    }
  });

  it.each(Array.from({ length: 13 }, (_unused, n) => n))(
    'marks exactly what the facts show done (%i steps), unlocks in order and has one next action',
    (n) => {
      const steps = deriveSteps(factsThrough(n));
      expect(steps.map((step) => step.completed)).toEqual(completedFlags(n));
      const firstOpen = steps.findIndex((step) => !step.completed);
      // With everything done the closing step is the one next action.
      const nextIndex = firstOpen === -1 ? steps.length - 1 : firstOpen;
      expect(steps.filter((step) => step.isNextAction)).toHaveLength(1);
      expect(steps.findIndex((step) => step.isNextAction)).toBe(nextIndex);
      for (const [index, step] of steps.entries()) {
        const unlocked = step.completed || index === firstOpen;
        expect(step.enabled, step.id).toBe(unlocked);
        if (unlocked) expect(step.lockedReason, step.id).toBeNull();
        else
          expect(step.lockedReason, step.id).toBe(
            `Complete step ${firstOpen + 1} first: ${steps[firstOpen]?.title}.`,
          );
      }
    },
  );

  it('makes the last step the single next action once the whole story is done', () => {
    const steps = deriveSteps(factsThrough(12));
    expect(steps.every((step) => step.completed && step.enabled)).toBe(true);
    expect(steps.filter((step) => step.isNextAction).map((step) => step.id)).toEqual([
      'compare-outcomes',
    ]);
  });

  it('stays incomplete until a scenario of the earliest meaningful fork has been accepted', () => {
    const facts = factsThrough(6);
    const notAccepted: DemoFacts = {
      ...facts,
      caseOne: facts.caseOne === null ? null : { ...facts.caseOne, acceptedScenarioId: null },
    };
    expect(deriveSteps(facts)[5]?.completed).toBe(true);
    expect(deriveSteps(notAccepted)[5]?.completed).toBe(false);
  });

  it('does not count the comparison before the plan was applied, even with metrics on both cases', () => {
    const facts = factsThrough(12);
    const notApplied: DemoFacts = {
      ...facts,
      followUpMatch: { applies: true, applied: false, hasConformance: false },
    };
    const steps = deriveSteps(notApplied);
    expect(steps[11]?.completed).toBe(false);
    expect(steps[12]?.completed).toBe(false);
    expect(steps[10]?.completed).toBe(true);
  });

  it('keeps a completed step open for a visit even when an earlier one is not done', () => {
    const facts = factsThrough(7);
    const outOfOrder: DemoFacts = {
      ...facts,
      caseTwo: caseFacts('case_two', { analyzed: false, metricCount: 0, qualityAssessed: false }),
    };
    const steps = deriveSteps(outOfOrder);
    const caseTwoStep = steps.find((step) => step.id === 'import-case-two');
    expect(caseTwoStep).toMatchObject({ completed: true, enabled: true, lockedReason: null });
    expect(steps.find((step) => step.isNextAction)?.id).toBe('generate-skill');
  });
});

describe('[FR-DEMO-03] deep links', () => {
  it('lead to /cases/new until a case exists, then to its pages, with ids encoded', () => {
    const before = deriveSteps(factsThrough(0));
    expect(before[0]?.route).toBe('/cases/new');
    expect(before[1]?.route).toBe('/cases/new');

    const after = deriveSteps(factsThrough(8));
    expect(after.map((step) => step.route)).toEqual([
      '/cases/case_one',
      '/cases/case_one/timeline',
      '/cases/case_one/evidence',
      '/cases/case_one/hypotheses',
      '/cases/case_one/counterfactual',
      '/cases/case_one/counterfactual',
      '/cases/case_one/quality',
      '/skills/skill_1',
      '/skills/skill_1',
      '/cases/new',
      '/cases/new',
      '/cases/new',
      '/efficiency',
    ]);

    const done = deriveSteps(factsThrough(12));
    expect(done[9]?.route).toBe('/cases/case_two');
    expect(done[10]?.route).toBe('/cases/case_two');
    expect(done[11]?.route).toBe('/cases/case_two/quality');
    // With both cases in place the last step opens their comparison, not a portfolio page.
    expect(done[12]?.route).toBe('/cases/case_two/quality?tab=compare&with=case_one');
  });

  it('send the skill steps to the library before a skill exists, and encode odd ids', () => {
    const steps = deriveSteps(factsThrough(7));
    expect(steps[7]?.route).toBe('/cases/case_one/counterfactual');
    expect(steps[8]?.route).toBe('/skills');

    const odd = factsThrough(1);
    const encoded = deriveSteps({
      ...odd,
      caseOne: odd.caseOne === null ? null : { ...odd.caseOne, id: 'case:one/2' },
    });
    expect(encoded[0]?.route).toBe('/cases/case%3Aone%2F2');
  });
});
