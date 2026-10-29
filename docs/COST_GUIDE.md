# Cost guide

> **This guide deliberately states no prices.** Azure prices vary by region, date, currency, agreement (pay-as-you-go, Enterprise Agreement, CSP, reservations, savings plans) and SKU, and change without notice. Any number written here would be wrong for someone and stale soon. Use the tools in section 1 to get **current** figures for **your** subscription, and keep them out of the repository (the application also never hard-codes prices: operators supply unit prices as configuration, assumption A-16).

Nothing in this repository has been deployed, so no cost has been measured either. Everything below is about **what drives cost** and **which lever in this repository changes it**.

## 1. How to find current prices and actual spend

| Need                                      | Tool                                                                                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Estimate a configuration before deploying | **Azure Pricing Calculator** (azure.microsoft.com/pricing/calculator). Pick your region and currency; take SKUs and counts from `infra/bicep/main.<env>.local.bicepparam` and the What-If output |
| Machine-readable list prices              | **Azure Retail Prices API**: public, unauthenticated REST (`https://prices.azure.com/api/retail/prices`). List prices only: negotiated or reserved prices differ                                 |
| What you actually spent                   | **Microsoft Cost Management** (portal: Cost analysis), or `az consumption usage list` / `az costmanagement query` (the `costmanagement` extension) against your subscription                     |
| Spend per environment/team                | Group Cost analysis by the tags this template sets: `environment`, `costCenter`, `owner`, `application`                                                                                          |
| Whether the budget is configured          | Portal: the resource group > Cost Management > Budgets (the template creates `budget-<workload>-<env>`)                                                                                          |

Example Retail Prices API calls (replace the region and filters; field names such as `skuName`, `meterName`, `unitOfMeasure`, `retailPrice`, `currencyCode` and `effectiveStartDate` come back in each item; confirm the `api-version` in the API documentation):

```powershell
$filter = "serviceName eq 'Azure Container Apps' and armRegionName eq '<region>' and priceType eq 'Consumption'"
(Invoke-RestMethod -Uri ("https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&`$filter=" + [uri]::EscapeDataString($filter))).Items |
  Select-Object productName, skuName, meterName, unitOfMeasure, retailPrice, currencyCode, effectiveStartDate
```

```bash
curl -sG 'https://prices.azure.com/api/retail/prices' --data-urlencode "api-version=2023-01-01-preview" \
  --data-urlencode "\$filter=serviceName eq 'Azure Cache for Redis' and armRegionName eq '<region>'"
```

Pages of results are linked through `NextPageLink`. Service names are the marketing names shown in the calculator.

### Estimating a month (template to fill in)

1. Deploy nothing yet. Run What-If and list every resource with its SKU/tier/count.
2. For each row below, find the meters in the Retail Prices API for **your region**, and note the unit (hour, GB-month, million operations, GB ingested, ...).
3. Multiply by the quantity you expect (hours the resource exists, GB stored, GB ingested, tokens...). Compute-style resources that scale to zero are billed for active time only.
4. Add the data-transfer and logging items, which are often the surprise.

| Resource                       | Meter(s) to look up                                                      | Quantity to estimate              | Your price | Your monthly figure |
| ------------------------------ | ------------------------------------------------------------------------ | --------------------------------- | ---------- | ------------------- |
| Container Apps (web, api, job) | vCPU-seconds, GiB-seconds, requests (active and idle rates)              | active seconds x size x replicas  |            |                     |
| Container registry             | SKU per day; storage; build (ACR Tasks) minutes                          | days, GB, build minutes           |            |                     |
| PostgreSQL Flexible Server     | compute per hour for the SKU; storage GB-month; backup                   | hours running, GB, retention      |            |                     |
| Storage                        | capacity per tier; transactions; data retrieval; early deletion          | GB per tier, operations           |            |                     |
| Log Analytics                  | ingestion per GB; retention beyond the included period                   | GB per day x days                 |            |                     |
| Azure AI Search (optional)     | search units per hour (replicas x partitions)                            | hours x units                     |            |                     |
| Azure OpenAI (optional)        | per-token (pay-as-you-go) or provisioned capacity per hour               | input/output tokens, or PTU-hours |            |                     |
| Redis (optional)               | SKU per hour                                                             | hours                             |            |                     |
| Private networking (optional)  | private endpoint per hour + data processed; private DNS zone and queries | endpoints x hours, GB             |            |                     |
| Metric alerts (optional)       | per monitored time series / rule                                         | rules x series                    |            |                     |
| Network egress                 | outbound data transfer                                                   | GB                                |            |                     |

## 2. What drives cost and how this repository limits it

| Resource                       | Cost driver                                                                                                                                                 | Dev default                                    | Levers (parameter)                                                                                                                                                                                                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Container Apps**             | vCPU-seconds and GiB-seconds while replicas run (active vs idle rates), requests; a monthly free grant may apply to Consumption usage - check current terms | min replicas 0, max 2, 0.25-0.5 vCPU           | `webMinReplicas`/`apiMinReplicas` (0 = scale to zero), `*MaxReplicas`, `*Cpu`/`*Memory`, `*ConcurrentRequests`. Old revisions stay billable while their replicas run: deactivate them after a soak                                                                            |
| **Container Apps job**         | vCPU/GiB-seconds only while a migration runs                                                                                                                | manual trigger, no schedule                    | `migrationTimeoutSeconds` bounds a stuck run                                                                                                                                                                                                                                  |
| **PostgreSQL Flexible Server** | Compute hours of the SKU (billed while the server is running), provisioned storage, backup storage beyond the free allowance, HA doubles compute            | Burstable, no HA, 32 GB, 7-day backups         | `postgresSkuTier`/`postgresSkuName`, `postgresStorageGb`, `postgresBackupRetentionDays`, `postgresHighAvailability`, `postgresGeoRedundantBackup`. A **stopped** server stops compute billing (storage and backups still bill; Azure restarts a stopped server after a while) |
| **Container registry**         | SKU daily fee, stored images, ACR Tasks build time                                                                                                          | Basic                                          | `registrySku`. Purge old images (section 5). Premium only for private endpoints / geo-replication                                                                                                                                                                             |
| **Storage account**            | GB per tier, transactions, retrieval from Cool, early-deletion fees, soft-deleted bytes, diagnostic log ingestion                                           | LRS, lifecycle off in dev except 30-day delete | `storageSku`, `blobCoolAfterDays`, `blobDeleteAfterDays`, `blobSoftDeleteDays`. Cool and Archive have minimum retention periods: tiering short-lived blobs can cost more                                                                                                      |
| **Log Analytics**              | **GB ingested** (usually the largest hidden cost), plus retention beyond the included period                                                                | 30-day retention, 1 GB/day cap                 | `logDailyCapGb`, `logRetentionDays`, `diagnosticsEnabled`, `containerAppsHttpLogs` (off), `postgresVerboseDiagnostics` (off), `logLevel`, `otelSamplingRatio`                                                                                                                 |
| **Application Insights**       | Workspace-based: its telemetry is Log Analytics ingestion                                                                                                   | sampling 1 (everything)                        | `otelSamplingRatio` below 1 in staging/prod                                                                                                                                                                                                                                   |
| **Key Vault**                  | Operations (secret reads) - negligible at this scale                                                                                                        | standard SKU                                   | none needed                                                                                                                                                                                                                                                                   |
| **Azure AI Search**            | Search-unit hours (replicas x partitions) for the whole time the service exists - it cannot be paused                                                       | **off**                                        | `deploySearch=false` (lexical provider), `searchSku`, `searchReplicaCount`, `searchPartitionCount`. Delete the service to stop billing                                                                                                                                        |
| **Azure OpenAI**               | Pay-as-you-go: tokens in and out. Provisioned capacity: fixed hourly cost even when idle                                                                    | **off** (deterministic provider)               | `deployOpenAi`, `openAiModelSkuName`/`openAiModelCapacity` (capacity bounds throughput and therefore spend), plus the application token controls in section 3                                                                                                                 |
| **Redis**                      | SKU hours                                                                                                                                                   | **off** (the app uses an in-memory cache)      | `deployRedis=false`                                                                                                                                                                                                                                                           |
| **Private endpoints / DNS**    | Hourly per endpoint, data processed, hosted DNS zones                                                                                                       | **off**                                        | `enablePrivateNetworking` (needed for staging/prod; skip for a throwaway demo). The VNet itself is free                                                                                                                                                                       |
| **Metric alerts**              | Per rule / monitored series                                                                                                                                 | off in dev                                     | `deployAlerts`                                                                                                                                                                                                                                                                |
| **Budgets**                    | Free                                                                                                                                                        | notifications at 50/80/100% and forecast       | `monthlyBudgetAmount`, `budgetActualThresholds`, `budgetForecastThreshold`                                                                                                                                                                                                    |

## 3. Controlling AI (token) spend

Model cost is the one line that can grow without any infrastructure change. Controls, from most to least effective:

1. **Do not enable it.** The default `AI_PROVIDER=deterministic` has zero model cost; its token counts are estimates (`ceil(chars / 4)`) and costs are simulated, never billed (assumption A-07).
2. **Bound each call**: `aiMaxInputTokens`, `aiMaxOutputTokens`, `aiTimeoutMs` (parameters -> `AI_MAX_INPUT_TOKENS`, `AI_MAX_OUTPUT_TOKENS`, `AI_TIMEOUT_MS`), per-agent budgets in the governance `model` section, and `maxAnalysisDepth`.
3. **Bound retries and storms**: `aiMaxRetries` (`AI_MAX_RETRIES`), the circuit breaker (`failureThreshold`, `resetMs`) and the semantic cache in the governance `model` section; `RATE_LIMIT_AI_MAX` limits AI-triggering calls per identity.
4. **Set a daily ceiling**: `aiCostLimitUsdPerDay` (`AI_COST_LIMIT_USD_PER_DAY`) and the governance `costLimits` (per request, per case, per day). They only work once **you** supply unit prices (`aiUnitPriceInputPer1k`, `aiUnitPriceOutputPer1k`): look the current prices up (section 1) and enter them. With no prices the application reports cost as _unknown_ and cannot enforce a monetary limit; token limits still apply.
5. **Bound the platform**: `openAiModelCapacity` caps throughput of a deployment created by this template; also set quota/spend limits on the Azure OpenAI resource itself.
6. **Watch it**: token consumption queries in [docs/OBSERVABILITY.md](OBSERVABILITY.md) and the response procedure in [docs/runbooks/excessive-token-use.md](runbooks/excessive-token-use.md).

## 4. Logging and telemetry costs

- Every supported resource sends logs and metrics to Log Analytics (`diagnosticsEnabled`). The categories that usually dominate: Container Apps console logs (your application's stdout), storage blob logs (one row per request), PostgreSQL logs. High-volume extras are **off** by default (`containerAppsHttpLogs`, `postgresVerboseDiagnostics`).
- `logDailyCapGb` stops ingestion for the rest of the UTC day when reached: a cost ceiling for dev, but it also drops security-relevant logs. Do not use a cap as the only control in production.
- Retention: 30 days is the minimum. Longer retention costs more; export or archive instead of retaining everything interactively.
- Sampling: `otelSamplingRatio` below 1 reduces trace volume; it does not reduce console logs. Log at `info`, not `debug`.
- Find the biggest tables: `Usage | where TimeGenerated > ago(7d) and IsBillable == true | summarize GB = sum(Quantity) / 1000 by DataType | sort by GB desc` (`Quantity` is in MB).

## 5. Housekeeping that saves money

| Action                          | Why / how                                                                                                                                                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scale to zero in dev            | Already the default. Expect cold starts after idle periods                                                                                                                                                                 |
| Deactivate old revisions        | `az containerapp revision deactivate --revision <name> ...` after a release soaks (Multiple revision mode keeps them running if their `minReplicas` > 0)                                                                   |
| Purge old container images      | `az acr run --registry <acr> --cmd "acr purge --filter 'caseguard-api:.*' --filter 'caseguard-web:.*' --ago 30d --untagged" /dev/null` (review the filters first; this deletes images)                                     |
| Stop the dev database overnight | `az postgres flexible-server stop` / `start`. The apps will fail readiness while it is stopped; Azure restarts a stopped server after a limited time                                                                       |
| Delete idle optional services   | Search and Redis bill while they exist, even idle                                                                                                                                                                          |
| Destroy dev when you are done   | `infra/scripts/destroy-dev.*` deletes the whole resource group; see [docs/DEPLOYMENT.md](DEPLOYMENT.md#8-clean-deletion-dev-only) for soft-delete leftovers. A forgotten dev environment is the most common avoidable cost |
| Keep blob lifecycle aligned     | `blobDeleteAfterDays` must agree with the application retention (governance `retention.caseDataDays`, default 365 days in the application defaults) or blobs outlive the data that references them; 0 disables             |
| Right-size after measuring      | After a representative week, compare actual CPU/memory (metrics: `UsageNanoCores`, `WorkingSetBytes`) and database metrics to the SKU; do not shrink on guesses                                                            |

## 6. Budgets and alerts

- `monthlyBudgetAmount` is a **notification threshold**, not a spending limit. Azure budgets alert; they do not stop resources. Notifications go to `contactEmails` at the actual-spend percentages in `budgetActualThresholds` and at the forecast threshold (forecasts need several days of history).
- Pass a fixed `budgetStartDate` (the first day of a month) on later deployments; otherwise the default (the first day of the current month) changes the budget definition each month.
- The budget covers the resource group only. Add a subscription-level budget separately if other workloads share the subscription.
- If you need an automatic brake, connect the budget to an action group that runs an automation (not provided here), or schedule a review of `destroy-dev`.

## 7. Cost-relevant decisions to record

| Decision           | Cheap choice                          | Costlier choice                                  | Trade-off                                                   |
| ------------------ | ------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------- |
| Search             | lexical provider (no service)         | Azure AI Search                                  | retrieval quality and index management vs fixed hourly cost |
| AI provider        | deterministic                         | Azure OpenAI                                     | live model output vs per-token cost and quota work          |
| Networking         | public endpoints, RBAC only (dev)     | private endpoints + VNet                         | exposure vs hourly endpoint cost and operator access        |
| Availability       | single zone, no HA                    | zone-redundant HA, ZRS/GRS storage               | recovery time and durability vs roughly doubled compute     |
| Always-on replicas | scale to zero                         | min replicas 1                                   | cold starts vs idle cost                                    |
| Telemetry          | sampling, info logs, 30-day retention | full sampling, HTTP/verbose logs, long retention | debuggability and audit vs ingestion cost                   |
