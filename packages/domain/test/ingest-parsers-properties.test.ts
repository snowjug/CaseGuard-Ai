import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  IngestParseError,
  parseCaseBundleJson,
  parseCsvEvents,
  parsePastedTranscript,
  validateCaseBundleValue,
  type IngestParseResult,
} from '../src/ingest/parsers';
import { parseStrictJson } from '../src/ingest/parsers/json-strict';
import { BASE, expectValidDraft, readExample } from './ingest-parsers.helpers';

const RUNS = { numRuns: 250 };
const csvOptions = { ...BASE, workload: 'teams-authentication' } as const;
const FORMULA = /^[=+\-@\t\r]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Every string must be storable: no NUL and no half of a surrogate pair (PostgreSQL rejects both). */
function expectStorable(value: unknown, path = 'bundle'): void {
  if (typeof value === 'string') {
    expect(value.includes('\u0000'), `${path} contains NUL`).toBe(false);
    expect(LONE_SURROGATE.test(value), `${path} contains a lone surrogate`).toBe(false);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => expectStorable(v, `${path}[${i}]`));
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) expectStorable(v, `${path}.${k}`);
  }
}

/** Shared contract: a result is a valid sorted draft, or at least one friendly typed error. */
function expectTypedResult(result: IngestParseResult): void {
  expect(typeof result.ok).toBe('boolean');
  expect(result.warnings.length).toBeLessThanOrEqual(101);
  for (const warning of result.warnings) {
    expect(typeof warning.code).toBe('string');
    expect(warning.message.length).toBeGreaterThan(0);
  }
  if (result.ok) {
    expectValidDraft(result.bundle);
    expectStorable(result.bundle);
    expect(result.stats.events).toBe(result.bundle.events.length);
    expect(result.confidence.score).toBeGreaterThanOrEqual(0.05);
    expect(result.confidence.score).toBeLessThanOrEqual(1);
    expect(
      result.eventNotes.length === 0 || result.eventNotes.length === result.bundle.events.length,
    ).toBe(true);
    for (const event of result.bundle.events) {
      expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/);
      const year = Number(event.timestamp.slice(0, 4));
      expect(year).toBeGreaterThanOrEqual(1970);
      expect(year).toBeLessThanOrEqual(2100);
    }
  } else {
    expect(result.errors.length).toBeGreaterThan(0);
    for (const issue of result.errors) {
      expect(issue.code.length).toBeGreaterThan(0);
      expect(issue.path.length).toBeGreaterThan(0);
      expect(issue.message.length).toBeGreaterThan(0);
      expect(issue.hint.length).toBeGreaterThan(0);
      expect(issue.received === null || typeof issue.received === 'string').toBe(true);
    }
  }
}

const anyText = fc.string({ maxLength: 600, unit: 'binary' });

/** Fuzzed text carries no case metadata, so a schema failure of the draft can only be a parser defect. */
function expectInputInducedFailure(result: IngestParseResult): void {
  if (result.ok) return;
  for (const issue of result.errors) {
    expect(issue.code, JSON.stringify(issue)).not.toMatch(/^schema_|^draft_invalid$/);
  }
}

const stampArb = fc
  .tuple(
    fc.integer({ min: 1960, max: 2110 }),
    fc.integer({ min: 0, max: 14 }),
    fc.integer({ min: 0, max: 33 }),
    fc.integer({ min: 0, max: 26 }),
    fc.integer({ min: 0, max: 64 }),
    fc.constantFrom('[{}]', '({})', '{}', '{} -', '{}Z -'),
  )
  .map(([y, mo, d, h, mi, shape]) => {
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${y}-${pad(mo)}-${pad(d)} ${pad(h)}:${pad(mi)}`;
    return shape.replace('{}', stamp);
  });
const labelArb = fc.constantFrom(
  'Customer',
  'Support Engineer',
  'Contoso admin',
  'Case System',
  'Anna Schmidt',
  'Escalation Engineer',
  'Network admin',
  '',
  'a:b',
  'Support (query output)',
  'Customer <c@x.invalid>',
);
const lineArb = fc.oneof(
  fc
    .tuple(stampArb, labelArb, fc.string({ maxLength: 60, unit: 'binary' }))
    .map(([s, l, b]) => `${s} ${l}: ${b}`),
  fc.tuple(stampArb, fc.string({ maxLength: 60, unit: 'binary' })).map(([s, b]) => `${s} ${b}`),
  fc.constantFrom(
    'From: Customer <c@x.invalid>',
    'Sent: 2026-03-09 09:00 UTC',
    'Subject: Re: help',
    '> quoted',
    '```',
    'On Mon, 9 Mar 2026 at 09:00, Support wrote:',
    '',
    '   ',
    '-----Original Message-----',
    'Customer: unstamped',
  ),
  fc.string({ maxLength: 80, unit: 'binary' }),
);
const transcriptArb = fc
  .array(lineArb, { maxLength: 40 })
  .chain((lines) => fc.constantFrom('\n', '\r\n').map((eol) => lines.join(eol)));

describe('property: parsePastedTranscript', () => {
  it('[FR-ING-02] never throws and always returns a typed result for arbitrary text', () => {
    fc.assert(
      fc.property(anyText, (text) => {
        const result = parsePastedTranscript(text, BASE);
        expectTypedResult(result);
        expectInputInducedFailure(result);
      }),
      RUNS,
    );
  });

  it('[FR-ING-02] returns valid, sorted drafts (or friendly errors) for transcript-shaped text', () => {
    fc.assert(
      fc.property(transcriptArb, (text) => {
        const result = parsePastedTranscript(text, BASE);
        expectTypedResult(result);
        expectInputInducedFailure(result);
      }),
      { numRuns: 400 },
    );
  });

  it('[FR-ING-01] is deterministic and ignores the line-ending convention', () => {
    fc.assert(
      fc.property(transcriptArb, (text) => {
        const a = parsePastedTranscript(text, BASE);
        const b = parsePastedTranscript(text, BASE);
        expect(a).toEqual(b);
        const lf = parsePastedTranscript(text.replaceAll('\r\n', '\n'), BASE);
        const crlf = parsePastedTranscript(
          text.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'),
          BASE,
        );
        expect(crlf.ok).toBe(lf.ok);
        if (lf.ok && crlf.ok) expect(crlf.bundle).toEqual(lf.bundle);
      }),
      { numRuns: 150 },
    );
  });

  it('[FR-ING-01] trailing blank lines and spaces never change the events', () => {
    fc.assert(
      fc.property(transcriptArb, (text) => {
        const base = parsePastedTranscript(text, BASE);
        const padded = parsePastedTranscript(`${text}\n\n   \n`, BASE);
        expect(padded.ok).toBe(base.ok);
        if (base.ok && padded.ok) {
          expect(padded.bundle.events.map((e) => [e.timestamp, e.type, e.body])).toEqual(
            base.bundle.events.map((e) => [e.timestamp, e.type, e.body]),
          );
        }
      }),
      { numRuns: 150 },
    );
  });
});

const cellArb = fc.oneof(
  fc.constantFrom(
    '',
    '=1+1',
    '+1',
    '-1',
    '@x',
    '\t=x',
    '"',
    '""',
    'a,b',
    'a;b',
    'line\nbreak',
    'x\r\ny',
    "'quoted'",
  ),
  fc.string({ maxLength: 40, unit: 'binary' }),
  fc.constantFrom(
    '2026-03-09T09:00:00Z',
    '2026-03-09 09:12',
    '09:12',
    '1773046800',
    'not a time',
    '2026-13-45',
  ),
);
const headerArb = fc.shuffledSubarray(
  [
    'Timestamp',
    'Participant',
    'Role',
    'Type',
    'Subject',
    'Body',
    'Action',
    'Customer effort',
    'Id',
    'In reply to',
    'Extra',
  ],
  { minLength: 3 },
);
const quoteCell = (cell: string, quote: boolean) =>
  quote || /[",;\r\n\t]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
const csvArb = fc
  .tuple(
    headerArb,
    fc.array(fc.array(cellArb, { minLength: 1, maxLength: 11 }), { maxLength: 12 }),
    fc.constantFrom(',', ';', '\t'),
    fc.constantFrom('\n', '\r\n', '\r'),
    fc.boolean(),
  )
  .map(([header, rows, delimiter, eol, bom]) => {
    const line = (cells: string[]) => cells.map((c) => quoteCell(c, false)).join(delimiter);
    return `${bom ? '\uFEFF' : ''}${[line(header), ...rows.map(line)].join(eol)}`;
  });

describe('property: parseCsvEvents', () => {
  it('[FR-ING-02] never throws and always returns a typed result for arbitrary text', () => {
    fc.assert(
      fc.property(anyText, (text) => {
        const result = parseCsvEvents(text, csvOptions);
        expectTypedResult(result);
        expectInputInducedFailure(result);
      }),
      RUNS,
    );
  });

  it('[FR-ING-02] returns valid, sorted drafts (or row-level errors) for CSV-shaped text', () => {
    fc.assert(
      fc.property(csvArb, (text) => {
        const result = parseCsvEvents(text, csvOptions);
        expectTypedResult(result);
        expectInputInducedFailure(result);
        if (!result.ok) {
          for (const issue of result.errors) {
            if (issue.code === 'csv_row_invalid') {
              expect(issue.row).toBeGreaterThanOrEqual(2);
              expect(issue.column).toBeTruthy();
            }
          }
        }
      }),
      { numRuns: 400 },
    );
  });

  it('[NFR-SEC-05] never stores a cell that a spreadsheet would execute as a formula', () => {
    fc.assert(
      fc.property(csvArb, (text) => {
        const result = parseCsvEvents(text, csvOptions);
        if (!result.ok) return;
        for (const event of result.bundle.events) {
          for (const value of [
            event.title,
            event.body,
            event.action?.label,
            event.action?.actionKey,
            ...event.correlationIds,
          ]) {
            if (value) expect(value, `stored value ${JSON.stringify(value)}`).not.toMatch(FORMULA);
          }
        }
      }),
      { numRuns: 400 },
    );
  });

  it('[FR-ING-01] is deterministic', () => {
    fc.assert(
      fc.property(csvArb, (text) => {
        expect(parseCsvEvents(text, csvOptions)).toEqual(parseCsvEvents(text, csvOptions));
      }),
      { numRuns: 120 },
    );
  });
});

const minimal = JSON.parse(readExample('minimal-case-bundle.json')) as Record<string, unknown>;
const mutateArb = fc
  .tuple(
    fc.constantFrom('case', 'participants', 'events', 'schemaVersion', 'synthetic', 'resolution'),
    fc.oneof(fc.constant(undefined), fc.jsonValue({ maxDepth: 3 })),
  )
  .map(([key, value]) => {
    const copy: Record<string, unknown> = { ...minimal };
    if (value === undefined) delete copy[key];
    else copy[key] = value;
    return JSON.stringify(copy);
  });

describe('property: parseCaseBundleJson', () => {
  it('[FR-ING-02] never throws and always returns a typed result for arbitrary text', () => {
    fc.assert(
      fc.property(anyText, (text) => {
        expectTypedResult(parseCaseBundleJson(text));
      }),
      RUNS,
    );
  });

  it('[FR-ING-02] returns friendly errors for any JSON document, valid or not', () => {
    fc.assert(
      fc.property(fc.oneof(fc.json({ maxDepth: 4 }), mutateArb), (text) => {
        expectTypedResult(parseCaseBundleJson(text));
      }),
      { numRuns: 400 },
    );
  });

  it('[FR-ING-02] validates a parsed value exactly like its text form', () => {
    fc.assert(
      fc.property(mutateArb, (text) => {
        const fromText = parseCaseBundleJson(text);
        const fromValue = validateCaseBundleValue(JSON.parse(text));
        expect(fromValue.ok).toBe(fromText.ok);
        if (fromText.ok && fromValue.ok) expect(fromValue.bundle).toEqual(fromText.bundle);
        if (!fromText.ok && !fromValue.ok) {
          expect(fromValue.errors.map((e) => e.path)).toEqual(fromText.errors.map((e) => e.path));
        }
      }),
      { numRuns: 200 },
    );
  });

  it('[NFR-SEC-05] the strict parser agrees with JSON.parse on every document it accepts', () => {
    const limits = { maxDepth: 16, maxNodes: 200_000 };
    fc.assert(
      fc.property(fc.oneof(fc.json({ maxDepth: 5 }), anyText), (text) => {
        const strict = parseStrictJson(text, limits);
        if (!strict.ok) return;
        expect(JSON.parse(text)).toEqual(strict.value);
      }),
      { numRuns: 500 },
    );
  });

  it('[NFR-SEC-05] the strict parser reads ordinary JSON values exactly like JSON.parse', () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 6 }), (value) => {
        const text = JSON.stringify(value);
        fc.pre(!/__proto__|"constructor"|"prototype"/.test(text));
        const strict = parseStrictJson(text, { maxDepth: 16, maxNodes: 200_000 });
        expect(strict.ok && strict.value).toEqual(JSON.parse(text));
      }),
      { numRuns: 300 },
    );
  });

  it('[NFR-SEC-05] only options can make a parser throw, and then only a typed error', () => {
    fc.assert(
      fc.property(fc.anything(), (options) => {
        try {
          parsePastedTranscript('[2026-03-09 09:00 UTC] Customer: hi', options as never);
        } catch (error) {
          expect(error).toBeInstanceOf(IngestParseError);
        }
      }),
      { numRuns: 150 },
    );
  });
});
