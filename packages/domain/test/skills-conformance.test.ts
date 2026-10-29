import { describe, expect, it } from 'vitest';
import { SkillMatchSchema } from '@caseguard/schemas';
import { checkConformance, toMatchConformance } from '../src';
import { CONFIG } from './helpers';
import { ONE, TWO, asOf, first, matchAt, withPoisonedFuture } from './skills-fixtures';
import { BLAME, conformanceThrough, recordedKeys, version } from './skills-story-fixtures';

describe('conformance of Case Two with the skill', () => {
  const appliedAt = asOf(TWO, 'g01');
  const report = conformanceThrough(TWO, 'g15', appliedAt);

  it('[FR-SK-05] is HIGH: every stage was followed, the last through the proxy alternative the skill lists', () => {
    expect(report).toMatchObject({
      level: 'high',
      score: 1,
      stagesFollowed: 4,
      stagesApplicable: 4,
      stagesTotal: 4,
      inStageOrder: true,
    });
    expect(report.label).toBe('Closely aligned with the skill');
    expect(report.stages.map((s) => s.status)).toEqual([
      'followed',
      'followed',
      'followed',
      'followed_alternative',
    ]);
    expect(report.stages.map((s) => s.actionKey)).toEqual(recordedKeys);
    expect(report.stages.every((s) => s.timing === 'after_application')).toBe(true);
    expect(report.stages[3]?.reason).toMatch(
      /alternative “Compare sign-in connectivity through each proxy node”.*“Compare name resolution across each DNS resolver”/,
    );
    expect(report.outsideSkill.map((o) => o.actionKey)).toEqual([
      'act.remove-proxy-node-from-rotation',
    ]);
    expect(report.outsideSkill[0]?.note).toMatch(/not assessed/);
  });

  it('[FR-SK-05] uses non-punitive wording everywhere', () => {
    const texts = [
      report.summary,
      report.label,
      ...report.notices,
      ...report.stages.map((s) => s.reason),
      ...report.outsideSkill.map((o) => o.note),
    ];
    for (const text of texts) expect(text).not.toMatch(BLAME);
    expect(report.notices.join(' ')).toMatch(/does not rate people/);
    const contrast = conformanceThrough(ONE, 'e24', asOf(ONE, 'e01'));
    for (const text of [
      contrast.summary,
      ...contrast.notices,
      ...contrast.stages.map((s) => s.reason),
    ]) {
      expect(text).not.toMatch(BLAME);
    }
  });

  it('[FR-SK-05] only stages reached so far count, so the route is never penalised for what has not happened yet', () => {
    for (const [suffix, applicable] of [
      ['g02', 1],
      ['g03', 2],
      ['g05', 3],
    ] as const) {
      const partial = conformanceThrough(TWO, suffix, appliedAt);
      expect(partial, suffix).toMatchObject({
        level: 'high',
        score: 1,
        stagesFollowed: applicable,
        stagesApplicable: applicable,
      });
    }
    expect(conformanceThrough(TWO, 'g05', appliedAt).stages[3]).toMatchObject({
      status: 'not_reached',
      reason: 'No step has been taken at this stage yet.',
    });
  });

  it('[FR-SK-05] conformance at T ignores everything after T', () => {
    for (const suffix of ['g03', 'g06', 'g08']) {
      const t = asOf(TWO, suffix);
      const rewritten = conformanceThrough(TWO, suffix, appliedAt, withPoisonedFuture(TWO, t));
      expect(rewritten, suffix).toEqual(conformanceThrough(TWO, suffix, appliedAt));
    }
  });

  it('[FR-SK-05] a path with a different first step is described as a different route and rated lower than Case Two', () => {
    const contrast = conformanceThrough(ONE, 'e24', asOf(ONE, 'e01'));
    expect(contrast).toMatchObject({ level: 'moderate', label: 'Partly aligned with the skill' });
    expect(contrast.score).toBeLessThan(report.score);
    expect(contrast.stages.map((s) => s.status)).toEqual([
      'not_needed',
      'different_route',
      'followed',
      'followed',
    ]);
    expect(contrast.stages[1]?.reason).toMatch(/different route was taken here \(Request HAR/);
    expect(contrast.notices.join(' ')).toMatch(/A different route is often right/);
    expect(conformanceThrough(ONE, 'e03', null).level).toBe('low');
  });

  it('[FR-SK-05] a stage that was not taken before later ones were is reported as skipped, without judgement', () => {
    const steps = version.content.decisionSequence;
    const extended = structuredClone(version);
    extended.content.decisionSequence = [
      ...steps.filter((s) => s.order <= 2),
      {
        id: 'stp-3-device-check',
        order: 3,
        title: 'Check device registration and PRT health',
        instruction: 'Run the device registration check on a sample of devices.',
        actionKey: 'act.device-registration-check',
        expectedInformationGainBits: null,
        requiresInputs: [],
        branches: [],
      },
      ...steps.filter((s) => s.order >= 3).map((s) => ({ ...s, order: s.order + 1 })),
    ];
    const longer = checkConformance({
      version: extended,
      analysis: TWO.analysis,
      pack: TWO.pack,
      config: CONFIG,
      caseId: TWO.ctx.caseId,
      appliedAt,
      throughAt: asOf(TWO, 'g15'),
    });
    expect(longer.stages.map((s) => s.status)).toEqual([
      'followed',
      'followed',
      'skipped',
      'followed',
      'followed_alternative',
    ]);
    expect(longer.stages[2]?.reason).toMatch(
      /No separate step was recorded for this stage before later stages were taken/,
    );
    expect(longer).toMatchObject({
      stagesTotal: 5,
      stagesFollowed: 4,
      stagesApplicable: 5,
      score: 0.8,
      level: 'high',
    });
    expect(longer.summary).toMatch(/1 had no recorded step/);
    for (const text of [longer.summary, ...longer.stages.map((s) => s.reason)]) {
      expect(text).not.toMatch(BLAME);
    }
  });

  it('[FR-SK-05] the projection stored on the match satisfies the contract', () => {
    const match = first(matchAt(TWO, appliedAt).matches);
    const applied = {
      ...match,
      applied: true,
      appliedAt,
      appliedBy: 'user_ava_engineer',
      conformance: toMatchConformance(report),
    };
    expect(applied.conformance).toEqual({ stepsFollowed: 4, stepsTotal: 4, score: 1 });
    expect(() => SkillMatchSchema.parse(applied)).not.toThrow();
  });
});
