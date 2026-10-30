# Runbook: search unavailable

Applies when `SEARCH_PROVIDER=azure-ai-search` (that is, `deploySearch=true`). With the default `lexical` provider (PostgreSQL full-text search) there is no external search dependency.

The API treats Azure AI Search as an optional accelerator: the external index is tried first with a 3 s deadline and the API **falls back to the PostgreSQL full-text search** (`apps/api/src/services/search/search-service.ts`) when the call fails **or** when the index answers with documents but none of them can be used. Users therefore see slower or differently ranked results, not errors; the fallback is visible only in warning logs and in-process metrics. Only global search (`GET /api/v1/search`) uses the provider; analysis does not. Two situations do **not** fall back: an empty answer (the index has nothing for the query, so the response is an empty list) and single unusable documents among usable ones (they are dropped and counted, the rest are shown).

> Not exercised against a live deployment. See the [honesty note](README.md).

## Symptoms

- Global search answers, but up to 3 s slower than usual (the external call times out before the fallback) and ranked by the PostgreSQL full-text search instead of the index. Results that exist only in the index are missing.
- The API logs a warning `Azure AI Search failed; using lexical search` with a `failure` field: `auth` (no token), `http_error` (the status is in the exception, for example 401/403/404/429/503), `timeout`, `network` (DNS or connection), `unsafe_endpoint`, `invalid_index`, `invalid_tenant`, `too_large`, `invalid_response` (not JSON, no `value` array, or more than 200 documents) or `aborted`. The query text is never logged.
- The API logs a warning `Azure AI Search returned no usable documents; using lexical search` (`failure` = `no_usable_documents`): the index answered with documents but every one was dropped, because of a wrong shape, an invalid link or case id, a missing title, or another tenant's data. See [Index document requirements](#index-document-requirements).
- Fewer results than expected, or results missing from an otherwise working index: unusable documents are dropped one by one. Azure is asked for `limit` documents, so each dropped one leaves the answer shorter. The response stays a 200; the drops are logged by count only and counted in the in-process metric `caseguard_errors_total{component="search", code=...}`, one increment per dropped document or hit:

  | Log line (`msg`)                                                            | Level   | Fields                                                   | `code`                    | Meaning                                                                                                                                                          |
  | --------------------------------------------------------------------------- | ------- | -------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `Azure AI Search returned malformed documents; they were discarded`         | `warn`  | `discarded`                                              | `invalid_document`        | A document of the caller's tenant that cannot be shown (shape, ids, case id, title)                                                                              |
  | `Azure AI Search returned documents of another tenant; they were discarded` | `error` | `discarded`                                              | `foreign_tenant_document` | The index ignored the tenant filter or holds mixed data. Never shown, but treat it as a security incident                                                        |
  | `Search hits that do not satisfy the result contract were discarded`        | `warn`  | `provider` (`azure-ai-search` or `lexical`), `discarded` | `invalid_result`          | A hit from either provider failed the last check before the answer: valid ids, a title, a case that fits the type, an `href` that is one of the app's own routes |

- An **empty** result list for a query that should match is not an error and nothing logs it as one: the index answered with no documents (never populated, other tenant ids, stale content), so there is no fallback and the retrieval is recorded as `outcome="ok"`. Compare with the PostgreSQL results (see Mitigation 1).
- After a new deployment, search worked locally (lexical) but the Azure index is never used.

## Impact

- Search keeps working through the fallback; ranking and recall differ. Case data, the evidence ledger and analysis math live in PostgreSQL and are unaffected.
- A document the API cannot show is never fatal and never shown: it is dropped, so it is simply absent from results until the index is corrected.
- No data is lost: the index is derived data that can be rebuilt from the database.

## Detection

- Console logs (the base function is defined in [OBSERVABILITY.md](../OBSERVABILITY.md) section 2). Fallbacks, by reason:

  ```kusto
  CgApiLogs()
  | where TimeGenerated > ago(1h)
      and msg in ('Azure AI Search failed; using lexical search', 'Azure AI Search returned no usable documents; using lexical search')
  | summarize fallbacks = count() by failure
  ```

  Dropped documents and hits (counts only; a document of another tenant is logged at `error`, and any occurrence is a security incident):

  ```kusto
  CgApiLogs()
  | where TimeGenerated > ago(24h)
      and msg in (
          'Azure AI Search returned malformed documents; they were discarded',
          'Azure AI Search returned documents of another tenant; they were discarded',
          'Search hits that do not satisfy the result contract were discarded')
  | summarize lines = count(), discarded = sum(discarded) by msg, level, provider, bin(TimeGenerated, 1h)
  | order by TimeGenerated desc
  ```

- The in-process metrics `caseguard_retrieval_duration_seconds{provider="azure-ai-search",outcome="fallback"}` (fallbacks) and `caseguard_errors_total{component="search", code="invalid_document" | "foreign_tenant_document" | "invalid_result"}` (drops) exist, but nothing exports them today and `GET /api/v1/system/metrics` does not include them (OBSERVABILITY.md section 8), so rely on the log lines.
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
6. **Content.** The index exists but results are empty, stale or missing items: the index was never populated, or the external process that fills it failed or writes documents the API cannot use. This repository ships no indexer (index population is out of scope, see `apps/api/src/services/search/README.md`), so check whatever the operator set up against [Index document requirements](#index-document-requirements). The counts in the `discarded` warnings (Symptoms) tell which kind of problem it is: `invalid_document` is a shape, id, case id or title problem; `foreign_tenant_document` is a wrong or missing tenant filter or mixed content; an empty answer with no warning means the index simply holds nothing for that tenant and query.

## Mitigation

1. **Use the PostgreSQL full-text search only** (results and ranking will differ and any index-only content is unavailable). This also removes the up-to-3 s wait on every search while the index is failing:

   ```powershell
   az containerapp update --subscription $sub --resource-group $rg --name <api app> --set-env-vars SEARCH_PROVIDER=lexical
   ```

   This drifts from the template; set `deploySearch=false` in your parameter file if it must persist.

2. Grant the missing role, create the missing index, repair DNS/private endpoint, or add replicas/partitions (`searchReplicaCount`, `searchPartitionCount`; each unit adds hourly cost).
3. If a free service hit its limits, move to `basic` (redeploy with `searchSku`; changing tier may require recreating the service) or stay on lexical.
4. **Fix the documents at their source.** The API never repairs or guesses a document it drops; correct the process that fills the index (ids, `caseId`, `title`, `tenantId`), delete the bad documents and re-index them.
5. **Documents of another tenant (`foreign_tenant_document`)**: switch to `SEARCH_PROVIDER=lexical` (Mitigation 1) until it is understood. The API's tenant filter and per-document check kept those documents out of every answer, so nothing was shown, but the index content or its filter is wrong: find which documents carry the wrong `tenantId`, and follow your organisation's process for a possible cross-tenant data exposure.

## Recovery

- Re-create and re-populate the index from PostgreSQL with the operator's own indexing process (this repository has none); verify document counts against the database, and verify that every document carries the right `tenantId` and meets [Index document requirements](#index-document-requirements).
- Switch back: `SEARCH_PROVIDER=azure-ai-search` (redeploy to restore the template state).

## Verification

- A search through the UI (or `GET /api/v1/search?q=<term>`, permission `case:read`) returns results for a known synthetic case. Because the fallback is invisible in the response, a result alone does not prove the index works: also confirm that neither `Azure AI Search failed; using lexical search` nor `Azure AI Search returned no usable documents; using lexical search` is logged while you search, and that no `discarded` warning appears for the same queries.
- Query 4.6 shows normal latency; no 401/403/404/429 in the last 30 minutes.
- Search service metrics show no throttling.

## Follow-ups

- Document who owns the index schema and how it is rebuilt; build the indexer (none exists in this repository) and automate index creation in a deployment step with an operator identity.
- Alert on throttled queries and on 4xx from search; alert on any `error`-level `Azure AI Search returned documents of another tenant; they were discarded` line and on a sustained rate of `no_usable_documents`. Export the in-process counters (`caseguard_retrieval_duration_seconds` with `outcome="fallback"`, `caseguard_errors_total{component="search"}`) so a silent fallback or drop becomes visible without log parsing.
- Re-evaluate the tier: the free tier is for smoke tests only.
- Remember the cost of replicas and partitions (docs/COST_GUIDE.md); delete the service when not needed.

## Index document requirements

What `apps/api/src/services/search/azure-ai-search.ts` accepts from the index (source of truth: `apps/api/src/services/search/README.md`). The API selects the fields `id,tenantId,type,entityId,caseId,title,snippet`, always sends the filter `tenantId eq '<caller tenant>'` (so `tenantId` must be a **filterable** field), and asks for at most `limit` documents (1 to 25). Index creation and population are an operator task: neither the Bicep template nor this repository does either. This has been validated against mocks only, never against a live service.

| Field           | Required                                      | Rule                                                                                                                                                                                                                                                                        |
| --------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`            | yes                                           | The index key: text of 1 to 300 characters, unique across tenants (for example `tenant_contoso_support:event:evt_03`). It is the link id only when `entityId` is absent, and then it must itself be a valid CaseGuard id                                                    |
| `tenantId`      | yes                                           | Must equal the caller's tenant exactly. A document naming another tenant is dropped as `foreign_tenant_document` even if it is also malformed; a document with no `tenantId` is dropped as `invalid_document`                                                               |
| `type`          | yes                                           | One of `case`, `claim`, `hypothesis`, `skill`, `warning`, `event`                                                                                                                                                                                                           |
| `entityId`      | recommended                                   | The CaseGuard id used in links. A valid id is 1 to 120 characters, letters, digits and `_ . : -`, starting with a letter or digit. Falls back to `id` when it is absent or null, so supply it whenever the key is not itself such an id; an empty string drops the document |
| `caseId`        | for `claim`, `hypothesis`, `event`, `warning` | The valid CaseGuard id of the case. A missing, null, empty, too long or invalid value drops the document. For `skill` (no case) and `case` (a case is its own case) the value is ignored, provided it is absent, null or text of 1 to 120 characters                        |
| `title`         | yes                                           | Text of at most 2,000 characters that is not empty once markup and control characters are removed. A longer title, or one that is only markup, blanks or control characters, drops the document                                                                             |
| `snippet`       | no                                            | Text of at most 20,000 characters (longer drops the document); shown clipped to 300 characters                                                                                                                                                                              |
| `@search.score` | returned by Azure                             | A finite number from 0 to 1e9 (it is part of every hit Azure returns, not an index field you define); BM25 scores are mapped into [0, 1) and used for ordering only                                                                                                         |

Text handling: `title` and `snippet` are reduced to plain text (tags, comments, scripts and styles removed, control characters and blank runs collapsed; entities are **not** decoded), credentials are masked once more on the way out, and the title and snippet are clipped to 300 characters. The `href` of a result is built by the API from the type and ids and must be one of the app's own routes (`/cases/<id>`, `/skills/<id>`, `/cases/<case>/<evidence|hypotheses|timeline|quality>?sel=<id>`); a result that would break that, or any other part of the response contract, is dropped as `invalid_result`.
