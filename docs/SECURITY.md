# Security architecture

This document describes the security controls that exist in the code today, how they fit together and what they do not
cover. It maps to [THREAT_MODEL.md](THREAT_MODEL.md) (threat ids `T1` to `T15`, `AI-1` to `AI-8`) instead of repeating
it. Vulnerability reporting is in the repository root [SECURITY.md](../SECURITY.md). Related: [ARCHITECTURE.md](ARCHITECTURE.md),
[DATA_MODEL.md](DATA_MODEL.md), [AI_ORCHESTRATION.md](AI_ORCHESTRATION.md), [PRIVACY.md](PRIVACY.md),
[ENTRA_ID_SETUP.md](ENTRA_ID_SETUP.md).

CaseGuard AI is a hackathon prototype for **synthetic data only**. The controls are written to be deployable, but nothing
has been deployed, no penetration test has been done and no external review has taken place.

## 1. Status legend and control summary

| Label                   | Meaning                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| **Implemented, tested** | Code exists and automated tests in this repository exercise it (local PGlite, fakes, mocks).  |
| **Mock-validated**      | Code exists and was exercised against local mocks only; never against the real Azure service. |
| **Designed only**       | Described in the design or the infrastructure template; no code or never executed.            |

| Control                                                                                                                                           | Where                                                                    | Status                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Development persona login (header) with environment guards                                                                                        | `packages/security/src/auth/dev.ts`, `factory.ts`                        | Implemented, tested                                                                                                                                                         |
| Microsoft Entra access-token validation (`jose`)                                                                                                  | `packages/security/src/auth/entra.ts`                                    | **Mock-validated** (locally generated keys); never run against a live tenant                                                                                                |
| Browser sign-in with MSAL (redirect + silent token)                                                                                               | `apps/web/src/lib/auth/entra.tsx`                                        | **Mock-validated** (unit tests with a fake MSAL instance)                                                                                                                   |
| Deny-by-default RBAC, a declared permission per route (three routes declare none)                                                                 | `packages/security/src/rbac.ts`, route registry                          | Implemented, tested                                                                                                                                                         |
| Tenant derived from the credential only; tenant-scoped repositories, `assertSameTenant` checks                                                    | `apps/api/src/db`, `packages/security/src/tenant.ts`                     | Implemented, tested                                                                                                                                                         |
| Composite foreign keys + forced row-level security                                                                                                | SQL migrations 0001 to 0012                                              | Implemented, tested on PGlite; **not run against managed PostgreSQL**                                                                                                       |
| Authentication before body parsing; throttling before authentication                                                                              | `apps/api/src/http/lifecycle.ts`, `route-binder.ts`                      | Implemented, tested (`http-hardening.test.ts`); 401 and 403 answers are throttled too                                                                                       |
| Per-visitor rate-limit key behind the web tier: the web server sets `x-cg-client-ip`, the API believes it only with `TRUST_CLIENT_IP_HEADER=true` | `apps/web/src/lib/api-forward.ts`, `apps/api/src/http/client-address.ts` | Implemented, tested with **simulated headers only**; never observed behind a real Container Apps ingress; **no configuration guard** against enabling it on a reachable API |
| Request validation, size limits, problem+json errors                                                                                              | `apps/api/src/http/*`                                                    | Implemented, tested                                                                                                                                                         |
| Idempotency keys on routes marked `idempotent`; private to the calling user                                                                       | `apps/api/src/http/idempotency.ts`, `db/repositories`, route binder      | Implemented, tested (`http-hardening.test.ts`)                                                                                                                              |
| Upload validation from bytes; malware scanning hook                                                                                               | `packages/security/src/files/*`                                          | Validation implemented, tested; **scanner is a stub** (no real malware scanning)                                                                                            |
| Redaction before persistence and before prompts                                                                                                   | `packages/security/src/redaction/*`, ingestion                           | Implemented, tested; pattern-based                                                                                                                                          |
| Prompt-injection screening                                                                                                                        | `packages/security/src/injection/*`                                      | Implemented, tested; **heuristic, evadable**                                                                                                                                |
| AI output validation (seven validators), no tools, data blocks                                                                                    | `packages/ai/src`                                                        | Implemented, tested                                                                                                                                                         |
| Outbound URL guard (SSRF)                                                                                                                         | `packages/security/src/url-safety.ts`                                    | Implemented, tested; used for the Azure AI Search endpoint; text-level only                                                                                                 |
| Security headers, CSP, CORS allow-list                                                                                                            | `packages/security/src/headers.ts`, API + web                            | Implemented, tested                                                                                                                                                         |
| Secret wrapper, log redaction, secret scanning                                                                                                    | `packages/config`, `packages/observability`, `scripts/scan-secrets.mjs`  | Implemented, tested                                                                                                                                                         |
| Tamper-evident audit log (hash chain)                                                                                                             | `apps/api/src/db`                                                        | Implemented, tested; **no external anchor**                                                                                                                                 |
| Managed identity to Azure services; Key Vault                                                                                                     | `infra/bicep`, `packages/ai`, storage adapter                            | **Designed only** (never deployed); adapters mock-validated                                                                                                                 |
| CI security jobs, CodeQL, dependency review, Dependabot                                                                                           | `.github/workflows`, `.github/dependabot.yml`                            | Defined; I could not verify that they have run on GitHub                                                                                                                    |

## 2. Identity and authentication

The authenticator is built **once at start-up** (`createAuthenticator` in `apps/api/src/container.ts`). An unsafe
combination aborts the process before it listens.

### 2.1 Development personas

- Header `x-cg-persona: <userId>` selects one of the **seeded** development personas (`DEV_PERSONAS` in
  `apps/api/src/db/seed.ts`). The tenant comes from the seed list and the roles and `disabled` flag from the stored user
  row, so the header cannot choose an arbitrary tenant or role.
- **Anyone who can reach the API can send the header.** It is acceptable only for synthetic data on a developer machine
  or a throw-away demo. The API says so in `GET /api/v1/dev/personas` and in the session notices.
- Allowed only when `AUTH_MODE=dev` **and** `DEV_AUTH_ENABLED=true` **and** `APP_ENV` is `local` or `test`
  (`DEV_AUTH_ALLOWED_ENVIRONMENTS`). `development` (the internet-facing Azure development environment), `staging`,
  `production` and any unknown value are refused at construction (`AuthConfigurationError`). The configuration loader
  refuses the same combinations at start-up (a `ConfigError` naming `AUTH_MODE` or `DEV_AUTH_ENABLED`); the authenticator
  is the second lock.
- Outside `local` and `test` (`development`, `staging`, `production`), `DEV_AUTH_ENABLED=true` is refused **even with
  `AUTH_MODE=entra`**.
- CORS only advertises the `x-cg-persona` header when dev auth is on (`apps/api/src/http/security.ts`).
- The web app stores the chosen persona in `localStorage` and a `SameSite=Strict` cookie and sends the header; the API
  reads **only the header**, never the cookie.

### 2.2 Microsoft Entra ID

`EntraJwtAuthenticator` validates `Authorization: Bearer <access token>` with `jose`:

| Check             | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Failure reason (server side only)                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Header shape      | `Bearer` plus a base64url-like token; at most 16,384 characters                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `missing_credentials`, `malformed_credentials`                  |
| Signature and key | Remote JWKS (`createRemoteJWKSet`: 5 s timeout, 30 s cooldown, 10 min cache); algorithm allow-list defaults to `RS256`; `none` and `HS*` can never be configured                                                                                                                                                                                                                                                                                                                                                                       | `invalid_signature`, `invalid_algorithm`, `unknown_signing_key` |
| Issuer            | Exactly the configured issuer: v2 `https://login.microsoftonline.com/<tid>/v2.0` is derived; a v1 issuer must be set explicitly with `ENTRA_ISSUER`                                                                                                                                                                                                                                                                                                                                                                                    | `invalid_issuer`                                                |
| Audience          | The configured `ENTRA_AUDIENCE`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `invalid_audience`                                              |
| Lifetime          | `exp` required; `exp`/`nbf` with 30 s tolerance (configurable up to 300 s)                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `token_expired`, `token_not_yet_valid`, `missing_claim`         |
| Tenant            | `tid` must be in `ENTRA_TENANT_MAP` (Entra tenant to CaseGuard tenant)                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `unknown_tenant`                                                |
| Subject           | `oid` must exist and be a valid id                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `missing_claim`, `malformed_token`                              |
| Roles             | The `roles` claim is mapped through `ENTRA_ROLE_MAP`; unknown app roles are dropped; no mapped role gives **403**                                                                                                                                                                                                                                                                                                                                                                                                                      | (403 `No CaseGuard role is assigned`)                           |
| User directory    | Just-in-time provisioning (`apps/api/src/identity-sync.ts`): the first request of a user, and any change of display name, e-mail or roles, is written to the tenant's user list (profile re-synced at most every 5 minutes; a token without an e-mail keeps the stored one). The stored user is read on every request; a stored `disabled` user always wins and gives 401, but **no API route sets `disabled`** (it has to be set in the database). A failed write is logged (`identity.sync_failed`) and falls back to the stored row | `user_disabled`                                                 |

Clients always receive a generic `401 Authentication failed` (with `WWW-Authenticate`); the reason goes to the log line
`auth.failure` and the metric. An unreachable JWKS endpoint is a **503**, not a 401, so an outage is not mistaken for a bad
token. In Entra mode roles come from the token only: `PUT /api/v1/governance/users/:id/roles` answers 409
`entra_managed` and writes a denied audit event. The roles used for authorisation are the mapped roles of the token, not the
stored copy; a token with no mapped role is refused (403) before any user row is written.

**Validation status: unit-tested with locally generated keys and a local JWKS; never exercised against a live Entra tenant.**
The just-in-time provisioning is implemented and tested against the repository (`identity-sync.int.test.ts`,
`identity-users.int.test.ts`) only, never with a live tenant.
Display names and e-mail addresses from the token are stripped of control, zero-width and bidi characters before use.

### 2.3 Fail-closed configuration guards (`packages/config`)

The API prints every problem (never a value) and exits with status 1 when configuration is unsafe:

| Rule                                                                                                                                                                                                                                                    | Applies to                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `AUTH_MODE` defaults to `dev` only for `local` and `test`; otherwise `entra`                                                                                                                                                                            | all                             |
| Persona login (`AUTH_MODE=dev` or `DEV_AUTH_ENABLED=true`) exists only when `APP_ENV` is `local` or `test`; anywhere else it is a start-up error                                                                                                        | all but `local`, `test`         |
| Production requires `AUTH_MODE=entra`, `DEV_AUTH_ENABLED=false`, `DEMO_MODE=false`, `DEMO_AUTO_SEED=false`, a malware scan mode other than the EICAR test hook, and database credentials when password authentication is used                           | `production`                    |
| Entra mode requires `ENTRA_TENANT_ID` (GUID) or an issuer, `ENTRA_AUDIENCE` and a non-empty `ENTRA_TENANT_MAP`                                                                                                                                          | `entra`                         |
| Deployed environments require TLS to PostgreSQL (`sslmode=require`, `verify-ca` or `verify-full`), no PGlite, `STORAGE_PROVIDER=azure-blob`, https non-wildcard CORS origins                                                                            | `staging`, `production`         |
| No Azure OpenAI API key and `AZURE_OPENAI_AUTH=managed-identity`                                                                                                                                                                                        | `staging`, `production`         |
| `NODE_ENV=production` (the API image sets it) with `APP_ENV` unset is refused: an unset `APP_ENV` would mean `local`, which enables persona login and the other development defaults                                                                    | `NODE_ENV=production`           |
| `AZURE_OPENAI_ENDPOINT` must be a bare https origin (no path, query, fragment, credentials or plain http) and `AZURE_OPENAI_DEPLOYMENT` must follow the provider's name rule (`apps/api/test/config-provider-parity.test.ts` keeps the two rules equal) | `AI_PROVIDER=azure-openai`, all |
| An AI cost cap needs both unit prices                                                                                                                                                                                                                   | all                             |
| Persona login cannot be combined with Entra                                                                                                                                                                                                             | all                             |

Two proxy settings are deliberately **not** guards: `TRUST_PROXY=true` only produces a warning when `APP_ENV` is `staging` or
`production`, and `TRUST_CLIENT_IP_HEADER=true` has no guard at all. It is safe only where nothing but the web app can reach the
API ([Client address for rate limits](#client-address-for-rate-limits)).

## 3. Authorization

- **Every route declares its permission** in the contract registry `ROUTES` (`packages/schemas/src/api.ts`, 75 routes): one
  permission, or `null`. Only `session.me`, `dev.personas` and `jobs.cancel` have none at the route (any authenticated caller;
  `dev.personas` needs no credentials at all). `jobs.cancel` is checked inside the job service instead: it requires the
  permission that starts that kind of job (`case:analyze`, `counterfactual:run`, `skill:extract`, `skill:mutate` or
  `demo:manage`, see [DATA_MODEL.md](DATA_MODEL.md#9-jobs)). The binder checks the permission **before** validation and before
  the handler; a missing permission is a 403 `problem+json` and an `access.denied` audit event.
- Denial audit events are bounded: the first refusal of a caller on a route in each rate-limit window is written, with a
  `suppressedSincePrevious` counter on the next one for the refusals left out; every refusal is still answered, logged and
  counted. A failure to write one never replaces the 403 (`DenialAuditThrottle`, tested in `http-hardening.test.ts`).
- Roles carry permissions (`ROLE_PERMISSIONS`, section 4). The administrator holds all 30. A permission is the only thing a
  route checks; there are no role names in handlers.
- **Four-eyes on SkillDNA.** Creator, reviewer, approver and publisher must be different people at the stages where the
  lifecycle demands it, and system actors can never approve. Enforced in the domain lifecycle and `requireDistinctApprover`
  (`@caseguard/security`) and backed by a CHECK constraint on `skill_approvals`. The gate table is in
  [DOMAIN_ENGINE.md](DOMAIN_ENGINE.md#13-skilldna). **Withdrawing is not an approval:** deprecating a published skill or
  retiring any skill only reduces what it can do, so it needs no second person (any holder of `skill:retire`, the creator
  included, may do it); the domain records it as a `rejected` decision, the one decision the constraint accepts from the creator.
  A validation counts toward a gate only when it is `full` in scope (the whole simulation set or the regression suite over every
  resolved case); a run on one case is stored but never lets a skill pass
  (`apps/api/src/services/skills/README.md`).
- Role changes keep at least one active administrator per tenant and are audited with before and after roles in the same
  transaction as the update.

## 4. RBAC matrix

Generated from `ROLE_PERMISSIONS` in `packages/security/src/rbac.ts` (5 roles, 30 permissions; `x` = granted). The
administrator column is complete by definition.

| Permission              | engineer | reviewer | manager | skill_curator | administrator |
| ----------------------- | :------: | :------: | :-----: | :-----------: | :-----------: |
| `case:read`             |    x     |    x     |    x    |       x       |       x       |
| `case:ingest`           |    x     |          |         |               |       x       |
| `case:analyze`          |    x     |          |         |               |       x       |
| `case:delete`           |          |          |         |               |       x       |
| `evidence:review`       |          |    x     |         |               |       x       |
| `fork:review`           |          |    x     |         |               |       x       |
| `counterfactual:run`    |    x     |          |         |               |       x       |
| `counterfactual:review` |          |    x     |         |               |       x       |
| `actionvalue:override`  |          |    x     |         |               |       x       |
| `quality:read`          |    x     |    x     |    x    |               |       x       |
| `quality:review`        |          |    x     |         |               |       x       |
| `warning:dismiss`       |    x     |          |         |               |       x       |
| `skill:read`            |    x     |    x     |    x    |       x       |       x       |
| `skill:extract`         |    x     |          |         |       x       |       x       |
| `skill:mutate`          |          |          |         |       x       |       x       |
| `skill:validate`        |          |    x     |         |       x       |       x       |
| `skill:review`          |          |    x     |         |       x       |       x       |
| `skill:approve`         |          |          |         |       x       |       x       |
| `skill:publish`         |          |          |         |       x       |       x       |
| `skill:retire`          |          |          |         |       x       |       x       |
| `skill:rollback`        |          |          |         |       x       |       x       |
| `skill:apply`           |    x     |          |         |       x       |       x       |
| `analytics:read`        |          |          |    x    |               |       x       |
| `telemetry:read`        |    x     |    x     |    x    |               |       x       |
| `governance:read`       |          |          |         |               |       x       |
| `governance:write`      |          |          |         |               |       x       |
| `roles:manage`          |          |          |         |               |       x       |
| `audit:read`            |          |    x     |         |               |       x       |
| `demo:manage`           |          |          |         |               |       x       |
| `export:data`           |          |          |         |               |       x       |

Counts: engineer 10, reviewer 12, manager 5, skill curator 11, administrator 30. Design consequences worth knowing:

- `fork:review` is granted to reviewers and administrators, but **no route in the current contract requires it** (the contract
  has no fork review route; forks are read-only and carry `reviewState: pending`). `quality:review` currently guards only the
  hindsight view.
- Managers read quality and portfolio analytics but **cannot** open case content beyond `case:read`, cannot dismiss warnings
  and cannot review anything. Analytics never rank individuals ([RESPONSIBLE_AI.md](RESPONSIBLE_AI.md)).
- Reviewers cannot approve or publish skills; curators cannot review evidence or counterfactuals.
- Deleting a case, reading governance settings, exporting data, managing roles and the demo controls are administrator-only.

## 5. Tenant isolation

Defence in depth, from the request to the row:

1. **Tenant comes from the credential.** The authenticator sets the tenant; no route accepts a tenant id in the path, query
   or body. The tenant id is placed in the async correlation context for logs.
2. **Tenant-scoped repositories.** `repos.forTenant({ tenantId, actorId })` returns repositories whose every statement is
   filtered by `tenant_id`, and each written entity is checked to carry that tenant.
3. **Composite keys.** Foreign keys include `tenant_id`, so a row cannot point at another tenant's parent.
4. **Forced row-level security.** Each tenant transaction runs `SET LOCAL ROLE caseguard_app` and sets
   `app.tenant_id`; every tenant table has `FORCE ROW LEVEL SECURITY` and one `tenant_isolation` policy
   ([DATA_MODEL.md](DATA_MODEL.md#5-row-level-security-and-the-caseguard_app-role)).
5. **Object store keys** are `<tenant>/<case>/<source>.json` behind a tenant-scoped wrapper.
6. **AI cache and context.** Cache keys contain tenant and case; a prompt is built from one `TemporalView` of one case
   ([AI_ORCHESTRATION.md](AI_ORCHESTRATION.md)).
7. **Per-tenant derived state.** One AI orchestrator and budget ledger per tenant; idempotency keys are stored per tenant
   (RLS) and are private to the user who chose them.

Evidence: `tenant-isolation.int.test.ts` and `ownership.int.test.ts` (PGlite). **Not verified:** the same checks on a managed
PostgreSQL server, which must connect as a non-superuser member of `caseguard_app` (a superuser or `BYPASSRLS` role ignores
RLS). Tenant provisioning, tenant-admin separation and per-tenant keys are out of scope for the prototype.

## 6. Request pipeline controls

Order of operation (see [ARCHITECTURE.md](ARCHITECTURE.md#5-request-pipeline)): request id and security headers, **general rate
limit (before authentication, so 401 and 403 answers cost the caller quota too)**, authentication (before the body is parsed),
permission check, body default and Zod validation (422), heavy-route per-user limit, handler, idempotency, audit, response
serialisation against the contract.

| Control             | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rate limiting       | `@fastify/rate-limit`: `RATE_LIMIT_MAX` (default 300) per `RATE_LIMIT_WINDOW_MS` (60 s) per client address, on every route **before authentication** (unauthenticated and forbidden requests are throttled like any other, so credential guessing and permission probing cost quota), 404s included, liveness/readiness probes exempt. Heavy routes (analysis, counterfactuals, skill extraction/simulation/mutation/apply, case creation and upload, the ingestion previews, demo seed, plus the two routes that walk very large amounts of data: the case export and the audit verification) also get `RATE_LIMIT_AI_MAX` (30) per user. **In memory, per replica.**                                                                                                 |
| As-of recomputation | An as-of view is recomputed, not filtered, so each cold engine pass costs CPU on the API's single event loop. A per-tenant-and-user token bucket (30 passes per 60 s, constants in `services/engine-budget.ts`, shared by the views and skill matching; applying a skill adds one pass for measuring the application and one for the first measurement of the case the skill came from, which is cached afterwards) answers 429 with `Retry-After` before any engine work; a scrub across more than 30 never-visited instants is refused, and cached windows are free. A pass is synchronous: the budget bounds how often it runs, not how long it blocks. **In memory, per replica.** Tests: `engine-budget.test.ts`, `views-cache.test.ts`, `views-temporal.test.ts` |
| Client address      | The general rate limit keys on the client address (IPv6 clients by /64). Behind the web tier that is the visitor's address as reported by the web server in `x-cg-client-ip` (believed only with `TRUST_CLIENT_IP_HEADER=true`, see "Client address for rate limits" below); otherwise it is the socket peer, adjusted by `TRUST_PROXY`. The heavy-route limit keys on the user once authenticated (the address before that), and the denial audit throttle on tenant, user and route. The address is used only by the limiters and is never logged or audited. HSTS is sent only when the request arrived over HTTPS. Tests: `http-hardening.test.ts` (client address header, proxy trust), `apps/web/src/proxy.test.ts` (simulated headers only)                     |
| Size limits         | JSON body 1 MiB (`BODY_LIMIT_BYTES`, 413); upload 2 MiB (`UPLOAD_MAX_BYTES`); multipart: 1 file, 4 fields, 6 parts; a declared length far beyond the limit is refused without reading, and every refusal for size closes the connection after the answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Uploads (envelope)  | A file **cut at the limit is refused with 413** (the parser truncates silently at a chunk boundary, so the truncation flag is checked explicitly and a cut file is never stored as evidence); a multipart body that is broken, ends early or has no boundary answers **400**, never 500; a client that disconnects mid-upload does not fault the server                                                                                                                                                                                                                                                                                                                                                                                                                |
| CORS                | Explicit allow-list (`CORS_ALLOWED_ORIGINS`; unset means `http://localhost:3000` locally, and a deployed environment refuses to start without it; bare origins only, no wildcard, https when deployed), `credentials: false`, bearer tokens not cookies                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Errors              | RFC 9457 `problem+json`, `type urn:caseguard:problem:<code>`, `correlationId`; unexpected errors give a generic 500; the response is validated against the contract, so a contract break becomes a generic 500 rather than leaking a shape. **Only genuine Fastify client errors (`FST_*` codes) may choose a 4xx status**; any other error that carries a 4xx status (an Azure SDK `RestError` relaying a storage or identity answer, for example) is a server-side fault. **Dependency faults** (Azure SDK `RestError` and credential errors, network error codes, PostgreSQL connection and shutdown errors) answer **503 `provider_unavailable`**, logged at `error` with the underlying cause                                                                     |
| Response headers    | From `@caseguard/security`: `buildSecurityHeaders` (nosniff, `Referrer-Policy`, `Permissions-Policy`, COOP, `X-Frame-Options: DENY`, HSTS over HTTPS) plus `API_CONTENT_SECURITY_POLICY` (`default-src 'none'`), `Cross-Origin-Resource-Policy: same-site`, `X-Permitted-Cross-Domain-Policies: none` and `Cache-Control: no-store`; also on error answers                                                                                                                                                                                                                                                                                                                                                                                                             |
| Idempotency         | `Idempotency-Key` on routes marked `idempotent`; a key is **private to the calling user** (scope = route plus a hash of the user id, inside the tenant), so another user of the same tenant can neither replay a stored response nor block the key; same key with a different body is 422, in progress is 409; a replay is marked `Idempotent-Replayed: true` and `details.replayed` in its audit event; a stored response is erased with the case it describes, because it can quote case content ([DATA_MODEL.md](DATA_MODEL.md#8-idempotency))                                                                                                                                                                                                                      |
| Pagination cursors  | Opaque, checksummed, bound to the list they were minted for and range-checked when decoded: a forged cursor is a 422 (never a database error) and can only move the caller inside data it may already read ([DATA_MODEL.md](DATA_MODEL.md#33-pagination-cursors))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| API documentation   | OpenAPI and the docs page are served only when the environment is not deployed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

The security headers come from `@caseguard/security` (`buildSecurityHeaders` and `API_CONTENT_SECURITY_POLICY`), applied in the
request lifecycle hook and in the error handler; no third-party header plugin is used.

### Client address for rate limits

In Azure the API has internal ingress and its only caller is the web app, so the socket peer is always a web replica; without more
information every visitor behind one replica would share one rate-limit bucket. Two mechanisms decide the address the general
limiter counts (`apps/api/src/http/client-address.ts`):

| Mechanism               | Setting                                                                                                                                                | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `x-cg-client-ip` header | `TRUST_CLIENT_IP_HEADER`: `false` by default; the Bicep template sets `true` for the API container                                                     | The web server (`apps/web/src/lib/api-forward.ts`, called from `src/proxy.ts`) deletes any `x-cg-client-ip` the client sent, in any letter case, and sets its own from the **right-most** valid entry of `x-forwarded-for`, the address the Container Apps ingress is expected to append (an assumption, see Status below). The API believes the header only when the flag is `true` and the value is a bare IPv4 or IPv6 literal of at most 45 characters (the same rule as the web tier, so a zone id or a bracket is refused); anything else is ignored and the peer address is used |
| Socket peer             | `TRUST_PROXY`: `false` (default), a **hop count**, a list of addresses, CIDR ranges and the keywords `loopback`, `linklocal`, `uniquelocal`, or `true` | `request.ip`. A count of `1` believes the nearest proxy only (the Bicep template sets 1 as the secondary fallback, used when the header is absent or invalid). `true` believes every hop, lets a client choose its own address, is meant for local experiments, and produces a configuration warning when `APP_ENV` is staging or production                                                                                                                                                                                                                                            |

Rules in the web tier (tests `[API-FWD-03]` and `[API-FWD-04]` in `apps/web/src/proxy.test.ts`):

- Only the right-most entry is read. The entries to its left were written by the client and are never consulted; repeated
  `x-forwarded-for` lines are joined first.
- A port and IPv6 brackets are stripped (`203.0.113.7:54321`, `[2001:db8::7]:443`). Only a bare IPv4 or IPv6 literal is accepted,
  which is stricter than `net.isIP`: an IPv6 zone id such as `fe80::1%eth0` is free text that could mint unlimited bucket keys, so
  it is refused.
- When the right-most entry is not an address, no header is set and the API uses the socket peer. A request forwarded by the web
  server therefore carries either the web server's own value or none, never the client's.
- The header is set for `/api/*` and the health endpoints and never for page requests. Next 16.4.2 fills `x-forwarded-for` with the
  socket address only when it is absent (`req.headers['x-forwarded-for'] ??= socket.remoteAddress` in `base-server.js`), so a value
  supplied by the ingress is kept, and in local development the value is the browser's loopback address.

Rules in the API:

- IPv6 clients are bucketed by /64 (the `normalizeIP` of `@fastify/rate-limit`); IPv4 is unchanged.
- The address is used only by the rate limiters. It is never logged, audited or stored, so a 429 log line shows no address.
- The API applies the same rule as the web tier: digits, hex letters, colons and dots only, at most 45 characters, and `net.isIP`
  must accept the value. An IPv6 zone id (`fe80::1%eth0`), a bracketed address, a port, a list or an empty value is ignored and
  the peer address is used (`http-hardening.test.ts` covers each).
- **Never enable `TRUST_CLIENT_IP_HEADER` on an API that browsers or any other caller can reach directly**: such a caller could send
  its own header and choose its bucket. No configuration guard enforces this (unlike `TRUST_PROXY=true`, which at least warns when
  deployed). The control is the internal ingress of the API container app in the Bicep template, which has never been deployed.

**Status.** Implemented on both sides and covered by unit and integration tests with **simulated headers only**
(`apps/web/src/proxy.test.ts`; `apps/api/test/http-hardening.test.ts`, "client address header (API behind the web tier)";
`packages/config/test/values.test.ts`). A local run of two API instances with `RATE_LIMIT_MAX=3` behaved as designed: with the flag on,
five requests reporting the same address gave 200, 200, 200, 429, 429 while another reported address still got 200; four
addresses in one IPv6 /64 shared one bucket and a different /64 had its own; a malformed value (`not-an-ip`, a list, an address
with a port, an over-long value) fell back to the peer's bucket; unauthenticated attempts (401) were throttled per reported address.
With the flag unset, rotating the header changed nothing (200, 200, 200, 429, 429), so a client could not choose its bucket.
**It has not been observed behind a real Container Apps ingress.** That the right-most `x-forwarded-for` entry is the visitor's
address, and that the ingress passes headers on as assumed, are assumptions ([ASSUMPTIONS.md](ASSUMPTIONS.md), A-19 and A-20). If
another proxy (for example Azure Front Door) were placed in front of the web app's ingress, the right-most entry would be that
proxy and all visitors would share one bucket. Post-deploy check 12 in
[DEPLOYMENT.md](DEPLOYMENT.md#57-post-deploy-smoke-tests) detects both a shared bucket and a client-chosen bucket.

### Web application

`apps/web` sets static headers in `next.config.ts` (nosniff, referrer policy, permissions policy, COOP, `X-Frame-Options`,
HSTS in production builds) and a **per-request nonce CSP** in `src/proxy.ts` (`script-src 'self' 'nonce-…' 'strict-dynamic'`,
`object-src 'none'`, `frame-ancestors 'none'`, `connect-src 'self'` plus the Entra authority). `style-src` keeps
`'unsafe-inline'` because Fluent UI injects style elements at runtime; scripts stay locked to the nonce. Case content is
rendered as text. The browser talks only to its own origin: the web server's `src/proxy.ts` forwards `/api/*` and the probes `/livez`,
`/healthz`, `/readyz` to the API at request time from `API_INTERNAL_URL` (`lib/api-forward.ts`, tests `[API-FWD-01]` and
`[API-FWD-02]` in `src/proxy.test.ts`). The value must be an absolute http(s) origin with no credentials, path or query; the
destination host is fixed by configuration and a request path cannot change it; method and body pass through untouched and so do the
headers, except that `x-cg-client-ip` is replaced by the web server (previous subsection); a missing or invalid value in production answers 502 `upstream_not_configured`. A consequence worth knowing: the
unauthenticated probes are reachable on the public web origin. `/livez` and `/healthz` return the service name, version and uptime;
`/readyz` adds the five dependency checks (`database`, `migrations`, `storage`, `search`, `model_provider`: name, kind, criticality,
status and latency, never error text).

## 7. Input handling

### 7.1 Uploads (`validateUpload`)

Decisions are made from the **bytes**, not the file name or the declared type: extension allow-list (`.json`, `.txt`, `.log`,
`.md`, `.csv`); media-type allow-list with mismatch detection (browsers send `application/octet-stream` for unknown
extensions, which is tolerated); UTF-8 or ASCII only (UTF-16 is refused); NUL bytes and control bytes (binary); content that
starts with a known executable, archive, document, image or media signature (Windows PE, ELF, Mach-O or Java class, PDF,
ZIP and Office, OLE2, gzip, bzip2, xz, zstd, RAR, 7-Zip, tar, PNG, JPEG, GIF, RIFF, MP4, SQLite); content that looks like a web
page or script (`active_content`); JSON nesting over 64 levels; empty files; and size over `UPLOAD_MAX_BYTES`. File names are
limited to 120 characters, reserved device names and risky extensions are refused and the stored name is sanitised. The domain
parsers then apply their own bounds (2,000 events, 20,000 characters per body, JSON depth 16, CSV 2,000 rows and 40 columns by
default).

**Malware scanning is a stub.** `NoopMalwareScanner` reports `not_scanned`; `EicarTestScanner` exists as a test hook and is
refused in production. No antivirus engine is integrated.

### 7.2 Redaction (`redactText`, `redactValue`)

Categories: `bearer_token`, `api_key`, `connection_string`, `private_key`, `password_assignment`, `jwt`, `github_token`,
`azure_storage_key`, `email_address`, `ipv4_address`, `phone_number` and `custom`. The secret categories are **always** on
(governance can narrow only the personal-data categories). Reserved and synthetic values (for example example-domain
addresses and private IP ranges) are exempt in synthetic data and are redacted too when the data is declared real
(`redactReservedValues`). Replacements are pseudonymised per case (the same address gets the same placeholder number), so the
analysis can still follow an actor. Custom patterns run inside a `node:vm` sandbox. Only counts per category are stored, never
the matched text. Redaction happens **before** the case is persisted and again before any text enters a prompt. The raw upload
is never stored: the object store holds the redacted canonical JSON.

**Detection works on a folded view.** Each string is viewed through NFKC per code point (full-width letters and punctuation
become ASCII), with invisible characters removed and Unicode spaces turned into plain spaces, so `pass<ZWSP>word` or a
no-break space after `password:` is caught like its ASCII form; the replacement is written onto the original text, so nothing
outside a redacted span is normalised in storage. Only one-to-one mappings are used (a ligature or an ellipsis stays as it is).
Not folded: look-alike letters from other scripts (Cyrillic U+0430 for Latin `a`) and combining marks, so a secret written with
them is not recognised (`packages/security/src/redaction/fold.ts`, `test/redaction-fold.test.ts`).

**Custom patterns fail closed.** A tenant's custom pattern that cannot be applied (invalid, rejected as unsafe, beyond the
20-pattern limit, too slow on this input, over its match bounds, or starved by the request's time budget) is never skipped
silently: the result is reported incomplete, so the ingestion preview answers `ok: false` with an issue on the path `redaction`
that names the pattern by its label only (never its source or any payload text) and creating the case answers **422
`unsafe_content`**. The operator's log line `ingest.redaction_notes` carries the label and a fixed reason. Each pattern is
evaluated once over all strings of a bundle (`redactTexts`, `redactValues`) instead of once per field. In one local measurement
during this rework, a bundle of 2,000 events (1.83 MB) with a single custom pattern took about 0.7 s, against about 21 s before
the batching; it was a single run, not part of the repeatable benchmarks. The work still runs on the API's event loop, which
stalls for up to about 0.9 s on very large bundles ([KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md)).

**Limits:** pattern-based redaction misses names, free-text personal data and context-dependent secrets. It is a safety net,
not a data-loss-prevention system ([PRIVACY.md](PRIVACY.md)).

### 7.3 Synthetic-data policy

A tenant flagged `synthetic` refuses a payload that declares `"synthetic": false`. A payload that declares `true` is
**self-attested**: the system cannot verify that the content is fictional. Pasted text and CSV inherit the tenant's label. A
tenant provisioned as non-synthetic accepts real data with the stricter redaction above; no such tenant is seeded.

### 7.4 Prompt injection

`detectPromptInjection` applies linear-time rules (`ignore_previous_instructions`, `system_prompt_exfiltration`,
`role_override`, `tool_invocation`, `delimiter_spoofing`, `policy_override`, `exfil_url_instruction`; severity low, medium or
high) plus hidden-character and encoded-payload checks. It **flags**: findings appear in the ingestion preview, the case
records `injectionDetected`, the AI context marks the event `possible_prompt_injection`, and metrics count it. Evidence is not
dropped. An empty result means "nothing recognised", not "safe". The structural controls that do not depend on detection are
in [AI_ORCHESTRATION.md](AI_ORCHESTRATION.md): instructions and data separated by delimited, nonce-keyed blocks; a model with
**no tools**; strict structured output; seven validators; deterministic fallback.

### 7.5 Outbound requests

The API never fetches a URL supplied by a user. Outbound calls go to operator-configured endpoints: Azure OpenAI (https bare
origin, no redirects), Azure AI Search (`assertSafeOutboundUrl`: https, default port, no credentials or IP literals, host in
`*.search.windows.net`), Azure Blob (account URL with `DefaultAzureCredential`), the Entra JWKS (https). The guard is
textual: it does not resolve DNS, so it does not defend against DNS rebinding.

What Azure AI Search sends back is untrusted too (`apps/api/src/services/search`). The answer is capped at 1,000,000 bytes and 200
documents (more is a failure and the service falls back to lexical search). Every document is validated on its own: a document of
another tenant is dropped, logged at `error` and counted as `foreign_tenant_document`; a malformed one is dropped, logged at
`warn` and counted as `invalid_document`. Title and snippet are stripped of markup (entities are not decoded), masked again and
clipped to 300 characters. The link of a hit is built by the application from the type and the ids and is never taken from the
document, and every hit must satisfy the result contract (`invalid_result` otherwise). When no usable document is left, the
service answers from PostgreSQL full-text search; an empty answer stays empty. These checks are covered by unit tests and an
integration test with a fake `fetch` (`search-documents.test.ts`, `search-service.test.ts`, `search-global-azure.int.test.ts`);
**no real Azure AI Search index has been queried**. The index document requirements are in
[runbooks/search-unavailable.md](runbooks/search-unavailable.md#index-document-requirements).

## 8. Secrets

- Configuration holds credentials in a `Secret` wrapper: `toString`, `toJSON` and `util.inspect` print `[redacted]`; the value
  is read only with an explicit `reveal()` where it is used.
- Start-up errors list names and reasons, never values.
- The logger redacts in four layers: a deep scrub of every logged object (credential and PII key names at any depth, token and
  connection-string shapes inside strings, error stacks and `cause` chains), the `msg` serialiser, `child()` bindings, and pino
  `redact` paths for headers and credential fields. Stacks are omitted in production. Pattern redaction is best effort: case
  content, prompts and model output must never be logged. Audit `details` are ids, counters and enums only
  ([OBSERVABILITY.md](OBSERVABILITY.md)).
- `.env.example` contains no secrets. `scripts/scan-secrets.mjs` (own scanner, pre-commit hook and CI) and gitleaks scan the
  tree; findings print file, line and rule id, never the value. Allow-listing requires a written reason.
- Cloud design: managed identities for PostgreSQL (Entra authentication), Blob, AI Search and Azure OpenAI; Key Vault for the
  database URL and the Application Insights connection string (`infra/bicep`, **designed and linted, never deployed**).
- Azure OpenAI API keys are refused in `staging` and `production`.

## 9. Audit and accountability

Every mutating route writes an audit event (a specific one such as `case.ingested`, `analysis.completed`,
`roles.assigned`, or the fallback `api.<routeId>`); audited reads are `governance.audit` and `governance.users`; refusals are
`access.denied`. Events form a per-tenant SHA-256 hash chain; the application role can insert and select only; a trigger
rejects update and delete; `GET /api/v1/audit/verify` walks the chain. The chain is tamper-evident, not tamper-proof: a
privileged database user can rewrite it consistently, and **no external anchor exists**. Details in
[DATA_MODEL.md](DATA_MODEL.md#7-the-audit-hash-chain).

## 10. Dependency policy and supply chain

| Mechanism                     | Where                                           | What it checks                                                                                                                     |
| ----------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Lockfile and registry hygiene | `scripts/audit-deps.mjs`                        | `pnpm-lock.yaml` and `.npmrc` must not reference a private feed or a tarball outside `registry.npmjs.org`                          |
| Vulnerability gate            | `pnpm audit:deps` (CI `security` job)           | `pnpm audit --prod --audit-level=high`, falling back to OSV.dev; HIGH and CRITICAL fail; exit code 3 means NOT RUN, never "passed" |
| Time-boxed exceptions         | `docs/dependency-exceptions.json`               | An entry needs an id, package, justification (at least 20 characters) and an expiry; expired entries are ignored                   |
| Secret scan                   | `pnpm secrets:scan`, pre-commit, gitleaks in CI | Secret-shaped content in tracked and untracked files                                                                               |
| Static analysis               | `.github/workflows/codeql.yml`                  | CodeQL `security-extended` for JavaScript/TypeScript on pushes, pull requests and weekly                                           |
| Dependency review             | `.github/workflows/dependency-review.yml`       | Pull requests that add a dependency with a known HIGH or CRITICAL runtime vulnerability fail                                       |
| Update automation             | `.github/dependabot.yml`                        | Weekly updates for npm, GitHub Actions, Docker and Docker Compose                                                                  |
| Least privilege               | workflows                                       | `persist-credentials: false`, read-only default token, OIDC for Azure (no stored cloud credentials)                                |
| Code owners                   | `.github/CODEOWNERS`                            | Security-sensitive paths require the owner's review (owner must confirm the file)                                                  |

**The one accepted exception (honest account).** `GHSA-xcx6-jx8p-x3h5` (listed as CVE-2026-109461) affects the
authorization-code flow of `@azure/msal-node` 6.x. CaseGuard does not import `@azure/msal-node`; it is a transitive
dependency of `@azure/identity` 4.14.0, which the API uses for managed identity (`DefaultAzureCredential`) and which pins
`^6.0.0`. The fix is in 7.1.0. A pnpm override to 7.x was not applied because it cannot be tested against a live Azure
identity here. The exception expires on **2027-01-15**; after that date the audit fails again unless someone renews it with
reviewer approval or upgrades. The browser uses `@azure/msal-browser`, a different package that the advisory does not name.

**Not done (backlog in [CI_CD.md](CI_CD.md)):** actions are pinned to major tags rather than commit SHAs, base images are not
pinned by digest, no SBOM or build provenance is generated, container images are not vulnerability-scanned, and Docker image
builds have not been run (no Docker daemon was available). I did not run `audit:deps` for this document; it sends the package
list of the lockfile to a public vulnerability service.

## 11. Mapping to the threat model

| Threat                       | Where it is handled                                                                                                                                         | Status / note                                                                                                                                                                                                                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T1 forged identity           | Section 2: environment guards, Entra validation                                                                                                             | Dev personas only in `local` and `test`; Entra mock-validated                                                                                                                                                                                                                  |
| T2 tenant spoofing           | Sections 2 and 5                                                                                                                                            | Implemented, tested                                                                                                                                                                                                                                                            |
| T3 event tampering           | [DATA_MODEL.md](DATA_MODEL.md#11-immutability-erasure-and-retention-what-exists)                                                                            | Triggers; privileged DB users can bypass                                                                                                                                                                                                                                       |
| T4, T5 audit and corrections | Section 9                                                                                                                                                   | Hash chain, no external anchor                                                                                                                                                                                                                                                 |
| T6 cross-tenant disclosure   | Section 5                                                                                                                                                   | Tested on PGlite; managed PostgreSQL unverified                                                                                                                                                                                                                                |
| T7 logs                      | Section 8, [OBSERVABILITY.md](OBSERVABILITY.md)                                                                                                             | Four-layer redaction                                                                                                                                                                                                                                                           |
| T8 denial of service         | Section 6                                                                                                                                                   | General throttle before authentication, bounded denial audit events, truncated and malformed uploads refused; limits are per replica and in memory; client-address trust depends on `TRUST_CLIENT_IP_HEADER` and `TRUST_PROXY` (section 6, not observed behind a real ingress) |
| T9 denial of wallet          | [AI_ORCHESTRATION.md](AI_ORCHESTRATION.md#7-token-governor-budgets-routing-cache-resilience)                                                                | Cost limits need unit prices; day and case token caps are not set by the API                                                                                                                                                                                                   |
| T10 role confusion           | Sections 3 and 4                                                                                                                                            | Implemented, tested; `jobs.cancel` has no route permission and is checked in the job service                                                                                                                                                                                   |
| T11 malicious file           | Section 7.1                                                                                                                                                 | Scanner is a stub                                                                                                                                                                                                                                                              |
| T12 XSS                      | Section 6 (web)                                                                                                                                             | Text rendering, nonce CSP                                                                                                                                                                                                                                                      |
| T13 CSRF                     | Section 2.1, 6                                                                                                                                              | Header and bearer authentication; no ambient-cookie auth in the API                                                                                                                                                                                                            |
| T14 SSRF                     | Section 7.5                                                                                                                                                 | Textual guard, no DNS resolution                                                                                                                                                                                                                                               |
| T15 supply chain             | Section 10                                                                                                                                                  | SBOM listed in the threat model is **not** generated (corrected there)                                                                                                                                                                                                         |
| AI-1 prompt injection        | Section 7.4                                                                                                                                                 | Heuristic flags; **no quarantine** (corrected in the threat model)                                                                                                                                                                                                             |
| AI-2 forged citations        | [AI_ORCHESTRATION.md](AI_ORCHESTRATION.md#6-the-seven-validators-code-disposes)                                                                             | Citation and temporal validators                                                                                                                                                                                                                                               |
| AI-3 temporal leakage        | [DOMAIN_ENGINE.md](DOMAIN_ENGINE.md#3-temporal-integrity-the-central-invariant)                                                                             | Branded view, leak check, mutation tests                                                                                                                                                                                                                                       |
| AI-4 cross-case context      | Section 5                                                                                                                                                   | One view of one case per task                                                                                                                                                                                                                                                  |
| AI-5 unsafe recommendations  | AI policy validator (negation-aware regular expressions with known gaps, [SP-17](KNOWN_LIMITATIONS.md#3-security-and-privacy-limits)), domain safety gating | Implemented, tested                                                                                                                                                                                                                                                            |
| AI-6 skill poisoning         | Section 3 (four-eyes), lifecycle                                                                                                                            | No auto-publish                                                                                                                                                                                                                                                                |
| AI-7 over-trust              | [RESPONSIBLE_AI.md](RESPONSIBLE_AI.md)                                                                                                                      | Labels, ranges, notices                                                                                                                                                                                                                                                        |
| AI-8 secrets or PII to model | Section 7.2                                                                                                                                                 | Redaction before prompts; pattern-based                                                                                                                                                                                                                                        |

## 12. What this does not protect against

- **A compromised or malicious insider with database or infrastructure rights**: a superuser can bypass RLS, disable
  triggers and rewrite the audit chain consistently.
- **Real personal data**: the system is built and documented for synthetic data. Redaction is pattern-based; it will miss
  names and free-text identifiers. There is no data classification, no data-subject tooling and no scheduled retention purge.
- **Evasive prompt injection**: detection is heuristic. If a real model were connected, the structural controls (no tools,
  validation, deterministic fallback) limit the damage but a model could still produce misleading, validated-looking text.
- **Malware**: nothing scans uploads. Files are parsed as text only; that reduces, but does not remove, the risk.
- **A live Entra tenant misconfiguration**, token theft, or an over-broad role mapping: the Entra path has not run against a
  real tenant, and bearer tokens are valid until expiry.
- **Network-level attacks and abuse at scale**: rate limits are in memory per replica and key on the client address, so they
  are only as good as the address they are given: the web tier's `x-cg-client-ip` (believed with `TRUST_CLIENT_IP_HEADER=true`,
  which nothing guards against on a reachable API, and never observed behind a real ingress) or, as the fallback, the
  `TRUST_PROXY` setting (a wrong hop count lets a client choose its own address or makes every client look like the proxy);
  no WAF, DDoS protection or bot control is configured or designed beyond what Azure provides by default.
- **Denial of service from large but valid inputs**: a maximal case (2,000 events) takes seconds of CPU to analyse in process
  ([EVALUATION.md](EVALUATION.md#6-performance)); analysis runs in the API process with a concurrency of 2.
- **Cloud-side controls that were never deployed**: private networking is optional and off by default in the template;
  Key Vault, managed identities, diagnostic settings and alerts are designed, not observed.
- **Browser-side secrets**: the dev persona id is stored in `localStorage` and a cookie by design; Entra tokens are held by MSAL
  in `sessionStorage` (`cacheLocation: 'sessionStorage'`), so any script that runs on the page could read them. The nonce CSP is
  the mitigation.
- **Insecure defaults on a developer machine**: the API binds to `0.0.0.0:4000` by default (`API_HOST`, `API_PORT`), and persona
  login is unauthenticated. Do not expose a local instance to a network.
