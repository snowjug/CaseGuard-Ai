import type {
  SkillApproval,
  SkillDna,
  SkillMatch,
  SkillValidation,
  SkillVersion,
} from '@caseguard/schemas';
import type { Ordered } from './specs-core';
import { col, ts, tsOrNull, type TableSpec } from './support';

/** Table projections for skill DNA, its versions, validations, approvals and case matches. */

export const SKILLS: TableSpec<SkillDna> = {
  table: 'skills',
  key: ['tenant_id', 'id'],
  columns: [
    col('tenant_id', 'text', (s: SkillDna) => s.tenantId),
    col('id', 'text', (s) => s.id),
    col('key', 'text', (s) => s.key),
    col('name', 'text', (s) => s.name),
    col('workload', 'text', (s) => s.workload),
    col('product', 'text', (s) => s.product),
    col('lifecycle', 'text', (s) => s.lifecycle),
    col('current_version_id', 'text', (s) => s.currentVersionId),
    col('current_version', 'text', (s) => s.currentVersion),
    col('owner', 'text', (s) => s.owner),
    col('reviewer', 'text', (s) => s.reviewer),
    col('validation_status', 'text', (s) => s.validationStatus),
    col('last_validated_at', 'timestamptz', (s) => tsOrNull(s.lastValidatedAt)),
    col('confidence', 'float8', (s) => s.confidence),
    col('has_proposed_mutation', 'bool', (s) => s.hasProposedMutation),
    col('synthetic', 'bool', (s) => s.synthetic),
    col('source_case_ids', 'text[]', (s) => s.sourceCaseIds),
    col('created_at', 'timestamptz', (s) => ts(s.createdAt)),
    col('updated_at', 'timestamptz', (s) => ts(s.updatedAt)),
    col('created_by', 'text', (s) => s.createdBy),
    col('version', 'int', (s) => s.version),
    col('data', 'jsonb', (s) => s),
  ],
};

export const SKILL_VERSIONS: TableSpec<SkillVersion> = {
  table: 'skill_versions',
  key: ['tenant_id', 'skill_id', 'id'],
  columns: [
    col('tenant_id', 'text', (v: SkillVersion) => v.tenantId),
    col('skill_id', 'text', (v) => v.skillId),
    col('id', 'text', (v) => v.id),
    col('semver', 'text', (v) => v.version),
    col('sequence', 'int', (v) => v.sequence),
    col('parent_version_id', 'text', (v) => v.parentVersionId),
    col('change_type', 'text', (v) => v.changeType),
    col('state', 'text', (v) => v.state),
    col('lifecycle_at_creation', 'text', (v) => v.lifecycleAtCreation),
    col('content_hash', 'text', (v) => v.contentHash),
    col('created_at', 'timestamptz', (v) => ts(v.createdAt)),
    col('updated_at', 'timestamptz', (v) => ts(v.updatedAt)),
    col('created_by', 'text', (v) => v.createdBy),
    col('data', 'jsonb', (v) => v),
  ],
};

export const SKILL_VALIDATIONS: TableSpec<SkillValidation> = {
  table: 'skill_validations',
  key: ['tenant_id', 'skill_id', 'id'],
  columns: [
    col('tenant_id', 'text', (v: SkillValidation) => v.tenantId),
    col('skill_id', 'text', (v) => v.skillId),
    col('id', 'text', (v) => v.id),
    col('version_id', 'text', (v) => v.versionId),
    col('kind', 'text', (v) => v.kind),
    col('outcome', 'text', (v) => v.outcome),
    col('case_id', 'text', (v) => v.caseId),
    col('executed_by', 'text', (v) => v.executedBy),
    col('executed_at', 'timestamptz', (v) => ts(v.executedAt)),
    col('synthetic', 'bool', (v) => v.synthetic),
    col('created_at', 'timestamptz', (v) => ts(v.createdAt)),
    col('updated_at', 'timestamptz', (v) => ts(v.updatedAt)),
    col('created_by', 'text', (v) => v.createdBy),
    col('data', 'jsonb', (v) => v),
  ],
};

export const SKILL_APPROVALS: TableSpec<SkillApproval> = {
  table: 'skill_approvals',
  key: ['tenant_id', 'skill_id', 'id'],
  columns: [
    col('tenant_id', 'text', (a: SkillApproval) => a.tenantId),
    col('skill_id', 'text', (a) => a.skillId),
    col('id', 'text', (a) => a.id),
    col('version_id', 'text', (a) => a.versionId),
    col('from_state', 'text', (a) => a.fromState),
    col('to_state', 'text', (a) => a.toState),
    col('decision', 'text', (a) => a.decision),
    col('approver', 'text', (a) => a.approver),
    col('requested_by', 'text', (a) => a.requestedBy),
    col('decided_at', 'timestamptz', (a) => ts(a.decidedAt)),
    col('created_at', 'timestamptz', (a) => ts(a.createdAt)),
    col('updated_at', 'timestamptz', (a) => ts(a.updatedAt)),
    col('created_by', 'text', (a) => a.createdBy),
    col('data', 'jsonb', (a) => a),
  ],
};

export const SKILL_MATCHES: TableSpec<Ordered<SkillMatch>> = {
  table: 'skill_matches',
  key: ['tenant_id', 'case_id', 'id'],
  columns: [
    col('tenant_id', 'text', (r: Ordered<SkillMatch>) => r.entity.tenantId),
    col('case_id', 'text', (r) => r.entity.caseId),
    col('id', 'text', (r) => r.entity.id),
    col('skill_id', 'text', (r) => r.entity.skillId),
    col('version_id', 'text', (r) => r.entity.versionId),
    col('as_of', 'timestamptz', (r) => ts(r.entity.asOf)),
    col('score', 'float8', (r) => r.entity.score),
    col('applicability', 'text', (r) => r.entity.applicability),
    col('ordinal', 'int', (r) => r.ordinal),
    col('applied', 'bool', (r) => r.entity.applied),
    col('applied_at', 'timestamptz', (r) => tsOrNull(r.entity.appliedAt)),
    col('applied_by', 'text', (r) => r.entity.appliedBy),
    col('created_at', 'timestamptz', (r) => ts(r.entity.createdAt)),
    col('updated_at', 'timestamptz', (r) => ts(r.entity.updatedAt)),
    col('created_by', 'text', (r) => r.entity.createdBy),
    col('version', 'int', (r) => r.entity.version),
    col('data', 'jsonb', (r) => r.entity),
  ],
};
