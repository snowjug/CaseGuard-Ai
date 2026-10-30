import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AnalyticsOverviewSchema,
  FORK_CATEGORIES,
  RESPONSIBLE_USE_NOTICE,
  type MetricEstimate,
} from '@caseguard/schemas';
import {
  GENERIC_ASSUMPTION_SUBJECT,
  buildAnalyticsOverview,
  buildMetricEstimates,
  computeAvoidableEffort,
  computeEfficiency,
  computeQualityReview,
  type AnalyticsInput,
} from '../src';
import { CASE_ONE, CASE_TWO, NOW, prepareCase, type Prepared } from './helpers';
import { scenariosFor } from './quality-fixtures';

const one = prepareCase(CASE_ONE);
const two = prepareCase(CASE_TWO);

function metricsFor(p: Prepared, withScenarios: boolean): MetricEstimate[] {
  const avoidable = computeAvoidableEffort({
    analysis: p.analysis,
    pack: p.pack,
    scenarios: withScenarios ? scenariosFor(p) : [],
  });
  return buildMetricEstimates({
    analysis: p.analysis,
    pack: p.pack,
    ctx: p.ctx,
    review: computeQualityReview({ analysis: p.analysis, pack: p.pack, ctx: p.ctx }),
    avoidable,
    efficiency: computeEfficiency({
      analysis: p.analysis,
      pack: p.pack,
      caseId: p.ctx.caseId,
      synthetic: true,
      avoidable,
    }),
    synthetic: true,
  });
}

const qualityRow = (p: Prepared, caseId: string) => {
  const review = computeQualityReview({ analysis: p.analysis, pack: p.pack, ctx: p.ctx });
  return {
    caseId,
    analyzedAt: NOW,
    compositeScore: review.compositeScore,
    evidenceIntegrity: review.dimensions.find((d) => d.key === 'evidence_integrity')?.score ?? 0,
  };
};

const metricRows = (caseId: string, list: MetricEstimate[]): AnalyticsInput['metrics'] =>
  list.map((m) => ({
    caseId,
    key: m.key,
    value: m.value,
    ase: m.ase
      ? {
          components: m.ase.components.map((c) => ({
            key: c.key,
            label: c.label,
            avoidablePct: c.avoidablePct,
          })),
        }
      : null,
  }));

type Precedent = NonNullable<AnalyticsInput['skills'][number]['effectiveness']['precedent']>;

const precedentOf = (current: number | null, earlier: number | null): Precedent => ({
  cases: 1,
  references: ['CG-SYN-1001'],
  avgTimeToDiagnosisMinutes: current,
  precedentAvgTimeToDiagnosisMinutes: earlier,
  tokenChangePct: -80,
  evidenceCompletenessPoints: 0,
  basis: 'Compared with the recorded path of the case the skill came from.',
});

const skill = (
  id: string,
  lifecycle: AnalyticsInput['skills'][number]['lifecycle'],
  applications: number,
  current: number | null,
  baseline: number | null,
  precedent?: Precedent,
): AnalyticsInput['skills'][number] => ({
  id,
  name: `Skill ${id}`,
  lifecycle,
  synthetic: true,
  effectiveness: {
    applications,
    matchedCases: applications,
    avgTimeToDiagnosisMinutes: current,
    baselineAvgTimeToDiagnosisMinutes: baseline,
    conformanceAvg: null,
    estimatedTokenSavingsPct: null,
    notes: [],
    synthetic: true,
    estimated: true,
    ...(precedent ? { precedent } : {}),
  },
});

const oneMetrics = metricsFor(one, true);
const twoMetrics = metricsFor(two, false);
const oneScenarios = scenariosFor(one);

const input: AnalyticsInput = {
  cases: [
    {
      id: 'case_one',
      synthetic: true,
      analysisState: 'analyzed',
      openedAt: '2026-03-09T09:12:00Z',
    },
    {
      id: 'case_two',
      synthetic: true,
      analysisState: 'analyzed',
      openedAt: '2026-04-14T08:00:00Z',
    },
    {
      id: 'case_new',
      synthetic: false,
      analysisState: 'pending',
      openedAt: '2026-04-20T08:00:00Z',
    },
  ],
  quality: [qualityRow(one, 'case_one'), qualityRow(two, 'case_two')],
  forks: [
    ...one.analysis.forks.map((f) => ({ caseId: 'case_one', category: f.category })),
    { caseId: 'case_two', category: 'not_a_category' },
  ],
  missing: [
    {
      caseId: 'case_one',
      requirementId: 'req.error-code',
      label: 'Error code or message',
      resolved: false,
    },
    {
      caseId: 'case_two',
      requirementId: 'req.error-code',
      label: 'Error code or message',
      resolved: false,
    },
    {
      caseId: 'case_one',
      requirementId: 'req.sample-users',
      label: 'Sample affected users',
      resolved: true,
    },
  ],
  metrics: [...metricRows('case_one', oneMetrics), ...metricRows('case_two', twoMetrics)],
  assumptionFlags: [
    { caseId: 'case_one', subject: 'hyp.conditional-access' },
    { caseId: 'case_one', subject: 'hyp.conditional-access' },
    { caseId: 'case_two', subject: null },
    { caseId: 'case_two', subject: '   ' },
  ],
  scenarios: oneScenarios.slice(0, 6).map((s, i) => ({
    caseId: 'case_one',
    reviewState:
      (['confirmed', 'rejected', 'corrected', 'pending', 'pending', 'confirmed'] as const)[i] ??
      'pending',
    counterfactualTokens: s.counterfactualMetrics.tokenEstimate.mid,
    actualTokens: s.actualMetrics.tokenEstimate.mid,
  })),
  skills: [
    skill('skill_a', 'published', 4, 60, 120),
    skill('skill_b', 'pilot', 1, null, 90),
    skill('skill_c', 'draft', 0, null, null),
  ],
  matches: [
    { caseId: 'case_one', skillId: 'skill_a', applied: true },
    { caseId: 'case_two', skillId: 'skill_a', applied: false },
    { caseId: 'case_two', skillId: 'skill_b', applied: false },
  ],
  reviewStats: { reviewedClaims: 20, correctedClaims: 3 },
};

const overview = (
  options: Partial<Parameters<typeof buildAnalyticsOverview>[1]> = {},
  source = input,
) => buildAnalyticsOverview(source, { now: NOW, ...options });

const keysDeep = (value: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysDeep(v, out);
    }
  }
  return out;
};

describe('quality analytics (FR-AN-01)', () => {
  const result = overview();

  it('[FR-AN-01] produces a valid overview that covers every analytics area', () => {
    expect(() => AnalyticsOverviewSchema.parse(result)).not.toThrow();
    expect(result.generatedAt).toBe(NOW);
    expect(result.cohort).toMatchObject({
      caseCount: 3,
      analyzedCaseCount: 2,
      syntheticCaseCount: 2,
    });
    expect(result.cohort.note).toMatch(/n=2/);
    expect(result.cohort.note).toMatch(/illustrative/);
  });

  it('[FR-AN-01] quality trend averages the reviews per period, oldest first', () => {
    expect(result.qualityTrend.map((t) => t.period)).toEqual(['2026-03', '2026-04']);
    expect(result.qualityTrend[0]).toMatchObject({
      caseCount: 1,
      avgQuality: input.quality[0]?.compositeScore,
      avgEvidenceIntegrity: input.quality[0]?.evidenceIntegrity,
    });
    expect(result.qualityTrend[1]?.avgQuality).toBe(input.quality[1]?.compositeScore);
    const daily = overview({ period: 'day' });
    expect(daily.qualityTrend.map((t) => t.period)).toEqual(['2026-03-09', '2026-04-14']);
    const weekly = overview({ period: 'week' });
    expect(weekly.qualityTrend.map((t) => t.period)).toEqual([
      '2026-03-09 (week)',
      '2026-04-13 (week)',
    ]);
  });

  it('[FR-AN-01] fork categories count only known categories and shares add up to one', () => {
    const counted = result.forkCategories.reduce((s, c) => s + c.count, 0);
    expect(counted).toBe(one.analysis.forks.length);
    expect(result.forkCategories.every((c) => FORK_CATEGORIES.includes(c.category))).toBe(true);
    expect(result.forkCategories.reduce((s, c) => s + c.share, 0)).toBeCloseTo(1, 1);
    const counts = result.forkCategories.map((c) => c.count);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  it('[FR-AN-01] missing evidence counts the cases still missing an item, unless resolved ones are requested', () => {
    expect(result.missingEvidence).toEqual([
      { requirementId: 'req.error-code', label: 'Error code or message', count: 2 },
    ]);
    const all = overview({ includeResolvedMissing: true });
    expect(all.missingEvidence.map((m) => m.requirementId)).toEqual([
      'req.error-code',
      'req.sample-users',
    ]);
  });

  it('[FR-AN-01] avoidable-effort patterns come from the per-component estimates and stay within 0-100', () => {
    const caseOneAse = oneMetrics.find((m) => m.key === 'avoidable_support_effort')?.ase;
    expect(result.avoidableEffortPatterns.length).toBe(caseOneAse?.components.length);
    for (const pattern of result.avoidableEffortPatterns) {
      const source = caseOneAse?.components.find((c) => c.key === pattern.component);
      expect(pattern.avgAvoidablePct).toBeCloseTo(source?.avoidablePct ?? -1, 1);
      expect(pattern.avgAvoidablePct).toBeGreaterThanOrEqual(0);
      expect(pattern.avgAvoidablePct).toBeLessThanOrEqual(100);
      expect(pattern.caseCount).toBe(1);
    }
    const pcts = result.avoidableEffortPatterns.map((p) => p.avgAvoidablePct);
    expect([...pcts].sort((a, b) => b - a)).toEqual(pcts);
  });

  it('[FR-AN-01] skill adoption and effectiveness', () => {
    expect(result.skillAdoption).toEqual({
      totalSkills: 3,
      published: 1,
      pilotOrValidated: 1,
      matchedCases: 2,
      appliedCases: 1,
    });
    expect(result.skillEffectiveness.map((s) => s.skillId)).toEqual(['skill_a', 'skill_b']);
    expect(result.skillEffectiveness[0]).toMatchObject({
      applications: 4,
      timeToDiagnosisDeltaPct: 50,
      timeToDiagnosisBasis: 'simulated_baseline',
    });
    expect(result.skillEffectiveness[1]?.timeToDiagnosisDeltaPct).toBeNull();
    expect(result.skillEffectiveness[1]).not.toHaveProperty('timeToDiagnosisBasis');
  });

  it('[FR-AN-01] effectiveness prefers the like-for-like earlier case over the simulated baseline', () => {
    const withPrecedent = overview(
      {},
      {
        ...input,
        skills: [
          // The simulated baseline says -50%, the earlier case says 75%: the earlier case wins.
          skill('skill_a', 'published', 4, 180, 120, precedentOf(30, 120)),
          // Nothing to compare with in the earlier case: fall back to the simulated baseline.
          skill('skill_b', 'pilot', 3, 60, 120, precedentOf(null, 120)),
          // A zero precedent cannot be divided by.
          skill('skill_c', 'validated', 2, null, null, precedentOf(30, 0)),
          // Slower than the earlier case: a negative change, not clamped.
          skill('skill_d', 'validated', 1, null, null, precedentOf(150, 100)),
        ],
      },
    );
    const byId = new Map(withPrecedent.skillEffectiveness.map((row) => [row.skillId, row]));
    expect(byId.get('skill_a')).toMatchObject({
      timeToDiagnosisDeltaPct: 75,
      timeToDiagnosisBasis: 'earlier_case',
    });
    expect(byId.get('skill_b')).toMatchObject({
      timeToDiagnosisDeltaPct: 50,
      timeToDiagnosisBasis: 'simulated_baseline',
    });
    expect(byId.get('skill_c')?.timeToDiagnosisDeltaPct).toBeNull();
    expect(byId.get('skill_c')).not.toHaveProperty('timeToDiagnosisBasis');
    expect(byId.get('skill_d')).toMatchObject({
      timeToDiagnosisDeltaPct: -50,
      timeToDiagnosisBasis: 'earlier_case',
    });
    expect(AnalyticsOverviewSchema.safeParse(withPrecedent).success).toBe(true);
  });

  it('[FR-AN-01] token efficiency, counterfactual acceptance and reviewer disagreement', () => {
    const bits = [oneMetrics, twoMetrics]
      .map((list) => list.find((m) => m.key === 'token_efficiency')?.value ?? 0)
      .filter((v) => v > 0);
    const mean = bits.reduce((s, v) => s + v, 0) / bits.length;
    expect(result.tokenEfficiency.avgBitsPer1kTokens).toBeCloseTo(mean, 1);
    expect(result.tokenEfficiency.avgEstimatedSavingsPct ?? -1).toBeGreaterThanOrEqual(0);
    expect(result.tokenEfficiency.avgEstimatedSavingsPct ?? 101).toBeLessThanOrEqual(100);
    expect(result.counterfactualAcceptance).toEqual({
      reviewed: 4,
      accepted: 3,
      rejected: 1,
      rate: 0.75,
    });
    expect(result.reviewerDisagreement).toEqual({ reviewedClaims: 20, corrected: 3, rate: 0.15 });
  });

  it('[FR-AN-01] frequent unsupported assumptions group by subject, never by statement text', () => {
    expect(result.frequentUnsupportedAssumptions).toEqual(
      [
        { subject: GENERIC_ASSUMPTION_SUBJECT, count: 2 },
        { subject: 'hyp.conditional-access', count: 2 },
      ].sort((a, b) => b.count - a.count || (a.subject < b.subject ? -1 : 1)),
    );
    const withText = [
      {
        caseId: 'case_one',
        subject: 'hyp.x',
        text: 'Root cause is the Conditional Access policy for Contoso',
      },
    ];
    const privacy = overview({}, { ...input, assumptionFlags: withText });
    expect(JSON.stringify(privacy)).not.toMatch(/Contoso|Conditional Access policy/);
    expect(privacy.frequentUnsupportedAssumptions).toEqual([{ subject: 'hyp.x', count: 1 }]);
  });
});

describe('privacy and responsible use (FR-AN-02)', () => {
  const result = overview();
  const text = JSON.stringify(result);

  it('[FR-AN-02] carries the responsible-use notice and the privacy notes', () => {
    expect(result.responsibleUseNotice).toBe(RESPONSIBLE_USE_NOTICE);
    expect(result.privacyNotes.join(' ')).toMatch(/No individual employee is ranked/);
    expect(result.privacyNotes.join(' ')).toMatch(/no case text/);
  });

  it('[FR-AN-02] contains no case text, customer names, participant aliases or case identifiers', () => {
    const bodies = one.analysis.view.events
      .flatMap((e) => [e.title ?? '', e.body])
      .filter((t) => t.length > 8);
    for (const snippet of bodies) expect(text).not.toContain(snippet.slice(0, 40));
    for (const forbidden of [
      one.bundle.case.customerAlias,
      one.bundle.case.reference,
      one.bundle.case.title,
      'Support Engineer',
      'Identity Escalation',
      'case_one',
      'case_two',
    ]) {
      if (forbidden) expect(text).not.toContain(forbidden);
    }
  });

  it('[FR-AN-02] has no per-person fields at all', () => {
    const keys = [...keysDeep(result)];
    expect(
      keys.filter((k) => /engineer|author|employee|participant|person|agent|user|owner/i.test(k)),
    ).toEqual([]);
    expect(keys).not.toContain('caseId');
  });

  it('[FR-AN-02] suppresses small groups on request and says so', () => {
    const strict = overview({ minCellSize: 2 });
    expect(strict.qualityTrend).toEqual([]);
    expect(strict.missingEvidence.map((m) => m.requirementId)).toEqual(['req.error-code']);
    expect(strict.forkCategories.every((c) => c.count >= 2)).toBe(true);
    expect(strict.privacyNotes.join(' ')).toMatch(/fewer than 2 cases are suppressed/);
  });

  it('limits ranked lists to topN', () => {
    const top = overview({ topN: 2 });
    expect(top.avoidableEffortPatterns.length).toBeLessThanOrEqual(2);
    expect(top.frequentUnsupportedAssumptions.length).toBeLessThanOrEqual(2);
  });
});

describe('analytics robustness (FR-AN-01)', () => {
  const empty: AnalyticsInput = {
    cases: [],
    quality: [],
    forks: [],
    missing: [],
    metrics: [],
    assumptionFlags: [],
    scenarios: [],
    skills: [],
    matches: [],
  };

  it('[FR-AN-01] an empty portfolio yields explicit empty states, never NaN', () => {
    const result = overview({}, empty);
    expect(() => AnalyticsOverviewSchema.parse(result)).not.toThrow();
    expect(result.cohort.caseCount).toBe(0);
    expect(result.tokenEfficiency).toEqual({
      avgBitsPer1kTokens: null,
      avgEstimatedSavingsPct: null,
    });
    expect(result.counterfactualAcceptance.rate).toBeNull();
    expect(result.reviewerDisagreement.rate).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/NaN|Infinity/);
  });

  it('is pure and deterministic: no mutation of the input, identical output for identical input', () => {
    const before = structuredClone(input);
    const first = overview();
    expect(input).toEqual(before);
    expect(overview()).toEqual(first);
  });

  it('[FR-AN-01] never reports more corrections than reviews', () => {
    const result = overview(
      {},
      { ...input, reviewStats: { reviewedClaims: 4, correctedClaims: 9 } },
    );
    expect(result.reviewerDisagreement).toEqual({ reviewedClaims: 4, corrected: 4, rate: 1 });
  });

  it('[FR-AN-01] every generated portfolio satisfies the contract (property)', () => {
    const scoreArb = fc.double({ min: 0, max: 100, noNaN: true });
    const caseIds = ['c1', 'c2', 'c3', 'c4'];
    const portfolioArb = fc.record({
      quality: fc.array(
        fc.record({
          caseId: fc.constantFrom(...caseIds),
          analyzedAt: fc.constant(NOW),
          compositeScore: scoreArb,
          evidenceIntegrity: scoreArb,
        }),
        { maxLength: 8 },
      ),
      forks: fc.array(
        fc.record({
          caseId: fc.constantFrom(...caseIds),
          category: fc.constantFrom(...FORK_CATEGORIES, 'unknown_category'),
        }),
        { maxLength: 12 },
      ),
      scenarios: fc.array(
        fc.record({
          caseId: fc.constantFrom(...caseIds),
          reviewState: fc.constantFrom('pending', 'confirmed', 'corrected', 'rejected'),
          counterfactualTokens: fc.double({ min: 0, max: 100_000, noNaN: true }),
          actualTokens: fc.double({ min: 0, max: 100_000, noNaN: true }),
        }),
        { maxLength: 8 },
      ),
      reviewed: fc.nat(50),
      corrected: fc.nat(80),
      minCellSize: fc.integer({ min: 0, max: 3 }),
    });
    fc.assert(
      fc.property(portfolioArb, (p) => {
        const source: AnalyticsInput = {
          ...empty,
          cases: caseIds.map((id) => ({
            id,
            synthetic: true,
            analysisState: 'analyzed',
            openedAt: '2026-05-01T00:00:00Z',
          })),
          quality: p.quality,
          forks: p.forks,
          scenarios: p.scenarios,
          reviewStats: { reviewedClaims: p.reviewed, correctedClaims: p.corrected },
        };
        const result = overview({ minCellSize: p.minCellSize }, source);
        expect(() => AnalyticsOverviewSchema.parse(result)).not.toThrow();
        expect(JSON.stringify(result)).not.toMatch(/NaN|Infinity/);
        const savings = result.tokenEfficiency.avgEstimatedSavingsPct;
        if (savings !== null) {
          expect(savings).toBeGreaterThanOrEqual(0);
          expect(savings).toBeLessThanOrEqual(100);
        }
      }),
      { numRuns: 100 },
    );
  });
});
