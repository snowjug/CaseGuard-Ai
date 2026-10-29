# ADR 0002: Modular monolith instead of microservices

- Status: Accepted
- Date: 2026-10-29
- Deciders: project owner and architect

## Context

The system reconstructs a case timeline, runs deterministic analysis, optionally calls a model, persists
reviewable results and serves a UI. Workloads are bounded (one case at a time, seconds to minutes), the team is
small, the budget is cost-conscious (NFR-COST-01) and the demo must run locally with one command (NFR-DX-01).
Tenant isolation and audit need transactional consistency across ingestion, analysis and review.

## Decision

Build **one Fastify API process** whose business logic lives in workspace packages with a one-way dependency
direction: `schemas` at the bottom, then `security` and `config`, then `domain` and `observability`, then `ai`,
then `apps/api`. pnpm's strict `node_modules` layout turns an undeclared upward import into a build error.
Analysis logic lives in pure, injectable packages; the API adds HTTP, persistence, auth and orchestration. The
web app is a separate deployable. Background work uses an **in-process job runner** (assumption A-12); there is
no queue. Operationally there are three units: web, API and a one-shot migration job.

## Consequences

- Good: one transaction boundary for ingest, analysis, audit and RBAC; trivial local run and debugging; fewer
  network failure modes; cheap to host (scale to zero).
- Good: the pure `domain` and provider interfaces (`ModelProvider`, `SearchProvider`, storage) are seams along
  which a service could be extracted later.
- Bad: one process shares CPU and memory, so a heavy analysis can delay requests; rate limiting and caches are
  per replica (A-13); horizontal scale beyond a few replicas needs a queue and shared limits.
- Bad: package boundaries are enforced by manifests, but the module boundaries inside `apps/api` are a
  convention that needs review discipline.

## Alternatives considered

- **Microservices (ingestion, analysis, skills, governance):** independent scaling and deployment, but
  distributed transactions, per-service auth and observability, and far more infrastructure than the problem
  needs.
- **Serverless functions per route:** cold starts and awkward long-running analysis; harder to run locally.
- **Event-driven pipeline with a queue:** right answer for large volumes; deferred until measurements show the
  in-process runner is a bottleneck.

## Notes

Reconsider when a single case analysis regularly exceeds the request timeout, or when one module needs a
different scaling profile or release cadence from the rest.
