export type CsvDelimiter = ',' | ';' | '\t';

export interface CsvRecord {
  fields: string[];
  /** 1-based physical line where the record starts. */
  line: number;
}

export interface CsvLimits {
  maxRecords: number;
  maxFields: number;
  maxFieldChars: number;
}

export type CsvFailure =
  | { code: 'csv_unterminated_quote'; line: number; record: number; column: number }
  | { code: 'csv_too_many_rows'; line: number; record: number; column: number }
  | { code: 'csv_too_many_columns'; line: number; record: number; column: number }
  | { code: 'csv_field_too_long'; line: number; record: number; column: number };

export type CsvTokens =
  | { ok: true; records: CsvRecord[]; strayQuoteLines: number[] }
  | { ok: false; failure: CsvFailure };

/**
 * RFC 4180 tokenizer: quoted fields, doubled quotes, embedded newlines, and CRLF, LF or CR record
 * terminators. A quote in the middle of a field is kept literally (and reported) instead of
 * failing the whole file. Limits are enforced while scanning, so hostile input stops early.
 */
export function tokenizeCsv(text: string, delimiter: CsvDelimiter, limits: CsvLimits): CsvTokens {
  const records: CsvRecord[] = [];
  const strayQuoteLines: number[] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let quotedField = false;
  let line = 1;
  let recordLine = 1;
  let quoteLine = 1;
  const n = text.length;

  const fail = (code: CsvFailure['code'], at: number): CsvTokens => ({
    ok: false,
    failure: { code, line: at, record: records.length + 1, column: fields.length + 1 },
  });

  for (let i = 0; i < n; i++) {
    const ch = text.charAt(i);
    if (inQuotes) {
      if (ch === '"') {
        if (text.charAt(i + 1) === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n' || (ch === '\r' && text.charAt(i + 1) !== '\n')) line += 1;
        field += ch;
      }
      if (field.length > limits.maxFieldChars) return fail('csv_field_too_long', recordLine);
      continue;
    }
    if (ch === '"') {
      if (field.length === 0 && !quotedField) {
        inQuotes = true;
        quotedField = true;
        quoteLine = line;
      } else {
        field += '"';
        strayQuoteLines.push(line);
      }
      continue;
    }
    if (ch === delimiter) {
      if (fields.length + 1 >= limits.maxFields) return fail('csv_too_many_columns', recordLine);
      fields.push(field);
      field = '';
      quotedField = false;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text.charAt(i + 1) === '\n') i += 1;
      fields.push(field);
      records.push({ fields, line: recordLine });
      if (records.length > limits.maxRecords) return fail('csv_too_many_rows', recordLine);
      fields = [];
      field = '';
      quotedField = false;
      line += 1;
      recordLine = line;
      continue;
    }
    field += ch;
    if (field.length > limits.maxFieldChars) return fail('csv_field_too_long', recordLine);
  }

  if (inQuotes) return fail('csv_unterminated_quote', quoteLine);
  if (field.length > 0 || fields.length > 0 || quotedField) {
    fields.push(field);
    records.push({ fields, line: recordLine });
    if (records.length > limits.maxRecords) return fail('csv_too_many_rows', recordLine);
  }
  return { ok: true, records, strayQuoteLines };
}

const SNIFF_CHARS = 8_192;
const SNIFF_RECORDS = 10;
const CANDIDATES: readonly CsvDelimiter[] = [',', ';', '\t'];

/** Counts fields per record outside quotes for the first few records of the text. */
function sampleCounts(head: string, delimiter: CsvDelimiter): number[] {
  const counts: number[] = [];
  let count = 1;
  let inQuotes = false;
  let touched = false;
  for (let i = 0; i < head.length && counts.length < SNIFF_RECORDS; i++) {
    const ch = head.charAt(i);
    if (ch === '"') {
      inQuotes = !inQuotes;
      touched = true;
    } else if (inQuotes) {
      continue;
    } else if (ch === delimiter) {
      count += 1;
      touched = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && head.charAt(i + 1) === '\n') i += 1;
      if (touched) counts.push(count);
      count = 1;
      touched = false;
    } else {
      touched = true;
    }
  }
  return counts;
}

/** Picks the delimiter whose column count is largest and most consistent over the first records. */
export function sniffDelimiter(text: string): CsvDelimiter {
  const head = text.slice(0, SNIFF_CHARS);
  let best: CsvDelimiter = ',';
  let bestScore = 0;
  for (const candidate of CANDIDATES) {
    const counts = sampleCounts(head, candidate);
    const header = counts[0] ?? 1;
    if (header < 2) continue;
    const consistent = counts.filter((c) => c === header).length;
    const score = consistent * 1000 + header;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}
