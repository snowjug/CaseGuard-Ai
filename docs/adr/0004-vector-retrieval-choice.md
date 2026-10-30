# ADR 0004: SearchProvider abstraction; lexical locally, Azure AI Search in Azure, pgvector deferred

- Status: Accepted
- Date: 2026-10-29
- Deciders: project owner and architect

## Context

Analysis needs to find relevant evidence, events and knowledge-pack content. Retrieval must be tenant- and
case-scoped by construction (AI-4), deterministic enough to test, runnable with no cloud dependency, and cheap.
The corpus today is a few synthetic cases and one authored knowledge pack. Embedding-based retrieval adds a
model dependency, cost, nondeterminism and a harder temporal-integrity story (every candidate must also be
filtered to what was known at the decision time).

## Decision

- Route all search through one **`SearchService`** (`apps/api/src/services/search`); `SEARCH_PROVIDER` selects the
  engine and callers never see which one answered.
- **Local and test default: PostgreSQL full-text search** (`search_tsv` generated columns with GIN indexes,
  `websearch_to_tsquery` and `ts_rank`; see [DATA_MODEL.md](../DATA_MODEL.md)), tenant-scoped by row-level security
  (`SEARCH_PROVIDER=lexical`). It is not BM25 and not in-process.
- **Azure: Azure AI Search** (`SEARCH_PROVIDER=azure-ai-search`), authenticated with managed identity, with a
  `tenantId` filter added to every query. The index is tried first with a 3 s deadline and any failure falls back
  to the lexical search. Creating and populating the index is an operator step, not part of the Bicep deployment
  and not implemented in this repository.
- **pgvector is deliberately deferred.** It would couple retrieval to an embedding model and to database
  extensions on managed PostgreSQL before there is evidence that lexical recall is insufficient.

## Consequences

- Good: zero-dependency local runs and reproducible tests; the cloud path can be swapped or added without
  touching analysis code; no embedding cost or model drift.
- Bad: lexical search misses paraphrases; quality on large, real corpora is unproven. The Azure AI Search
  provider has not been exercised against a live service from this repository, and results from the two
  engines will differ.
- Scope today: only global search (`GET /api/v1/search`, `search.global`) goes through the provider. The analysis
  engine and the AI context builder read the case's temporally filtered evidence directly and do no retrieval, so
  the temporal and case-scoping guarantees do not depend on the search engine.
- Follow-up: measure recall on realistic data before adding vectors; if added, keep the same interface and
  filter by tenant, case and as-of time before ranking.

## Alternatives considered

- **pgvector now:** one database, but needs an embedding pipeline, extension availability on the managed server
  and a temporal-filtering design; no measured need yet.
- **Azure AI Search only:** forces a cloud dependency on every local run and test.
- **A hosted vector database:** another data store holding tenant content to secure and audit.
- **No abstraction:** would leak engine details into the analysis code.
