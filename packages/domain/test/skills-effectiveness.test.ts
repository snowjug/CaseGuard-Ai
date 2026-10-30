import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SkillEffectivenessSchema } from '@caseguard/schemas';
import {
  aggregateSkillEffectiveness,
  mean,
  rangeOf,
  round,
  type SkillUsagePrecedent,
  type SkillUsageRecord,
} from '../src';

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

describe('effectiveness against the recorded path of the case the skill came from', () => {
  // The origin's own recorded path: slower, heavier and less complete than the applications below.
  const precedent = (over: Partial<SkillUsagePrecedent> = {}): SkillUsagePrecedent => ({
    reference: 'CG-SYN-1001',
    timeToDiagnosisMinutes: 400,
    tokenEstimate: 8000,
    evidenceCompleteness: 0.5,
    ...over,
  });
  const BASIS =
    'Compared with the recorded path of the case the skill came from (1 earlier case); different cases, no control group: an estimate, not a measurement.';

  it('[FR-SK-06] has no precedent block without applications, and says nothing about a second basis', () => {
    const empty = aggregateSkillEffectiveness([]);
    expect(empty.effectiveness.precedent).toBeUndefined();
    expect('precedent' in empty.effectiveness).toBe(false);
    expect(empty.effectiveness.notes).toEqual([
      'No applications recorded yet.',
      'No engineer-level data is used: usage is aggregated per skill.',
    ]);
    expect(empty.confidence.rationale).not.toMatch(/recorded path/);
    // Records without a precedent (as every record was before it existed) give exactly the old output.
    const legacy = aggregateSkillEffectiveness(sample);
    expect(legacy.effectiveness.precedent).toBeUndefined();
    expect('precedent' in legacy.effectiveness).toBe(false);
    expect(legacy.confidence.rationale).not.toMatch(/recorded path/);
  });

  it('[FR-SK-06] compares one application with the recorded path of the origin: faster, fewer tokens, as estimates', () => {
    const one = aggregateSkillEffectiveness([record({ precedent: precedent() })]);
    expect(one.effectiveness.precedent).toEqual({
      cases: 1,
      references: ['CG-SYN-1001'],
      avgTimeToDiagnosisMinutes: 120,
      precedentAvgTimeToDiagnosisMinutes: 400,
      tokenChangePct: -50,
      evidenceCompletenessPoints: 50,
      basis: BASIS,
    });
    expect(() => SkillEffectivenessSchema.parse(one.effectiveness)).not.toThrow();
    expect(one.effectiveness.estimated).toBe(true);
    // Both bases are named, so neither is read as the other.
    expect(one.effectiveness.notes).toEqual([
      'Estimated from 1 recorded application; figures are model estimates, not measurements.',
      expect.stringMatching(
        /^Two bases are shown, and both are estimates: a seeded simulation of the knowledge-pack policy without the skill \(it has no waiting between steps, so recorded times read longer than it by construction\) and the recorded path of the case the skill came from \(a different case, with no control group\)\.$/,
      ),
      'No engineer-level data is used: usage is aggregated per skill.',
    ]);
    expect(one.confidence.rationale).toBe(
      '1 applied case, all synthetic; estimates come from simulated baselines without a control group, and from the recorded path of the case the skill came from (a different case, also without a control group).',
    );
    const text = [one.effectiveness.precedent?.basis, ...one.effectiveness.notes].join(' ');
    expect(text).not.toMatch(/(proves|guarantee|thanks to the skill|because of the skill)/i);
  });

  it('[FR-SK-06] leaves every figure against the simulated baseline exactly as it was', () => {
    const plain = aggregateSkillEffectiveness(sample);
    const withPrecedent = aggregateSkillEffectiveness(
      sample.map((r) => (r.applied ? { ...r, precedent: precedent() } : r)),
    );
    const { precedent: block, notes, ...figures } = withPrecedent.effectiveness;
    const { notes: plainNotes, ...plainFigures } = plain.effectiveness;
    expect(figures).toEqual(plainFigures);
    expect(block?.cases).toBe(3);
    expect(notes.slice(0, 1)).toEqual(plainNotes.slice(0, 1));
    expect(notes.at(-1)).toBe(plainNotes.at(-1));
    // Adoption, acceptance, saved time and uplift are the simulated comparison; none of them moved.
    for (const key of [
      'adoption',
      'suggestionAcceptance',
      'estimatedTimeSaved',
      'evidenceCompletenessUplift',
      'privacy',
      'notices',
    ] as const) {
      expect(withPrecedent[key], key).toEqual(plain[key]);
    }
  });

  it('[FR-SK-06] reports a worse result as such: slower, heavier and less complete than the origin', () => {
    const worse = aggregateSkillEffectiveness([
      record({
        timeToDiagnosisMinutes: 500,
        tokenEstimate: 10000,
        evidenceCompleteness: 0.4,
        precedent: precedent(),
      }),
    ]);
    expect(worse.effectiveness.precedent).toMatchObject({
      avgTimeToDiagnosisMinutes: 500,
      precedentAvgTimeToDiagnosisMinutes: 400,
      tokenChangePct: 25,
      evidenceCompletenessPoints: -10,
    });
  });

  it('[FR-SK-06] counts only applications that have a precedent, and explains the ones that do not', () => {
    const mixed = aggregateSkillEffectiveness([
      record({ caseId: 'c_compared', precedent: precedent() }),
      record({ caseId: 'c_origin', precedent: null, precedentUnavailable: 'origin_case' }),
      record({ caseId: 'c_gone', precedent: null, precedentUnavailable: 'origin_unavailable' }),
      // Written before precedents existed: no figure and no reason, so no claim either.
      record({ caseId: 'c_legacy' }),
      // Only offered, never applied: never compared.
      record({
        caseId: 'c_offered',
        applied: false,
        precedent: precedent({ timeToDiagnosisMinutes: 1 }),
      }),
    ]);
    expect(mixed.effectiveness.applications).toBe(4);
    expect(mixed.effectiveness.precedent).toMatchObject({
      cases: 1,
      avgTimeToDiagnosisMinutes: 120,
      precedentAvgTimeToDiagnosisMinutes: 400,
    });
    expect(mixed.effectiveness.notes).toEqual([
      'Estimated from 4 recorded applications; figures are model estimates, not measurements.',
      expect.stringMatching(/^Two bases are shown/),
      '1 application is on the case the skill came from and is not compared with that case’s own recorded path.',
      'The recorded path of the case the skill came from is not available, so 1 application has no comparison with it.',
      'No engineer-level data is used: usage is aggregated per skill.',
    ]);
  });

  it('[FR-SK-06] without any usable precedent there is no block, only the reason, in the plural too', () => {
    const gone = aggregateSkillEffectiveness([
      record({ caseId: 'c_1', precedent: null, precedentUnavailable: 'origin_unavailable' }),
      record({ caseId: 'c_2', precedent: null, precedentUnavailable: 'origin_unavailable' }),
      record({ caseId: 'c_3', precedent: null, precedentUnavailable: 'origin_case' }),
    ]);
    expect(gone.effectiveness.precedent).toBeUndefined();
    expect(gone.effectiveness.notes).toEqual([
      'Estimated from 3 recorded applications; figures are model estimates, not measurements.',
      '1 application is on the case the skill came from and is not compared with that case’s own recorded path.',
      'The recorded path of the case the skill came from is not available, so 2 applications have no comparison with it.',
      'No engineer-level data is used: usage is aggregated per skill.',
    ]);
    expect(gone.confidence.rationale).not.toMatch(/recorded path/);
    const notes = gone.effectiveness.notes;
    expect(new Set(notes).size).toBe(notes.length);
  });

  it('[FR-SK-06] compares each metric only over the applications that have both figures', () => {
    const partial = aggregateSkillEffectiveness([
      record({
        caseId: 'c_a',
        timeToDiagnosisMinutes: 100,
        tokenEstimate: 1000,
        evidenceCompleteness: 1,
        precedent: precedent({ reference: 'CG-B', tokenEstimate: 4000 }),
      }),
      // Never reached a diagnosis and has no completeness figure: only its tokens can be compared.
      record({
        caseId: 'c_b',
        timeToDiagnosisMinutes: null,
        tokenEstimate: 3000,
        evidenceCompleteness: null,
        precedent: precedent({ reference: 'CG-A', tokenEstimate: 4000 }),
      }),
    ]);
    expect(partial.effectiveness.precedent).toEqual({
      cases: 2,
      references: ['CG-A', 'CG-B'],
      avgTimeToDiagnosisMinutes: 100,
      precedentAvgTimeToDiagnosisMinutes: 400,
      // (1000 + 3000 - 8000) / 8000
      tokenChangePct: -50,
      evidenceCompletenessPoints: 50,
      basis:
        'Compared with the recorded path of the case the skill came from (2 earlier cases); different cases, no control group: an estimate, not a measurement.',
    });
  });

  it('[FR-SK-06] says nothing it cannot measure: no times, no tokens to compare, no completeness', () => {
    const bare = aggregateSkillEffectiveness([
      record({
        timeToDiagnosisMinutes: null,
        tokenEstimate: null,
        evidenceCompleteness: null,
        precedent: precedent(),
      }),
      record({
        caseId: 'c_2',
        tokenEstimate: 100,
        precedent: precedent({ tokenEstimate: 0 }),
      }),
    ]);
    expect(bare.effectiveness.precedent).toMatchObject({
      cases: 2,
      avgTimeToDiagnosisMinutes: 120,
      precedentAvgTimeToDiagnosisMinutes: 400,
      // The only token pair has a precedent of zero tokens, so there is nothing to divide by.
      tokenChangePct: null,
      evidenceCompletenessPoints: 50,
    });
    const none = aggregateSkillEffectiveness([
      record({
        timeToDiagnosisMinutes: null,
        tokenEstimate: null,
        evidenceCompleteness: null,
        precedent: precedent(),
      }),
    ]);
    expect(none.effectiveness.precedent).toMatchObject({
      cases: 1,
      avgTimeToDiagnosisMinutes: null,
      precedentAvgTimeToDiagnosisMinutes: null,
      tokenChangePct: null,
      evidenceCompletenessPoints: null,
    });
    expect(() => SkillEffectivenessSchema.parse(none.effectiveness)).not.toThrow();
  });

  it('[FR-SK-06] does not depend on the order of the records, with or without precedents', () => {
    const records = [
      record({ caseId: 'c_1', precedent: precedent() }),
      record({
        caseId: 'c_2',
        timeToDiagnosisMinutes: 300,
        precedent: precedent({ reference: 'CG-B' }),
      }),
      record({ caseId: 'c_3', precedent: null, precedentUnavailable: 'origin_case' }),
    ];
    expect(aggregateSkillEffectiveness([...records].reverse())).toEqual(
      aggregateSkillEffectiveness(records),
    );
  });
});

const precedentArb = fc.record({
  reference: fc.constantFrom('CG-SYN-1001', 'CG-SYN-2001'),
  timeToDiagnosisMinutes: fc.integer({ min: 1, max: 6000 }),
  tokenEstimate: fc.integer({ min: 0, max: 20000 }),
  evidenceCompleteness: fc.double({ min: 0, max: 1, noNaN: true }),
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
  precedent: fc.option(precedentArb, { nil: null }),
  precedentUnavailable: fc.constantFrom(
    'origin_case' as const,
    'origin_unavailable' as const,
    undefined,
  ),
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

  it('[FR-SK-06] a precedent block stays within what it can mean and never changes the simulated figures', () => {
    fc.assert(
      fc.property(fc.array(recordArb, { maxLength: 30 }), (records) => {
        const out = aggregateSkillEffectiveness(records).effectiveness;
        const block = out.precedent;
        if (block !== undefined) {
          expect(block.cases).toBeGreaterThanOrEqual(1);
          expect(block.cases).toBeLessThanOrEqual(out.applications);
          expect(block.references.length).toBeGreaterThanOrEqual(1);
          expect([...block.references].sort()).toEqual(block.references);
          // Fewer tokens can save at most all of them; times come in pairs.
          if (block.tokenChangePct !== null)
            expect(block.tokenChangePct).toBeGreaterThanOrEqual(-100);
          if (block.evidenceCompletenessPoints !== null) {
            expect(Math.abs(block.evidenceCompletenessPoints)).toBeLessThanOrEqual(100);
          }
          expect(block.avgTimeToDiagnosisMinutes === null).toBe(
            block.precedentAvgTimeToDiagnosisMinutes === null,
          );
          expect(block.basis).toMatch(
            /different cases, no control group: an estimate, not a measurement\.$/,
          );
        }
        const bare = records.map(({ precedent: _p, precedentUnavailable: _u, ...rest }) => rest);
        const { precedent: _block, notes: _notes, ...figures } = out;
        const { notes: _bareNotes, ...bareFigures } =
          aggregateSkillEffectiveness(bare).effectiveness;
        expect(figures).toEqual(bareFigures);
      }),
      { numRuns: 150, seed: 20261031 },
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
