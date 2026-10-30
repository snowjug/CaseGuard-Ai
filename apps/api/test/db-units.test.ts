import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError, ConflictError, ForbiddenError, ValidationFailedError } from '../src/errors';
import { createDatabase } from '../src/db/client';
import { ENTRA_POSTGRES_SCOPE, createEntraPasswordProvider } from '../src/db/entra';
import {
  DataStoreError,
  DataStoreUnavailableError,
  SanitizedDatabaseError,
  describeFailure,
  getDatabaseErrorCode,
  mapDatabaseError,
} from '../src/db/errors';
import { canonicalJson, sha256Hex } from '../src/db/hash';
import { createIdGenerator, isGeneratedId } from '../src/db/ids';
import {
  normalizeParams,
  normalizeRows,
  normalizeValue,
  parseInt8,
  parseNumeric,
  parseTimestamptz,
  toJsonParam,
} from '../src/db/normalize';
import {
  PG_TYPE_OVERRIDES,
  PgDatabase,
  type PgClientLike,
  type PgPoolLike,
} from '../src/db/pg-database';
import {
  QueryBuilder,
  col,
  insertRows,
  updateRow,
  type TableSpec,
} from '../src/db/repositories/support';
import type { Database, QueryResult, SqlExecutor } from '../src/db/repositories/types';

describe('timestamp, integer and parameter normalisation', () => {
  it.each([
    ['2024-01-02 03:04:05.123456+00', '2024-01-02T03:04:05.123Z'],
    ['2024-01-02 03:04:05+05:30', '2024-01-01T21:34:05.000Z'],
    ['2024-01-02 03:04:05.1-08', '2024-01-02T11:04:05.100Z'],
    ['2024-01-02T03:04:05.123Z', '2024-01-02T03:04:05.123Z'],
    ['2024-12-31 23:59:59.9999999+00', '2024-12-31T23:59:59.999Z'],
    ['2024-03-10 12:00:00+05:45:30', '2024-03-10T06:14:30.000Z'],
  ])('parseTimestamptz(%s) -> %s', (input, expected) => {
    expect(parseTimestamptz(input)).toBe(expected);
  });

  it('passes through infinity and anything it does not recognise', () => {
    expect(parseTimestamptz('infinity')).toBe('infinity');
    expect(parseTimestamptz('-infinity')).toBe('-infinity');
    expect(parseTimestamptz('not a date')).toBe('not a date');
  });

  it('turns 64-bit integers into numbers and refuses to produce BigInt', () => {
    expect(parseInt8('42')).toBe(42);
    expect(parseInt8('9007199254740993')).toBe('9007199254740993');
    expect(parseNumeric('1.50')).toBe(1.5);
    expect(normalizeValue(5n)).toBe(5);
    expect(normalizeValue(9007199254740993n)).toBe('9007199254740993');
    expect(normalizeValue(new Date('2024-01-02T03:04:05.678Z'))).toBe('2024-01-02T03:04:05.678Z');
    expect(normalizeValue(new Date('nope'))).toBeNull();
    expect(normalizeValue({ a: 1 })).toEqual({ a: 1 });
    expect(
      normalizeRows([{ t: new Date('2024-01-02T03:04:05.000Z'), n: 3n, s: 'x' }, null]),
    ).toEqual([{ t: '2024-01-02T03:04:05.000Z', n: 3, s: 'x' }, null]);
  });

  it('normalises bind parameters and rejects shapes the two drivers would treat differently', () => {
    expect(normalizeParams(undefined)).toBeUndefined();
    expect(normalizeParams([])).toBeUndefined();
    expect(
      normalizeParams([
        undefined,
        null,
        'a',
        1,
        true,
        new Date('2024-01-02T03:04:05.000Z'),
        ['x', 'y'],
      ]),
    ).toEqual([null, null, 'a', 1, true, '2024-01-02T03:04:05.000Z', ['x', 'y']]);
    expect(() => normalizeParams([5n])).toThrow(/bigint/);
    expect(() => normalizeParams([{ a: 1 }])).toThrow(/toJsonParam/);
    expect(() => normalizeParams([[{ a: 1 }]])).toThrow(/non-primitive/);
    expect(toJsonParam({ a: [1, 2] })).toBe('{"a":[1,2]}');
    expect(() => toJsonParam(undefined)).toThrow();
  });

  it('configures pg to return the same shapes as PGlite', () => {
    const parser = (oid: number) =>
      PG_TYPE_OVERRIDES.getTypeParser(oid, 'text') as (value: string) => unknown;
    expect(parser(1184)('2024-01-02 03:04:05.1+00')).toBe('2024-01-02T03:04:05.100Z');
    expect(parser(20)('7')).toBe(7);
    expect(parser(1700)('2.5')).toBe(2.5);
    expect(parser(3802)('{"a":[1]}')).toEqual({ a: [1] });
    expect(parser(23)('12')).toBe(12);
    expect(parser(1009)('{a,b}')).toEqual(['a', 'b']);
  });
});

describe('PGlite returns the normalised shapes', () => {
  let db: Database;
  // Starting PGlite takes seconds, longer when the whole suite runs in parallel.
  beforeAll(async () => {
    db = await createDatabase({ url: 'pglite://memory' });
  }, 180_000);
  afterAll(async () => {
    await db.close();
  });

  it('timestamptz as ISO strings, jsonb as objects, counts as numbers, arrays as arrays', async () => {
    const result = await db.query<Record<string, unknown>>(
      `SELECT '2024-01-02 03:04:05.123456+05:30'::timestamptz AS t,
              count(*) AS c, 12::int8 AS big, 1.5::numeric AS n, avg(x) AS a,
              '{"a":[1,{"b":null}]}'::jsonb AS j, ARRAY['x','y']::text[] AS arr
         FROM (SELECT 1 AS x UNION ALL SELECT 2) s`,
    );
    expect(result.rows[0]).toEqual({
      t: '2024-01-01T21:34:05.123Z',
      c: 2,
      big: 12,
      n: 1.5,
      a: 1.5,
      j: { a: [1, { b: null }] },
      arr: ['x', 'y'],
    });
    expect(result.rowCount).toBe(1);
    // Parameters: JSON as text, arrays as arrays, timestamps as strings, null for undefined.
    const bound = await db.query<Record<string, unknown>>(
      'SELECT $1::jsonb AS j, $2::text[] AS a, $3::timestamptz AS t, $4::text AS u',
      [toJsonParam({ k: [1, 2] }), ['p', 'q,r'], '2024-05-06T07:08:09.010Z', undefined],
    );
    expect(bound.rows[0]).toEqual({
      j: { k: [1, 2] },
      a: ['p', 'q,r'],
      t: '2024-05-06T07:08:09.010Z',
      u: null,
    });
  });

  it('runs multi-statement scripts without parameters and reports the last statement', async () => {
    const result = await db.query<{ n: number }>(
      'CREATE TABLE t (id int); INSERT INTO t VALUES (1), (2); SELECT count(*)::int AS n FROM t',
    );
    expect(result.rows).toEqual([{ n: 2 }]);
    const update = await db.query('UPDATE t SET id = id + 1');
    expect(update.rowCount).toBe(2);
  });
});

describe('error mapping never leaks SQL text, parameters or row values', () => {
  const dbError = (code: string, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error('duplicate key value violates unique constraint "x"'), {
      code,
      severity: 'ERROR',
      detail: 'Key (tenant_id, id)=(secret-tenant, secret-id) already exists.',
      query: 'INSERT INTO cases VALUES ($1)',
      params: ['secret-param'],
      ...extra,
    });
  const serialised = (error: unknown): string =>
    JSON.stringify(error, Object.getOwnPropertyNames(error)) +
    JSON.stringify(
      (error as { cause?: unknown }).cause,
      Object.getOwnPropertyNames((error as { cause?: object }).cause ?? {}),
    );

  it('maps unique and foreign-key violations to ConflictError with fixed messages', () => {
    const unique = mapDatabaseError(dbError('23505', { constraint: 'cases_pkey', table: 'cases' }));
    expect(unique).toBeInstanceOf(ConflictError);
    expect(unique.message).toBe('A record with the same identifier already exists');
    expect(getDatabaseErrorCode(unique)).toBe('23505');
    expect(serialised(unique)).not.toMatch(/secret|INSERT INTO/);
    expect(unique.cause).toBeInstanceOf(SanitizedDatabaseError);
    expect(unique.cause).toMatchObject({
      message: 'database error 23505 (table cases, constraint cases_pkey)',
    });

    const named = mapDatabaseError(dbError('23505', { constraint: 'skills_tenant_key_uq' }));
    expect(named.message).toBe('A skill with this key already exists');
    expect(mapDatabaseError(dbError('23503'))).toBeInstanceOf(ConflictError);
  });

  it.each([
    ['23514', ValidationFailedError],
    ['22P05', ValidationFailedError],
    ['22021', ValidationFailedError],
    ['22003', ValidationFailedError],
    ['22007', ValidationFailedError],
    ['22008', ValidationFailedError],
    ['22P02', ValidationFailedError],
    ['40001', ConflictError],
    ['40P01', ConflictError],
    ['CG001', ConflictError],
    ['57014', DataStoreUnavailableError],
    ['08006', DataStoreUnavailableError],
    ['53300', DataStoreUnavailableError],
    ['57P01', DataStoreUnavailableError],
    ['42P01', DataStoreError],
    ['23502', DataStoreError],
  ])('SQLSTATE %s maps to %o', (code, expected) => {
    const mapped = mapDatabaseError(dbError(code));
    expect(mapped).toBeInstanceOf(expected);
    expect(mapped).toBeInstanceOf(AppError);
    expect(serialised(mapped)).not.toMatch(/secret|INSERT INTO/);
  });

  it.each([
    ['22003', 'numeric_value_out_of_range', 'value "2147483648" is out of range for type integer'],
    [
      '22007',
      'invalid_datetime_format',
      'invalid input syntax for type timestamp with time zone: "garbage-secret"',
    ],
    [
      '22008',
      'datetime_field_overflow',
      'date/time field value out of range: "0000-01-01T00:00:00.000Z"',
    ],
    [
      '22P02',
      'invalid_text_representation',
      'invalid input syntax for type integer: "secret-text"',
    ],
  ])(
    '[NFR-SEC-05] SQLSTATE %s (%s) is a 422 with a fixed message that carries no value',
    (code, _name, driverMessage) => {
      const mapped = mapDatabaseError(dbError(code, { message: driverMessage, routine: 'int4in' }));
      expect(mapped).toBeInstanceOf(ValidationFailedError);
      expect(mapped).toMatchObject({
        code: 'validation_failed',
        status: 422,
        message: 'A value in the request is out of range or malformed',
      });
      expect((mapped as ValidationFailedError).issues).toEqual([
        { path: 'request', message: 'Check the numbers, dates and identifiers in the request' },
      ]);
      // The SQLSTATE stays available to the logs through the sanitised cause.
      expect(getDatabaseErrorCode(mapped)).toBe(code);
      expect(mapped.cause).toBeInstanceOf(SanitizedDatabaseError);
      expect(serialised(mapped)).not.toMatch(
        /secret|2147483648|0000-01-01|garbage|INSERT INTO|out of range for type/,
      );
    },
  );

  it('distinguishes row-level-security violations from missing privileges', () => {
    const rls = mapDatabaseError(
      dbError('42501', { message: 'new row violates row-level security policy for table "cases"' }),
    );
    expect(rls).toMatchObject({ code: 'tenant_violation', status: 403 });
    const privilege = mapDatabaseError(
      dbError('42501', { message: 'permission denied for table audit_events' }),
    );
    expect(privilege).toBeInstanceOf(ForbiddenError);
  });

  it('recognises connection failures and leaves non-database errors alone', () => {
    for (const failure of [
      Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'ECONNREFUSED' }),
      new Error('Connection terminated unexpectedly'),
      new Error('timeout exceeded when trying to connect'),
    ]) {
      const mapped = mapDatabaseError(failure);
      expect(mapped).toBeInstanceOf(DataStoreUnavailableError);
      expect(serialised(mapped)).not.toContain('10.0.0.5');
    }
    const appError = new ConflictError('already mapped');
    expect(mapDatabaseError(appError)).toBe(appError);
    const plain = new TypeError('programming error');
    expect(mapDatabaseError(plain)).toBe(plain);
    expect(mapDatabaseError('weird')).toBeInstanceOf(Error);
  });

  it('describes failures for health checks without secrets', () => {
    expect(describeFailure(dbError('28P01'))).toBe('database error 28P01');
    expect(describeFailure(Object.assign(new Error('boom'), { code: 'ETIMEDOUT' }))).toBe(
      'connection failure (ETIMEDOUT)',
    );
    expect(describeFailure(new Error('postgres://user:password@host/db'))).toBe(
      'database unreachable',
    );
  });
});

class FakeClient implements PgClientLike {
  readonly statements: { text: string; values?: unknown[] | undefined }[] = [];
  released: (Error | undefined)[] = [];
  failOn: RegExp | null = null;
  failWith: Error = new Error('boom');
  rollbackFails = false;
  results: Record<string, unknown> = {};

  async query(text: string, values?: unknown[]): Promise<unknown> {
    this.statements.push({ text, values });
    if (this.rollbackFails && text === 'ROLLBACK') throw new Error('socket closed');
    if (this.failOn?.test(text)) throw this.failWith;
    for (const [pattern, result] of Object.entries(this.results))
      if (text.includes(pattern)) return result;
    return { rows: [], rowCount: 0 };
  }
  release(error?: Error): void {
    this.released.push(error);
  }
}

function fakePool(
  client: FakeClient,
  extra: Partial<PgPoolLike> = {},
): PgPoolLike & { errorListeners: ((e: Error) => void)[]; ended: boolean } {
  const pool = {
    errorListeners: [] as ((e: Error) => void)[],
    ended: false,
    query: (text: string, values?: unknown[]) => client.query(text, values),
    connect: () => Promise.resolve(client),
    end: () => {
      pool.ended = true;
      return Promise.resolve();
    },
    onError: (listener: (e: Error) => void) => {
      pool.errorListeners.push(listener);
    },
    ...extra,
  };
  return pool;
}

describe('PgDatabase (driven through a fake pool)', () => {
  it('normalises rows, passes parameters and uses the last result of a multi-statement script', async () => {
    const client = new FakeClient();
    client.results['FROM t'] = {
      rows: [{ at: new Date('2024-01-02T03:04:05.000Z'), n: 7n }],
      rowCount: 1,
    };
    client.results['multi'] = [
      { rows: [], rowCount: 0 },
      { rows: [{ ok: true }], rowCount: 1 },
    ];
    const db = new PgDatabase(fakePool(client));
    const one = await db.query('SELECT * FROM t WHERE id = $1', ['a']);
    expect(one).toEqual({ rows: [{ at: '2024-01-02T03:04:05.000Z', n: 7 }], rowCount: 1 });
    expect(client.statements[0]).toEqual({ text: 'SELECT * FROM t WHERE id = $1', values: ['a'] });
    expect(await db.query('SELECT 1; multi')).toEqual({ rows: [{ ok: true }], rowCount: 1 });
    // Without parameters pg is called without a values array, which selects the simple protocol.
    expect(client.statements[1]?.values).toBeUndefined();
  });

  it('wraps work in BEGIN/COMMIT on one connection and releases it', async () => {
    const client = new FakeClient();
    const db = new PgDatabase(fakePool(client));
    const value = await db.transaction(async (tx) => {
      await tx.query('SELECT 1');
      return 'done';
    });
    expect(value).toBe('done');
    expect(client.statements.map((s) => s.text)).toEqual(['BEGIN', 'SELECT 1', 'COMMIT']);
    expect(client.released).toEqual([undefined]);
  });

  it('rolls back, maps the error and returns the connection when the work fails', async () => {
    const client = new FakeClient();
    client.failOn = /BOOM/;
    client.failWith = Object.assign(new Error('violates'), {
      code: '23505',
      severity: 'ERROR',
      constraint: 'cases_pkey',
    });
    const db = new PgDatabase(fakePool(client));
    await expect(db.transaction((tx) => tx.query('BOOM'))).rejects.toBeInstanceOf(ConflictError);
    expect(client.statements.map((s) => s.text)).toEqual(['BEGIN', 'BOOM', 'ROLLBACK']);
    expect(client.released).toEqual([undefined]);

    const appFailure = new Error('application failure');
    await expect(
      db.transaction(async () => {
        throw appFailure;
      }),
    ).rejects.toBe(appFailure);
  });

  it('destroys a connection whose ROLLBACK failed instead of pooling it', async () => {
    const client = new FakeClient();
    client.rollbackFails = true;
    const warnings: string[] = [];
    const db = new PgDatabase(fakePool(client), { warn: (message) => warnings.push(message) });
    await expect(
      db.transaction(async () => {
        throw new Error('work failed');
      }),
    ).rejects.toThrow('work failed');
    expect(client.released).toHaveLength(1);
    expect(client.released[0]).toBeInstanceOf(Error);
    expect(warnings[0]).toMatch(/ROLLBACK failed/);
  });

  it('[NFR-SEC-01] withTenant switches role and sets the tenant inside the transaction, before any work', async () => {
    const client = new FakeClient();
    const db = new PgDatabase(fakePool(client));
    await db.withTenant({ tenantId: 'tenant_a', actorId: 'user_x' }, (tx) =>
      tx.query('SELECT * FROM cases'),
    );
    expect(client.statements).toEqual([
      { text: 'BEGIN', values: undefined },
      { text: 'SET LOCAL ROLE caseguard_app', values: undefined },
      { text: "SELECT set_config('app.tenant_id', $1, true)", values: ['tenant_a'] },
      { text: 'SELECT * FROM cases', values: undefined },
      { text: 'COMMIT', values: undefined },
    ]);
    await expect(
      db.withTenant({ tenantId: '', actorId: 'x' }, async () => 1),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('maps connection failures, reports health and ends the pool', async () => {
    const client = new FakeClient();
    const pool = fakePool(client, {
      connect: () =>
        Promise.reject(
          Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:5432'), { code: 'ECONNREFUSED' }),
        ),
    });
    const warnings: Record<string, unknown>[] = [];
    const db = new PgDatabase(pool, { warn: (_m, fields) => warnings.push(fields ?? {}) });
    await expect(db.transaction(async () => 1)).rejects.toBeInstanceOf(DataStoreUnavailableError);

    pool.errorListeners[0]?.(new Error('idle client lost'));
    expect(warnings[0]).toMatchObject({ reason: 'database unreachable' });

    client.failOn = /SELECT 1/;
    client.failWith = Object.assign(new Error('down'), { code: 'ECONNRESET' });
    const unhealthy = await db.ping();
    expect(unhealthy.ok).toBe(false);
    expect(unhealthy.detail).toContain('ECONNRESET');
    expect(unhealthy.detail).not.toContain('10.1.2.3');
    client.failOn = null;
    expect(await db.ping()).toMatchObject({ ok: true });
    await db.close();
    expect(pool.ended).toBe(true);
  });
});

describe('Microsoft Entra password provider (fake token source only; not validated against Azure)', () => {
  it('caches tokens until shortly before expiry and shares one in-flight acquisition', async () => {
    let now = 1_000_000;
    let calls = 0;
    const provider = createEntraPasswordProvider(
      {
        getToken: async (scope) => {
          calls += 1;
          expect(scope).toBe(ENTRA_POSTGRES_SCOPE);
          return { token: `token-${calls}`, expiresOnTimestamp: now + 3_600_000 };
        },
      },
      { now: () => now, refreshSkewMs: 300_000 },
    );
    expect(ENTRA_POSTGRES_SCOPE).toBe('https://ossrdbms-aad.database.windows.net/.default');
    const concurrent = await Promise.all([provider(), provider(), provider()]);
    expect(concurrent).toEqual(['token-1', 'token-1', 'token-1']);
    expect(calls).toBe(1);
    now += 3_000_000;
    expect(await provider()).toBe('token-1');
    now += 400_000; // inside the 5-minute refresh window
    expect(await provider()).toBe('token-2');
  });

  it('fails clearly when no token is returned and retries on the next connection', async () => {
    let answer: { token: string; expiresOnTimestamp: number } | null = null;
    const provider = createEntraPasswordProvider({ getToken: async () => answer });
    await expect(provider()).rejects.toThrow(/did not return an access token/);
    answer = { token: 'ok', expiresOnTimestamp: Date.now() + 3_600_000 };
    expect(await provider()).toBe('ok');
  });
});

describe('ids and hashing', () => {
  it('generates prefixed, 26-character Crockford ids that sort by creation time', () => {
    let clock = 1_700_000_000_000;
    const next = createIdGenerator({ now: () => clock });
    const a = next('case');
    const b = next('case'); // same millisecond: strictly increasing
    clock += 1;
    const c = next('case');
    expect(a).toMatch(/^case_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect([a, b, c]).toEqual([a, b, c].slice().sort());
    expect(new Set([a, b, c]).size).toBe(3);
    expect(isGeneratedId(a, 'case')).toBe(true);
    expect(isGeneratedId(a, 'job')).toBe(false);
    expect(isGeneratedId('case_ILOU')).toBe(false);
    expect(() => next('Bad Prefix')).toThrow(TypeError);
    clock -= 1000; // a clock that jumps backwards must not break ordering
    expect(next('case') > c).toBe(true);
  });

  it('carries the randomness counter and borrows the next millisecond on overflow', () => {
    const allOnes = () => new Uint8Array(16).fill(31);
    const next = createIdGenerator({ now: () => 5, random: allOnes });
    const first = next('aud');
    const second = next('aud');
    expect(second > first).toBe(true);
    expect(second.slice(4, 14)).not.toBe(first.slice(4, 14));
  });

  it('hashes known vectors and produces canonical JSON', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex(new Uint8Array([97, 98, 99]))).toBe(sha256Hex('abc'));
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: undefined }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"z":1}]},"b":1}',
    );
    expect(canonicalJson([undefined, () => 1])).toBe('[null,null]');
    expect(canonicalJson(new Date('2024-01-02T03:04:05.000Z'))).toBe('"2024-01-02T03:04:05.000Z"');
    expect(canonicalJson('ünï')).toBe('"ünï"');
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson({ v: 1n })).toThrow(TypeError);
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
  });
});

describe('SQL helpers', () => {
  class Recorder implements SqlExecutor {
    readonly calls: { text: string; params: readonly unknown[] | undefined }[] = [];
    async query<T>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>> {
      this.calls.push({ text, params });
      return { rows: [], rowCount: 1 };
    }
  }
  interface Row {
    id: string;
    tenant: string;
    n: number;
    meta: unknown;
    tags: string[];
  }
  const spec: TableSpec<Row> = {
    table: 'things',
    key: ['tenant_id', 'id'],
    columns: [
      col('tenant_id', 'text', (r: Row) => r.tenant),
      col('id', 'text', (r) => r.id),
      col('n', 'int', (r) => r.n),
      col('tags', 'text[]', (r) => r.tags),
      col('data', 'jsonb', (r) => r.meta),
    ],
  };
  const row = (id: string): Row => ({ id, tenant: 't', n: 1, meta: { a: [1] }, tags: ['x'] });

  it('builds parameterised WHERE clauses without putting values in the SQL', () => {
    const q = new QueryBuilder();
    q.where(`tenant_id = ${q.bind('t1')}`).where(`status = ${q.bind("x'; DROP TABLE cases; --")}`);
    expect(q.clause).toBe('tenant_id = $1 AND status = $2');
    expect(q.params).toEqual(['t1', "x'; DROP TABLE cases; --"]);
    expect(new QueryBuilder().clause).toBe('TRUE');
  });

  it('chunks multi-row inserts below the bind-parameter limit and serialises jsonb as text', async () => {
    const tx = new Recorder();
    const rows = Array.from({ length: 9_000 }, (_, i) => row(`id_${i}`));
    const written = await insertRows(tx, spec, rows);
    expect(written).toBe(tx.calls.length); // the recorder reports one row per statement
    expect(tx.calls.length).toBeGreaterThan(1);
    expect(tx.calls.every((c) => (c.params?.length ?? 0) <= 20_000)).toBe(true);
    expect(tx.calls.reduce((sum, c) => sum + (c.params?.length ?? 0), 0)).toBe(9_000 * 5);
    expect(tx.calls[0]?.text).toMatch(
      /^INSERT INTO things \(tenant_id, id, n, tags, data\) VALUES \(\$1::text, \$2::text, \$3::integer, \$4::text\[\], \$5::jsonb\)/,
    );
    expect(tx.calls[0]?.params?.slice(0, 5)).toEqual(['t', 'id_0', 1, ['x'], '{"a":[1]}']);
    expect(await insertRows(new Recorder(), spec, [])).toBe(0);
  });

  it('upserts and ignores on the primary key without touching key columns', async () => {
    const upsert = new Recorder();
    await insertRows(upsert, spec, [row('a')], 'upsert');
    expect(upsert.calls[0]?.text).toContain(
      'ON CONFLICT (tenant_id, id) DO UPDATE SET n = EXCLUDED.n, tags = EXCLUDED.tags, data = EXCLUDED.data',
    );
    const ignore = new Recorder();
    await insertRows(ignore, spec, [row('a')], 'ignore');
    expect(ignore.calls[0]?.text).toContain('ON CONFLICT (tenant_id, id) DO NOTHING');
  });

  it('updates by primary key with an optional version predicate and column subset', async () => {
    const tx = new Recorder();
    await updateRow(tx, spec, row('a'), { columns: ['n', 'data'], expectedVersion: 3 });
    expect(tx.calls[0]).toEqual({
      text: 'UPDATE things SET n = $1::integer, data = $2::jsonb WHERE tenant_id = $3::text AND id = $4::text AND version = $5::integer',
      params: [1, '{"a":[1]}', 't', 'a', 3],
    });
    const all = new Recorder();
    await updateRow(all, spec, row('a'));
    expect(all.calls[0]?.text).toBe(
      'UPDATE things SET n = $1::integer, tags = $2::text[], data = $3::jsonb WHERE tenant_id = $4::text AND id = $5::text',
    );
  });
});
