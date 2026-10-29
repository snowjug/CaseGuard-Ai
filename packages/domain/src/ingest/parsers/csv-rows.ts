import { ChannelSchema, EVENT_TYPES, IdSchema, type Channel } from '@caseguard/schemas';
import type { ColumnMapping } from './csv-columns';
import { CellReader, quoted, readAction, ROLE_HINT, roleFromCell } from './csv-cells';
import type { CsvRecord } from './csv-tokenizer';
import type { DraftEvent } from './draft-types';
import { eventTypeFromText, inferEventType } from './event-types';
import type { ResolvedOptions } from './options';
import { inferRole, splitSpeakerLabel, type RoleInference } from './roles';
import type { SpeakerBook } from './speakers';
import type { WarningCollector } from './text';
import {
  inferDateOrder,
  isoDate,
  parseEpoch,
  resolveMoment,
  scanWholeValue,
  type ScannedMoment,
} from './timestamps';
import type { CsvField, ParseIssue, TimestampBasis } from './types';

const TIMESTAMP_HINT =
  'Use a full date and time such as 2026-03-09 09:12 UTC or 2026-03-09T09:12:00Z (a numeric epoch in seconds also works).';

export interface RowsInput {
  /** Data records only (the header is removed). */
  records: readonly CsvRecord[];
  headers: readonly string[];
  mapping: ColumnMapping;
  options: ResolvedOptions;
  book: SpeakerBook;
  warnings: WarningCollector;
}

export interface RowsOutput {
  events: DraftEvent[];
  errors: ParseIssue[];
  skippedRows: number;
  nonBlankRows: number;
}

interface Row {
  record: CsvRecord;
  /** Spreadsheet row number: the header is row 1. */
  row: number;
  /** Position among data records, used to keep equal timestamps in file order. */
  k: number;
  stampText: string;
  epochMs: number | null;
  scanned: ScannedMoment | null;
}

/** Converts data records into draft events, collecting every row problem instead of stopping at the first. */
export function buildCsvEvents(input: RowsInput): RowsOutput {
  const { records, headers, mapping, options, book, warnings } = input;
  const { columns } = mapping;
  const reader = new CellReader(columns, headers, options.limits.maxErrors);
  const stampField: CsvField =
    columns.timestamp !== undefined ? 'timestamp' : columns.date === undefined ? 'time' : 'date';

  const stampText = (record: CsvRecord, row: number): string => {
    if (columns.timestamp !== undefined) return reader.read(record, 'timestamp', row);
    if (columns.date !== undefined && columns.time !== undefined) {
      return [reader.read(record, 'date', row), reader.read(record, 'time', row)]
        .filter(Boolean)
        .join(' ');
    }
    return reader.read(record, columns.date === undefined ? 'time' : 'date', row);
  };

  let skippedRows = 0;
  const rows: Row[] = [];
  records.forEach((record, k) => {
    if (record.fields.every((f) => f.trim().length === 0)) {
      skippedRows += 1;
      return;
    }
    const row = k + 2;
    const text = stampText(record, row);
    const epochMs = parseEpoch(text);
    rows.push({
      record,
      row,
      k,
      stampText: text,
      epochMs,
      scanned: epochMs === null && text ? scanWholeValue(text) : null,
    });
  });

  // A day/month order that the data itself reveals applies to every row.
  const order =
    options.dateOrder ??
    inferDateOrder(rows.flatMap((r) => (r.scanned?.ambiguous ? [r.scanned.ambiguous] : [])));

  const events: DraftEvent[] = [];
  const explicitIds = new Map<string, string>();
  const refByRow = new Map<number, string>();
  const replies: { event: DraftEvent; value: string; row: number; record: CsvRecord }[] = [];
  const zones = new Map<string, number>();
  let assumedDateWarned = false;

  for (const item of rows) {
    const { record, row } = item;
    if (record.fields.length > headers.length) {
      reader.fail(
        record,
        row,
        '(row)',
        `the row has ${record.fields.length} fields but the header has ${headers.length}.`,
        'Put text that contains the delimiter inside double quotes, for example "a, b".',
        `${record.fields.length} fields`,
      );
      continue;
    }

    let ms: number | null = null;
    let basis: TimestampBasis = 'explicit';
    let zoneAssumed = false;
    if (item.epochMs !== null) {
      ms = item.epochMs;
    } else if (!item.scanned?.time) {
      reader.fail(
        record,
        row,
        stampField,
        item.stampText.length === 0
          ? 'the timestamp is empty.'
          : 'the timestamp is not a recognised date and time.',
        TIMESTAMP_HINT,
        item.stampText.length === 0 ? '(empty)' : quoted(item.stampText),
      );
    } else {
      const scanned = item.scanned;
      if (scanned.unrecognisedZone) {
        zones.set(scanned.unrecognisedZone, (zones.get(scanned.unrecognisedZone) ?? 0) + 1);
      }
      const resolved = resolveMoment(scanned, {
        currentDate: options.defaultDate ?? isoDate(options.nowMs),
        assumedOffsetMinutes: options.assumedOffsetMinutes,
        dateOrder: order,
      });
      if (!resolved.ok) {
        reader.fail(
          record,
          row,
          stampField,
          `the timestamp cannot be used: ${resolved.detail}.`,
          resolved.reason === 'ambiguous_date'
            ? 'Write dates as YYYY-MM-DD, or pass dateOrder ("dmy" or "mdy").'
            : TIMESTAMP_HINT,
          quoted(item.stampText),
        );
      } else {
        ms = resolved.value.ms;
        zoneAssumed = resolved.value.assumedZone;
        if (scanned.date === null && scanned.ambiguous === null) {
          basis = 'date_assumed';
          if (!assumedDateWarned) {
            assumedDateWarned = true;
            warnings.add(
              'date_assumed',
              options.defaultDate ? 'info' : 'warning',
              options.defaultDate
                ? 'Some timestamps carry only a time of day; defaultDate was used for the date.'
                : 'Some timestamps carry only a time of day and no date was supplied; the ingestion date was used.',
              { hint: 'Add a Date column or pass defaultDate.', row },
            );
          }
        }
      }
    }

    const participantText = reader.read(record, 'participant', row);
    const roleText = reader.read(record, 'role', row);
    const label = splitSpeakerLabel(participantText || roleText || 'unnamed');
    let inference: RoleInference | null = null;
    if (roleText) {
      const role = roleFromCell(roleText);
      if (role) inference = { role, basis: 'column', ambiguous: false };
      else {
        reader.fail(
          record,
          row,
          'role',
          `${quoted(roleText)} is not a recognised role.`,
          ROLE_HINT,
          quoted(roleText),
        );
      }
    } else {
      inference = inferRole(label, options.speakerRoles);
    }

    const typeText = reader.read(record, 'type', row);
    const explicitType = typeText ? eventTypeFromText(typeText) : null;
    if (typeText && !explicitType) {
      reader.fail(
        record,
        row,
        'type',
        `${quoted(typeText)} is not a recognised event type.`,
        `Use one of: ${EVENT_TYPES.join(', ')}.`,
        quoted(typeText),
      );
    }

    const title = reader.read(record, 'title', row);
    const body = reader.read(record, 'body', row);
    if (title.length > 200) {
      reader.fail(
        record,
        row,
        'title',
        `the title has ${title.length} characters; the limit is 200.`,
        'Shorten the title.',
        `${title.length} characters`,
      );
    }
    if (body.length > options.limits.maxBodyChars) {
      reader.fail(
        record,
        row,
        'body',
        `the text has ${body.length} characters; the limit is ${options.limits.maxBodyChars}.`,
        'Shorten the text or split it over several rows.',
        `${body.length} characters`,
      );
    }
    if (body.length === 0 && title.length === 0) {
      reader.fail(
        record,
        row,
        columns.body === undefined ? 'title' : 'body',
        'the row has no text.',
        'Give every row a Body (or at least a Title), or delete the row.',
        '(empty)',
      );
    }

    let channel: Channel | null = null;
    const channelText = reader.read(record, 'channel', row).toLowerCase();
    if (channelText) {
      const parsed = ChannelSchema.safeParse(channelText);
      if (parsed.success) channel = parsed.data;
      else {
        reader.fail(
          record,
          row,
          'channel',
          `${quoted(channelText)} is not a recognised channel.`,
          `Use one of: ${ChannelSchema.options.join(', ')}.`,
          quoted(channelText),
        );
      }
    }

    const action = readAction(reader, record, row);

    let explicitId: string | null = null;
    const idText = reader.read(record, 'id', row);
    if (idText) {
      if (!IdSchema.safeParse(idText).success) {
        reader.fail(
          record,
          row,
          'id',
          'the id is not valid.',
          'Ids may contain letters, digits, underscore, dot, colon and dash, and must start with a letter or digit.',
          quoted(idText),
        );
      } else if (explicitIds.has(idText)) {
        reader.fail(
          record,
          row,
          'id',
          `the id ${quoted(idText)} is already used by an earlier row.`,
          'Give every row a unique id.',
          quoted(idText),
        );
      } else {
        explicitId = idText;
      }
    }

    const correlation = reader
      .read(record, 'correlationIds', row)
      .split(/[;|]/)
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    if (correlation.length > 20 || correlation.some((c) => c.length > 80)) {
      reader.fail(
        record,
        row,
        'correlationIds',
        'at most 20 correlation ids of up to 80 characters each are allowed.',
        'Shorten or remove some.',
        `${correlation.length} ids`,
      );
    }

    if (ms === null || inference === null) continue;
    const speaker = book.register(label, inference, row, warnings);
    const decision = explicitType
      ? { type: explicitType, basis: 'column' as const }
      : inferEventType({
          role: speaker.role,
          roleKnown: !speaker.unidentified,
          qualifier: label.qualifier,
          body: body || title,
          isEmailBlock: false,
        });
    const event: DraftEvent = {
      ref: `r${row}`,
      order: item.k,
      at: row,
      timestampMs: ms,
      timestampBasis: basis,
      zoneAssumed,
      speakerKey: speaker.key,
      type: decision.type,
      typeBasis: decision.basis,
      title: title || null,
      body,
      channel,
      action,
      inResponseTo: null,
      inResponseToBasis: null,
      correlationIds: correlation.slice(0, 20),
      explicitId,
    };
    events.push(event);
    refByRow.set(row, event.ref);
    if (explicitId) explicitIds.set(explicitId, event.ref);
    const reply = reader.read(record, 'inResponseTo', row);
    if (reply) replies.push({ event, value: reply, row, record });
  }

  for (const { event, value, row, record } of replies) {
    const target =
      explicitIds.get(value) ??
      (columns.id === undefined && /^\d{1,6}$/.test(value)
        ? refByRow.get(Number(value))
        : undefined);
    if (!target || target === event.ref) {
      reader.fail(
        record,
        row,
        'inResponseTo',
        target ? 'a row cannot answer itself.' : `${quoted(value)} does not match any event.`,
        columns.id === undefined
          ? 'Refer to another row by its spreadsheet row number, or add an Id column.'
          : 'Use the Id of another row in this file.',
        quoted(value),
      );
    } else {
      event.inResponseTo = target;
      event.inResponseToBasis = 'column';
    }
  }

  reportCsvWarnings(reader, zones, warnings);
  return { events, errors: reader.errors, skippedRows, nonBlankRows: rows.length };
}

function reportCsvWarnings(
  reader: CellReader,
  zones: ReadonlyMap<string, number>,
  warnings: WarningCollector,
): void {
  for (const [column, { count, row }] of reader.formulas) {
    warnings.add(
      'csv_formula_neutralised',
      'warning',
      `${count} cell(s) in column "${column}" start with =, +, - or @ (or a tab or carriage return), which spreadsheets run as formulas; a ' was added in front of each (first at row ${row}).`,
      {
        hint: 'Review these cells; legitimate text that starts with "-" now starts with a quote.',
        row,
        column,
        count,
      },
    );
  }
  for (const [zone, count] of zones) {
    warnings.add(
      'timezone_unrecognised',
      'warning',
      `The time zone "${zone}" is ambiguous and was not interpreted (${count} timestamp(s)); the assumed offset was used instead.`,
      { hint: 'Write the offset instead, for example +02:00 or -05:00.', count },
    );
  }
  if (reader.hiddenErrors > 0) {
    reader.errors.push({
      code: 'errors_truncated',
      path: '(file)',
      message: `${reader.hiddenErrors} more row problem(s) are not listed.`,
      hint: 'Fix the problems above and import again to see the rest.',
      received: null,
    });
  }
}
