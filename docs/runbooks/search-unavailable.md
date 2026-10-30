# Runbook: search unavailable

Applies when `SEARCH_PROVIDER=azure-ai-search` (that is, `deploySearch=true`). With the default `lexical` provider (PostgreSQL full-text search) there is no external search dependency.

The API treats Azure AI Search as an optional accelerator: the external index is tried first with a 3 s deadline and **any failure falls back to the PostgreSQL full-text search** (`apps/api/src/services/search/search-service.ts`). Users therefore see slower or differently ranked results, not errors; the failure is visible only in a warning log and an in-process metric. Only global search (`GET /api/v1/search`) uses the provider; analysis does not.

> Not exercised against a live deployment. See the [honesty note](README.md).

## Symptoms

- Global search answers, but up to 3 s slower than usual (the external call times out before the fallback) and ranked by the PostgreSQL full-text search instead of the index. Results that exist only in the index are missing.
- The API logs a warning `Azure AI Search failed; using lexical search` with a `failure` field: `auth` (no token), `http_error` (the status is in the exception, for example 401/403/404/429/503), `timeout`, `network` (DNS or connection), `unsafe_endpoint`, `invalid_index`, `invalid_tenant`, `too_large`, `invalid_response` or `aborted`. The query text is never logged.
- After a new deployment, search worked locally (lexical) but the Azure index is never used.

## Impact

- Search keeps working through the fallback; ranking and recall differ. Case data, the evidence ledger and analysis math live in PostgreSQL and are unaffected.
- No data is lost: the index is derived data that can be rebuilt from the database.

## Detection

- Console logs (the base function is defined in [OBSERVABILITY.md](../OBSERVABILITY.md) section 2): `CgApiLogs() | where TimeGenerated > ago(1h) and msg == 'Azure AI Search failed; using lexical search' | summarize failures = count() by failure`. A document of another tenant returned by the index is logged at `error` (`Azure AI Search returned documents of another tenant; they were discarded`): treat any occurrence as a security incident.
- The in-process metric `caseguard_retrieval_duration_seconds{provider="azure-ai-search",outcome="fallback"}` counts the fallbacks, but nothing exports it today (OBSERVABILITY.md section 8), so rely on the log line.
- `/readyz` does not test Azure AI Search: the `search` health check is a local stand-in.
- Search resource logs: `AzureDiagnostics | where ResourceProvider == 'MICROSOFT.SEARCH' and Category == 'OperationLogs'` (check `ResultSignature`, `DurationMs`).
- Search service metrics in the portal (search latency, throttled queries).

## Triage

1. **Service state and tier.**

   ```powershell
   az search service show --subscription $sub --resource-group $rg --name <search> --query "{status:status,state:provisioningState,sku:sku.name,replicas:replicaCount,partitions:partitionCount,publicAccess:publicNetworkAccess,localAuthDisabled:disableLocalAuth}" -o table
   ```

2. **Authorization (the most common failure).** The template disables API keys, so every call needs an Entra token and the identity needs **Search Index Data Contributor** on the service. Role assignments can take several minutes to propagate. Check: `az role assignment list --subscription $sub --scope <search resource id> --query "[].{role:roleDefinitionName,principal:principalId}" -o table`. 401/403 with the role present usually means the identity or `AZURE_CLIENT_ID` is wrong.
3. **Index.** A 404 on the index means it does not exist: **this template does not create it** (`searchIndexName`, default `caseguard`), and the application identity is deliberately not allowed to create indexes. List indexes with an operator identity holding Search Service Contributor / Index Data Reader:

   ```powershell
   az rest --method get --url "https://<search>.search.windows.net/indexes?api-version=2024-07-01" --resource "https://search.azure.com"
   ```

   (Verify the data-plane API version against the current Azure AI Search documentation.)

4. **Throttling and capacity.** 429/503 under load: more replicas (queries) or partitions (storage), or lower concurrency. **Free tier:** hard limits on index count, storage and documents, no scaling, no private endpoints, no SLA; writes start failing when a limit is reached.
5. **Network.** Private networking: the private endpoint must be approved and `privatelink.search.windows.net` linked to the VNet; check resolution from the API container (`az containerapp exec ... --command "nslookup <search>.search.windows.net"`). `publicNetworkAccess` is `disabled` when private networking is enabled.
6. **Content.** Index exists but results are empty or stale: the index was never populated or the external process that fills it failed. This repository ships no indexer (index population is out of scope, see `apps/api/src/services/search/README.md`), so check whatever the operator set up.

## Mitigation

1. **Use the PostgreSQL full-text search only** (results and ranking will differ and any index-only content is unavailable). This also removes the up-to-3 s wait on every search while the index is failing:

   ```powershell
   az containerapp update --subscription $sub --resource-group $rg --name <api app> --set-env-vars SEARCH_PROVIDER=lexical
   ```

   This drifts from the template; set `deploySearch=false` in your parameter file if it must persist.

2. Grant the missing role, create the missing index, repair DNS/private endpoint, or add replicas/partitions (`searchReplicaCount`, `searchPartitionCount`; each unit adds hourly cost).
3. If a free service hit its limits, move to `basic` (redeploy with `searchSku`; changing tier may require recreating the service) or stay on lexical.

## Recovery

- Re-create and re-populate the index from PostgreSQL with the operator's own indexing process (this repository has none); verify document counts against the database, and verify that every document carries the right `tenantId`.
- Switch back: `SEARCH_PROVIDER=azure-ai-search` (redeploy to restore the template state).

## Verification

- A search through the UI (or `GET /api/v1/search?q=<term>`, permission `case:read`) returns results for a known synthetic case. Because the fallback is invisible in the response, a result alone does not prove the index works: also confirm that no `Azure AI Search failed; using lexical search` warning is logged while you search.
- Query 4.6 shows normal latency; no 401/403/404/429 in the last 30 minutes.
- Search service metrics show no throttling.

## Follow-ups

- Document who owns the index schema and how it is rebuilt; build the indexer (none exists in this repository) and automate index creation in a deployment step with an operator identity.
- Alert on throttled queries and on 4xx from search, and export the in-process fallback counter (`caseguard_retrieval_duration_seconds` with `outcome="fallback"`) so a silent fallback becomes visible without log parsing.
- Re-evaluate the tier: the free tier is for smoke tests only.
- Remember the cost of replicas and partitions (docs/COST_GUIDE.md); delete the service when not needed.
