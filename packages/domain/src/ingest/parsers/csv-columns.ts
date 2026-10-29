import type { CsvField } from './types';

/** Accepted header names per field (matched after `normaliseHeader`). */
export const CSV_ALIASES: Readonly<Record<CsvField, readonly string[]>> = {
  timestamp: [
    'timestamp',
    'datetime',
    'date_time',
    'date_and_time',
    'ts',
    'when',
    'sent',
    'sent_at',
    'sent_on',
    'created',
    'created_at',
    'created_on',
    'event_time',
    'event_timestamp',
    'timestamp_utc',
    'time_utc',
    'date_utc',
    'utc',
  ],
  date: ['date', 'day'],
  time: ['time', 'time_of_day'],
  participant: [
    'participant',
    'participant_name',
    'author',
    'from',
    'sender',
    'speaker',
    'user',
    'name',
    'by',
    'actor',
    'who',
    'posted_by',
    'created_by',
  ],
  role: ['role', 'participant_role', 'speaker_role', 'author_role', 'side', 'party'],
  type: ['type', 'event_type', 'kind', 'category', 'event_kind', 'message_type'],
  title: ['title', 'subject', 'summary', 'heading', 'headline'],
  body: [
    'body',
    'message',
    'message_body',
    'text',
    'content',
    'description',
    'details',
    'note',
    'notes',
    'comment',
    'comments',
    'email',
    'entry',
  ],
  action: ['action', 'action_label', 'action_taken', 'step'],
  actionKey: ['action_key', 'actionkey', 'action_id'],
  customerEffort: ['customer_effort', 'customer_effort_level', 'effort'],
  destructive: ['destructive', 'is_destructive'],
  durationMinutes: ['duration_minutes', 'duration_min', 'duration', 'minutes'],
  inResponseTo: [
    'in_response_to',
    'in_reply_to',
    'reply_to',
    'responds_to',
    'response_to',
    'parent',
    'parent_id',
  ],
  id: ['id', 'event_id', 'row_id', 'message_id'],
  channel: ['channel', 'medium', 'via'],
  correlationIds: ['correlation_ids', 'correlation_id', 'correlation'],
};

const FIELD_BY_ALIAS = new Map<string, CsvField>(
  (Object.entries(CSV_ALIASES) as [CsvField, readonly string[]][]).flatMap(([field, names]) =>
    names.map((name) => [name, field] as const),
  ),
);

/** `Sent At`, `sentAt`, `SENT-AT` and `sent_at` all become `sent_at`. */
export function normaliseHeader(header: string): string {
  return header
    .slice(0, 200)
    .replace(/^\uFEFF/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 60);
}

export interface ColumnMapping {
  /** Zero-based column index per field. */
  columns: Partial<Record<CsvField, number>>;
  /** Headers that map to a field that is already taken (first column wins). */
  conflicts: { header: string; field: CsvField; index: number }[];
  /** Headers with no meaning for the case bundle. */
  ignored: { header: string; index: number }[];
}

/** Maps headers to fields through the built-in aliases and the caller's explicit overrides. */
export function mapColumns(
  headers: readonly string[],
  overrides: Readonly<Record<string, CsvField>> | undefined,
): ColumnMapping {
  const explicit = new Map<string, CsvField>();
  for (const [header, field] of Object.entries(overrides ?? {})) {
    explicit.set(normaliseHeader(header), field);
  }
  const columns: ColumnMapping['columns'] = {};
  const conflicts: ColumnMapping['conflicts'] = [];
  const ignored: ColumnMapping['ignored'] = [];
  headers.forEach((header, index) => {
    const key = normaliseHeader(header);
    const field = explicit.get(key) ?? FIELD_BY_ALIAS.get(key);
    if (!field) {
      if (key.length > 0) ignored.push({ header, index });
      return;
    }
    if (columns[field] !== undefined) conflicts.push({ header, field, index });
    else columns[field] = index;
  });
  return { columns, conflicts, ignored };
}
