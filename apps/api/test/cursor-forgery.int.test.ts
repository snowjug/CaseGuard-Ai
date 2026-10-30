import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeCursor, type CursorField, type CursorKind } from '../src/db/cursor';
import { getDatabaseErrorCode } from '../src/db/errors';
import { sha256Hex } from '../src/db/hash';
import { createRepositories } from '../src/db/repositories';
import type { Database, TenantRepositories, TenantScope } from '../src/db/repositories/types';
import {
  CONTOSO_SCOPE,
  TEST_DATABASE_STARTUP_TIMEOUT_MS,
  createTestRepositories,
  type TestHarness,
} from '../src/db/testing';
import { ValidationFailedError } from '../src/errors';
import { TENANT_A, at, buildAuditInput, buildIngestInput } from './builders';

let h: TestHarness;

beforeAll(async () => {
  h = await createTestRepositories();
}, TEST_DATABASE_STARTUP_TIMEOUT_MS);
afterAll(async () => {
  await h.close();
});

/**
 * What anyone can do: the checksum of a cursor is a public function of its payload, so a forger can
 * give any values a valid one. (`encodeCursor` cannot be used for hostile types such as null.)
 */
function forge(
  kind: CursorKind,
  values: readonly unknown[],
  options: { version?: number; embeddedKind?: CursorKind } = {},
): string {
  const payload = JSON.stringify([options.version ?? 1, options.embeddedKind ?? kind, ...values]);
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${sha256Hex(`${kind}:${payload}`).slice(0, 8)}`;
}

interface ListUnderTest {
  /** The sort-key layout the repository decodes this cursor with. */
  layout: readonly CursorField[];
  list: (repos: TenantRepositories, cursor: string) => Promise<unknown>;
}

/** Every list that takes a cursor. Typed over CursorKind: a new kind cannot be added without a row. */
const LISTS: Record<CursorKind, ListUnderTest> = {
  cases: {
    layout: ['timestamp', 'text'],
    list: (repos, cursor) => repos.cases.list({ limit: 5, cursor }),
  },
  events: {
    layout: ['timestamp', 'int'],
    list: (repos, cursor) => repos.cases.listEvents('case_f1', { limit: 5, cursor }),
  },
  claims: {
    layout: ['timestamp', 'text'],
    list: (repos, cursor) => repos.analysis.listClaims('case_f1', { limit: 5, cursor }),
  },
  skills: {
    layout: ['timestamp', 'text'],
    list: (repos, cursor) => repos.skills.list({ limit: 5, cursor }),
  },
  audit: {
    layout: ['int'],
    list: (repos, cursor) => repos.audit.list({ limit: 5, cursor }),
  },
  executions: {
    layout: ['timestamp', 'text'],
    list: (repos, cursor) => repos.telemetry.listExecutions({ limit: 5, cursor }),
  },
  reviews: {
    layout: ['timestamp', 'text'],
    list: (repos, cursor) => repos.reviews.list({ limit: 5, cursor }),
  },
  jobs: {
    layout: ['timestamp', 'text'],
    list: (repos, cursor) => repos.jobs.list({ limit: 5, cursor }),
  },
};
const KINDS = Object.keys(LISTS) as CursorKind[];

const VALID: Record<CursorField, unknown> = {
  timestamp: '2026-01-15T09:00:00.000Z',
  text: 'case_a',
  int: 5,
};

const HOSTILE: Record<CursorField, readonly (readonly [label: string, value: unknown])[]> = {
  timestamp: [
    ['year zero (the reviewer’s forged cases cursor)', '0000-01-01T00:00:00.000Z'],
    ['last day of year zero', '0000-12-31T23:59:59.999Z'],
    ['February 30', '2026-02-30T00:00:00.000Z'],
    ['April 31', '2026-04-31T00:00:00.000Z'],
    ['February 29 of a common year', '2025-02-29T12:00:00.000Z'],
    ['month 0', '2026-00-10T00:00:00.000Z'],
    ['day 0', '2026-01-00T00:00:00.000Z'],
    ['month 13', '2026-13-01T00:00:00.000Z'],
    ['hour 24', '2026-01-01T24:00:00.000Z'],
    ['leap second', '2026-01-01T23:59:60.000Z'],
    ['no milliseconds', '2026-01-01T00:00:00Z'],
    ['an offset instead of Z', '2026-01-01T00:00:00.000+01:00'],
    ['five-digit year', '10000-01-01T00:00:00.000Z'],
    ['SQL in the value', "2026-01-01T00:00:00.000Z'; DROP TABLE cases;--"],
    ['a word', 'garbage'],
    ['empty', ''],
    ['a number', 20260115],
    ['null', null],
    ['an object', {}],
    ['a list', ['2026-01-01T00:00:00.000Z']],
    ['true', true],
  ],
  int: [
    ['2^53-1 (the reviewer’s forged audit cursor)', Number.MAX_SAFE_INTEGER],
    ['2^31, one past a PostgreSQL integer', 2 ** 31],
    ['-1', -1],
    ['the smallest integer', -(2 ** 31)],
    ['a fraction', 1.5],
    ['1e21', 1e21],
    ['a numeric string', '7'],
    ['a word', 'seven'],
    ['null (what JSON makes of NaN)', null],
    ['an object', {}],
    ['a list', [1]],
    ['true', true],
  ],
  text: [
    ['empty', ''],
    ['121 characters', 'x'.repeat(121)],
    ['a blank', ' '],
    ['a space inside', 'a b'],
    ['a NUL character', 'a\u0000b'],
    ['a newline', 'a\nb'],
    ['SQL in the value', "x' OR '1'='1"],
    ['a leading underscore', '_a'],
    ['a leading dot', '.a'],
    ['a slash', 'a/b'],
    ['a non-ASCII letter', 'é'],
    ['a number', 5],
    ['null', null],
    ['an object', {}],
    ['a list', ['a']],
  ],
};

function* forgeries(kind: CursorKind, layout: readonly CursorField[]) {
  const valid = layout.map((field) => VALID[field]);
  for (const [index, field] of layout.entries()) {
    for (const [label, hostile] of HOSTILE[field]) {
      const values = valid.map((value, position) => (position === index ? hostile : value));
      yield { label: `${field} #${index}: ${label}`, cursor: forge(kind, values) };
    }
  }
  yield { label: 'a value too few', cursor: forge(kind, valid.slice(1)) };
  yield { label: 'a value too many', cursor: forge(kind, [...valid, 1]) };
  yield { label: 'another version', cursor: forge(kind, valid, { version: 2 }) };
  const other = KINDS.find((candidate) => candidate !== kind) ?? kind;
  yield {
    label: 'a valid checksum for this list over a payload that names another list',
    cursor: forge(kind, valid, { embeddedKind: other }),
  };
}

/** Repositories that count how often they reach the database. */
function counted(scope: TenantScope = CONTOSO_SCOPE) {
  let calls = 0;
  const count = <T>(run: () => Promise<T>): Promise<T> => {
    calls += 1;
    return run();
  };
  const database: Database = {
    kind: h.database.kind,
    query: (text, params) => count(() => h.database.query(text, params)),
    transaction: (fn) => count(() => h.database.transaction(fn)),
    withTenant: (tenant, fn) => count(() => h.database.withTenant(tenant, fn)),
    ping: () => h.database.ping(),
    close: () => Promise.resolve(),
  };
  return { repos: createRepositories(database).forTenant(scope), calls: () => calls };
}

describe('[NFR-SEC-05] a forged cursor with a valid checksum', () => {
  it('has a row for every cursor kind, with the layout the repositories decode with', () => {
    expect(KINDS.slice().sort()).toEqual(
      ['audit', 'cases', 'claims', 'events', 'executions', 'jobs', 'reviews', 'skills'].sort(),
    );
  });

  it.each(KINDS)(
    '%s: decoding refuses out-of-range values and wrong shapes with a ValidationFailedError',
    (kind) => {
      const { layout } = LISTS[kind];
      let tried = 0;
      for (const { label, cursor } of forgeries(kind, layout)) {
        tried += 1;
        let thrown: unknown = null;
        try {
          decodeCursor(kind, cursor, layout);
        } catch (error) {
          thrown = error;
        }
        expect(thrown, label).toBeInstanceOf(ValidationFailedError);
        expect(thrown, label).toMatchObject({
          code: 'validation_failed',
          status: 422,
          message: 'The pagination cursor is invalid',
          issues: [{ path: 'cursor' }],
        });
      }
      expect(tried).toBeGreaterThan(layout.length * 10);
    },
  );

  it.each(KINDS)(
    '%s: the list answers ValidationFailedError for every forgery, before any SQL runs',
    async (kind) => {
      const { layout, list } = LISTS[kind];
      const { repos, calls } = counted();
      for (const { label, cursor } of forgeries(kind, layout)) {
        const outcome = await list(repos, cursor).then(
          () => null,
          (error: unknown) => error,
        );
        expect(outcome, label).toBeInstanceOf(ValidationFailedError);
        expect(outcome, label).toMatchObject({ code: 'validation_failed', status: 422 });
      }
      expect(calls()).toBe(0);
    },
  );
});

describe('[NFR-SEC-05] what a cursor may say, the database takes', () => {
  const EXTREMES: Record<CursorField, readonly unknown[]> = {
    timestamp: ['0001-01-01T00:00:00.000Z', '9999-12-31T23:59:59.999Z', '2024-02-29T23:59:59.999Z'],
    int: [0, 2 ** 31 - 1, 1999],
    text: ['a', `z${'9'.repeat(119)}`, 'A_b.c:d-e'],
  };

  beforeAll(async () => {
    await h.reset();
    const repos = h.contoso();
    for (const [index, caseId] of ['case_f1', 'case_f2', 'case_f3'].entries()) {
      await repos.cases.ingest(
        buildIngestInput({
          caseId,
          reference: `CG-F${index + 1}`,
          receivedSeed: `forged:${caseId}`,
          openedAt: at(index + 1),
        }),
      );
    }
    for (let minute = 1; minute <= 3; minute += 1) {
      await repos.audit.append(buildAuditInput({ occurredAt: at(minute) }));
    }
  }, TEST_DATABASE_STARTUP_TIMEOUT_MS);

  it.each(KINDS)(
    '%s: cursors at the extremes of every field reach SQL and succeed',
    async (kind) => {
      const { layout, list } = LISTS[kind];
      const repos = h.contoso();
      const picks = [0, 1, 2].map((pick) => layout.map((field) => EXTREMES[field][pick]));
      for (const values of picks) {
        const page = await list(repos, forge(kind, values));
        expect(page, JSON.stringify(values)).toMatchObject({ items: expect.any(Array) });
      }
    },
  );

  it('puts the extremes where they belong: before everything, after everything', async () => {
    const repos = h.contoso();
    const first = '0001-01-01T00:00:00.000Z';
    const last = '9999-12-31T23:59:59.999Z';
    // Newest first: a cursor at the end of time leaves everything after it, one before time nothing.
    expect(
      (await repos.cases.list({ limit: 50, cursor: forge('cases', [last, 'z']) })).items,
    ).toHaveLength(3);
    expect(
      (await repos.cases.list({ limit: 50, cursor: forge('cases', [first, 'a']) })).items,
    ).toHaveLength(0);
    expect(
      (await repos.audit.list({ limit: 50, cursor: forge('audit', [2 ** 31 - 1]) })).items,
    ).toHaveLength(3);
    expect((await repos.audit.list({ limit: 50, cursor: forge('audit', [0]) })).items).toHaveLength(
      0,
    );
    // Oldest first for events: the opposite.
    const events = (cursor: string) => repos.cases.listEvents('case_f1', { limit: 50, cursor });
    expect((await events(forge('events', [first, 0]))).items.length).toBeGreaterThan(0);
    expect((await events(forge('events', [last, 2 ** 31 - 1]))).items).toHaveLength(0);
  });

  it('whatever the decoder accepts, PostgreSQL reads as the same value (600 random candidates)', async () => {
    // mulberry32: a fixed seed keeps the candidates, and so any failure, reproducible.
    let state = 20_260_115;
    const random = (): number => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
    const int = (max: number): number => Math.floor(random() * (max + 1));
    const pad = (value: number, width: number): string => String(value).padStart(width, '0');
    const instant = (): string =>
      `${pad(random() < 0.1 ? int(3) : int(9999), 4)}-${pad(int(13), 2)}-${pad(int(32), 2)}` +
      `T${pad(int(25), 2)}:${pad(int(61), 2)}:${pad(int(61), 2)}.${pad(int(999), 3)}Z`;
    const sequence = (): number => {
      const edges = [0, 1, 2 ** 31 - 1, 2 ** 31, -1, Number.MAX_SAFE_INTEGER];
      return random() < 0.2 ? (edges[int(edges.length - 1)] ?? 0) : int(2 ** 33) - 2 ** 32;
    };

    let accepted = 0;
    let refused = 0;
    for (let round = 0; round < 600; round += 1) {
      const value = instant();
      const number = sequence();
      for (const [kind, layout, values] of [
        ['events', ['timestamp', 'int'], [value, 1]],
        ['audit', ['int'], [number]],
      ] as const) {
        let decoded: ReturnType<typeof decodeCursor> = null;
        try {
          decoded = decodeCursor(kind, forge(kind, values), layout);
        } catch (error) {
          expect(error).toBeInstanceOf(ValidationFailedError);
          refused += 1;
          continue;
        }
        accepted += 1;
        if (kind === 'events') {
          const result = await h.database.query<{ text: string }>(
            `SELECT to_char($1::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS text`,
            [decoded?.[0]],
          );
          expect(result.rows[0]?.text, value).toBe(value);
        } else {
          const result = await h.database.query<{ n: number }>('SELECT $1::integer AS n', [
            decoded?.[0],
          ]);
          expect(result.rows[0]?.n, String(number)).toBe(number);
        }
      }
    }
    // Both outcomes happen often, so neither half of the check is vacuous.
    expect(accepted).toBeGreaterThan(300);
    expect(refused).toBeGreaterThan(300);
  });
});

describe('[NFR-SEC-05] a data exception from the database is a 422, whatever caused it', () => {
  const CASES = [
    ['22003', 'an integer out of range', 'SELECT $1::integer AS v', [2 ** 31]],
    ['22007', 'text that is not a timestamp', 'SELECT $1::timestamptz AS v', ['garbage-value']],
    [
      '22008',
      'a timestamp past the calendar',
      'SELECT $1::timestamptz AS v',
      ['0000-01-01T00:00:00.000Z'],
    ],
    ['22P02', 'text that is not an integer', 'SELECT $1::integer AS v', ['not-a-number']],
  ] as const;

  it.each(CASES)(
    'SQLSTATE %s (%s) reaches callers as ValidationFailedError',
    async (code, _what, sql, params) => {
      for (const run of [
        () => h.database.query(sql, params),
        () => h.database.withTenant(CONTOSO_SCOPE, (tx) => tx.query(sql, params)),
        () => h.database.transaction((tx) => tx.query(sql, params)),
      ]) {
        const error = await run().then(
          () => null,
          (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(ValidationFailedError);
        expect(error).toMatchObject({ code: 'validation_failed', status: 422 });
        // The SQLSTATE is kept for the logs, the value and the SQL text are not shown to anyone.
        expect(getDatabaseErrorCode(error)).toBe(code);
        const shown = JSON.stringify(error, Object.getOwnPropertyNames(error));
        expect(shown).not.toMatch(/garbage-value|not-a-number|SELECT \$1|2147483648|0000-01-01/);
      }
    },
  );

  it('a failed statement leaves the connection usable for the next request', async () => {
    await expect(h.database.query('SELECT $1::integer', [2 ** 31])).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
    const direct = await h.database.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM cases WHERE tenant_id = $1',
      [TENANT_A],
    );
    const scoped = await h.database.withTenant(CONTOSO_SCOPE, (tx) =>
      tx.query<{ n: number }>('SELECT count(*)::int AS n FROM cases'),
    );
    expect(scoped.rows[0]?.n).toBe(direct.rows[0]?.n);
  });

  it('a statement handed such a value directly gets the same 422 (defence in depth)', async () => {
    // Defence in depth: this value bypasses the validation of a cursor on purpose.
    const error = await h.database
      .withTenant(CONTOSO_SCOPE, (tx) =>
        tx.query('SELECT 1 FROM audit_events WHERE tenant_id = $1 AND sequence < $2::integer', [
          TENANT_A,
          Number.MAX_SAFE_INTEGER,
        ]),
      )
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(ValidationFailedError);
    expect(getDatabaseErrorCode(error)).toBe('22003');
  });
});
