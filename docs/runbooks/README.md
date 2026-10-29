# Runbooks

Operational procedures for CaseGuard AI running in Azure. Each runbook has the same shape: **symptoms, impact, detection, triage, mitigation, recovery, verification, follow-ups**.

> **Honesty note.** Nothing has been deployed, so no runbook has been exercised against a live environment. Commands are written from the documented behaviour of the Azure CLI and of this repository's templates; expect to correct flags, table names and expected outputs the first time you use them, and record the corrections here. The KQL depends on the log contract in [../OBSERVABILITY.md](../OBSERVABILITY.md), which must be verified after the first deployment.

## Index

| Runbook                                                       | Use when                                                                                          | Typical trigger                                                           | Default severity    |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------- |
| [ai-provider-unavailable](ai-provider-unavailable.md)         | Azure OpenAI calls fail, time out, are throttled or rejected; the circuit breaker is open         | model-failure queries, API 5xx alert, `/api/v1/system/provider` unhealthy | 2 (3 with fallback) |
| [database-unavailable](database-unavailable.md)               | `/readyz` fails or the API cannot reach PostgreSQL                                                | API 5xx alert, readiness failures, `connections_failed`                   | 1                   |
| [search-unavailable](search-unavailable.md)                   | Azure AI Search errors, missing index or throttling (only when `SEARCH_PROVIDER=azure-ai-search`) | retrieval errors, search 4xx/5xx                                          | 3                   |
| [excessive-token-use](excessive-token-use.md)                 | Token or model spend is far above baseline, or a limit tripped                                    | token spike query, `budget_exceeded`, budget notification                 | 2                   |
| [failed-deployment](failed-deployment.md)                     | An `az deployment sub` stage failed or left things half-created                                   | pipeline/script failure                                                   | 3 (1 in prod)       |
| [broken-migration](broken-migration.md)                       | The `migrate` job failed or hung, or the schema and the code disagree                             | failed job execution, `/readyz` not ready, missing-column errors          | 1                   |
| [suspicious-prompt-injection](suspicious-prompt-injection.md) | `injection.flagged` bursts or suspicious model/skill output                                       | security query, reviewer report                                           | 2                   |
| [secret-exposure-response](secret-exposure-response.md)       | A secret, token or key may have been exposed                                                      | secret-scanning alert, Key Vault audit anomaly, report                    | 1                   |
| [rollback-procedure](rollback-procedure.md)                   | A release must be reverted (application, infrastructure or database)                              | failed smoke test, error-rate regression                                  | 1-2                 |

Severity is a starting point: 1 = users cannot work or data/security is at risk, 2 = degraded or at-risk, 3 = contained or cosmetic. Declare an incident owner for severity 1-2, keep a timeline, and write a short post-incident note.

## Conventions

- Commands use PowerShell-friendly syntax and `<placeholders>`. Set these once per session (the scripts never rely on the az current subscription, and neither should you):

  ```powershell
  $sub = '<subscription-id>'
  $rg  = 'rg-caseguard-<dev|stg|prd>'
  az containerapp list --subscription $sub --resource-group $rg --query "[].name" -o tsv          # api and web app names
  az containerapp job list --subscription $sub --resource-group $rg --query "[].name" -o tsv      # migrate job name
  ```

- The API has **internal ingress only**. Health endpoints (`/livez`, `/healthz`, `/readyz`) are reachable only inside the environment: use `az containerapp exec` into the API container, or the web proxy for `/api/*`. Authenticated operator endpoints (`/api/v1/system/health`, `/api/v1/system/provider`, `/api/v1/system/metrics`, `/api/v1/audit`, `/api/v1/audit/verify`, `/api/v1/governance/settings`) need a bearer token and the permissions noted in each runbook.
- Environment-variable changes made with `az containerapp update` create a new revision and **drift from the templates**: the next deployment restores the template values. Make durable changes in the parameter file.
- Roles referenced here are the CaseGuard roles (`engineer`, `reviewer`, `manager`, `skill_curator`, `administrator`) and Azure roles. Production changes follow the approval flow in [../DEPLOYMENT.md](../DEPLOYMENT.md#6-production-deployment-with-approvals).
- All data in demo environments is synthetic; production-like environments may hold sensitive operational data. Never paste case text, tokens or secrets into tickets or chat.

## Where to look first

| Question               | Where                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Is the platform up?    | revision health (`az containerapp revision list`), API 5xx/latency alerts, `/readyz` via exec                       |
| What changed?          | `az deployment sub list`, revision creation times, Container Apps system logs, the Git history of `infra/`          |
| Where is the error?    | queries in [../OBSERVABILITY.md](../OBSERVABILITY.md) (use the correlation id from a failing request)               |
| Who did what?          | append-only audit log (`GET /api/v1/audit`, `GET /api/v1/audit/verify`), Azure Activity Log, Key Vault audit events |
| Is it Azure's problem? | Azure Service Health for the region and the affected service                                                        |
