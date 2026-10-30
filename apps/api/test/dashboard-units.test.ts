import { describe, expect, it } from 'vitest';
import {
  METRIC_DEFINITIONS,
  METRIC_KEYS,
  MetricCardSchema,
  type CaseWarning,
  type Hypothesis,
  type SkillMatch,
  type SystemHealth,
} from '@caseguard/schemas';
import {
  buildCards,
  bestSkillMatch,
  commandCenterNotices,
  criticalMissingOf,
  defaultCaseId,
  leadingHypothesisOf,
  metricHref,
  openWarningsOf,
  previousAnalysedCase,
  skillCandidatesOf,
  summarizeHealth,
  trendOf,
} from '../src/services/dashboard';
import { estimateOf, estimatesOf, listItem, skillOf } from './insights-fixtures';

const BASE = {
  reference: 'CG-SYN-1001',
  estimates: estimatesOf('case_one', {
    case_quality_index: 36,
    avoidable_support_effort: 60,
    customer_effort: 600,
  }),
};

describe('[FR-CC-01] metric cards', () => {
  it('has the seven metrics in contract order, each explained, estimated, banded and linked', () => {
    const estimates = estimatesOf('case_two', {
      case_quality_index: 99,
      evidence_integrity: 90,
      avoidable_support_effort: 10,
      reasoning_efficiency: 50,
      customer_effort: 200,
      resolution_confidence: 40,
      token_efficiency: 2,
    });
    const cards = buildCards({ caseId: 'case_two', synthetic: true, estimates, base: null });
    expect(cards.map((card) => card.key)).toEqual([...METRIC_KEYS]);
    for (const [index, key] of METRIC_KEYS.entries()) {
      const card = cards[index];
      expect(MetricCardSchema.safeParse(card).success, key).toBe(true);
      expect(card?.definition, key).toBe(METRIC_DEFINITIONS[key].definition);
      expect(card?.formula, key).toBe(METRIC_DEFINITIONS[key].formula);
      expect(card).toMatchObject({ estimated: true, synthetic: true, caseId: 'case_two' });
      expect(card?.range, key).not.toBeNull();
      expect(card?.evidenceLink?.href, key).toBe(metricHref(key, 'case_two'));
    }
    // From the shared thresholds: higher is better except for avoidable effort and customer effort.
    expect(cards.map((card) => card.status)).toEqual([
      'good',
      'good',
      'good',
      'watch',
      'watch',
      'poor',
      'good',
    ]);
  });

  it('takes the status band from the estimate (the domain owns the thresholds) and says unknown when there is no value', () => {
    const estimates = [
      estimateOf('case_quality_index', 90),
      estimateOf('evidence_integrity', 70),
      estimateOf('avoidable_support_effort', 60),
      estimateOf('reasoning_efficiency', null),
      estimateOf('customer_effort', 100),
      estimateOf('resolution_confidence', 55),
      estimateOf('token_efficiency', 0.1),
    ];
    const byKey = new Map(
      buildCards({ caseId: 'case_a', synthetic: true, estimates, base: null }).map(
        (card) => [card.key, card] as const,
      ),
    );
    expect(byKey.get('case_quality_index')).toMatchObject({ status: 'good' });
    expect(byKey.get('evidence_integrity')).toMatchObject({ status: 'watch' });
    expect(byKey.get('avoidable_support_effort')).toMatchObject({ status: 'poor' });
    expect(byKey.get('reasoning_efficiency')).toMatchObject({
      status: 'unknown',
      value: null,
      range: null,
    });
    expect(byKey.get('customer_effort')).toMatchObject({ status: 'good' });
    expect(byKey.get('resolution_confidence')).toMatchObject({ status: 'watch' });
    expect(byKey.get('token_efficiency')).toMatchObject({ status: 'poor' });
  });

  it('shows seven explained "not available yet" cards when nothing was analysed, never fewer', () => {
    const cards = buildCards({ caseId: null, synthetic: false, estimates: [], base: null });
    expect(cards.map((card) => card.key)).toEqual([...METRIC_KEYS]);
    for (const card of cards) {
      expect(MetricCardSchema.safeParse(card).success, card.key).toBe(true);
      expect(card).toMatchObject({
        value: null,
        status: 'unknown',
        trend: null,
        range: null,
        evidenceLink: null,
        estimated: true,
        caseId: null,
      });
      expect(card.display).toBe('Not available yet');
      expect(card.definition.length).toBeGreaterThan(40);
    }
  });

  it('adds a trend only against an earlier analysed case, labelled with that case and as an estimate', () => {
    const estimates = estimatesOf('case_two', {
      case_quality_index: 99,
      avoidable_support_effort: 60,
      customer_effort: 300,
      evidence_integrity: 90,
    });
    const cards = new Map(
      buildCards({ caseId: 'case_two', synthetic: true, estimates, base: BASE }).map(
        (card) => [card.key, card] as const,
      ),
    );
    expect(cards.get('case_quality_index')?.trend).toEqual({
      direction: 'up',
      delta: 63,
      label: '+63 points compared with CG-SYN-1001, the previous analysed case (estimates)',
    });
    expect(cards.get('avoidable_support_effort')?.trend).toMatchObject({
      direction: 'flat',
      delta: 0,
    });
    expect(cards.get('customer_effort')?.trend).toMatchObject({ direction: 'down', delta: -300 });
    // The base has no value for this metric, so there is nothing to compare: no trend, never a guess.
    expect(cards.get('evidence_integrity')?.trend).toBeNull();
    // Without an earlier analysed case no card has a trend.
    expect(
      buildCards({ caseId: 'case_two', synthetic: true, estimates, base: null }).every(
        (card) => card.trend === null,
      ),
    ).toBe(true);
  });

  it('never fabricates a trend from a missing or empty value', () => {
    const current = estimateOf('case_quality_index', 80);
    expect(trendOf(current, { reference: 'X', estimates: [] })).toBeNull();
    expect(
      trendOf(current, { reference: 'X', estimates: [estimateOf('case_quality_index', null)] }),
    ).toBeNull();
    expect(trendOf(estimateOf('case_quality_index', null), BASE)).toBeNull();
    expect(trendOf(current, null)).toBeNull();
  });
});

describe('[FR-CC-02] the case the command center shows', () => {
  const older = listItem('case_one', {
    openedAt: '2026-03-01T09:00:00.000Z',
    analyzedAt: '2026-03-02T09:00:00.000Z',
  });
  const newer = listItem('case_two', {
    openedAt: '2026-03-10T09:00:00.000Z',
    analyzedAt: '2026-03-11T09:00:00.000Z',
  });

  it('defaults to the most recently analysed case, then the newest case, then none', () => {
    expect(defaultCaseId([older, newer], 'case_unanalysed')).toBe('case_two');
    expect(defaultCaseId([newer, older], 'case_unanalysed')).toBe('case_two');
    expect(defaultCaseId([], 'case_unanalysed')).toBe('case_unanalysed');
    expect(defaultCaseId([], null)).toBeNull();
  });

  it('compares instants, not strings, when two timestamps differ in precision', () => {
    const early = listItem('a', { analyzedAt: '2026-03-02T09:00:00.500Z' });
    const late = listItem('b', { analyzedAt: '2026-03-02T09:00:00Z' });
    expect(defaultCaseId([early, late], null)).toBe('a');
  });

  it('takes the analysed case opened just before the active one as the trend base', () => {
    const oldest = listItem('case_zero', { openedAt: '2026-02-01T09:00:00.000Z' });
    expect(previousAnalysedCase([oldest, older, newer], newer)?.id).toBe('case_one');
    expect(previousAnalysedCase([oldest, older, newer], older)?.id).toBe('case_zero');
    expect(previousAnalysedCase([oldest, older, newer], oldest)).toBeNull();
    expect(previousAnalysedCase([newer], newer)).toBeNull();
  });
});

describe('[FR-CC-03] the panels around the cards', () => {
  const hypothesis = (id: string, confidence: number): Hypothesis =>
    ({
      id,
      name: `Hypothesis ${id}`,
      caseId: 'case_one',
      currentConfidence: confidence,
      currentLow: Math.round((confidence - 0.1) * 100) / 100,
      currentHigh: Math.round((confidence + 0.1) * 100) / 100,
    }) as unknown as Hypothesis;
  const match = (skillId: string, overrides: Partial<SkillMatch>): SkillMatch =>
    ({
      skillId,
      skillName: `Skill ${skillId}`,
      skillVersion: '1.0.0',
      caseId: 'case_two',
      lifecycle: 'published',
      applicability: 'applies',
      score: 0.7,
      ...overrides,
    }) as unknown as SkillMatch;

  it('picks the most confident hypothesis, with its range', () => {
    expect(
      leadingHypothesisOf([hypothesis('a', 0.4), hypothesis('b', 0.8), hypothesis('c', 0.6)]),
    ).toEqual({
      hypothesisId: 'b',
      name: 'Hypothesis b',
      confidence: 0.8,
      low: 0.7,
      high: 0.9,
      caseId: 'case_one',
    });
    expect(leadingHypothesisOf([])).toBeNull();
  });

  it('shows the best published or validated skill that applies at least partly, never one that does not apply', () => {
    expect(
      bestSkillMatch([
        match('a', { score: 0.9, applicability: 'partial' }),
        match('b', { score: 0.6 }),
      ])?.skillId,
    ).toBe('b');
    expect(bestSkillMatch([match('a', { score: 0.6 }), match('b', { score: 0.8 })])).toMatchObject({
      skillId: 'b',
      applicability: 'applies',
      score: 0.8,
    });
    expect(
      bestSkillMatch([match('a', { applicability: 'not_applicable', score: 0.99 })]),
    ).toBeNull();
    expect(bestSkillMatch([match('a', { lifecycle: 'pilot' })])).toBeNull();
    expect(bestSkillMatch([])).toBeNull();
  });

  it('lists the skills still awaiting a decision, newest activity first', () => {
    const skills = [
      skillOf('p', { lifecycle: 'published' }),
      skillOf('d', { lifecycle: 'draft', updatedAt: '2026-03-01T00:00:00.000Z' }),
      skillOf('x', { lifecycle: 'discovered', updatedAt: '2026-03-05T00:00:00.000Z' }),
      skillOf('r', { lifecycle: 'retired' }),
    ];
    expect(skillCandidatesOf(skills, 5).map((skill) => skill.id)).toEqual(['x', 'd']);
    expect(skillCandidatesOf(skills, 1).map((skill) => skill.id)).toEqual(['x']);
  });

  it('keeps unresolved critical evidence only, tagged with its case, and open warnings in engine order', () => {
    const missing = [
      { id: 'm1', criticality: 'critical', resolvedAt: null },
      { id: 'm2', criticality: 'critical', resolvedAt: '2026-03-02T00:00:00.000Z' },
      { id: 'm3', criticality: 'helpful', resolvedAt: null },
    ] as never[];
    expect(criticalMissingOf(missing, 'case_one', 5).map((item) => [item.id, item.caseId])).toEqual(
      [['m1', 'case_one']],
    );
    const warnings = [
      { id: 'w2', rank: 2, state: 'open' },
      { id: 'w1', rank: 1, state: 'open' },
      { id: 'w0', rank: 0, state: 'dismissed' },
    ] as unknown as CaseWarning[];
    expect(openWarningsOf(warnings, 5).map((warning) => warning.id)).toEqual(['w1', 'w2']);
    expect(openWarningsOf(warnings, 1).map((warning) => warning.id)).toEqual(['w1']);
  });

  it('reduces the system report to counts and the honest provider kind', () => {
    const report = {
      status: 'degraded',
      provider: { kind: 'deterministic', simulated: true },
      dependencies: [
        { status: 'healthy' },
        { status: 'healthy' },
        { status: 'degraded' },
        { status: 'unknown' },
        { status: 'disabled' },
      ],
    } as unknown as SystemHealth;
    expect(summarizeHealth(report)).toEqual({
      status: 'degraded',
      healthy: 2,
      degraded: 1,
      unhealthy: 0,
      providerKind: 'deterministic',
      providerSimulated: true,
    });
  });
});

describe('[FR-CC-04] notices', () => {
  const base = {
    hasCases: true,
    hasActiveCase: true,
    activeAnalysed: true,
    requestedMissing: false,
    trendBase: null,
    analysedCases: 2,
    providerSimulated: false,
  };

  it('says where to start when there are no cases, and shows nothing else as data', () => {
    const notices = commandCenterNotices({
      ...base,
      hasCases: false,
      hasActiveCase: false,
      activeAnalysed: false,
    });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/no cases yet/i);
  });

  it('labels estimates, thin trends, a missing request and the simulated provider', () => {
    const text = commandCenterNotices({
      ...base,
      requestedMissing: true,
      trendBase: 'CG-SYN-1001',
      providerSimulated: true,
    }).join('\n');
    expect(text).toMatch(/model estimates/i);
    expect(text).toMatch(/requested case was not found/i);
    expect(text).toMatch(/CG-SYN-1001.*only 2 analysed case/i);
    expect(text).toMatch(/simulated/i);
    expect(commandCenterNotices({ ...base, activeAnalysed: false }).join('\n')).toMatch(
      /not been analysed yet/i,
    );
  });
});
