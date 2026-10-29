import { describe, expect, it } from 'vitest';
import { SkillValidationSchema } from '@caseguard/schemas';
import {
  PARTIAL_THRESHOLD,
  evaluateReplayCase,
  runSkillRegressionSuite,
  runSkillSimulationTest,
  toSkillValidation,
} from '../src';
import {
  IRRELEVANT,
  ONE,
  REGRESSION_CASES,
  RILEY,
  TWO,
  asOf,
  first,
  makeOp,
  seeded,
  toReplayCase,
} from './skills-fixtures';

const { draft, previewMutation } = seeded();
const { skill } = draft;
const v1 = draft.version;
if (!previewMutation) throw new Error('the seed must propose the Case Two mutation');
const v11 = previewMutation.version;

const simulate = (cases = [toReplayCase(ONE)], version = v1) =>
  runSkillSimulationTest({ skill, version, cases });
const regress = (version = v1, cases = REGRESSION_CASES) =>
  runSkillRegressionSuite({ skill, version, cases });

describe('simulation test: replaying the skill on its source case', () => {
  const report = simulate();
  const c1 = first(report.cases);

  it('[FR-SK-02] passes for the seeded skill on Case One: it reaches the recorded diagnosis sooner with less customer effort', () => {
    expect(report).toMatchObject({
      kind: 'simulation_test',
      outcome: 'passed',
      skillId: skill.id,
      versionId: v1.id,
      skillVersion: '1.0.0',
    });
    expect(c1).toMatchObject({
      reference: 'CG-SYN-1001',
      expectation: 'improves',
      verdict: 'improves',
      passed: true,
      synthetic: true,
    });
    expect(c1.checks.map((c) => [c.id, c.passed])).toEqual([
      ['temporal-integrity', true],
      ['matches-at-decision', true],
      ['safe-steps', true],
      ['no-false-diagnosis', true],
      ['reaches-diagnosis', true],
      ['sooner-than-recorded', true],
      ['no-more-customer-effort', true],
    ]);
    const comparison = c1.comparison;
    if (!comparison) throw new Error('expected a comparison');
    expect(comparison.timeToDiagnosisMinutes.skill.mid).toBeLessThan(
      comparison.timeToDiagnosisMinutes.actual,
    );
    expect(comparison.customerEffortMinutes.skill).toBeLessThanOrEqual(
      comparison.customerEffortMinutes.actual,
    );
    expect(comparison.timeToDiagnosisMinutes.skill.low).toBeLessThanOrEqual(
      comparison.timeToDiagnosisMinutes.skill.high,
    );
    expect(comparison.evidenceCompleteness.skill).toBe(1);
  });

  it('[FR-SK-02] replays the guided ladder from the decision point and records the evidence of each step', () => {
    expect(c1.replay?.steps.map((s) => s.actionKey)).toEqual([
      'act.request-minimal-scoping',
      'act.check-service-health',
      'act.signin-log-correlation',
      'act.dns-resolver-comparison',
    ]);
    expect(c1.replay).toMatchObject({
      terminal: 'success',
      reachedDiagnosis: true,
      falseDiagnosis: false,
      oracle: 'recorded_resolution',
    });
    expect(c1.replay?.metrics.unsafeSteps).toBe(0);
    expect(c1.replay?.steps.every((s) => s.simulated && s.safe)).toBe(true);
    expect(c1.decisionAt).toBe(
      ONE.normalized.events.find((e) => e.id === c1.decisionEventId)?.timestamp,
    );
    expect(c1.match).toMatchObject({ applicability: 'partial' });
    expect(c1.match?.metTriggerIds.length).toBeGreaterThan(0);
    for (const check of c1.checks) expect(check.detail.length).toBeGreaterThan(10);
  });

  it('[FR-CF-02] uses only information from before the decision and says where hindsight enters', () => {
    expect(c1.checks[0]?.detail).toMatch(
      /2 events recorded before the decision and never the final resolution/,
    );
    expect(c1.usedFinalResolution).toBe(true);
    expect(report.notices.join(' ')).toMatch(/Simulated replay: nothing was executed/);
    expect(report.notices.join(' ')).toMatch(/hindsight/);
    expect(c1.checks.find((c) => c.id === 'sooner-than-recorded')?.detail).toMatch(
      /simulated estimate, outcomes from the recorded cause/,
    );
  });

  it('[FR-CF-02] changing events after the decision changes nothing, while changing earlier events does', () => {
    const base = toReplayCase(ONE);
    const decisionAt = c1.decisionAt ?? '';
    const rewrite = (after: boolean) =>
      base.events.map((e) =>
        (after ? e.timestamp > decisionAt : e.timestamp < decisionAt)
          ? {
              ...e,
              title: 'One laptop',
              body: 'Only one user is affected on a single laptop and the server returned a 500 error.',
            }
          : e,
      );
    expect(simulate([{ ...base, events: rewrite(true) }])).toEqual(report);
    const earlier = first(simulate([{ ...base, events: rewrite(false) }]).cases);
    expect(earlier.verdict).toBe('not_applicable');
    expect(earlier.match?.exclusionIds).toContain('exc-single-user-scope');
  });

  it('[FR-SK-02] is deterministic and every output satisfies the validation contract', () => {
    expect(simulate()).toEqual(report);
    const validation = toSkillValidation({ report, op: makeOp('v'), executedBy: RILEY.id });
    expect(() => SkillValidationSchema.parse(validation)).not.toThrow();
    expect(validation).toMatchObject({
      kind: 'simulation_test',
      outcome: 'passed',
      skillId: skill.id,
      versionId: v1.id,
      caseId: ONE.ctx.caseId,
      executedBy: RILEY.id,
      synthetic: true,
    });
    expect(validation.checks[0]).toMatchObject({
      id: 'CG-SYN-1001:temporal-integrity',
      passed: true,
    });
    const both = toSkillValidation({ report: regress(), op: makeOp('v'), executedBy: RILEY.id });
    expect(both).toMatchObject({ kind: 'regression', outcome: 'passed', caseId: null });
    expect(() => SkillValidationSchema.parse(both)).not.toThrow();
  });
});

describe('simulation test: honest failures', () => {
  it('[FR-SK-02] a source case that was already efficient cannot be required to improve, and the failure says why', () => {
    const forced = evaluateReplayCase(skill, v1, {
      replayCase: toReplayCase(TWO),
      expectation: 'improves',
    });
    expect(forced).toMatchObject({ verdict: 'equivalent', passed: false });
    expect(forced.checks.find((c) => c.id === 'sooner-than-recorded')).toMatchObject({
      passed: false,
    });
    expect(forced.checks.find((c) => c.id === 'sooner-than-recorded')?.detail).toMatch(
      /versus 3 h 3 min recorded/,
    );
    expect(
      runSkillRegressionSuite({
        skill,
        version: v1,
        cases: [{ replayCase: toReplayCase(TWO), expectation: 'improves' }],
      }).outcome,
    ).toBe('failed');
    expect(simulate([toReplayCase(TWO)]).outcome).toBe('passed');
  });

  it('[FR-SK-02] a skill that does not match the decision-time evidence does not pass as a test of the case', () => {
    const miss = simulate([toReplayCase(IRRELEVANT)]);
    expect(first(miss.cases)).toMatchObject({
      verdict: 'not_applicable',
      passed: false,
      replay: null,
    });
    expect(first(miss.cases).checks.find((c) => c.id === 'matches-at-decision')?.passed).toBe(
      false,
    );
    expect(miss.outcome).toBe('failed');
  });

  it('[FR-SK-02] a case without any decision point makes the run inconclusive, never a pass', () => {
    const base = toReplayCase(ONE);
    const none = simulate([{ ...base, analysis: { ...base.analysis, forks: [], actions: [] } }]);
    expect(none.outcome).toBe('inconclusive');
    expect(first(none.cases)).toMatchObject({
      verdict: 'no_decision_point',
      decisionEventId: null,
      passed: false,
    });
    expect(simulate([]).outcome).toBe('inconclusive');
  });

  it('[FR-SK-02] an unsafe step is never replayed: the plan itself refuses it and the run stops safely', () => {
    const unsafe = structuredClone(v1);
    const step = unsafe.content.decisionSequence.find(
      (s) => s.actionKey === 'act.check-service-health',
    );
    if (!step) throw new Error('expected the service-health step');
    step.actionKey = 'act.remove-resolver-from-service';
    const result = first(
      runSkillSimulationTest({ skill, version: unsafe, cases: [toReplayCase(ONE)] }).cases,
    );
    expect(result.replay?.steps.map((s) => s.actionKey)).not.toContain(
      'act.remove-resolver-from-service',
    );
    expect(result.replay?.metrics.unsafeSteps).toBe(0);
    expect(result.passed).toBe(false);
  });
});

describe('regression suite across the synthetic cases', () => {
  it.each([
    ['1.0.0', v1],
    ['1.1.0 (with the Case Two proxy branch)', v11],
  ])(
    '[FR-SK-02] version %s helps Case One, leaves Case Two intact and never matches the irrelevant case',
    (_name, version) => {
      const report = regress(version);
      expect(report).toMatchObject({ kind: 'regression', outcome: 'passed' });
      expect(report.cases.map((c) => [c.reference, c.verdict])).toEqual([
        ['CG-SYN-1001', 'improves'],
        ['CG-SYN-1002', 'equivalent'],
        ['CG-SYN-9001', 'not_applicable'],
      ]);
      expect(report.cases.map((c) => c.passed)).toEqual([true, true, true]);
      const irrelevant = report.cases[2];
      expect(irrelevant?.match?.exclusionIds).toContain('exc-single-user-scope');
      expect(irrelevant?.replay).toBeNull();
      for (const c of report.cases.slice(0, 2)) {
        expect(c.replay?.falseDiagnosis).toBe(false);
        expect(c.replay?.metrics.unsafeSteps).toBe(0);
      }
    },
  );

  it('[FR-SK-02] the Case Two decision matches from the first customer email alone', () => {
    const c2 = first(regress().cases.filter((c) => c.reference === 'CG-SYN-1002'));
    expect(c2.decisionAt).toBe(asOf(TWO, 'g02'));
    expect(c2.match).toMatchObject({ applicability: 'applies' });
    expect(c2.checks[0]?.detail).toMatch(/1 events recorded before the decision/);
  });

  it('[FR-SK-02] the proxy branch makes the skill fit Case Two better without breaking Case One', () => {
    const matchOf = (version: typeof v1, ref: string) =>
      regress(version).cases.find((c) => c.reference === ref);
    expect(matchOf(v11, 'CG-SYN-1002')?.match?.score).toBeGreaterThan(
      matchOf(v1, 'CG-SYN-1002')?.match?.score ?? 1,
    );
    expect(matchOf(v11, 'CG-SYN-1001')).toMatchObject({
      verdict: 'improves',
      passed: true,
      match: { applicability: 'partial' },
    });
    expect(matchOf(v11, 'CG-SYN-1001')?.match?.score).toBeGreaterThanOrEqual(PARTIAL_THRESHOLD);
  });

  it('[FR-SK-02] an irrelevant case that must not match makes the suite fail if the skill matches it', () => {
    const loose = structuredClone(v1);
    loose.content.exclusions = [];
    loose.content.triggerConditions = loose.content.triggerConditions.map((t) => ({
      ...t,
      required: false,
    }));
    loose.content.triggerConditions.push({
      id: 'trg-any-text',
      description: 'Any sign-in text',
      kind: 'text',
      pattern: 'sign',
      weight: 5,
      required: false,
    });
    const report = regress(loose);
    const irrelevant = report.cases.find((c) => c.reference === 'CG-SYN-9001');
    expect(irrelevant?.checks.find((c) => c.id === 'does-not-match')?.passed).toBe(false);
    expect(report.outcome).toBe('failed');
  });

  it('[FR-SK-02] is deterministic', () => {
    expect(regress()).toEqual(regress());
  });
});
