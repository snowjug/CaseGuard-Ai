import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  SkillOverlaySchema,
  type DecisionFork,
  type PathMetrics,
  type Range,
  type SkillMatch,
  type SkillOverlay,
} from '@caseguard/schemas';
import {
  buildSkillOverlay,
  chooseDecisionPoint,
  firstRecommendedStep,
  generateCounterfactuals,
  subtractSaving,
  type SkillOverlayInput,
} from '../src';
import { CONFIG, type Prepared } from './helpers';
import { ONE, TWO, asOf, first, matchAt, publishedAggregate, versionOf } from './skills-fixtures';

/*
 * The overlay is arithmetic and wording over stored facts. These tests use the real synthetic cases and the
 * real seeded skill (Case One's, the one the demo story applies to Case Two), and prove: the formula, the
 * choice of the decision point, that the recorded figures of a record that is not whole are never shown,
 * that nothing is estimated where the skill does not apply, and that every sentence fits its contract.
 */

const content = versionOf(publishedAggregate()).content;
const benefit = content.expectedBenefit;
if (benefit === undefined) throw new Error('the seeded skill states no expected benefit');
const originForkId = content.provenance?.forkId;

const lastAt = (p: Prepared): string => first([...p.normalized.events].reverse()).timestamp;
const matchOf = (p: Prepared, at: string): SkillMatch => first(matchAt(p, at).matches);

const sourceFork = ONE.analysis.forks.find((fork) => fork.id === originForkId);
if (sourceFork === undefined) throw new Error('the skill’s source decision point is missing');

/** The recorded path of Case One from the decision point the skill was distilled at, as the engine measures it. */
const sourceMetrics: PathMetrics = first(
  generateCounterfactuals({
    analysis: ONE.analysis,
    fork: sourceFork,
    strategies: ['balanced'],
    events: ONE.normalized.events,
    resolution: ONE.normalized.resolution,
    pack: ONE.pack,
    config: CONFIG,
    ctx: ONE.ctx,
    rolloutCount: 40,
  }).scenarios,
).actualMetrics;

const round1 = (value: number): number => Math.round(value * 10) / 10;
const withSaving = (recorded: Range, saved: Range): Range => ({
  low: round1(Math.max(0, recorded.low - saved.high)),
  mid: round1(Math.max(0, recorded.mid - saved.mid)),
  high: round1(Math.max(0, recorded.high - saved.low)),
});

function overlayOf(p: Prepared, over: Partial<SkillOverlayInput> & { at?: string } = {}) {
  const match = over.match ?? matchOf(p, over.at ?? lastAt(p));
  const decisionPoint =
    'decisionPoint' in over
      ? (over.decisionPoint ?? null)
      : chooseDecisionPoint({ forks: p.analysis.forks, match, content: over.content ?? content });
  const overlay = buildSkillOverlay({
    caseId: p.ctx.caseId,
    match,
    content,
    decisionPoint,
    decisionPointCount: p.analysis.forks.length,
    recorded: { wholeRecord: true, metrics: sourceMetrics },
    ...over,
  });
  // Every text and every number fits the contract the API answers with.
  expect(SkillOverlaySchema.parse(overlay)).toEqual(overlay);
  return overlay;
}

const row = (overlay: SkillOverlay, key: string) => {
  const found = overlay.comparison.find((candidate) => candidate.key === key);
  if (found === undefined) throw new Error(`no row ${key}`);
  return found;
};

describe('the formula: the skill’s saving taken off the recorded range', () => {
  it('subtracts range against range, never below zero, and says when it held a result at zero', () => {
    expect(
      subtractSaving(
        { low: 2994, mid: 2994, high: 2994 },
        { low: 2641.5, mid: 2799, high: 2879.2 },
      ),
    ).toEqual({ range: { low: 114.8, mid: 195, high: 352.5 }, heldAtZero: false });
    expect(
      subtractSaving({ low: 100, mid: 100, high: 100 }, { low: 50, mid: 200, high: 300 }),
    ).toEqual({ range: { low: 0, mid: 0, high: 50 }, heldAtZero: true });
  });

  it('keeps the range ordered, never negative and never above the recorded one (property)', () => {
    const ordered = fc
      .tuple(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
      )
      .map(([a, b, c]) => {
        const [low = 0, mid = 0, high = 0] = [a, b, c].sort((x, y) => x - y);
        return { low: low / 10, mid: mid / 10, high: high / 10 };
      });
    fc.assert(
      fc.property(ordered, ordered, (recorded, saved) => {
        const { range, heldAtZero } = subtractSaving(recorded, saved);
        expect(range.low).toBeLessThanOrEqual(range.mid);
        expect(range.mid).toBeLessThanOrEqual(range.high);
        expect(range.low).toBeGreaterThanOrEqual(0);
        expect(range.low).toBeLessThanOrEqual(recorded.low);
        expect(range.mid).toBeLessThanOrEqual(recorded.mid);
        expect(range.high).toBeLessThanOrEqual(recorded.high);
        const exact = [
          recorded.low - saved.high,
          recorded.mid - saved.mid,
          recorded.high - saved.low,
        ];
        expect(heldAtZero).toBe(exact.some((value) => value < 0));
      }),
    );
  });

  it('a bigger saving never leaves more, and no saving leaves the recorded range (property)', () => {
    const value = fc.integer({ min: 0, max: 100_000 }).map((n) => n / 10);
    fc.assert(
      fc.property(value, value, value, value, (a, b, c, extra) => {
        const [low = 0, mid = 0, high = 0] = [a, b, c].sort((x, y) => x - y);
        const recorded = { low, mid, high };
        const none = subtractSaving(recorded, { low: 0, mid: 0, high: 0 }).range;
        expect(none).toEqual(recorded);
        const small = { low: 1, mid: 2, high: 3 };
        const large = { low: 1 + extra, mid: 2 + extra, high: 3 + extra };
        const less = subtractSaving(recorded, large).range;
        const more = subtractSaving(recorded, small).range;
        expect(less.low).toBeLessThanOrEqual(more.low);
        expect(less.mid).toBeLessThanOrEqual(more.mid);
        expect(less.high).toBeLessThanOrEqual(more.high);
      }),
    );
  });

  it('lets a saving that might be negative raise the high end, which is the honest reading', () => {
    const { range } = subtractSaving(
      { low: 100, mid: 100, high: 100 },
      { low: -20, mid: 10, high: 30 },
    );
    expect(range).toEqual({ low: 70, mid: 90, high: 120 });
  });
});

describe('the decision point at which a skill would have mattered', () => {
  const match = matchOf(ONE, lastAt(ONE));
  const action = firstRecommendedStep(match)?.actionKey ?? '';
  const minutesBefore = (fork: DecisionFork, minutes: number): string =>
    new Date(Date.parse(fork.timestamp) - minutes * 60_000).toISOString();
  const earlier = (over: Partial<DecisionFork> = {}): DecisionFork => ({
    ...sourceFork,
    id: 'fork_earlier',
    sequence: sourceFork.sequence - 1,
    timestamp: minutesBefore(sourceFork, 30),
    ...over,
  });

  it('is the decision point the skill was distilled from, where its first step was an open alternative', () => {
    expect(action).not.toBe('');
    expect(sourceFork.alternatives.some((alt) => alt.actionKey === action)).toBe(true);
    expect(sourceFork.actual.actionKey).not.toBe(action);
    expect(chooseDecisionPoint({ forks: ONE.analysis.forks, match, content })?.id).toBe(
      originForkId,
    );
  });

  it('prefers the one the skill came from over an earlier one, and otherwise the earliest where the case did something else', () => {
    const forks = [earlier(), ...ONE.analysis.forks];
    expect(chooseDecisionPoint({ forks, match, content })?.id).toBe(originForkId);
    const withoutOrigin = { provenance: undefined };
    expect(chooseDecisionPoint({ forks, match, content: withoutOrigin })?.id).toBe('fork_earlier');
    // An earlier decision point where the case already did the recommended thing is not the one that mattered.
    const did = earlier({ actual: { ...sourceFork.actual, actionKey: action } });
    expect(
      chooseDecisionPoint({ forks: [did, sourceFork], match, content: withoutOrigin })?.id,
    ).toBe(originForkId);
    // When that is all there is, it is still the decision point, and the overlay can say the case did it.
    expect(chooseDecisionPoint({ forks: [did], match, content: withoutOrigin })?.id).toBe(
      'fork_earlier',
    );
  });

  it('ignores an alternative that was unsafe or blocked at the time, and a plan that names no action', () => {
    const closed = (over: Partial<DecisionFork['alternatives'][number]>): DecisionFork => ({
      ...sourceFork,
      alternatives: sourceFork.alternatives.map((alt) =>
        alt.actionKey === action ? { ...alt, ...over } : alt,
      ),
    });
    expect(chooseDecisionPoint({ forks: [closed({ safe: false })], match, content })).toBeNull();
    expect(
      chooseDecisionPoint({
        forks: [closed({ blockedReasons: ['Needs first: scoping'] })],
        match,
        content,
      }),
    ).toBeNull();
    const manual = {
      recommendedSteps: match.recommendedSteps.map((step) => ({ ...step, actionKey: null })),
    };
    expect(firstRecommendedStep(manual)).toBeNull();
    expect(chooseDecisionPoint({ forks: ONE.analysis.forks, match: manual, content })).toBeNull();
    expect(chooseDecisionPoint({ forks: [], match, content })).toBeNull();
  });
});

describe('the case the skill was distilled from', () => {
  let overlay: SkillOverlay;
  beforeAll(() => {
    overlay = overlayOf(ONE);
  });

  it('sets the recorded path beside the skill’s own estimate, with the saving taken off range against range', () => {
    expect(overlay.decisionPoint).toMatchObject({
      forkId: originForkId,
      eventId: sourceFork.eventId,
      at: sourceFork.timestamp,
    });
    expect(overlay.recorded.actionKey).toBe(sourceFork.actual.actionKey);
    expect(overlay.recorded.note).toContain(sourceFork.actual.label);

    const expected: [string, Range, Range][] = [
      ['time_to_diagnosis_minutes', sourceMetrics.timeToDiagnosisMinutes, benefit.timeSavedMinutes],
      [
        'customer_effort_minutes',
        sourceMetrics.customerEffortMinutes,
        benefit.customerEffortSavedMinutes,
      ],
      ['tokens', sourceMetrics.tokenEstimate, benefit.tokensSaved],
    ];
    for (const [key, recorded, saved] of expected) {
      const found = row(overlay, key);
      expect(found.recorded).toEqual(recorded);
      expect(found.saved).toEqual(saved);
      expect(found.withSkill).toEqual(withSaving(recorded, saved));
      expect(found.basis).toContain('recorded minus the skill’s own estimated saving');
      expect(found.withSkill?.mid).toBeLessThan(recorded.mid);
    }
  });

  it('shows the time to useful evidence as recorded and makes no estimate of it: the skill states none', () => {
    const found = row(overlay, 'time_to_useful_evidence_minutes');
    expect(found.recorded).toEqual(sourceMetrics.timeToUsefulEvidenceMinutes);
    expect(found.saved).toBeNull();
    expect(found.withSkill).toBeNull();
    expect(found.basis).toMatch(/states no saving for this figure/);
  });

  it('names the evidence that made the skill match, then the decision point, and labels itself an estimate', () => {
    const match = matchOf(ONE, lastAt(ONE));
    const matched = new Set(match.matchedTriggers.flatMap((trigger) => trigger.evidenceIds));
    const evidence = overlay.evidence.filter((link) => link.type === 'evidence');
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence.every((link) => matched.has(link.id))).toBe(true);
    expect(new Set(evidence.map((link) => link.id)).size).toBe(evidence.length);
    expect(overlay.evidence.at(-1)).toMatchObject({ type: 'fork', id: originForkId });
    expect(overlay.evidence.length).toBeLessThanOrEqual(40);
    expect(overlay.labels).toEqual({
      estimated: true,
      simulated: true,
      recordedAnalysisUnchanged: true,
    });
    expect(overlay.withSkill.steps).toEqual(match.recommendedSteps);
    expect(overlay.assumptions.join(' ')).toContain('the skill’s own replay');
  });

  it('is the same overlay for the same inputs, and does not alter its inputs', () => {
    const match = matchOf(ONE, lastAt(ONE));
    const before = JSON.stringify([match, content, sourceFork, sourceMetrics]);
    expect(overlayOf(ONE)).toEqual(overlay);
    expect(JSON.stringify([match, content, sourceFork, sourceMetrics])).toBe(before);
  });

  it('offers the cheaper way to learn the same thing when the case did the step the skill replaces', () => {
    const alternative = content.cheaperAlternatives?.find(
      (item) => item.insteadOfActionKey === sourceFork.actual.actionKey,
    );
    expect(alternative).toBeDefined();
    expect(overlay.withSkill.cheaperAlternative).toEqual(alternative);
  });
});

describe('Case Two: the skill from Case One resembles it (the demo story)', () => {
  let whole: SkillOverlay;
  beforeAll(() => {
    whole = overlayOf(TWO);
  });

  it('has no decision point to compare, so it shows the skill’s own saving and nothing of its own', () => {
    expect(TWO.analysis.forks).toHaveLength(0);
    expect(whole.decisionPoint).toBeNull();
    expect(whole.recorded.actionKey).toBeNull();
    expect(whole.recorded.note).toMatch(/no decision point/);
    for (const found of whole.comparison) {
      expect(found.recorded).toBeNull();
      expect(found.withSkill).toBeNull();
    }
    expect(row(whole, 'time_to_diagnosis_minutes').saved).toEqual(benefit.timeSavedMinutes);
    expect(row(whole, 'customer_effort_minutes').basis).toMatch(/No decision point/);
    expect(row(whole, 'customer_effort_minutes').basis).toMatch(/the skill’s own estimate/);
  });

  it('says the engineer had already taken the skill’s first step, and that it applies to the case', () => {
    const step = firstRecommendedStep(matchOf(TWO, lastAt(TWO)));
    expect(step?.status).toBe('done');
    expect(whole.recorded.followedRecommendedStep).toBe(true);
    expect(whole.recorded.note).toContain('The case took that step.');
    expect(whole.applicability).toBe('applies');
    expect(whole.score).toBe(matchOf(TWO, lastAt(TWO)).score);
  });

  it('as of its first email, the skill recommends the first step and the case has not taken it', () => {
    const at = asOf(TWO, 'g01');
    const early = overlayOf(TWO, {
      at,
      recorded: { wholeRecord: false, metrics: null },
    });
    expect(early.asOf).toBe(at);
    expect(firstRecommendedStep(matchOf(TWO, at))?.status).toBe('recommended_next');
    expect(early.recorded.followedRecommendedStep).toBe(false);
    expect(early.withSkill.steps[0]?.status).toBe('recommended_next');
    expect(early.recorded.note).toContain('has not taken that step yet');
  });
});

describe('what is withheld, and where nothing is estimated', () => {
  const match = matchOf(ONE, lastAt(ONE));

  it('never shows the recorded path of a record that is not whole, whatever it is given', () => {
    const shown = overlayOf(ONE);
    expect(row(shown, 'tokens').recorded).not.toBeNull();
    const partial = overlayOf(ONE, { recorded: { wholeRecord: false, metrics: sourceMetrics } });
    for (const found of partial.comparison) {
      expect(found.recorded).toBeNull();
      expect(found.withSkill).toBeNull();
    }
    expect(row(partial, 'tokens').saved).toEqual(benefit.tokensSaved);
    expect(row(partial, 'tokens').basis).toMatch(/whole record is visible/);
    expect(partial.limitations.join(' ')).toMatch(/only once the whole record is visible/);
    expect(JSON.stringify(partial.comparison)).not.toContain(
      String(sourceMetrics.timeToDiagnosisMinutes.mid),
    );
  });

  it('says so when the engine has no simulated figures for the decision point', () => {
    const none = overlayOf(ONE, { recorded: { wholeRecord: true, metrics: null } });
    expect(none.decisionPoint).not.toBeNull();
    expect(row(none, 'tokens').recorded).toBeNull();
    expect(row(none, 'tokens').basis).toMatch(/no simulated figures/);
  });

  it('makes no with-skill figure for a skill that does not apply to the case', () => {
    const overlay = overlayOf(ONE, { match: { ...match, applicability: 'not_applicable' } });
    for (const found of overlay.comparison) expect(found.withSkill).toBeNull();
    expect(row(overlay, 'tokens').recorded).toEqual(sourceMetrics.tokenEstimate);
    expect(row(overlay, 'tokens').basis).toMatch(/does not apply to this case/);
    expect(overlay.withSkill.cheaperAlternative).toBeNull();
    expect(overlay.limitations.join(' ')).toMatch(/does not apply to this case/);
  });

  it('says only partly when the skill only partly matches, and still estimates', () => {
    const overlay = overlayOf(ONE, { match: { ...match, applicability: 'partial' } });
    expect(row(overlay, 'tokens').withSkill).not.toBeNull();
    expect(overlay.limitations.join(' ')).toMatch(/only partly/);
  });

  it('makes no with-skill figure where the case already did what the skill recommends', () => {
    const action = firstRecommendedStep(match)?.actionKey ?? '';
    const did: DecisionFork = {
      ...sourceFork,
      actual: { ...sourceFork.actual, actionKey: action },
    };
    const overlay = overlayOf(ONE, { decisionPoint: did });
    for (const found of overlay.comparison) expect(found.withSkill).toBeNull();
    expect(row(overlay, 'tokens').recorded).toEqual(sourceMetrics.tokenEstimate);
    expect(row(overlay, 'tokens').basis).toMatch(/already did what the skill recommends/);
  });

  it('holds a result at zero and says it did, when the saving is more than the case recorded', () => {
    const small: PathMetrics = {
      ...sourceMetrics,
      tokenEstimate: { low: 100, mid: 100, high: 100 },
    };
    const overlay = overlayOf(ONE, { recorded: { wholeRecord: true, metrics: small } });
    expect(row(overlay, 'tokens').withSkill).toEqual({ low: 0, mid: 0, high: 0 });
    expect(row(overlay, 'tokens').basis).toMatch(/held at zero/);
    expect(row(overlay, 'customer_effort_minutes').basis).not.toMatch(/held at zero/);
  });

  it('has nothing to subtract when the skill states no saving, and says so in every row', () => {
    const bare = { ...content, expectedBenefit: undefined };
    const overlay = overlayOf(ONE, { content: bare });
    for (const found of overlay.comparison) {
      expect(found.saved).toBeNull();
      expect(found.withSkill).toBeNull();
      expect(found.basis).toMatch(/states no estimated saving/);
    }
    expect(overlay.assumptions.join(' ')).toMatch(/states no estimated saving/);
  });

  it('says a skill that was retired since is no longer offered to other cases', () => {
    const overlay = overlayOf(ONE, { match: { ...match, lifecycle: 'retired' } });
    expect(overlay.skill.lifecycle).toBe('retired');
    expect(overlay.limitations.join(' ')).toMatch(/retired and is no longer offered/);
  });

  it('cuts the evidence at what one provenance request can resolve, and says how much it left out', () => {
    const many = Array.from({ length: 60 }, (_, index) => `ev_${index}`);
    const crowded: SkillMatch = {
      ...match,
      matchedTriggers: [{ id: 'trg', description: 'Many sightings', weight: 1, evidenceIds: many }],
    };
    const overlay = overlayOf(ONE, { match: crowded });
    expect(overlay.evidence).toHaveLength(40);
    expect(overlay.evidence.at(-1)).toMatchObject({ type: 'fork' });
    expect(overlay.limitations.join(' ')).toContain('Showing 39 of 60 pieces of evidence');
  });
});
