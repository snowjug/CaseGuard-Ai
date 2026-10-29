import type {
  CaseBundle,
  CaseStatus,
  EventType,
  ParticipantRole,
  Severity,
} from '@caseguard/schemas';
import type { ParserLimits } from './limits';

export type ParserSource = 'pasted_transcript' | 'csv' | 'json_bundle';

export type WarningSeverity = 'info' | 'warning';

export const WARNING_CODES = [
  'timezone_assumed',
  'timezone_unrecognised',
  'date_assumed',
  'date_rollover_assumed',
  'timestamp_inherited',
  'timestamp_unresolved',
  'timestamp_in_future',
  'events_reordered',
  'preamble_ignored',
  'lines_without_speaker',
  'quoted_text_removed',
  'body_truncated',
  'title_truncated',
  'role_unknown',
  'role_generalised',
  'role_ambiguous',
  'event_type_defaulted',
  'speakers_merged',
  'workload_assumed',
  'metadata_defaulted',
  'header_ignored',
  'resolution_not_extracted',
  'unclosed_code_fence',
  'invisible_characters_removed',
  'control_characters_removed',
  'invalid_characters_replaced',
  'csv_delimiter_detected',
  'csv_column_ignored',
  'csv_column_conflict',
  'csv_formula_neutralised',
  'csv_blank_rows_skipped',
  'csv_stray_quote',
  'bom_removed',
  'reply_link_dropped',
  'empty_message_skipped',
  'unknown_field',
  'warnings_truncated',
] as const;
export type WarningCode = (typeof WARNING_CODES)[number];

/** A non-fatal observation about the input. Ambiguity is reported here instead of being guessed. */
export interface ParseWarning {
  code: WarningCode;
  severity: WarningSeverity;
  message: string;
  /** What the author can do about it. */
  hint?: string;
  /** 1-based line of the pasted text or of the CSV file where the problem starts. */
  line?: number;
  /** 1-based spreadsheet row (the header is row 1). */
  row?: number;
  column?: string;
  /** How many places this warning summarises (aggregated warnings only). */
  count?: number;
}

export const ISSUE_CODES = [
  'input_not_text',
  'input_empty',
  'input_too_large',
  'too_many_lines',
  'no_turns',
  'no_timestamps',
  'too_many_events',
  'draft_invalid',
  'csv_unterminated_quote',
  'csv_too_many_rows',
  'csv_too_many_columns',
  'csv_field_too_long',
  'csv_no_header',
  'csv_missing_column',
  'csv_no_rows',
  'csv_row_invalid',
  'json_syntax',
  'json_too_deep',
  'json_too_complex',
  'json_duplicate_key',
  'json_forbidden_key',
  'json_invalid_string',
  'json_invalid_number',
  'json_not_an_object',
  'schema_version_mismatch',
  'schema_invalid_type',
  'schema_invalid_value',
  'schema_too_small',
  'schema_too_big',
  'schema_invalid_format',
  'schema_custom',
  'schema_invalid',
  'errors_truncated',
] as const;
export type ParseIssueCode = (typeof ISSUE_CODES)[number];

/** A fatal, field-level problem written for a person rather than a validator. */
export interface ParseIssue {
  code: ParseIssueCode;
  /** Where: `events[3].timestamp`, `line 12`, or `row 5, column "Body"`. */
  path: string;
  message: string;
  /** How to fix it. */
  hint: string;
  /** Short, sanitised excerpt of the offending value; null when nothing useful can be shown. */
  received: string | null;
  line?: number;
  row?: number;
  column?: string;
}

export type ConfidenceLevel = 'high' | 'medium' | 'low';

/**
 * Heuristic estimate of how faithfully the draft reflects the input. It is a model of parse
 * quality (never a statistical probability) and is always labelled as an estimate.
 */
export interface ParseConfidence {
  score: number;
  level: ConfidenceLevel;
  reasons: string[];
  estimated: true;
}

export interface ParseStats {
  inputChars: number;
  inputBytes: number;
  lines: number;
  events: number;
  participants: number;
  ignoredLines: number;
  skippedRows: number;
}

export type RoleBasis = 'override' | 'column' | 'keyword' | 'generic_customer' | 'unknown';
export type TypeBasis =
  | 'explicit'
  | 'column'
  | 'status_pattern'
  | 'resolution_pattern'
  | 'validation_pattern'
  | 'escalation_pattern'
  | 'code_like'
  | 'email_block'
  | 'salutation'
  | 'call_marker'
  | 'action_verb'
  | 'system_role'
  | 'customer_side'
  | 'unknown_speaker'
  | 'default';
export type TimestampBasis = 'explicit' | 'header' | 'date_assumed' | 'inherited' | 'rollover';

/** Pseudonymous participant as it will appear in the draft bundle. */
export interface SpeakerSummary {
  participantId: string;
  alias: string;
  role: ParticipantRole;
  roleBasis: RoleBasis;
  /** Label exactly as pasted (trimmed). For display in the preview only; never persist it. */
  label: string;
  eventCount: number;
}

/** Why an event looks the way it does, so the preview can explain every inference. */
export interface EventNote {
  eventId: string;
  /** 1-based source line (transcript) or spreadsheet row (CSV). */
  at: number;
  typeBasis: TypeBasis;
  timestampBasis: TimestampBasis;
  inResponseToBasis: 'subject_thread' | 'request_reply' | 'adjacent_output' | 'column' | null;
}

interface ResultBase {
  source: ParserSource;
  warnings: ParseWarning[];
  stats: ParseStats;
}

export interface DraftSuccess extends ResultBase {
  ok: true;
  /** Always passes `CaseBundleSchema`; events are sorted by timestamp. */
  bundle: CaseBundle;
  confidence: ParseConfidence;
  speakers: SpeakerSummary[];
  eventNotes: EventNote[];
}

export interface DraftFailure extends ResultBase {
  ok: false;
  errors: ParseIssue[];
}

export type ParseResult = DraftSuccess | DraftFailure;

/** Generates the identifiers of a draft so callers (and tests) control them. */
export interface IdFactory {
  /** `index` is the 0-based chronological position; `total` the number of events. */
  eventId(index: number, total: number): string;
  /** `ordinal` is 1-based per role; `unidentified` marks speakers whose role could not be told. */
  participantId(role: ParticipantRole, ordinal: number, unidentified: boolean): string;
}

export type DateOrder = 'dmy' | 'mdy';

export interface DraftOptions {
  /** Required and explicit: demo data is `true`; anything else must be `false` and is treated as real. */
  synthetic: boolean;
  /** Replaces the standard synthetic notice. */
  syntheticNotice?: string;
  /** Injected clock (UTC ISO-8601). Last-resort date for time-only stamps and the future-date check. */
  now: string;
  title?: string;
  reference?: string;
  product?: string;
  workload?: string;
  severity?: Severity;
  status?: CaseStatus;
  customerAlias?: string;
  tags?: readonly string[];
  /** Maps a speaker label (any case) to a role when keywords cannot decide. */
  speakerRoles?: Readonly<Record<string, ParticipantRole>>;
  /** `YYYY-MM-DD` used for stamps that carry only a time of day. */
  defaultDate?: string;
  /** Offset applied to stamps without a zone; defaults to 0 (UTC) and is always reported. */
  assumedUtcOffsetMinutes?: number;
  /** Resolves day/month order of `03/09/2026`-style dates when the text cannot. */
  dateOrder?: DateOrder;
  limits?: Partial<ParserLimits>;
  ids?: IdFactory;
}

export type TranscriptOptions = DraftOptions;

export type CsvField =
  | 'timestamp'
  | 'date'
  | 'time'
  | 'participant'
  | 'role'
  | 'type'
  | 'title'
  | 'body'
  | 'action'
  | 'actionKey'
  | 'customerEffort'
  | 'destructive'
  | 'durationMinutes'
  | 'inResponseTo'
  | 'id'
  | 'channel'
  | 'correlationIds';

export interface CsvOptions extends DraftOptions {
  /** Forces the delimiter instead of sniffing it. */
  delimiter?: ',' | ';' | '\t';
  /** Maps a header (any case) to a field, overriding the built-in aliases. */
  columnMap?: Readonly<Record<string, CsvField>>;
}

export interface JsonBundleOptions {
  limits?: Partial<ParserLimits>;
}

export interface EventTypeCount {
  type: EventType;
  count: number;
}
