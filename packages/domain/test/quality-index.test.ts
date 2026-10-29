import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PENALTY_POINTS,
  DEFAULT_QUALITY_CONFIG,
  PENALTY_KEYS,
  QUALITY_DIMENSIONS,
  QualityAssessmentSchema,
  type PenaltyKey,
  type QualityAssessment,
  type QualityConfig,
} from '@caseguard/schemas';
import { computeQualityReview, computeQualityReviewAsOf } from '../src';
import {
  CASE_ONE,
  CASE_TWO,
  eventBySuffix,
  loadBundle,
  prepareBundle,
  prepareCase,
} from './helpers';
import { engineerEvent, poisonAfter, poisonResolution, variantOfCaseOne } from './quality-fixtures';

const one = prepareCase(CASE_ONE);
const two = prepareCase(CASE_TWO);

const review = (p: typeof one, config?: QualityConfig): QualityAssessment =>
  computeQualityReview({
    analysis: p.analysis,
    pack: p.pack,
    ctx: p.ctx,
    ...(config ? { config } : {}),
  });

const keysOf = (r: QualityAssessment): PenaltyKey[] => r.penalties.map((x) => x.key);
const dimension = (r: QualityAssessment, key: string) => {
  const found = r.dimensions.find((d) => d.key === key);
  if (!found) throw new Error(`no dimension ${key}`);
  return found;
};

const asOfReview = (p: typeof one, suffix: string, resolution = p.normalized.resolution) =>
  computeQualityReviewAsOf({
    events: p.normalized.events,
    resolution,
    asOf: eventBySuffix(p, suffix).timestamp,
    pack: p.pack,
    ctx: p.ctx,
  });

describe('Case Quality Index on the synthetic cases (FR-QI-01)', () => {
  const caseOne = review(one);
  const caseTwo = review(two);

  it('[FR-QI-01] Case One lands in needs attention or lower with the six expected penalties', () => {
    expect(['needs_attention', 'poor']).toContain(caseOne.band);
    expect(caseOne.compositeScore).toBeLessThan(DEFAULT_QUALITY_CONFIG.bands.adequate);
    expect(keysOf(caseOne)).toEqual(
      expect.arrayContaining([
        'unsupported_root_cause',
        'destructive_action_without_justification',
        'repeated_low_value_diagnostic',
        'ignored_contradiction',
        'premature_escalation',
        'unnecessary_customer_request',
      ]),
    );
  });

  it('[FR-QI-01] Case Two is strong (>= 85) with no penalties', () => {
    expect(caseTwo.band).toBe('strong');
    expect(caseTwo.compositeScore).toBeGreaterThanOrEqual(85);
    expect(caseTwo.penalties).toEqual([]);
    expect(caseTwo.totalPenaltyPoints).toBe(0);
    expect(caseTwo.penaltyCapApplied).toBe(false);
  });

  it('[FR-QI-01] every output satisfies the QualityAssessment contract and is labelled an estimate', () => {
    for (const r of [caseOne, caseTwo]) {
      expect(() => QualityAssessmentSchema.parse(r)).not.toThrow();
      expect(r.estimated).toBe(true);
      expect(r.asOf).toBeNull();
      expect(r.uncertaintyNote).toMatch(/estimate/i);
      expect(r.uncertaintyNote).toMatch(/never a verdict about a person/);
      expect(r.compositeLow).toBeLessThanOrEqual(r.compositeScore);
      expect(r.compositeHigh).toBeGreaterThanOrEqual(r.compositeScore);
    }
  });

  it('[FR-QI-01] uses the configured dimension weights (25/20/15/15/15/10) when every dimension is assessable', () => {
    expect(caseTwo.weights).toEqual(
      expect.objectContaining(
        Object.fromEntries(
          QUALITY_DIMENSIONS.map((k) => [
            k,
            expect.closeTo(DEFAULT_QUALITY_CONFIG.weights[k] ?? 0, 3),
          ]),
        ),
      ),
    );
    expect(Object.values(caseTwo.weights).reduce((s, w) => s + w, 0)).toBeCloseTo(1, 3);
    expect(caseTwo.dimensions.map((d) => d.key)).toEqual([...QUALITY_DIMENSIONS]);
  });

  it('[FR-QI-01] the ten penalties are the configured ones and each carries points, reason and evidence', () => {
    expect(PENALTY_KEYS).toHaveLength(10);
    for (const p of caseOne.penalties) {
      expect(p.points).toBe(DEFAULT_PENALTY_POINTS[p.key]);
      expect(p.rationale.length).toBeGreaterThan(20);
      expect(p.evidence.length).toBeGreaterThan(0);
      expect(p.dimension).not.toBeNull();
    }
    expect(new Set(keysOf(caseOne)).size).toBe(caseOne.penalties.length);
  });

  it('[FR-QI-01] the composite equals the weighted dimension scores minus the capped penalties', () => {
    for (const r of [caseOne, caseTwo]) {
      const weightedRaw = r.dimensions.reduce((s, d) => s + d.weight * d.rawScore, 0);
      const deduction = Math.min(DEFAULT_QUALITY_CONFIG.penaltyCap, r.totalPenaltyPoints);
      expect(r.compositeScore).toBeCloseTo(Math.max(0, weightedRaw - deduction), 0);
      const weightedFinal = r.dimensions.reduce((s, d) => s + d.weight * d.score, 0);
      expect(weightedFinal).toBeCloseTo(r.compositeScore, 0);
    }
  });

  it('[FR-QI-01] every dimension is explainable: sub-checks with notes and evidence, positive and negative', () => {
    for (const d of caseOne.dimensions) {
      expect(d.rationale.length).toBeGreaterThan(10);
      expect(d.subChecks.length).toBeGreaterThan(0);
      for (const c of d.subChecks) expect(c.note.length).toBeGreaterThan(5);
    }
    const all = caseOne.dimensions.flatMap((d) => d.subChecks).filter((c) => c.determinable);
    expect(all.some((c) => c.score >= 0.85)).toBe(true);
    expect(all.some((c) => c.score < 0.5)).toBe(true);
    const linked = all.flatMap((c) => c.evidence);
    expect(linked.length).toBeGreaterThan(5);
    expect(new Set(linked.map((l) => l.type)).size).toBeGreaterThanOrEqual(3);
  });

  it('[FR-QI-02] recommended improvements are evidence-linked and the post-improvement score is an estimate with a range', () => {
    expect(caseOne.improvements.length).toBeGreaterThan(0);
    for (const imp of caseOne.improvements) {
      expect(imp.expectedScoreGain).toBeGreaterThan(0);
      expect(imp.description.length).toBeGreaterThan(20);
      expect(imp.evidence.length + (imp.linkedForkId ? 1 : 0)).toBeGreaterThan(0);
    }
    const after = caseOne.estimatedScoreAfterImprovements;
    expect(after.score).toBeGreaterThan(caseOne.compositeScore);
    expect(after.score).toBeLessThanOrEqual(100);
    expect(after.low).toBeLessThanOrEqual(after.score);
    expect(after.high).toBeGreaterThanOrEqual(after.score);
    expect(after.method).toMatch(/estimate/i);
    expect(caseTwo.improvements.length).toBeLessThan(caseOne.improvements.length);
  });

  it('[FR-QI-01] never names a person or passes a verdict', () => {
    const text = JSON.stringify([caseOne, caseTwo]);
    expect(text).not.toMatch(/Support Engineer 1|Identity Escalation Engineer|Support Manager 1/);
    expect(text).not.toMatch(/\b(careless|negligen\w*|incompeten\w*|lazy|sloppy|blame\w*)\b/i);
  });

  it('is deterministic: the same analysis scores identically', () => {
    expect(review(one)).toEqual(caseOne);
  });
});

describe('configuration (FR-QI-01)', () => {
  it('[FR-QI-01] the penalty cap limits the deduction and is reported', () => {
    const capped = review(one, { ...DEFAULT_QUALITY_CONFIG, penaltyCap: 10 });
    const base = review(one);
    expect(capped.penaltyCapApplied).toBe(true);
    expect(base.penaltyCapApplied).toBe(false);
    expect(capped.compositeScore - base.compositeScore).toBeCloseTo(
      base.totalPenaltyPoints - 10,
      0,
    );
    expect(capped.totalPenaltyPoints).toBe(base.totalPenaltyPoints);
    expect(() => QualityAssessmentSchema.parse(capped)).not.toThrow();
  });

  it('[FR-QI-01] a penalty configured at zero points is not applied', () => {
    const config: QualityConfig = {
      ...DEFAULT_QUALITY_CONFIG,
      penaltyPoints: { ...DEFAULT_QUALITY_CONFIG.penaltyPoints, unsupported_root_cause: 0 },
    };
    const result = review(one, config);
    expect(keysOf(result)).not.toContain('unsupported_root_cause');
    expect(result.compositeScore).toBeGreaterThan(review(one).compositeScore);
  });

  it('[FR-QI-01] custom bands move the band label, not the score', () => {
    const lenient: QualityConfig = {
      ...DEFAULT_QUALITY_CONFIG,
      bands: { strong: 30, adequate: 20, needsAttention: 10 },
    };
    const result = review(one, lenient);
    expect(result.band).toBe('strong');
    expect(result.compositeScore).toBe(review(one).compositeScore);
  });
});

describe('as-of scoring (FR-QI-02, FR-TL-06)', () => {
  it('[FR-QI-02] scores the case as of a time using only the view up to then', () => {
    const early = asOfReview(one, 'e08');
    expect(early.asOf).toBe(eventBySuffix(one, 'e08').timestamp);
    expect(keysOf(early)).toEqual(
      expect.arrayContaining([
        'unsupported_root_cause',
        'destructive_action_without_justification',
      ]),
    );
    expect(keysOf(early)).not.toContain('premature_escalation');
    expect(keysOf(early)).not.toContain('repeated_low_value_diagnostic');
    expect(early.uncertaintyNote).toMatch(/Scored as of/);
    expect(() => QualityAssessmentSchema.parse(early)).not.toThrow();
  });

  it('[FR-QI-02] penalties appear only once the events that cause them are in the view', () => {
    const e02 = asOfReview(one, 'e02');
    const e03 = asOfReview(one, 'e03');
    expect(e02.penalties).toEqual([]);
    expect(keysOf(e03)).toContain('unnecessary_customer_request');
    const e15 = asOfReview(one, 'e15');
    const e19 = asOfReview(one, 'e19');
    expect(keysOf(e15)).not.toContain('premature_escalation');
    expect(keysOf(e19)).toContain('premature_escalation');
    expect(e19.totalPenaltyPoints).toBeGreaterThan(e15.totalPenaltyPoints);
  });

  it('[FR-QI-02] resolution-dependent dimensions are left out until the closure is in the view', () => {
    const beforeClosure = asOfReview(one, 'e29');
    const validation = dimension(beforeClosure, 'resolution_validation');
    expect(validation.weight).toBe(0);
    expect(validation.subChecks.every((c) => !c.determinable || c.weight === 0)).toBe(true);
    expect(beforeClosure.uncertaintyNote).toMatch(/Resolution validation/);
    const weights = Object.values(beforeClosure.weights);
    expect(weights.reduce((s, w) => s + w, 0)).toBeCloseTo(1, 3);

    const atClosure = asOfReview(one, 'e30');
    expect(dimension(atClosure, 'resolution_validation').weight).toBeGreaterThan(0);
    expect(dimension(atClosure, 'resolution_validation').score).toBeGreaterThan(80);
  });

  it('[FR-QI-02] before anything can be judged the score is a neutral placeholder, never a result', () => {
    const beforeFirstEvent = computeQualityReviewAsOf({
      events: one.normalized.events,
      resolution: one.normalized.resolution,
      asOf: '2026-03-09T08:00:00Z',
      pack: one.pack,
      ctx: one.ctx,
    });
    const openingMessage = asOfReview(one, 'e01');
    for (const r of [beforeFirstEvent, openingMessage]) {
      expect(() => QualityAssessmentSchema.parse(r)).not.toThrow();
      expect(r.compositeScore).toBe(50);
      expect(r.compositeLow).toBe(0);
      expect(r.compositeHigh).toBe(100);
      expect(Object.values(r.weights).every((w) => w === 0)).toBe(true);
      expect(r.penalties).toEqual([]);
      expect(r.dimensions.every((d) => d.subChecks.every((c) => !c.determinable))).toBe(true);
      expect(r.uncertaintyNote).toMatch(/nothing can be assessed/);
      expect(r.uncertaintyNote).toMatch(/estimate/);
      expect(r.estimated).toBe(true);
    }
  });

  it('[FR-QI-02] a customer who has not yet had time to need news is not credited for not chasing', () => {
    const early = asOfReview(one, 'e08');
    const communication = dimension(early, 'customer_communication');
    const chase = communication.subChecks.find((c) => c.id === 'CC-4');
    expect(chase?.determinable).toBe(false);
    expect(chase?.note).toMatch(/Too early to tell/);
    const full = dimension(review(one), 'customer_communication').subChecks.find(
      (c) => c.id === 'CC-4',
    );
    expect(full?.determinable).toBe(true);
  });

  it('[FR-TL-06] a review as of the last event matches the full review', () => {
    const last = asOfReview(one, 'e31');
    const full = review(one);
    expect(last.compositeScore).toBe(full.compositeScore);
    expect(last.compositeLow).toBe(full.compositeLow);
    expect(last.compositeHigh).toBe(full.compositeHigh);
    expect(keysOf(last)).toEqual(keysOf(full));
    expect(last.dimensions.map((d) => d.score)).toEqual(full.dimensions.map((d) => d.score));
  });

  for (const suffix of ['e08', 'e15', 'e19']) {
    it(`[FR-TL-06] mutating everything after ${suffix} (events and resolution) changes nothing`, () => {
      const cut = one.normalized.events.findIndex((e) => e.id.endsWith(suffix));
      const original = asOfReview(one, suffix);
      const poisoned = computeQualityReviewAsOf({
        events: poisonAfter(one.normalized.events, cut),
        resolution: poisonResolution(one.normalized.resolution),
        asOf: eventBySuffix(one, suffix).timestamp,
        pack: one.pack,
        ctx: one.ctx,
      });
      expect(poisoned).toEqual(original);
    });
  }
});

describe('penalties that the synthetic cases do not exercise (FR-QI-01)', () => {
  const closedTooEarly = () =>
    prepareBundle(
      variantOfCaseOne(
        4,
        [
          engineerEvent({
            id: 'z1',
            timestamp: '2026-03-09T12:00:00Z',
            type: 'resolution_note',
            title: 'Resolution summary',
            body: 'Resolution summary. Cleared the Teams cache and closing the case as resolved.',
          }),
        ],
        {
          resolvedAt: '2026-03-09T12:00:00Z',
          summary: 'Cleared the Teams cache.',
          rootCause: 'Corrupt local Teams cache.',
        },
      ),
      'case_closed_early',
    );

  it('[FR-QI-01] closing before any hypothesis is confirmed and without validation is penalised', () => {
    const p = closedTooEarly();
    const result = review(p);
    expect(keysOf(result)).toEqual(
      expect.arrayContaining(['premature_closure', 'missing_resolution_validation']),
    );
    expect(dimension(result, 'resolution_validation').score).toBeLessThan(60);
    expect(() => QualityAssessmentSchema.parse(result)).not.toThrow();
  });

  it('[FR-QI-01] a workaround recorded without a permanent fix is flagged as workaround/fix conflation', () => {
    const base = loadBundle(CASE_ONE);
    const resolution = base.resolution
      ? { ...base.resolution, permanentFix: undefined }
      : undefined;
    const p = prepareBundle(variantOfCaseOne(31, [], resolution), 'case_workaround');
    expect(keysOf(review(p))).toContain('workaround_fix_conflation');
    expect(keysOf(review(one))).not.toContain('workaround_fix_conflation');
  });

  it('[FR-QI-01] checklist phrasing that stands in for evidence is flagged', () => {
    const p = prepareBundle(
      variantOfCaseOne(
        4,
        [
          engineerEvent({
            id: 'z2',
            timestamp: '2026-03-09T11:00:00Z',
            body: 'Standard troubleshooting steps completed per checklist. No issues found.',
          }),
        ],
        undefined,
      ),
      'case_template',
    );
    const result = review(p);
    expect(keysOf(result)).toContain('template_completion_without_evidence');
    expect(dimension(result, 'evidence_integrity').score).toBeLessThan(
      dimension(review(two), 'evidence_integrity').score,
    );
  });

  it('[FR-QI-01] all ten penalty keys are reachable across the synthetic and variant cases', () => {
    const seen = new Set<PenaltyKey>(keysOf(review(one)));
    for (const k of keysOf(review(closedTooEarly()))) seen.add(k);
    const base = loadBundle(CASE_ONE);
    const resolution = base.resolution
      ? { ...base.resolution, permanentFix: undefined }
      : undefined;
    for (const k of keysOf(review(prepareBundle(variantOfCaseOne(31, [], resolution), 'case_w')))) {
      seen.add(k);
    }
    const template = prepareBundle(
      variantOfCaseOne(
        4,
        [
          engineerEvent({
            id: 'z3',
            timestamp: '2026-03-09T11:00:00Z',
            body: 'All checks completed. No issues found.',
          }),
        ],
        undefined,
      ),
      'case_t',
    );
    for (const k of keysOf(review(template))) seen.add(k);
    expect([...seen].sort()).toEqual([...PENALTY_KEYS].sort());
  });
});
