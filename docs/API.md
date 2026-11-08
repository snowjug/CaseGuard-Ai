# API reference

The HTTP API of CaseGuard AI is the Fastify 5 service in `apps/api`. This page has two parts:

- **Conventions** (the sections up to the worked examples): what every route shares. Written by hand and checked against `apps/api/src/http/*` and the tests named in each section.
- **[Route reference](#route-reference)**: one table per route group, **generated** from the `ROUTES` registry in `packages/schemas/src/api.ts` by `scripts/export-api-docs.ts`. The registry is the only authority on paths, permissions and shapes; see [Regenerating this page](#regenerating-this-page).

**Page names.** The web app was redesigned and its pages were renamed; the API did not change. The generated route descriptions keep the earlier names, so read "Command center" as Home, "Evidence ledger" as Evidence, "Decision forks" as key decisions, "Digital twin" as Case details, "Counterfactual lab" as What if, "SkillDNA library" as Skills, "Ingest a case" as Add a case and "Avoidable Support Effort" as Time that could have been saved. Route ids such as `dashboard.commandCenter` are unchanged.

**Validation status.** Every route has a handler, and the request pipeline, the contract and tenant isolation are exercised by the API test-suite on PGlite (`apps/api/test`). Identity in a local run is a development persona. `AUTH_MODE=entra` (token validation, just-in-time user provisioning) is implemented and tested against locally generated keys and the repository only: it has never met a real Entra tenant. Nothing has been deployed to Azure. The worked examples below were run against a local API with an in-memory database and the deterministic AI provider; where something was only read in code, the text says so.

## Conventions

### Base path and content types

- Every route of the registry lives under `/api/v1`. There is one version and no deprecation policy yet.
- Requests and responses are JSON (`application/json`). The two upload routes take `multipart/form-data`. Errors are `application/problem+json`. `examples.get` is the one route that answers with something other than JSON: a downloadable example in its own format (`text/plain`, `text/csv` or `application/json`, with `Content-Disposition: attachment`).
- The same Zod schemas validate requests, validate responses and generate the OpenAPI 3.1 document, and the web client imports them from `@caseguard/schemas`. A response that breaks its schema becomes a generic 500, never a leaked shape.
- Identifiers are opaque strings of letters, digits and `_ . : -` (at most 120 characters), for example `case_01M65...`. Timestamps are UTC ISO-8601 with a trailing `Z` (assumption A-17); an offset or a missing `Z` is a 422.
- Unversioned probes, exempt from authentication and from the rate limit: `GET /livez` and `GET /healthz` answer from the process alone, `GET /readyz` runs the cached dependency checks and answers 503 only when a critical dependency is down (it lists names and states, never error text).
- `GET /api/v1/openapi.json` and the Swagger UI at `/api/docs` are served unless `APP_ENV` is `staging` or `production` (`runtime.deployed` in `packages/config/src/load.ts` is true only for those two). They describe the same routes as the tables below.
- Browsers never call the API directly: the web server forwards `/api/*` to it at request time ([ARCHITECTURE.md](ARCHITECTURE.md#4-runtime-architecture-diagram-a)).

### Authentication

Every route except `dev.personas` needs a credential, and the credential is checked before the request body is parsed. The mechanism is fixed at start-up by `AUTH_MODE`.

| Mode    | Credential                                                                                                                                                                                                                                                                                                                         | Status                                                                                               |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `dev`   | Header `x-cg-persona: <userId>` naming a seeded persona. The tenant, roles and disabled flag come from the stored user row, so the header cannot pick a tenant or a role. Anyone who can reach the API can send it: synthetic data on a developer machine only ([SECURITY.md](SECURITY.md#21-development-personas) has the guard). | Implemented and tested. The default of a local run.                                                  |
| `entra` | `Authorization: Bearer <Entra access token>`, validated with `jose`: signature (remote JWKS), issuer, audience, lifetime, `tid` in the tenant map, `oid`, and app roles mapped to CaseGuard roles ([SECURITY.md](SECURITY.md#22-microsoft-entra-id)).                                                                              | Implemented; validated against local mock keys and the repository only, never against a live tenant. |

- Development personas (`GET /api/v1/dev/personas` lists them while development identity is enabled): `user_ava_engineer` (engineer), `user_riley_reviewer` (reviewer), `user_morgan_manager` (manager), `user_casey_curator` (skill_curator), `user_alex_admin` (administrator), all in tenant `tenant_contoso_support`, and `user_fabi_engineer` (engineer) in `tenant_fabrikam_lab`, a second tenant that exists to demonstrate isolation.
- `GET /api/v1/me` returns the signed-in user, tenant, effective `permissions`, `authMode`, `environment`, `features` and the honesty `notices` the UI shows.
- A missing or invalid credential is a 401 `unauthenticated` with `WWW-Authenticate: Bearer realm="caseguard"`. The reason (`token_expired`, `invalid_audience`, and so on) is logged as an `auth.failure` event and never returned.

### Authorization and tenancy

- Each route declares one permission in the registry, shown in the `Permission` column. The binder checks it right after authentication, before the body is parsed. A missing permission is a 403 `forbidden`. Permissions come from roles (`ROLE_PERMISSIONS` in `packages/security/src/rbac.ts`); the matrix is in [SECURITY.md](SECURITY.md#4-rbac-matrix).
- Three routes have no permission at the route: `session.me` and `jobs.cancel` accept any signed-in user, and `dev.personas` is public. `jobs.cancel` is then checked inside the job service, which requires the permission that starts that kind of job ([DATA_MODEL.md](DATA_MODEL.md#9-jobs)).
- **The tenant comes from the credential, never from the request.** No path, query or body carries a tenant id. A case, job or user of another tenant answers **404**, the same as one that does not exist (`cases.int.test.ts`: "answers 404 for an unknown case and for another tenant's case"). Under the hood: tenant-scoped repositories, composite keys and forced row-level security ([SECURITY.md](SECURITY.md#5-tenant-isolation)).
- Every state-changing request is audited as `api.<routeId>`, a refusal as `access.denied` (at most one per caller and route per rate-limit window, with a `suppressedSincePrevious` counter), and two reads that expose security-relevant data (`governance.audit`, `governance.users`) are audited like mutations. Audit events are in the database, not in the log stream ([SECURITY.md](SECURITY.md#9-audit-and-accountability)).

### Request identifiers and headers

| Header                          | Direction         | Behaviour                                                                                                                                                                                                                                                                                                                         |
| ------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `x-request-id`                  | request, response | Optional on the request: accepted when it is 8 to 64 characters of `A-Z a-z 0-9 . _ : -` starting with a letter or digit, otherwise a `req_<ULID>` is generated. Always echoed. It is the `correlationId` of an error and of the audit events of the request.                                                                     |
| `Idempotency-Key`               | request           | Optional; honoured on six routes ([Idempotency](#idempotency)).                                                                                                                                                                                                                                                                   |
| `Idempotent-Replayed: true`     | response          | The body is the stored answer of an earlier identical request; the handler did not run.                                                                                                                                                                                                                                           |
| `Retry-After`                   | response (429)    | Seconds until the limiter that refused the request admits it again.                                                                                                                                                                                                                                                               |
| `Content-Disposition`           | response          | Downloads only (`examples.get`, `schemas.caseBundle`, `schemas.knowledgePack`).                                                                                                                                                                                                                                                   |
| `x-cg-persona`, `Authorization` | request           | See [Authentication](#authentication).                                                                                                                                                                                                                                                                                            |
| Security headers                | response          | `Cache-Control: no-store`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy: same-site`, `X-Frame-Options: DENY`, a `default-src 'none'` CSP, HSTS only over HTTPS; also on error answers ([SECURITY.md](SECURITY.md#6-request-pipeline-controls)). |

CORS is an explicit allow-list (`CORS_ALLOWED_ORIGINS`: unset means `http://localhost:3000` in a local run, a deployed environment refuses to start without it, and no wildcard is accepted), never allows credentials, and exposes `x-request-id`, `retry-after`, `idempotent-replayed` and `content-disposition` to browsers. Its allowed request headers are `authorization`, `content-type`, `idempotency-key` and `x-request-id`, plus `x-cg-persona` while development identity is on. The rate-limit plugin may also send its default `x-ratelimit-*` headers; no test asserts them, so they are not part of the contract.

### Errors

Every failure is RFC 9457 `application/problem+json`:

```json
{
  "type": "urn:caseguard:problem:validation_failed",
  "title": "The request is not valid",
  "status": 422,
  "code": "validation_failed",
  "correlationId": "req_01M65ZW0HFVM9Q7JCQ63KW9V76",
  "detail": "One or more fields are not valid.",
  "errors": [{ "path": "query.limit", "message": "Too big: expected number to be <=200" }]
}
```

(`GET /api/v1/cases?limit=999`, observed.) `type` is `urn:caseguard:problem:<code>`, `correlationId` is the request id (quote it when you ask for help), `detail` is at most 1,000 characters and `errors` (at most 100 entries, `path` plus `message`) appears for field problems. `reason` is optional and is described [below](#reason-tokens). The server-side cause of a failure (SQL, paths, a stack trace) is never sent: a 500 carries a generic message.

| Status | `code`                   | When                                                                                                                                                                                                                                                                            |
| ------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `validation_failed`      | The request cannot be parsed: JSON that is not JSON, a broken or boundary-less multipart body.                                                                                                                                                                                  |
| 401    | `unauthenticated`        | No credential, or one that fails validation. Carries `WWW-Authenticate`.                                                                                                                                                                                                        |
| 403    | `forbidden`              | The caller lacks the route's permission (or, for `jobs.cancel`, the permission of the job's kind), an Entra token maps to no CaseGuard role, or a four-eyes rule of the SkillDNA lifecycle is broken (the same person in two stages).                                           |
| 403    | `tenant_violation`       | A guard below the route found a record that does not belong to the caller's tenant. Routes answer 404 for such records, so clients should not see this one.                                                                                                                     |
| 404    | `not_found`              | The route, the record, or a record of another tenant.                                                                                                                                                                                                                           |
| 409    | `conflict`               | The state forbids the request: a view of a case that has never been analysed; a case reference already used in the workspace by different content (`UNIQUE (tenant_id, reference)`); an idempotent request that is still in progress; an illegal SkillDNA lifecycle transition. |
| 409    | `version_conflict`       | `expectedVersion` is stale (optimistic lock on reviews, overrides, governance, skills). Reload and retry.                                                                                                                                                                       |
| 412    | `precondition_failed`    | A skill lifecycle gate is not met (for example a missing validation).                                                                                                                                                                                                           |
| 413    | `payload_too_large`      | A JSON body over `BODY_LIMIT_BYTES`, or an upload over `UPLOAD_MAX_BYTES` or cut at the limit.                                                                                                                                                                                  |
| 415    | `unsupported_media_type` | A content type the server cannot parse (observed with `application/xml`). A JSON route given `text/plain` is a 422 instead: the body is a string where an object is required.                                                                                                   |
| 422    | `validation_failed`      | The request parses but breaks the schema: `errors[]` names each field. Also a forged or foreign pagination cursor, a malformed `Idempotency-Key` and a SkillDNA extraction the engine refused (the reasons are listed).                                                         |
| 422    | `idempotency_conflict`   | The same `Idempotency-Key` was used with a different request.                                                                                                                                                                                                                   |
| 422    | `unsafe_content`         | An upload or ingest refused for safety: validation, the malware scanner hook, invalid UTF-8, or a redaction that could not be completed (fail closed).                                                                                                                          |
| 429    | `rate_limited`           | The general limit, the heavy-route limit or the as-of engine budget; always with `Retry-After`.                                                                                                                                                                                 |
| 429    | `budget_exceeded`        | In the problem vocabulary, but no route in `apps/api/src` raises it today: an exhausted AI budget degrades to deterministic output and is recorded on the execution as `budget_exceeded` ([AI_ORCHESTRATION.md](AI_ORCHESTRATION.md)).                                          |
| 500    | `internal`               | An unexpected fault. Generic message plus the `correlationId`.                                                                                                                                                                                                                  |
| 501    | `not_implemented`        | A documented route that has no handler. Every route has one today; start-up refuses an incomplete build when `APP_ENV` is `staging` or `production`, and elsewhere such a route would answer 501.                                                                               |
| 503    | `provider_unavailable`   | A dependency fault: an Azure SDK error, a database or network outage. Only genuine Fastify client errors (`FST_*`) may choose a 4xx status; anything else that carries a 4xx status is a server-side fault.                                                                     |

The web tier adds one answer of its own: 502 `upstream_not_configured` when `API_INTERNAL_URL` is missing in production ([DEPLOYMENT.md](DEPLOYMENT.md)).

#### Reason tokens

A condition a client may want to handle on purpose carries a second, stable field next to `code`: `reason`, a lower-case snake_case token of 3 to 40 characters. Branch on `code` and `reason`, never on `detail`, whose wording can change; show `detail` to the person. A problem without a `reason` has nothing more to say. A token is never free text and never contains data of the request. These are all the tokens the API sends (`apps/api/test/problem-reasons.test.ts` fails when a token appears in the code and not on this page, or the other way round):

| `reason`                                             | Status and `code`         | Meaning                                                                                                                                                                                                       |
| ---------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `not_analysed`                                       | 409 `conflict`            | The case has never been analysed. Every artefact view, counterfactual run and skill application answers this for such a case; start an analysis first.                                                        |
| `reference_in_use`                                   | 409 `conflict`            | A case with this reference already exists in the workspace with different content.                                                                                                                            |
| `request_in_progress`                                | 409 `conflict`            | A request with the same `Idempotency-Key` is still running. Retry shortly.                                                                                                                                    |
| `job_active`                                         | 409 `conflict`            | A job of the case (or a demo seed or reset) is still running. Wait for it or cancel it.                                                                                                                       |
| `job_terminal`                                       | 409 `conflict`            | The job has already finished, so its status cannot change.                                                                                                                                                    |
| `illegal_transition`                                 | 409 `conflict`            | The SkillDNA lifecycle does not allow this transition from the skill's current state.                                                                                                                         |
| `not_a_demo_tenant`                                  | 409 `conflict`            | A demo route was called on a workspace that is not a demo workspace.                                                                                                                                          |
| `personas_unavailable`                               | 409 `conflict`            | The demo story needs its synthetic personas, and this workspace does not have them.                                                                                                                           |
| `entra_managed`                                      | 409 `conflict`            | Roles are managed in Microsoft Entra ID, not in CaseGuard AI.                                                                                                                                                 |
| `last_administrator`                                 | 409 `conflict`            | A workspace must keep at least one active administrator.                                                                                                                                                      |
| `record_cap_exceeded`                                | 409 `conflict`            | The export would hold more records than the export controls allow.                                                                                                                                            |
| `duplicate`, `immutable`, `reference`, `concurrency` | 409 `conflict`            | Refusals of the data tier: a record with that identifier exists; the record is immutable; the operation points at a record that is missing or still in use; a concurrent change (retry, `retryable` is true). |
| `separation_of_duties`                               | 403 `forbidden`           | The same person cannot hold two stages of the SkillDNA lifecycle (four eyes).                                                                                                                                 |
| `case_export_disabled`, `audit_export_disabled`      | 403 `forbidden`           | The export controls of the workspace forbid this kind of export.                                                                                                                                              |
| `gate_failed`                                        | 412 `precondition_failed` | A SkillDNA lifecycle gate is not met (for example a missing validation).                                                                                                                                      |
| `file_refused`                                       | 422 `unsafe_content`      | An uploaded file was refused: its validation, the malware scanner hook, or invalid UTF-8.                                                                                                                     |
| `redaction_incomplete`                               | 422 `unsafe_content`      | A custom redaction pattern could not be applied, so the content is refused rather than stored partly redacted (fail closed).                                                                                  |
| `engine_budget`                                      | 429 `rate_limited`        | The per-user budget of earlier-view computations is empty. Wait for `Retry-After`.                                                                                                                            |

### Pagination

List routes take `limit` (1 to 200, default 50) and `cursor` (an opaque string of at most 200 characters) and answer `{ "items": [...], "nextCursor": "..." | null }`; a few add `total`. A handful of routes return a named collection instead of `items` (the timeline returns `events`, with `total`, `nextCursor` and the as-of counters); the registry has each schema.

A cursor is checksummed and bound to the list it was minted for, so a forged, truncated or foreign cursor is a **422** `validation_failed` (path `cursor`), never a database error ([DATA_MODEL.md](DATA_MODEL.md#33-pagination-cursors)). Pass `nextCursor` back unchanged and do not parse it.

### Idempotency

Six routes honour an `Idempotency-Key` header: `cases.create`, `cases.createFromFile`, `analysis.start`, `counterfactuals.run`, `skills.extract` and `skills.proposeMutation`.

- The key is optional. Without it the request simply runs. With it, the value must be 8 to 128 characters of `A-Z a-z 0-9 . _ : -` starting with a letter or digit; anything else is a 422 (path `header.idempotency-key`).
- The first request reserves the key, runs and stores its status and body. An identical retry (same route, params, query, body and file) gets the stored answer with `Idempotent-Replayed: true`. The same key with a different request is a 422 `idempotency_conflict`; the same key while the first request is still running is a 409 `conflict`.
- A key is **private to the calling user** inside the tenant and to the route, so another user can neither replay an answer nor block a key.
- A completed key lives 24 hours, a reservation older than 5 minutes is taken over, a failed attempt releases the key, and a stored response (at most 1 MiB) is erased together with the case it describes. The replay is audited with `details.replayed: true`. Details: [DATA_MODEL.md](DATA_MODEL.md#8-idempotency).
- Idempotency is not the only protection against repeats. Ingesting the same content again answers 201 with `created: false` and no `analysisJob`, and `analysis.start` reuses an analysis whose input is identical (`reused: true`) unless `force` is set. Both were read in code (`ingestion/persist.ts`, the analysis service), not run for this page.

### Asynchronous jobs

Work that can take seconds runs as a job: `analysis.start`, `counterfactuals.run`, `skills.extract` and `skills.proposeMutation` answer **202** with a `job`, and `cases.create` returns the analysis it started as `analysisJob`. (The `portfolio` profile of `demo.seed` also records a `demo_seed` job, but that route waits for it and answers 200.)

1. Read the `job` from the answer. Its `status` is `queued`, `running`, `succeeded`, `failed` or `cancelled`; `kind` is `case_analysis`, `counterfactual`, `skill_extraction`, `skill_mutation` or `demo_seed`.
2. Poll `jobs.get` (`GET /api/v1/jobs/{jobId}`) until the status is terminal. `progress` carries `percent`, the current `stage` and the `stages[]` (`id`, `label`, `status`, `startedAt`, `completedAt`, `detail`). A finished job has a `resultRef` (`{ type, id }`, for example the `analysis_run`); a failed one has an `error` (`code`, `message`).
3. Cancel with `jobs.cancel` while `cancellable` is true. Any signed-in user may call the route, and the job service then requires the permission that starts that kind of job.

Jobs run on the API process (concurrency 2, no external queue, a 10-minute limit). A heartbeat every 10 seconds lets another replica tell a live job from an orphaned one (silent for 60 seconds), and a cancel on another replica is noticed at the next heartbeat. The multi-replica behaviour is tested with two service instances on one PGlite database, not with two real replicas. See [DATA_MODEL.md](DATA_MODEL.md#9-jobs) and [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).

### Temporal reads (asOf)

The views of a case (`twin`, `timeline`, `evidence`, `hypotheses`, `actions`, `action-values`, `forks`, `record-findings`, `graph`, `quality`, `metrics`, `warnings`, `skill-matches`, `provenance`, a match's `overlay`, and `events` for one source event) take an optional `asOf` query parameter: a UTC ISO-8601 timestamp. The `Input` column of the route tables marks them.

- **Recomputed, never filtered.** With `asOf` the engine runs again on a temporal view that holds only what was recorded at or before that instant (the resolution only once it is inside the window). A filtered copy of the final analysis would leak through every derived number, so none is made. Without `asOf` the stored artefacts of the latest analysis are served ([ARCHITECTURE.md](ARCHITECTURE.md#8-temporal-integrity-design)).
- **Human input made after `asOf` is invisible.** A claim review, an action-value override, a warning dismissal or a fork review shows in a window only from the moment it was made; the whole-record view (no `asOf`) shows all of it. The table is in [the views README](../apps/api/src/services/views/README.md).
- **Reviewer overrides of the action ranking.** `action-values` lists them in `reviewerOverrides` (`instant` it is about, `actionKey`, `actionName`, `rank`, `reason`, `by`, `at`; the latest decision per instant and action, newest first, 200 at most), next to the candidates whose inline `override` still shows only the override about the ranking's own instant. The whole record lists every override of the case. A window (`asOf` or `forkId`) shows only what was decided, and is about an instant, at or before its end: nothing of later overrides is sent, not even their number, so the response of an earlier window is the same whether or not later overrides exist. The field is optional in the schema.
- **Cost.** What a pass depends on is the set of visible events, so every instant between two events shares one pass, and cached windows are free. A cold pass costs one unit of a per-user budget of 30 units per minute (tenant and user, shared with skill matching, constants rather than settings). An empty budget is a 429 with `Retry-After`; a scrub across more than 30 never-visited instants gets one. A refused request caches nothing, so a burst of them cannot push out the passes other users paid for.
- **A never-analysed case** answers 409 on the artefact views (`events.get` reads the immutable record and works before analysis).
- **Skill matches** (`skillMatches.list`) follow the same rule. The matcher is given a temporal view, never the filtered final analysis, and the skills extracted from the case being read are left out of an as-of list (their triggers were learned partly from what happened later). The instant is canonicalised to the last event the matcher can see, match ids are deterministic (`smt_` derived from the case and the skill, so a match that was listed can be applied by id), and a read stores and audits nothing. An applied match is a human decision and survives its skill being deprecated or retired: it is kept and flagged with the skill's current lifecycle ([skills README](../apps/api/src/services/skills/README.md)).
- **Provenance** (`provenance.resolve`) knows a record by the rule of `events.get`: an event, a simulated path or a derived record that only exists later is reported in `unresolved` as `not_yet_known`, with nothing else about it. The whole record serves the stored artefacts; an `asOf` serves the engine's analysis of that window, never a filtered copy. Evidence and claims are checked against the stored event on every read and only a `verified` citation carries the surrounding text ([DOMAIN_ENGINE.md](DOMAIN_ENGINE.md#51-source-references-and-checking-a-citation-provenance)). It writes and audits nothing.
- **The skill overlay** (`skillOverlay.get`) reads the match exactly as `skillMatches.list` does for the same `asOf` (404 when that moment has no such match, for example the skill extracted from the case itself as of an earlier instant), and the decision points of the window the way `forks.list` does. The recorded path of a decision point includes later events, so its figures are shown only when the whole record is visible; before that its rows say so. It writes and audits nothing, and adopting the plan stays `skillMatches.apply` ([DOMAIN_ENGINE.md](DOMAIN_ENGINE.md#13-skilldna)).
- **Record findings** (`recordFindings.get`) is what the record itself shows, read without a model: statements of the case that cannot both stand (`conflicts`, at most 100, each with both sides, the rule that found it and an uncertainty), patterns that need more than one event (`sequenceFindings`, at most 100, each about an instant and naming only events recorded by then) and the words the detectors read and did not count because the sentence does not state the fact (`setAside`, at most 200: a denial, a guess, a plan or a request, with the cue that decided it; `setAsideTotal` is the true count when the list was cut). Nothing is stored: the engine reads the events of the window, so with `asOf` nothing recorded later can reach any field, and without it the answer is about the whole record. It costs what any other pass costs (one unit of the budget above when the window is cold, nothing when another request already paid for it) and it writes and audits nothing ([DETECTION.md](DETECTION.md#7-conflicts)).

Observed on the second synthetic sample with the deterministic provider (`GET /api/v1/cases/{caseId}/timeline?limit=3&asOf=2026-04-14T07:52:00Z`, the time of its second event): `total` 2, `withheldFutureEventCount` 13 and `knownAtAsOf` `{ "evidenceCount": 5, "claimCount": 11, "criticalMissingCount": 2, "openWarningCount": 0 }`; the same case without `asOf` reports 15 events. `GET .../quality?asOf=...` on the same instant returned a Case Quality Index assessment with `asOf` set and a score range, and without `asOf` it returned the whole-record assessment with `asOf` null.

### Rate limits

All limiters are in memory and per replica ([KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md)).

| Limit             | Applies to                                                                                             | Default                                                  | Counted per                                                                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| General           | Every route and every 404, before authentication (a 401 or 403 costs quota too); the probes are exempt | `RATE_LIMIT_MAX` 300 per `RATE_LIMIT_WINDOW_MS` (60,000) | Client address, IPv6 by its /64. Behind the web tier it is the address the web server reports in `x-cg-client-ip`, believed only when `TRUST_CLIENT_IP_HEADER=true` ([SECURITY.md](SECURITY.md#client-address-for-rate-limits)). |
| Heavy route       | The routes listed in the next section                                                                  | `RATE_LIMIT_AI_MAX` 30 per window                        | The user (tenant plus user id).                                                                                                                                                                                                  |
| As-of engine pass | Cold views and skill matching ([Temporal reads](#temporal-reads-asof))                                 | 30 per 60 seconds, not configurable                      | Tenant plus user.                                                                                                                                                                                                                |

A refusal is a 429 `rate_limited` with `Retry-After` (seconds), and CORS exposes that header. The client-address handling is implemented and tested with simulated headers; it has not been observed behind a real Container Apps ingress.

### Heavy routes

These routes start expensive or AI-assisted work, or walk a lot of data, so they also count against the per-user heavy limit (`HEAVY_ROUTES` in `apps/api/src/http/route-binder.ts`; a test keeps this list equal to the code):

- Engine and AI work: `analysis.start`, `counterfactuals.run`, `skills.extract`, `skills.simulationTest`, `skills.proposeMutation`, `skills.apply`, `skillMatches.apply`.
- Ingestion (parse, redact, screen): `cases.create`, `cases.createFromFile`, `ingestion.preview`, `ingestion.previewFile`.
- Demo data: `demo.seed`.
- Large reads: `governance.export` (a case or audit export) and `governance.auditVerify` (walks the whole audit hash chain).

The heavy limit counts a request only after it passed authentication and validation, so a malformed request does not spend it.

### Size limits and uploads

| Limit        | Value                                                                                                                                                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JSON body    | `BODY_LIMIT_BYTES`, default 1 MiB; over it is a 413                                                                                                                                                                                                                       |
| Upload       | `UPLOAD_MAX_BYTES`, default 2 MiB; one file, at most 4 other fields and 6 parts; the file field is named `file`                                                                                                                                                           |
| Cut upload   | A file cut at the limit is refused with 413 and never stored; a broken or boundary-less multipart body is a 400                                                                                                                                                           |
| File content | Decided from the bytes: extensions `.json`, `.txt`, `.log`, `.md` and `.csv` only; UTF-8 or ASCII text; executables, archives, documents, images and web-page content refused. A malware-scanner hook exists but the scanner is a stub; no antivirus engine is integrated |
| Redaction    | Applied to every ingest before anything is stored; if a tenant's custom pattern cannot be applied, the ingest is refused with 422 `unsafe_content`                                                                                                                        |

The upload rules are in [SECURITY.md](SECURITY.md#71-uploads-validateupload).

## Worked examples

The examples use the default API address `http://localhost:4000` ([LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md)) and the development persona `user_ava_engineer`. I ran each against a local API on another port with an in-memory database, the deterministic provider and `DEMO_AUTO_SEED=false`, using Git Bash for the `curl` forms and Windows PowerShell 5.1 for the PowerShell forms. Identifiers are generated, so yours differ.

### 1. A read: list cases

```bash
curl -s "http://localhost:4000/api/v1/cases?limit=1" -H "x-cg-persona: user_ava_engineer"
```

```powershell
Invoke-RestMethod -Uri "http://localhost:4000/api/v1/cases?limit=1" -Headers @{ 'x-cg-persona' = 'user_ava_engineer' }
```

The answer is 200 (excerpt; each item also has `analysisState`, `analyzedAt`, `qualityIndex`, `avoidableEffortPct`, `openWarningCount`, `leadingHypothesis`, `eventCount`, `severity`, `synthetic` and more):

```json
{
  "items": [
    {
      "id": "case_01M65ZTMYAKHHYMV97TZ42KMPM",
      "reference": "CG-SYN-1002",
      "status": "resolved",
      "title": "Intermittent Teams sign-in failures for about 60 users at the Rotterdam site"
    }
  ],
  "nextCursor": "WzEsImNhc2VzIiwiMjAyNi0w..."
}
```

Without the header the same call is a 401 `unauthenticated`; `?limit=999` is the 422 shown under [Errors](#errors).

### 2. An idempotent create

```bash
curl -s -i -X POST "http://localhost:4000/api/v1/cases" \
  -H "x-cg-persona: user_ava_engineer" \
  -H "content-type: application/json" \
  -H "idempotency-key: docs-example-case-one-0001" \
  -d '{"source":{"type":"sample","sampleId":"case-one-teams-signin-dns"}}'
```

Windows PowerShell 5.1 strips the double quotes of a JSON argument passed to `curl.exe`, so use `Invoke-WebRequest`, or put the body in a file and send it with `--data-binary "@body.json"` (both ran):

```powershell
$headers = @{ 'x-cg-persona' = 'user_ava_engineer'; 'Idempotency-Key' = 'docs-example-case-one-0001' }
$body = '{"source":{"type":"sample","sampleId":"case-one-teams-signin-dns"}}'
$r = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://localhost:4000/api/v1/cases" `
  -Headers $headers -ContentType 'application/json' -Body $body
$r.StatusCode; $r.Headers['Idempotent-Replayed']
```

The first request answered `201 Created` (headers `cache-control: no-store`, an `x-request-id` and `content-type: application/json; charset=utf-8`; no `idempotent-replayed`). Body, with the `preview` block and the other fields of `case` and `analysisJob` omitted:

```json
{
  "case": {
    "id": "case_01M65ZPP07E0BG8D531KFPRS09",
    "reference": "CG-SYN-1001",
    "status": "resolved",
    "analysisState": "queued",
    "eventCount": 31,
    "synthetic": true
  },
  "sourceId": "src_01M65ZPP087SR9P2AQ9CJTSFXH",
  "eventCount": 31,
  "created": true,
  "analysisJob": {
    "id": "job_01M65ZPR1HZ9D19EPNRVQ25FHH",
    "kind": "case_analysis",
    "status": "queued",
    "caseId": "case_01M65ZPP07E0BG8D531KFPRS09",
    "cancellable": true
  }
}
```

The **same request again** answered `201 Created` with a new `x-request-id`, the header `idempotent-replayed: true` and a body byte-identical to the first (checked with `cmp`). The **same key with a different body** (the other sample) answered 422:

```json
{
  "type": "urn:caseguard:problem:idempotency_conflict",
  "title": "Idempotency key reuse",
  "status": 422,
  "code": "idempotency_conflict",
  "correlationId": "req_01M65ZPZSPN3ZHT8J00N8BAPPJ",
  "detail": "This Idempotency-Key was already used with a different request"
}
```

### 3. Poll an asynchronous job

Take the `analysisJob.id` of the previous answer (the second sample was used here, so the ids differ from example 2):

```bash
curl -s "http://localhost:4000/api/v1/jobs/job_01M65ZTN5F0XB01ZY9959QQE6P" -H "x-cg-persona: user_ava_engineer"
```

```powershell
Invoke-RestMethod -Uri "http://localhost:4000/api/v1/jobs/job_01M65ZTN5F0XB01ZY9959QQE6P" -Headers @{ 'x-cg-persona' = 'user_ava_engineer' }
```

Right after creation the job was `queued` at 0 percent, stage `load`. The first poll, about a second later, already read (other fields omitted; `progress.stages` listed `load`, `analyse`, `counterfactuals`, `assess`, `warnings`, `skills`, `agents` and `save`, all `done`):

```json
{
  "id": "job_01M65ZTN5F0XB01ZY9959QQE6P",
  "kind": "case_analysis",
  "status": "succeeded",
  "caseId": "case_01M65ZTMYAKHHYMV97TZ42KMPM",
  "progress": { "percent": 100, "stage": "save" },
  "resultRef": { "type": "analysis_run", "id": "run_01M65ZTNA0194874G2YJ86841A" },
  "error": null,
  "cancellable": false,
  "createdBy": "user_ava_engineer"
}
```

I never caught a `running` answer: the deterministic provider finishes the synthetic samples within a few seconds. A client should poll every second or two until `status` is `succeeded`, `failed` or `cancelled`, and treat `error` as the reason for a failure. `jobs.cancel` was not run for this page.

## Route reference

<!-- BEGIN GENERATED ROUTE REFERENCE: written by scripts/export-api-docs.ts, do not edit by hand -->

78 routes (53 GET, 22 POST, 2 PUT, 1 DELETE) in 13 groups, generated from `ROUTES` in `packages/schemas/src/api.ts`.
A trailing `?` marks a field that may be left out; path parameters are the `:name` segments of the request. Every path starts with `/api/v1`.

### Identity

| Route id       | Request                    | Permission                                                              | Success | Input | Summary                                                          |
| -------------- | -------------------------- | ----------------------------------------------------------------------- | ------- | ----- | ---------------------------------------------------------------- |
| `session.me`   | `GET /api/v1/me`           | any signed-in user                                                      | 200     | none  | Current user, tenant, permissions and honesty notices            |
| `dev.personas` | `GET /api/v1/dev/personas` | none (public); lists personas only when development identity is enabled | 200     | none  | Development personas (only when development identity is enabled) |

### Ingestion

| Route id                | Request                                          | Permission    | Success | Input             | Summary                                                                                      |
| ----------------------- | ------------------------------------------------ | ------------- | ------- | ----------------- | -------------------------------------------------------------------------------------------- |
| `samples.list`          | `GET /api/v1/samples`                            | `case:read`   | 200     | none              | Built-in synthetic sample cases                                                              |
| `ingestion.preview`     | `POST /api/v1/ingestion/preview`                 | `case:ingest` | 200     | body: `source`    | Validate, redact and preview a case payload without persisting it                            |
| `ingestion.previewFile` | `POST /api/v1/ingestion/preview-file`            | `case:ingest` | 200     | multipart: `file` | Preview an uploaded file (multipart/form-data: field "file", optional text field "workload") |
| `schemas.caseBundle`    | `GET /api/v1/schemas/case-bundle.schema.json`    | `case:read`   | 200     | none              | JSON Schema for case bundles                                                                 |
| `schemas.knowledgePack` | `GET /api/v1/schemas/knowledge-pack.schema.json` | `case:read`   | 200     | none              | JSON Schema for workload knowledge packs                                                     |
| `examples.list`         | `GET /api/v1/examples`                           | `case:read`   | 200     | none              | Downloadable example case bundles (synthetic)                                                |
| `examples.get`          | `GET /api/v1/examples/:exampleId`                | `case:read`   | 200     | none              | Download one example case bundle                                                             |

### Cases

| Route id               | Request                        | Permission    | Success         | Input                                                                      | Summary                                                                                     |
| ---------------------- | ------------------------------ | ------------- | --------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `cases.create`         | `POST /api/v1/cases`           | `case:ingest` | 201, idempotent | body: `source`, `options?`                                                 | Ingest a case (idempotent) and optionally start analysis                                    |
| `cases.createFromFile` | `POST /api/v1/cases/upload`    | `case:ingest` | 201, idempotent | multipart: `file`                                                          | Ingest an uploaded file (multipart/form-data: field "file", optional text field "workload") |
| `cases.list`           | `GET /api/v1/cases`            | `case:read`   | 200             | query: `limit?`, `cursor?`, `status?`, `workload?`, `analysisState?`, `q?` | List cases (paginated)                                                                      |
| `cases.get`            | `GET /api/v1/cases/:caseId`    | `case:read`   | 200             | none                                                                       | Case detail                                                                                 |
| `cases.delete`         | `DELETE /api/v1/cases/:caseId` | `case:delete` | 200             | none                                                                       | Delete a case and all derived data (administrator)                                          |

### Analysis

| Route id          | Request                               | Permission     | Success              | Input          | Summary                                                            |
| ----------------- | ------------------------------------- | -------------- | -------------------- | -------------- | ------------------------------------------------------------------ |
| `analysis.start`  | `POST /api/v1/cases/:caseId/analysis` | `case:analyze` | 202, job, idempotent | body: `force?` | Start (or reuse) the case analysis. Identical input never re-runs. |
| `analysis.latest` | `GET /api/v1/cases/:caseId/analysis`  | `case:read`    | 200                  | none           | Latest analysis run summary                                        |

### Jobs

| Route id      | Request                           | Permission                                                                                    | Success | Input                                                     | Summary                        |
| ------------- | --------------------------------- | --------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------- | ------------------------------ |
| `jobs.get`    | `GET /api/v1/jobs/:jobId`         | `case:read`                                                                                   | 200     | none                                                      | Job status and progress        |
| `jobs.cancel` | `POST /api/v1/jobs/:jobId/cancel` | any signed-in user; the job service then requires the permission that starts that kind of job | 200     | none                                                      | Cancel a queued or running job |
| `jobs.list`   | `GET /api/v1/jobs`                | `case:read`                                                                                   | 200     | query: `limit?`, `cursor?`, `caseId?`, `status?`, `kind?` | List jobs (paginated)          |

### Case analysis

| Route id               | Request                                             | Permission             | Success | Input                                                                                                                | Summary                                                                              |
| ---------------------- | --------------------------------------------------- | ---------------------- | ------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `twin.get`             | `GET /api/v1/cases/:caseId/twin`                    | `case:read`            | 200     | query: `asOf?`                                                                                                       | Digital twin, optionally as of a past instant                                        |
| `timeline.get`         | `GET /api/v1/cases/:caseId/timeline`                | `case:read`            | 200     | query: `limit?`, `cursor?`, `asOf?`, `types?`, `roles?`, `hypothesisId?`, `category?`, `scenarioId?`, `from?`, `to?` | Chronological timeline with filters, delays, repeats and hypothesis series           |
| `events.get`           | `GET /api/v1/cases/:caseId/events/:eventId`         | `case:read`            | 200     | query: `asOf?`                                                                                                       | Source event with derived claims and evidence                                        |
| `provenance.resolve`   | `GET /api/v1/cases/:caseId/provenance`              | `case:read`            | 200     | query: `asOf?`, `links`                                                                                              | Resolve evidence links to the stored source text, checking each excerpt against it   |
| `evidence.list`        | `GET /api/v1/cases/:caseId/evidence`                | `case:read`            | 200     | query: `limit?`, `cursor?`, `asOf?`, `category?`, `reviewState?`, `hypothesisId?`, `q?`                              | Evidence ledger (claims classified into eight categories)                            |
| `claims.review`        | `POST /api/v1/cases/:caseId/claims/:claimId/review` | `evidence:review`      | 200     | body: `category`, `reason`, `expectedVersion`                                                                        | Correct a claim classification (original AI classification is preserved and audited) |
| `hypotheses.list`      | `GET /api/v1/cases/:caseId/hypotheses`              | `case:read`            | 200     | query: `asOf?`                                                                                                       | Competing hypotheses with time-indexed confidence                                    |
| `actions.list`         | `GET /api/v1/cases/:caseId/actions`                 | `case:read`            | 200     | query: `asOf?`                                                                                                       | Diagnostic actions taken in the case                                                 |
| `actionValue.rank`     | `GET /api/v1/cases/:caseId/action-values`           | `case:read`            | 200     | query: `asOf?`, `forkId?`                                                                                            | Rank next actions: transparent calculation, sensitivity, reviewer overrides          |
| `actionValue.override` | `POST /api/v1/cases/:caseId/action-values/override` | `actionvalue:override` | 200     | body: `asOf`, `actionKey`, `rank`, `reason`                                                                          | Record a reviewer override of the action ranking (audited)                           |
| `forks.list`           | `GET /api/v1/cases/:caseId/forks`                   | `case:read`            | 200     | query: `asOf?`                                                                                                       | Decision forks (decision-time view when asOf is given)                               |
| `forks.get`            | `GET /api/v1/cases/:caseId/forks/:forkId`           | `case:read`            | 200     | query: `asOf?`                                                                                                       | One decision fork (decision-time view when asOf is given)                            |
| `recordFindings.get`   | `GET /api/v1/cases/:caseId/record-findings`         | `case:read`            | 200     | query: `asOf?`                                                                                                       | Statements that disagree, patterns across events, and words read but not counted     |
| `graph.get`            | `GET /api/v1/cases/:caseId/graph`                   | `case:read`            | 200     | query: `asOf?`, `scenarioId?`                                                                                        | Investigation graph model (bounded)                                                  |

### Counterfactual lab

| Route id                    | Request                                                           | Permission              | Success              | Input                                         | Summary                                                                      |
| --------------------------- | ----------------------------------------------------------------- | ----------------------- | -------------------- | --------------------------------------------- | ---------------------------------------------------------------------------- |
| `counterfactuals.run`       | `POST /api/v1/cases/:caseId/forks/:forkId/counterfactuals`        | `counterfactual:run`    | 202, job, idempotent | body: `strategies?`                           | Generate counterfactual paths for a fork (temporal boundary enforced)        |
| `counterfactuals.list`      | `GET /api/v1/cases/:caseId/counterfactuals`                       | `case:read`             | 200                  | query: `forkId?`                              | Counterfactual scenarios                                                     |
| `counterfactuals.get`       | `GET /api/v1/cases/:caseId/counterfactuals/:scenarioId`           | `case:read`             | 200                  | none                                          | One counterfactual scenario                                                  |
| `counterfactuals.review`    | `POST /api/v1/cases/:caseId/counterfactuals/:scenarioId/review`   | `counterfactual:review` | 200                  | body: `decision`, `reason`, `expectedVersion` | Accept or reject a counterfactual path with a reason (audited)               |
| `counterfactuals.hindsight` | `GET /api/v1/cases/:caseId/counterfactuals/:scenarioId/hindsight` | `quality:review`        | 200                  | none                                          | Post-hoc hindsight check (uses the final resolution; never feeds generation) |

### Quality

| Route id           | Request                                                  | Permission        | Success | Input                             | Summary                                             |
| ------------------ | -------------------------------------------------------- | ----------------- | ------- | --------------------------------- | --------------------------------------------------- |
| `quality.get`      | `GET /api/v1/cases/:caseId/quality`                      | `quality:read`    | 200     | query: `asOf?`                    | Case Quality Index assessment                       |
| `metrics.get`      | `GET /api/v1/cases/:caseId/metrics`                      | `quality:read`    | 200     | query: `asOf?`                    | Metric estimates including Avoidable Support Effort |
| `warnings.list`    | `GET /api/v1/cases/:caseId/warnings`                     | `case:read`       | 200     | query: `asOf?`, `state?`          | Live quality warnings as of a time cursor           |
| `warnings.dismiss` | `POST /api/v1/cases/:caseId/warnings/:warningId/dismiss` | `warning:dismiss` | 200     | body: `reason`, `expectedVersion` | Dismiss a warning with a reason (audited)           |
| `coaching.get`     | `GET /api/v1/cases/:caseId/coaching`                     | `quality:read`    | 200     | none                              | Constructive coaching report                        |
| `compare.cases`    | `GET /api/v1/compare`                                    | `analytics:read`  | 200     | query: `caseIds`                  | Compare outcomes between two cases                  |

### SkillDNA

| Route id                 | Request                                                     | Permission       | Success              | Input                                            | Summary                                                                                |
| ------------------------ | ----------------------------------------------------------- | ---------------- | -------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `skillMatches.list`      | `GET /api/v1/cases/:caseId/skill-matches`                   | `skill:read`     | 200                  | query: `asOf?`                                   | SkillDNA matches using only evidence available as of the cursor                        |
| `skillMatches.apply`     | `POST /api/v1/cases/:caseId/skill-matches/:matchId/apply`   | `skill:apply`    | 200                  | none                                             | Apply a matched skill to the case (records the application)                            |
| `skillOverlay.get`       | `GET /api/v1/cases/:caseId/skill-matches/:matchId/overlay`  | `skill:read`     | 200                  | query: `asOf?`                                   | What a matched skill would have changed: the recorded path beside an explicit estimate |
| `skills.list`            | `GET /api/v1/skills`                                        | `skill:read`     | 200                  | query: `limit?`, `cursor?`, `lifecycle?`, `q?`   | SkillDNA library (paginated)                                                           |
| `skills.get`             | `GET /api/v1/skills/:skillId`                               | `skill:read`     | 200                  | none                                             | Skill detail with allowed lifecycle transitions                                        |
| `skills.versions`        | `GET /api/v1/skills/:skillId/versions`                      | `skill:read`     | 200                  | none                                             | Version history                                                                        |
| `skills.diff`            | `GET /api/v1/skills/:skillId/diff`                          | `skill:read`     | 200                  | query: `fromVersionId`, `toVersionId`            | Human-readable diff between two versions                                               |
| `skills.extract`         | `POST /api/v1/cases/:caseId/skills/extract`                 | `skill:extract`  | 202, job, idempotent | body: `scenarioId`                               | Extract a draft SkillDNA from an accepted counterfactual path                          |
| `skills.transition`      | `POST /api/v1/skills/:skillId/transition`                   | `skill:review`   | 200                  | body: `toState`, `reason`, `expectedVersion`     | Move a skill through its lifecycle (role-gated, optimistic lock, audited)              |
| `skills.simulationTest`  | `POST /api/v1/skills/:skillId/simulation-test`              | `skill:validate` | 200                  | body: `kind?`, `caseId?`, `versionId?`           | Replay the skill against its source case at the original decision point                |
| `skills.proposeMutation` | `POST /api/v1/skills/:skillId/mutations`                    | `skill:mutate`   | 202, job, idempotent | body: `sourceCaseId`                             | Propose a new skill version from another case (never auto-applied)                     |
| `skills.versionDecision` | `POST /api/v1/skills/:skillId/versions/:versionId/decision` | `skill:approve`  | 200                  | body: `decision`, `reason`, `expectedVersion`    | Approve or reject a proposed skill version                                             |
| `skills.rollback`        | `POST /api/v1/skills/:skillId/rollback`                     | `skill:rollback` | 200                  | body: `toVersionId`, `reason`, `expectedVersion` | Roll back to an earlier version by creating a new version with that content            |
| `skills.apply`           | `POST /api/v1/cases/:caseId/skills/apply`                   | `skill:apply`    | 200                  | body: `skillId`                                  | Apply a skill to a case (creates or updates the match)                                 |

### Dashboards

| Route id                  | Request                           | Permission       | Success | Input                                           | Summary                                                                   |
| ------------------------- | --------------------------------- | ---------------- | ------- | ----------------------------------------------- | ------------------------------------------------------------------------- |
| `dashboard.commandCenter` | `GET /api/v1/command-center`      | `case:read`      | 200     | query: `caseId?`                                | Command center aggregate                                                  |
| `efficiency.overview`     | `GET /api/v1/efficiency/overview` | `telemetry:read` | 200     | query: `caseId?`                                | Token and compute efficiency (estimated / simulated values are labelled)  |
| `efficiency.executions`   | `GET /api/v1/model-executions`    | `telemetry:read` | 200     | query: `limit?`, `cursor?`, `caseId?`, `agent?` | Model executions with token usage (paginated)                             |
| `analytics.overview`      | `GET /api/v1/analytics/overview`  | `analytics:read` | 200     | none                                            | Privacy-safe quality analytics (never ranks individuals)                  |
| `search.global`           | `GET /api/v1/search`              | `case:read`      | 200     | query: `q`, `limit?`                            | Global search across cases, claims, hypotheses and skills (tenant-scoped) |

### Governance

| Route id                 | Request                                      | Permission         | Success | Input                                                                                    | Summary                                                          |
| ------------------------ | -------------------------------------------- | ------------------ | ------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `governance.get`         | `GET /api/v1/governance/settings`            | `governance:read`  | 200     | none                                                                                     | All governed configuration sections                              |
| `governance.update`      | `PUT /api/v1/governance/settings/:section`   | `governance:write` | 200     | body: `value`, `expectedVersion`, `changeNote`                                           | Update one configuration section (versioned, validated, audited) |
| `governance.prompts`     | `GET /api/v1/governance/prompts`             | `governance:read`  | 200     | none                                                                                     | Versioned prompts                                                |
| `governance.users`       | `GET /api/v1/governance/users`               | `governance:read`  | 200     | none                                                                                     | Users and role assignments                                       |
| `governance.assignRoles` | `PUT /api/v1/governance/users/:userId/roles` | `roles:manage`     | 200     | body: `roles`, `expectedVersion`, `reason`                                               | Assign roles to a user (audited)                                 |
| `governance.audit`       | `GET /api/v1/audit`                          | `audit:read`       | 200     | query: `limit?`, `cursor?`, `action?`, `actorId?`, `caseId?`, `outcome?`, `from?`, `to?` | Audit log (paginated, append-only, hash-chained)                 |
| `governance.auditVerify` | `GET /api/v1/audit/verify`                   | `audit:read`       | 200     | none                                                                                     | Verify the audit hash chain                                      |
| `governance.reviews`     | `GET /api/v1/governance/reviews`             | `audit:read`       | 200     | query: `limit?`, `cursor?`, `caseId?`                                                    | Recorded reviewer decisions (paginated)                          |
| `governance.export`      | `POST /api/v1/governance/export`             | `export:data`      | 200     | body: `scope`, `caseId?`, `reason`                                                       | Export case or audit data (guarded by export controls; audited)  |

### Demo

| Route id     | Request                   | Permission    | Success | Input            | Summary                                        |
| ------------ | ------------------------- | ------------- | ------- | ---------------- | ---------------------------------------------- |
| `demo.state` | `GET /api/v1/demo/state`  | `case:read`   | 200     | none             | Guided demo progress derived from real data    |
| `demo.seed`  | `POST /api/v1/demo/seed`  | `demo:manage` | 200     | body: `profile?` | Seed synthetic demo data (idempotent)          |
| `demo.reset` | `POST /api/v1/demo/reset` | `demo:manage` | 200     | none             | Reset synthetic demo data to its initial state |

### System

| Route id          | Request                       | Permission       | Success | Input | Summary                                              |
| ----------------- | ----------------------------- | ---------------- | ------- | ----- | ---------------------------------------------------- |
| `system.health`   | `GET /api/v1/system/health`   | `telemetry:read` | 200     | none  | Dependency health, migrations and AI provider status |
| `system.metrics`  | `GET /api/v1/system/metrics`  | `telemetry:read` | 200     | none  | In-process request, model and security metrics       |
| `system.provider` | `GET /api/v1/system/provider` | `telemetry:read` | 200     | none  | AI provider status and validation note               |

<!-- END GENERATED ROUTE REFERENCE -->

## Regenerating this page

The table between the two HTML comments is written by `scripts/export-api-docs.ts` from the `ROUTES` registry. The rest of the page is hand-written and is never touched: the script replaces only the text between the markers and then formats the whole file with Prettier.

| Command                                                    | What it does                                                                                                                                                                                             |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm docs:api`                                            | Rewrites the generated block after a change to the registry.                                                                                                                                             |
| `pnpm docs:api --check` (or `pnpm docs:api -- --check`)    | Writes nothing, prints the file and exits 1 when the committed block is stale. `pnpm verify` runs it inside its `generated:check` step, and so does CI.                                                  |
| `pnpm exec vitest run test/api-docs.test.ts` in `apps/api` | Unit tests of the generator, the marker handling and the drift check, plus two checks of this page: the heavy-route list equals `HEAVY_ROUTES` and the idempotency section names every idempotent route. |

The tables carry paths, permissions, success statuses and the names of the input fields, not their types. For the shape of a request or response open the route's entry in `packages/schemas/src/api.ts`, or the OpenAPI document of a local API (`/api/v1/openapi.json`, [Base path and content types](#base-path-and-content-types)).

Related: [SECURITY.md](SECURITY.md) (identity, the RBAC matrix, limits), [DATA_MODEL.md](DATA_MODEL.md) (idempotency, jobs, cursors), [ARCHITECTURE.md](ARCHITECTURE.md#5-request-pipeline) (the request pipeline), [OBSERVABILITY.md](OBSERVABILITY.md) (the `http.request` and `http.error` log events), [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).
