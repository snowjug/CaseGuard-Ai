# CaseGuard AI — Implementation Plan

> Status: living document. Last updated 2026-10-29. Track: **C+AI Hack for Quality**.
> All demo data in this repository is **synthetic**. Nothing here is a Microsoft product.

## 1. Goal

Build a complete, locally runnable, Azure-deployable platform that:

1. reconstructs a technical-support case as a **digital twin** with source-mapped fields,
2. separates facts, reports, assumptions, diagnostics, inferences, simulated outcomes and gaps in an **evidence ledger**,
3. keeps **competing hypotheses** alive with explainable, time-indexed confidence,
4. detects **decision forks** and simulates safer, shorter **counterfactual** paths under strict **temporal integrity**,
5. scores quality (**Case Quality Index**) and estimates **Avoidable Support Effort** with visible uncertainty,
6. extracts governed, versioned, reusable **SkillDNA**, and reuses it on a second case.

Non-goals: a generic chatbot, auto-closing cases, employee ranking, treating AI inference as fact.

## 2. Environment findings (inspected 2026-10-29)

| Item | Finding | Consequence |
| --- | --- | --- |
| Node / npm | Node 24.x, npm 12.x | ESM-first TypeScript, Node 24 runtime target |
| pnpm | Not preinstalled | Installed v10.34.7 from the corporate feed tarball |
| Registry | `registry.npmjs.org` unreachable; Microsoft package-feed proxy works | `pnpm-lock.yaml` is checked for feed-specific tarball URLs before commit |
| Docker | CLI present, **daemon not running** | Container build / Compose validation is attempted only if the daemon can be started; otherwise reported as *not run* |
| Azure CLI / Bicep | az 2.91, Bicep 0.48 present; az is signed in to a corporate subscription | Bicep is built/linted locally only. **No deployment, What-If or validate call is made against the subscription without explicit approval** |
| GitHub | `gh` authenticated as the repository owner; remote repository is **empty** (no default branch) | Work happens on `feat/caseguard-ai-platform`; creating a base branch for a PR needs explicit approval |
| Browsers | Playwright browsers not installed; Microsoft Edge available | E2E uses `channel: msedge` locally and Chromium in CI |
| Git identity | Not configured globally | Repo-local identity set from the owner's GitHub profile |

## 3. Architecture decisions (summary — details in `docs/adr/`)

| Area | Decision |
| --- | --- |
| Repo | pnpm workspaces monorepo, *just-in-time* TypeScript packages (no per-package build step); Turborepo not adopted |
| Backend | TypeScript + Fastify modular monolith with Zod-first contracts and generated OpenAPI |
| Frontend | Next.js (App Router) + Fluent UI React Components v9; custom accessible SVG investigation graph and charts |
| Data | PostgreSQL; **PGlite** (in-process Postgres) for zero-dependency local dev and tests; hybrid relational + JSONB schema; composite `(tenant_id, id)` keys and row-level security |
| Retrieval | `SearchProvider` abstraction — in-memory lexical (BM25) locally, Azure AI Search in Azure; pgvector deliberately deferred |
| AI | `ModelProvider` abstraction — deterministic knowledge-pack provider (default) and Azure OpenAI provider. *LLM proposes, code disposes*: all probabilistic math, safety policy and citation checks run in deterministic code |
| Temporal integrity | Analysis functions accept only a branded `TemporalView` produced by a single gatekeeper; metamorphic tests prove future mutation cannot change earlier output |
| Audit | Append-only, hash-chained audit events with a verification endpoint |
| Identity | Microsoft Entra ID (JWT validation) in Azure; development persona mode is hard-blocked in production |
| Hosting | Azure Container Apps (scale-to-zero) + ACR + PostgreSQL Flexible Server + Key Vault + Storage + AI Search + App Insights; Bicep |

## 4. Phases and exit criteria

| # | Phase | Exit criteria |
| --- | --- | --- |
| 1 | Foundation | Monorepo installs, `typecheck`/`lint`/`test` scripts run, design tokens + schemas compile |
| 2 | Core domain | Migrations apply from empty state; tenant isolation proven by tests |
| 3 | Ingestion + twin | Paste/upload/sample ingestion with validation, redaction, injection detection, immutable source records |
| 4 | AI orchestration | Deterministic and Azure providers behind one interface; schema + citation + policy validation; telemetry |
| 5 | Analysis engine | Ledger, hypotheses, forks, action value, counterfactuals, temporal tests, quality index, ASE |
| 6 | SkillDNA | Extraction, lifecycle, approvals with optimistic locking, diff, mutation, rollback, case-two matching |
| 7 | Premium UI | All 12 destinations functional, graph, presentation mode, dark/light, responsive, accessible |
| 8 | Security + ops | RBAC, audit, rate limits, headers, health/readiness, runbooks |
| 9 | Azure + CI/CD | Bicep builds and lints; workflows; OIDC docs; deployment helper scripts (not executed) |
| 10 | Testing + hardening | Unit, integration, E2E, a11y, security, AI-eval, perf; dependency audit; secret scan |
| 11 | Docs + polish | README with real screenshots, diagrams, demo script, honest limitations |

## 5. Quality gates (all must pass before any push)

`pnpm format:check` · `pnpm lint` · `pnpm typecheck` · `pnpm test` (unit + integration) · `pnpm build` · `pnpm test:e2e` (incl. axe checks) · `pnpm audit:deps` · `pnpm secrets:scan` · `pnpm infra:validate` · container build (if Docker is available) · `pnpm demo:reset && pnpm demo:seed` replay.

Anything that cannot be executed in this environment is reported as **not run** with the reason — never as passed.

## 6. Risk register

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Deterministic provider is rule-based and only strong on bundled knowledge packs | Limited accuracy on unseen free text | Documented limitation; Azure provider path with the same schemas and validators; evaluation harness reports measured rates |
| Azure OpenAI path cannot be exercised live | Integration risk | Contract tests against a local mock of the REST API; UI and docs state "not validated against a live deployment" |
| PGlite differs from managed PostgreSQL | Dialect drift | Only portable SQL; CI job runs the integration suite against a real PostgreSQL service |
| Scope is very large | Incomplete features | Contract-first (Zod) so work parallelises; vertical-slice E2E gates the demo path first |
| Accessibility regressions | WCAG gaps | Fluent primitives, axe in E2E, documented manual checklist |
| Counterfactual temporal leakage | Invalid analysis | Single gatekeeper + metamorphic/property tests + leak-check recorded on every scenario |
