import { describe, expect, it } from 'vitest';
import { ValidationFailedError } from '../src/errors';
import { sha256Hex } from '../src/db/hash';
import {
  MAX_PAGE_SIZE,
  decodeCursor,
  encodeCursor,
  normalizeLimit,
  toPage,
  type CursorField,
} from '../src/db/cursor';

const TS = '2026-01-15T09:00:00.123Z';

const rejects = (
  cursor: string,
  kind: Parameters<typeof decodeCursor>[0],
  fields: readonly CursorField[],
): void => {
  expect(() => decodeCursor(kind, cursor, fields)).toThrow(ValidationFailedError);
};

describe('[NFR-REL-01] opaque keyset cursors', () => {
  it('round-trips the sort keys of each list layout', () => {
    expect(
      decodeCursor('cases', encodeCursor('cases', [TS, 'case_1']), ['timestamp', 'text']),
    ).toEqual([TS, 'case_1']);
    expect(decodeCursor('audit', encodeCursor('audit', [42]), ['int'])).toEqual([42]);
    expect(decodeCursor('events', encodeCursor('events', [TS, 7]), ['timestamp', 'int'])).toEqual([
      TS,
      7,
    ]);
    expect(
      decodeCursor('claims', encodeCursor('claims', [TS, 'a.b:c-d_e']), ['timestamp', 'text']),
    ).toEqual([TS, 'a.b:c-d_e']);
  });

  it('treats a missing or empty cursor as "start from the beginning"', () => {
    expect(decodeCursor('cases', undefined, ['timestamp', 'text'])).toBeNull();
    expect(decodeCursor('cases', '', ['timestamp', 'text'])).toBeNull();
  });

  it('produces URL-safe opaque strings that fit the 200-character API limit', () => {
    const cursor = encodeCursor('cases', [TS, 'case_01HZX3N5Y7Q9R2T4V6W8X0A1B2']);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+\.[0-9a-f]{8}$/);
    expect(cursor.length).toBeLessThanOrEqual(200);
    expect(cursor).not.toContain('case_01'); // not human-readable
  });

  it('rejects every kind of tampering with ValidationFailedError', () => {
    const valid = encodeCursor('cases', [TS, 'case_1']);
    const [payload, checksum] = valid.split('.') as [string, string];
    const flipped = `${payload.slice(0, 4)}${payload[4] === 'A' ? 'B' : 'A'}${payload.slice(5)}`;
    const layout: CursorField[] = ['timestamp', 'text'];

    rejects(`${flipped}.${checksum}`, 'cases', layout);
    rejects(
      `${payload}.${checksum.replace(/./, checksum[0] === 'a' ? 'b' : 'a')}`,
      'cases',
      layout,
    );
    rejects(payload, 'cases', layout);
    rejects(`${payload}.${checksum}.extra`, 'cases', layout);
    rejects(`${payload}.NOTHEX!!`, 'cases', layout);
    rejects(`${payload}=.${checksum}`, 'cases', layout); // non-canonical base64url padding
    rejects('x'.repeat(500), 'cases', layout);
    rejects('not a cursor', 'cases', layout);
    rejects('.', 'cases', layout);
  });

  it('rejects cursors issued for another list or with another layout', () => {
    const cursor = encodeCursor('cases', [TS, 'case_1']);
    rejects(cursor, 'claims', ['timestamp', 'text']);
    rejects(cursor, 'cases', ['timestamp']);
    rejects(cursor, 'cases', ['timestamp', 'int']);
    rejects(encodeCursor('audit', [5]), 'audit', ['timestamp']);
  });

  it('rejects values that do not match the declared field types', () => {
    rejects(encodeCursor('events', ['2026-01-15T09:00:00Z', 1]), 'events', ['timestamp', 'int']); // not millisecond ISO
    rejects(encodeCursor('events', ['2026-13-45T09:00:00.000Z', 1]), 'events', [
      'timestamp',
      'int',
    ]);
    rejects(encodeCursor('events', [TS, 1.5]), 'events', ['timestamp', 'int']);
    rejects(encodeCursor('events', [TS, 'seven']), 'events', ['timestamp', 'int']);
    rejects(encodeCursor('cases', [TS, 'x'.repeat(201)]), 'cases', ['timestamp', 'text']);
    rejects(encodeCursor('audit', [Number.MAX_SAFE_INTEGER + 2]), 'audit', ['int']);
  });

  it('[NFR-SEC-05] rejects values the database would refuse, even when the checksum is valid', () => {
    const events: CursorField[] = ['timestamp', 'int'];
    const cases: CursorField[] = ['timestamp', 'text'];
    const impossibleInstants = [
      '0000-01-01T00:00:00.000Z', // PostgreSQL has no year 0
      '0000-12-31T23:59:59.999Z',
      '2026-02-30T00:00:00.000Z', // V8 would roll these over; PostgreSQL refuses them
      '2026-04-31T00:00:00.000Z',
      '2025-02-29T12:00:00.000Z',
      '2026-00-10T00:00:00.000Z',
      '2026-01-00T00:00:00.000Z',
      '2026-13-01T00:00:00.000Z',
      '2026-01-01T24:00:00.000Z',
      '2026-01-01T23:59:60.000Z',
    ];
    for (const bad of impossibleInstants)
      rejects(encodeCursor('events', [bad, 1]), 'events', events);
    // `integer` columns: the reviewer's 2^53-1 and just past the column range, and negatives.
    for (const bad of [Number.MAX_SAFE_INTEGER, 2 ** 31, 2 ** 31 + 1, -1, -(2 ** 31)]) {
      rejects(encodeCursor('audit', [bad]), 'audit', ['int']);
      rejects(encodeCursor('events', [TS, bad]), 'events', events);
    }
    // Identifiers follow the rules of IdSchema: no blanks, controls, quotes, leading punctuation.
    for (const bad of [
      '',
      ' ',
      'a b',
      'a\u0000b',
      'a\nb',
      "x' OR '1'='1",
      '_a',
      '.a',
      '-a',
      'é',
      'a/b',
      'x'.repeat(121),
    ]) {
      rejects(encodeCursor('cases', [TS, bad]), 'cases', cases);
    }
  });

  it('accepts the extreme values the database accepts', () => {
    const events: CursorField[] = ['timestamp', 'int'];
    for (const [instant, sequence] of [
      ['0001-01-01T00:00:00.000Z', 0],
      ['9999-12-31T23:59:59.999Z', 2 ** 31 - 1],
      ['2024-02-29T23:59:59.999Z', 1999], // a real leap day
    ] as const) {
      expect(decodeCursor('events', encodeCursor('events', [instant, sequence]), events)).toEqual([
        instant,
        sequence,
      ]);
    }
    const longest = `a${'b'.repeat(119)}`;
    expect(
      decodeCursor('cases', encodeCursor('cases', [TS, longest]), ['timestamp', 'text']),
    ).toEqual([TS, longest]);
  });

  it('rejects values of the wrong JSON type, whatever the checksum says', () => {
    const forged = (values: unknown[]): string => {
      const payload = JSON.stringify([1, 'events', ...values]);
      return `${Buffer.from(payload).toString('base64url')}.${sha256Hex(`events:${payload}`).slice(0, 8)}`;
    };
    const events: CursorField[] = ['timestamp', 'int'];
    for (const values of [
      [null, 1],
      [20260115, 1],
      [{}, 1],
      [[TS], 1],
      [TS, null],
      [TS, '7'],
      [TS, true],
      [TS, [1]],
      [TS, 1e21],
      [TS],
      [TS, 1, 2],
    ]) {
      expect(() => decodeCursor('events', forged(values), events)).toThrow(ValidationFailedError);
    }
    expect(decodeCursor('events', forged([TS, 7]), events)).toEqual([TS, 7]);
  });
});

describe('page sizes and pages', () => {
  it('accepts 1..200 only', () => {
    expect(normalizeLimit(1)).toBe(1);
    expect(normalizeLimit(MAX_PAGE_SIZE)).toBe(200);
    for (const bad of [0, -1, 201, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => normalizeLimit(bad)).toThrow(ValidationFailedError);
    }
  });

  it('turns a limit+1 fetch into a page with a cursor taken from the last returned row', () => {
    const rows = [1, 2, 3, 4];
    const full = toPage(
      rows,
      3,
      (n) => n * 10,
      (n) => `c${n}`,
    );
    expect(full).toEqual({ items: [10, 20, 30], nextCursor: 'c3' });
    const exact = toPage(
      [1, 2, 3],
      3,
      (n) => n,
      (n) => `c${n}`,
    );
    expect(exact).toEqual({ items: [1, 2, 3], nextCursor: null });
    expect(
      toPage(
        [],
        3,
        (n: number) => n,
        () => 'x',
      ),
    ).toEqual({ items: [], nextCursor: null });
  });
});
