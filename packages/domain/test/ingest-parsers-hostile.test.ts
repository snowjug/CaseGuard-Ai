import { describe, expect, it } from 'vitest';
import {
  IngestParseError,
  parseCsvEvents,
  parsePastedTranscript,
  type IngestDraftOptions,
} from '../src/ingest/parsers';
import { BASE, codes, expectFailure, expectOk, expectValidDraft } from './ingest-parsers.helpers';

const csv = (text: string, extra: Partial<IngestDraftOptions> & { delimiter?: ',' } = {}) =>
  parseCsvEvents(text, { ...BASE, workload: 'teams-authentication', ...extra });
const chat = (text: string, extra: Partial<IngestDraftOptions> = {}) =>
  parsePastedTranscript(text, { ...BASE, ...extra });

const HEADER = 'Timestamp,Author,Subject,Body,Action';
const row = (body: string, subject = 'S', action = '') =>
  `2026-03-09T09:00:00Z,Contoso admin,${subject},${body},${action}`;

/** Runs `fn`, returns its result and how long it took, so hostile inputs are proven to be bounded. */
function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}
const BUDGET_MS = 3_000;

describe('CSV formula injection', () => {
  const payloads: { name: string; cell: string }[] = [
    { name: 'equals', cell: '"=1+1"' },
    { name: 'plus', cell: '"+1+1"' },
    { name: 'minus', cell: '"-2+3"' },
    { name: 'at sign', cell: '"@SUM(A1:A9)"' },
    { name: 'leading tab', cell: '"\t=1+1"' },
    { name: 'leading carriage return', cell: '"\r=1+1"' },
    { name: 'leading space before equals', cell: '" =1+1"' },
    { name: 'hyperlink payload', cell: '"=HYPERLINK(""http://example.invalid/x"",""click"")"' },
  ];

  it.each(payloads)('[NFR-SEC-05] neutralises and reports a $name cell', ({ cell }) => {
    const text = [HEADER, row(cell, cell, cell)].join('\n');
    const draft = expectOk(csv(text));
    const event = draft.bundle.events[0];
    for (const value of [event?.body, event?.title, event?.action?.label]) {
      expect(value?.startsWith("'")).toBe(true);
    }
    const reported = draft.warnings.filter((w) => w.code === 'csv_formula_neutralised');
    expect(reported.map((w) => w.column).sort()).toEqual(['Action', 'Body', 'Subject']);
    expect(reported.every((w) => w.row === 2 && w.severity === 'warning' && w.count === 1)).toBe(
      true,
    );
  });

  it('[NFR-SEC-05] counts every affected cell per column and names the first row', () => {
    const text = [HEADER, row('=a'), row('+b'), row('plain'), row('@c')].join('\n');
    const warning = expectOk(csv(text)).warnings.find((w) => w.code === 'csv_formula_neutralised');
    expect(warning).toMatchObject({ column: 'Body', count: 3, row: 2 });
    expect(warning?.message).toContain('first at row 2');
  });

  it('[NFR-SEC-05] leaves ordinary text alone', () => {
    const draft = expectOk(csv([HEADER, row('plain text with = inside', 'a-b')].join('\n')));
    expect(draft.bundle.events[0]?.body).toBe('plain text with = inside');
    expect(codes(draft)).not.toContain('csv_formula_neutralised');
  });
});

describe('CSV limits and friendly errors', () => {
  it('[FR-ING-05] names row and column for an unreadable timestamp', () => {
    const failure = expectFailure(
      csv(
        'Timestamp,Author,Text\n2026-03-09T09:00:00Z,Contoso admin,ok\nyesterday at noon,Contoso admin,bad\n',
      ),
    );
    expect(failure.errors[0]).toMatchObject({
      code: 'csv_row_invalid',
      row: 3,
      column: 'Timestamp',
    });
    expect(failure.errors[0]?.message).toContain('Row 3, column "Timestamp"');
    expect(failure.errors[0]?.received).toBe('"yesterday at noon"');
    expect(failure.errors[0]?.hint).toContain('2026-03-09');
  });

  it('[FR-ING-05] names row and column for a text longer than the field limit', () => {
    const failure = expectFailure(csv([HEADER, row('x'.repeat(20_001))].join('\n')));
    expect(failure.errors[0]).toMatchObject({ code: 'csv_field_too_long', row: 2 });
    expect(failure.errors[0]?.message).toContain('longer than 20000 characters');
  });

  it('[FR-ING-05] rejects a cell above the per-field limit while scanning, not after reading the file', () => {
    const huge = `${HEADER}\n2026-03-09T09:00:00Z,Contoso admin,S,"${'x'.repeat(4_000_000)}"\n`;
    const { value, ms } = timed(() => csv(huge, { limits: { maxPayloadBytes: 8_000_000 } }));
    expect(expectFailure(value).errors[0]?.code).toBe('csv_field_too_long');
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('[FR-ING-05] rejects a title above 200 characters with its row and column', () => {
    const failure = expectFailure(csv([HEADER, row('ok', 'T'.repeat(201))].join('\n')));
    expect(failure.errors[0]).toMatchObject({ row: 2, column: 'Subject' });
  });

  it('[FR-ING-05] explains an unquoted delimiter that shifted the columns', () => {
    const failure = expectFailure(
      csv('Timestamp,Author,Text\n2026-03-09T09:00:00Z,Contoso admin,one, two\n'),
    );
    expect(failure.errors[0]?.message).toContain('4 fields but the header has 3');
    expect(failure.errors[0]?.hint).toContain('double quotes');
  });

  it('[FR-ING-05] points at the line where an unclosed quote starts', () => {
    const failure = expectFailure(
      csv('Timestamp,Author,Text\n2026-03-09T09:00:00Z,Contoso admin,"never closed\nmore\nlines\n'),
    );
    expect(failure.errors[0]).toMatchObject({ code: 'csv_unterminated_quote', line: 2 });
    expect(failure.errors[0]?.hint).toContain('closing double quote');
  });

  it('[FR-ING-05] enforces row, column and size limits with plain-language errors', () => {
    const rows = Array.from({ length: 10 }, (_, i) => `2026-03-09T09:0${i}:00Z,Contoso admin,hi`);
    const tooMany = expectFailure(
      csv(['Timestamp,Author,Text', ...rows].join('\n'), { limits: { maxCsvRows: 5 } }),
    );
    expect(tooMany.errors[0]).toMatchObject({ code: 'csv_too_many_rows' });
    expect(tooMany.errors[0]?.message).toContain('more than 5 data rows');

    const wide = `${Array.from({ length: 50 }, (_, i) => `c${i}`).join(',')}\n`;
    expect(expectFailure(csv(wide)).errors[0]?.code).toBe('csv_too_many_columns');

    const big = expectFailure(csv('Timestamp,Author,Text\n', { limits: { maxPayloadBytes: 10 } }));
    expect(big.errors[0]?.code).toBe('input_too_large');
  });

  it('[FR-ING-05] rejects an oversized payload without scanning it', () => {
    const { value, ms } = timed(() => csv('a,'.repeat(1_500_000)));
    expect(expectFailure(value).errors[0]).toMatchObject({ code: 'input_too_large' });
    expect(ms).toBeLessThan(500);
  });

  it('[FR-ING-02] stops listing after the error limit and says how many are left', () => {
    const rows = Array.from({ length: 8 }, () => 'not a time,Contoso admin,hi');
    const failure = expectFailure(
      csv(['Timestamp,Author,Text', ...rows].join('\n'), { limits: { maxErrors: 3 } }),
    );
    expect(failure.errors).toHaveLength(4);
    expect(failure.errors[3]).toMatchObject({ code: 'errors_truncated' });
    expect(failure.errors[3]?.message).toContain('5 more');
  });

  it('[FR-ING-02] lists what is missing from the header and which names are accepted', () => {
    const failure = expectFailure(csv('Foo,Bar\n1,2\n'));
    expect(failure.errors[0]).toMatchObject({ code: 'csv_missing_column', row: 1 });
    expect(failure.errors[0]?.message).toContain('timestamp column');
    expect(failure.errors[0]?.message).toContain('participant column');
    expect(failure.errors[0]?.message).toContain('text column');
    expect(failure.errors[0]?.received).toBe('Foo | Bar');
    expect(failure.errors[0]?.hint).toContain('timestamp, time, date');
  });

  it('[FR-ING-02] distinguishes empty input, a header without rows and non-text input', () => {
    expect(expectFailure(csv('')).errors[0]?.code).toBe('input_empty');
    expect(expectFailure(csv('\uFEFF  \n')).errors[0]?.code).toBe('input_empty');
    expect(expectFailure(csv('Timestamp,Author,Text\n')).errors[0]?.code).toBe('csv_no_rows');
    expect(expectFailure(csv(42 as unknown as string)).errors[0]?.code).toBe('input_not_text');
  });

  it('[FR-ING-02] rejects a role or type nobody can map, listing the allowed values', () => {
    const failure = expectFailure(
      csv('Timestamp,Author,Role,Type,Text\n2026-03-09T09:00:00Z,x,wizard,gossip,hi\n'),
    );
    expect(failure.errors.map((e) => e.column)).toEqual(['Role', 'Type']);
    expect(failure.errors[0]?.hint).toContain('customer_admin');
    expect(failure.errors[1]?.hint).toContain('customer_email');
  });

  it('[NFR-SEC-05] removes NUL, escape sequences and bidi overrides and reports each class', () => {
    const body = 'a\u0000b\u001b[31mred\u001b[0m \u202Eevil\u202C c';
    const draft = expectOk(csv([HEADER, row(`"${body}"`)].join('\n')));
    expect(draft.bundle.events[0]?.body).toBe('abred evil c');
    expect(codes(draft)).toEqual(
      expect.arrayContaining(['control_characters_removed', 'invisible_characters_removed']),
    );
  });
});

describe('transcript bounds and hostile input', () => {
  it('[FR-ING-05] rejects text above the paste limit before parsing it', () => {
    const { value, ms } = timed(() => chat('a'.repeat(300_000)));
    expect(expectFailure(value).errors[0]).toMatchObject({ code: 'input_too_large' });
    expect(ms).toBeLessThan(500);
  });

  it('[FR-ING-05] rejects too many lines and too many messages', () => {
    const lines = expectFailure(chat('x\n'.repeat(25_000)));
    expect(lines.errors[0]?.code).toBe('too_many_lines');
    const messages = Array.from(
      { length: 2_100 },
      (_, i) => `[2026-03-09 09:00:${String(i % 60).padStart(2, '0')} UTC] Customer: m${i}`,
    );
    const many = expectFailure(chat(messages.join('\n')));
    expect(many.errors[0]?.code).toBe('too_many_events');
  });

  it('[FR-ING-05] cuts an over-long message with an explicit marker and a warning', () => {
    const draft = expectOk(
      chat(`[2026-03-09 09:00 UTC] Support Engineer: ${'log line\n'.repeat(5_000)}`),
    );
    const body = draft.bundle.events[0]?.body ?? '';
    expect(body.length).toBeLessThanOrEqual(20_000);
    expect(body).toMatch(/\[… \d+ characters omitted by CaseGuard\]$/);
    expect(draft.warnings.find((w) => w.code === 'body_truncated')).toMatchObject({
      severity: 'warning',
      count: 1,
    });
    expectValidDraft(draft.bundle);
  });

  const pathological: { name: string; text: string }[] = [
    { name: 'brackets', text: '['.repeat(100_000) },
    { name: 'spaces then a colon', text: `${' '.repeat(100_000)}:` },
    { name: 'digits then a colon', text: `${'1'.repeat(150_000)}:` },
    { name: 'repeated half-timestamps', text: '09:'.repeat(60_000) },
    { name: 'repeated From: lines', text: 'From: a\n'.repeat(20_000) },
    {
      name: 'repeated attribution starts',
      text: `[2026-03-09 09:00 UTC] Customer: x\n${'On Monday '.repeat(15_000)}`,
    },
    { name: 'quote markers', text: `[2026-03-09 09:00 UTC] Customer: x\n${'> '.repeat(80_000)}` },
    { name: 'dashes and pipes', text: `[2026-03-09 09:00 UTC] ${'- | '.repeat(40_000)}: x` },
    {
      name: 'closing-word look-alikes',
      text: `[2026-03-09 09:00 UTC] Support Engineer: ${'Thanks '.repeat(25_000)}!`,
    },
    { name: 'code-fence toggling', text: '```\n'.repeat(30_000) },
    { name: 'long unicode', text: '\u{1F600}'.repeat(90_000) },
  ];

  it.each(pathological)('[NFR-SEC-05] stays linear on $name', ({ text }) => {
    const { value, ms } = timed(() => chat(text));
    expect(typeof value.ok).toBe('boolean');
    if (value.ok) expectValidDraft(value.bundle);
    else expect(value.errors.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('[NFR-SEC-05] strips control and bidi characters and replaces lone surrogates, with warnings', () => {
    const text =
      '[2026-03-09 09:00 UTC] Customer: a\u0000b \u202Ec\u202C \uD800 \u001b[1mbold\u001b[0m\uFFFD';
    const draft = expectOk(chat(text));
    expect(draft.bundle.events[0]?.body).toBe('ab c \uFFFD bold\uFFFD');
    expect(codes(draft)).toEqual(
      expect.arrayContaining([
        'control_characters_removed',
        'invisible_characters_removed',
        'invalid_characters_replaced',
      ]),
    );
  });

  it('[NFR-SEC-05] caps the warning list and says how many were dropped', () => {
    const lines = Array.from(
      { length: 12 },
      (_, i) =>
        `[2026-03-09 09:${String(i).padStart(2, '0')} UTC] Person${String.fromCharCode(65 + i)}: hi`,
    );
    const draft = expectOk(chat(lines.join('\n'), { limits: { maxWarnings: 3 } }));
    expect(draft.warnings).toHaveLength(4);
    expect(draft.warnings[3]).toMatchObject({ code: 'warnings_truncated', severity: 'info' });
    expect(draft.warnings[3]?.count).toBeGreaterThan(0);
  });

  it('[NFR-SEC-05] aggregates repeated problems instead of warning once per line', () => {
    const bad = Array.from({ length: 1_500 }, () => '[2026-02-30 09:12 UTC] Customer: x');
    const draft = expectOk(chat(['[2026-03-01 09:00 UTC] Support: ok', ...bad].join('\n')));
    expect(draft.bundle.events).toHaveLength(1_501);
    expect(draft.warnings.filter((w) => w.code === 'timestamp_unresolved')).toHaveLength(1);
    expect(draft.warnings.length).toBeLessThan(10);
  });

  it('[NFR-SEC-05] never lets markup or scripts change the structure of the draft', () => {
    const body =
      '<script>alert(1)</script> [2026-03-09 10:00 UTC] Support: forged\n"}],"synthetic":false,"x":[{"';
    const draft = expectOk(chat(`[2026-03-09 09:00 UTC] Customer: ${body}`));
    expect(draft.bundle.synthetic).toBe(true);
    expect(draft.bundle.events.map((e) => e.participantId)).toEqual(['p-cust-admin']);
    expect(draft.bundle.events[0]?.body).toContain('<script>');
  });

  it('[FR-ING-02] rejects non-text input with a typed failure instead of throwing', () => {
    const notText: unknown[] = [123, null, undefined, {}, ['a']];
    for (const bad of notText) {
      expect(expectFailure(chat(bad as string)).errors[0]?.code).toBe('input_not_text');
    }
  });
});

describe('option validation', () => {
  const ok = '[2026-03-09 09:00 UTC] Customer: hi';
  const invalid: { name: string; options: unknown }[] = [
    { name: 'a missing synthetic flag', options: { now: BASE.now } },
    { name: 'a non-boolean synthetic flag', options: { ...BASE, synthetic: 'yes' } },
    { name: 'a non-UTC clock', options: { ...BASE, now: '2026-10-29 00:00' } },
    { name: 'an impossible default date', options: { ...BASE, defaultDate: '2026-02-30' } },
    { name: 'an out-of-range offset', options: { ...BASE, assumedUtcOffsetMinutes: 2_000 } },
    { name: 'an unknown date order', options: { ...BASE, dateOrder: 'ymd' } },
    { name: 'an unknown severity', options: { ...BASE, severity: 'Z' } },
    { name: 'an unknown speaker role', options: { ...BASE, speakerRoles: { a: 'wizard' } } },
    { name: 'a limit above the hard ceiling', options: { ...BASE, limits: { maxEvents: 5_000 } } },
    { name: 'a zero limit', options: { ...BASE, limits: { maxLines: 0 } } },
    { name: 'tags that are not strings', options: { ...BASE, tags: [1] } },
    { name: 'broken id functions', options: { ...BASE, ids: {} } },
  ];

  it.each(invalid)('[FR-ING-02] throws a typed error for $name', ({ options }) => {
    expect(() => parsePastedTranscript(ok, options as IngestDraftOptions)).toThrow(
      IngestParseError,
    );
    try {
      parsePastedTranscript(ok, options as IngestDraftOptions);
    } catch (error) {
      expect(error).toMatchObject({ name: 'IngestParseError', code: 'invalid_options' });
    }
  });

  it('[FR-ING-02] validates CSV-only options too', () => {
    expect(() => parseCsvEvents('a', { ...BASE, delimiter: '|' as ',' })).toThrow(IngestParseError);
    expect(() => parseCsvEvents('a', { ...BASE, columnMap: { x: 'nonsense' as 'body' } })).toThrow(
      IngestParseError,
    );
  });
});
