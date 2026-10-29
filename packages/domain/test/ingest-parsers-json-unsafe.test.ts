import { describe, expect, it } from 'vitest';
import { parseCaseBundleJson, validateCaseBundleValue } from '../src/ingest/parsers';
import {
  broken,
  expectOk,
  expectValidDraft,
  firstError,
  readExample,
} from './ingest-parsers.helpers';

const minimal = readExample('minimal-case-bundle.json');

describe('parseCaseBundleJson: unsafe structures', () => {
  it('[NFR-SEC-05] rejects duplicate keys that JSON.parse would silently collapse', () => {
    expect(firstError(parseCaseBundleJson('{"a":1,"a":2}'))).toMatchObject({
      code: 'json_duplicate_key',
      path: '(root)',
      received: '"a"',
    });
    const nested = firstError(parseCaseBundleJson('{"events":[{"id":"a"},{"id":"b","id":"c"}]}'));
    expect(nested).toMatchObject({ code: 'json_duplicate_key', path: 'events[1]' });
  });

  const forbidden = [
    ['__proto__ at the root', '{"__proto__":{"polluted":true}}'],
    ['constructor at the root', '{"constructor":{"prototype":{"polluted":true}}}'],
    ['prototype in a nested object', '{"case":{"prototype":1}}'],
    ['__proto__ inside an array item', '{"events":[{"__proto__":{}}]}'],
    ['__proto__ spelled with escapes', '{"\\u005f\\u005fproto\\u005f\\u005f":{}}'],
  ] as const;

  it.each(forbidden)('[NFR-SEC-05] rejects %s', (_name, text) => {
    expect(firstError(parseCaseBundleJson(text)).code).toBe('json_forbidden_key');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('[NFR-SEC-05] enforces the nesting limit without overflowing the stack', () => {
    const limit = firstError(parseCaseBundleJson(`${'['.repeat(17)}${']'.repeat(17)}`));
    expect(limit).toMatchObject({ code: 'json_too_deep' });
    expect(limit.message).toContain('more than 16 levels');
    for (const depth of [100_000, 1_000_000]) {
      const result = parseCaseBundleJson(`${'['.repeat(depth)}${']'.repeat(depth)}`, {
        limits: { maxPayloadBytes: 8_000_000 },
      });
      expect(firstError(result).code).toBe('json_too_deep');
    }
    const objects = `${'{"a":'.repeat(50_000)}1${'}'.repeat(50_000)}`;
    expect(firstError(parseCaseBundleJson(objects)).code).toBe('json_too_deep');
  });

  it('[NFR-SEC-05] accepts nesting exactly at the limit', () => {
    const deep = `${'{"a":'.repeat(15)}1${'}'.repeat(15)}`;
    expect(firstError(parseCaseBundleJson(deep)).code).not.toBe('json_too_deep');
  });

  it('[NFR-SEC-05] limits the number of values', () => {
    const items = `[${Array.from({ length: 500 }, () => '1').join(',')}]`;
    const result = parseCaseBundleJson(`{"a":${items}}`, { limits: { maxJsonNodes: 100 } });
    expect(firstError(result).code).toBe('json_too_complex');
  });

  it('[NFR-SEC-05] counts bytes, not characters, against the payload limit', () => {
    const euro = JSON.stringify({ a: '€'.repeat(40) });
    expect(euro.length).toBeLessThan(100);
    const result = parseCaseBundleJson(euro, { limits: { maxPayloadBytes: 100 } });
    expect(firstError(result).code).toBe('input_too_large');
  });

  it('[NFR-SEC-05] rejects NUL characters and unpaired surrogates that databases cannot store', () => {
    for (const escape of ['\\u0000', '\\ud800', '\\udc00 x']) {
      const error = firstError(
        parseCaseBundleJson(broken(['case.title', 'Bad']).replace('Bad', `Bad${escape}`)),
      );
      expect(error.code).toBe('json_invalid_string');
      expect(error.hint).toContain('UTF-8');
    }
  });
});

describe('validateCaseBundleValue: values that were parsed elsewhere', () => {
  it('[FR-ING-02] validates an already-parsed bundle like text', () => {
    expectValidDraft(expectOk(validateCaseBundleValue(JSON.parse(minimal))).bundle);
    const result = validateCaseBundleValue(JSON.parse(broken(['case.severity', 'Q'])));
    expect(firstError(result)).toMatchObject({ path: 'case.severity' });
  });

  it('[NFR-SEC-05] rejects an own __proto__ key that JSON.parse creates', () => {
    const value = JSON.parse('{"__proto__":{"polluted":true}}') as unknown;
    expect(firstError(validateCaseBundleValue(value)).code).toBe('json_forbidden_key');
  });

  it('[NFR-SEC-05] rejects cycles and deep structures without recursing', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(firstError(validateCaseBundleValue(cyclic)).code).toBe('json_too_deep');
    let deep: unknown = 1;
    for (let i = 0; i < 100_000; i++) deep = [deep];
    expect(firstError(validateCaseBundleValue(deep)).code).toBe('json_too_deep');
  });

  it('[NFR-SEC-05] rejects values JSON can never contain', () => {
    const impossible: unknown[] = [
      { a: () => 1 },
      { a: 10n },
      { a: Symbol('x') },
      { a: Number.NaN },
      { a: 'x\u0000y' },
    ];
    for (const value of impossible) {
      expect(['json_syntax', 'json_invalid_number', 'json_invalid_string']).toContain(
        firstError(validateCaseBundleValue(value)).code,
      );
    }
    const huge = { a: new Array<number>(300_000).fill(1) };
    expect(firstError(validateCaseBundleValue(huge)).code).toBe('json_too_complex');
  });
});
