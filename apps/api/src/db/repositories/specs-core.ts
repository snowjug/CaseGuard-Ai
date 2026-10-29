import type {
  Case,
  CaseEvent,
  CaseParticipant,
  CaseResolution,
  CaseSource,
  PromptVersion,
  Tenant,
  User,
} from '@caseguard/schemas';
import { col, ts, tsOrNull, type TableSpec } from './support';

/**
 * Projection of every entity onto its table. Relational columns mirror fields of the entity that
 * are used to filter, sort or join; `data` holds the whole validated entity and is what reads
 * return (after re-validation). Writers always go through these specs so the two never diverge.
 *
 * The specs are grouped by area (core, analysis, skills, ops) and re-exported by `table-specs.ts`.
 * This module holds tenancy and the case aggregate.
 */

export interface Ordered<T> {
  entity: T;
  /** Position inside the analysis snapshot, so lists keep the order the engine produced. */
  ordinal: number;
}

// ------------------------------------------------------------------ tenancy

export const TENANTS: TableSpec<Tenant> = {
  table: 'tenants',
  key: ['id'],
  columns: [
    col('id', 'text', (t: Tenant) => t.id),
    col('name', 'text', (t) => t.name),
    col('slug', 'text', (t) => t.slug),
    col('synthetic', 'bool', (t) => t.synthetic),
    col('created_at', 'timestamptz', (t) => ts(t.createdAt)),
    col('data', 'jsonb', (t) => t),
  ],
};

export interface UserRow {
  user: User;
  createdBy: string;
}

export const USERS: TableSpec<UserRow> = {
  table: 'users',
  key: ['tenant_id', 'id'],
  columns: [
    col('tenant_id', 'text', (r: UserRow) => r.user.tenantId),
    col('id', 'text', (r) => r.user.id),
    col('display_name', 'text', (r) => r.user.displayName),
    col('email', 'text', (r) => r.user.email),
    col('roles', 'text[]', (r) => r.user.roles),
    col('status', 'text', (r) => r.user.status),
    col('synthetic', 'bool', (r) => r.user.synthetic),
    col('created_at', 'timestamptz', (r) => ts(r.user.createdAt)),
    col('updated_at', 'timestamptz', (r) => ts(r.user.updatedAt)),
    col('created_by', 'text', (r) => r.createdBy),
    col('version', 'int', (r) => r.user.version),
    col('data', 'jsonb', (r) => r.user),
  ],
};

export interface SettingRow {
  tenantId: string;
  section: string;
  value: unknown;
  version: number;
  updatedAt: string;
  updatedBy: string;
  changeNote: string;
}

export const GOVERNANCE_SETTINGS: TableSpec<SettingRow> = {
  table: 'governance_settings',
  key: ['tenant_id', 'section'],
  columns: [
    col('tenant_id', 'text', (r: SettingRow) => r.tenantId),
    col('section', 'text', (r) => r.section),
    col('value', 'jsonb', (r) => r.value),
    col('version', 'int', (r) => r.version),
    col('updated_at', 'timestamptz', (r) => ts(r.updatedAt)),
    col('updated_by', 'text', (r) => r.updatedBy),
    col('change_note', 'text', (r) => r.changeNote),
  ],
};

export const PROMPT_VERSIONS: TableSpec<PromptVersion> = {
  table: 'prompt_versions',
  key: ['tenant_id', 'id'],
  columns: [
    col('tenant_id', 'text', (p: PromptVersion) => p.tenantId),
    col('id', 'text', (p) => p.id),
    col('agent', 'text', (p) => p.agent),
    col('semver', 'text', (p) => p.version),
    col('template_hash', 'text', (p) => p.templateHash),
    col('status', 'text', (p) => p.status),
    col('created_at', 'timestamptz', (p) => ts(p.createdAt)),
    col('updated_at', 'timestamptz', (p) => ts(p.updatedAt)),
    col('created_by', 'text', (p) => p.createdBy),
    col('data', 'jsonb', (p) => p),
  ],
};

// ------------------------------------------------------------------ cases

export const CASES: TableSpec<Case> = {
  table: 'cases',
  key: ['tenant_id', 'id'],
  columns: [
    col('tenant_id', 'text', (c: Case) => c.tenantId),
    col('id', 'text', (c) => c.id),
    col('reference', 'text', (c) => c.reference),
    col('title', 'text', (c) => c.title),
    col('product', 'text', (c) => c.product),
    col('workload', 'text', (c) => c.workload),
    col('severity', 'text', (c) => c.severity),
    col('status', 'text', (c) => c.status),
    col('customer_alias', 'text', (c) => c.customerAlias),
    col('opened_at', 'timestamptz', (c) => ts(c.openedAt)),
    col('closed_at', 'timestamptz', (c) => tsOrNull(c.closedAt)),
    col('synthetic', 'bool', (c) => c.synthetic),
    col('tags', 'text[]', (c) => c.tags),
    col('event_count', 'int', (c) => c.eventCount),
    col('first_event_at', 'timestamptz', (c) => tsOrNull(c.firstEventAt)),
    col('last_event_at', 'timestamptz', (c) => tsOrNull(c.lastEventAt)),
    col('source_id', 'text', (c) => c.sourceId),
    col('source_kind', 'text', (c) => c.sourceKind),
    col('content_hash', 'text', (c) => c.contentHash),
    col('redaction_applied', 'bool', (c) => c.redactionApplied),
    col('redaction_replacements', 'int', (c) => c.redactionReplacements),
    col('injection_detected', 'bool', (c) => c.injectionDetected),
    col('has_resolution', 'bool', (c) => c.hasResolution),
    col('analysis_state', 'text', (c) => c.analysisState),
    col('last_analysis_run_id', 'text', (c) => c.lastAnalysisRunId),
    col('analyzed_at', 'timestamptz', (c) => tsOrNull(c.analyzedAt)),
    col('created_at', 'timestamptz', (c) => ts(c.createdAt)),
    col('updated_at', 'timestamptz', (c) => ts(c.updatedAt)),
    col('created_by', 'text', (c) => c.createdBy),
    col('version', 'int', (c) => c.version),
    col('data', 'jsonb', (c) => c),
  ],
};

export interface SourceRow {
  source: CaseSource;
  payload: string;
}

export const CASE_SOURCES: TableSpec<SourceRow> = {
  table: 'case_sources',
  key: ['tenant_id', 'case_id', 'id'],
  columns: [
    col('tenant_id', 'text', (r: SourceRow) => r.source.tenantId),
    col('case_id', 'text', (r) => r.source.caseId),
    col('id', 'text', (r) => r.source.id),
    col('kind', 'text', (r) => r.source.kind),
    col('file_name', 'text', (r) => r.source.fileName),
    col('media_type', 'text', (r) => r.source.mediaType),
    col('size_bytes', 'int', (r) => r.source.sizeBytes),
    col('received_sha256', 'text', (r) => r.source.receivedSha256),
    col('stored_sha256', 'text', (r) => r.source.storedSha256),
    col('storage_ref', 'text', (r) => r.source.storageRef),
    col('redaction_applied', 'bool', (r) => r.source.redactionApplied),
    col('redaction_replacements', 'int', (r) => r.source.redactionReplacements),
    col('synthetic', 'bool', (r) => r.source.synthetic),
    col('payload', 'text', (r) => r.payload),
    col('created_at', 'timestamptz', (r) => ts(r.source.createdAt)),
    col('updated_at', 'timestamptz', (r) => ts(r.source.updatedAt)),
    col('created_by', 'text', (r) => r.source.createdBy),
    col('version', 'int', (r) => r.source.version),
    col('data', 'jsonb', (r) => r.source),
  ],
};

export interface ParticipantRow {
  tenantId: string;
  caseId: string;
  participant: CaseParticipant;
  createdAt: string;
}

export const CASE_PARTICIPANTS: TableSpec<ParticipantRow> = {
  table: 'case_participants',
  key: ['tenant_id', 'case_id', 'id'],
  columns: [
    col('tenant_id', 'text', (r: ParticipantRow) => r.tenantId),
    col('case_id', 'text', (r) => r.caseId),
    col('id', 'text', (r) => r.participant.id),
    col('role', 'text', (r) => r.participant.role),
    col('alias', 'text', (r) => r.participant.alias),
    col('event_count', 'int', (r) => r.participant.eventCount),
    col('first_seen_at', 'timestamptz', (r) => tsOrNull(r.participant.firstSeenAt)),
    col('created_at', 'timestamptz', (r) => ts(r.createdAt)),
    col('data', 'jsonb', (r) => r.participant),
  ],
};

export const CASE_EVENTS: TableSpec<CaseEvent> = {
  table: 'case_events',
  key: ['tenant_id', 'case_id', 'id'],
  columns: [
    col('tenant_id', 'text', (e: CaseEvent) => e.tenantId),
    col('case_id', 'text', (e) => e.caseId),
    col('id', 'text', (e) => e.id),
    col('source_id', 'text', (e) => e.sourceId),
    col('sequence', 'int', (e) => e.sequence),
    col('event_ts', 'timestamptz', (e) => ts(e.timestamp)),
    col('participant_id', 'text', (e) => e.participantId),
    col('participant_role', 'text', (e) => e.participantRole),
    col('type', 'text', (e) => e.type),
    col('channel', 'text', (e) => e.channel),
    col('created_at', 'timestamptz', (e) => ts(e.createdAt)),
    col('updated_at', 'timestamptz', (e) => ts(e.updatedAt)),
    col('created_by', 'text', (e) => e.createdBy),
    col('version', 'int', (e) => e.version),
    col('data', 'jsonb', (e) => e),
  ],
};

export interface ResolutionRow {
  tenantId: string;
  resolution: CaseResolution;
  createdAt: string;
  createdBy: string;
}

export const CASE_RESOLUTIONS: TableSpec<ResolutionRow> = {
  table: 'case_resolutions',
  key: ['tenant_id', 'case_id'],
  columns: [
    col('tenant_id', 'text', (r: ResolutionRow) => r.tenantId),
    col('case_id', 'text', (r) => r.resolution.caseId),
    col('resolved_at', 'timestamptz', (r) => ts(r.resolution.resolvedAt)),
    col('created_at', 'timestamptz', (r) => ts(r.createdAt)),
    col('created_by', 'text', (r) => r.createdBy),
    col('data', 'jsonb', (r) => r.resolution),
  ],
};
