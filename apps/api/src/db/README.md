# Data tier (`apps/api/src/db`, `apps/api/src/storage`)

PostgreSQL persistence for the CaseGuard API, written against the frozen contract in
`repositories/types.ts`. Everything runs unchanged on **PGlite** (in-process PostgreSQL, used for local
development and tests) and on **PostgreSQL 16** (production).

```
client.ts            createDatabase({ url, auth?, poolMax? }) -> Database (pg pool or PGlite)
migrate.ts           migrate(db), getMigrationStatus(db); migrate-cli.ts is `pnpm db:migrate`
migrations/*.sql     the full schema (tables, indexes, triggers, RLS, grants)
repositories/        one class per interface in types.ts; createRepositories(db, deps?)
                     (specs-*.ts hold the entity <-> table projections, re-exported by table-specs.ts;
                     analysis-read-models.ts holds the cross-case dashboard read models)
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

## Entra just-in-time user sync (NFR-SEC-02)

`governance.upsertIdentityUser({ userId, displayName, email, roles, synthetic })` keeps the `users` row of
the scoped tenant in step with the identity provider. The token is the source of truth for roles.

- Absent: inserted as `active`, version 1 (`created_by` = the scope's actor). A missing e-mail is stored as `''`.
- Present: display name, e-mail and roles are replaced; `status`, `createdAt` and `synthetic` are never touched
  (an administrator may have disabled the user). `updatedAt` and `version` move only when something changed,
  so repeated sign-ins write nothing. A `null` e-mail does not erase a stored address.
- Roles are de-duplicated and stored in the order of `ROLES`; a different order is not a change.
- Text from the token is cleaned (control characters, runs of blanks) and the display name is cut to 120
  characters, with the e-mail and then the user id as fallbacks, so odd directory data never blocks a sign-in.
- Concurrent first sign-ins are safe (`INSERT ... ON CONFLICT DO NOTHING`, then a locked update). It writes no
  audit rows; the caller audits role changes.
- Migration 0007 grants `INSERT` on `users` to `caseguard_app` for this (row-level security still confines
  the row to the caller's tenant) and replaces the unique e-mail index with a plain one: Entra's `mail`
  attribute is neither unique nor always present, and accounts are identified by id.

## Full-text search (FR-UX-04)

`tenantRepos.search.query({ text, limit })` returns `SearchHit[]` (`type`, `id`, `caseId`, `title`, `snippet`,
`score`; the service adds `href`). It searches case title/reference/tags, event title/body (bodies are already
redacted), claims, hypotheses, skills and **open** warnings, with PostgreSQL full-text search (`english`
configuration) and no extension.

- Each searched table has a stored generated `search_tsv` column and a GIN index (migration 0007), so nothing
  in the application keeps an index current and existing rows are backfilled by the migration. Only the first
  100,000 characters of an event body are indexed (a `tsvector` is limited to 1 MiB).
- `text` uses web-search syntax (`websearch_to_tsquery`: words are ANDed, `"phrases"`, `or`, `-exclusion`).
  It only ever travels as a bind parameter; any input is accepted. Control characters are dropped, text is cut
  to 200 characters, and blank text, stop words only or exclusions only return `[]`. `limit` is 1..100.
- Ranking: `ts_rank` with the field weights title/reference (A) > label/tag/key (B) > body (C), normalised to
  [0, 1) and multiplied by a per-type weight (case 1, skill 0.9, hypothesis 0.85, warning 0.8, claim 0.7,
  event 0.6; `SEARCH_TYPE_WEIGHTS`). Exclusions are ignored when scoring. Ties break by type, case id and id.
- Snippets are plain text of at most 300 characters taken with `ts_headline` (empty quoted delimiters, so no
  markup is produced; a literal `<b>`/`</b>` in the quoted text is removed too). Treat them as text, never HTML.
- Tenant scope: every branch filters by `tenant_id` and runs under the same row-level security as the other
  repositories.
- **Index use under row-level security.** `@@` is not leakproof, so PostgreSQL does not use the GIN indexes for a
  role subject to a policy. For `caseguard_app` the statement reads the tenant's rows through the tenant_id
  indexes and tests each stored vector: correct and tenant-safe, about 50 ms for 20,000 cases on PGlite. The
  indexes serve sessions that bypass RLS, and become effective for the application role if a superuser runs
  `ALTER FUNCTION ts_match_vq(tsvector, tsquery) LEAKPROOF` (checked on PGlite; it edits `pg_catalog` and is not
  possible on managed PostgreSQL). Past that scale, use the external search provider instead.

## Dashboard read models (FR-UX-01)

The Command Center and the case list need figures that span cases. They are plain repository methods (no cache,
no extra tables) over the stored artefacts of each case's **latest analysis** (`cases.last_analysis_run_id`;
`saveSnapshot` replaces a case's artefacts in one transaction, so a figure never mixes two runs). Every
statement filters by `tenant_id` itself and also runs under row-level security; both are tested, the first
with row-level security bypassed.

- `analysis.summarize(caseIds: readonly string[]): Promise<CaseAnalysisSummary[]>` returns, per case,
  `{ caseId, qualityIndex, avoidableEffortPct, leadingHypothesis: { name, confidence } | null, openWarningCount }`
  (the analysis-derived fields of `CaseSummarySchema`). One statement serves the whole list (lateral lookups on
  each case's own key prefixes), however many ids; at most **200** ids, duplicates included, otherwise
  `ValidationFailedError` (`caseIds`; `caseIds.<n>` for an id that is not a non-empty string of at most 120
  characters without control characters). An empty list returns `[]` without touching the database.
  - It returns one entry per requested id **that is a case of this tenant**, in the requested order, duplicates
    collapsed. A case that was never analysed (or is only queued) is present with `null`, `null`, `null` and `0`.
    Ids that are not cases of the tenant, unknown or another tenant's, are **omitted**, so a caller cannot tell
    them apart.
  - `qualityIndex` is the stored quality assessment's composite score; `avoidableEffortPct` is the value of the
    stored `avoidable_support_effort` metric, `null` when its status is `unknown`; the leading hypothesis is the
    one with the highest current confidence (ties: lower ordinal, then id); `openWarningCount` counts warnings
    in state `open`, so dismissed and resolved ones are not included. A case being re-analysed keeps reporting
    its last stored analysis until the new one is saved.
- `analysis.listOpenWarnings({ limit })`: warnings in state `open` across the tenant, `critical` > `high` >
  `medium` > `low`, then most recently raised, then `rank`, case id and id. `limit` is 1..100.
- `analysis.listCriticalMissing({ limit, minCriticality? })`: missing evidence with `resolvedAt` null, from each
  case's latest run only, each item carrying its `caseId`. Ranked by `criticality` (`critical` > `important` >
  `helpful`, the only priority field of `MissingEvidenceSchema`), then `firstRelevantAt` newest first, then case
  id and id. By default every criticality is listed, best first, so a small `limit` shows the critical items;
  `minCriticality: 'critical'` (or `'important'`) restricts the list. `limit` is 1..100. The `minCriticality`
  option is an addition to the requested signature.
- `analysis.getHypothesis(caseId, hypothesisId)`: the stored hypothesis, or `null` when that case of this tenant
  has no such hypothesis.
- `cases.counts()`: `{ total, synthetic, byAnalysisState }` from one `GROUP BY`; every analysis state is present
  and zero when no case is in it.
- Migration 0008 adds two **partial indexes**, `case_warnings_open_idx` (`state = 'open'`) and
  `missing_evidence_open_idx` (`resolved_at IS NULL`), because most items end up closed and the tenant-wide lists
  only ever read the open ones. A test shows through `EXPLAIN` that the planner picks them for the application
  role. Measured once on PGlite as `caseguard_app` under row-level security with 4,000 cases, 20,000 warnings
  and 12,000 missing-evidence items: `summarize` of 200 ids about 11 ms, `counts` about 6 ms, the warning list
  7.6 ms to 4.1 ms and the missing-evidence list 8.7 ms to 6.6 ms with the indexes. These are not benchmarks of
  PostgreSQL 16.

## Migrations

`migrations/NNNN_name.sql`, applied in order, each in its own transaction, with a checksum recorded in
`schema_migrations`. **A released migration is never edited**: the runner refuses to continue against a
database that applied the old text, and `test/migrations.int.test.ts` pins the checksum of every released
file, so a schema change is always a new file. Add it to `MIGRATION_NAMES` in that test. `0007` adds search
and the identity-sync changes above; its upgrade path (data written under 0006) is tested. `0008` adds the
two partial indexes of the dashboard read models; the same test upgrades a database that stopped at 0006
through both.

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
| Full-text search         | verified here (generated `tsvector`, GIN, `websearch_to_tsquery`, `ts_headline` with empty quoted delimiters)                                | same features since PostgreSQL 12; the delimiter and plan behaviour above are **not verified** on 16        |
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
