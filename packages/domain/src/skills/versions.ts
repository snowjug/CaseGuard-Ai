import type { SkillApproval, SkillDna, SkillVersion } from '@caseguard/schemas';
import { auditPayload, refusal } from './audit';
import { requiredValidationsFor, validationShortfall, validationStatusFor } from './lifecycle';
import {
  currentVersionOf,
  skillOk,
  type SkillActor,
  type SkillAggregate,
  type SkillChangeSet,
  type SkillErrorCode,
  type SkillOpContext,
  type SkillResult,
} from './types';
import { bumpSemver, compareSemver, uniq } from './util';

export interface VersionDecisionRequest {
  decision: 'approve' | 'reject';
  reason: string;
  /** Optimistic lock: the skill `version` the caller last saw. */
  expectedVersion: number;
}

const highestVersion = (versions: readonly SkillVersion[]): string =>
  [...versions].sort((a, b) => compareSemver(b.version, a.version))[0]?.version ?? '1.0.0';

/** Skill-level fields that mirror the content of the (new) current version. */
function mirrorContent(skill: SkillDna, version: SkillVersion): SkillDna {
  const c = version.content;
  return {
    ...skill,
    name: c.name,
    description: c.description,
    workload: c.workload,
    product: c.product,
    currentVersionId: version.id,
    currentVersion: version.version,
    confidence: c.confidence.score,
    sourceCaseIds: uniq(c.sourceCases.map((s) => s.caseId)),
  };
}

/**
 * Approves or rejects a proposed version (a mutation). Approval needs a distinct approver, a fresh
 * parent (the proposal must still build on the current version) and, once the skill is beyond draft,
 * passed simulation and regression validations for the proposed content: unvalidated content never
 * goes live. A reviewed skill falls back to simulation-tested because the review covered older content.
 */
export function decideSkillVersion(args: {
  aggregate: SkillAggregate;
  versionId: string;
  request: VersionDecisionRequest;
  actor: SkillActor;
  op: SkillOpContext;
}): SkillResult<SkillChangeSet> {
  const { aggregate, versionId, request, actor, op } = args;
  const { skill } = aggregate;
  const refuse = (code: SkillErrorCode, message: string) =>
    refusal<SkillChangeSet>({
      code,
      message,
      action: 'skill.version_decision',
      targetType: 'skill_version',
      targetId: versionId,
      actorId: actor.id,
      now: op.now,
      details: { skillId: skill.id, decision: request.decision },
    });
  if (request.reason.trim().length < 5) {
    return refuse('validation_failed', 'A reason of at least five characters is required.');
  }
  if (actor.kind === 'system' || !actor.permissions.includes('skill:approve')) {
    return refuse(
      'forbidden',
      'Deciding on a proposed version requires a person with the skill:approve permission.',
    );
  }
  if (request.expectedVersion !== skill.version) {
    return refuse(
      'version_conflict',
      `The skill was modified by someone else (expected version ${request.expectedVersion}, found ${skill.version}). Reload and retry.`,
    );
  }
  const proposed = aggregate.versions.find((v) => v.id === versionId && v.skillId === skill.id);
  const current = currentVersionOf(aggregate);
  if (!proposed || !current) return refuse('not_found', 'The proposed version was not found.');
  if (proposed.state !== 'proposed') {
    return refuse(
      'conflict',
      `The version is already ${proposed.state}; only proposed versions can be decided.`,
    );
  }
  if (skill.lifecycle === 'retired' || skill.lifecycle === 'deprecated') {
    return refuse('illegal_transition', `A ${skill.lifecycle} skill cannot take a new version.`);
  }
  const others = aggregate.versions.filter((v) => v.state === 'proposed' && v.id !== proposed.id);
  const approve = request.decision === 'approve';
  if (approve) {
    if (actor.id === proposed.createdBy || actor.id === skill.createdBy) {
      return refuse(
        'separation_of_duties',
        'The approver must differ from the creator of the skill and the author of the proposal.',
      );
    }
    if (proposed.parentVersionId !== current.id) {
      return refuse(
        'gate_failed',
        'The proposal builds on an older version than the current one. Propose it again.',
      );
    }
    const shortfall = validationShortfall(
      aggregate,
      proposed,
      requiredValidationsFor(skill.lifecycle),
    );
    if (shortfall) return refuse('gate_failed', shortfall);
  }
  const lifecycle =
    approve && skill.lifecycle === 'expert_reviewed' ? 'simulation_tested' : skill.lifecycle;
  const approval: SkillApproval = {
    tenantId: op.tenantId,
    createdAt: op.now,
    updatedAt: op.now,
    createdBy: actor.id,
    version: 1,
    id: op.nextId('skp'),
    skillId: skill.id,
    versionId: proposed.id,
    fromState: skill.lifecycle,
    toState: lifecycle,
    decision: approve ? 'approved' : 'rejected',
    approver: actor.id,
    requestedBy: proposed.createdBy,
    reason: request.reason.trim(),
    decidedAt: op.now,
  };
  const base = approve ? mirrorContent(skill, proposed) : skill;
  const next: SkillDna = {
    ...base,
    lifecycle,
    reviewer: lifecycle === skill.lifecycle ? skill.reviewer : null,
    validationStatus: validationStatusFor(lifecycle, skill.validationStatus),
    hasProposedMutation: others.length > 0,
    updatedAt: op.now,
    version: skill.version + 1,
  };
  return skillOk({
    skill: next,
    previousSkillVersion: skill.version,
    newVersions: [],
    versionStates: approve
      ? [
          { versionId: proposed.id, state: 'active' },
          { versionId: current.id, state: 'superseded' },
        ]
      : [{ versionId: proposed.id, state: 'rejected' }],
    validations: [],
    approvals: [approval],
    audit: [
      auditPayload({
        action: approve ? 'skill.version_approved' : 'skill.version_rejected',
        targetType: 'skill_version',
        targetId: proposed.id,
        actorId: actor.id,
        now: op.now,
        outcome: 'success',
        details: {
          skillId: skill.id,
          baseVersionId: current.id,
          proposedVersion: proposed.version,
          lifecycleBefore: skill.lifecycle,
          lifecycleAfter: lifecycle,
          approvalId: approval.id,
          reason: approval.reason,
        },
      }),
    ],
  });
}

export interface RollbackRequest {
  toVersionId: string;
  reason: string;
  /** Optimistic lock: the skill `version` the caller last saw. */
  expectedVersion: number;
}

/**
 * Rolls back by creating a NEW version whose content equals an earlier, once-approved version. History
 * is never rewritten: the replaced version becomes `superseded`. The restored content must hold the
 * validations the skill's lifecycle requires, so a rollback cannot slip unvalidated content into a
 * published skill.
 */
export function rollbackSkill(args: {
  aggregate: SkillAggregate;
  request: RollbackRequest;
  actor: SkillActor;
  op: SkillOpContext;
}): SkillResult<SkillChangeSet> {
  const { aggregate, request, actor, op } = args;
  const { skill } = aggregate;
  const refuse = (code: SkillErrorCode, message: string) =>
    refusal<SkillChangeSet>({
      code,
      message,
      action: 'skill.rollback',
      targetType: 'skill',
      targetId: skill.id,
      actorId: actor.id,
      now: op.now,
      details: { toVersionId: request.toVersionId },
    });
  if (request.reason.trim().length < 5) {
    return refuse('validation_failed', 'A reason of at least five characters is required.');
  }
  if (actor.kind === 'system' || !actor.permissions.includes('skill:rollback')) {
    return refuse(
      'forbidden',
      'Rolling back requires a person with the skill:rollback permission.',
    );
  }
  if (request.expectedVersion !== skill.version) {
    return refuse(
      'version_conflict',
      `The skill was modified by someone else (expected version ${request.expectedVersion}, found ${skill.version}). Reload and retry.`,
    );
  }
  if (skill.lifecycle === 'retired' || skill.lifecycle === 'deprecated') {
    return refuse('illegal_transition', `A ${skill.lifecycle} skill cannot be rolled back.`);
  }
  const target = aggregate.versions.find(
    (v) => v.id === request.toVersionId && v.skillId === skill.id,
  );
  const current = currentVersionOf(aggregate);
  if (!target || !current) return refuse('not_found', 'The version to restore was not found.');
  if (target.id === current.id)
    return refuse('conflict', 'That version is already the current one.');
  if (target.state !== 'active' && target.state !== 'superseded') {
    return refuse(
      'gate_failed',
      `A ${target.state} version was never approved and cannot be restored.`,
    );
  }
  const shortfall = validationShortfall(aggregate, target, requiredValidationsFor(skill.lifecycle));
  if (shortfall) return refuse('gate_failed', shortfall);

  const restored: SkillVersion = {
    tenantId: op.tenantId,
    createdAt: op.now,
    updatedAt: op.now,
    createdBy: actor.id,
    id: op.nextId('skv'),
    skillId: skill.id,
    version: bumpSemver(highestVersion(aggregate.versions), 'patch'),
    sequence: Math.max(...aggregate.versions.map((v) => v.sequence)) + 1,
    parentVersionId: target.id,
    changeType: 'rollback',
    changeSummary:
      `Rollback: restored the content of version ${target.version} in place of ${current.version}. Reason: ${request.reason.trim()}`.slice(
        0,
        600,
      ),
    state: 'active',
    lifecycleAtCreation: skill.lifecycle,
    content: structuredClone(target.content),
    contentHash: target.contentHash,
  };
  const next: SkillDna = {
    ...mirrorContent(skill, restored),
    updatedAt: op.now,
    version: skill.version + 1,
  };
  return skillOk({
    skill: next,
    previousSkillVersion: skill.version,
    newVersions: [restored],
    versionStates: [{ versionId: current.id, state: 'superseded' }],
    validations: [],
    approvals: [],
    audit: [
      auditPayload({
        action: 'skill.rolled_back',
        targetType: 'skill',
        targetId: skill.id,
        actorId: actor.id,
        now: op.now,
        outcome: 'success',
        details: {
          restoredFromVersionId: target.id,
          restoredFromVersion: target.version,
          replacedVersionId: current.id,
          newVersionId: restored.id,
          newVersion: restored.version,
          reason: request.reason.trim(),
        },
      }),
    ],
  });
}
