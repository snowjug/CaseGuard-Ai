# Global search (`search.global`)

`GET /api/v1/search?q=&limit=` returns `{ items: SearchResult[] }` for the caller's tenant only. Permission
`case:read`. `q` is 2-200 characters after trimming (a shorter or blank query is a 422 with path `query.q`),
`limit` is 1-25 (default 10). The query text is never logged, audited or used as a metric label.

## Providers

| `SEARCH_PROVIDER`   | Behaviour                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `lexical` (default) | PostgreSQL full-text search through `ctx.repos.search` (see `db/README.md`). Always tenant-scoped by RLS.                                   |
| `azure-ai-search`   | The external index is tried first with a 3 s deadline; any failure, or an answer with no usable document, falls back to the lexical search. |

The fallback is invisible in the response. It is recorded only as the retrieval metric
`caseguard_retrieval_duration_seconds{provider="azure-ai-search",outcome="fallback"}` (successful calls use
`outcome="ok"`, lexical calls `provider="lexical"`), plus a warning log with the failure code
(`timeout`, `http_error`, `auth`, `network`, `unsafe_endpoint`, ...), never the query.

Each hit gets an `href` that matches the web app's deep links: `/cases/{id}`, `/skills/{id}`,
`/cases/{caseId}/{evidence|hypotheses|timeline|quality}?sel={id}` (claims, hypotheses, events, warnings).
Titles and snippets are masked for credentials once more on the way out and bounded to 300 characters.

Every hit, from either provider, is checked against the result contract before it is answered: the response
schema (`SearchResultSchema`), valid CaseGuard ids (a result is a link), a case that fits the type (a case is
its own case, a skill has none, anything else needs one) and an href that is one of the app's own routes. A
hit that fails is **dropped, never fatal**: the response stays a 200, the limit applies to the hits that are
left, and the drop is counted in a warning log (`discarded: <n>`, never the content) and in
`caseguard_errors_total{component="search",code="invalid_result"}`.

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
  tenant is discarded and logged as an error, even when it is also malformed.
- **A document that cannot be shown is dropped and counted, never fatal.** It is dropped when its shape is
  wrong, its link id (`entityId`, else `id`) is not a valid CaseGuard id (letters, digits and `_ . : -`, at
  most 120 characters, starting with a letter or digit), a claim, hypothesis, event or warning has no valid
  `caseId`, or its title is empty once cleaned. Text is reduced to plain text: tags, comments, scripts and
  styles are removed (a `<` that does not open markup, as in `a < b`, stays), so a title that is only markup
  is dropped. Counts go to the log (`discarded: <n>`: a warning for malformed documents, an error for
  documents of another tenant) and to `caseguard_errors_total{component="search",code="invalid_document"}`
  or `code="foreign_tenant_document"`. If the index answers with documents but none can be used, the call
  counts as a failure and the lexical search answers (`failure="no_usable_documents"`).
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
falls back to `id`, so give it whenever the key is not itself a CaseGuard id). `tenantId` must be
filterable. `caseId` is required for claims, hypotheses, events and warnings, and ignored for skills (none)
and cases (a case is its own case). `title` and `snippet` are plain text: markup is removed. Scores are BM25
and are mapped into [0, 1) (`s / (1 + s)`, order preserved) so they resemble lexical scores; they are only
for ordering.
