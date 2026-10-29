import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SkillEffectivenessSchema } from '@caseguard/schemas';
import { aggregateSkillEffectiveness, mean, rangeOf, round, type SkillUsageRecord } from '../src';

const record = (over: Partial<SkillUsageRecord> = {}): SkillUsageRecord => ({
  skillId: 'skill_a',
  versionId: 'skv_a1',
  caseId: 'case_1',
  synthetic: true,
  matched: true,
  applied: true,
  suggestionsOffered: 4,
  suggestionsAccepted: 3,
  timeToDiagnosisMinutes: 120,
  baselineTimeToDiagnosisMinutes: 180,
  tokenEstimate: 4000,
  baselineTokenEstimate: 6000,
  evidenceCompleteness: 1,
  baselineEvidenceCompleteness: 0.5,
  conformanceScore: 0.9,
  ...over,
});

const sample = [
  record({ caseId: 'case_1' }),
  record({
    caseId: 'case_2',
    timeToDiagnosisMinutes: 90,
    baselineTimeToDiagnosisMinutes: 200,
    suggestionsOffered: 5,
    suggestionsAccepted: 5,
    tokenEstimate: 3000,
    baselineTokenEstimate: 5000,
    baselineEvidenceCompleteness: 0.6,
    conformanceScore: 1,
  }),
  record({
    caseId: 'case_3',
    timeToDiagnosisMinutes: 200,
    baselineTimeToDiagnosisMinutes: 180,
    suggestionsOffered: 3,
    suggestionsAccepted: 0,
    tokenEstimate: 5000,
    baselineTokenEstimate: 5000,
    evidenceCompleteness: 0.8,
    baselineEvidenceCompleteness: 0.8,
    conformanceScore: 0.4,
  }),
  record({
    caseId: 'case_4',
    applied: false,
    suggestionsOffered: 0,
    suggestionsAccepted: 0,
    timeToDiagnosisMinutes: null,
    baselineTimeToDiagnosisMinutes: null,
  }),
  record({ caseId: 'case_5', matched: false, applied: false }),
];

describe('skill effectiveness aggregated from recorded applications', () => {
  const report = aggregateSkillEffectiveness(sample);

  it('[FR-SK-06] derives adoption, acceptance, saved time and evidence uplift from the records, all labelled estimated', () => {
    expect(report.adoption).toEqual({ matchedCases: 4, appliedCases: 3, adoptionRate: 0.75 });
    expect(report.suggestionAcceptance).toEqual({
      offered: 12,
      accepted: 8,
      rate: round(8 / 12, 3),
    });
    const saved = [60, 110, -20];
    const range = rangeOf(saved);
    expect(report.estimatedTimeSaved).toMatchObject({
      casesCompared: 3,
      estimated: true,
      perCaseMinutes: {
        low: round(range.low, 1),
        mid: round(range.mid, 1),
        high: round(range.high, 1),
      },
    });
    expect(report.evidenceCompletenessUplift).toEqual({
      casesCompared: 3,
      meanPoints: round(mean([50, 40, 0]), 1),
      estimated: true,
    });
    expect(report.effectiveness).toMatchObject({
      applications: 3,
      matchedCases: 4,
      avgTimeToDiagnosisMinutes: round(mean([120, 90, 200]), 2),
      baselineAvgTimeToDiagnosisMinutes: round(mean([180, 200, 180]), 2),
      conformanceAvg: round(mean([0.9, 1, 0.4]), 3),
      estimatedTokenSavingsPct: round(((16000 - 12000) / 16000) * 100, 1),
      estimated: true,
      synthetic: true,
    });
    expect(report.estimated).toBe(true);
    expect(() => SkillEffectivenessSchema.parse(report.effectiveness)).not.toThrow();
  });

  it('[FR-SK-06] says plainly that a handful of synthetic cases is not evidence of effectiveness', () => {
    expect(report.confidence).toMatchObject({ level: 'low', score: 0.15 });
    expect(report.confidence.rationale).toMatch(
      /3 applied cases, all synthetic; estimates come from simulated baselines without a control group/,
    );
    expect(report.estimatedTimeSaved.note).toMatch(/Range across compared cases/);
    expect(aggregateSkillEffectiveness(sample.slice(0, 2)).estimatedTimeSaved.note).toMatch(
      /Fewer than three cases compared/,
    );
    expect(report.notices.join(' ')).toMatch(/Every contributing case is synthetic/);
    expect(report.effectiveness.notes.join(' ')).toMatch(/model estimates, not measurements/);
    const mixed = aggregateSkillEffectiveness([
      ...sample,
      record({ caseId: 'case_6', synthetic: false }),
    ]);
    expect(mixed.synthetic).toBe(false);
    expect(mixed.notices.join(' ')).toMatch(/not a controlled comparison/);
  });

  it('[FR-SK-06] confidence grows only with the number of applied cases and is capped', () => {
    const many = (n: number) =>
      aggregateSkillEffectiveness(
        Array.from({ length: n }, (_, i) => record({ caseId: `case_${i}` })),
      ).confidence;
    expect(many(4)).toMatchObject({ level: 'low', score: 0.2 });
    expect(many(5)).toMatchObject({ level: 'medium', score: 0.25 });
    expect(many(20)).toMatchObject({ level: 'high', score: 0.9 });
    expect(many(60).score).toBe(0.9);
  });

  it('[FR-SK-06] is empty and honest without any record', () => {
    const empty = aggregateSkillEffectiveness([]);
    expect(empty.adoption).toEqual({ matchedCases: 0, appliedCases: 0, adoptionRate: null });
    expect(empty.suggestionAcceptance.rate).toBeNull();
    expect(empty.estimatedTimeSaved).toMatchObject({ casesCompared: 0, perCaseMinutes: null });
    expect(empty.effectiveness).toMatchObject({
      applications: 0,
      avgTimeToDiagnosisMinutes: null,
      estimatedTokenSavingsPct: null,
      synthetic: false,
    });
    expect(empty.effectiveness.notes[0]).toBe('No applications recorded yet.');
    expect(() => SkillEffectivenessSchema.parse(empty.effectiveness)).not.toThrow();
  });

  it('[FR-SK-06] counts one record per skill, version and case, and can be scoped to one skill', () => {
    const duplicated = aggregateSkillEffectiveness([
      ...sample,
      record({ caseId: 'case_1', timeToDiagnosisMinutes: 60 }),
    ]);
    expect(duplicated.effectiveness.applications).toBe(3);
    expect(duplicated.effectiveness.avgTimeToDiagnosisMinutes).toBe(round(mean([60, 90, 200]), 2));
    const other = record({ skillId: 'skill_b', versionId: 'skv_b1', caseId: 'case_9' });
    expect(aggregateSkillEffectiveness([...sample, other], { skillId: 'skill_a' })).toEqual(report);
    expect(aggregateSkillEffectiveness([...sample, other]).effectiveness.applications).toBe(4);
  });

  it('[FR-SK-06] never offers more acceptances than suggestions', () => {
    const odd = aggregateSkillEffectiveness([
      record({ suggestionsOffered: 2, suggestionsAccepted: 9 }),
    ]);
    expect(odd.suggestionAcceptance).toEqual({ offered: 2, accepted: 2, rate: 1 });
  });

  it('[FR-SK-06] is aggregated per skill only: identifiers of people never reach the output', () => {
    const tagged = sample.map((r) =>
      Object.assign({}, r, {
        engineerId: 'user_ava_engineer',
        email: 'ava@contoso-synthetic.invalid',
      }),
    );
    const text = JSON.stringify(aggregateSkillEffectiveness(tagged));
    expect(text).not.toMatch(/user_ava_engineer|ava@contoso/);
    expect(report.privacy).toEqual({
      personalData: false,
      aggregation: 'per_skill',
      note: expect.stringMatching(/no user or engineer identifiers/i),
    });
    expect(aggregateSkillEffectiveness(tagged)).toEqual(report);
  });

  it('[FR-SK-06] does not depend on the order of the records', () => {
    expect(aggregateSkillEffectiveness([...sample].reverse())).toEqual(report);
  });
});

const recordArb = fc.record({
  skillId: fc.constantFrom('skill_a', 'skill_b'),
  versionId: fc.constantFrom('skv_1', 'skv_2'),
  caseId: fc.constantFrom('c1', 'c2', 'c3', 'c4', 'c5', 'c6'),
  synthetic: fc.boolean(),
  matched: fc.boolean(),
  applied: fc.boolean(),
  suggestionsOffered: fc.nat(8),
  suggestionsAccepted: fc.nat(12),
  timeToDiagnosisMinutes: fc.option(fc.integer({ min: 1, max: 6000 }), { nil: null }),
  baselineTimeToDiagnosisMinutes: fc.option(fc.integer({ min: 1, max: 6000 }), { nil: null }),
  tokenEstimate: fc.option(fc.integer({ min: 0, max: 20000 }), { nil: null }),
  baselineTokenEstimate: fc.option(fc.integer({ min: 0, max: 20000 }), { nil: null }),
  evidenceCompleteness: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null }),
  baselineEvidenceCompleteness: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), {
    nil: null,
  }),
  conformanceScore: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null }),
});

describe('effectiveness properties', () => {
  it('[FR-SK-06] every aggregate satisfies the contract, stays in bounds and keeps its labels', () => {
    fc.assert(
      fc.property(fc.array(recordArb, { maxLength: 30 }), (records) => {
        const out = aggregateSkillEffectiveness(records);
        expect(SkillEffectivenessSchema.safeParse(out.effectiveness).success).toBe(true);
        expect(out.estimated).toBe(true);
        expect(out.effectiveness.estimated).toBe(true);
        for (const rate of [out.adoption.adoptionRate, out.suggestionAcceptance.rate]) {
          if (rate !== null) expect(rate >= 0 && rate <= 1).toBe(true);
        }
        expect(out.suggestionAcceptance.accepted).toBeLessThanOrEqual(
          out.suggestionAcceptance.offered,
        );
        expect(out.adoption.appliedCases).toBeLessThanOrEqual(out.adoption.matchedCases);
        expect(out.confidence.score).toBeLessThanOrEqual(0.9);
        const range = out.estimatedTimeSaved.perCaseMinutes;
        if (range) expect(range.low <= range.mid && range.mid <= range.high).toBe(true);
        expect(out.privacy.personalData).toBe(false);
      }),
      { numRuns: 200, seed: 20261029 },
    );
  });

  it('[FR-SK-06] is deterministic and independent of the order of distinct cases', () => {
    fc.assert(
      fc.property(fc.array(recordArb, { maxLength: 20 }), (records) => {
        const unique = [
          ...new Map(records.map((r) => [`${r.skillId}|${r.versionId}|${r.caseId}`, r])).values(),
        ];
        expect(aggregateSkillEffectiveness(unique)).toEqual(
          aggregateSkillEffectiveness([...unique].reverse()),
        );
        expect(aggregateSkillEffectiveness(records)).toEqual(aggregateSkillEffectiveness(records));
      }),
      { numRuns: 100, seed: 20261030 },
    );
  });
});
