# System status (`system.health`, `system.metrics`, `system.provider`)

All three routes need `telemetry:read`. They describe the process and its integrations, never tenant
content, and never contain a key, a connection string, an object-store path or an error stack.

## `system.health`

Dependency checks come from the health registry (`infra.health.systemHealth`), migrations from
`infra.repos.migrationStatus()` and the AI provider from the AI service (`ctx.services.ai.health`), whose
runtime state replaces the registry's own model-provider row. The answer is always a 200: when the database
cannot be queried the migration counters are zero with a notice and the database row says `unhealthy`; when
the AI service cannot initialise the provider is reported `healthy: false`.

Honesty rules (`dependencies.ts`, `notices.ts`):

- In-process stand-ins are labelled `simulated: true`: the local object store, built-in lexical search, the
  deterministic provider, the memory cache, development sign-in and, when `DATABASE_URL` is `pglite://...`,
  the database itself (PGlite is an in-process PostgreSQL-compatible engine, not the PostgreSQL service a
  deployment uses).
- A configured integration that is not probed here (Azure AI Search, Microsoft Entra ID) is `unknown`, never
  `healthy`. Azure OpenAI is `healthy` only after a call has succeeded.
- `notices` state what each integration actually is and how far it has been validated: Azure OpenAI, Azure AI
  Search, Azure Blob Storage and Entra sign-in are implemented and validated against mocks or locally
  generated keys only; the PostgreSQL path has not been exercised by the automated tests (they use PGlite).

## `system.metrics`

`buildRequestMetrics(infra.metricsRegistry, { since })` with `since` set when the routes are built (process
start). The counters are in memory, per instance, and reset on restart.

## `system.provider`

The AI service's status (`ctx.services.ai.status`) plus the configuration facts that a runtime status does
not carry: the deterministic engine is `simulated`, in-process, with no network call and no model; Azure
OpenAI reports the endpoint host, the deployment name and the authentication mode, the effective limits
(the governed `model` settings tightened by the `AI_*` environment limits) and the validation note
"implemented, validated against mocks only". If the AI service cannot report, the answer is derived from the
configuration with `healthy: false`.
