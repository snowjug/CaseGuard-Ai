# CaseGuard AI - Azure infrastructure (Bicep)

> **Status: authored and statically validated only.** Nothing in this directory has been deployed to Azure, and no What-If, validate or deploy call has been made. See [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md) for exactly what has and has not been validated, and what needs a human with credentials.

Infrastructure as code for the CaseGuard AI platform: Azure Container Apps (web, API, migration job), Azure Container Registry, Key Vault, Storage, PostgreSQL Flexible Server, Log Analytics + Application Insights, and optional Azure AI Search, Azure OpenAI, Redis, private networking, budgets and alerts. All demo data is **synthetic**; nothing here is a Microsoft product.

## Design in one page

| Principle                 | How it shows up                                                                                                                                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Managed identity first    | One user-assigned identity pulls images (AcrPull), reads Key Vault secrets, reads/writes the `cases` blob container, calls AI Search and Azure OpenAI. Shared keys, API keys and the registry admin user are disabled.                 |
| No secrets in templates   | Secrets are `@secure()` parameters or read inside the deployment, are written to Key Vault, and reach containers only as **Key Vault references**. Outputs contain names, ids and host names only.                                     |
| Least privilege           | Role assignments are scoped to the single resource they need (the blob role to the container).                                                                                                                                         |
| Cost-conscious defaults   | Scale to zero, Basic/Burstable SKUs, optional services off, log cap and retention parameters, storage lifecycle, budget notifications. No prices are stated anywhere - see [docs/COST_GUIDE.md](../../docs/COST_GUIDE.md).             |
| API stays private         | `web` has external ingress. `api` has **internal** ingress only; the browser reaches it through the web app's same-origin `/api` proxy (`apps/web/src/proxy.ts`), whose server-side target is the runtime variable `API_INTERNAL_URL`. |
| Azure never uses personas | `AUTH_MODE=entra` and `DEV_AUTH_ENABLED=false` are hard-wired in the Container Apps module. Persona login is for local/test only (docs/ASSUMPTIONS.md A-14).                                                                           |
| Honest about the unproven | Deployment-time `fail()` guards stop impossible combinations early; everything that cannot be validated offline (quota, model access, regional SKUs, metric names) is called out in [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md).    |

## Layout

```text
infra/
  bicep/
    main.bicep                        subscription scope: resource group + every module below
    main.dev.bicepparam               safe low-cost dev profile (placeholders; builds as-is, refused by the scripts until filled in)
    main.prod.bicepparam.template     production TEMPLATE (not deployable as-is; deliberately not named *.bicepparam)
    main.staging.bicepparam.template  staging TEMPLATE (same rules)
    bicepconfig.json                  linter rules (errors, not warnings)
    .gitignore                        keeps *.local.bicepparam (real values) out of git
    modules/
      monitoring.bicep   Log Analytics workspace + workspace-based Application Insights
      identity.bicep     user-assigned managed identity
      network.bicep      VNet, delegated Container Apps subnet, private-endpoint subnet, private DNS zones + links
      private-endpoint.bicep  generic private endpoint + DNS zone group (used by the data modules)
      keyvault.bicep     Key Vault (RBAC) + the secrets the workloads reference
      acr.bicep          container registry (admin user disabled)
      storage.bicep      storage account, private `cases` container, lifecycle policy
      postgres.bicep     PostgreSQL Flexible Server + `caseguard` database + Entra administrators
      search.bicep       Azure AI Search (optional)
      openai.bicep       Azure OpenAI account + optional model deployment (optional)
      redis.bicep        Azure Managed Redis or classic Azure Cache for Redis (optional)
      containerapps.bicep  environment, web, api, migrate job, probes, scale rules, Key Vault secret references
      rbac.bicep         role assignments for the managed identity
      rbac-openai-existing.bicep  OpenAI User role on an existing account in another resource group/subscription
      budget.bicep       monthly budget with threshold e-mail notifications
      alerts.bicep       action group + API 5xx and latency metric alerts
  scripts/               operator helpers (PowerShell and bash): what-if, deploy-dev, destroy-dev
```

## What is deployed

| Component                                                                                                     | Always | Condition                                                               |
| ------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------- |
| Resource group, monitoring, identity, ACR, Key Vault, Storage, PostgreSQL, Container Apps environment, budget | yes    |                                                                         |
| `web`, `api`, `migrate` job                                                                                   |        | `deployContainerApps` (false for the first stage, before images exist)  |
| VNet, private endpoints, private DNS zones                                                                    |        | `enablePrivateNetworking`                                               |
| Azure AI Search                                                                                               |        | `deploySearch`                                                          |
| Azure OpenAI account                                                                                          |        | `deployOpenAi` (mutually exclusive with `existingOpenAiResourceId`)     |
| Azure OpenAI **model deployment**                                                                             |        | `deployOpenAi` and `deployOpenAiModel` - needs access, region and quota |
| Redis                                                                                                         |        | `deployRedis` (the application does not use it yet)                     |
| Action group + metric alerts                                                                                  |        | `deployAlerts` and `deployContainerApps`                                |

### Container Apps behaviour

- Workload-profiles environment with the `Consumption` profile; logs go to Log Analytics through Azure Monitor diagnostic settings (no workspace shared key is handed out).
- `web` (port 3000, external ingress, TCP probes) and `api` (port 4000, **internal** ingress; startup and liveness on `/livez`, readiness on `/readyz`). The API container runs `node --enable-source-maps dist/main.js` (identical to the image's default CMD). The `migrate` job runs `node --enable-source-maps dist/db/migrate-cli.js` from the same image, manual trigger, no automatic retry.
- Both apps use **Multiple revision** mode with 100% of traffic on the latest revision, so rollback is a traffic shift to the previous revision (see [docs/runbooks/rollback-procedure.md](../../docs/runbooks/rollback-procedure.md)).
- HTTP concurrency scale rules; `minReplicas` 0 in dev. The API keeps rate limits and caches per replica (docs/ASSUMPTIONS.md A-13), so keep `apiMaxReplicas` small until a shared store exists.
- Every environment variable of the contract in `BUILD_CONTRACT.md` section 6 that makes sense in Azure is set from parameters; optional values that are empty are omitted so the application defaults apply. `AZURE_CLIENT_ID` is added so `DefaultAzureCredential` selects the user-assigned identity.
- Assumes the API image's working directory contains `dist/` so `node dist/main.js` and `node dist/db/migrate-cli.js` resolve. A static read of `apps/api/Dockerfile` (`WORKDIR /app`, `COPY ... dist ./dist`, entry points `dist/main.js` and `dist/db/migrate-cli.js`) agrees, but that image has not been built or run by the infrastructure authors. Adjust the commands in `containerapps.bicep` if the Dockerfile layout changes.
- Next.js inlines the `NEXT_PUBLIC_*` values into the **web image at build time** (`docker-compose.yml` passes them as build arguments). `main.bicep` therefore outputs `webBuildArguments` (`KEY=VALUE` strings, none secret) so the deploy script can pass them to `az acr build`; the web image is specific to one environment's Entra registration. The API address is different: `API_INTERNAL_URL` is a **runtime** environment variable of the web container (set by `containerapps.bicep` from the API's internal FQDN) that `apps/web/src/proxy.ts` reads on every request, so it is not a build argument and the image has no default for it.

### Role assignments (managed identity)

| Role                           | Scope                            | Purpose                           |
| ------------------------------ | -------------------------------- | --------------------------------- |
| AcrPull                        | container registry               | pull images                       |
| Key Vault Secrets User         | Key Vault                        | resolve secret references         |
| Storage Blob Data Contributor  | the `cases` blob container       | case artefacts                    |
| Search Index Data Contributor  | AI Search (if deployed)          | read/write documents of the index |
| Cognitive Services OpenAI User | OpenAI account (new or existing) | call the model with Entra ID      |

Not granted on purpose: `Search Service Contributor` (creating the index is an operator task), any Key Vault write role, any control-plane role.
PostgreSQL has no ARM data-plane role: in `entra` mode the identity is registered as an Entra administrator of the server.

### Diagnostics

Every module that creates a supported resource adds a diagnostic setting named `send-to-log-analytics` (switch: `diagnosticsEnabled`): Key Vault (`allLogs` + metrics), registry, storage (blob service logs and metrics), PostgreSQL (`PostgreSQLLogs` + metrics; the high-volume categories only with `postgresVerboseDiagnostics`), AI Search, Azure OpenAI, Redis, the VNet, the Container Apps environment (`ContainerAppConsoleLogs`, `ContainerAppSystemLogs`, and `ContainerAppHTTPLogs` only with `containerAppsHttpLogs`) and the web/API apps (metrics). Deliberately **not** configured: Application Insights (workspace-based, so its data is already in the workspace) and the workspace itself (it would export to itself). The migration job has no diagnostic setting; its console output arrives through the environment's console-log category.

### Outputs

Names, resource ids and host names only, plus `webBuildArguments` (`KEY=VALUE` build arguments for the web image; they contain the tenant and client ids, which are identifiers, not secrets): `resourceGroupName`, `containerRegistryName`, `containerRegistryLoginServer`, `keyVaultName`, `keyVaultUri`, `storageAccountName`, `postgresServerName`, `postgresFqdn`, `logAnalyticsWorkspaceName`, `appInsightsName`, `managedIdentityName`, `containerAppsEnvironmentName`, `webAppName`, `apiAppName`, `migrateJobName`, `webUrl`, `apiInternalFqdn`, `searchEndpoint`, `openAiEndpoint`.

## Naming convention

`<abbr>-<workload>-<env>-<suffix>` using Azure Cloud Adoption Framework abbreviations. `env` is `dev`, `stg` or `prd`. `suffix` is the first six characters of `uniqueString(subscription id, workload, environment, nameSalt)`: stable per subscription, different across subscriptions. Resources whose names must be globally unique and forbid hyphens drop them. Examples use the illustrative suffix `a1b2c3`.

| Resource                   | Pattern                                                          | Service limit                         | Example (defaults, dev)                 |
| -------------------------- | ---------------------------------------------------------------- | ------------------------------------- | --------------------------------------- |
| Resource group             | `rg-<workload>-<env>`                                            | 90                                    | `rg-caseguard-dev`                      |
| Log Analytics workspace    | `log-<workload>-<env>-<suffix>`                                  | 4-63                                  | `log-caseguard-dev-a1b2c3`              |
| Application Insights       | `appi-<workload>-<env>-<suffix>`                                 | 260                                   | `appi-caseguard-dev-a1b2c3`             |
| Managed identity           | `id-<workload>-<env>-<suffix>`                                   | 3-128                                 | `id-caseguard-dev-a1b2c3`               |
| Virtual network            | `vnet-<workload>-<env>-<suffix>`                                 | 64                                    | `vnet-caseguard-dev-a1b2c3`             |
| Key Vault                  | `kv-<workload>-<env>-<suffix>`                                   | 3-24 (global)                         | `kv-caseguard-dev-a1b2c3` (23)          |
| Container registry         | `cr<workload><env><suffix>`                                      | 5-50, alphanumeric (global)           | `crcaseguarddeva1b2c3`                  |
| Storage account            | `st<workload><env><suffix>`                                      | 3-24, lowercase alphanumeric (global) | `stcaseguarddeva1b2c3`                  |
| PostgreSQL server          | `psql-<workload>-<env>-<suffix>`                                 | 3-63                                  | `psql-caseguard-dev-a1b2c3`             |
| AI Search                  | `srch-<workload>-<env>-<suffix>`                                 | 2-60 (global)                         | `srch-caseguard-dev-a1b2c3`             |
| Azure OpenAI               | `oai-<workload>-<env>-<suffix>`                                  | 2-64 (also the subdomain)             | `oai-caseguard-dev-a1b2c3`              |
| Redis                      | `redis-<workload>-<env>-<suffix>`                                | 1-63                                  | `redis-caseguard-dev-a1b2c3`            |
| Container Apps environment | `cae-<workload>-<env>-<suffix>`                                  | 2-60                                  | `cae-caseguard-dev-a1b2c3`              |
| Container app              | `ca-<workload>-web\|api-<env>-<suffix>`                          | 2-32                                  | `ca-caseguard-web-dev-a1b2c3` (27)      |
| Container Apps job         | `caj-<workload>-migrate-<env>-<suffix>`                          | 2-32                                  | `caj-caseguard-migrate-dev-a1b2c3` (32) |
| Private endpoint           | `pe-<resource name>` (blob: `pe-<storage>-blob`)                 | 2-80                                  | `pe-kv-caseguard-dev-a1b2c3`            |
| Budget                     | `budget-<workload>-<env>`                                        | 63                                    | `budget-caseguard-dev`                  |
| Action group / alerts      | `ag-<workload>-<env>-<suffix>`, `alert-<workload>-<env>-api-5xx` | 260                                   | `ag-caseguard-dev-a1b2c3`               |

`workloadName` is limited to 3-9 lowercase letters/digits: the Container Apps job name reaches the 32-character limit at nine. `caj` is used for jobs because no official abbreviation exists. The resource group name has no suffix so `destroy-dev` can verify the `-dev` ending.

**Re-deploying after deletion.** Key Vault (and Azure OpenAI, Log Analytics) keep deleted names reserved (soft delete). Either purge them (possible for Key Vault only when purge protection is off, which is why the dev profile turns it off) or change `nameSalt` to generate fresh names.

## Tags

Applied to the resource group and every taggable resource.

| Tag                  | Value                                                                    |
| -------------------- | ------------------------------------------------------------------------ |
| `application`        | `caseguard` (the destroy scripts require it)                             |
| `environment`        | `dev`, `staging` or `prod`                                               |
| `owner`              | the `owner` parameter                                                    |
| `costCenter`         | the `costCenter` parameter                                               |
| `dataClassification` | `synthetic-demo` (fixed; re-run docs/THREAT_MODEL.md before changing it) |
| `managedBy`          | `bicep`                                                                  |

## Parameters

Required parameters have no default. Secrets are never accepted from a file: `postgresAdminPassword` is a `@secure()` parameter that the parameter files read from the `CASEGUARD_POSTGRES_ADMIN_PASSWORD` environment variable.

### Deployment identity

| Parameter         | Type   | Default                 | Notes                                                                    |
| ----------------- | ------ | ----------------------- | ------------------------------------------------------------------------ |
| `environmentName` | string | **required**            | `dev`, `staging` or `prod`; drives names, `APP_ENV` and several defaults |
| `location`        | string | `deployment().location` | region of the resource group and resources                               |
| `workloadName`    | string | `caseguard`             | 3-9 characters, lowercase letters/digits                                 |
| `nameSalt`        | string | empty                   | changes the generated suffix (fresh names after soft delete)             |
| `owner`           | string | **required**            | tag                                                                      |
| `costCenter`      | string | **required**            | tag                                                                      |

### Container Apps

| Parameter                    | Type   | Default          | Notes                                                             |
| ---------------------------- | ------ | ---------------- | ----------------------------------------------------------------- |
| `deployContainerApps`        | bool   | `true`           | `false` creates only the environment (first stage)                |
| `imageTag`                   | string | empty            | required with `deployContainerApps`; `latest` is rejected in prod |
| `webImageRepository`         | string | `caseguard-web`  | repository in the registry                                        |
| `apiImageRepository`         | string | `caseguard-api`  | repository in the registry (also used by the job)                 |
| `webCpu` / `webMemory`       | string | `0.25` / `0.5Gi` | must follow the Consumption profile pairing (memory = 2 x vCPU)   |
| `webMinReplicas`             | int    | `0`              | 0 = scale to zero                                                 |
| `webMaxReplicas`             | int    | `2`              |                                                                   |
| `webConcurrentRequests`      | int    | `50`             | HTTP scale rule                                                   |
| `apiCpu` / `apiMemory`       | string | `0.5` / `1.0Gi`  |                                                                   |
| `apiMinReplicas`             | int    | `0`              |                                                                   |
| `apiMaxReplicas`             | int    | `2`              | in-memory rate limits are per replica                             |
| `apiConcurrentRequests`      | int    | `20`             |                                                                   |
| `webAllowedIpRanges`         | array  | `[]`             | non-empty = allow-list for the web ingress                        |
| `containerAppsZoneRedundant` | bool   | `false`          | needs private networking and a zone-enabled region                |
| `migrationTimeoutSeconds`    | int    | `900`            | 60-3600                                                           |

### Application configuration

| Parameter                                         | Type   | Default                                  | Notes                                                                         |
| ------------------------------------------------- | ------ | ---------------------------------------- | ----------------------------------------------------------------------------- |
| `appVersion`, `gitCommit`                         | string | empty (version falls back to `imageTag`) | `APP_VERSION`, `GIT_COMMIT`                                                   |
| `logLevel`                                        | string | `info`                                   | `LOG_LEVEL`                                                                   |
| `entraTenantId`                                   | string | **required**                             | `ENTRA_TENANT_ID`                                                             |
| `entraApiAudience`                                | string | **required**                             | `ENTRA_AUDIENCE`; must equal the `aud` claim of your tokens                   |
| `entraWebClientId`                                | string | **required**                             | `NEXT_PUBLIC_ENTRA_CLIENT_ID`                                                 |
| `entraApiScope`                                   | string | **required**                             | `NEXT_PUBLIC_ENTRA_API_SCOPE`                                                 |
| `entraTenantMap`                                  | object | **required**                             | `ENTRA_TENANT_MAP` (Entra tenant id to CaseGuard tenant id)                   |
| `entraRoleMap`                                    | object | the five `CaseGuard.*` roles             | `ENTRA_ROLE_MAP`                                                              |
| `demoMode`                                        | bool   | `true` only for dev                      | `DEMO_MODE`                                                                   |
| `demoAutoSeed`                                    | bool   | `false`                                  | `DEMO_AUTO_SEED`                                                              |
| `databasePoolMax`                                 | int    | `5`                                      | `DB_POOL_MAX`; replicas x pool must stay below the server connection limit    |
| `aiMaxInputTokens`, `aiMaxOutputTokens`           | int    | `24000`, `4000`                          | `AI_MAX_INPUT_TOKENS`, `AI_MAX_OUTPUT_TOKENS`                                 |
| `aiTimeoutMs`, `aiMaxRetries`                     | int    | `30000`, `2`                             | `AI_TIMEOUT_MS`, `AI_MAX_RETRIES`                                             |
| `aiCostLimitUsdPerDay`                            | string | empty                                    | `AI_COST_LIMIT_USD_PER_DAY`; empty = no limit                                 |
| `aiUnitPriceInputPer1k`, `aiUnitPriceOutputPer1k` | string | empty                                    | operator-supplied prices; empty = cost reported as unknown (never hard-coded) |
| `otelSamplingRatio`                               | string | `1`                                      | `OTEL_SAMPLING_RATIO`                                                         |

### Database

| Parameter                            | Type          | Default                          | Notes                                                                                   |
| ------------------------------------ | ------------- | -------------------------------- | --------------------------------------------------------------------------------------- |
| `postgresAuthMode`                   | string        | `password` for dev, else `entra` | `entra` disables password authentication entirely                                       |
| `postgresAdminLogin`                 | string        | `cgadmin`                        | password mode only                                                                      |
| `postgresAdminPassword`              | secure string | empty                            | password mode; at least 16 characters (checked at deployment); stored in Key Vault      |
| `postgresSkuTier`, `postgresSkuName` | string        | `Burstable`, `Standard_B1ms`     | verify availability per region/subscription                                             |
| `postgresVersion`                    | string        | `16`                             | `15`, `16` or `17`                                                                      |
| `postgresStorageGb`                  | int           | `32`                             | auto-grow is on                                                                         |
| `postgresBackupRetentionDays`        | int           | `7`                              | 7-35                                                                                    |
| `postgresGeoRedundantBackup`         | bool          | `false`                          | not available in every region                                                           |
| `postgresHighAvailability`           | string        | `Disabled`                       | `SameZone`/`ZoneRedundant` need GeneralPurpose or MemoryOptimized                       |
| `postgresAllowAzureServices`         | bool          | `false`                          | **dev only**: opens the firewall to every Azure-hosted client (the `0.0.0.0` rule)      |
| `postgresFirewallRules`              | array         | `[]`                             | `{ name, startIpAddress, endIpAddress }`; ignored with private networking               |
| `postgresAllowedExtensions`          | array         | `[]`                             | `azure.extensions` allow-list (for example `pgcrypto`) if migrations `CREATE EXTENSION` |
| `postgresAdditionalEntraAdmins`      | array         | `[]`                             | `{ objectId, principalName, principalType }` for operators (use a group)                |
| `postgresVerboseDiagnostics`         | bool          | `false`                          | exports the high-volume Query Store/session/table-stat categories                       |

### Storage, Key Vault, registry, monitoring

| Parameter                 | Type   | Default        | Notes                                                                                  |
| ------------------------- | ------ | -------------- | -------------------------------------------------------------------------------------- |
| `storageSku`              | string | `Standard_LRS` | LRS, ZRS, GRS or GZRS                                                                  |
| `blobCoolAfterDays`       | int    | `30`           | 0 disables; Cool has an early-deletion charge window                                   |
| `blobDeleteAfterDays`     | int    | `0`            | 0 disables; align with the application retention (governance `retention.caseDataDays`) |
| `blobSoftDeleteDays`      | int    | `7`            | blob and container soft delete                                                         |
| `keyVaultSoftDeleteDays`  | int    | `90`           | 7-90, immutable after creation                                                         |
| `keyVaultPurgeProtection` | bool   | `true`         | irreversible once on; the dev profile sets it to `false`                               |
| `registrySku`             | string | `Basic`        | Premium enables the untagged-manifest retention policy                                 |
| `logRetentionDays`        | int    | `30`           | 30-730                                                                                 |
| `logDailyCapGb`           | int    | `-1`           | -1 = no cap; a cap stops ingestion for the rest of the UTC day when reached            |
| `diagnosticsEnabled`      | bool   | `true`         | diagnostic settings on every supported resource                                        |
| `containerAppsHttpLogs`   | bool   | `false`        | ingress logs contain client IPs and paths: privacy review first                        |

### Optional services

| Parameter                                    | Type        | Default                  | Notes                                                                                      |
| -------------------------------------------- | ----------- | ------------------------ | ------------------------------------------------------------------------------------------ |
| `deploySearch`                               | bool        | `false`                  | `SEARCH_PROVIDER` becomes `azure-ai-search` when deployed                                  |
| `searchSku`                                  | string      | `basic`                  | `free` has no private endpoints and tight limits                                           |
| `searchReplicaCount`, `searchPartitionCount` | int         | `1`, `1`                 | ignored on `free`                                                                          |
| `searchIndexName`                            | string      | `caseguard`              | the index is **not** created by this template                                              |
| `deployOpenAi`                               | bool        | `false`                  | new account; `AI_PROVIDER` becomes `azure-openai` when an endpoint exists                  |
| `existingOpenAiResourceId`                   | string      | empty                    | existing account (any resource group/subscription); mutually exclusive with `deployOpenAi` |
| `existingOpenAiEndpoint`                     | string      | empty                    | required with the resource id                                                              |
| `openAiDeploymentName`                       | string      | `caseguard-chat`         | `AZURE_OPENAI_DEPLOYMENT`; must exist on the account                                       |
| `openAiApiVersion`                           | string      | `2024-10-21`             | `AZURE_OPENAI_API_VERSION`                                                                 |
| `deployOpenAiModel`                          | bool        | `false`                  | creates a model deployment on a **new** account; needs access, region and quota            |
| `openAiModelName`, `openAiModelVersion`      | string      | empty                    | required with `deployOpenAiModel`; no defaults on purpose                                  |
| `openAiModelSkuName`, `openAiModelCapacity`  | string, int | `Standard`, `10`         | deployment SKU and capacity                                                                |
| `deployRedis`                                | bool        | `false`                  | not used by the application yet                                                            |
| `redisOffering`, `redisManagedSku`           | string      | `managed`, `Balanced_B0` | `cache` = classic Azure Cache for Redis (closed to new customers)                          |

### Private networking

| Parameter                     | Type   | Default        | Notes                                                                                         |
| ----------------------------- | ------ | -------------- | --------------------------------------------------------------------------------------------- |
| `enablePrivateNetworking`     | bool   | `false`        | VNet, VNet-integrated environment, private endpoints, public access disabled on data services |
| `vnetAddressPrefix`           | string | `10.40.0.0/16` |                                                                                               |
| `containerAppsSubnetPrefix`   | string | `10.40.0.0/23` | delegated to `Microsoft.App/environments`                                                     |
| `privateEndpointSubnetPrefix` | string | `10.40.2.0/26` |                                                                                               |

### Budget and alerts

| Parameter                      | Type   | Default                | Notes                                                                        |
| ------------------------------ | ------ | ---------------------- | ---------------------------------------------------------------------------- |
| `monthlyBudgetAmount`          | int    | **required**           | notification threshold in the billing currency, not an estimate              |
| `budgetStartDate`              | string | `utcNow('yyyy-MM-01')` | first day of a month; pass a fixed value on later deployments to avoid drift |
| `budgetActualThresholds`       | array  | `[50, 80, 100]`        | at most four                                                                 |
| `budgetForecastThreshold`      | int    | `100`                  | 0 disables                                                                   |
| `contactEmails`                | array  | **required**           | budget and alert recipients                                                  |
| `deployAlerts`                 | bool   | `true`                 | needs `deployContainerApps`                                                  |
| `alertServerErrorThreshold`    | int    | `5`                    | 5xx responses in 15 minutes                                                  |
| `alertResponseTimeThresholdMs` | int    | `2000`                 | average response time over 15 minutes                                        |

## Environment profiles

| Setting                    | dev (`main.dev.bicepparam`)             | staging (template)       | prod (template)                                      |
| -------------------------- | --------------------------------------- | ------------------------ | ---------------------------------------------------- |
| Database auth              | password (from environment variable)    | Entra only               | Entra only                                           |
| Database SKU               | Burstable `Standard_B1ms`, no HA        | Burstable `Standard_B2s` | GeneralPurpose `Standard_D2ds_v5`, zone-redundant HA |
| Postgres firewall          | opened to Azure services (**dev only**) | closed                   | closed (private endpoint)                            |
| Private networking         | off                                     | on                       | on                                                   |
| Replicas (min/max)         | 0 / 2                                   | 0 / 2                    | 1 / 3                                                |
| Key Vault purge protection | off (fast re-deploy)                    | on                       | on                                                   |
| Search / OpenAI / Redis    | off                                     | off                      | search on, OpenAI via existing account, Redis off    |
| Alerts                     | off                                     | on                       | on                                                   |
| Log cap                    | 1 GB/day                                | 2 GB/day                 | none                                                 |

## Secrets and parameter files

- Committed `*.bicepparam` and `*.template` files contain only placeholders (`00000000-0000-0000-0000-000000000000`, `CHANGE-ME`, `example.com`, `<...>`). Copy to `main.<env>.local.bicepparam` (git-ignored here), fill in your values and deploy that copy.
- Dynamic or secret values come from environment variables read by the parameter file: `CASEGUARD_DEPLOY_APPS`, `CASEGUARD_IMAGE_TAG`, `CASEGUARD_POSTGRES_ADMIN_PASSWORD`. The scripts set them for the child process only.
- Do not run `bicep build-params` with `CASEGUARD_POSTGRES_ADMIN_PASSWORD` set and redirect the output: the generated parameter JSON would contain the password.

## Validate locally (no Azure calls)

```powershell
bicep --version
bicep lint infra/bicep/main.bicep          # also run per module: infra/bicep/modules/*.bicep
bicep build infra/bicep/main.bicep --stdout > NUL
bicep build-params infra/bicep/main.dev.bicepparam --stdout > NUL
```

`pnpm infra:validate` (the root script `scripts/infra-validate.mjs`) runs the same checks and additionally scans parameter files for real-looking ids and secret literals; it passed when run locally during authoring. These commands prove the templates compile and lint; they do **not** prove a deployment succeeds. Run What-If before the first real deployment (`infra/scripts/what-if.*`).

## Linter suppressions

Three `#disable-next-line what-if-short-circuiting` comments in `main.bicep`, all for the managed identity **principal id**: it exists only after the identity is created, and the PostgreSQL Entra administrator and the role assignments must be named after it (so a recreated identity never collides with an orphaned assignment). The effect is that What-If cannot preview those specific resources before the first deployment. Every other what-if-short-circuiting finding was fixed by passing known-at-start names and an explicit private-endpoint flag instead of runtime values.

## API versions and assumptions to re-verify

API versions were chosen as the newest generally available version known to Bicep 0.48.1 at authoring time for each type, except where noted. The Bicep compiler validates property names and types against these versions; it cannot validate service behaviour. Re-verify against the current Azure resource reference before the first deployment.

| Resource type                                                           | API version        | Note                                                                        |
| ----------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------- |
| `Microsoft.Resources/resourceGroups`                                    | 2025-04-01         |                                                                             |
| `Microsoft.OperationalInsights/workspaces`                              | 2025-02-01         |                                                                             |
| `Microsoft.Insights/components`                                         | 2020-02-02         | only version                                                                |
| `Microsoft.ManagedIdentity/userAssignedIdentities`                      | 2024-11-30         |                                                                             |
| `Microsoft.ContainerRegistry/registries`                                | 2025-04-01         |                                                                             |
| `Microsoft.KeyVault/vaults` (+ `secrets`)                               | 2025-05-01         |                                                                             |
| `Microsoft.Storage/storageAccounts` (+ children)                        | 2025-06-01         |                                                                             |
| `Microsoft.DBforPostgreSQL/flexibleServers` (+ children)                | 2025-08-01         | SKU/region availability is a deployment-time fact                           |
| `Microsoft.Search/searchServices`                                       | 2025-05-01         |                                                                             |
| `Microsoft.CognitiveServices/accounts` (+ `deployments`)                | 2025-06-01         | model names, versions and quota are not validated                           |
| `Microsoft.Cache/redisEnterprise` (+ children)                          | 2025-07-01         | Azure Managed Redis SKU names are assumptions                               |
| `Microsoft.Cache/redis` (+ `accessPolicyAssignments`)                   | 2024-11-01         | classic offering is closed to new customers                                 |
| `Microsoft.App/managedEnvironments`, `containerApps`, `jobs`            | 2025-01-01         |                                                                             |
| `Microsoft.Network/virtualNetworks`, `privateEndpoints` (+ zone groups) | 2025-05-01         |                                                                             |
| `Microsoft.Network/privateDnsZones` (+ links)                           | 2024-06-01         |                                                                             |
| `Microsoft.Consumption/budgets`                                         | 2024-08-01         | newer 2026-06-01 exists; older, widely used version kept deliberately       |
| `Microsoft.Insights/actionGroups`                                       | 2023-01-01         |                                                                             |
| `Microsoft.Insights/metricAlerts`                                       | 2018-03-01         | newer 2026-01-01 exists; the long-standing stable version kept deliberately |
| `Microsoft.Insights/diagnosticSettings`                                 | 2021-05-01-preview | the current version for category groups; there is no newer one              |
| `Microsoft.Authorization/roleAssignments`                               | 2022-04-01         |                                                                             |

Other assumptions: the Private DNS zone names (public cloud) and private endpoint group ids, the `statusCodeCategory` metric dimension value `5xx` and the `ResponseTime` (Preview) metric used by the alerts, the `ContainerAppConsoleLogs`/`ContainerAppSystemLogs`/`ContainerAppHTTPLogs` diagnostic categories, and the Key Vault trusted-service list (Container Apps is not on it, so a public vault is not firewalled to deny).

## Assumptions about application code (verify with the owners)

The templates were written against the build contract, not against finished code. Each item below is something the infrastructure depends on and that could not be confirmed when this was authored:

- The API image's working directory contains `dist/`, so `node dist/main.js` and `node dist/db/migrate-cli.js` resolve (`apps/api` scripts: `start`, `db:migrate`). `apps/api/Dockerfile` (read statically, never built here) matches: `WORKDIR /app`, `dist/` copied into it, non-root user 1000, port 4000. Dockerfiles are at `apps/api/Dockerfile` and `apps/web/Dockerfile` with the repository root as the build context (as `scripts/docker-build.mjs` and `docker-compose.yml` assume).
- The API listens on port 4000 and serves unauthenticated `/livez` and `/readyz` (the latter checks the database and migrations); the web app listens on port 3000 and has no health route of its own (`apps/web/src/proxy.ts` forwards `/livez`, `/healthz` and `/readyz` to the API, so a web HTTP probe would test the API, not the web container), so only TCP probes are used for the web app.
- The environment-variable names are those of the contract (`BUILD_CONTRACT.md` section 6); `packages/config` was not yet present to compare. `ENTRA_ISSUER` and `ENTRA_JWKS_URI` are deliberately not set (derivable from the tenant id).
- `DATABASE_URL` as built here (`postgres://user[:password]@host:5432/caseguard?sslmode=require`) is accepted by the API; in `entra` mode the user is the managed identity name and the password is an access token obtained with `DefaultAzureCredential` (`AZURE_CLIENT_ID` is set for that).
- The migration job needs the same configuration as the API (the shared config validation), so it receives the same environment.
- The web build inlines `NEXT_PUBLIC_*` (see `docker-compose.yml`) while `API_INTERNAL_URL` is read at runtime; the OAuth redirect URI used by the web app is the page origin (`window.location.origin`: the site root with no path), as read from `apps/web/src/lib/auth/entra.tsx` and documented in docs/ENTRA_ID_SETUP.md. Register exactly that origin as a SPA redirect URI.
- The structured log field names used by the queries in docs/OBSERVABILITY.md.

## Not included (documented limitations)

- NSGs/UDRs/egress firewall, VNet peering, Azure Monitor Private Link Scope, private endpoint for the registry (needs Premium), custom domains and certificates, WAF/Front Door, Defender plans, resource locks, Azure Policy assignments.
- Separate migration and runtime identities. With a single identity, the API connects as the role that owns the tables, which **bypasses PostgreSQL row-level security unless the tables use `FORCE ROW LEVEL SECURITY`**. Verify this on the first deployment (docs/THREAT_MODEL.md section 5) and consider a second, non-owner runtime role.
- Multi-region, disaster-recovery automation, and Entra app registrations (see docs/ENTRA_ID_SETUP.md).
