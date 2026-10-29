# Data tier (`apps/api/src/db`, `apps/api/src/storage`)

PostgreSQL persistence for the CaseGuard API, written against the frozen contract in
`repositories/types.ts`. Everything runs unchanged on **PGlite** (in-process PostgreSQL, used for local
development and tests) and on **PostgreSQL 16** (production).

```
client.ts            createDatabase({ url, auth?, poolMax? }) -> Database (pg pool or PGlite)
migrate.ts           migrate(db), getMigrationStatus(db); migrate-cli.ts is `pnpm db:migrate`
migrations/*.sql     the full schema (tables, indexes, triggers, RLS, grants)
repositories/        one class per interface in types.ts; createRepositories(db, deps?)
                     (specs-*.ts hold the entity <-> table projections, re-exported by table-specs.ts)
seed.ts              seedFoundation(db), DEV_PERSONAS (synthetic tenants and users)
testing.ts           createTestDatabase(), createTestRepositories(), fault injection
../storage/          ObjectStore (local directory, Azure Blob), tenant-scoped keys
```

## Using it

```ts
const db = await createDatabase({ url: process.env.DATABASE_URL, auth: 'password' });
await migrate(db); // when DB_AUTO_MIGRATE
const repositories = createRepositories(db);
const repos = repositories.forTenant({ tenantId, actorId }); // derived from the validated token only
const page = await repos.cases.list({ limit: 50 });
await repos.transaction(async (r) => {
  // use `r`, not `repos`: `r` is bound to one transaction (all-or-nothing)
});
```

## Tenant isolation (NFR-SEC-01)

1. Every repository statement filters by `tenant_id` and every write checks the entity's tenant.
2. Every tenant table has `ENABLE` + `FORCE ROW LEVEL SECURITY` with the policy
   `tenant_id = nullif(current_setting('app.tenant_id', true), '')`.
3. `withTenant` runs `SET LOCAL ROLE caseguard_app` and `set_config('app.tenant_id', …, true)` inside a
   transaction, so the settings vanish at commit/rollback and cannot leak to the next request.
4. Foreign keys are composite and include `tenant_id`.

**PostgreSQL superusers (and roles with `BYPASSRLS`) bypass row-level security, even when it is forced.**
Production must connect as a non-superuser that is a member of `caseguard_app`
(`GRANT caseguard_app TO <login role>` if a DBA created the role). PGlite always runs as a superuser,
which is why the role switch happens in every tenant-scoped transaction. The test suite also proves
that migrations, seeding and the repositories work when a non-superuser owns the schema.

## Immutability and erasure (FR-ING-07)

- `case_sources`, `case_events`, `case_resolutions` and `audit_events` have triggers that reject UPDATE and
  DELETE. The application role has no UPDATE/DELETE privilege on them at all.
- `CaseRepository.delete` (administrator erasure) and the demo reset set `app.allow_erasure = on` for the
  duration of one statement; the triggers then allow the cascade from `cases` (DELETE only, never UPDATE).
  Audit events are never deletable. The setting protects against accidents and bugs, **not** against
  someone who can run arbitrary SQL as `caseguard_app`.
- Audit events form a per-tenant hash chain (`sha256(prevHash + "\n" + canonicalJson(event))`, genesis
  `prevHash` is 64 zeros). `verify()` reports the first invalid sequence. A DBA who removes the _tail_ of a
  chain or rewrites every later event consistently is only detectable against an externally anchored head
  hash, which is not implemented.

## Conventions

- Tables carry relational columns for filtering/sorting and `data jsonb` with the whole Zod-validated
  entity; reads re-validate `data` and throw `DataIntegrityError` instead of returning junk.
- Case child tables are keyed `(tenant_id, case_id, id)`: ids that come from a bundle only need to be
  unique inside one case.
- Timestamps are `timestamptz` written with millisecond precision; drivers return ISO strings ending in
  `Z`. Numbers are `integer`/`double precision` (no bigint).
- Keyset cursors are opaque (`base64url(JSON).checksum`), bound to the list they were issued for, and
  invalid ones raise `ValidationFailedError`. Page size is 1–200.
- jsonb parameters are passed as JSON text (`toJsonParam`); arrays are only allowed for `text[]` columns.

## PGlite vs PostgreSQL differences handled in code

| Topic                    | PGlite                                                                                                                                       | PostgreSQL (`pg`)                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Connections              | one; transactions are serialised, so a call on `db` inside a transaction callback would wait forever. It throws a descriptive error instead. | pool; each `transaction` pins one connection                                                                |
| Advisory locks           | not needed (skipped)                                                                                                                         | `pg_advisory_xact_lock` serialises audit appends and same-content ingests per tenant                        |
| Server version           | PostgreSQL 18                                                                                                                                | 16; the SQL avoids anything newer than 16                                                                   |
| Parameterless statements | `exec` (simple protocol, multi-statement)                                                                                                    | `query(text)` (simple protocol)                                                                             |
| Result types             | custom `parsers` for timestamptz/int8/numeric                                                                                                | `types.getTypeParser` override with the same functions                                                      |
| Role                     | always superuser                                                                                                                             | must be a non-superuser member of `caseguard_app`                                                           |
| Auth / TLS               | none                                                                                                                                         | `DATABASE_AUTH=entra` (token as password) and `sslmode` in the URL, **not validated against a live server** |

A file-backed PGlite directory (`pglite://.data/caseguard`) must be opened by one process at a time.

## Tests

`pnpm exec vitest run` in `apps/api`. Integration tests (`*.int.test.ts`) use one in-memory PGlite per file
and reset it between tests. Set `TEST_DATABASE_URL` (a **superuser** connection to a throwaway database)
to run the same suites on real PostgreSQL in a private schema per test file; that path has not been
exercised here.
