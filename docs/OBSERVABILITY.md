# Observability

Ready-to-use Kusto (KQL) queries for the questions an operator asks about CaseGuard AI in Azure: latency, errors, model behaviour, token use, retrieval, counterfactual failures, skill approvals and security events.

> **Not run against a real workspace.** Nothing has been deployed, so every query here is unexecuted. They are written for the log shape and table names described in section 2, and **table and column names depend on how logs are exported**. Run the "verify" queries in section 3 after the first deployment and adjust names before trusting any chart. Field names for application events are an assumption about the structured logging in `packages/observability`, which was still being written when this was authored.

## 1. Where the telemetry comes from

| Source                                                   | How it reaches Log Analytics                                                                                                       | Table(s) (verify)                                                                                                                                  |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| API console output (JSON logs)                           | Container Apps environment > Azure Monitor diagnostic setting, resource-specific tables (`logAnalyticsDestinationType: Dedicated`) | `ContainerAppConsoleLogs` (columns such as `TimeGenerated`, `ContainerAppName`, `RevisionName`, `Log`)                                             |
| Platform/system events                                   | same                                                                                                                               | `ContainerAppSystemLogs` (revision provisioning, probe failures, image pull errors)                                                                |
| Ingress access logs (optional, off by default)           | same, when `containerAppsHttpLogs = true` (contains client IPs and paths: privacy review first)                                    | `ContainerAppHTTPLogs`                                                                                                                             |
| Container Apps metrics                                   | diagnostic setting `AllMetrics` on the apps, also Azure Monitor metrics                                                            | `AzureMetrics` (`Requests`, `ResponseTime` (Preview), `Replicas`, `UsageNanoCores`, ...)                                                           |
| Application Insights                                     | `APPLICATIONINSIGHTS_CONNECTION_STRING` (Key Vault reference) + OpenTelemetry; workspace-based                                     | `AppRequests`, `AppDependencies`, `AppExceptions`, `AppTraces`, `AppMetrics`                                                                       |
| Key Vault, storage, registry, PostgreSQL, Search, OpenAI | diagnostic settings of each resource                                                                                               | `AzureDiagnostics` (Key Vault, PostgreSQL, Search, OpenAI), `StorageBlobLogs`, `ContainerRegistryLoginEvents`, `ContainerRegistryRepositoryEvents` |

If the environment was switched to the legacy "Log Analytics" destination, the console logs land in `ContainerAppConsoleLogs_CL` with suffixed columns (`ContainerAppName_s`, `RevisionName_s`, `Log_s`). The base function below reads both shapes.

## 2. Assumed log contract

The API writes one JSON object per line to stdout (pino). The queries assume these fields; any may be absent:

| Field                                                             | Meaning                                                                                                                                                                                                |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `level`                                                           | pino numeric level: 10 trace, 20 debug, 30 info, 40 warn, 50 error, 60 fatal                                                                                                                           |
| `time`, `msg`                                                     | timestamp (epoch ms) and message                                                                                                                                                                       |
| `correlationId`                                                   | request/trace correlation id propagated across the request                                                                                                                                             |
| `route`, `method`, `status`, `durationMs`                         | HTTP request completion: route template, verb, numeric status code, duration in milliseconds                                                                                                           |
| `agent`, `model`, `status`/`outcome`, `durationMs` or `latencyMs` | a model call: agent name (for example `counterfactual_simulator`), model name, execution status (`succeeded`, `failed`, `timed_out`, `circuit_open`, `budget_exceeded`, `rejected_by_validation`, ...) |
| `promptTokens`, `completionTokens`                                | token usage of a model call (estimates for the deterministic provider)                                                                                                                                 |
| `event`                                                           | dotted event name, for example `skill.published`, `auth.failure`, `injection.flagged`                                                                                                                  |
| `tenantId`, `userId`                                              | opaque identifiers only. Logs must never contain e-mail addresses, prompts, case text or secrets (NFR-OBS-01, T7)                                                                                      |

Agent names come from `AGENT_NAMES`: `timeline_analyzer`, `evidence_classifier`, `hypothesis_generator`, `decision_fork_detector`, `counterfactual_simulator`, `quality_judge`, `skilldna_extractor`, `communication_coach`, `token_governor`, `safety_policy_validator`.

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
        level = toint(j.level),
        msg = tostring(j.msg),
        event = tostring(j.event),
        correlationId = tostring(j.correlationId),
        route = tostring(j.route),
        method = tostring(j.method),
        status = toint(j.status),
        statusText = tostring(coalesce(j.outcome, j.status)),
        durationMs = todouble(coalesce(j.durationMs, j.latencyMs)),
        agent = tostring(j.agent),
        model = tostring(j.model),
        promptTokens = tolong(j.promptTokens),
        completionTokens = tolong(j.completionTokens),
        tenantId = tostring(j.tenantId)
};
```

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
            withCorrelationId = countif(isnotempty(correlationId)),
            withRoute = countif(isnotempty(route)),
            withStatus = countif(isnotnull(status)),
            withDuration = countif(isnotnull(durationMs)),
            withAgent = countif(isnotempty(agent)),
            withTokens = countif(isnotnull(promptTokens)),
            withEvent = countif(isnotempty(event))
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
| where TimeGenerated > ago(24h) and isnotempty(route) and isnotnull(status) and isnotnull(durationMs)
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
| where TimeGenerated > ago(24h) and isnotempty(route) and isnotnull(durationMs)
| summarize p95 = percentile(durationMs, 95), p50 = percentile(durationMs, 50) by bin(TimeGenerated, 5m)
| render timechart
```

The Container Apps platform metric `ResponseTime` (Preview) is what the latency alert uses; compare it with the application's own `durationMs` to see time spent before the request reaches the container (cold starts show up here).

### 4.2 API error rate

```kusto
// 5xx and 4xx rate over time
CgApiLogs()
| where TimeGenerated > ago(24h) and isnotempty(route) and isnotnull(status)
| summarize total = count(), serverErrors = countif(status >= 500), clientErrors = countif(status >= 400 and status < 500) by bin(TimeGenerated, 15m)
| extend serverErrorPct = round(100.0 * serverErrors / total, 2), clientErrorPct = round(100.0 * clientErrors / total, 2)
| project TimeGenerated, total, serverErrors, serverErrorPct, clientErrors, clientErrorPct
| render timechart
```

```kusto
// Which routes fail, and with what?
CgApiLogs()
| where TimeGenerated > ago(24h) and isnotnull(status) and status >= 500
| summarize failures = count(), firstSeen = min(TimeGenerated), lastSeen = max(TimeGenerated), sampleCorrelationId = take_any(correlationId) by route, status
| order by failures desc
```

```kusto
// Error messages (level 50+): group by message
CgApiLogs()
| where TimeGenerated > ago(24h) and level >= 50
| summarize occurrences = count(), sampleCorrelationId = take_any(correlationId) by msg
| order by occurrences desc
```

Application Insights equivalent (if OpenTelemetry export is active; `AppRoleName` is `OTEL_SERVICE_NAME`, `caseguard-api`):

```kusto
AppRequests
| where TimeGenerated > ago(24h) and AppRoleName startswith 'caseguard-api'
| summarize requests = count(), failed = countif(Success == false), p95 = percentile(DurationMs, 95) by Name, bin(TimeGenerated, 15m)
| order by failed desc
```

### 4.3 Model latency

```kusto
CgApiLogs()
| where TimeGenerated > ago(24h) and isnotempty(agent) and isnotempty(model) and isnotnull(durationMs)
| summarize calls = count(), p50 = percentile(durationMs, 50), p95 = percentile(durationMs, 95), p99 = percentile(durationMs, 99) by agent, model
| order by p95 desc
```

### 4.4 Model failures

```kusto
// Failure ratio per agent
CgApiLogs()
| where TimeGenerated > ago(24h) and isnotempty(agent)
| extend failed = level >= 50 or statusText in ('failed', 'timed_out', 'circuit_open', 'budget_exceeded', 'rejected_by_validation')
| summarize calls = count(), failures = countif(failed) by agent, model
| extend failurePct = round(100.0 * failures / calls, 2)
| order by failurePct desc
```

```kusto
// Failure reasons over time (circuit_open means the circuit breaker tripped; budget_exceeded means a token/cost limit stopped the call)
CgApiLogs()
| where TimeGenerated > ago(24h) and isnotempty(agent) and statusText in ('failed', 'timed_out', 'circuit_open', 'budget_exceeded', 'rejected_by_validation', 'cancelled')
| summarize failures = count() by statusText, bin(TimeGenerated, 1h)
| render columnchart
```

Provider-side errors (Azure OpenAI resource logs, if `deployOpenAi`): `AzureDiagnostics | where ResourceProvider == 'MICROSOFT.COGNITIVESERVICES' and Category == 'RequestResponse'` and look at the `ResultSignature`/`DurationMs` columns.

### 4.5 Token consumption

```kusto
// Daily tokens by agent and model (estimates for the deterministic provider; real counts once Azure OpenAI is used)
CgApiLogs()
| where TimeGenerated > ago(14d) and (isnotnull(promptTokens) or isnotnull(completionTokens))
| summarize promptTokens = sum(promptTokens), completionTokens = sum(completionTokens), totalTokens = sum(coalesce(promptTokens, long(0)) + coalesce(completionTokens, long(0))), calls = count() by bin(TimeGenerated, 1d), agent, model
| order by TimeGenerated desc, totalTokens desc
```

```kusto
// Hourly tokens (spike detection) and the busiest tenants
CgApiLogs()
| where TimeGenerated > ago(48h) and isnotnull(promptTokens)
| summarize totalTokens = sum(coalesce(promptTokens, long(0)) + coalesce(completionTokens, long(0))) by bin(TimeGenerated, 1h), tenantId
| render timechart
```

Money is deliberately absent: multiply tokens by the unit prices **you** looked up (docs/COST_GUIDE.md). The application's own view is `GET /api/v1/efficiency/overview` and `GET /api/v1/model-executions` (permission `telemetry:read`).

### 4.6 Retrieval latency

```kusto
// Application-side retrieval events (names assumed: retrieval.*)
CgApiLogs()
| where TimeGenerated > ago(24h) and (event startswith 'retrieval' or route has 'search') and isnotnull(durationMs)
| summarize calls = count(), p50 = percentile(durationMs, 50), p95 = percentile(durationMs, 95) by event, bin(TimeGenerated, 15m)
| render timechart
```

```kusto
// Azure AI Search service side (when deployed); column names depend on the diagnostic mode, check AzureDiagnostics first
AzureDiagnostics
| where TimeGenerated > ago(24h) and ResourceProvider == 'MICROSOFT.SEARCH' and Category == 'OperationLogs'
| summarize calls = count(), p95 = percentile(DurationMs, 95) by OperationName, bin(TimeGenerated, 15m)
```

### 4.7 Counterfactual-generation failures

```kusto
CgApiLogs()
| where TimeGenerated > ago(7d) and (agent == 'counterfactual_simulator' or event startswith 'counterfactual')
| extend failed = level >= 50 or event has 'fail' or statusText in ('failed', 'timed_out', 'circuit_open', 'budget_exceeded', 'rejected_by_validation')
| summarize runs = count(), failures = countif(failed), lastFailure = maxif(TimeGenerated, failed) by bin(TimeGenerated, 1d)
| extend failurePct = round(100.0 * failures / runs, 2)
| order by TimeGenerated desc
```

```kusto
// Individual failures with correlation ids for triage
CgApiLogs()
| where TimeGenerated > ago(24h) and (agent == 'counterfactual_simulator' or event startswith 'counterfactual')
| where level >= 50 or event has 'fail' or statusText in ('failed', 'timed_out', 'rejected_by_validation')
| project TimeGenerated, correlationId, event, statusText, msg
| order by TimeGenerated desc
```

`rejected_by_validation` is **expected and healthy** when the validators block an output (citation, schema, policy or temporal check): investigate the rate, not the existence.

### 4.8 Skill approval activity

```kusto
CgApiLogs()
| where TimeGenerated > ago(30d) and event startswith 'skill.'
| summarize count() by event, bin(TimeGenerated, 1d)
| render columnchart
```

```kusto
// Recent lifecycle events (published/approved/retired/rolled back); event names assumed
CgApiLogs()
| where TimeGenerated > ago(7d) and event in ('skill.published', 'skill.approved', 'skill.rejected', 'skill.retired', 'skill.rolled_back')
| project TimeGenerated, event, correlationId, tenantId, msg
| order by TimeGenerated desc
```

The authoritative record is the append-only, hash-chained audit log (`GET /api/v1/audit`, `GET /api/v1/audit/verify`, permission `audit:read`), not the console logs. Use these queries for activity trends only.

### 4.9 Security events

```kusto
// Counts by event family
CgApiLogs()
| where TimeGenerated > ago(24h) and (event startswith 'auth.' or event startswith 'injection.' or event startswith 'authz.' or event startswith 'rate_limit' or event startswith 'upload.')
| summarize count() by event, bin(TimeGenerated, 1h)
| render columnchart
```

```kusto
// Authentication failures per tenant (a burst from one tenant or a sudden rise overall deserves a look)
CgApiLogs()
| where TimeGenerated > ago(24h) and event == 'auth.failure'
| summarize failures = count(), firstSeen = min(TimeGenerated), lastSeen = max(TimeGenerated) by tenantId, bin(TimeGenerated, 15m)
| order by failures desc
```

```kusto
// Prompt-injection detections
CgApiLogs()
| where TimeGenerated > ago(7d) and event == 'injection.flagged'
| project TimeGenerated, correlationId, tenantId, msg
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
// Migration job output (the job logs the service name caseguard-migrate)
union isfuzzy = true
    (ContainerAppConsoleLogs | project TimeGenerated, Raw = Log),
    (ContainerAppConsoleLogs_CL | project TimeGenerated, Raw = Log_s)
| where TimeGenerated > ago(24h) and Raw has 'caseguard-migrate'
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

| Signal                       | Query basis                                            | Starting point (tune to your traffic)                 |
| ---------------------------- | ------------------------------------------------------ | ----------------------------------------------------- |
| Authentication failure burst | 4.9 `auth.failure` per 5 minutes                       | more than a handful per tenant in 5 minutes           |
| Any injection detection      | 4.9 `injection.flagged`                                | informational; page only on a sustained burst         |
| Model failure ratio          | 4.4                                                    | failure percentage above your baseline for 15 minutes |
| Circuit breaker open         | 4.4 `statusText == 'circuit_open'`                     | any occurrence                                        |
| Token spike                  | 4.5 hourly tokens against the previous days            | several times the normal hourly volume                |
| Migration job failed         | 4.10 job output / `az containerapp job execution list` | any failed execution                                  |
| API not ready                | `ContainerAppSystemLogs` readiness failures            | repeated failures on the latest revision              |

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
- Retention is `logRetentionDays` (30 by default in dev). The append-only audit log in PostgreSQL has its own retention (governance `retention.auditDays`).
