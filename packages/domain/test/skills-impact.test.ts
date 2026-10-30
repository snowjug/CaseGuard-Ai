import { describe, expect, it } from 'vitest';
import { DEFAULT_EFFORT_MINUTES } from '@caseguard/schemas';
import {
  estimateSkillImpact,
  formatDuration,
  impactPrecedentOf,
  type SkillImpactEstimate,
} from '../src';
import { positionOf } from '../src/skills/impact';
import { defaultDecisionEventId, measureActualPath } from '../src/skills/actual';
import { CONFIG, eventBySuffix } from './helpers';
import { ONE, TWO, asOf, withPoisonedFuture } from './skills-fixtures';
import {
  conformanceThrough,
  minutes,
  planAt,
  recordedKeys,
  version,
} from './skills-story-fixtures';

describe('the estimated comparison with the "without the skill" baseline', () => {
  const plan = planAt(TWO, 'g01');
  const minimumEvidence = version.content.minimumEvidence.map((m) => m.requirementId);
  const precedent = impactPrecedentOf({
    reference: 'CG-SYN-1001',
    analysis: ONE.analysis,
    pack: ONE.pack,
    minimumEvidence,
  });
  const conformance = conformanceThrough(TWO, 'g15', asOf(TWO, 'g01'));
  const estimate = (
    over: Partial<Parameters<typeof estimateSkillImpact>[0]> = {},
  ): SkillImpactEstimate =>
    estimateSkillImpact({
      plan,
      version,
      analysis: TWO.analysis,
      pack: TWO.pack,
      config: CONFIG,
      ctx: TWO.ctx,
      synthetic: true,
      conformance,
      precedent,
      ...over,
    });
  const result = estimate();
  const rangeOk = (r: { low: number; mid: number; high: number }) =>
    r.low <= r.mid && r.mid <= r.high;

  it('[FR-ASE-01] is labelled estimated, simulated and synthetic, never measured', () => {
    expect(result.labels).toEqual({ estimated: true, simulated: true, synthetic: true });
    expect(result.headline).toMatch(/^Estimated, not measured\./);
    expect(result.notice).toMatch(/Estimated comparison/);
    expect(result.notice).toMatch(/does not measure the skill’s effect/);
    const text = [result.headline, result.notice, ...result.statements, ...result.caveats].join(
      ' ',
    );
    expect(text).not.toMatch(
      /(measured (saving|improvement|reduction|benefit)|proves|guarantee|thanks to the skill|because of the skill)/i,
    );
    for (const statement of result.statements.slice(0, 4)) {
      expect(statement).toMatch(/estimated|simulated/i);
    }
    expect(result.caveats.join(' ')).toMatch(/One case and no control group/);
    expect(result.caveats.join(' ')).toMatch(/synthetic/);
    const recordedMinutes = result.recorded?.timeToDiagnosisMinutes;
    expect(recordedMinutes).toBeDefined();
    expect(result.statements[0]).toContain(formatDuration(recordedMinutes ?? 0));
  });

  it('[FR-ASE-01] "expected without the skill" is a range from the action-value baseline at the plan time', () => {
    const { baseline } = result;
    expect(baseline.count).toBe(TWO.pack.pack.policies.rolloutCount);
    expect(baseline.policy).toBe(
      'Knowledge-pack action-value policy (balanced), without the skill',
    );
    for (const range of Object.values(baseline.metrics)) expect(rangeOk(range)).toBe(true);
    expect(baseline.metrics.timeToDiagnosisMinutes.low).toBeLessThan(
      baseline.metrics.timeToDiagnosisMinutes.high,
    );
    expect(result.planAsOf).toBe(asOf(TWO, 'g01'));
    expect(result.decisionEventId).toBe(eventBySuffix(TWO, 'g02').id);
    expect(result.caveats[0]).toContain(`seed ${baseline.seed}`);
  });

  it('[FR-ASE-01] the recorded path is measured from the case record and the difference follows from the two', () => {
    const recorded = result.recorded;
    if (!recorded || !result.difference) throw new Error('expected a recorded path');
    expect(recorded).toMatchObject({
      fromEventId: eventBySuffix(TWO, 'g02').id,
      diagnosisEventId: eventBySuffix(TWO, 'g09').id,
      reachedDiagnosis: true,
      actionCount: 4,
      evidenceCompleteness: 1,
    });
    expect(recorded.timeToDiagnosisMinutes).toBe(minutes(asOf(TWO, 'g02'), asOf(TWO, 'g09')));
    expect(recorded.actionKeys).toEqual(recordedKeys);
    const effort = recordedKeys.reduce(
      (sum, k) => sum + DEFAULT_EFFORT_MINUTES[TWO.pack.actions.get(k)?.customerEffort ?? 'none'],
      0,
    );
    expect(recorded.customerEffortMinutes).toBe(effort);
    const bm = result.baseline.metrics;
    expect(result.difference.timeToDiagnosisMinutes.mid).toBeCloseTo(
      bm.timeToDiagnosisMinutes.mid - recorded.timeToDiagnosisMinutes,
      1,
    );
    expect(result.difference.customerEffortMinutes.high).toBeCloseTo(
      bm.customerEffortMinutes.high - recorded.customerEffortMinutes,
      1,
    );
    expect(result.difference.tokenEstimate.low).toBeCloseTo(
      bm.tokenEstimate.low - recorded.tokenEstimate,
      1,
    );
    for (const range of Object.values(result.difference)) expect(rangeOk(range)).toBe(true);
    expect(result.position).toMatchObject({
      time: positionOf(recorded.timeToDiagnosisMinutes, bm.timeToDiagnosisMinutes),
      customerEffort: positionOf(recorded.customerEffortMinutes, bm.customerEffortMinutes),
      tokens: positionOf(recorded.tokenEstimate, bm.tokenEstimate),
    });
  });

  it('[FR-ASE-01] minimum-evidence completeness is compared too, with its own range', () => {
    const uplift = result.evidenceCompletenessUplift;
    if (!uplift || !result.recorded) throw new Error('expected an uplift');
    expect(rangeOk(uplift)).toBe(true);
    expect(uplift.mid).toBeCloseTo(
      result.recorded.evidenceCompleteness - result.baseline.metrics.evidenceCompleteness.mid,
      3,
    );
    expect(uplift.mid).toBeGreaterThan(0);
    expect(result.position?.evidenceCompleteness).toBe('above_range');
  });

  it('[FR-ASE-01] compares each recorded step with the engine ranking at the same decision points', () => {
    const recorded = ['g02', 'g03', 'g05', 'g08'];
    expect(result.decisionPoints.map((d) => d.eventId)).toEqual(
      recorded.map((s) => eventBySuffix(TWO, s).id),
    );
    expect(result.decisionPoints.map((d) => d.plannedStage)).toEqual([1, 2, 3, 4]);
    for (const point of result.decisionPoints) {
      const ranking = TWO.analysis.decisions.get(point.eventId);
      expect(point.baselineBestActionKey).toBe(ranking?.best?.actionKey ?? null);
      expect(point.relativeValue).toBe(ranking?.relative ?? null);
      expect(point.agreement).toBe(
        !ranking?.best
          ? 'not_ranked'
          : ranking.best.actionKey === point.recordedActionKey
            ? 'same_as_baseline_best'
            : 'different_route',
      );
    }
    expect(result.decisionPoints[3]?.recordedActionKey).toBe('act.proxy-node-comparison');
    const same = result.decisionPoints.filter(
      (d) => d.agreement === 'same_as_baseline_best',
    ).length;
    expect(result.statements.join(' ')).toContain(
      `At ${same} of ${result.decisionPoints.length} decision points the recorded step was the baseline's top-ranked action`,
    );
  });

  it('[FR-ASE-01] reads the baseline from the evidence at the plan time only', () => {
    const rewritten = estimate({
      analysis: { ...TWO.analysis, view: withPoisonedFuture(TWO, plan.asOf).view },
    });
    expect(rewritten).toEqual(result);
  });

  it('[FR-ASE-01] is deterministic, and every policy keeps the labels', () => {
    expect(estimate()).toEqual(result);
    const cheap = estimate({ strategy: 'lowest_customer_effort' });
    expect(cheap.baseline.policy).toContain('lowest_customer_effort');
    expect(cheap.baseline.metrics.customerEffortMinutes.mid).toBeLessThanOrEqual(
      result.baseline.metrics.customerEffortMinutes.mid,
    );
    expect(cheap.labels).toEqual(result.labels);
    expect(estimate({ ctx: { ...TWO.ctx, seed: 'another-seed' } }).labels.estimated).toBe(true);
  });

  it('[FR-ASE-01] the Case One path is context only and never the baseline', () => {
    expect(precedent).toMatchObject({ reference: 'CG-SYN-1001', actionCount: 9 });
    const context = result.precedent;
    if (!context || !result.recorded) throw new Error('expected a precedent');
    expect(context.timeDifferenceMinutes).toBeCloseTo(
      context.timeToDiagnosisMinutes - result.recorded.timeToDiagnosisMinutes,
      1,
    );
    expect(context.note).toMatch(/different case: shown for context only/);
    expect(estimate({ precedent: null }).baseline).toEqual(result.baseline);
    expect(estimate({ precedent: null }).precedent).toBeNull();
  });

  it('[FR-ASE-01] the precedent is measured with the definitions of the recorded path it is compared with', () => {
    const decisionEventId = defaultDecisionEventId(ONE.analysis);
    const fromIndex = ONE.analysis.view.events.findIndex((e) => e.id === decisionEventId);
    const fromAt = ONE.analysis.view.events[fromIndex]?.timestamp ?? '';
    const measured = measureActualPath({
      analysis: ONE.analysis,
      pack: ONE.pack,
      fromIndex,
      fromAt,
      minimumEvidence,
    });
    if (!measured || !precedent) throw new Error('expected both paths to be measured');
    expect(precedent).toEqual({
      reference: 'CG-SYN-1001',
      timeToDiagnosisMinutes: measured.timeToDiagnosisMinutes,
      customerEffortMinutes: measured.customerEffortMinutes,
      actionCount: measured.actionCount,
      tokenEstimate: measured.tokenEstimate,
      evidenceCompleteness: measured.evidenceCompleteness,
      reachedDiagnosis: measured.reachedDiagnosis,
    });
    expect(precedent.reachedDiagnosis).toBe(true);
    expect(precedent.tokenEstimate).toBeGreaterThan(0);
    // The context block of an estimate carries the same figures.
    expect(result.precedent).toMatchObject({
      tokenEstimate: precedent.tokenEstimate,
      evidenceCompleteness: precedent.evidenceCompleteness,
      reachedDiagnosis: true,
    });
  });

  it('[FR-ASE-01] Case Two reads faster and lighter than the recorded path of the case its skill came from', () => {
    const recorded = result.recorded;
    if (!recorded || !precedent) throw new Error('expected both recorded paths');
    // Both are recorded paths from their own decision point to the recorded diagnosis, so unlike the
    // simulated baseline (no waiting between steps, a pack that already knows the domain) they compare.
    expect(recorded.reachedDiagnosis).toBe(true);
    expect(recorded.timeToDiagnosisMinutes).toBeLessThan(precedent.timeToDiagnosisMinutes);
    expect(recorded.tokenEstimate).toBeLessThan(precedent.tokenEstimate);
    expect(recorded.evidenceCompleteness).toBeGreaterThanOrEqual(precedent.evidenceCompleteness);
    expect(recorded.customerEffortMinutes).toBeLessThan(precedent.customerEffortMinutes);
  });

  it('[FR-ASE-01] says so when nothing was recorded after the plan time', () => {
    const empty = estimate({ plan: planAt(TWO, 'g15') });
    expect(empty).toMatchObject({
      recorded: null,
      difference: null,
      position: null,
      evidenceCompletenessUplift: null,
    });
    expect(empty.statements).toEqual([
      'No steps were recorded after the plan time, so nothing can be compared yet.',
    ]);
    expect(empty.headline).toBe(
      'Estimated, not measured: no recorded path is available to compare with the baseline yet.',
    );
  });

  it('[FR-ASE-01] range positions are reported against the whole estimated range', () => {
    const range = { low: 60, mid: 90, high: 150 };
    expect(positionOf(59, range)).toBe('below_range');
    expect(positionOf(60, range)).toBe('at_or_below_median');
    expect(positionOf(90, range)).toBe('at_or_below_median');
    expect(positionOf(91, range)).toBe('above_median_within_range');
    expect(positionOf(150, range)).toBe('above_median_within_range');
    expect(positionOf(151, range)).toBe('above_range');
  });
});
