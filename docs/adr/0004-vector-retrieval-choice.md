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

- Define a **`SearchProvider`** interface; callers never know which engine is behind it.
- **Local and test default: in-process lexical search (BM25)** over the already tenant- and case-scoped evidence
  set (`SEARCH_PROVIDER=lexical`).
- **Azure: Azure AI Search** (`SEARCH_PROVIDER=azure-ai-search`), authenticated with managed identity, with
  tenant filters added to every query. Creating the index is a documented operator step, not part of the Bicep
  deployment.
- **pgvector is deliberately deferred.** It would couple retrieval to an embedding model and to database
  extensions on managed PostgreSQL before there is evidence that lexical recall is insufficient.

## Consequences

- Good: zero-dependency local runs and reproducible tests; the cloud path can be swapped or added without
  touching analysis code; no embedding cost or model drift.
- Bad: lexical search misses paraphrases; quality on large, real corpora is unproven. The Azure AI Search
  provider has not been exercised against a live service from this repository, and results from the two
  engines will differ.
- Follow-up: measure recall on realistic data before adding vectors; if added, keep the same interface and
  filter by tenant, case and as-of time before ranking.

## Alternatives considered

- **pgvector now:** one database, but needs an embedding pipeline, extension availability on the managed server
  and a temporal-filtering design; no measured need yet.
- **Azure AI Search only:** forces a cloud dependency on every local run and test.
- **A hosted vector database:** another data store holding tenant content to secure and audit.
- **No abstraction:** would leak engine details into the analysis code.
