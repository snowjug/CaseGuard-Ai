import {
  SKILL_LIFECYCLE_LABELS,
  type Permission,
  type SkillApproval,
  type SkillDna,
  type SkillLifecycle,
  type SkillTransitionOption,
  type SkillValidation,
  type SkillVersion,
} from '@caseguard/schemas';
import { auditPayload, refusal } from './audit';
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

/** Structurally legal moves. Everything else is an illegal transition regardless of who asks. */
export const SKILL_TRANSITIONS: Readonly<Record<SkillLifecycle, readonly SkillLifecycle[]>> = {
  discovered: ['draft', 'retired'],
  draft: ['simulation_tested', 'retired'],
  simulation_tested: ['expert_reviewed', 'draft', 'retired'],
  expert_reviewed: ['pilot', 'draft', 'retired'],
  pilot: ['validated', 'draft', 'retired'],
  validated: ['published', 'draft', 'retired'],
  published: ['deprecated'],
  deprecated: ['retired'],
  retired: [],
};

type ValidationKind = SkillValidation['kind'];

interface TransitionRule {
  permission: Permission;
  decision: SkillApproval['decision'];
  /** Actor must differ from the skill creator and from the author of the current version. */
  distinctFromCreator: boolean;
  /** Actor must also differ from every approver of the pilot stage (four-eyes on publication). */
  distinctFromApprovers: boolean;
  /** Passed validations required for the current version. */
  validations: readonly ValidationKind[];
  gate: string | null;
}

const PRE_PUBLICATION: readonly SkillLifecycle[] = [
  'discovered',
  'draft',
  'simulation_tested',
  'expert_reviewed',
  'pilot',
  'validated',
];

/** The rule that governs one legal move, or null when the move is not in the graph. */
export function transitionRule(from: SkillLifecycle, to: SkillLifecycle): TransitionRule | null {
  if (!SKILL_TRANSITIONS[from].includes(to)) return null;
  const base = {
    distinctFromCreator: false,
    distinctFromApprovers: false,
    validations: [] as ValidationKind[],
    gate: null,
  };
  switch (to) {
    case 'draft':
      return from === 'discovered'
        ? { ...base, permission: 'skill:extract', decision: 'approved' }
        : {
            ...base,
            permission: 'skill:review',
            decision: 'changes_requested',
            gate: 'A reason is required; earlier validations no longer apply once the content changes.',
          };
    case 'simulation_tested':
      return {
        ...base,
        permission: 'skill:validate',
        decision: 'approved',
        validations: ['simulation_test'],
        gate: 'A passed simulation test exists for the current version.',
      };
    case 'expert_reviewed':
      return {
        ...base,
        permission: 'skill:review',
        decision: 'approved',
        distinctFromCreator: true,
        validations: ['simulation_test'],
        gate: 'The reviewer differs from the creator and a passed simulation test exists for the current version.',
      };
    case 'pilot':
      return {
        ...base,
        permission: 'skill:approve',
        decision: 'approved',
        distinctFromCreator: true,
        validations: ['simulation_test'],
        gate: 'The approver differs from the creator and a passed simulation test exists for the current version.',
      };
    case 'validated':
      return {
        ...base,
        permission: 'skill:validate',
        decision: 'approved',
        validations: ['simulation_test', 'regression'],
        gate: 'Passed simulation and regression validations exist for the current version.',
      };
    case 'published':
      return {
        ...base,
        permission: 'skill:publish',
        decision: 'approved',
        distinctFromCreator: true,
        distinctFromApprovers: true,
        validations: ['simulation_test', 'regression'],
        gate: 'The publisher differs from the creator and the approver, a pilot approval is on record, and passed simulation and regression validations exist. Publication is always a human action.',
      };
    case 'deprecated':
      return { ...base, permission: 'skill:retire', decision: 'approved' };
    case 'retired':
      return {
        ...base,
        permission: 'skill:retire',
        decision: PRE_PUBLICATION.includes(from) ? 'rejected' : 'approved',
      };
    case 'discovered':
      return null;
  }
}

/** Validation kinds a skill's content must have passed to be live in a given lifecycle state. */
export function requiredValidationsFor(lifecycle: SkillLifecycle): readonly ValidationKind[] {
  if (lifecycle === 'simulation_tested' || lifecycle === 'expert_reviewed')
    return ['simulation_test'];
  if (lifecycle === 'pilot' || lifecycle === 'validated' || lifecycle === 'published') {
    return ['simulation_test', 'regression'];
  }
  return [];
}

/**
 * The latest validation of a kind that covers a version, directly or because an identical content hash
 * was validated (rollbacks restore validated content). A later failed run supersedes an earlier pass.
 */
export function latestValidation(
  aggregate: Pick<SkillAggregate, 'versions' | 'validations'>,
  version: SkillVersion,
  kind: ValidationKind,
): SkillValidation | undefined {
  const hashOf = new Map(aggregate.versions.map((v) => [v.id, v.contentHash]));
  const covering = aggregate.validations
    .filter(
      (v) =>
        v.kind === kind &&
        (v.versionId === version.id || hashOf.get(v.versionId) === version.contentHash),
    )
    .sort((a, b) => (a.executedAt < b.executedAt ? -1 : a.executedAt > b.executedAt ? 1 : 0));
  return covering[covering.length - 1];
}

/** The first missing or failed validation of the required kinds, as a sentence (null when all hold). */
export function validationShortfall(
  aggregate: Pick<SkillAggregate, 'versions' | 'validations'>,
  version: SkillVersion,
  kinds: readonly ValidationKind[],
): string | null {
  for (const kind of kinds) {
    const latest = latestValidation(aggregate, version, kind);
    const label = kind === 'simulation_test' ? 'simulation test' : kind.replace('_', ' ');
    if (!latest) return `No ${label} has been run for version ${version.version}.`;
    if (latest.outcome !== 'passed') {
      return `The latest ${label} for version ${version.version} did not pass (${latest.outcome}).`;
    }
  }
  return null;
}

/** Pilot approvers on record for the skill: they may not publish it. */
export const pilotApproversOf = (aggregate: SkillAggregate): string[] => [
  ...new Set(
    aggregate.approvals
      .filter((a) => a.toState === 'pilot' && a.decision === 'approved')
      .map((a) => a.approver),
  ),
];

interface Evaluation {
  rule: TransitionRule | null;
  failure: { code: SkillErrorCode; message: string } | null;
}

function evaluate(
  aggregate: SkillAggregate,
  to: SkillLifecycle,
  actor: SkillActor,
  expectedVersion: number | null,
): Evaluation {
  const { skill } = aggregate;
  const rule = transitionRule(skill.lifecycle, to);
  const fail = (code: SkillErrorCode, message: string): Evaluation => ({
    rule,
    failure: { code, message },
  });
  if (!rule) {
    return fail(
      'illegal_transition',
      `A ${SKILL_LIFECYCLE_LABELS[skill.lifecycle]} skill cannot move to ${SKILL_LIFECYCLE_LABELS[to]}.`,
    );
  }
  if (actor.kind === 'system') {
    return fail('forbidden', 'Automated actors can never approve, validate or publish skills.');
  }
  if (!actor.permissions.includes(rule.permission)) {
    return fail(
      'forbidden',
      `Moving a skill to ${SKILL_LIFECYCLE_LABELS[to]} requires the ${rule.permission} permission.`,
    );
  }
  if (expectedVersion !== null && expectedVersion !== skill.version) {
    return fail(
      'version_conflict',
      `The skill was modified by someone else (expected version ${expectedVersion}, found ${skill.version}). Reload and retry.`,
    );
  }
  const current = currentVersionOf(aggregate);
  if (!current) return fail('not_found', 'The current version of the skill was not found.');
  if (rule.distinctFromCreator) {
    if (actor.id === skill.createdBy || actor.id === current.createdBy) {
      return fail(
        'separation_of_duties',
        'The reviewer or approver must be a different person from the creator of the skill.',
      );
    }
  }
  if (to === 'published') {
    const approvers = pilotApproversOf(aggregate);
    if (approvers.length === 0) {
      return fail('gate_failed', 'No pilot approval is on record for this skill.');
    }
    if (approvers.includes(actor.id)) {
      return fail(
        'separation_of_duties',
        'The publisher must be a different person from the approver of the pilot stage.',
      );
    }
  }
  const shortfall = validationShortfall(aggregate, current, rule.validations);
  if (shortfall) return fail('gate_failed', shortfall);
  return { rule, failure: null };
}

/** What each legal next state means for this actor now: allowed or why not (the UI shows it as is). */
export function describeSkillTransitions(
  aggregate: SkillAggregate,
  actor: SkillActor,
): SkillTransitionOption[] {
  return SKILL_TRANSITIONS[aggregate.skill.lifecycle].map((to) => {
    const { rule, failure } = evaluate(aggregate, to, actor, null);
    return {
      toState: to,
      allowed: failure === null,
      reason: failure?.message ?? null,
      requiredPermission: rule?.permission ?? 'skill:review',
      requiresDistinctApprover: rule?.distinctFromCreator ?? false,
      gate: rule?.gate ?? null,
    };
  });
}

const VALIDATION_STATUS: Partial<Record<SkillLifecycle, SkillDna['validationStatus']>> = {
  discovered: 'unvalidated',
  draft: 'unvalidated',
  simulation_tested: 'simulation_passed',
  expert_reviewed: 'expert_reviewed',
  pilot: 'pilot_validated',
  validated: 'validated',
  published: 'validated',
};

/** Validation status implied by a lifecycle state (deprecated and retired keep their last status). */
export const validationStatusFor = (
  lifecycle: SkillLifecycle,
  fallback: SkillDna['validationStatus'],
): SkillDna['validationStatus'] => VALIDATION_STATUS[lifecycle] ?? fallback;

export interface TransitionRequest {
  toState: SkillLifecycle;
  reason: string;
  /** Optimistic lock: the skill `version` the caller last saw. */
  expectedVersion: number;
}

/**
 * Moves a skill through its lifecycle. Every gate is explicit: permission, separation of duties,
 * optimistic lock and the validations the current version must hold. Nothing is ever promoted
 * automatically, and every outcome (including a refusal) carries an audit payload.
 */
export function transitionSkill(args: {
  aggregate: SkillAggregate;
  request: TransitionRequest;
  actor: SkillActor;
  op: SkillOpContext;
}): SkillResult<SkillChangeSet> {
  const { aggregate, request, actor, op } = args;
  const { skill } = aggregate;
  const refuse = (code: SkillErrorCode, message: string) =>
    refusal<SkillChangeSet>({
      code,
      message,
      action: request.toState === 'published' ? 'skill.publish' : 'skill.transition',
      targetType: 'skill',
      targetId: skill.id,
      actorId: actor.id,
      now: op.now,
      details: { fromState: skill.lifecycle, toState: request.toState },
    });
  if (request.reason.trim().length < 5) {
    return refuse('validation_failed', 'A reason of at least five characters is required.');
  }
  const { rule, failure } = evaluate(aggregate, request.toState, actor, request.expectedVersion);
  if (failure || !rule) {
    return refuse(
      failure?.code ?? 'illegal_transition',
      failure?.message ?? 'The transition is not allowed.',
    );
  }
  const current = currentVersionOf(aggregate);
  if (!current) return refuse('not_found', 'The current version of the skill was not found.');

  const to = request.toState;
  const approval: SkillApproval = {
    tenantId: op.tenantId,
    createdAt: op.now,
    updatedAt: op.now,
    createdBy: actor.id,
    version: 1,
    id: op.nextId('skp'),
    skillId: skill.id,
    versionId: current.id,
    fromState: skill.lifecycle,
    toState: to,
    decision: rule.decision,
    approver: actor.id,
    requestedBy: skill.createdBy,
    reason: request.reason.trim(),
    decidedAt: op.now,
  };
  const validations: SkillValidation[] = [];
  if (to === 'expert_reviewed') {
    validations.push({
      tenantId: op.tenantId,
      createdAt: op.now,
      updatedAt: op.now,
      createdBy: actor.id,
      version: 1,
      id: op.nextId('skval'),
      skillId: skill.id,
      versionId: current.id,
      kind: 'expert_review',
      outcome: 'passed',
      caseId: null,
      checks: [
        {
          id: 'reviewer-distinct-from-creator',
          passed: true,
          detail: 'The reviewer is not the creator of the skill.',
        },
        {
          id: 'simulation-test-passed',
          passed: true,
          detail: 'The current version holds a passed simulation test.',
        },
        { id: 'review-reason-recorded', passed: true, detail: request.reason.trim().slice(0, 200) },
      ],
      executedBy: actor.id,
      executedAt: op.now,
      synthetic: skill.synthetic,
    });
  }
  const gateKind =
    to === 'validated' ? 'regression' : to === 'simulation_tested' ? 'simulation_test' : null;
  const gateValidation = gateKind ? latestValidation(aggregate, current, gateKind) : undefined;
  const back = to === 'draft' || to === 'discovered';
  const next: SkillDna = {
    ...skill,
    lifecycle: to,
    reviewer: to === 'expert_reviewed' ? actor.id : back ? null : skill.reviewer,
    validationStatus: validationStatusFor(to, skill.validationStatus),
    lastValidatedAt: gateValidation?.executedAt ?? skill.lastValidatedAt,
    updatedAt: op.now,
    version: skill.version + 1,
  };
  const action =
    to === 'published'
      ? 'skill.published'
      : to === 'deprecated'
        ? 'skill.deprecated'
        : to === 'retired'
          ? 'skill.retired'
          : back
            ? 'skill.changes_requested'
            : 'skill.transitioned';
  return skillOk({
    skill: next,
    previousSkillVersion: skill.version,
    newVersions: [],
    versionStates: [],
    validations,
    approvals: [approval],
    audit: [
      auditPayload({
        action,
        targetType: 'skill',
        targetId: skill.id,
        actorId: actor.id,
        now: op.now,
        outcome: 'success',
        details: {
          fromState: skill.lifecycle,
          toState: to,
          versionId: current.id,
          skillVersion: next.version,
          approvalId: approval.id,
          decision: rule.decision,
          reason: approval.reason,
        },
      }),
    ],
  });
}
