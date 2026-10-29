# Runbook: search unavailable

Applies when `SEARCH_PROVIDER=azure-ai-search` (that is, `deploySearch=true`). With the default `lexical` provider there is no external search dependency.

> Not exercised against a live deployment. See the [honesty note](README.md).

## Symptoms

- Global search and retrieval-backed features return errors or empty results; the API logs mention 401/403, 404 on the index, 429/503, timeouts or DNS errors for `<service>.search.windows.net`.
- After a new deployment, search worked locally (lexical) but not in Azure.

## Impact

- Search and retrieval-grounded features degrade or fail. Case data, the evidence ledger and analysis math live in PostgreSQL and are unaffected.
- No data is lost: the index is derived data that can be rebuilt from the database.

## Detection

- Console logs: `CgApiLogs() | where TimeGenerated > ago(1h) and (route has 'search' or event startswith 'retrieval') and (level >= 50 or status >= 500)`, and OBSERVABILITY 4.6 (retrieval latency).
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
6. **Content.** Index exists but results are empty or stale: the index was never populated or an indexing job failed; check the application's indexing logs.

## Mitigation

1. **Fall back to lexical search** (in-process BM25; results and ranking will differ and any index-only content is unavailable):

   ```powershell
   az containerapp update --subscription $sub --resource-group $rg --name <api app> --set-env-vars SEARCH_PROVIDER=lexical
   ```

   This drifts from the template; set `deploySearch=false` in your parameter file if it must persist.

2. Grant the missing role, create the missing index, repair DNS/private endpoint, or add replicas/partitions (`searchReplicaCount`, `searchPartitionCount`; each unit adds hourly cost).
3. If a free service hit its limits, move to `basic` (redeploy with `searchSku`; changing tier may require recreating the service) or stay on lexical.

## Recovery

- Re-create and re-populate the index from PostgreSQL using the application's indexing procedure; verify document counts against the database.
- Switch back: `SEARCH_PROVIDER=azure-ai-search` (redeploy to restore the template state).

## Verification

- A search through the UI (or `GET /api/v1/search?q=<term>`, permission `case:read`) returns results for a known synthetic case.
- Query 4.6 shows normal latency; no 401/403/404/429 in the last 30 minutes.
- Search service metrics show no throttling.

## Follow-ups

- Document who owns the index schema and how it is rebuilt; automate index creation in the application or a deployment step with an operator identity.
- Alert on throttled queries and on 4xx from search.
- Re-evaluate the tier: the free tier is for smoke tests only.
- Remember the cost of replicas and partitions (docs/COST_GUIDE.md); delete the service when not needed.
