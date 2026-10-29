import type {
  Permission,
  SkillApproval,
  SkillDna,
  SkillValidation,
  SkillVersion,
  SkillVersionState,
} from '@caseguard/schemas';
import { stableId } from '../util/ids';

/**
 * Domain-level result and error shapes for SkillDNA governance. They deliberately mirror the API
 * error codes (`apps/api/src/errors.ts`) through SKILL_ERROR_HTTP without importing from the API.
 */
export type SkillErrorCode =
  | 'forbidden'
  | 'separation_of_duties'
  | 'version_conflict'
  | 'illegal_transition'
  | 'gate_failed'
  | 'not_found'
  | 'conflict'
  | 'validation_failed'
  | 'extraction_refused';

/** How the HTTP layer should present each skill error (status and Problem Details `code`). */
export const SKILL_ERROR_HTTP: Readonly<
  Record<SkillErrorCode, { status: number; problemCode: string }>
> = {
  forbidden: { status: 403, problemCode: 'forbidden' },
  separation_of_duties: { status: 403, problemCode: 'forbidden' },
  version_conflict: { status: 409, problemCode: 'version_conflict' },
  illegal_transition: { status: 409, problemCode: 'conflict' },
  gate_failed: { status: 412, problemCode: 'precondition_failed' },
  not_found: { status: 404, problemCode: 'not_found' },
  conflict: { status: 409, problemCode: 'conflict' },
  validation_failed: { status: 422, problemCode: 'validation_failed' },
  extraction_refused: { status: 422, problemCode: 'validation_failed' },
};

/** Payload the API turns into a hash-chained audit event (sequence, role and hash are added there). */
export interface SkillAuditPayload {
  /** Dot-separated verb, for example `skill.transitioned` or `skill.publish_denied`. */
  action: string;
  targetType: 'skill' | 'skill_version';
  targetId: string;
  caseId: string | null;
  outcome: 'success' | 'denied' | 'failure';
  actorId: string;
  occurredAt: string;
  /** Redacted structured details: ids, states and reasons only, never raw case content. */
  details: Record<string, unknown>;
}

export interface SkillError {
  code: SkillErrorCode;
  message: string;
  details: Record<string, unknown>;
  /** Present for governance denials so that blocked attempts are audited as well. */
  audit: SkillAuditPayload | null;
}

export type SkillResult<T> = { ok: true; value: T } | { ok: false; error: SkillError };

export const skillOk = <T>(value: T): SkillResult<T> => ({ ok: true, value });

export function skillFail<T = never>(
  code: SkillErrorCode,
  message: string,
  details: Record<string, unknown> = {},
  audit: SkillAuditPayload | null = null,
): SkillResult<T> {
  return { ok: false, error: { code, message, details, audit } };
}

/** The caller on whose behalf a skill operation runs. Permissions come from the RBAC layer. */
export interface SkillActor {
  id: string;
  permissions: readonly Permission[];
  /** Automated actors may extract and propose but can never approve, validate or publish. */
  kind?: 'user' | 'system';
}

/** Injected clock, tenant and id generator so every operation is reproducible in tests. */
export interface SkillOpContext {
  tenantId: string;
  now: string;
  nextId: (prefix: string) => string;
}

/** Deterministic id generator for tests and seeds: `<prefix>_<hash of seed and counter>`. */
export function createSkillIdGenerator(seed: string): (prefix: string) => string {
  let counter = 0;
  return (prefix) => {
    counter += 1;
    return stableId(prefix, seed, counter);
  };
}

/** Everything the governance functions need to know about one skill. */
export interface SkillAggregate {
  skill: SkillDna;
  versions: readonly SkillVersion[];
  validations: readonly SkillValidation[];
  approvals: readonly SkillApproval[];
}

/** The atomic set of writes an operation asks the persistence layer to apply. */
export interface SkillChangeSet {
  /** The skill row after the change; `version` is the incremented optimistic-lock value. */
  skill: SkillDna;
  /** The `skill.version` the caller must still see when persisting (compare-and-swap). */
  previousSkillVersion: number;
  newVersions: SkillVersion[];
  versionStates: { versionId: string; state: SkillVersionState }[];
  validations: SkillValidation[];
  approvals: SkillApproval[];
  audit: SkillAuditPayload[];
}

export const currentVersionOf = (aggregate: SkillAggregate): SkillVersion | undefined =>
  aggregate.versions.find((v) => v.id === aggregate.skill.currentVersionId);

/** Pure reducer used by tests and the demo seed; production persistence applies the same writes. */
export function applySkillChangeSet(
  aggregate: SkillAggregate,
  change: SkillChangeSet,
): SkillAggregate {
  const stateChanges = new Map(change.versionStates.map((s) => [s.versionId, s.state]));
  const versions = [...aggregate.versions, ...change.newVersions].map((v) => {
    const next = stateChanges.get(v.id);
    return next ? { ...v, state: next } : v;
  });
  return {
    skill: change.skill,
    versions,
    validations: [...aggregate.validations, ...change.validations],
    approvals: [...aggregate.approvals, ...change.approvals],
  };
}
