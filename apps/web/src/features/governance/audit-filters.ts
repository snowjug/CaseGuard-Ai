import { codecs, type UrlCodec } from '../../lib/url-state';
import { boundedString } from '../../lib/url-codecs';

export const OUTCOME_FILTERS = ['all', 'success', 'denied', 'failure'] as const;
export type OutcomeFilter = (typeof OUTCOME_FILTERS)[number];

export const OUTCOME_LABELS: Record<OutcomeFilter, string> = {
  all: 'Any outcome',
  success: 'Success',
  denied: 'Denied',
  failure: 'Failure',
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar day (`2025-03-14`, read as UTC). Anything else is treated as not set. */
const dayCodec: UrlCodec<string> = {
  parse: (raw) =>
    raw !== null && DAY.test(raw) && !Number.isNaN(Date.parse(`${raw}T00:00:00Z`)) ? raw : '',
  serialize: (value) => (value === '' ? null : value),
};

/** Audit-log filters. Short keys keep shared links readable; defaults are omitted from the URL. */
export const AUDIT_FILTERS = {
  act: boundedString(80),
  actor: boundedString(120),
  acase: codecs.optionalString(),
  aout: codecs.enumOf(OUTCOME_FILTERS, 'all'),
  afrom: dayCodec,
  ato: dayCodec,
} as const;

export interface AuditFilterValues {
  act: string;
  actor: string;
  acase: string | null;
  aout: OutcomeFilter;
  afrom: string;
  ato: string;
}

export interface AuditQuery {
  limit: number;
  action?: string;
  actorId?: string;
  caseId?: string;
  outcome?: 'success' | 'denied' | 'failure';
  from?: string;
  to?: string;
}

/** The `governance.audit` query for the filters: unset filters are left out, a day becomes its UTC bounds. */
export function auditQuery(filters: AuditFilterValues, limit = 50): AuditQuery {
  const query: AuditQuery = { limit };
  if (filters.act.trim()) query.action = filters.act.trim();
  if (filters.actor.trim()) query.actorId = filters.actor.trim();
  if (filters.acase) query.caseId = filters.acase;
  if (filters.aout !== 'all') query.outcome = filters.aout;
  if (filters.afrom) query.from = `${filters.afrom}T00:00:00.000Z`;
  if (filters.ato) query.to = `${filters.ato}T23:59:59.999Z`;
  return query;
}

export function activeAuditFilters(filters: AuditFilterValues): number {
  return [
    filters.act.trim() !== '',
    filters.actor.trim() !== '',
    filters.acase !== null,
    filters.aout !== 'all',
    filters.afrom !== '',
    filters.ato !== '',
  ].filter(Boolean).length;
}

/** Audit actions the API writes, offered as suggestions in the action filter (the filter itself is an exact match). */
export const KNOWN_AUDIT_ACTIONS: readonly string[] = [
  'analysis.completed',
  'case.deleted',
  'case.ingested',
  'claim.reclassified',
  'counterfactual.reviewed',
  'demo.reset',
  'demo.seed',
  'export.created',
  'governance.settings.updated',
  'roles.assigned',
  'skill.applied',
  'skill.extracted',
  'skill.published',
  'skill.transitioned',
];
