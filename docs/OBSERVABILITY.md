# Observability

Ready-to-use Kusto (KQL) queries for the questions an operator asks about CaseGuard AI in Azure: latency, errors, model behaviour, token use, retrieval, counterfactual failures, skill approvals and security events.

> **Not run against a real workspace.** Nothing has been deployed, so every query here is unexecuted. They are written for the log shape described in section 2, which was **reconciled with the code** of `packages/observability` and `apps/api` (field names, levels, events). **Table and column names of the Azure side depend on how logs are exported**, so run the "verify" queries in section 3 after the first deployment and adjust names before trusting any chart. Two things are not what an Azure operator might expect: the API does **not** start an OpenTelemetry or Azure Monitor exporter (Application Insights stays empty), and it has **no** `/metrics` scrape route (section 8). In Azure the only telemetry path that exists in code is container stdout to Log Analytics, and that path is designed, never deployed.

## 1. Where the telemetry comes from

| Source                                                   | How it reaches Log Analytics                                                                                                                                                                                                                                      | Table(s) (verify)                                                                                                                                  |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| API console output (JSON logs)                           | Container Apps environment > Azure Monitor diagnostic setting, resource-specific tables (`logAnalyticsDestinationType: Dedicated`)                                                                                                                                | `ContainerAppConsoleLogs` (columns such as `TimeGenerated`, `ContainerAppName`, `RevisionName`, `Log`)                                             |
| Platform/system events                                   | same                                                                                                                                                                                                                                                              | `ContainerAppSystemLogs` (revision provisioning, probe failures, image pull errors)                                                                |
| Ingress access logs (optional, off by default)           | same, when `containerAppsHttpLogs = true` (contains client IPs and paths: privacy review first)                                                                                                                                                                   | `ContainerAppHTTPLogs`                                                                                                                             |
| Container Apps metrics                                   | diagnostic setting `AllMetrics` on the apps, also Azure Monitor metrics                                                                                                                                                                                           | `AzureMetrics` (`Requests`, `ResponseTime` (Preview), `Replicas`, `UsageNanoCores`, ...)                                                           |
| Application Insights                                     | **Not wired in the API.** `APPLICATIONINSIGHTS_CONNECTION_STRING` is parsed and validated by `packages/config`, and `@azure/monitor-opentelemetry` is a declared dependency, but nothing starts an exporter, so these tables stay empty. Designed, never deployed | `AppRequests`, `AppDependencies`, `AppExceptions`, `AppTraces`, `AppMetrics` (empty today)                                                         |
| Key Vault, storage, registry, PostgreSQL, Search, OpenAI | diagnostic settings of each resource                                                                                                                                                                                                                              | `AzureDiagnostics` (Key Vault, PostgreSQL, Search, OpenAI), `StorageBlobLogs`, `ContainerRegistryLoginEvents`, `ContainerRegistryRepositoryEvents` |

If the environment was switched to the legacy "Log Analytics" destination, the console logs land in `ContainerAppConsoleLogs_CL` with suffixed columns (`ContainerAppName_s`, `RevisionName_s`, `Log_s`). The base function below reads both shapes.

## 2. The log contract (as implemented)

The API writes one JSON object per line to stdout (pino, `packages/observability`) whenever `APP_ENV` is not `local`; in `local` the same
fields are printed as human-readable lines. The queries below use these fields (an event carries only the fields listed for it):

| Field                                                                           | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `level`                                                                         | lower-case **label string**: `trace`, `debug`, `info`, `warn`, `error`, `fatal` (not pino's numeric levels)                                                                                                                                                                                                                                                                                                                                   |
| `time`, `msg`                                                                   | `time` is an **ISO 8601 UTC string** such as `2026-10-29T13:05:40.018Z`; `msg` is the message                                                                                                                                                                                                                                                                                                                                                 |
| `requestId`, `traceId`, `spanId`                                                | correlation ids merged from the async request context into **every** line written during a request. `requestId` is also the `x-request-id` response header and the `correlationId` member of problem responses; `ai.model.execution` additionally carries it as a field named `correlationId`                                                                                                                                                 |
| `method`, `route`, `statusCode`, `durationMs`                                   | event `http.request`: verb, route **pattern** (`unmatched` when no route matched; never the raw URL or query), numeric HTTP status code, duration in whole milliseconds                                                                                                                                                                                                                                                                       |
| `agent`, `model`, `provider`, `status`, `source`, `latencyMs`, `fallbackReason` | event `ai.model.execution` (one per finished agent task). `status` is the **execution status** (`succeeded`, `failed`, `timed_out`, `cancelled`, `cache_hit`, `rejected_by_validation`, `circuit_open`, `budget_exceeded`), `source` is `model`, `cache`, `deterministic` or `deterministic_fallback`, and the latency field is `latencyMs`, not `durationMs`. Do not confuse it with `http.error`, where `status` is the numeric HTTP status |
| `promptTokens`, `completionTokens`                                              | token usage of a model call; `tokenSource` is `measured` or `estimated` (always `estimated` for the deterministic provider)                                                                                                                                                                                                                                                                                                                   |
| `event`                                                                         | dotted event name. Only the events listed under "Events emitted today" exist; planned names are listed separately                                                                                                                                                                                                                                                                                                                             |
| `tenantId`, `userId`                                                            | opaque identifiers merged from the async request context (`ai.model.execution` also sets `tenantId` and `caseId` itself). Logs must never contain e-mail addresses, prompts, case text or secrets (NFR-OBS-01, T7)                                                                                                                                                                                                                            |

Agent names come from `AGENT_NAMES`: `timeline_analyzer`, `evidence_classifier`, `hypothesis_generator`, `decision_fork_detector`, `counterfactual_simulator`, `quality_judge`, `skilldna_extractor`, `communication_coach`, `token_governor`, `safety_policy_validator`.

### Events emitted today

Searched in `apps/api/src` and `packages/ai/src` (`event:` values). Common fields (`level`, `time`, `msg`, `service`, `version`, `env`, `commit`, and the correlation fields above) are on every line; the table lists the event-specific fields.

| `event`                           | Level                                                                                                                                                                                              | Event-specific fields                                                                                                                                                                                                                                                                                                         | Meaning                                                                                                                                                                                                                                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http.request`                    | `info`; `debug` for `/livez`, `/healthz`, `/readyz`; `error` when `statusCode >= 500`                                                                                                              | `method`, `route`, `statusCode`, `durationMs`                                                                                                                                                                                                                                                                                 | One line per finished request (msg `request completed`). The raw URL and query are never logged                                                                                                                                                                                                         |
| `auth.failure`                    | `warn`                                                                                                                                                                                             | `reason` (`missing_credentials`, `malformed_credentials`, `malformed_token`, `invalid_signature`, `invalid_algorithm`, `unknown_signing_key`, `invalid_issuer`, `invalid_audience`, `token_expired`, `token_not_yet_valid`, `missing_claim`, `unknown_tenant`, `unknown_persona`, `unknown_user`, `user_disabled`), `routeId` | Authentication failed (msg `authentication failed`). The client only sees a generic 401. A JWKS outage is a 503 and is not an `auth.failure`                                                                                                                                                            |
| `access.denied`                   | `info`                                                                                                                                                                                             | `routeId`, `code`, `status` (403)                                                                                                                                                                                                                                                                                             | A permission or tenant check refused the request (msg `request denied`); one line per refusal. The audit event of the same name is in the database and is throttled (first refusal per caller and route per rate-limit window, with `suppressedSincePrevious`), so the log line count is the true count |
| `http.error`                      | `error` for an unexpected fault (msg `unhandled error`, with `err`); `warn` for a handled 5xx (`request failed`); `debug` for other 4xx (`request rejected`, or `request rejected before routing`) | `routeId`, `code`, `status` (numeric HTTP status)                                                                                                                                                                                                                                                                             | The problem+json answer the client received                                                                                                                                                                                                                                                             |
| `audit.write_failed`              | `error`                                                                                                                                                                                            | `routeId`                                                                                                                                                                                                                                                                                                                     | An audit event could not be written; the request outcome itself is unchanged. Also counted in `caseguard_errors_total{component="audit"}`                                                                                                                                                               |
| `idempotency.complete_failed`     | `error`                                                                                                                                                                                            | none                                                                                                                                                                                                                                                                                                                          | The response of an idempotent request could not be stored for replay                                                                                                                                                                                                                                    |
| `identity.sync_failed`            | `warn`                                                                                                                                                                                             | `err`                                                                                                                                                                                                                                                                                                                         | The signed-in Entra user could not be written to the tenant's user list (msg `could not sync the signed-in user to the user list`); the request continues with the stored user, or none                                                                                                                 |
| `job.heartbeat_failed`            | `warn`                                                                                                                                                                                             | `jobId`                                                                                                                                                                                                                                                                                                                       | A job heartbeat could not be written (the next beat retries)                                                                                                                                                                                                                                            |
| `job.outcome_not_recorded`        | `error`                                                                                                                                                                                            | `jobId`                                                                                                                                                                                                                                                                                                                       | How a job ended could not be saved after retries; a later sweep fails it as orphaned                                                                                                                                                                                                                    |
| `job.timed_out`                   | `error`                                                                                                                                                                                            | `limitMs`                                                                                                                                                                                                                                                                                                                     | A job exceeded its time limit (10 minutes) and was stopped                                                                                                                                                                                                                                              |
| `case.ingested`                   | `info`                                                                                                                                                                                             | `caseId`, `eventCount`, `sourceKind`, `redactionReplacements`, `injectionDetected`                                                                                                                                                                                                                                            | A case was stored (ids and counts only)                                                                                                                                                                                                                                                                 |
| `case.deleted`                    | `info`                                                                                                                                                                                             | `caseId`                                                                                                                                                                                                                                                                                                                      | A case was erased                                                                                                                                                                                                                                                                                       |
| `ingest.unsafe_upload_refused`    | `warn`                                                                                                                                                                                             | `code`, `status`                                                                                                                                                                                                                                                                                                              | An upload was refused by byte-level validation                                                                                                                                                                                                                                                          |
| `ingest.redaction_notes`          | `warn`                                                                                                                                                                                             | `notes`                                                                                                                                                                                                                                                                                                                       | The redaction engine skipped something (for example an unusable custom pattern)                                                                                                                                                                                                                         |
| `ingest.orphaned_object`          | `error`                                                                                                                                                                                            | `key`                                                                                                                                                                                                                                                                                                                         | A stored payload that no case refers to could not be removed                                                                                                                                                                                                                                            |
| `ingest.analysis_not_started`     | `warn` (known error) or `error`                                                                                                                                                                    | `caseId`, `code`, `status`                                                                                                                                                                                                                                                                                                    | The case was stored but its analysis could not be started                                                                                                                                                                                                                                               |
| `demo.seed.completed`             | `info`                                                                                                                                                                                             | `profile`, `jobId`, the seed tallies (for example `performed`, `skipped`)                                                                                                                                                                                                                                                     | The demo seed finished (new demo service; was uncommitted when I checked)                                                                                                                                                                                                                               |
| `demo.auto_seed`                  | `info`                                                                                                                                                                                             | `profile`, `completedSteps`, `totalSteps`                                                                                                                                                                                                                                                                                     | Start-up seeding (`DEMO_AUTO_SEED`) finished                                                                                                                                                                                                                                                            |
| `demo.auto_seed_failed`           | `error`                                                                                                                                                                                            | `profile`, `err`                                                                                                                                                                                                                                                                                                              | Start-up seeding failed; the server starts without demo data                                                                                                                                                                                                                                            |
| `demo.seed.mutation_not_proposed` | `warn`                                                                                                                                                                                             | `skillId`, `code`, `status`                                                                                                                                                                                                                                                                                                   | One step of the story seed was refused (the seed continues)                                                                                                                                                                                                                                             |
| `demo.reset.payload_not_removed`  | `warn`                                                                                                                                                                                             | `key`, `err`                                                                                                                                                                                                                                                                                                                  | A stored case payload could not be removed during a demo reset                                                                                                                                                                                                                                          |
| `demo.audit_failed`               | `error`                                                                                                                                                                                            | `action`, `err`                                                                                                                                                                                                                                                                                                               | A demo audit event could not be written                                                                                                                                                                                                                                                                 |
| `demo.cli_failed`                 | `error`                                                                                                                                                                                            | `command`, `err`                                                                                                                                                                                                                                                                                                              | The `demo:seed` / `demo:reset` command line failed                                                                                                                                                                                                                                                      |
| `ai.model.execution`              | `info`                                                                                                                                                                                             | `agent`, `model`, `provider`, `status`, `source`, `latencyMs`, `promptTokens`, `completionTokens`, `tokenSource`, `cacheHit`, `promptVersion`, `fallbackReason`, `injectionIndicators`, `tenantId`, `caseId`, `correlationId`                                                                                                 | One per finished AI task, including deterministic ones (msg `AI task finished`). No prompt, no case text, no model output                                                                                                                                                                               |
| `ai.circuit.transition`           | `warn`                                                                                                                                                                                             | `breaker`, `from`, `to`                                                                                                                                                                                                                                                                                                       | The circuit breaker changed state                                                                                                                                                                                                                                                                       |
| `ai.budget.refused`               | `info`                                                                                                                                                                                             | `agent`, `code` (`request_tokens`, `day_tokens`, `case_tokens`, `cost_limit`, `cost_unknown`)                                                                                                                                                                                                                                 | A token or cost budget refused a model call                                                                                                                                                                                                                                                             |
| `ai.budget.cost_unenforceable`    | `warn`                                                                                                                                                                                             | none                                                                                                                                                                                                                                                                                                                          | A cost limit is configured without unit prices; model calls are refused (logged once per orchestrator)                                                                                                                                                                                                  |
| `ai.provider.retry`               | `warn`                                                                                                                                                                                             | `agent`, `deployment`, `attempt`, `status` (HTTP status of the failed attempt), `code`, `delayMs`                                                                                                                                                                                                                             | The Azure OpenAI provider is retrying                                                                                                                                                                                                                                                                   |
| `ai.provider.unexpected`          | `error`                                                                                                                                                                                            | `agent`, `error`                                                                                                                                                                                                                                                                                                              | A provider failed in a way the provider code did not classify                                                                                                                                                                                                                                           |
| `ai.deterministic.invalid`        | `error`                                                                                                                                                                                            | `agent`, `kinds`, `issues` (at most five issue codes)                                                                                                                                                                                                                                                                         | The deterministic result itself failed validation (an internal defect)                                                                                                                                                                                                                                  |

Other lines have **no** `event` field and must be found by `msg`: the search lines below, `database migrations applied` (`info`, field `applied`), `configuration warning` (`warn`), `CaseGuard API started` (`info`, a redacted configuration summary that includes `http.trustProxy` and `http.trustClientIpHeader`), `marked jobs that lost their server as failed` (`warn`, field `recovered`), `shutting down` and `unhandled promise rejection` / `uncaught exception` (`fatal`).

Search lines (`apps/api/src/services/search/search-service.ts`; the query text is never logged, and documents and hits are reported by count only):

| `msg`                                                                       | Level   | Fields                                                   | Meaning                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------- | ------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Azure AI Search failed; using lexical search`                              | `warn`  | `failure`                                                | The external call failed and the PostgreSQL full-text search answered. `failure` is one of `unsafe_endpoint`, `invalid_index`, `invalid_tenant`, `timeout`, `aborted`, `auth`, `network`, `http_error`, `too_large`, `invalid_response` or `unexpected` |
| `Azure AI Search returned no usable documents; using lexical search`        | `warn`  | `failure` (always `no_usable_documents`)                 | The index answered with documents, none of which could be used (every one was dropped), so the PostgreSQL full-text search answered. An answer with **no** documents is not this case: it is returned as an empty list without a fallback               |
| `Azure AI Search returned malformed documents; they were discarded`         | `warn`  | `discarded`                                              | Documents of the caller's tenant dropped for a wrong shape, an invalid link or case id, or an empty title. Counted in `caseguard_errors_total{component="search", code="invalid_document"}`                                                             |
| `Azure AI Search returned documents of another tenant; they were discarded` | `error` | `discarded`                                              | Documents naming another tenant were dropped (the index ignored the filter or holds mixed data). Counted as `code="foreign_tenant_document"`. Treat any occurrence as a security incident                                                               |
| `Search hits that do not satisfy the result contract were discarded`        | `warn`  | `provider` (`azure-ai-search` or `lexical`), `discarded` | Hits of either provider dropped by the last check before the answer (response schema, valid ids, a case that fits the type, an `href` that is one of the app's own routes). Counted as `code="invalid_result"`                                          |

A dropped document or hit never fails the request. The requirements for index documents are in [runbooks/search-unavailable.md](runbooks/search-unavailable.md#index-document-requirements).

**Audit events are not in the log stream.** They are rows in `audit_events` (`GET /api/v1/audit`, verification at `GET /api/v1/audit/verify`, permission `audit:read`), for example `case.ingested`, `case.deleted`, `analysis.completed`, `access.denied`, `governance.settings.updated`, `roles.assigned`, `export.created`, `counterfactual.run_requested` and the fallback `api.<routeId>`. A log event with the same name (for example `case.ingested`) is a different record. The audit `access.denied` event is throttled per caller and route (see [DATA_MODEL.md](DATA_MODEL.md#7-the-audit-hash-chain)); a replayed idempotent request is marked `details.replayed`.

### Planned events (nothing emits them yet)

These names appeared in earlier versions of this document and in runbooks. **No code emits them.** Do not build alerts on them. When one is implemented it should move to the table above.

| Planned name                                                                                | Intended meaning                            | What to use today                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skill.published`, `skill.approved`, `skill.rejected`, `skill.retired`, `skill.rolled_back` | Skill lifecycle activity in the log         | Audit events in `audit_events` (`GET /api/v1/audit`) and the in-process metric `caseguard_skill_transitions_total`                                                                                                          |
| `injection.flagged`                                                                         | A prompt-injection detection in the log     | `injectionDetected` in `case.ingested`, `injectionIndicators` in `ai.model.execution`, and `caseguard_prompt_injection_flags_total`                                                                                         |
| `authz.*`, `rate_limit.*`, `upload.*`                                                       | Authorisation, throttling and upload events | `access.denied` and `http.error` (a 429 is `code` `rate_limited`), `ingest.unsafe_upload_refused`, and `caseguard_rate_limit_hits_total`                                                                                    |
| `retrieval.*`                                                                               | Search latency and provider fallback        | The `http.request` line of `/api/v1/search`, the search warnings listed under "Events emitted today" (fallback, dropped documents), `caseguard_retrieval_duration_seconds` and `caseguard_errors_total{component="search"}` |
| `counterfactual.*`                                                                          | Counterfactual generation lifecycle         | `ai.model.execution` with `agent == 'counterfactual_simulator'`, the job `counterfactual` (`GET /api/v1/jobs`), and `caseguard_counterfactual_leak_check_failures_total`                                                    |

### Base function

Save this once as a workspace function named `CgApiLogs` (Logs > Save > Save as function) so every query can call `CgApiLogs()`; otherwise paste it above the query. Adjust the app name prefix (`ca-caseguard-api`) if you changed `workloadName`.

```kusto
let CgApiLogs = () {
    union isfuzzy = true
        (ContainerAppConsoleLogs
         | where ContainerAppName startswith 'ca-caseguard-api'
         | project TimeGenerated, Revision = RevisionName, Raw = Log),
        (ContainerAppConsoleLogs_CL
         | where ContainerAppName_s startswith 'ca-caseguard-api'
         | project TimeGenerated, Revision = RevisionName_s, Raw = Log_s)
    | extend j = parse_json(Raw)
    | where gettype(j) == 'dictionary'
    | extend
        level = tostring(j.level),
        logTime = todatetime(j.time),
        msg = tostring(j.msg),
        event = tostring(j.event),
        requestId = tostring(j.requestId),
        traceId = tostring(j.traceId),
        tenantId = tostring(j.tenantId),
        userId = tostring(j.userId),
        method = tostring(j.method),
        route = tostring(j.route),
        routeId = tostring(j.routeId),
        statusCode = toint(j.statusCode),
        code = tostring(j.code),
        reason = tostring(j.reason),
        durationMs = todouble(coalesce(j.durationMs, j.latencyMs)),
        agent = tostring(j.agent),
        model = tostring(j.model),
        execStatus = iff(event == 'ai.model.execution', tostring(j.status), ''),
        source = tostring(j.source),
        fallbackReason = tostring(j.fallbackReason),
        injectionDetected = tobool(j.injectionDetected),
        injectionIndicators = toint(j.injectionIndicators),
        promptTokens = tolong(j.promptTokens),
        completionTokens = tolong(j.completionTokens),
        provider = tostring(j.provider),
        tokenSource = tostring(j.tokenSource),
        failure = tostring(j.failure),
        discarded = toint(j.discarded)
};
```

`level` is a label string, so compare with `level in ('error', 'fatal')`, never with a number. `statusCode` exists only on `http.request` lines; `execStatus`, `provider` and `tokenSource` only on `ai.model.execution` lines, except that `provider` is also on the search line `Search hits that do not satisfy the result contract were discarded` (the same JSON key `status` is the numeric HTTP status on `http.error` and `access.denied` lines, which these queries do not need); `failure` and `discarded` only on the search warnings. `durationMs` is filled from `durationMs` (HTTP) or `latencyMs` (model calls).

## 3. Verify the log contract first

Run these after the first deployment and after any logging change. If a count is zero, fix the field name in the base function (or in the application) before using the dashboards.

```kusto
// Which tables receive data?
union withsource = SourceTable isfuzzy = true
    ContainerAppConsoleLogs, ContainerAppConsoleLogs_CL, ContainerAppSystemLogs, ContainerAppSystemLogs_CL, ContainerAppHTTPLogs
| where TimeGenerated > ago(1h)
| summarize rows = count() by SourceTable
```

```kusto
// Do the log lines parse, and which fields are present?
CgApiLogs()
| where TimeGenerated > ago(1h)
| summarize rows = count(),
            withRequestId = countif(isnotempty(requestId)),
            withRoute = countif(isnotempty(route)),
            withStatusCode = countif(isnotnull(statusCode)),
            withDuration = countif(isnotnull(durationMs)),
            withAgent = countif(isnotempty(agent)),
            withTokens = countif(isnotnull(promptTokens)),
            withEvent = countif(isnotempty(event))
```

```kusto
// Levels must be label strings (trace, debug, info, warn, error, fatal), never numbers
CgApiLogs()
| where TimeGenerated > ago(1h)
| summarize lines = count() by level
```

```kusto
// Look at raw lines (should be JSON, with no secrets, prompts or case text)
CgApiLogs()
| where TimeGenerated > ago(1h)
| take 5
| project TimeGenerated, Raw
```

## 4. Workbook-style queries

Each block is one tile of a workbook. Use the workbook time range picker in place of the hard-coded `ago(...)` where you build one.

### 4.1 API latency

```kusto
// p50/p95/p99 per route, last 24 hours
CgApiLogs()
| where TimeGenerated > ago(24h) and event == 'http.request' and isnotnull(statusCode) and isnotnull(durationMs)
| summarize requests = count(),
            p50 = percentile(durationMs, 50),
            p95 = percentile(durationMs, 95),
            p99 = percentile(durationMs, 99),
            maxMs = max(durationMs)
          by route
| order by p95 desc
```

```kusto
// p95 over time (chart)
CgApiLogs()
| where TimeGenerated > ago(24h) and event == 'http.request' and isnotnull(durationMs)
| summarize p95 = percentile(durationMs, 95), p50 = percentile(durationMs, 50) by bin(TimeGenerated, 5m)
| render timechart
```

The Container Apps platform metric `ResponseTime` (Preview) is what the latency alert uses; compare it with the application's own `durationMs` to see time spent before the request reaches the container (cold starts show up here). The probes `/livez`, `/healthz` and `/readyz` are logged at `debug` and therefore absent at the default `LOG_LEVEL=info`.

### 4.2 API error rate

```kusto
// 5xx and 4xx rate over time
CgApiLogs()
| where TimeGenerated > ago(24h) and event == 'http.request' and isnotnull(statusCode)
| summarize total = count(), serverErrors = countif(statusCode >= 500), clientErrors = countif(statusCode >= 400 and statusCode < 500) by bin(TimeGenerated, 15m)
| extend serverErrorPct = round(100.0 * serverErrors / total, 2), clientErrorPct = round(100.0 * clientErrors / total, 2)
| project TimeGenerated, total, serverErrors, serverErrorPct, clientErrors, clientErrorPct
| render timechart
```

```kusto
// Which routes fail, and with what?
CgApiLogs()
| where TimeGenerated > ago(24h) and event == 'http.request' and statusCode >= 500
| summarize failures = count(), firstSeen = min(TimeGenerated), lastSeen = max(TimeGenerated), sampleRequestId = take_any(requestId) by route, statusCode
| order by failures desc
```

```kusto
// Error messages (level error or fatal): group by message
CgApiLogs()
| where TimeGenerated > ago(24h) and level in ('error', 'fatal')
| summarize occurrences = count(), sampleRequestId = take_any(requestId) by msg
| order by occurrences desc
```

A 503 with code `provider_unavailable` is the API's answer to a dependency fault (database or network error codes, Azure SDK `RestError` and credential errors). It is logged as `http.error` at `error` with `msg` `unhandled error`; the underlying cause is in the `err` field of the raw line, not in `msg`.

Application Insights equivalent. **Only if an OpenTelemetry exporter is added: none is wired today, so this returns no rows.** (`AppRoleName` would be `OTEL_SERVICE_NAME`, default `SERVICE_NAME`, `caseguard-api`):

```kusto
AppRequests
| where TimeGenerated > ago(24h) and AppRoleName startswith 'caseguard-api'
| summarize requests = count(), failed = countif(Success == false), p95 = percentile(DurationMs, 95) by Name, bin(TimeGenerated, 15m)
| order by failed desc
```

### 4.3 Model latency

```kusto
CgApiLogs()
| where TimeGenerated > ago(24h) and event == 'ai.model.execution' and isnotnull(durationMs)
| summarize calls = count(), p50 = percentile(durationMs, 50), p95 = percentile(durationMs, 95), p99 = percentile(durationMs, 99) by agent, model
| order by p95 desc
```

### 4.4 Model failures

```kusto
// Failure ratio per agent
CgApiLogs()
| where TimeGenerated > ago(24h) and event == 'ai.model.execution'
| extend failed = execStatus in ('failed', 'timed_out', 'circuit_open', 'budget_exceeded', 'rejected_by_validation')
| summarize calls = count(), failures = countif(failed) by agent, model
| extend failurePct = round(100.0 * failures / calls, 2)
| order by failurePct desc
```

```kusto
// Failure reasons over time (circuit_open means the circuit breaker tripped; budget_exceeded means a token/cost limit stopped the call)
CgApiLogs()
| where TimeGenerated > ago(24h) and event == 'ai.model.execution' and execStatus in ('failed', 'timed_out', 'circuit_open', 'budget_exceeded', 'rejected_by_validation', 'cancelled')
| summarize failures = count() by execStatus, bin(TimeGenerated, 1h)
| render columnchart
```

```kusto
// Results that came from the deterministic fallback instead of the model, with the reason
CgApiLogs()
| where TimeGenerated > ago(24h) and event == 'ai.model.execution' and source == 'deterministic_fallback'
| summarize fallbacks = count() by agent, fallbackReason, bin(TimeGenerated, 1h)
| order by TimeGenerated desc, fallbacks desc
```

Provider-side errors (Azure OpenAI resource logs, if `deployOpenAi`): `AzureDiagnostics | where ResourceProvider == 'MICROSOFT.COGNITIVESERVICES' and Category == 'RequestResponse'` and look at the `ResultSignature`/`DurationMs` columns.

### 4.5 Token consumption

```kusto
// Daily tokens by agent and model (always estimates for the deterministic provider; measured when Azure OpenAI reports usage)
CgApiLogs()
| where TimeGenerated > ago(14d) and event == 'ai.model.execution'
| summarize promptTokens = sum(promptTokens), completionTokens = sum(completionTokens), totalTokens = sum(coalesce(promptTokens, long(0)) + coalesce(completionTokens, long(0))), calls = count() by bin(TimeGenerated, 1d), agent, model
| order by TimeGenerated desc, totalTokens desc
```

```kusto
// Hourly tokens (spike detection) and the busiest tenants
CgApiLogs()
| where TimeGenerated > ago(48h) and event == 'ai.model.execution'
| summarize totalTokens = sum(coalesce(promptTokens, long(0)) + coalesce(completionTokens, long(0))) by bin(TimeGenerated, 1h), tenantId
| render timechart
```

Money is deliberately absent: multiply tokens by the unit prices **you** looked up (docs/COST_GUIDE.md). The application's own view is `GET /api/v1/efficiency/overview` and `GET /api/v1/model-executions` (permission `telemetry:read`); both answered 200 in a smoke run on the working tree (these handlers landed late and were uncommitted when I checked; on an older checkout they answer 501).

### 4.6 Retrieval latency

```kusto
// Search requests as the API saw them (the application emits no retrieval.* events; which provider answered is only in the in-process metric, fallbacks and dropped documents are the warnings below)
CgApiLogs()
| where TimeGenerated > ago(24h) and event == 'http.request' and route == '/api/v1/search' and isnotnull(durationMs)
| summarize calls = count(), p50 = percentile(durationMs, 50), p95 = percentile(durationMs, 95) by bin(TimeGenerated, 15m)
| render timechart
```

```kusto
// Azure AI Search fallbacks to lexical search, by reason (the warnings have no `event`; the `failure` codes, including no_usable_documents, are listed in section 2)
CgApiLogs()
| where TimeGenerated > ago(24h)
    and msg in ('Azure AI Search failed; using lexical search', 'Azure AI Search returned no usable documents; using lexical search')
| summarize fallbacks = count() by failure, bin(TimeGenerated, 15m)
| render columnchart
```

```kusto
// Documents and hits the API dropped (counts only). foreign-tenant lines are level error and are a security incident
CgApiLogs()
| where TimeGenerated > ago(24h)
    and msg in (
        'Azure AI Search returned malformed documents; they were discarded',
        'Azure AI Search returned documents of another tenant; they were discarded',
        'Search hits that do not satisfy the result contract were discarded')
| summarize lines = count(), discarded = sum(discarded) by msg, level, provider, bin(TimeGenerated, 1h)
| order by TimeGenerated desc
```

An empty result list for a query that should match is **not** logged: when the index answers with no documents the API returns an empty list without a fallback, and the only trace is the retrieval metric with `outcome="ok"`. The index document requirements and the triage steps are in [runbooks/search-unavailable.md](runbooks/search-unavailable.md).

```kusto
// Azure AI Search service side (when deployed); column names depend on the diagnostic mode, check AzureDiagnostics first
AzureDiagnostics
| where TimeGenerated > ago(24h) and ResourceProvider == 'MICROSOFT.SEARCH' and Category == 'OperationLogs'
| summarize calls = count(), p95 = percentile(DurationMs, 95) by OperationName, bin(TimeGenerated, 15m)
```

### 4.7 Counterfactual-generation failures

```kusto
// Counterfactual simulator task outcomes per day (the application emits no counterfactual.* events; the task is the signal)
CgApiLogs()
| where TimeGenerated > ago(7d) and event == 'ai.model.execution' and agent == 'counterfactual_simulator'
| extend failed = execStatus in ('failed', 'timed_out', 'circuit_open', 'budget_exceeded', 'rejected_by_validation')
| summarize runs = count(), failures = countif(failed), lastFailure = maxif(TimeGenerated, failed) by bin(TimeGenerated, 1d)
| extend failurePct = round(100.0 * failures / runs, 2)
| order by TimeGenerated desc
```

```kusto
// Individual failures with request ids for triage
CgApiLogs()
| where TimeGenerated > ago(24h) and event == 'ai.model.execution' and agent == 'counterfactual_simulator'
| where execStatus in ('failed', 'timed_out', 'circuit_open', 'budget_exceeded', 'rejected_by_validation')
| project TimeGenerated, requestId, execStatus, source, fallbackReason
| order by TimeGenerated desc
```

`rejected_by_validation` is **expected and healthy** when the validators block an output (citation, schema, policy or temporal check): investigate the rate, not the existence. A failed task does not fail the scenario: the engine's result is stored without a model execution. Job-level failures are visible through `GET /api/v1/jobs` (kind `counterfactual`, status `failed`) and the log events `job.timed_out` and `job.outcome_not_recorded`; a counterfactual that used information from after its decision (it must never happen) increments `caseguard_counterfactual_leak_check_failures_total`.

### 4.8 Skill approval activity

**No log event exists for skill lifecycle activity** (`skill.published` and friends are in the planned list of section 2), so there is no KQL for it. The authoritative record is the append-only, hash-chained audit log in PostgreSQL (`GET /api/v1/audit`, `GET /api/v1/audit/verify`, permission `audit:read`), and the in-process counter `caseguard_skill_transitions_total{transition,outcome}` counts transitions since the process started. If a log stream of skill activity is wanted, emit the event from the skills service first, then add a query here.

### 4.9 Security events

```kusto
// Counts by event (a 429 is an http.error line with code rate_limited; it is logged at debug, so it is absent at LOG_LEVEL=info)
CgApiLogs()
| where TimeGenerated > ago(24h) and (event in ('auth.failure', 'access.denied', 'ingest.unsafe_upload_refused') or (event == 'http.error' and code == 'rate_limited'))
| summarize count() by event, bin(TimeGenerated, 1h)
| render columnchart
```

```kusto
// Authentication failures by reason and route. They are logged before the caller is known, so there is no tenantId or userId on these lines.
CgApiLogs()
| where TimeGenerated > ago(24h) and event == 'auth.failure'
| summarize failures = count(), firstSeen = min(TimeGenerated), lastSeen = max(TimeGenerated) by reason, routeId, bin(TimeGenerated, 15m)
| order by failures desc
```

The general rate limit runs before authentication, so once a client address has used up its quota, further bad credentials are answered 429 without ever being authenticated: they appear as `http.error` lines with `code` `rate_limited` (debug level) and **not** as `auth.failure`. A sustained burst therefore shows `auth.failure` lines up to the quota and then silence plus a rising `rate_limit_hits_total{limiter="general"}`.

Which address a 429 was counted against cannot be seen in the log: the limiter runs before the caller is known, so those lines have no tenant or user, and the API never writes a client address to its own logs (the per-client buckets, including the address taken from `x-cg-client-ip`, live in memory only). If many different visitors are throttled at once, suspect a shared bucket: check that the start-up line `CaseGuard API started` shows `trustClientIpHeader: true` on the API in Azure, and run the two-client check (check 12) in [DEPLOYMENT.md](DEPLOYMENT.md#57-post-deploy-smoke-tests) (this behaviour is tested with simulated headers only, never behind a real Container Apps ingress).

```kusto
// Refused requests per tenant and route (the caller is known by then)
CgApiLogs()
| where TimeGenerated > ago(24h) and event == 'access.denied'
| summarize denials = count() by tenantId, userId, routeId, bin(TimeGenerated, 1h)
| order by denials desc
```

```kusto
// Prompt-injection indicators: cases ingested with detections, and model tasks whose input carried indicators
CgApiLogs()
| where TimeGenerated > ago(7d) and ((event == 'case.ingested' and injectionDetected == true) or (event == 'ai.model.execution' and injectionIndicators > 0))
| project TimeGenerated, event, requestId, tenantId, agent, injectionIndicators
| order by TimeGenerated desc
```

Related resource logs:

```kusto
// Key Vault access (who reads secrets, failures)
AzureDiagnostics
| where TimeGenerated > ago(24h) and ResourceProvider == 'MICROSOFT.KEYVAULT' and Category == 'AuditEvent'
| summarize operations = count() by OperationName, ResultSignature, CallerIPAddress
| order by operations desc
```

```kusto
// Blob access by authentication type (shared key is disabled, so SharedKey rows indicate a problem)
StorageBlobLogs
| where TimeGenerated > ago(24h)
| summarize requests = count() by OperationName, AuthenticationType, StatusText
| order by requests desc
```

### 4.10 Platform health

```kusto
// Probe failures, image pull errors and crash loops
ContainerAppSystemLogs
| where TimeGenerated > ago(24h) and Log has_any ('Probe failed', 'ErrImagePull', 'ImagePullBackOff', 'ContainerCrashing', 'Back-off', 'Failed to provision revision')
| project TimeGenerated, ContainerAppName, RevisionName, Log
| order by TimeGenerated desc
```

```kusto
// Request volume and replicas from exported metrics
AzureMetrics
| where TimeGenerated > ago(24h) and ResourceProvider == 'MICROSOFT.APP' and MetricName in ('Requests', 'Replicas')
| summarize requests = sumif(Total, MetricName == 'Requests'), maxReplicas = maxif(Maximum, MetricName == 'Replicas') by bin(TimeGenerated, 15m)
| render timechart
```

```kusto
// PostgreSQL: CPU, connections, storage
AzureMetrics
| where TimeGenerated > ago(24h) and ResourceProvider == 'MICROSOFT.DBFORPOSTGRESQL' and MetricName in ('cpu_percent', 'active_connections', 'storage_percent', 'connections_failed')
| summarize peak = max(Maximum) by MetricName, bin(TimeGenerated, 15m)
| render timechart
```

```kusto
// Migration job output. The migrate CLI writes plain text (not JSON): "Applied <name>", "No pending migrations.",
// "Applied: N, pending: M", "Migration failed: ..." and "Checksum mismatch: ...". The job's console logs may land in a
// different table or columns than the API's: verify with the queries in section 3 first.
union isfuzzy = true
    (ContainerAppConsoleLogs | project TimeGenerated, Raw = Log),
    (ContainerAppConsoleLogs_CL | project TimeGenerated, Raw = Log_s)
| where TimeGenerated > ago(24h) and Raw has_any ('Applied ', 'No pending migrations', 'Migration failed', 'Checksum mismatch')
| project TimeGenerated, Raw
| order by TimeGenerated desc
```

```kusto
// What is costing ingestion? (Quantity is in MB)
Usage
| where TimeGenerated > ago(7d) and IsBillable == true
| summarize GB = sum(Quantity) / 1000 by DataType
| order by GB desc
```

## 5. Turning queries into alerts

The templates provision only two metric alerts (API 5xx count and average response time, plus an action group). Anything below is a suggestion you create as a scheduled query rule or workbook, after the queries return real data:

| Signal                               | Query basis                                                                                   | Starting point (tune to your traffic)                 |
| ------------------------------------ | --------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Authentication failure burst         | 4.9 `auth.failure` per 5 minutes (by `reason`, not tenant: the caller is not known yet)       | more than a handful in 5 minutes                      |
| Prompt-injection indicators          | 4.9 `case.ingested` with `injectionDetected`, `ai.model.execution` with `injectionIndicators` | informational; page only on a sustained burst         |
| Model failure ratio                  | 4.4                                                                                           | failure percentage above your baseline for 15 minutes |
| Circuit breaker open                 | 4.4 `execStatus == 'circuit_open'`, or `event == 'ai.circuit.transition'` (`to == 'open'`)    | any occurrence                                        |
| Fallback to the deterministic result | 4.4 `source == 'deterministic_fallback'`                                                      | sustained rise                                        |
| Token spike                          | 4.5 hourly tokens against the previous days                                                   | several times the normal hourly volume                |
| Audit write failures                 | `event == 'audit.write_failed'`                                                               | any occurrence                                        |
| Migration job failed                 | 4.10 job output / `az containerapp job execution list`                                        | any failed execution                                  |
| API not ready                        | `ContainerAppSystemLogs` readiness failures                                                   | repeated failures on the latest revision              |

Example scheduled-query body (fires when authentication failures spike):

```kusto
CgApiLogs()
| where TimeGenerated > ago(15m) and event == 'auth.failure'
| summarize failures = count() by bin(TimeGenerated, 5m)
| where failures > 20
```

## 6. Building the workbook

1. Azure portal > Monitor > Workbooks > New (or the Log Analytics workspace > Workbooks).
2. Add parameters: _Time range_ (the standard picker) and optionally _Revision_.
3. Add one **query** tile per block in section 4; use the time-range parameter instead of `ago(...)`.
4. Save the workbook in the environment's resource group so it is deleted with the environment (`destroy-dev`), or export it as a template and keep it in source control.

## 7. Privacy and cost notes

- Console logs must contain no prompts, case text, e-mail addresses or secrets. Treat a row that does as an incident (docs/runbooks/secret-exposure-response.md).
- Ingress (HTTP) logs and `XForwardedFor` are personal data; they are off by default.
- Everything here is ingested billable data: see docs/COST_GUIDE.md before turning on verbose categories.
- Retention is `logRetentionDays` (30 by default in dev). The append-only audit log in PostgreSQL has its own retention setting (governance `retention.auditDays`), which is stored but **not enforced** by any job.

## 8. In-process metrics, and what is not exported

`packages/observability` defines 25 product metrics (`METRIC_NAMES` in `src/metrics/product.ts`, all prefixed `caseguard_`). They live in an in-process registry:

- **Not exported.** There is no Prometheus `/metrics` route, `bindMetricsToOtel` and `withSpan` are never called, and no OpenTelemetry or Azure Monitor SDK is started (`@azure/monitor-opentelemetry` is a declared but unused dependency of `apps/api`; `APPLICATIONINSIGHTS_CONNECTION_STRING` is only parsed and validated). Application Insights therefore receives nothing today.
- **Readable through the API.** `GET /api/v1/system/metrics` (permission `telemetry:read`) returns a summary built from the registry: `totalRequests`, `errorRequests`, `errorRate`, `latencyMs` (p50, p95, p99, max), `byRoute` (at most 100), `modelExecutions` (total, failures, average latency) and `securityEvents` (`authFailures`, `forbidden`, `rateLimited`, `injectionFlags`), counted since the process started. `GET /api/v1/system/health` reports dependencies and migrations.
- **Per process.** Counters reset on restart and are not shared between replicas.

| Metric (`caseguard_` prefix)                                                                                                                                                                           | Recorded by the API today                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `http_requests_total`, `http_request_duration_seconds` (labels `method`, `route`, `status_class`)                                                                                                      | Yes (one per finished request)                                                                                                                                                       |
| `errors_total` (`component`, `code`)                                                                                                                                                                   | Yes (`http`, `audit`, `idempotency`, `search`; the `search` codes are `invalid_document`, `foreign_tenant_document` and `invalid_result`, one increment per dropped document or hit) |
| `jobs_active`, `job_duration_seconds`, `job_failures_total`, `queue_depth`                                                                                                                             | Yes (job service)                                                                                                                                                                    |
| `model_calls_total`, `model_tokens_total`, `model_call_duration_seconds`, `model_cache_lookups_total`, `model_fallbacks_total`, `model_validation_failures_total`                                      | Yes (every AI task; validation kinds are folded into `schema`, `citation`, `policy`, `temporal`)                                                                                     |
| `model_cache_hit_ratio`                                                                                                                                                                                | Defined; derived from the lookup counters                                                                                                                                            |
| `counterfactual_leak_check_failures_total`                                                                                                                                                             | Yes, incremented only when a leak is found (it must stay 0)                                                                                                                          |
| `auth_failures_total` (`reason`), `forbidden_total` (`permission`), `rate_limit_hits_total` (`limiter` = `general` or `heavy`), `prompt_injection_flags_total` (`source` = `ingestion` or `case_text`) | Yes                                                                                                                                                                                  |
| `retrieval_duration_seconds` (`provider`, `outcome` = `ok`, `error`, `fallback`)                                                                                                                       | Yes (global search; `fallback` also covers an index answer with no usable document)                                                                                                  |
| `skill_transitions_total` (`transition`, `outcome`)                                                                                                                                                    | Yes (SkillDNA governance and mutation)                                                                                                                                               |
| `build_info`, `process_start_time_seconds`                                                                                                                                                             | Yes                                                                                                                                                                                  |
| `analysis_duration_seconds`, `db_query_duration_seconds`                                                                                                                                               | **Defined but not recorded by anything**                                                                                                                                             |

Token counts in `model_tokens_total` carry a `source` label (`measured` or `estimated`); with the deterministic provider they are always `estimated`.
