import type {
  CaseBundle,
  EventType,
  IngestionPreview,
  ParticipantRole,
  PreviewEvent,
  SourceKind,
  ValidationIssue,
} from '@caseguard/schemas';
import { excerpt } from './text';
import type {
  EventTypeCount,
  ParseConfidence,
  ParseIssue,
  ParseResult,
  ParseWarning,
  ParserSource,
  WarningCode,
} from './types';

const MAX_PREVIEW_EVENTS = 25;
const MAX_ISSUES = 200;
const SOURCE_KIND: Record<ParserSource, SourceKind> = {
  pasted_transcript: 'pasted_text',
  csv: 'uploaded_file',
  json_bundle: 'json_bundle',
};

/** The part of the API `IngestionPreview` that only the parser can know. */
export type IngestionPreviewParts = Pick<
  IngestionPreview,
  'ok' | 'sourceKind' | 'synthetic' | 'issues' | 'summary' | 'eventsPreview'
>;

export interface RoleOverview {
  role: ParticipantRole;
  participants: number;
  events: number;
}

export interface WarningOverview {
  total: number;
  info: number;
  warning: number;
  byCode: Partial<Record<WarningCode, number>>;
}

/** Summary of a draft for the preview-before-analysis step. */
export interface DraftOverview {
  eventCount: number;
  participantCount: number;
  firstEventAt: string | null;
  lastEventAt: string | null;
  spanMinutes: number;
  eventTypes: EventTypeCount[];
  roles: RoleOverview[];
  warnings: WarningOverview;
  hasResolution: boolean;
}

export interface DraftPreview extends IngestionPreviewParts {
  overview: DraftOverview | null;
  /** Heuristic parse-quality estimate; `null` when the input could not be parsed. */
  confidence: ParseConfidence | null;
  errorCount: number;
}

export interface PreviewOptions {
  /** Overrides the source kind derived from the parser (for example an uploaded JSON file). */
  sourceKind?: SourceKind;
  /** Number of events listed in `eventsPreview`; at most 25. */
  maxEvents?: number;
  /** Excerpt length per event; at most 400. */
  excerptChars?: number;
}

function warningPath(w: ParseWarning): string {
  if (w.row !== undefined) return w.column ? `row ${w.row}, column "${w.column}"` : `row ${w.row}`;
  if (w.line !== undefined) return `line ${w.line}`;
  return '(input)';
}

const joinText = (message: string, hint: string | undefined): string =>
  (hint ? `${message} ${hint}` : message).slice(0, 500);

/** Warnings and errors in the `ValidationIssue` shape of the preview contract (errors first). */
export function toValidationIssues(
  errors: readonly ParseIssue[],
  warnings: readonly ParseWarning[],
): ValidationIssue[] {
  const fromErrors = errors.map<ValidationIssue>((e) => ({
    path: e.path.slice(0, 300),
    message: joinText(e.message, e.hint),
    severity: 'error',
  }));
  const fromWarnings = warnings.map<ValidationIssue>((w) => ({
    path: warningPath(w).slice(0, 300),
    message: joinText(w.message, w.hint),
    severity: 'warning',
  }));
  return [...fromErrors, ...fromWarnings].slice(0, MAX_ISSUES);
}

export function overviewOf(bundle: CaseBundle, warnings: readonly ParseWarning[]): DraftOverview {
  const events = bundle.events;
  const first = events.reduce<string | null>(
    (min, e) => (min === null || e.timestamp < min ? e.timestamp : min),
    null,
  );
  const last = events.reduce<string | null>(
    (max, e) => (max === null || e.timestamp > max ? e.timestamp : max),
    null,
  );
  const typeCounts = new Map<EventType, number>();
  const roleOf = new Map(bundle.participants.map((p) => [p.id, p.role] as const));
  const roleEvents = new Map<ParticipantRole, number>();
  for (const event of events) {
    typeCounts.set(event.type, (typeCounts.get(event.type) ?? 0) + 1);
    const role = roleOf.get(event.participantId);
    if (role) roleEvents.set(role, (roleEvents.get(role) ?? 0) + 1);
  }
  const roleParticipants = new Map<ParticipantRole, number>();
  for (const p of bundle.participants) {
    roleParticipants.set(p.role, (roleParticipants.get(p.role) ?? 0) + 1);
  }
  const byCode: Partial<Record<WarningCode, number>> = {};
  for (const w of warnings) byCode[w.code] = (byCode[w.code] ?? 0) + (w.count ?? 1);
  return {
    eventCount: events.length,
    participantCount: bundle.participants.length,
    firstEventAt: first,
    lastEventAt: last,
    spanMinutes: first && last ? Math.round((Date.parse(last) - Date.parse(first)) / 60_000) : 0,
    eventTypes: [...typeCounts]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count || (a.type < b.type ? -1 : 1)),
    roles: [...roleEvents.keys(), ...roleParticipants.keys()]
      .filter((role, i, all) => all.indexOf(role) === i)
      .sort()
      .map((role) => ({
        role,
        participants: roleParticipants.get(role) ?? 0,
        events: roleEvents.get(role) ?? 0,
      })),
    warnings: {
      total: warnings.length,
      info: warnings.filter((w) => w.severity === 'info').length,
      warning: warnings.filter((w) => w.severity === 'warning').length,
      byCode,
    },
    hasResolution: bundle.resolution !== undefined,
  };
}

/**
 * Builds the preview of a parse result: summary, a short list of events, warnings and errors as
 * validation issues, and an overview (time span, roles, event types). It never parses again and
 * never runs redaction or injection detection: those belong to `@caseguard/security`, and the API
 * merges their findings with these parts. Call it on the redacted bundle so excerpts are safe.
 */
export function buildDraftPreview(result: ParseResult, options: PreviewOptions = {}): DraftPreview {
  const sourceKind = options.sourceKind ?? SOURCE_KIND[result.source];
  if (!result.ok) {
    return {
      ok: false,
      sourceKind,
      synthetic: false,
      issues: toValidationIssues(result.errors, result.warnings),
      summary: null,
      eventsPreview: [],
      overview: null,
      confidence: null,
      errorCount: result.errors.length,
    };
  }
  const { bundle } = result;
  const overview = overviewOf(bundle, result.warnings);
  const limit = Math.min(MAX_PREVIEW_EVENTS, Math.max(0, options.maxEvents ?? MAX_PREVIEW_EVENTS));
  const chars = Math.min(400, Math.max(20, options.excerptChars ?? 240));
  const roleOf = new Map(bundle.participants.map((p) => [p.id, p.role] as const));
  const eventsPreview = [...bundle.events]
    .sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0))
    .slice(0, limit)
    .map<PreviewEvent>((e) => ({
      id: e.id,
      timestamp: e.timestamp,
      type: e.type,
      participantRole: roleOf.get(e.participantId) ?? 'system',
      title: e.title ?? null,
      bodyExcerpt: excerpt(e.body, chars),
    }));
  return {
    ok: true,
    sourceKind,
    synthetic: bundle.synthetic,
    issues: toValidationIssues([], result.warnings),
    summary: {
      reference: bundle.case.reference,
      title: bundle.case.title,
      product: bundle.case.product,
      workload: bundle.case.workload,
      eventCount: overview.eventCount,
      participantCount: overview.participantCount,
      firstEventAt: overview.firstEventAt,
      lastEventAt: overview.lastEventAt,
      hasResolution: overview.hasResolution,
      durationHours: Math.round((overview.spanMinutes / 60) * 100) / 100,
    },
    eventsPreview,
    overview,
    confidence: result.confidence,
    errorCount: 0,
  };
}
