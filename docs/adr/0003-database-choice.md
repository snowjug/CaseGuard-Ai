# ADR 0003: PostgreSQL with PGlite for local and test, tenant keys and row-level security

- Status: Accepted
- Date: 2026-10-29
- Deciders: project owner and architect

## Context

Tenant isolation is the highest-impact failure (NFR-SEC-01, T6). Case sources, events and audit records must be
immutable (T3, T4), analysis payloads change shape as the model evolves, and the demo must run without Docker
(NFR-DX-01). Local, CI and Azure should share one SQL dialect.

## Decision

- **PostgreSQL** is the system of record (Azure Database for PostgreSQL Flexible Server in Azure).
- **PGlite** (PostgreSQL compiled to WASM, in process) is the zero-dependency engine for local development and
  most tests (`DATABASE_URL=pglite://...`). CI also runs the integration suite against a real `postgres:16`
  service container (assumption A-11) so dialect drift is caught.
- **Hybrid relational plus JSONB.** Identity, tenancy, status, ordering and anything queried is relational;
  evolving analysis payloads (hypothesis trees, scenario detail) are JSONB validated by Zod at the boundary.
- **Composite tenant keys.** Every tenant-owned table has `tenant_id text not null`, primary key
  `(tenant_id, id)` and composite foreign keys that include `tenant_id`, so a row cannot reference another
  tenant's row even by mistake.
- **Row-level security** on `current_setting('app.tenant_id')`, forced on every tenant table. Each transaction
  sets the tenant and runs `SET LOCAL ROLE caseguard_app`, because superusers bypass RLS even when forced.
  PGlite and the compose PostgreSQL connect as superusers, which is why the role switch is mandatory; production
  must also connect as a non-superuser member of `caseguard_app`. The application layer additionally scopes
  every query by tenant.
- **Text identifiers**: generated ids are `<prefix>_<26-char ULID-like>`, seeded data uses readable slugs, and
  analysis artefacts get deterministic ids from `(caseId, stable key)` so re-runs replace and carry reviews
  forward.
- **Plain SQL migrations** (`NNNN_name.sql`) applied by a small runner that records checksums and refuses to run
  when an applied file changed; production runs them as a separate job.

## Consequences

- Good: defence in depth for isolation (key shape, RLS, application scoping); one dialect everywhere; no
  external database needed to try the product.
- Bad: PGlite is single-connection and not identical to managed PostgreSQL; RLS parity on the managed service
  must be verified during the first deployment (residual risk in the threat model).
- Bad: text keys are larger than UUIDs or integers; JSONB payloads need schema versioning discipline.

## Alternatives considered

- **SQLite for local and test:** a second dialect with different JSON, locking and RLS behaviour.
- **Cosmos DB or MongoDB:** weaker relational integrity and no row-level security equivalent for this model.
- **Fully relational (no JSONB):** a migration for every analysis-shape change.
- **UUID or serial keys:** hide intent and make deterministic artefact ids and readable seeds harder.
