import { describe, expect, it } from 'vitest';
import {
  parseCaseBundleJson,
  parseCsvEvents,
  parsePastedTranscript,
  validateCaseBundleValue,
  type IngestParseResult,
} from '../src/ingest/parsers';
import {
  BASE,
  expectFailure,
  expectOk,
  expectValidDraft,
  readExample,
} from './ingest-parsers.helpers';

/** Names that exist on every object: lookups by user text must never reach them. */
const INHERITED = [
  'constructor',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  '__proto__',
  'prototype',
  '__defineGetter__',
];
const stamp = '[2026-03-09 09:00 UTC]';
const csvBase = { ...BASE, workload: 'teams-authentication' } as const;
const minimal = readExample('minimal-case-bundle.json');

function expectTypedTexts(result: IngestParseResult): void {
  const texts = result.ok
    ? [...result.warnings.flatMap((w) => [w.message, w.hint])]
    : [...result.errors.flatMap((e) => [e.path, e.message, e.hint, e.received])];
  for (const text of texts)
    expect(text === undefined || text === null || typeof text === 'string').toBe(true);
}

describe.each(INHERITED)('hostile name %s', (name) => {
  it('[NFR-SEC-05] is just a speaker label, with or without role overrides', () => {
    const text = `${stamp} ${name}: hello\n${stamp} Customer: ok`;
    for (const speakerRoles of [undefined, { other: 'customer_admin' as const }]) {
      const draft = expectOk(parsePastedTranscript(text, { ...BASE, speakerRoles }));
      expectValidDraft(draft.bundle);
      expect(draft.bundle.participants.every((p) => typeof p.role === 'string')).toBe(true);
      // Labels that do not start with a letter or digit are not speaker labels at all.
      if (/^[A-Za-z]/.test(name)) {
        expect(draft.warnings.some((w) => w.code === 'role_unknown')).toBe(true);
      }
    }
  });

  it('[NFR-SEC-05] is just a qualifier, a header key and a status word in a transcript', () => {
    const text = [
      `${name[0]?.toUpperCase()}${name.slice(1)}: some value`,
      `${stamp} Support Engineer (${name}): Ran the query.`,
      `${stamp} Case System: Status changed to Resolved (${name}).`,
    ].join('\n');
    const draft = expectOk(parsePastedTranscript(text, BASE));
    expectValidDraft(draft.bundle);
    expectTypedTexts(draft);
    expect(Object.keys(draft.bundle.case).sort()).toEqual([
      'closedAt',
      'customerAlias',
      'openedAt',
      'product',
      'reference',
      'severity',
      'status',
      'tags',
      'title',
      'workload',
    ]);
  });

  it('[NFR-SEC-05] is just a cell value in CSV role, type, channel and effort columns', () => {
    for (const column of ['Role', 'Type', 'Channel', 'Customer effort']) {
      const header = `Timestamp,Author,Text,Action,${column}`;
      const row = `2026-03-09T09:00:00Z,Contoso admin,hi,Check,${name}`;
      const failure = expectFailure(parseCsvEvents(`${header}\n${row}\n`, csvBase));
      expect(failure.errors[0]).toMatchObject({ code: 'csv_row_invalid', column, row: 2 });
      expect(failure.errors[0]?.hint).toMatch(/^Use one of: /);
      expectTypedTexts(failure);
    }
  });

  it('[NFR-SEC-05] is just a CSV header or a columnMap key', () => {
    const csv = `${name},Timestamp,Author,Text\nemail,2026-03-09T09:00:00Z,Contoso admin,hi\n`;
    const draft = expectOk(parseCsvEvents(csv, csvBase));
    expect(draft.warnings.find((w) => w.code === 'csv_column_ignored')?.count).toBe(1);
    const mapped = expectOk(
      parseCsvEvents(csv, {
        ...csvBase,
        columnMap: Object.fromEntries([[name, 'channel' as const]]),
      }),
    );
    expect(mapped.bundle.events[0]?.channel).toBe('email');
    expectValidDraft(mapped.bundle);
  });

  it('[NFR-SEC-05] is just a key inside structured data', () => {
    const bundle = JSON.parse(minimal) as { events: { structured?: unknown }[] };
    const first = bundle.events[0];
    if (!first) throw new Error('no event');
    first.structured = Object.fromEntries([[name, 'plain text']]);
    if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
      const failure = expectFailure(parseCaseBundleJson(JSON.stringify(bundle)));
      expect(failure.errors[0]?.code).toBe('json_forbidden_key');
      return;
    }
    expect(
      expectOk(parseCaseBundleJson(JSON.stringify(bundle))).bundle.events[0]?.structured,
    ).toEqual({ [name]: 'plain text' });

    first.structured = Object.fromEntries([[name, { nested: 1 }]]);
    const bad = expectFailure(parseCaseBundleJson(JSON.stringify(bundle)));
    expect(typeof bad.errors[0]?.hint).toBe('string');
    expect(bad.errors[0]?.hint.length).toBeGreaterThan(10);
    expect(bad.errors[0]?.path).toContain(name);
  });
});

describe('bounded error output', () => {
  it('[NFR-SEC-05] keeps paths and quoted keys short however long the document keys are', () => {
    const key = 'k'.repeat(200_000);
    const bundle = JSON.parse(minimal) as { events: { structured?: unknown }[] };
    const first = bundle.events[0];
    if (!first) throw new Error('no event');
    first.structured = { [key]: { nested: 1 } };
    const failure = expectFailure(parseCaseBundleJson(JSON.stringify(bundle)));
    for (const issue of failure.errors) {
      expect(issue.path.length).toBeLessThanOrEqual(300);
      expect(issue.message.length).toBeLessThanOrEqual(300);
      expect((issue.received ?? '').length).toBeLessThanOrEqual(120);
    }
    const duplicate = expectFailure(parseCaseBundleJson(`{"${key}":1,"${key}":2}`));
    expect(duplicate.errors[0]?.message.length).toBeLessThanOrEqual(300);
    const value = expectFailure(validateCaseBundleValue({ [key]: 1, [`${key}x`]: [] }));
    expect(value.errors.every((e) => e.path.length <= 300)).toBe(true);
  });

  it('[NFR-SEC-05] shortens hostile header and speaker text before it reaches a message', () => {
    const long = 'Z'.repeat(15_000);
    const csv = `Timestamp,Author,Text,${long}\n2026-03-09T09:00:00Z,${long},hi,x\n`;
    const draft = expectOk(parseCsvEvents(csv, csvBase));
    for (const warning of draft.warnings) {
      expect(warning.message.length).toBeLessThan(600);
    }
    const chat = expectOk(parsePastedTranscript(`${stamp} ${'Y'.repeat(55)}: hi`, BASE));
    expect(chat.warnings.every((w) => w.message.length < 400)).toBe(true);
    expect(chat.speakers[0]?.label.length).toBeLessThanOrEqual(60);
  });
});
