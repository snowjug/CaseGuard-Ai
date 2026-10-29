# Global search (`search.global`)

`GET /api/v1/search?q=&limit=` returns `{ items: SearchResult[] }` for the caller's tenant only. Permission
`case:read`. `q` is 2-200 characters after trimming (a shorter or blank query is a 422 with path `query.q`),
`limit` is 1-25 (default 10). The query text is never logged, audited or used as a metric label.

## Providers

| `SEARCH_PROVIDER`   | Behaviour                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| `lexical` (default) | PostgreSQL full-text search through `ctx.repos.search` (see `db/README.md`). Always tenant-scoped by RLS. |
| `azure-ai-search`   | The external index is tried first with a 3 s deadline; any failure falls back to the lexical search.      |

The fallback is invisible in the response. It is recorded only as the retrieval metric
`caseguard_retrieval_duration_seconds{provider="azure-ai-search",outcome="fallback"}` (successful calls use
`outcome="ok"`, lexical calls `provider="lexical"`), plus a warning log with the failure code
(`timeout`, `http_error`, `auth`, `network`, `unsafe_endpoint`, ...), never the query.

Each hit gets an `href` that matches the web app's deep links: `/cases/{id}`, `/skills/{id}`,
`/cases/{caseId}/{evidence|hypotheses|timeline|quality}?sel={id}` (claims, hypotheses, events, warnings).
Titles and snippets are masked for credentials once more on the way out and bounded to 300 characters.

## Azure AI Search adapter (`azure-ai-search.ts`)

**Implemented and validated against mocks only.** It has never been run against a live search service; every
test injects a fake `fetch` and a fake credential.

- Request: `POST <endpoint>/indexes/<index>/docs/search?api-version=2024-07-01` with
  `Authorization: Bearer <token>` from `DefaultAzureCredential` (scope `https://search.azure.com/.default`,
  managed identity in Azure; there is no key option) and the body
  `{ search, queryType: "simple", searchMode: "all", top, filter, select, count: false }`.
- The endpoint must pass `assertSafeOutboundUrl` for `*.search.windows.net` (https, default port, no
  credentials, no IP literal); redirects are never followed; the body is capped at 1 MB.
- **Tenant isolation:** `filter` is always `tenantId eq '<caller tenant>'` (the id is validated and
  quote-escaped), and every returned document is checked against the tenant again; a document of another
  tenant is discarded and logged as an error.
- **Index population is out of scope.** The index must be created and filled outside this API (an indexer, a
  pipeline or a script), with the case content already redacted. Documents need these fields:

```json
{
  "id": "tenant_contoso_support:event:evt_03",
  "tenantId": "tenant_contoso_support",
  "type": "case | claim | hypothesis | skill | warning | event",
  "entityId": "evt_03",
  "caseId": "case_alpha",
  "title": "Resolver check",
  "snippet": "Plain text, at most 300 characters."
}
```

`id` is the index key and must be unique across tenants; `entityId` is the CaseGuard id used in links (it
falls back to `id`). `tenantId` must be filterable. `caseId` is null for skills. Scores are BM25 and are mapped
into [0, 1) (`s / (1 + s)`, order preserved) so they resemble lexical scores; they are only for ordering.
