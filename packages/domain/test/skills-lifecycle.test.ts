import { describe, expect, it } from 'vitest';
import {
  SKILL_LIFECYCLE,
  SkillApprovalSchema,
  SkillDnaSchema,
  SkillValidationSchema,
  type SkillApproval,
  type SkillLifecycle,
} from '@caseguard/schemas';
import {
  SKILL_ERROR_HTTP,
  SKILL_TRANSITIONS,
  advanceSkillGovernance,
  applySkillChangeSet,
  describeSkillTransitions,
  runSkillRegressionSuite,
  runSkillSimulationTest,
  toSkillValidation,
  transitionSkill,
  type SkillActor,
  type SkillAggregate,
  type SkillResult,
} from '../src';
import {
  ALEX,
  AVA,
  CAST,
  CASEY,
  MORGAN,
  REGRESSION_CASES,
  RILEY,
  SYSTEM_BOT,
  ONE,
  draftAggregate,
  makeOp,
  publishedAggregate,
  toReplayCase,
  validationOf,
  versionOf,
} from './skills-fixtures';

const at = (
  lifecycle: SkillLifecycle,
  over: Partial<SkillAggregate['skill']> = {},
): SkillAggregate => {
  const base = draftAggregate();
  return { ...base, skill: { ...base.skill, lifecycle, ...over } };
};
const withValidations = (
  a: SkillAggregate,
  ...kinds: ('simulation_test' | 'regression')[]
): SkillAggregate => ({
  ...a,
  validations: [...a.validations, ...kinds.map((k) => validationOf(a, k, 'passed'))],
});
const pilotApproval = (a: SkillAggregate, approver: string): SkillApproval => ({
  tenantId: 'tenant_test',
  createdAt: '2026-10-29T00:00:00.000Z',
  updatedAt: '2026-10-29T00:00:00.000Z',
  createdBy: approver,
  version: 1,
  id: `skp_${approver}`,
  skillId: a.skill.id,
  versionId: a.skill.currentVersionId,
  fromState: 'expert_reviewed',
  toState: 'pilot',
  decision: 'approved',
  approver,
  requestedBy: a.skill.createdBy,
  reason: 'Approved for the pilot.',
  decidedAt: '2026-10-29T00:00:00.000Z',
});
const move = (
  a: SkillAggregate,
  to: SkillLifecycle,
  actor: SkillActor,
  expectedVersion = a.skill.version,
) =>
  transitionSkill({
    aggregate: a,
    request: { toState: to, reason: 'Moving on after review.', expectedVersion },
    actor,
    op: makeOp('t'),
  });
const errorOf = <T>(result: SkillResult<T>) => {
  if (result.ok) throw new Error('expected a refusal');
  return result.error;
};
const apply = (a: SkillAggregate, result: ReturnType<typeof move>): SkillAggregate => {
  if (!result.ok) throw new Error(`expected success: ${result.error.message}`);
  return applySkillChangeSet(a, result.value);
};

describe('lifecycle state machine [FR-SK-02, FR-SK-03]', () => {
  it('[FR-SK-02] a skill moves Discovered → Published only through the gates, one audited step at a time', () => {
    let a = draftAggregate();
    const op = makeOp('happy');
    const step = (to: SkillLifecycle, actor: SkillActor) => {
      const result = transitionSkill({
        aggregate: a,
        request: {
          toState: to,
          reason: `Moving to ${to} after review.`,
          expectedVersion: a.skill.version,
        },
        actor,
        op,
      });
      if (!result.ok) throw new Error(`${to}: ${result.error.message}`);
      expect(result.value.previousSkillVersion).toBe(a.skill.version);
      expect(result.value.skill.version).toBe(a.skill.version + 1);
      expect(result.value.audit).toHaveLength(1);
      expect(result.value.audit[0]).toMatchObject({
        targetType: 'skill',
        targetId: a.skill.id,
        actorId: actor.id,
        outcome: 'success',
        occurredAt: '2026-10-29T00:00:00.000Z',
        details: { fromState: a.skill.lifecycle, toState: to },
      });
      expect(() => SkillApprovalSchema.parse(result.value.approvals[0])).not.toThrow();
      a = applySkillChangeSet(a, result.value);
      expect(() => SkillDnaSchema.parse(a.skill)).not.toThrow();
    };
    step('draft', AVA);
    const sim = runSkillSimulationTest({
      skill: a.skill,
      version: versionOf(a),
      cases: [toReplayCase(ONE)],
    });
    expect(sim.outcome).toBe('passed');
    a = {
      ...a,
      validations: [...a.validations, toSkillValidation({ report: sim, op, executedBy: RILEY.id })],
    };
    step('simulation_tested', RILEY);
    expect(a.skill.validationStatus).toBe('simulation_passed');
    step('expert_reviewed', RILEY);
    expect(a.skill.reviewer).toBe(RILEY.id);
    expect(a.validations.some((v) => v.kind === 'expert_review' && v.outcome === 'passed')).toBe(
      true,
    );
    step('pilot', CASEY);
    const regression = runSkillRegressionSuite({
      skill: a.skill,
      version: versionOf(a),
      cases: REGRESSION_CASES,
    });
    expect(regression.outcome).toBe('passed');
    a = {
      ...a,
      validations: [
        ...a.validations,
        toSkillValidation({ report: regression, op, executedBy: RILEY.id }),
      ],
    };
    step('validated', RILEY);
    expect(a.skill.lastValidatedAt).toBe('2026-10-29T00:00:00.000Z');
    step('published', ALEX);
    expect(a.skill.lifecycle).toBe('published');
    expect(a.skill.validationStatus).toBe('validated');
    expect(a.skill.version).toBe(7);
    expect(a.approvals.map((x) => x.toState)).toEqual([
      'draft',
      'simulation_tested',
      'expert_reviewed',
      'pilot',
      'validated',
      'published',
    ]);
    expect(a.validations.every((v) => SkillValidationSchema.safeParse(v).success)).toBe(true);
  });

  it('[FR-SK-03] nothing is ever published automatically', () => {
    expect(draftAggregate().skill.lifecycle).toBe('discovered');
    const upToValidated = advanceSkillGovernance({
      aggregate: draftAggregate(),
      cast: CAST,
      op: makeOp('g'),
      simulationCases: [toReplayCase(ONE)],
      regressionCases: REGRESSION_CASES,
      target: 'validated',
    });
    expect(upToValidated.ok && upToValidated.value.skill.lifecycle).toBe('validated');
    const asPublisher = (publisher: SkillActor) =>
      advanceSkillGovernance({
        aggregate: draftAggregate(),
        cast: { ...CAST, publisher },
        op: makeOp('g'),
        simulationCases: [toReplayCase(ONE)],
        regressionCases: REGRESSION_CASES,
        target: 'published',
      });
    expect(errorOf(asPublisher(AVA)).code).toBe('forbidden');
    expect(errorOf(asPublisher(SYSTEM_BOT)).code).toBe('forbidden');
    expect(errorOf(asPublisher(CASEY)).code).toBe('separation_of_duties');
    const ok = asPublisher(ALEX);
    expect(ok.ok && ok.value.skill.lifecycle).toBe('published');
  });

  it('[FR-SK-02] every pair of states outside the graph is an illegal transition; legal ones never are', () => {
    const everything: SkillActor = { id: 'user_root', permissions: ALEX.permissions };
    for (const from of SKILL_LIFECYCLE) {
      for (const to of SKILL_LIFECYCLE) {
        const code = (() => {
          const r = move(at(from), to, everything);
          return r.ok ? 'ok' : r.error.code;
        })();
        if (SKILL_TRANSITIONS[from].includes(to))
          expect(code, `${from} -> ${to}`).not.toBe('illegal_transition');
        else expect(code, `${from} -> ${to}`).toBe('illegal_transition');
      }
    }
    expect(SKILL_TRANSITIONS.retired).toEqual([]);
    expect(SKILL_TRANSITIONS.published).toEqual(['deprecated']);
  });

  it('[FR-SK-03] a missing permission is refused, deny by default', () => {
    const a = withValidations(at('simulation_tested'), 'simulation_test');
    const error = errorOf(move(a, 'expert_reviewed', AVA));
    expect(error.code).toBe('forbidden');
    expect(error.message).toMatch(/skill:review/);
    expect(errorOf(move(a, 'expert_reviewed', MORGAN)).code).toBe('forbidden');
    expect(errorOf(move(at('draft'), 'simulation_tested', AVA)).code).toBe('forbidden');
  });

  it('[FR-SK-03] simulation must have passed: missing, failed, and a later failure all block', () => {
    const draft = at('draft');
    expect(errorOf(move(draft, 'simulation_tested', RILEY)).message).toMatch(
      /No simulation test has been run/,
    );
    const failed = { ...draft, validations: [validationOf(draft, 'simulation_test', 'failed')] };
    expect(errorOf(move(failed, 'simulation_tested', RILEY)).message).toMatch(/did not pass/);
    const inconclusive = {
      ...draft,
      validations: [validationOf(draft, 'simulation_test', 'inconclusive')],
    };
    expect(errorOf(move(inconclusive, 'simulation_tested', RILEY)).code).toBe('gate_failed');
    const passThenFail = {
      ...draft,
      validations: [
        validationOf(draft, 'simulation_test', 'passed', '2026-10-28T00:00:00.000Z'),
        validationOf(draft, 'simulation_test', 'failed', '2026-10-29T00:00:00.000Z'),
      ],
    };
    expect(errorOf(move(passThenFail, 'simulation_tested', RILEY)).code).toBe('gate_failed');
    const failThenPass = {
      ...draft,
      validations: [
        validationOf(draft, 'simulation_test', 'failed', '2026-10-28T00:00:00.000Z'),
        validationOf(draft, 'simulation_test', 'passed', '2026-10-29T00:00:00.000Z'),
      ],
    };
    expect(move(failThenPass, 'simulation_tested', RILEY).ok).toBe(true);
  });

  it('[FR-SK-03] a validation of different content does not satisfy the gate', () => {
    const draft = at('draft');
    const foreign = {
      ...validationOf(draft, 'simulation_test', 'passed'),
      versionId: 'skv_other_version',
    };
    expect(
      errorOf(move({ ...draft, validations: [foreign] }, 'simulation_tested', RILEY)).code,
    ).toBe('gate_failed');
  });

  it('[FR-SK-03] validated needs a passed regression, not just a simulation test', () => {
    const a = withValidations(at('pilot'), 'simulation_test');
    expect(errorOf(move(a, 'validated', RILEY)).message).toMatch(/No regression has been run/);
    expect(
      move(withValidations(at('pilot'), 'simulation_test', 'regression'), 'validated', RILEY).ok,
    ).toBe(true);
  });

  it('[FR-SK-03] the reviewer and the pilot approver must differ from the creator', () => {
    const own = (p: SkillActor) => ({ createdBy: p.id });
    const review = withValidations(at('simulation_tested', own(RILEY)), 'simulation_test');
    expect(errorOf(move(review, 'expert_reviewed', RILEY)).code).toBe('separation_of_duties');
    const approve = withValidations(at('expert_reviewed', own(CASEY)), 'simulation_test');
    expect(errorOf(move(approve, 'pilot', CASEY)).code).toBe('separation_of_duties');
    expect(move(withValidations(at('expert_reviewed'), 'simulation_test'), 'pilot', CASEY).ok).toBe(
      true,
    );
  });

  it('[FR-SK-03] the publisher differs from the creator and from the pilot approver and needs a pilot approval', () => {
    const base = withValidations(at('validated'), 'simulation_test', 'regression');
    const approved = { ...base, approvals: [pilotApproval(base, CASEY.id)] };
    expect(errorOf(move(base, 'published', ALEX)).message).toMatch(/No pilot approval/);
    expect(errorOf(move(approved, 'published', CASEY)).code).toBe('separation_of_duties');
    expect(
      errorOf(
        move({ ...approved, skill: { ...approved.skill, createdBy: ALEX.id } }, 'published', ALEX),
      ).code,
    ).toBe('separation_of_duties');
    expect(errorOf(move(approved, 'published', RILEY)).code).toBe('forbidden');
    const published = move(approved, 'published', ALEX);
    expect(published.ok && published.value.audit[0]?.action).toBe('skill.published');
  });

  it('[FR-SK-03] a stale expected version is a version conflict (optimistic lock)', () => {
    const a = withValidations(at('draft'), 'simulation_test');
    const error = errorOf(move(a, 'simulation_tested', RILEY, a.skill.version + 3));
    expect(error.code).toBe('version_conflict');
    expect(error.message).toMatch(/modified by someone else/);
    expect(SKILL_ERROR_HTTP.version_conflict.status).toBe(409);
    expect(SKILL_ERROR_HTTP.gate_failed.problemCode).toBe('precondition_failed');
  });

  it('[FR-SK-03] automated actors can never move a skill, whatever they are permitted', () => {
    expect(errorOf(move(at('discovered'), 'draft', SYSTEM_BOT)).code).toBe('forbidden');
    expect(errorOf(move(at('validated'), 'published', SYSTEM_BOT)).message).toMatch(
      /Automated actors/,
    );
  });

  it('requires a reason', () => {
    const r = transitionSkill({
      aggregate: at('discovered'),
      request: { toState: 'draft', reason: 'ok', expectedVersion: 1 },
      actor: AVA,
      op: makeOp('t'),
    });
    expect(errorOf(r).code).toBe('validation_failed');
  });

  it('[FR-SK-03] every refusal is audited as a denied attempt, including unsafe publication', () => {
    const base = withValidations(at('validated'), 'simulation_test', 'regression');
    const refused = errorOf(
      move({ ...base, approvals: [pilotApproval(base, CASEY.id)] }, 'published', CASEY),
    );
    expect(refused.audit).toMatchObject({
      action: 'skill.publish_denied',
      outcome: 'denied',
      actorId: CASEY.id,
      targetType: 'skill',
      details: { code: 'separation_of_duties', fromState: 'validated', toState: 'published' },
    });
    const stale = errorOf(move(at('draft'), 'simulation_tested', RILEY, 9));
    expect(stale.audit?.outcome).toBe('failure');
  });

  it('[FR-SK-02] sending a skill back for changes clears the review and its validation status', () => {
    const reviewed = withValidations(
      at('expert_reviewed', { reviewer: RILEY.id, validationStatus: 'expert_reviewed' }),
      'simulation_test',
    );
    const result = move(reviewed, 'draft', RILEY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.skill).toMatchObject({
      lifecycle: 'draft',
      reviewer: null,
      validationStatus: 'unvalidated',
    });
    expect(result.value.approvals[0]?.decision).toBe('changes_requested');
    expect(result.value.audit[0]?.action).toBe('skill.changes_requested');
  });

  it('[FR-SK-02] deprecating and retiring follow publication; a draft can be rejected', () => {
    const published = publishedAggregate();
    const deprecated = apply(published, move(published, 'deprecated', CASEY));
    expect(deprecated.skill.lifecycle).toBe('deprecated');
    const retired = apply(deprecated, move(deprecated, 'retired', CASEY));
    expect(retired.skill.lifecycle).toBe('retired');
    const rejected = move(at('simulation_tested'), 'retired', CASEY);
    expect(rejected.ok && rejected.value.approvals[0]?.decision).toBe('rejected');
  });

  it('[FR-SK-03] the detail view lists each legal next state with why it is or is not available', () => {
    const a = withValidations(at('draft'), 'simulation_test');
    const options = describeSkillTransitions(a, RILEY);
    expect(options.map((o) => o.toState)).toEqual(SKILL_TRANSITIONS.draft);
    const sim = options.find((o) => o.toState === 'simulation_tested');
    expect(sim).toMatchObject({
      allowed: true,
      reason: null,
      requiredPermission: 'skill:validate',
    });
    const asEngineer = describeSkillTransitions(a, AVA).find(
      (o) => o.toState === 'simulation_tested',
    );
    expect(asEngineer).toMatchObject({ allowed: false });
    expect(asEngineer?.reason).toMatch(/skill:validate/);
    const publish = describeSkillTransitions(
      withValidations(at('validated'), 'simulation_test', 'regression'),
      ALEX,
    ).find((o) => o.toState === 'published');
    expect(publish).toMatchObject({
      allowed: false,
      requiresDistinctApprover: true,
      requiredPermission: 'skill:publish',
    });
    expect(publish?.gate).toMatch(/human action/);
  });
});
