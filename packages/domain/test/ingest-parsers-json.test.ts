import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CaseBundleSchema } from '@caseguard/schemas';
import { parseCaseBundleJson } from '../src/ingest/parsers';
import {
  broken,
  codes,
  expectFailure,
  expectOk,
  expectValidDraft,
  firstError,
  readExample,
  type Change,
} from './ingest-parsers.helpers';

const minimal = readExample('minimal-case-bundle.json');
const casesDir = resolve(import.meta.dirname, '../../../synthetic-data/cases');

describe('parseCaseBundleJson: valid bundles', () => {
  it.each([
    ['the minimal example', minimal],
    ['Case One', readFileSync(resolve(casesDir, 'case-one-teams-signin-dns.json'), 'utf8')],
    ['Case Two', readFileSync(resolve(casesDir, 'case-two-teams-signin-proxy.json'), 'utf8')],
  ])('[FR-ING-02] accepts %s and returns exactly what the schema parses', (_name, text) => {
    const draft = expectOk(parseCaseBundleJson(text));
    expect(draft.bundle).toEqual(CaseBundleSchema.parse(JSON.parse(text)));
    expect(draft.source).toBe('json_bundle');
    expect(draft.confidence).toMatchObject({ level: 'high', estimated: true });
    expectValidDraft(draft.bundle);
  });

  it('[FR-ING-02] ignores a byte-order mark and reports it', () => {
    expect(codes(expectOk(parseCaseBundleJson(`\uFEFF${minimal}`)))).toContain('bom_removed');
  });

  it('[FR-ING-02] warns about replacement characters that betray a bad UTF-8 decode', () => {
    const draft = expectOk(
      parseCaseBundleJson(minimal.replace('Leeds office', 'Leeds \uFFFD office')),
    );
    expect(draft.warnings.find((w) => w.code === 'invalid_characters_replaced')).toMatchObject({
      count: 1,
    });
  });

  it('[FR-ING-02] reports unknown fields, with a suggestion when one is close', () => {
    const draft = expectOk(
      parseCaseBundleJson(broken(['case.closeAt', '2026-05-06T09:00:00Z'], ['extra', 1])),
    );
    const warning = draft.warnings.find((w) => w.code === 'unknown_field');
    expect(warning?.count).toBe(2);
    expect(warning?.message).toContain('"closeAt" in case (did you mean "closedAt"?)');
  });

  it('[FR-ING-02] accepts structured values and escapes, including surrogate pairs', () => {
    const text = broken(
      ['events.0.structured', { rows: 3, ok: true, names: ['a', 'b'] }],
      ['events.0.body', 'tab\there \u{1F600}'],
    );
    const draft = expectOk(parseCaseBundleJson(text));
    expect(draft.bundle.events[0]?.structured).toEqual({ rows: 3, ok: true, names: ['a', 'b'] });
    expect(draft.bundle.events[0]?.body).toBe('tab\there \u{1F600}');
  });
});

describe('parseCaseBundleJson: syntax errors', () => {
  const cases: { name: string; text: string; code: string; message: RegExp; hint: RegExp }[] = [
    {
      name: 'a trailing comma',
      text: '{"a":1,}',
      code: 'json_syntax',
      message: /quoted key/,
      hint: /trailing comma/,
    },
    {
      name: 'single quotes',
      text: "{'a':1}",
      code: 'json_syntax',
      message: /quoted key/,
      hint: /double quotes/,
    },
    {
      name: 'an unquoted key',
      text: '{a:1}',
      code: 'json_syntax',
      message: /quoted key/,
      hint: /double quotes/,
    },
    {
      name: 'a missing colon',
      text: '{"a" 1}',
      code: 'json_syntax',
      message: /":"/,
      hint: /colon/,
    },
    {
      name: 'a missing comma',
      text: '[1 2]',
      code: 'json_syntax',
      message: /Expected "," or "]"/,
      hint: /commas/,
    },
    {
      name: 'an unclosed object',
      text: '{"a":1',
      code: 'json_syntax',
      message: /ends unexpectedly/,
      hint: /missing closing/,
    },
    {
      name: 'an unterminated string',
      text: '{"a":"x',
      code: 'json_syntax',
      message: /never closed/,
      hint: /closing double quote/,
    },
    {
      name: 'a bad escape',
      text: '{"a":"\\x"}',
      code: 'json_syntax',
      message: /not a valid escape/,
      hint: /Escape a backslash/,
    },
    {
      name: 'a short unicode escape',
      text: '{"a":"\\u12"}',
      code: 'json_syntax',
      message: /four hexadecimal/,
      hint: /four hex/,
    },
    {
      name: 'a raw line break in a string',
      text: '{"a":"x\ny"}',
      code: 'json_invalid_string',
      message: /control character/,
      hint: /\\n/,
    },
    {
      name: 'a leading zero',
      text: '{"a":01}',
      code: 'json_syntax',
      message: /after a number/,
      hint: /leading zeros/,
    },
    {
      name: 'a number that overflows',
      text: '{"a":1e999}',
      code: 'json_invalid_number',
      message: /too large/,
      hint: /smaller number/,
    },
    {
      name: 'text after the value',
      text: '{"a":1} x',
      code: 'json_syntax',
      message: /after the end/,
      hint: /exactly one/,
    },
    {
      name: 'a bare word',
      text: 'undefined',
      code: 'json_syntax',
      message: /where a value was expected/,
      hint: /strings, numbers/,
    },
    {
      name: 'a truncated literal',
      text: '{"a":tru}',
      code: 'json_syntax',
      message: /where a value was expected/,
      hint: /strings, numbers/,
    },
  ];

  it.each(cases)('[FR-ING-02] explains $name', ({ text, code, message, hint }) => {
    const error = firstError(parseCaseBundleJson(text));
    expect(error.code).toBe(code);
    expect(error.message).toMatch(message);
    expect(error.hint).toMatch(hint);
    expect(error.message).toMatch(/\(line \d+, column \d+\)/);
  });

  it('[FR-ING-02] reports the line and column of the problem', () => {
    const error = firstError(parseCaseBundleJson('{\n  "a": 1,\n  "b": ?\n}'));
    expect(error).toMatchObject({ line: 3, path: 'b', received: '?' });
    expect(error.message).toContain('line 3, column 8');
  });

  it('[FR-ING-02] rejects documents whose root is not an object', () => {
    for (const text of ['[]', '"x"', '123', 'null', 'true']) {
      expect(firstError(parseCaseBundleJson(text))).toMatchObject({
        code: 'json_not_an_object',
        path: '(root)',
      });
    }
  });

  it('[FR-ING-02] distinguishes empty and oversized input', () => {
    expect(firstError(parseCaseBundleJson('   '))).toMatchObject({ code: 'input_empty' });
    expect(
      firstError(parseCaseBundleJson(minimal, { limits: { maxPayloadBytes: 100 } })),
    ).toMatchObject({ code: 'input_too_large' });
  });
});

describe('parseCaseBundleJson: friendly schema errors', () => {
  const mutations: {
    name: string;
    changes: Change[];
    path: string;
    message: RegExp;
    hint: RegExp;
    received: string;
  }[] = [
    {
      name: 'a timestamp without a Z',
      changes: [['events.0.timestamp', '2026-03-09 09:12']],
      path: 'events[0].timestamp',
      message: /not a UTC ISO-8601 timestamp/,
      hint: /2026-03-09T09:12:00Z/,
      received: '"2026-03-09 09:12"',
    },
    {
      name: 'a timestamp with an offset',
      changes: [['events.1.timestamp', '2026-03-09T09:12:00+02:00']],
      path: 'events[1].timestamp',
      message: /UTC ISO-8601/,
      hint: /offsets such as \+02:00 are not accepted/,
      received: '"2026-03-09T09:12:00+02:00"',
    },
    {
      name: 'an unknown event type',
      changes: [['events.1.type', 'gossip']],
      path: 'events[1].type',
      message: /not allowed/,
      hint: /customer_email, customer_call, engineer_email/,
      received: '"gossip"',
    },
    {
      name: 'an unknown role',
      changes: [['participants.0.role', 'wizard']],
      path: 'participants[0].role',
      message: /not allowed/,
      hint: /customer_admin/,
      received: '"wizard"',
    },
    {
      name: 'an invalid severity',
      changes: [['case.severity', 'D']],
      path: 'case.severity',
      message: /not allowed/,
      hint: /A, B, C/,
      received: '"D"',
    },
    {
      name: 'a body that is not text',
      changes: [['events.0.body', 5]],
      path: 'events[0].body',
      message: /must be a string but a number was given/,
      hint: /Change "body" to a string/,
      received: '5',
    },
    {
      name: 'a body that is too long',
      changes: [['events.0.body', 'x'.repeat(20_001)]],
      path: 'events[0].body',
      message: /at most 20000 characters/,
      hint: /Shorten "body"/,
      received: '"',
    },
    {
      name: 'a malformed reference',
      changes: [['case.reference', 'ab']],
      path: 'case.reference',
      message: /does not match/,
      hint: /upper-case letters, digits and dashes/,
      received: '"ab"',
    },
    {
      name: 'no events',
      changes: [['events', []]],
      path: 'events',
      message: /at least 1 item/,
      hint: /at least 1 item/,
      received: 'array with 0 items',
    },
    {
      name: 'a structured value of the wrong shape',
      changes: [['events.0.structured', { a: { b: 1 } }]],
      path: 'events[0].structured.a',
      message: /unsupported type/,
      hint: /string \(up to 500 chars\)/,
      received: 'object with 1 key (b)',
    },
    {
      name: 'an unknown reply target',
      changes: [['events.2.inResponseTo', 'nope']],
      path: 'events[2].inResponseTo',
      message: /unknown event "nope"/,
      hint: /Point "inResponseTo" at the "id"/,
      received: '"nope"',
    },
    {
      name: 'a duplicate participant id',
      changes: [
        ['participants.1.id', 'p-cust-admin'],
        ['events.1.participantId', 'p-cust-admin'],
      ],
      path: 'participants[1].id',
      message: /Duplicate participant id/,
      hint: /unique "id"/,
      received: '"p-cust-admin"',
    },
    {
      name: 'an event for an unknown participant',
      changes: [['events.0.participantId', 'ghost']],
      path: 'events[0].participantId',
      message: /Unknown participant "ghost"/,
      hint: /Add that participant/,
      received: '"ghost"',
    },
    {
      name: 'an event before the case opened',
      changes: [['case.openedAt', '2026-05-05T09:30:00Z']],
      path: 'case.openedAt',
      message: /earlier than case\.openedAt/,
      hint: /first event or earlier/,
      received: '"2026-05-05T09:30:00Z"',
    },
    {
      name: 'a misspelled required field',
      changes: [
        ['case.tiltle', 'Minimal example title'],
        ['case.title', undefined],
      ],
      path: 'case.title',
      message: /required but is missing/,
      hint: /did you mean "title"/,
      received: '(missing)',
    },
    {
      name: 'a missing enum field',
      changes: [['case.status', undefined]],
      path: 'case.status',
      message: /required but is missing/,
      hint: /one of: open, resolved, closed/,
      received: '(missing)',
    },
  ];

  it.each(mutations)('[FR-ING-02] explains $name', ({ changes, path, message, hint, received }) => {
    const error = firstError(parseCaseBundleJson(broken(...changes)));
    expect(error.path).toBe(path);
    expect(error.message).toMatch(message);
    expect(error.hint).toMatch(hint);
    expect(error.received).not.toBeNull();
    expect(error.received?.startsWith(received.slice(0, 8))).toBe(true);
  });

  it('[FR-ING-02] never leaks raw validator wording and always fills path, message, hint and code', () => {
    for (const { changes } of mutations) {
      const failure = expectFailure(parseCaseBundleJson(broken(...changes)));
      for (const issue of failure.errors) {
        expect(issue.path.length).toBeGreaterThan(0);
        expect(issue.message.length).toBeGreaterThan(10);
        expect(issue.hint.length).toBeGreaterThan(10);
        expect(issue.code.startsWith('schema_')).toBe(true);
        expect(`${issue.message} ${issue.hint}`).not.toMatch(
          /Invalid input|Too (small|big): expected|\$ZodError|\bZod\b/,
        );
      }
    }
  });

  it('[FR-ING-02] lists every field problem at once, in document order, up to the error limit', () => {
    const text = broken(
      ['case.severity', 'D'],
      ['events.0.timestamp', 'nope'],
      ['events.1.type', 'x'],
      ['participants.0.role', 'y'],
    );
    const paths = expectFailure(parseCaseBundleJson(text)).errors.map((e) => e.path);
    expect(paths).toEqual([
      'case.severity',
      'participants[0].role',
      'events[0].timestamp',
      'events[1].type',
    ]);
    const limited = expectFailure(parseCaseBundleJson(text, { limits: { maxErrors: 2 } })).errors;
    expect(limited.map((e) => e.code)).toEqual([
      'schema_invalid_value',
      'schema_invalid_value',
      'errors_truncated',
    ]);
  });
});

describe('parseCaseBundleJson: schema version', () => {
  it('[FR-ING-02] gives migration advice for a newer version and skips the rest', () => {
    const failure = expectFailure(
      parseCaseBundleJson(
        broken(['schemaVersion', 'caseguard.case-bundle/2'], ['case.severity', 'Z']),
      ),
    );
    expect(failure.errors).toHaveLength(1);
    expect(failure.errors[0]).toMatchObject({
      code: 'schema_version_mismatch',
      path: 'schemaVersion',
      received: '"caseguard.case-bundle/2"',
    });
    expect(failure.errors[0]?.message).toContain('newer than the version 1');
    expect(failure.errors[0]?.hint).toContain('Upgrade CaseGuard');
    expect(failure.errors[0]?.hint).toContain('"schemaVersion" to "caseguard.case-bundle/1"');
  });

  it('[FR-ING-02] gives migration advice for an older version', () => {
    const error = firstError(
      parseCaseBundleJson(broken(['schemaVersion', 'caseguard.case-bundle/0'])),
    );
    expect(error.message).toContain('older than the current version 1');
    expect(error.hint).toContain('Migrate the file');
    expect(error.hint).toContain('docs/schemas/case-bundle.schema.json');
  });

  it('[FR-ING-02] reports a missing version first and still lists the other problems', () => {
    const failure = expectFailure(
      parseCaseBundleJson(broken(['schemaVersion', undefined], ['case.severity', 'Z'])),
    );
    expect(failure.errors.map((e) => e.path)).toEqual(['schemaVersion', 'case.severity']);
    expect(failure.errors[0]?.hint).toContain('Add "schemaVersion": "caseguard.case-bundle/1"');
    const onlyVersion = expectFailure(parseCaseBundleJson(broken(['schemaVersion', undefined])));
    expect(onlyVersion.errors).toHaveLength(1);
  });

  it.each([
    ['a string that is not a version', 'v1', /not a schema version CaseGuard recognises/],
    ['a number', 1, /must be a string but 1 was given/],
    ['a null', null, /must be a string but null was given/],
  ])('[FR-ING-02] explains %s', (_name, value, message) => {
    const error = firstError(parseCaseBundleJson(broken(['schemaVersion', value])));
    expect(error.code).toBe('schema_version_mismatch');
    expect(error.message).toMatch(message);
    expect(error.hint).toContain('caseguard.case-bundle/1');
  });
});
