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
- Erasing a case also erases what the idempotency store kept about it (next section).
- Audit events form a per-tenant hash chain (`sha256(prevHash + "\n" + canonicalJson(event))`, genesis
  `prevHash` is 64 zeros). `verify()` reports the first invalid sequence. A DBA who removes the _tail_ of a
  chain or rewrites every later event consistently is only detectable against an externally anchored head
  hash, which is not implemented.

## Idempotency keys and erasure (FR-ING-07)

A completed `Idempotency-Key` keeps its response for 24 hours so a retry can replay it, and that response
carries the case summary and injection excerpts of an ingest, or the job of a case. A retry must never replay
a case that was erased, so erasure reaches the idempotency store in two complementary ways:

- **By link.** `idempotency.complete(key, scope, status, response, { caseId })` stores the case the response
  is about in `idempotency_keys.case_id` (migration 0011: a composite foreign key to `cases` with
  `ON DELETE CASCADE`, and a partial index on the linked keys). The database then deletes the key in the same
  statement that deletes the case, whoever runs it. If `caseId` names a case that no longer exists (erased
  while the request ran) nothing is stored and the reservation is dropped, so the retry runs again instead of
  replaying erased data; the foreign key makes that airtight under concurrency (`complete` holds the case row
  with `FOR KEY SHARE`). A key can be linked to one case.
- **By content.** A key without a link (a caller that did not pass `caseId`, or a future route) is found by
  looking for the case id **as a whole word** in the stored response of the tenant's completed, unlinked keys:
  delimited by anything that cannot be part of an id, such as a JSON quote or the slash of a link, so `case_1`
  does not match `case_10`. It reads the tenant's unlinked keys (at most a day's worth), so it is the fallback;
  linking is the cheap path. Measured once on PGlite (WebAssembly, slower than a native server): 2,000 unlinked
  keys of 10 KB take about 0.4 s to search and 10,000 about 2.3 s (2,000 of 100 KB, about 5 s); once every
  response is linked there are no unlinked keys and nothing is searched.
- `idempotency.purgeForCase(caseId): Promise<number>` runs both for the tenant and says how many keys went
  (reserved keys hold no response and are left alone). **`CaseRepository.delete` already does it** in its own
  transaction, so erasing a case needs no separate call; calling it first, as api-cases may, simply returns the
  count and leaves nothing for `delete` to remove.
- `idempotency.purgeExpired(limit?: number): Promise<number>` deletes up to `limit` (default 1,000, at most
  10,000) of the tenant's expired keys, oldest first, and returns how many; call again while it returns
  `limit`. It is bound to the tenant of the repositories: there is no repository method that lists tenants
  (`tenants` is under forced row-level security, so a non-superuser connection cannot read it without a tenant),
  so a periodic sweep has to know the tenant ids. Concurrent sweeps share the work (`FOR UPDATE SKIP LOCKED`).
  The batch is a `MATERIALIZED` CTE on purpose: as a plain subquery of `DELETE ... USING` (or `IN`) the planner
  can re-run it for every row it joins, and every re-run takes the next `limit` rows that this statement has not
  deleted yet, so a batch of 5 silently becomes everything that expired (observed on PGlite; a regression
  test covers both the application role and a session without row-level security).
- What the HTTP binder should pass as `caseId`: `case.id` for `cases.create` and `cases.createFromFile`,
  `job.caseId` for `analysis.start`, `counterfactuals.run`, `skills.extract` and `skills.proposeMutation` (the
  source case) - or, for all but the creates, the `caseId` path parameter.

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

## Case references (FR-ING-08)

A case reference (`CG-SYN-1001`) is what people quote, and it is **unique within a tenant** (migration 0010,
`UNIQUE (tenant_id, reference)`, which also replaces the plain `cases_reference_idx`). The comparison is exact
and case-sensitive, as the service's check always was; another tenant may use the same reference.

- `cases.findByReference(reference): Promise<Case | null>` is the exact, tenant-bound lookup (through that
  unique index). A string that cannot be a reference (empty, over 200 characters, control characters) is a
  `ValidationFailedError`; anything else that matches nothing, however odd, is `null` (no pattern semantics).
- A case with different content under a used reference is refused by the database: `ingest` throws the
  existing `ConflictError` with `details.reason === 'duplicate'` and the message "A case with this reference
  already exists in this workspace" (the constraint, `cases_tenant_reference_uq`, is named in the sanitised
  cause for the logs). The ingest is one transaction, so nothing of the refused case is left, and what shares
  its transaction (the audit record) rolls back with it. Ingesting the same content again is still the
  idempotent replay, not a conflict. Two concurrent ingests under one new reference: one wins.
- **Upgrading a database that already holds two cases of a tenant with one reference** is refused by migration
  0010: it fails (SQLSTATE 23505 on `cases_tenant_reference_uq`, all or nothing) and the runner reports the
  migration name and constraint. List the pairs with
  `SELECT tenant_id, reference, count(*) FROM cases GROUP BY 1, 2 HAVING count(*) > 1;`, rename or erase all
  but one case of each (a rename must update both the `reference` column and `data->'reference'`), and run
  `pnpm db:migrate` again.

## Review decisions by target type

`reviews.list({ caseId?, targetType?, limit, cursor? })` lists decisions newest first (`decidedAt`, then id).
`targetType` is an exact match on the stored target type and must be one of `REVIEW_TARGETS` (`claim`, `fork`,
`counterfactual`, `warning`, `skill`, `skill_version`, `action_value`, `hypothesis`, `twin_field`): anything
else, including an empty string, is a `ValidationFailedError` (an unknown type can never match, so it is a
mistake worth a 422, not an empty page). It combines with `caseId`; a cursor continues the list it came from.
Filtering happens in the database, so only matching decisions are read, validated and returned.

Migration 0012 adds `review_decisions_type_idx (tenant_id, target_type, decided_at DESC, id DESC)` and
`review_decisions_case_type_idx (tenant_id, case_id, target_type, decided_at DESC, id DESC) WHERE case_id IS NOT
NULL`. Before them the tenant-wide list had to read and sort every decision of the type (and again for every
page), and the per-case list read all of a case's decisions to filter them. Measured once on PGlite as
`caseguard_app` under row-level security (30,000 decisions in a tenant, about 700 bytes each, 100 per case):
tenant and type, 427 matches, 14.7 ms and 412 buffers with a sort, now 0.4 ms and 54 buffers without; one type
within a case, 103 buffers, now 8. A test checks through `EXPLAIN` that the planner picks them and does not sort.

## Job liveness (heartbeat)

Jobs run inside the API process that accepted them (see `services/job-service.ts`). With more than one replica,
or an old and a new revision side by side during a rollout, a job's status alone cannot say whether anyone is
still running it, so migration 0009 adds `jobs.heartbeat_at`:

- `jobs.heartbeat(jobId)` refreshes `heartbeat_at` of a queued or running job and returns the status the
  database now has (`null` when the job does not exist). The owner calls it every few seconds, and a status
  other than queued/running (cancelled on another replica, failed as orphaned while the owner stalled) tells it
  to stop the work. A finished job keeps its last heartbeat.
- `jobs.failOrphaned(reason, { staleBefore? })` fails queued/running jobs of the tenant. Without `staleBefore`
  every one of them fails (a lone process that has just started). With it only jobs whose last sign of life,
  `coalesce(heartbeat_at, started_at, created_at)`, is at or before that ISO instant fail, so a job another
  replica is still heartbeating is left alone.

## Migrations

`migrations/NNNN_name.sql`, applied in order, each in its own transaction, with a checksum recorded in
`schema_migrations`. **A released migration is never edited**: the runner refuses to continue against a
database that applied the old text, and `test/migrations.int.test.ts` pins the checksum of every released
file, so a schema change is always a new file. Add it to `MIGRATION_NAMES` in that test. `0007` adds search
and the identity-sync changes above; its upgrade path (data written under 0006) is tested. `0008` adds the
two partial indexes of the dashboard read models; the same test upgrades a database that stopped at 0006
through both. `0009` adds the job heartbeat column. `0010` makes case references unique, `0011` links
idempotency keys to cases and `0012` indexes review decisions by target type; a database that stopped at 0009
upgrades through all three (also tested, including the refusal when references are duplicated). A migration
that fails is rolled back whole and reported with its name, the SQLSTATE and the constraint (no SQL, no values),
for example `Migration 0010_case_reference_unique failed and was rolled back (database error 23505 (table
cases, constraint cases_tenant_reference_uq))`. Application code needs the schema it was written for: run the
migrations before starting a new version (`DB_AUTO_MIGRATE` does).

## Conventions

- Tables carry relational columns for filtering/sorting and `data jsonb` with the whole Zod-validated
  entity; reads re-validate `data` and throw `DataIntegrityError` instead of returning junk.
- Case child tables are keyed `(tenant_id, case_id, id)`: ids that come from a bundle only need to be
  unique inside one case.
- Timestamps are `timestamptz` written with millisecond precision; drivers return ISO strings ending in
  `Z`. Numbers are `integer`/`double precision` (no bigint).
- Keyset cursors are opaque (`base64url(JSON).checksum`), bound to the list they were issued for, and
  invalid ones raise `ValidationFailedError`. Page size is 1–200. The checksum is an integrity check, not a
  secret (anyone can compute it), so decoding also **range-checks every value**: timestamps must be real UTC
  instants in millisecond form with years 0001-9999 (`2026-02-30` and year 0 are refused, as PostgreSQL does),
  integers must be non-negative and fit a PostgreSQL `integer`, and text sort keys must be ids under the rules
  of `IdSchema`. Whatever decodes is safe to bind as `integer`, `timestamptz` or `text`; a forged cursor is a
  422, never a database error (tested with valid checksums for every list, and by comparing what the decoder
  accepts with what PostgreSQL reads). As a second line, SQLSTATE 22003, 22007, 22008 and 22P02 (and 22021,
  22P05) from any statement are mapped to `ValidationFailedError` with a fixed message that carries no value or
  SQL.
- jsonb parameters are passed as JSON text (`toJsonParam`); arrays are only allowed for `text[]` columns.

## PGlite vs PostgreSQL differences handled in code

| Topic                    | PGlite                                                                                                                                       | PostgreSQL (`pg`)                                                                                                                                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connections              | one; transactions are serialised, so a call on `db` inside a transaction callback would wait forever. It throws a descriptive error instead. | pool; each `transaction` pins one connection                                                                                                                                                                                                  |
| Advisory locks           | not needed (skipped)                                                                                                                         | `pg_advisory_xact_lock` serialises audit appends and same-content ingests per tenant                                                                                                                                                          |
| Races between sessions   | one connection, so nothing interleaves and these cannot be exercised                                                                         | `FOR UPDATE SKIP LOCKED` (purge batches), `FOR KEY SHARE` with the foreign key (an idempotent response against an erasure) and the unique index (two ingests of one reference) rely on PostgreSQL's locking by design; **not exercised here** |
| Server version           | PostgreSQL 18                                                                                                                                | 16; the SQL avoids anything newer than 16                                                                                                                                                                                                     |
| Full-text search         | verified here (generated `tsvector`, GIN, `websearch_to_tsquery`, `ts_headline` with empty quoted delimiters)                                | same features since PostgreSQL 12; the delimiter and plan behaviour above are **not verified** on 16                                                                                                                                          |
| Parameterless statements | `exec` (simple protocol, multi-statement)                                                                                                    | `query(text)` (simple protocol)                                                                                                                                                                                                               |
| Result types             | custom `parsers` for timestamptz/int8/numeric                                                                                                | `types.getTypeParser` override with the same functions                                                                                                                                                                                        |
| Role                     | always superuser                                                                                                                             | must be a non-superuser member of `caseguard_app`                                                                                                                                                                                             |
| Auth / TLS               | none                                                                                                                                         | `DATABASE_AUTH=entra` (token as password) and `sslmode` in the URL, **not validated against a live server**                                                                                                                                   |

A file-backed PGlite directory (`pglite://.data/caseguard`) must be opened by one process at a time.

## Tests

`pnpm exec vitest run` in `apps/api`. Integration tests (`*.int.test.ts`) use one in-memory PGlite per file
and reset it between tests. Set `TEST_DATABASE_URL` (a **superuser** connection to a throwaway database)
to run the same suites on real PostgreSQL in a private schema per test file; that path has not been
exercised here.
