import { describe, expect, it } from 'vitest';
import { SkillVersionSchema } from '@caseguard/schemas';
import {
  advanceSkillGovernance,
  applySkillChangeSet,
  decideSkillVersion,
  rollbackSkill,
  validationShortfall,
  type SkillActor,
  type SkillAggregate,
} from '../src';
import {
  ALEX,
  AVA,
  CAST,
  CASEY,
  ONE,
  REGRESSION_CASES,
  RILEY,
  SYSTEM_BOT,
  TWO,
  asOf,
  first,
  makeOp,
  matchAt,
  matchableOf,
  seeded,
  toReplayCase,
  validationOf,
  versionOf,
} from './skills-fixtures';
import {
  approved,
  decide,
  errorOf,
  proposal,
  proposalOf,
  proposed,
  published,
  ready,
  v1,
  validated,
  valueOf,
} from './skills-version-fixtures';

describe('approving or rejecting a proposed version', () => {
  it('[FR-SK-04] approval makes the proposal current, supersedes the old version and improves the Case Two match', () => {
    const change = valueOf(decide(ready, 'approve'));
    expect(change.versionStates).toEqual([
      { versionId: proposal.version.id, state: 'active' },
      { versionId: v1.id, state: 'superseded' },
    ]);
    expect(change.audit[0]).toMatchObject({
      action: 'skill.version_approved',
      actorId: ALEX.id,
      outcome: 'success',
      details: { proposedVersion: '1.1.0' },
    });
    expect(change.approvals[0]).toMatchObject({
      decision: 'approved',
      approver: ALEX.id,
      requestedBy: CASEY.id,
      versionId: proposal.version.id,
    });
    expect(approved.skill).toMatchObject({
      currentVersion: '1.1.0',
      currentVersionId: proposal.version.id,
      lifecycle: 'published',
      hasProposedMutation: false,
      version: ready.skill.version + 1,
    });
    expect(approved.skill.sourceCaseIds).toEqual(
      expect.arrayContaining([ONE.ctx.caseId, TWO.ctx.caseId]),
    );
    expect(approved.versions.map((v) => [v.version, v.state])).toEqual([
      ['1.0.0', 'superseded'],
      ['1.1.0', 'active'],
    ]);
    const t = asOf(TWO, 'g02');
    const after = first(matchAt(TWO, t, [matchableOf(approved)]).matches);
    expect(after.score).toBeGreaterThan(first(matchAt(TWO, t).matches).score);
    expect(after.skillVersion).toBe('1.1.0');
  });

  it('[FR-SK-04] rejection keeps the current version and records why', () => {
    const rejected = applySkillChangeSet(ready, valueOf(decide(ready, 'reject')));
    expect(rejected.versions.find((v) => v.id === proposal.version.id)?.state).toBe('rejected');
    expect(rejected.skill).toMatchObject({ currentVersion: '1.0.0', hasProposedMutation: false });
    expect(rejected.approvals.at(-1)).toMatchObject({ decision: 'rejected' });
  });

  it('[FR-SK-03] the approver differs from the creator and from the author of the proposal', () => {
    const creator: SkillActor = { id: published.skill.createdBy, permissions: ALEX.permissions };
    expect(errorOf(decide(ready, 'approve', creator)).code).toBe('separation_of_duties');
    expect(errorOf(decide(ready, 'approve', CASEY)).code).toBe('separation_of_duties');
    expect(errorOf(decide(ready, 'approve', CASEY)).audit).toMatchObject({
      action: 'skill.version_decision_denied',
      outcome: 'denied',
      targetType: 'skill_version',
    });
  });

  it('[FR-SK-03] needs skill:approve, a person, the current version and a reason', () => {
    expect(errorOf(decide(ready, 'approve', RILEY)).code).toBe('forbidden');
    expect(errorOf(decide(ready, 'approve', SYSTEM_BOT)).code).toBe('forbidden');
    expect(errorOf(decide(ready, 'approve', ALEX, ready.skill.version + 2)).code).toBe(
      'version_conflict',
    );
    const brief = decideSkillVersion({
      aggregate: ready,
      versionId: proposal.version.id,
      request: { decision: 'approve', reason: 'ok', expectedVersion: ready.skill.version },
      actor: ALEX,
      op: makeOp('d'),
    });
    expect(errorOf(brief).code).toBe('validation_failed');
  });

  it('[FR-SK-03] unvalidated or failing content never goes live', () => {
    expect(errorOf(decide(proposed, 'approve')).message).toMatch(
      /No simulation test has been run for version 1\.1\.0/,
    );
    const failing = {
      ...proposed,
      validations: [
        ...proposed.validations,
        { ...validationOf(proposed, 'simulation_test', 'passed'), versionId: proposal.version.id },
        { ...validationOf(proposed, 'regression', 'failed'), versionId: proposal.version.id },
      ],
    };
    expect(errorOf(decide(failing, 'approve')).message).toMatch(
      /latest regression for version 1\.1\.0 did not pass \(failed\)/,
    );
  });

  it('[FR-SK-03] a proposal built on an older version, an unknown or an already decided one is refused', () => {
    const stale = {
      ...ready,
      versions: ready.versions.map((v) =>
        v.id === proposal.version.id ? { ...v, parentVersionId: 'skv_older' } : v,
      ),
    };
    expect(errorOf(decide(stale, 'approve')).message).toMatch(/builds on an older version/);
    const unknown = decideSkillVersion({
      aggregate: ready,
      versionId: 'skv_unknown',
      request: {
        decision: 'approve',
        reason: 'Reviewed the diff.',
        expectedVersion: ready.skill.version,
      },
      actor: ALEX,
      op: makeOp('d'),
    });
    expect(errorOf(unknown).code).toBe('not_found');
    expect(errorOf(decide(approved, 'approve')).code).toBe('conflict');
    const deprecated = { ...ready, skill: { ...ready.skill, lifecycle: 'deprecated' as const } };
    expect(errorOf(decide(deprecated, 'approve')).code).toBe('illegal_transition');
  });

  it('[FR-SK-03] a reviewed skill falls back to simulation-tested because the review covered the old content', () => {
    const reviewed = valueOf(
      advanceSkillGovernance({
        aggregate: {
          skill: seeded().draft.skill,
          versions: [seeded().draft.version],
          validations: [],
          approvals: [],
        },
        cast: CAST,
        op: makeOp('gov'),
        simulationCases: [toReplayCase(ONE)],
        regressionCases: REGRESSION_CASES,
        target: 'expert_reviewed',
      }),
    );
    expect(reviewed.skill).toMatchObject({ lifecycle: 'expert_reviewed', reviewer: RILEY.id });
    const reviewedProposal = proposalOf(reviewed, CASEY, 'reviewed');
    const withProposal = validated(
      applySkillChangeSet(reviewed, reviewedProposal.changeSet),
      reviewedProposal.version,
    );
    const result = valueOf(
      decideSkillVersion({
        aggregate: withProposal,
        versionId: reviewedProposal.version.id,
        request: {
          decision: 'approve',
          reason: 'Reviewed the diff.',
          expectedVersion: withProposal.skill.version,
        },
        actor: ALEX,
        op: makeOp('d'),
      }),
    );
    expect(result.skill).toMatchObject({
      lifecycle: 'simulation_tested',
      reviewer: null,
      validationStatus: 'simulation_passed',
    });
    expect(result.approvals[0]).toMatchObject({
      fromState: 'expert_reviewed',
      toState: 'simulation_tested',
    });
  });
});

describe('rollback', () => {
  const rollback = (
    aggregate: SkillAggregate,
    toVersionId: string,
    actor: SkillActor = CASEY,
    expectedVersion = aggregate.skill.version,
    reason = 'The new branch confused engineers.',
  ) =>
    rollbackSkill({
      aggregate,
      request: { toVersionId, reason, expectedVersion },
      actor,
      op: makeOp('rollback'),
    });
  const rolledBack = applySkillChangeSet(approved, valueOf(rollback(approved, v1.id)));

  it('[FR-SK-04] creates a NEW version from the earlier one and never rewrites history', () => {
    const restored = versionOf(rolledBack);
    expect(() => SkillVersionSchema.parse(restored)).not.toThrow();
    expect(restored).toMatchObject({
      version: '1.1.1',
      changeType: 'rollback',
      parentVersionId: v1.id,
      state: 'active',
      sequence: 3,
      contentHash: v1.contentHash,
    });
    expect(restored.id).not.toBe(v1.id);
    expect(restored.content).toEqual(v1.content);
    expect(restored.changeSummary).toMatch(
      /^Rollback: restored the content of version 1\.0\.0 in place of 1\.1\.0\. Reason: The new branch confused engineers\./,
    );
    expect(rolledBack.versions.map((v) => [v.version, v.state])).toEqual([
      ['1.0.0', 'superseded'],
      ['1.1.0', 'superseded'],
      ['1.1.1', 'active'],
    ]);
    expect(rolledBack.skill).toMatchObject({
      currentVersion: '1.1.1',
      currentVersionId: restored.id,
      version: approved.skill.version + 1,
    });
    expect(valueOf(rollback(approved, v1.id)).audit[0]).toMatchObject({
      action: 'skill.rolled_back',
      actorId: CASEY.id,
      details: { restoredFromVersion: '1.0.0', replacedVersionId: proposal.version.id },
    });
    const t = asOf(TWO, 'g02');
    expect(first(matchAt(TWO, t, [matchableOf(rolledBack)]).matches).score).toBe(
      first(matchAt(TWO, t).matches).score,
    );
  });

  it('[FR-SK-04] refuses the current version, a proposed or rejected one, an unknown one and a stale lock', () => {
    expect(errorOf(rollback(approved, proposal.version.id)).code).toBe('conflict');
    expect(errorOf(rollback(proposed, proposal.version.id)).code).toBe('gate_failed');
    expect(errorOf(rollback(proposed, proposal.version.id)).message).toMatch(
      /proposed version was never approved/,
    );
    const rejected = applySkillChangeSet(ready, valueOf(decide(ready, 'reject')));
    expect(errorOf(rollback(rejected, proposal.version.id)).message).toMatch(
      /rejected version was never approved/,
    );
    expect(errorOf(rollback(approved, 'skv_unknown')).code).toBe('not_found');
    expect(errorOf(rollback(approved, v1.id, CASEY, approved.skill.version + 1)).code).toBe(
      'version_conflict',
    );
  });

  it('[FR-SK-03] needs skill:rollback, a person and a reason, and never restores unvalidated content', () => {
    expect(errorOf(rollback(approved, v1.id, AVA)).code).toBe('forbidden');
    expect(errorOf(rollback(approved, v1.id, SYSTEM_BOT)).code).toBe('forbidden');
    expect(errorOf(rollback(approved, v1.id, CASEY, approved.skill.version, 'no')).code).toBe(
      'validation_failed',
    );
    const unvalidated = {
      ...approved,
      validations: approved.validations.filter((v) => v.versionId !== v1.id),
    };
    expect(errorOf(rollback(unvalidated, v1.id)).message).toMatch(
      /No simulation test has been run for version 1\.0\.0/,
    );
    const retired = { ...approved, skill: { ...approved.skill, lifecycle: 'retired' as const } };
    expect(errorOf(rollback(retired, v1.id)).code).toBe('illegal_transition');
    expect(errorOf(rollback(approved, v1.id, AVA)).audit).toMatchObject({
      action: 'skill.rollback_denied',
      outcome: 'denied',
      actorId: AVA.id,
    });
  });

  it('[FR-SK-04] validations of identical content cover the restored version', () => {
    const onlyOriginal = rolledBack.validations.filter((v) => v.versionId === v1.id);
    expect(onlyOriginal.length).toBeGreaterThan(0);
    const covered = { versions: rolledBack.versions, validations: onlyOriginal };
    expect(
      validationShortfall(covered, versionOf(rolledBack), ['simulation_test', 'regression']),
    ).toBeNull();
    expect(validationShortfall(covered, proposal.version, ['simulation_test'])).toMatch(
      /No simulation test has been run for version 1\.1\.0/,
    );
  });
});
