import { describe, expect, it } from 'vitest';
import {
  SKILL_LIFECYCLE,
  SkillMatchSchema,
  SkillMatchStepSchema,
  type SkillCondition,
  type SkillContent,
  type SkillLifecycle,
} from '@caseguard/schemas';
import {
  APPLIES_THRESHOLD,
  MATCHABLE_LIFECYCLES,
  PARTIAL_THRESHOLD,
  applySkillChangeSet,
  hashJson,
  matchSkills,
  toMatchSteps,
  transitionSkill,
  type MatchableSkill,
} from '../src';
import { applicabilityOf, type TriggerScore } from '../src/skills/matching';
import { CONFIG } from './helpers';
import {
  CASEY,
  IRRELEVANT,
  TWO,
  asOf,
  caseInfoOf,
  first,
  makeOp,
  matchAt,
  matchableOf,
  publishedAggregate,
  withPoisonedFuture,
  withoutFuture,
} from './skills-fixtures';

const published = publishedAggregate();
const seedSkill = matchableOf(published);

const variant = (
  key: string,
  lifecycle: SkillLifecycle,
  edit: (content: SkillContent) => void = () => undefined,
): MatchableSkill => {
  const content = structuredClone(seedSkill.version.content);
  edit(content);
  return {
    skill: { ...seedSkill.skill, id: `skill_${key}`, key, lifecycle },
    version: {
      ...seedSkill.version,
      id: `skv_${key}`,
      skillId: `skill_${key}`,
      content,
      contentHash: hashJson(content),
    },
  };
};

const condition = (id: string, over: Partial<SkillCondition> = {}): SkillCondition => ({
  id,
  description: `Condition ${id}`,
  kind: 'signal',
  signalId: 'sig.synthetic',
  weight: 0.5,
  required: false,
  ...over,
});
const score = (over: Partial<TriggerScore>): TriggerScore => ({
  matched: [],
  unmatched: [],
  requiredUnmet: [],
  exclusionsHit: [],
  coverage: 0,
  ...over,
});

describe('matching a skill against the evidence known as of a moment', () => {
  it('[FR-SK-05] explains a match: which triggers hold, with evidence, and which do not', () => {
    const t = asOf(TWO, 'g01');
    const set = matchAt(TWO, t);
    const match = first(set.matches);
    expect(() => SkillMatchSchema.parse(match)).not.toThrow();
    expect(match).toMatchObject({
      applicability: 'applies',
      lifecycle: 'published',
      asOf: t,
      applied: false,
      conformance: null,
    });
    expect(match.score).toBeGreaterThanOrEqual(APPLIES_THRESHOLD);
    expect(match.matchedTriggers.map((m) => m.id)).toEqual(
      expect.arrayContaining([
        'trg-multiple-users-affected',
        'trg-intermittent-failures',
        'trg-site-correlated',
        'trg-recent-network-change-reported',
      ]),
    );
    const unmet = first(match.unmatchedTriggers);
    expect(unmet.id).toBe('trg-error-name-not-resolved');
    expect(match.rationale).toContain(`Not met yet: ${unmet.description}`);
    expect(match.rationale).toMatch(
      /model estimate from the evidence at this moment, not a measurement/,
    );
    expect(match.exclusionsHit).toEqual([]);
    expect(set.excluded).toEqual([]);
  });

  it('[FR-SK-05] every piece of supporting evidence was observed at or before the match time', () => {
    const t = asOf(TWO, 'g02');
    const seen = new Map(TWO.analysis.observations.map((o) => [o.id, o.timestamp]));
    const trigger = first(
      first(matchAt(TWO, t).matches).matchedTriggers.filter((m) => m.evidenceIds.length > 0),
    );
    for (const m of first(matchAt(TWO, t).matches).matchedTriggers) {
      for (const id of m.evidenceIds) {
        const at = seen.get(id);
        expect(at, `${m.id} cites ${id}`).toBeDefined();
        expect((at ?? '') <= t).toBe(true);
      }
    }
    expect(trigger.evidenceIds.length).toBeGreaterThan(0);
  });

  it('[FR-SK-05] before the first event nothing is known, so the skill cannot apply', () => {
    const match = first(matchAt(TWO, '2026-04-14T07:34:59Z').matches);
    expect(match.applicability).toBe('not_applicable');
    expect(match.matchedTriggers).toEqual([]);
    expect(match.score).toBeLessThan(PARTIAL_THRESHOLD);
  });

  it('[FR-SK-05] an exclusion explains why an unrelated case does not match, and no plan is produced', () => {
    const set = matchAt(IRRELEVANT, asOf(IRRELEVANT, 'x01'));
    const match = first(set.matches);
    expect(match).toMatchObject({
      applicability: 'not_applicable',
      score: 0,
      recommendedSteps: [],
    });
    expect(match.exclusionsHit.map((e) => e.id)).toContain('exc-single-user-scope');
    expect(match.rationale).toMatch(/Excluded because/);
    expect(set.plans).toEqual({});
    expect(() => SkillMatchSchema.parse(match)).not.toThrow();
  });

  it('[FR-SK-05] a case of another workload never matches, whatever its evidence', () => {
    const set = matchSkills({
      skills: [seedSkill],
      analysisAsOf: TWO.analysis,
      asOf: asOf(TWO, 'g02'),
      pack: TWO.pack,
      config: CONFIG,
      ctx: TWO.ctx,
      caseInfo: { ...caseInfoOf(TWO), workload: 'exchange-mail-flow' },
    });
    const match = first(set.matches);
    expect(match).toMatchObject({ applicability: 'not_applicable', score: 0 });
    expect(match.rationale).toMatch(/covers the teams-authentication workload/);
    expect(set.plans).toEqual({});
  });

  it('[FR-SK-05] thresholds: applies from 70%, partial from 35%, a required miss or an exclusion rules the skill out', () => {
    expect(applicabilityOf(score({ coverage: APPLIES_THRESHOLD }))).toEqual({
      applicability: 'applies',
      score: APPLIES_THRESHOLD,
    });
    expect(applicabilityOf(score({ coverage: 0.699 })).applicability).toBe('partial');
    expect(applicabilityOf(score({ coverage: PARTIAL_THRESHOLD })).applicability).toBe('partial');
    expect(applicabilityOf(score({ coverage: 0.349 })).applicability).toBe('not_applicable');
    expect(
      applicabilityOf(
        score({ coverage: 0.9, requiredUnmet: [condition('r', { required: true })] }),
      ),
    ).toEqual({
      applicability: 'not_applicable',
      score: 0.45,
    });
    expect(applicabilityOf(score({ coverage: 1, exclusionsHit: [condition('x')] }))).toEqual({
      applicability: 'not_applicable',
      score: 0,
    });
  });

  it('[FR-SK-05] every skill gets a verdict, ranked best first, and an unmet required trigger is named', () => {
    const strict = variant('strict', 'published', (c) => {
      c.triggerConditions = c.triggerConditions.map((t) =>
        t.id === 'trg-error-name-not-resolved' ? { ...t, required: true } : t,
      );
    });
    const pilot = variant('pilot', 'pilot');
    const set = matchAt(TWO, asOf(TWO, 'g02'), [strict, seedSkill, pilot]);
    expect(set.matches).toHaveLength(3);
    const scores = set.matches.map((m) => m.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    const strictMatch = set.matches.find((m) => m.skillId === strict.skill.id);
    expect(strictMatch?.applicability).toBe('not_applicable');
    expect(strictMatch?.rationale).toMatch(/A required condition is not met: .*/);
    expect(set.matches.find((m) => m.skillId === pilot.skill.id)?.rationale).toMatch(
      /Pilot skill: not yet validated for general use/,
    );
    expect(Object.keys(set.plans).sort()).toEqual([pilot.skill.id, seedSkill.skill.id].sort());
    set.matches.forEach((m) => expect(() => SkillMatchSchema.parse(m)).not.toThrow());
  });

  it('[FR-SK-05] only pilot, validated and published skills ever match', () => {
    expect(MATCHABLE_LIFECYCLES).toEqual(['pilot', 'validated', 'published']);
    for (const lifecycle of SKILL_LIFECYCLE) {
      const set = matchAt(TWO, asOf(TWO, 'g02'), [variant(`lc-${lifecycle}`, lifecycle)]);
      if (MATCHABLE_LIFECYCLES.includes(lifecycle)) {
        expect(set.matches, lifecycle).toHaveLength(1);
        expect(set.excluded).toEqual([]);
      } else {
        expect(set.matches, lifecycle).toEqual([]);
        expect(set.plans).toEqual({});
        expect(first(set.excluded)).toMatchObject({ lifecycle });
      }
    }
  });

  it('[FR-SK-05] a skill deprecated or retired through the real transitions never matches again', () => {
    const op = makeOp('retire');
    const step = (aggregate: typeof published, to: 'deprecated' | 'retired') => {
      const result = transitionSkill({
        aggregate,
        request: {
          toState: to,
          reason: `Moving to ${to} after review.`,
          expectedVersion: aggregate.skill.version,
        },
        actor: CASEY,
        op,
      });
      if (!result.ok) throw new Error(result.error.message);
      return applySkillChangeSet(aggregate, result.value);
    };
    const deprecated = step(published, 'deprecated');
    const afterDeprecation = matchAt(TWO, asOf(TWO, 'g02'), [matchableOf(deprecated)]);
    expect(afterDeprecation.matches).toEqual([]);
    expect(first(afterDeprecation.excluded).reason).toMatch(
      /deprecated and retired skills never match/,
    );
    const retired = step(deprecated, 'retired');
    const afterRetirement = matchAt(TWO, asOf(TWO, 'g02'), [matchableOf(retired)]);
    expect(afterRetirement.matches).toEqual([]);
    expect(first(afterRetirement.excluded)).toMatchObject({ lifecycle: 'retired' });
  });

  it('[FR-SK-05] the recommended steps in a match satisfy the contract', () => {
    const set = matchAt(TWO, asOf(TWO, 'g01'));
    const match = first(set.matches);
    expect(match.recommendedSteps.length).toBe(5);
    match.recommendedSteps.forEach((s) =>
      expect(() => SkillMatchStepSchema.parse(s)).not.toThrow(),
    );
    expect(match.recommendedSteps).toEqual(toMatchSteps(set.plans[match.skillId] ?? { steps: [] }));
    expect(first(match.recommendedSteps)).toMatchObject({
      actionKey: 'act.request-minimal-scoping',
      status: 'recommended_next',
    });
  });
});

describe('strict temporal integrity of matching', () => {
  const instants = ['g01', 'g02', 'g04', 'g06', 'g08', 'g09'] as const;

  it.each(instants)(
    '[FR-SK-05] rewriting every later event and the resolution never changes the decision at %s',
    (suffix) => {
      const t = asOf(TWO, suffix);
      expect(matchAt(TWO, t, undefined, withPoisonedFuture(TWO, t))).toEqual(matchAt(TWO, t));
    },
  );

  it.each(instants)(
    '[FR-SK-05] deleting every later event and the resolution gives the same decision at %s',
    (suffix) => {
      const t = asOf(TWO, suffix);
      expect(matchAt(TWO, t, undefined, withoutFuture(TWO, t))).toEqual(matchAt(TWO, t));
    },
  );

  it('[FR-SK-05] the rewrite is not vacuous: once its events fall inside the window the decision changes', () => {
    const rewrittenFrom = asOf(TWO, 'g02');
    const later = first(
      matchAt(TWO, asOf(TWO, 'g06'), undefined, withPoisonedFuture(TWO, rewrittenFrom)).matches,
    );
    expect(later).toMatchObject({ applicability: 'not_applicable', score: 0 });
    expect(later.exclusionsHit.map((e) => e.id)).toContain('exc-single-user-scope');
  });

  it('[FR-SK-05] the match instant is inclusive: an event at exactly T counts, the next one does not', () => {
    const g01 = asOf(TWO, 'g01');
    const atEvent = first(matchAt(TWO, g01).matches);
    expect(atEvent.matchedTriggers.length).toBeGreaterThan(0);
    expect(first(matchAt(TWO, '2026-04-14T07:34:59Z').matches).matchedTriggers).toEqual([]);
  });
});
