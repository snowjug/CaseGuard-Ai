import {
  EFFORT_LEVELS,
  PARTICIPANT_ROLES,
  type EffortLevel,
  type ParticipantRole,
} from '@caseguard/schemas';
import type { ColumnMapping } from './csv-columns';
import type { CsvRecord } from './csv-tokenizer';
import type { DraftAction } from './draft-types';
import { inferRole, splitSpeakerLabel } from './roles';
import { displayValue } from './text';
import type { CsvField, ParseIssue } from './types';

/** Cells starting with these characters are executed as formulas by spreadsheet programs. */
const FORMULA_START = /^[=+\-@\t\r]/;
const EFFORT_SET: ReadonlySet<string> = new Set(EFFORT_LEVELS);
const ROLE_SET: ReadonlySet<string> = new Set(PARTICIPANT_ROLES);

export const quoted = (value: string, max = 40): string => JSON.stringify(displayValue(value, max));

/**
 * Reads cells of one CSV file: neutralises formula-injection payloads (and remembers where they
 * were, for a warning) and records row problems with their row number and column name.
 */
export class CellReader {
  readonly errors: ParseIssue[] = [];
  hiddenErrors = 0;
  readonly formulas = new Map<string, { count: number; row: number }>();

  constructor(
    private readonly columns: ColumnMapping['columns'],
    private readonly headers: readonly string[],
    private readonly maxErrors: number,
  ) {}

  header(field: CsvField | '(row)'): string {
    if (field === '(row)') return '(row)';
    const index = this.columns[field];
    return displayValue(index === undefined ? field : (this.headers[index] ?? field), 40);
  }

  /**
   * Cell text with embedded newlines normalised and trimmed. A cell that starts with a formula
   * character, before or after trimming, gets a leading `'` so it is stored as plain text.
   */
  read(record: CsvRecord, field: CsvField, row: number): string {
    const index = this.columns[field];
    const raw = index === undefined ? '' : (record.fields[index] ?? '');
    if (raw.length === 0) return '';
    const trimmed = raw.replace(/\r\n?/g, '\n').trim();
    if (trimmed.length === 0) return '';
    if (!FORMULA_START.test(raw) && !FORMULA_START.test(trimmed)) return trimmed;
    const column = this.header(field);
    const seen = this.formulas.get(column);
    if (seen) seen.count += 1;
    else this.formulas.set(column, { count: 1, row });
    return `'${trimmed}`;
  }

  fail(
    record: CsvRecord,
    row: number,
    field: CsvField | '(row)',
    message: string,
    hint: string,
    received: string | null,
  ): void {
    if (this.errors.length >= this.maxErrors) {
      this.hiddenErrors += 1;
      return;
    }
    const column = this.header(field);
    this.errors.push({
      code: 'csv_row_invalid',
      path: `row ${row}, column "${column}"`,
      message: `Row ${row}, column "${column}": ${message}`,
      hint,
      received,
      line: record.line,
      row,
      column,
    });
  }
}

export function roleFromCell(value: string): ParticipantRole | null {
  const key = value
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, '_');
  if (ROLE_SET.has(key)) return key as ParticipantRole;
  const inferred = inferRole(splitSpeakerLabel(value));
  return inferred.basis === 'unknown' ? null : inferred.role;
}

export const ROLE_HINT = `Use one of: ${PARTICIPANT_ROLES.join(', ')}.`;

/** Reads the optional action columns; any invalid cell is reported against its own column. */
export function readAction(reader: CellReader, record: CsvRecord, row: number): DraftAction | null {
  const label = reader.read(record, 'action', row);
  const key = reader.read(record, 'actionKey', row);
  const text = label || key;
  if (!text) return null;
  if (text.length > 200) {
    reader.fail(
      record,
      row,
      'action',
      `the action label has ${text.length} characters; the limit is 200.`,
      'Shorten the label.',
      `${text.length} characters`,
    );
  }
  const action: DraftAction = { label: text };
  if (key) action.actionKey = key;

  const effort = reader
    .read(record, 'customerEffort', row)
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (effort) {
    if (EFFORT_SET.has(effort)) action.customerEffort = effort as EffortLevel;
    else {
      reader.fail(
        record,
        row,
        'customerEffort',
        `${quoted(effort, 30)} is not a recognised effort level.`,
        `Use one of: ${EFFORT_LEVELS.join(', ')}.`,
        quoted(effort, 30),
      );
    }
  }
  const destructive = reader.read(record, 'destructive', row).toLowerCase();
  if (destructive) {
    if (/^(?:true|yes|y|1)$/.test(destructive)) action.destructive = true;
    else if (/^(?:false|no|n|0)$/.test(destructive)) action.destructive = false;
    else {
      reader.fail(
        record,
        row,
        'destructive',
        `${quoted(destructive, 30)} is not true or false.`,
        'Use true or false (yes and no also work).',
        quoted(destructive, 30),
      );
    }
  }
  const duration = reader.read(record, 'durationMinutes', row);
  if (duration) {
    const minutes = Number(duration);
    if (Number.isFinite(minutes) && minutes >= 0 && minutes <= 20_160) {
      action.durationMinutes = minutes;
    } else {
      reader.fail(
        record,
        row,
        'durationMinutes',
        `${quoted(duration, 30)} is not a number of minutes between 0 and 20160.`,
        'Use a plain number such as 15.',
        quoted(duration, 30),
      );
    }
  }
  return action;
}
