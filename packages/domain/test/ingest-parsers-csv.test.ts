import { describe, expect, it } from 'vitest';
import { parseCsvEvents, type CsvParseOptions } from '../src/ingest/parsers';
import { BASE, codes, expectFailure, expectOk, expectValidDraft } from './ingest-parsers.helpers';

const parse = (csv: string, extra: Partial<CsvParseOptions> = {}) =>
  parseCsvEvents(csv, { ...BASE, workload: 'teams-authentication', ...extra });

const HEADER = 'Timestamp,Participant,Role,Type,Subject,Body';
const sample = (eol = '\n') =>
  [
    HEADER,
    '2026-03-09T09:00:00Z,Contoso admin,customer_admin,customer_email,Sign-in fails,Users cannot sign in',
    '2026-03-09T09:30:00Z,Support Engineer,support_engineer,engineer_action,Checked logs,Ran the query',
  ].join(eol);

describe('parseCsvEvents: RFC 4180', () => {
  const variants: { name: string; csv: string }[] = [
    { name: 'LF line endings', csv: sample('\n') },
    { name: 'CRLF line endings', csv: sample('\r\n') },
    { name: 'CR line endings', csv: sample('\r') },
    { name: 'mixed CRLF and LF', csv: sample('\n').replace('\n', '\r\n') },
    { name: 'a byte-order mark', csv: `\uFEFF${sample()}` },
    { name: 'a trailing newline', csv: `${sample()}\n` },
    { name: 'a trailing CRLF', csv: `${sample()}\r\n` },
  ];

  it.each(variants)('[FR-ING-01] reads the same two events with $name', ({ csv }) => {
    const draft = expectOk(parse(csv));
    expect(draft.bundle.events).toHaveLength(2);
    expect(draft.bundle.events.map((e) => e.body)).toEqual([
      'Users cannot sign in',
      'Ran the query',
    ]);
    expectValidDraft(draft.bundle);
  });

  it('[FR-ING-01] reports a byte-order mark instead of silently dropping it', () => {
    expect(expectOk(parse(`\uFEFF${sample()}`)).warnings.map((w) => w.code)).toContain(
      'bom_removed',
    );
  });

  const quoting: { name: string; cell: string; expected: string }[] = [
    { name: 'a comma inside quotes', cell: '"one, two"', expected: 'one, two' },
    { name: 'doubled quotes', cell: '"say ""hello"""', expected: 'say "hello"' },
    { name: 'an embedded LF', cell: '"line1\nline2"', expected: 'line1\nline2' },
    { name: 'an embedded CRLF', cell: '"line1\r\nline2"', expected: 'line1\nline2' },
    { name: 'an empty quoted body next to a title', cell: '""', expected: '' },
    { name: 'a quoted delimiter-only cell', cell: '","', expected: ',' },
  ];

  it.each(quoting)('[FR-ING-01] keeps $name', ({ cell, expected }) => {
    const csv = `${HEADER}\n2026-03-09T09:00:00Z,Contoso admin,customer_admin,customer_email,Subject,${cell}\n`;
    const draft = expectOk(parse(csv));
    expect(draft.bundle.events[0]?.body).toBe(expected);
  });

  it('[FR-ING-01] keeps a multi-line quoted cell from shifting the rows that follow', () => {
    const csv = [
      HEADER,
      '2026-03-09T09:00:00Z,Contoso admin,customer_admin,customer_email,One,"a\nb\nc"',
      '2026-03-09T09:05:00Z,Support Engineer,support_engineer,engineer_email,Two,second',
    ].join('\n');
    const draft = expectOk(parse(csv));
    expect(draft.bundle.events.map((e) => e.title)).toEqual(['One', 'Two']);
  });

  it('[FR-ING-01] reports a stray quote inside unquoted text but keeps going', () => {
    const csv = `${HEADER}\n2026-03-09T09:00:00Z,Contoso admin,customer_admin,customer_email,Sub,5" screen fails\n`;
    const draft = expectOk(parse(csv));
    expect(draft.bundle.events[0]?.body).toBe('5" screen fails');
    expect(draft.warnings.find((w) => w.code === 'csv_stray_quote')).toMatchObject({ line: 2 });
  });
});

describe('parseCsvEvents: delimiters and columns', () => {
  it('[FR-ING-01] sniffs semicolon and tab delimiters and tells the author', () => {
    for (const [delimiter, name] of [
      [';', 'semicolon'],
      ['\t', 'tab'],
    ] as const) {
      const csv = sample()
        .split('\n')
        .map((l) => l.replaceAll(',', delimiter))
        .join('\n');
      const draft = expectOk(parse(csv));
      expect(draft.bundle.events).toHaveLength(2);
      expect(draft.warnings.find((w) => w.code === 'csv_delimiter_detected')?.message).toContain(
        name,
      );
    }
  });

  it('[FR-ING-01] does not mistake commas inside quoted semicolon-separated cells', () => {
    const csv = 'Timestamp;Participant;Body\n2026-03-09T09:00:00Z;Contoso admin;"a, b, c"\n';
    expect(expectOk(parse(csv)).bundle.events[0]?.body).toBe('a, b, c');
  });

  it('[FR-ING-01] honours an explicit delimiter option without announcing a detection', () => {
    const csv = 'Timestamp\tParticipant\tBody\n2026-03-09T09:00:00Z\tContoso admin\ta;b,c\n';
    const draft = expectOk(parse(csv, { delimiter: '\t' }));
    expect(draft.bundle.events[0]?.body).toBe('a;b,c');
    expect(codes(draft)).not.toContain('csv_delimiter_detected');
    const wrong = expectFailure(
      parse('Timestamp;Participant;Body\n2026-03-09T09:00:00Z;Contoso admin;hi\n', {
        delimiter: ',',
      }),
    );
    expect(wrong.errors[0]?.code).toBe('csv_missing_column');
  });

  const aliases: { name: string; header: string; row: string }[] = [
    {
      name: 'Time (UTC) / From / Message',
      header: 'Time (UTC),From,Message',
      row: '2026-03-09T09:00:00Z,Contoso admin,hello',
    },
    {
      name: 'When / Speaker / Comment',
      header: 'When,Speaker,Comment',
      row: '2026-03-09 09:00 UTC,Contoso admin,hello',
    },
    {
      name: 'Created At / Sender / Content',
      header: 'Created At,Sender,Content',
      row: '2026-03-09T09:00:00Z,Contoso admin,hello',
    },
    {
      name: 'sentAt / Actor / Notes',
      header: 'sentAt,Actor,Notes',
      row: '2026-03-09T09:00:00Z,Contoso admin,hello',
    },
    {
      name: 'DATETIME / AUTHOR / TEXT',
      header: 'DATETIME,AUTHOR,TEXT',
      row: '2026-03-09T09:00:00Z,Contoso admin,hello',
    },
    {
      name: 'separate Date and Time columns',
      header: 'Date,Time,Author,Text',
      row: '2026-03-09,09:00 UTC,Contoso admin,hello',
    },
    {
      name: 'epoch seconds',
      header: 'Timestamp,Author,Text',
      row: '1773046800,Contoso admin,hello',
    },
    {
      name: 'epoch milliseconds',
      header: 'Timestamp,Author,Text',
      row: '1773046800000,Contoso admin,hello',
    },
  ];

  it.each(aliases)('[FR-ING-02] maps the headers $name', ({ header, row }) => {
    const draft = expectOk(parse(`${header}\n${row}\n`));
    expect(draft.bundle.events[0]).toMatchObject({
      timestamp: '2026-03-09T09:00:00Z',
      body: 'hello',
    });
    expect(draft.bundle.participants[0]?.role).toBe('customer_admin');
  });

  it('[FR-ING-02] uses a time-only column with defaultDate', () => {
    const draft = expectOk(
      parse('Time,Author,Text\n09:00 UTC,Contoso admin,hello\n', { defaultDate: '2026-03-09' }),
    );
    expect(draft.bundle.events[0]?.timestamp).toBe('2026-03-09T09:00:00Z');
    expect(draft.eventNotes[0]?.timestampBasis).toBe('date_assumed');
  });

  it('[FR-ING-02] lists ignored columns and prefers the first of two columns with one meaning', () => {
    const draft = expectOk(
      parse(
        'Timestamp,Author,Message,Text,Priority\n2026-03-09T09:00:00Z,Contoso admin,first,second,high\n',
      ),
    );
    expect(draft.bundle.events[0]?.body).toBe('first');
    expect(codes(draft)).toEqual(
      expect.arrayContaining(['csv_column_conflict', 'csv_column_ignored']),
    );
    expect(draft.warnings.find((w) => w.code === 'csv_column_ignored')?.message).toContain(
      '"Priority"',
    );
  });

  it('[FR-ING-02] lets columnMap rename unusual headers', () => {
    const draft = expectOk(
      parse('Zeit,Wer,Was\n2026-03-09T09:00:00Z,Contoso admin,hallo\n', {
        columnMap: { Zeit: 'timestamp', Wer: 'participant', Was: 'body' },
      }),
    );
    expect(draft.bundle.events[0]?.body).toBe('hallo');
  });

  it('[FR-ING-01] pseudonymises participants and infers roles from keywords, never from names', () => {
    const csv =
      'Timestamp,Author,Text\n2026-03-09T09:00:00Z,Anna Schmidt,hi\n2026-03-09T09:01:00Z,Support Engineer,hello\n';
    const draft = expectOk(parse(csv));
    expect(draft.bundle.participants.map((p) => p.alias)).toEqual([
      'Unidentified Participant 1',
      'Support Engineer 1',
    ]);
    expect(JSON.stringify(draft.bundle.participants)).not.toContain('Anna');
    expect(codes(draft)).toContain('role_unknown');
  });

  it('[FR-ING-01] reads role and type columns, accepting readable names', () => {
    const csv =
      `${HEADER}\n2026-03-09T09:00:00Z,Anna,Customer admin,Customer e-mail,S,Body\n`.replace(
        'e-mail',
        'email',
      );
    const draft = expectOk(parse(csv));
    expect(draft.bundle.participants[0]?.role).toBe('customer_admin');
    expect(draft.bundle.events[0]?.type).toBe('customer_email');
    expect(draft.eventNotes[0]?.typeBasis).toBe('column');
    expect(codes(draft)).not.toContain('role_unknown');
  });

  it('[FR-ING-01] reads action columns and validates each of them', () => {
    const header =
      'Timestamp,Author,Text,Action,Customer effort,Destructive,Duration (min),Action key';
    const ok = expectOk(
      parse(
        `${header}\n2026-03-09T09:00:00Z,Support Engineer,Ran it,Check logs,low,no,15,act.signin-log-correlation\n`,
      ),
    );
    expect(ok.bundle.events[0]?.action).toEqual({
      label: 'Check logs',
      customerEffort: 'low',
      destructive: false,
      durationMinutes: 15,
      actionKey: 'act.signin-log-correlation',
    });
    const bad = expectFailure(
      parse(
        `${header}\n2026-03-09T09:00:00Z,Support Engineer,Ran it,Check logs,huge,maybe,soon,\n`,
      ),
    );
    expect(bad.errors.map((e) => e.column)).toEqual([
      'Customer effort',
      'Destructive',
      'Duration (min)',
    ]);
    expect(bad.errors[0]?.hint).toContain('none, low, medium, high, very_high');
  });

  it('[FR-ING-01] links replies by id or by spreadsheet row number', () => {
    const byId = expectOk(
      parse(
        'Id,Timestamp,Author,Text,In reply to\nA,2026-03-09T09:00:00Z,Support Engineer,q,\nB,2026-03-09T09:10:00Z,Contoso admin,a,A\n',
      ),
    );
    expect(byId.bundle.events[1]?.inResponseTo).toBe('A');
    const byRow = expectOk(
      parse(
        'Timestamp,Author,Text,Parent\n2026-03-09T09:00:00Z,Support Engineer,q,\n2026-03-09T09:10:00Z,Contoso admin,a,2\n',
      ),
    );
    expect(byRow.bundle.events[1]?.inResponseTo).toBe('e01');
    expect(byRow.eventNotes[1]?.inResponseToBasis).toBe('column');
  });

  it('[FR-ING-02] rejects a reply that points nowhere or at itself, naming the row', () => {
    const failure = expectFailure(
      parse(
        'Id,Timestamp,Author,Text,In reply to\nA,2026-03-09T09:00:00Z,Support,q,Z\nB,2026-03-09T09:10:00Z,Contoso admin,a,B\n',
      ),
    );
    expect(failure.errors.map((e) => [e.row, e.column])).toEqual([
      [2, 'In reply to'],
      [3, 'In reply to'],
    ]);
  });

  it('[FR-ING-01] keeps resolution and status when the rows state them explicitly', () => {
    const csv = [
      'Timestamp,Author,Type,Text',
      '2026-03-09T09:00:00Z,Contoso admin,customer_email,Fails',
      '2026-03-09T15:00:00Z,Support Engineer,resolution_note,Resolution summary. Root cause: proxy. Workaround: bypass.',
      '2026-03-09T15:05:00Z,Case System,status_change,Status changed to Resolved.',
    ].join('\n');
    const draft = expectOk(parse(csv));
    expect(draft.bundle.resolution).toMatchObject({ rootCause: 'proxy.', workaround: 'bypass.' });
    expect(draft.bundle.case).toMatchObject({
      status: 'resolved',
      closedAt: '2026-03-09T15:05:00Z',
    });
  });

  it('[FR-ING-01] sorts rows by time and says so', () => {
    const csv =
      'Timestamp,Author,Text\n2026-03-09T10:00:00Z,Support Engineer,second\n2026-03-09T09:00:00Z,Contoso admin,first\n';
    const draft = expectOk(parse(csv));
    expect(draft.bundle.events.map((e) => e.body)).toEqual(['first', 'second']);
    expect(codes(draft)).toContain('events_reordered');
  });

  it('[FR-ING-01] skips blank rows and counts them', () => {
    const csv = 'Timestamp,Author,Text\n\n2026-03-09T09:00:00Z,Contoso admin,hi\n,,\n';
    const draft = expectOk(parse(csv));
    expect(draft.stats.skippedRows).toBe(2);
    expect(draft.warnings.find((w) => w.code === 'csv_blank_rows_skipped')?.count).toBe(2);
  });

  it('[FR-ING-01] defaults the title from the first subject and flags assumed time zones', () => {
    const draft = expectOk(
      parse('Timestamp,Author,Subject,Text\n2026-03-09 09:00,Contoso admin,Proxy is slow,hi\n'),
    );
    expect(draft.bundle.case.title).toBe('Proxy is slow');
    expect(codes(draft)).toContain('timezone_assumed');
  });
});
