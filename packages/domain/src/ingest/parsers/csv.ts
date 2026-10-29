import { CUSTOMER_SIDE_ROLES } from '@caseguard/schemas';
import { CSV_ALIASES, mapColumns } from './csv-columns';
import { buildCsvEvents } from './csv-rows';
import { sniffDelimiter, tokenizeCsv, type CsvDelimiter, type CsvFailure } from './csv-tokenizer';
import { assembleDraft } from './draft';
import { emptyStats } from './draft-types';
import { IngestParseError } from './errors';
import { resolveDraftOptions } from './options';
import { SpeakerBook } from './speakers';
import {
  displayValue,
  exceedsBytes,
  reportSanitization,
  sanitizeText,
  utf8Bytes,
  WarningCollector,
} from './text';
import { deriveTitle, extractResolution, findStatusEvent } from './transcript-meta';
import type { CsvOptions, DraftFailure, ParseIssue, ParseIssueCode, ParseResult } from './types';

const DELIMITER_NAMES: Record<CsvDelimiter, string> = {
  ',': 'comma',
  ';': 'semicolon',
  '\t': 'tab',
};
const CSV_FIELDS: ReadonlySet<string> = new Set(Object.keys(CSV_ALIASES));

export const CSV_FORMAT_HINT =
  'The first row must be a header with at least a timestamp column (Timestamp, Time or Date), a participant column (Participant, Author or From) and a text column (Body, Message or Text).';

function describeFailure(
  failure: CsvFailure,
  maxRows: number,
  maxColumns: number,
  maxChars: number,
) {
  const where = `row ${failure.record}, column ${failure.column}`;
  switch (failure.code) {
    case 'csv_unterminated_quote':
      return {
        path: `line ${failure.line}`,
        message: `A quoted field that starts on line ${failure.line} is never closed.`,
        hint: 'Add the missing closing double quote, or write a double quote inside text as two ("").',
      };
    case 'csv_too_many_rows':
      return {
        path: `row ${failure.record}`,
        message: `The file has more than ${maxRows} data rows.`,
        hint: 'Split the file into smaller files or remove rows that are not part of the case.',
      };
    case 'csv_too_many_columns':
      return {
        path: where,
        message: `Row ${failure.record} has more than ${maxColumns} columns.`,
        hint: 'Remove unused columns, and check that text containing the delimiter is quoted.',
      };
    case 'csv_field_too_long':
      return {
        path: where,
        message: `Row ${failure.record}, column ${failure.column}: the cell is longer than ${maxChars} characters.`,
        hint: 'Shorten the text. A missing closing double quote earlier in the file can also swallow the rows that follow.',
      };
  }
}

/**
 * Converts a CSV export of case events into a draft case bundle. RFC 4180 compliant (quotes,
 * escaped quotes, embedded newlines, CRLF, BOM), with delimiter sniffing for comma, semicolon and
 * tab. Cells that spreadsheets would execute as formulas are neutralised and reported. Every row
 * problem is collected with its row number and column so the file can be fixed in one pass.
 *
 * @throws IngestParseError only when the *options* are invalid. Bad input never throws.
 */
export function parseCsvEvents(csv: string, options: CsvOptions): ParseResult {
  const opts = resolveDraftOptions(options);
  if (options.delimiter !== undefined && !Object.hasOwn(DELIMITER_NAMES, options.delimiter)) {
    throw new IngestParseError('invalid_options', 'Option "delimiter" must be ",", ";" or a tab.');
  }
  for (const [header, field] of Object.entries(options.columnMap ?? {})) {
    if (!CSV_FIELDS.has(field)) {
      throw new IngestParseError(
        'invalid_options',
        `Option "columnMap" maps "${header}" to the unknown field "${String(field)}".`,
      );
    }
  }
  const { limits } = opts;
  const warnings = new WarningCollector(limits.maxWarnings);
  const counts = {
    inputChars: typeof csv === 'string' ? csv.length : 0,
    inputBytes: 0,
    lines: 0,
  };
  const failWith = (issues: ParseIssue[]): DraftFailure => ({
    ok: false,
    source: 'csv',
    errors: issues,
    warnings: warnings.toArray(),
    stats: emptyStats(counts),
  });
  const fail = (
    code: ParseIssueCode,
    message: string,
    hint: string,
    received: string | null = null,
    path = '(file)',
  ): DraftFailure => failWith([{ code, path, message, hint, received }]);

  if (typeof csv !== 'string') {
    return fail('input_not_text', 'The CSV content is missing or is not text.', CSV_FORMAT_HINT);
  }
  if (exceedsBytes(csv, limits.maxPayloadBytes)) {
    return fail(
      'input_too_large',
      `The file is larger than ${limits.maxPayloadBytes} bytes.`,
      'Split the file or remove rows that are not part of the case.',
      `${utf8Bytes(csv)} bytes`,
    );
  }
  counts.inputBytes = utf8Bytes(csv);
  const sanitized = sanitizeText(csv, { keepCarriageReturns: true });
  reportSanitization(sanitized, warnings);
  if (sanitized.text.trim().length === 0) {
    return fail('input_empty', 'The file is empty.', CSV_FORMAT_HINT);
  }
  const text = sanitized.text;
  counts.lines = (text.match(/\n/g) ?? []).length + 1;

  const delimiter = options.delimiter ?? sniffDelimiter(text);
  if (options.delimiter === undefined && delimiter !== ',') {
    warnings.add(
      'csv_delimiter_detected',
      'info',
      `The ${DELIMITER_NAMES[delimiter]} was detected as the column delimiter.`,
    );
  }

  const tokens = tokenizeCsv(text, delimiter, {
    maxRecords: limits.maxCsvRows + 1,
    maxFields: limits.maxCsvColumns,
    maxFieldChars: limits.maxCsvFieldChars,
  });
  if (!tokens.ok) {
    const { failure } = tokens;
    const described = describeFailure(
      failure,
      limits.maxCsvRows,
      limits.maxCsvColumns,
      limits.maxCsvFieldChars,
    );
    return failWith([
      {
        code: failure.code,
        ...described,
        received: null,
        line: failure.line,
        row: failure.record,
        column: String(failure.column),
      },
    ]);
  }
  if (tokens.strayQuoteLines.length > 0) {
    warnings.add(
      'csv_stray_quote',
      'warning',
      `${tokens.strayQuoteLines.length} double quote(s) inside unquoted text were kept as they are (first at line ${tokens.strayQuoteLines[0]}).`,
      {
        hint: 'Wrap text that contains double quotes in quotes and double each inner quote.',
        count: tokens.strayQuoteLines.length,
        line: tokens.strayQuoteLines[0],
      },
    );
  }

  const headerRecord = tokens.records[0];
  if (!headerRecord || headerRecord.fields.every((f) => f.trim().length === 0)) {
    return fail('csv_no_header', 'The file has no header row.', CSV_FORMAT_HINT);
  }
  const headers = headerRecord.fields.map((f) => f.trim());
  const mapping = mapColumns(headers, options.columnMap);
  const { columns } = mapping;
  const redundant: string[] = [];
  if (columns.timestamp !== undefined) {
    for (const field of ['date', 'time'] as const) {
      const index = columns[field];
      if (index !== undefined) {
        redundant.push(displayValue(headers[index] ?? field, 30));
        delete columns[field];
      }
    }
  }

  const missing: string[] = [];
  if (columns.timestamp === undefined && columns.date === undefined && columns.time === undefined) {
    missing.push('a timestamp column (Timestamp, Time or Date)');
  }
  if (columns.participant === undefined && columns.role === undefined) {
    missing.push('a participant column (Participant, Author or From)');
  }
  if (columns.body === undefined && columns.title === undefined) {
    missing.push('a text column (Body, Message or Text)');
  }
  if (missing.length > 0) {
    return failWith([
      {
        code: 'csv_missing_column',
        path: 'row 1',
        message: `The header row is missing ${missing.join(', ')}.`,
        hint: `Rename or add the column(s). Accepted names include: timestamp, time, date; participant, author, from, speaker; body, message, text, title, subject.`,
        received: displayValue(headers.join(' | '), 120),
        row: 1,
        line: headerRecord.line,
      },
    ]);
  }

  for (const conflict of mapping.conflicts) {
    warnings.add(
      'csv_column_conflict',
      'warning',
      `Column "${displayValue(conflict.header, 30)}" also means ${conflict.field}; the first matching column is used and this one is ignored.`,
      { hint: 'Rename or remove one of the columns, or pass columnMap.', row: 1 },
    );
  }
  const ignoredNames = [...redundant, ...mapping.ignored.map((i) => displayValue(i.header, 30))];
  if (ignoredNames.length > 0) {
    warnings.add(
      'csv_column_ignored',
      'info',
      `${ignoredNames.length} column(s) have no meaning for a case bundle and were ignored: ${ignoredNames
        .slice(0, 8)
        .map((n) => `"${n}"`)
        .join(', ')}${ignoredNames.length > 8 ? ', …' : ''}.`,
      { count: ignoredNames.length, row: 1 },
    );
  }

  const data = tokens.records.slice(1);
  const book = new SpeakerBook(limits.maxParticipants);
  const built = buildCsvEvents({ records: data, headers, mapping, options: opts, book, warnings });
  if (built.errors.length > 0) return failWith(built.errors);
  if (built.events.length === 0) {
    return fail('csv_no_rows', 'The file has a header but no data rows.', CSV_FORMAT_HINT);
  }
  if (built.skippedRows > 0) {
    warnings.add(
      'csv_blank_rows_skipped',
      'info',
      `${built.skippedRows} blank row(s) were skipped.`,
      { count: built.skippedRows },
    );
  }

  const isCustomerSide = (key: string): boolean => {
    const speaker = book.speakers.get(key);
    return !!speaker && !speaker.unidentified && CUSTOMER_SIDE_ROLES.includes(speaker.role);
  };
  return assembleDraft({
    source: 'csv',
    options: opts,
    speakers: book.speakers,
    events: built.events,
    warnings,
    stats: {
      inputChars: counts.inputChars,
      inputBytes: counts.inputBytes,
      lines: counts.lines,
      ignoredLines: 0,
      skippedRows: built.skippedRows,
    },
    nonBlankLines: built.nonBlankRows,
    header: {},
    derivedTitle: deriveTitle(built.events, isCustomerSide),
    tag: 'csv-import',
    referenceSeed: text,
    resolution: extractResolution(built.events, warnings),
    statusEvent: findStatusEvent(built.events),
    mergedSpeakers: book.merged,
    truncatedBodies: 0,
  });
}
