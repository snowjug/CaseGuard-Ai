import { describe, expect, it } from 'vitest';
import {
  AnalyticsOverviewSchema,
  FORK_CATEGORIES,
  RESPONSIBLE_USE_NOTICE,
} from '@caseguard/schemas';
import { aggregateAnalytics, ANALYTICS_CASE_LIMIT } from '../src/services/analytics';
import type { AnalyticsSource } from '../src/db';
import { NOW, emptySource, skillOf } from './insights-fixtures';

const REVIEW = { reviewedClaims: 0, correctedClaims: 0 };

/** Two synthetic cases: an inefficient one with forks and an efficient one without. */
function story(): AnalyticsSource {
  const caseRow = (id: string, reference: string, openedAt: string) => ({
    id,
    reference,
    synthetic: true,
    analysisState: 'analyzed' as const,
    openedAt,
    workload: 'teams-authentication',
  });
  const fork = (category: string) => ({ caseId: 'case_one', category });
  const component = (key: string, avoidablePct: number) => ({
    key,
    label: key.replace('_', ' '),
    avoidablePct,
  });
  return {
    ...emptySource(),
    cases: [
      caseRow('case_two', 'CG-SYN-1002', '2026-04-02T09:00:00.000Z'),
      caseRow('case_one', 'CG-SYN-1001', '2026-03-09T09:00:00.000Z'),
    ],
    quality: [
      {
        caseId: 'case_one',
        analyzedAt: '2026-03-10T09:00:00.000Z',
        compositeScore: 36,
        evidenceIntegrity: 50,
      },
      {
        caseId: 'case_two',
        analyzedAt: '2026-04-03T09:00:00.000Z',
        compositeScore: 99,
        evidenceIntegrity: 92,
      },
    ],
    forks: [
      fork('assumption_as_fact'),
      fork('assumption_as_fact'),
      fork('premature_destructive_action'),
      fork('low_value_action'),
      fork('premature_escalation'),
    ],
    missing: [
      {
        caseId: 'case_one',
        requirementId: 'req-dns',
        label: 'DNS resolver query logs',
        resolved: false,
      },
      { caseId: 'case_one', requirementId: 'req-proxy', label: 'Proxy trace', resolved: true },
    ],
    metrics: [
      {
        caseId: 'case_one',
        key: 'avoidable_support_effort',
        value: 60,
        ase: { components: [component('customer_effort', 70), component('token_usage', 40)] },
      },
      {
        caseId: 'case_two',
        key: 'avoidable_support_effort',
        value: 0,
        ase: { components: [component('customer_effort', 0)] },
      },
      { caseId: 'case_one', key: 'token_efficiency', value: 0.5, ase: null },
      { caseId: 'case_two', key: 'token_efficiency', value: 1.5, ase: null },
    ],
    assumptionFlags: [
      {
        caseId: 'case_one',
        subject: 'root_cause',
        text: 'RAW-CASE-TEXT: it must be the conditional access policy',
      },
      {
        caseId: 'case_one',
        subject: 'root_cause',
        text: 'RAW-CASE-TEXT: definitely conditional access',
      },
      { caseId: 'case_one', subject: null, text: 'RAW-CASE-TEXT: no subject here' },
    ],
    scenarios: [
      {
        caseId: 'case_one',
        reviewState: 'confirmed',
        counterfactualTokens: 6_000,
        actualTokens: 10_000,
      },
      {
        caseId: 'case_one',
        reviewState: 'rejected',
        counterfactualTokens: 9_000,
        actualTokens: 10_000,
      },
      {
        caseId: 'case_one',
        reviewState: 'pending',
        counterfactualTokens: 8_000,
        actualTokens: 10_000,
      },
    ],
    skills: [
      skillOf('skill_pub', {
        lifecycle: 'published',
        effectiveness: {
          ...skillOf('x').effectiveness,
          applications: 1,
          matchedCases: 1,
          avgTimeToDiagnosisMinutes: 60,
          baselineAvgTimeToDiagnosisMinutes: 120,
        },
      }),
      skillOf('skill_draft', { lifecycle: 'draft' }),
      skillOf('skill_pilot', { lifecycle: 'pilot' }),
    ],
    matches: [
      { caseId: 'case_two', skillId: 'skill_pub', applied: true },
      { caseId: 'case_two', skillId: 'skill_pilot', applied: false },
    ],
  };
}

describe('[FR-AN-01] quality analytics', () => {
  it('is valid, zero and honest for an empty tenant, with the responsible-use notice', () => {
    const overview = aggregateAnalytics({
      source: emptySource(),
      review: REVIEW,
      totalCases: 0,
      now: NOW,
    });
    expect(AnalyticsOverviewSchema.safeParse(overview).success).toBe(true);
    expect(overview.generatedAt).toBe(NOW);
    expect(overview.cohort).toMatchObject({
      caseCount: 0,
      analyzedCaseCount: 0,
      syntheticCaseCount: 0,
    });
    expect(overview.cohort.note).toMatch(/n=0/);
    expect(overview).toMatchObject({
      qualityTrend: [],
      forkCategories: [],
      missingEvidence: [],
      avoidableEffortPatterns: [],
      skillEffectiveness: [],
      frequentUnsupportedAssumptions: [],
    });
    expect(overview.counterfactualAcceptance).toEqual({
      reviewed: 0,
      accepted: 0,
      rejected: 0,
      rate: null,
    });
    expect(overview.reviewerDisagreement).toEqual({ reviewedClaims: 0, corrected: 0, rate: null });
    expect(overview.tokenEfficiency).toEqual({
      avgBitsPer1kTokens: null,
      avgEstimatedSavingsPct: null,
    });
    expect(overview.responsibleUseNotice).toBe(RESPONSIBLE_USE_NOTICE);
  });

  it('says how thin the cohort is, and counts synthetic cases', () => {
    const { cohort } = aggregateAnalytics({
      source: story(),
      review: REVIEW,
      totalCases: 2,
      now: NOW,
    });
    expect(cohort).toMatchObject({ caseCount: 2, analyzedCaseCount: 2, syntheticCaseCount: 2 });
    expect(cohort.note).toMatch(/n=2/);
    expect(cohort.note).toMatch(/illustrative/i);
  });

  it('shows fork-category shares that add up to one, most common first', () => {
    const { forkCategories } = aggregateAnalytics({
      source: story(),
      review: REVIEW,
      totalCases: 2,
      now: NOW,
    });
    expect(forkCategories[0]).toEqual({ category: 'assumption_as_fact', count: 2, share: 0.4 });
    expect(forkCategories.reduce((sum, row) => sum + row.count, 0)).toBe(5);
    expect(forkCategories.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(1, 2);
    for (const row of forkCategories) expect(FORK_CATEGORIES).toContain(row.category);
  });

  it('averages quality and evidence integrity per month and ranks effort patterns and missing evidence', () => {
    const overview = aggregateAnalytics({
      source: story(),
      review: REVIEW,
      totalCases: 2,
      now: NOW,
    });
    expect(overview.qualityTrend).toEqual([
      { period: '2026-03', caseCount: 1, avgQuality: 36, avgEvidenceIntegrity: 50 },
      { period: '2026-04', caseCount: 1, avgQuality: 99, avgEvidenceIntegrity: 92 },
    ]);
    expect(overview.avoidableEffortPatterns).toEqual([
      { component: 'token_usage', label: 'token usage', avgAvoidablePct: 40, caseCount: 1 },
      { component: 'customer_effort', label: 'customer effort', avgAvoidablePct: 35, caseCount: 2 },
    ]);
    // Only what is still missing is counted: the resolved proxy trace is not.
    expect(overview.missingEvidence).toEqual([
      { requirementId: 'req-dns', label: 'DNS resolver query logs', count: 1 },
    ]);
    expect(overview.tokenEfficiency.avgBitsPer1kTokens).toBe(1);
    // The confirmed (40%) and pending (20%) paths of Case One average to 30%; the rejected one is left out.
    expect(overview.tokenEfficiency.avgEstimatedSavingsPct).toBe(30);
  });

  it('counts skill adoption by lifecycle and match, and labels effectiveness synthetic', () => {
    const { skillAdoption, skillEffectiveness } = aggregateAnalytics({
      source: story(),
      review: REVIEW,
      totalCases: 2,
      now: NOW,
    });
    expect(skillAdoption).toEqual({
      totalSkills: 3,
      published: 1,
      pilotOrValidated: 1,
      matchedCases: 1,
      appliedCases: 1,
    });
    expect(skillEffectiveness).toEqual([
      {
        skillId: 'skill_pub',
        name: 'Skill skill_pub',
        applications: 1,
        timeToDiagnosisDeltaPct: 50,
        // This fixture carries no comparison with the case the skill came from, so the simulated baseline is the basis.
        timeToDiagnosisBasis: 'simulated_baseline',
        synthetic: true,
      },
    ]);
  });

  it('measures counterfactual acceptance and reviewer disagreement from the reviews that happened', () => {
    const overview = aggregateAnalytics({
      source: story(),
      review: { reviewedClaims: 8, correctedClaims: 2 },
      totalCases: 2,
      now: NOW,
    });
    expect(overview.counterfactualAcceptance).toEqual({
      reviewed: 2,
      accepted: 1,
      rejected: 1,
      rate: 0.5,
    });
    expect(overview.reviewerDisagreement).toEqual({ reviewedClaims: 8, corrected: 2, rate: 0.25 });
  });

  it('groups unsupported assumptions by subject and never carries the statement text', () => {
    const overview = aggregateAnalytics({
      source: story(),
      review: REVIEW,
      totalCases: 2,
      now: NOW,
    });
    expect(overview.frequentUnsupportedAssumptions[0]).toEqual({ subject: 'root_cause', count: 2 });
    expect(overview.frequentUnsupportedAssumptions).toHaveLength(2);
    expect(JSON.stringify(overview)).not.toContain('RAW-CASE-TEXT');
  });

  it('contains no person: no user id, no persona name, no e-mail, nothing ranked per individual', () => {
    const text = JSON.stringify(
      aggregateAnalytics({ source: story(), review: REVIEW, totalCases: 2, now: NOW }),
    );
    expect(text).not.toMatch(/user_[a-z_]+/);
    expect(text).not.toMatch(/\(synthetic\)/);
    expect(text).not.toMatch(/@/);
    expect(text).not.toContain('"owner"');
    expect(text).not.toContain('"reviewer"');
    expect(text).toContain('must not be used to rank, rate or discipline individual employees');
    expect(text).toContain('No individual employee is ranked, scored or identified');
  });

  it('says so when only the newest cases are covered', () => {
    const covered = aggregateAnalytics({
      source: story(),
      review: REVIEW,
      totalCases: ANALYTICS_CASE_LIMIT + 40,
      now: NOW,
    });
    expect(covered.cohort.note).toContain(
      `Only the 2 most recent of ${ANALYTICS_CASE_LIMIT + 40} cases are included.`,
    );
    expect(
      aggregateAnalytics({ source: story(), review: REVIEW, totalCases: 2, now: NOW }).cohort.note,
    ).not.toMatch(/most recent/);
  });
});
