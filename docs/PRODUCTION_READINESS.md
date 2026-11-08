# Production-readiness preparation (controlled pilot)

> **Nothing is deployed and no Azure resource was created.** This document prepares a decision. It says what a later
> **controlled pilot** needs, what is already in the repository, what has only ever run locally or in CI, and what only the owner
> can decide or provide. [DEPLOYMENT.md](DEPLOYMENT.md) is the step-by-step guide and [COST_GUIDE.md](COST_GUIDE.md) the method for
> prices; this page does not repeat them, it puts them in the order of a pilot and adds what wave 2 changed.

## 1. What this assumes a controlled pilot is

These are assumptions made so that the rest can be concrete. The owner may change any of them; each change moves something below.

| Assumption                                                          | Why it matters                                                                                                                                           |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One tenant, a few named users (about ten), Microsoft Entra sign-in  | Multi-tenant provisioning and shared limiters are not built (R-8, R-9)                                                                                   |
| **Synthetic or consented cases only**                               | The template fixes `dataClassification` to `synthetic-demo`; real customer data needs the threat model re-run first ([THREAT_MODEL.md](THREAT_MODEL.md)) |
| Cases of up to **300 events**, and up to 1,000 with a looser target | The size the pilot performance target covers (section 13); the guided review reads at most 1,000 (PL-13)                                                 |
| The **deterministic path** is the verified path; the model path off | No real model has been evaluated (section 8)                                                                                                             |
| One workload (Microsoft Teams authentication), no connectors        | The scope is frozen                                                                                                                                      |
| **One API replica**                                                 | Rate limits and caches are per process (A-13, R-8); more replicas change the limits                                                                      |

## 2. The Azure resources a pilot needs

From `infra/bicep` (module in brackets). The production template is `main.prod.bicepparam.template`; its values are starting points,
not recommendations.

| Resource                                       | What for                                                           | Pilot setting or decision                                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Resource group, tags (`owner`, `costCenter`)   | Ownership and cost reporting                                       | Owner names the team alias and cost centre                                                                                   |
| Container Apps environment, **web** (external) | The product's front end, proxying `/api` to the API                | 0.5 vCPU, 1 GiB, 1 replica always on [containerapps]                                                                         |
| Container App **api** (internal ingress)       | The API and the in-process analysis and jobs                       | 1 vCPU, 2 GiB, **max 1 replica** for the pilot (A-13) [containerapps]                                                        |
| Container Apps job **migrate**                 | Schema migrations and tenant provisioning, started by the pipeline | Manual trigger; timeout above the slowest migration                                                                          |
| Azure Container Registry                       | The two images, built from an immutable tag                        | Standard [acr]                                                                                                               |
| PostgreSQL Flexible Server                     | The database, with forced row-level security                       | Version 16, Entra-only authentication, section 5 [postgres]                                                                  |
| Storage account, container `cases`             | Uploaded and stored case payloads, tenant-prefixed keys            | Zone-redundant; section 6 [storage]                                                                                          |
| Key Vault                                      | Every secret, as references                                        | Soft delete 90 days, purge protection on [keyvault]                                                                          |
| Log Analytics and Application Insights         | Logs, traces, metrics, alerts                                      | Retention 90 days, sampling 0.2 [monitoring], section 9                                                                      |
| Virtual network, private endpoints             | Data services without public access                                | On in the template; operators then need a network path (VPN, jump host) [network, private-endpoint]                          |
| Budget and metric alerts                       | Spend and failure notification                                     | Set the budget to your threshold; alerts on [budget, alerts]                                                                 |
| Azure AI Search                                | Optional lexical provider only                                     | **`deploySearch = false`** for the pilot: semantic and vector search are out of scope, so nothing uses it [search]           |
| Azure OpenAI or Foundry deployment             | Optional model path                                                | Off until section 8 is satisfied; prefer an **existing** account (`existingOpenAiResourceId`) [openai, rbac-openai-existing] |
| Redis                                          | Not used by the application                                        | `deployRedis = false` [redis]                                                                                                |

## 3. Microsoft Entra

Everything is in [ENTRA_ID_SETUP.md](ENTRA_ID_SETUP.md). What a pilot needs from the owner, none of which has been done:

- An **API app registration** and a **SPA app registration**, the app roles that map to the personas, and the user and group assignments.
- The `entraTenantMap` that maps the Entra tenant to the CaseGuard tenant, and operators in a **security group** for the database administrator
  role (`postgresAdditionalEntraAdmins`).
- A **GitHub OIDC federated credential** bound to the `production` environment, with a read-only one for What-If. No stored secret.
- Sign-in, token validation, role mapping and just-in-time provisioning exercised against a **real tenant** (R-3). Today they are unit-tested with
  locally generated keys only.

## 4. Managed identity

One user-assigned managed identity serves the apps and the migration job: AcrPull, Key Vault Secrets User, Storage Blob Data
Contributor (on the `cases` container only), and, if the model path is switched on, Cognitive Services OpenAI User. Search Index Data
Contributor is only needed if search is deployed. No key, connection string or password is stored anywhere: the database uses the identity as its
Entra administrator. Role-assignment propagation timing has never been observed and is a first-deployment check.

## 5. PostgreSQL

- **PostgreSQL 16**, general-purpose SKU, zone-redundant high availability (the template notes that this roughly doubles compute cost; choose
  deliberately), storage 128 GB, **backup retention 14 days**, no geo-redundancy by default.
- **Forced row-level security** and the owner/application role split are verified in CI on a `postgres:16` container (1,033 integration tests in the
  last wave-1 run). **They have not been verified on a managed server**, nor TLS, nor Entra authentication to PostgreSQL; the first deployment must do
  this before any case is stored (DEPLOYMENT.md section 1).
- Migrations run only through the job. The connection pool size times the replica count must stay under the server's connection limit.
- A tenant's data volume at pilot scale is small (tens of cases of at most 1,000 events each); storage size is not the constraint, backups
  and high availability are the cost.

## 6. Storage

Tenant-scoped object keys, a private container, soft delete 14 days and cool tier after 30 days are set in the template; **`blobDeleteAfterDays`
is 0** (no lifecycle deletion rule), so stored payloads are not removed when a retention window ends (R-12). Uploaded files are **not scanned for
malware**: the scanner is a stub (R-13). If the pilot accepts real files, real scanning is a gate; if it accepts only the built-in samples and JSON the
owner has reviewed, state that restriction.

## 7. Secrets and configuration

Secrets live only in Key Vault and reach containers as references; template outputs never contain secrets. `demoMode` and `demoAutoSeed` are off in
production and `APP_ENV=production` is checked in the running revision. The configuration guards (unsafe `TRUST_CLIENT_IP_HEADER` and similar
combinations, R-14) must be reviewed against the real environment. Model configuration (`aiCostLimitUsdPerDay`, unit prices) is left empty unless
the owner enters prices, in which case cost is reported as unknown.

## 8. The model path

The deterministic provider is the verified path. **No real model has been evaluated**: no Azure OpenAI or Foundry credentials were available in
wave 1 or wave 2, so every real-model check is marked NOT RUN ([EVALUATION.md](EVALUATION.md)). Before the model path is enabled for a pilot:

1. The owner supplies an Azure OpenAI or Foundry deployment (name, API version, region, quota) and its role assignment; keys are never used.
2. The evaluation harness and the adversarial and prompt-injection corpora run against it, measuring the model schema-valid rate, the grounded-claim
   and unsupported-claim rates, the critic's catch rate, fallback behaviour, latency and cost.
3. The per-case and per-operation token ceilings, the timeout, the retry and concurrency limits and the cache isolation between tenants
   ([AI_ORCHESTRATION.md](AI_ORCHESTRATION.md)) are set from those measurements, with a daily cost limit.
4. A reviewer decides what a model-proposed finding may do. A model never approves its own high-impact conclusion, and a proposal that
   fails validation is dropped and counted, never shown as a finding.

## 9. Monitoring

What to watch is in [OBSERVABILITY.md](OBSERVABILITY.md); the metric alerts are in `alerts.bicep`. For a pilot, at least: server errors, response time
(the template's alert threshold is 2,000 ms), failed or timed-out jobs, database connection use, **token spend and model fallback count** if the
model path is on, and **audit-chain verification**. The telemetry export is implemented but has **never been observed in Azure** (R-6): the first
deployment verifies the log table and column names and the alert dimensions. HTTP ingress logs contain client addresses and are off until a
privacy review.

## 10. Retention and deletion

The retention windows (case data 365 days, audit 730, model executions 90, analytics 365, legal hold off) are **stored settings that nothing
enforces** (R-12). Erasure of one case works and is tested (including the skills derived from it); the scheduled sweep does not exist. The owner
chooses: a written manual procedure with a named person and a cadence for the pilot, or the enforcement job as a gate.

## 11. Reading a case: audited or not (decision needed)

Changes, and reads of the audit log and the user list, are audited today. Reading the guided review, resolving a citation, reading a skill overlay and
exporting a report are **not** (PL-15, R-25). The decision must be written down before real data is used.

| Option                                                  | Consequence                                                                                                                                  |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Audit case reads and report exports, ids only           | Answers "who looked at this case"; needs a server record for exports composed in the browser; adds audit volume; no case text is ever logged |
| Audit only the sensitive reads (citations, exports)     | Smaller volume, a partial answer                                                                                                             |
| Do not audit reads (acceptable for synthetic data only) | No privacy answer for a reviewer; not acceptable once real or consented data is in the system                                                |

## 12. Backup, restore and rollback

- **Backup:** PostgreSQL automatic backups with point-in-time restore (14 days in the template), blob soft delete (14 days), Key Vault soft delete and
  purge protection. **A restore has never been tried** (R-11). The gate is a drill: restore into a scratch server, run the migrations check, and verify the
  audit hash chain over the restored data.
- **Rollback:** releases deploy an immutable image tag (`latest` is rejected in production), so rolling back is deploying the previous tag
  ([runbooks/rollback-procedure.md](runbooks/rollback-procedure.md)). A migration is the part that does not roll back by itself: record the time
  before the migration job starts, because point-in-time restore is the recovery path ([runbooks/broken-migration.md](runbooks/broken-migration.md)).
- **Other runbooks** for the first weeks: failed deployment, database unavailable, AI provider unavailable, excessive token use, suspected prompt
  injection and secret exposure (`docs/runbooks`). None has been rehearsed.

<a id="pilot-performance-target"></a>

## 13. Pilot performance target

Proposed for the pilot and for the owner to confirm: nothing here is a service-level objective, and it **has not been measured on the target SKU**.
The figures are from a shared 4-vCPU development VM, re-measured on the final Wave 2 pack at a load average of about 5 (the first measurement, at about 9, gave the same CPU time and a longer
wall time), so they are neither best case nor worst case: treat them as an order of
magnitude ([PERFORMANCE_ENGINE.md](PERFORMANCE_ENGINE.md), `pnpm bench:engine`; the API figures come from `pnpm bench:api`). An analysis runs inside the
API process without yielding between the parts of a stage, so **the longest stage is the longest pause of every other request and the longest wait for a
cancellation**.

**How the targets were set, and what that does and does not show.** The first draft asked for no stage longer than 3 s at 1,000 events; the final
measurement gave 3.9 s, so that target was **not met** and was not relabelled (the re-measurement on the final pack gave 2.1 s; the targets were not changed to fit). The targets below are in two tiers and say what an operator can tolerate: a
pause of other users of about a second or two for an ordinary case, and of several seconds only for a rare large one. The two tiers were chosen after
looking at the numbers, so they show that the pilot is workable inside them, not that the engine is fast.

| Measure                                                              | Proposed target                         | Measured on the development VM                                                                                       | Reading                                                                                        |
| -------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Whole deterministic analysis, **up to 300 events**                   | at most 5 s; no stage longer than 1.5 s | 1.7 s (1.7 s of CPU); longest stage 0.7 s                                                                            | Met                                                                                            |
| Whole deterministic analysis, **301 to 1,000 events** (looser, rare) | at most 15 s; no stage longer than 5 s  | 4.3 s median, 4.5 s slowest (4.3 s of CPU); longest stage 2.1 s                                                      | Met, with the margin the load makes small                                                      |
| **More than 1,000 events**                                           | not in the pilot                        | 2,000 events (the ingestion limit): 9.7 s median (9.7 s of CPU); longest stage 5.2 s, the warning replay about 2.6 s | Outside the target: one such case holds the API for many seconds                               |
| Reading a case page (timeline, evidence, quality), p95               | at most 1 s each                        | 38, 24 and 12 ms (20 samples)                                                                                        | Met                                                                                            |
| Creating a case (analysis not started), p95                          | at most 1 s                             | about 41 ms for a 15-event bundle (20 samples)                                                                       | Met                                                                                            |
| Counterfactual job                                                   | at most 10 s                            | about 23 ms median, 0.5 s slowest (20 samples)                                                                       | Met                                                                                            |
| Memory of the API process                                            | under 1 GiB through 1,000 events        | about 460 MB resident and a heap of about 230 MB at 1,000 events (benchmark process)                                 | Met in the benchmark process; not measured in a container                                      |
| Full guided-review and report latency in a browser                   | to be set after a measurement           | **not measured**                                                                                                     | Composed in the browser from the reads above; the on-demand Playwright render spec was not run |
| Model-assisted latency                                               | to be set after a real-model evaluation | **not measured** (no credentials)                                                                                    | A scripted provider measures only the orchestration, never a model                             |

A bottleneck blocks the target only if a case in scope misses a row. None does, so **nothing was optimised**: the growth above 300 events (the analysis
and the warning replay cost more than their share of the size) is recorded, not fixed. If the owner wants the 1,000-event tier to be comfortable, or
cases beyond it, lower the ingestion limit from 2,000 to the tier the pilot accepts, or fix those two stages first ([KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md), OP-1 and OP-3).

## 14. Estimated cost

This repository deliberately states no prices ([COST_GUIDE.md](COST_GUIDE.md)), and none is stated here: a figure would depend on the region, the date, the
agreement and the SKUs the owner chooses. What can be said without a price:

- **The fixed infrastructure is the cost.** The database (with high availability), the always-on web and API replicas, the private endpoints and the log
  ingestion do not depend on how many cases are analysed. The Bicep notes that zone-redundant high availability roughly doubles the database's compute.
- **The engine is not a cost driver.** A deterministic analysis of a typical case costs about one to two seconds of one core. Fifty cases a day is a few
  minutes of CPU a day on a replica that is already running.
- **The model path is the only variable cost,** and it is **not measured**: token use per case with a real model is unknown (NOT RUN). It is bounded by
  the per-case and per-operation ceilings and a daily cost limit; with no prices entered, the cost shows as unknown rather than zero.
- **Levers:** `deploySearch = false` (nothing uses it in the pilot), `deployRedis = false`, the log sampling ratio and daily cap, `containerAppsHttpLogs`
  off, HA off in a non-production stage, and a monthly **budget with alerts** (the template creates one; its amount is a threshold, not an estimate).

To turn this into a figure: list the resources of the What-If output with their SKUs, look the meters up in the Retail Prices API for the chosen region,
and multiply by hours, gigabytes ingested and tokens as the cost guide's table shows.

## 15. Deployment gates

In this order. **Status is as of the end of wave 2**; "not run" means nothing in this repository can run it without the owner's subscription or
credentials.

| Gate                                                                                               | Status                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The default branch is green and the work is merged after owner review (R-1)                        | Partly: the work reached `main` on 8 November 2026 at the owner's request, without a pull request into `main`; no CI run is recorded on `main` itself                                            |
| What-If reviewed against the production subscription                                               | Not run                                                                                                                                                                                          |
| The release commit has a green CI run                                                              | Run on each branch head; read the last run                                                                                                                                                       |
| PostgreSQL 16 integration suite, **and row-level-security parity on the managed server**           | CI container: run. Managed server: not run                                                                                                                                                       |
| Entra sign-in, token validation, role mapping on a real tenant (R-3)                               | Not run                                                                                                                                                                                          |
| Backup and restore drill, with the audit chain verified after (R-11)                               | Not run                                                                                                                                                                                          |
| Retention: an enforcement job, or a written manual procedure (R-12)                                | Decision needed                                                                                                                                                                                  |
| Audit-on-read decision (R-25)                                                                      | Decision needed                                                                                                                                                                                  |
| Analytic quality targets met on the held-out evaluation sets ([EVALUATION.md](EVALUATION.md))      | **Not met.** Wave 2 verdict: ANALYTICAL QUALITY NOT READY ([EVALUATION.md](EVALUATION.md#106-the-locked-test-split-and-the-verdict)); the labels are AI-drafted and unreviewed by a human expert |
| A real-model evaluation, **if** the model path is to be enabled (R-4)                              | NOT RUN: no credentials                                                                                                                                                                          |
| Performance measured on the target SKU against section 13                                          | Not run: measured only on a shared development VM                                                                                                                                                |
| A security review of the release; the time-boxed `@azure/msal-node` exception resolved or accepted | Automated reviews are reported with each wave; not a penetration test or a human audit; the exception is the owner's decision                                                                    |
| Threat model re-run **if** real or consented data will be stored (`dataClassification`)            | Not done                                                                                                                                                                                         |
| The runbooks rehearsed once                                                                        | Not run                                                                                                                                                                                          |
| A licence chosen                                                                                   | The repository is unlicensed; the owner's decision                                                                                                                                               |

## 16. What only the owner can do or decide

Provide the subscription, the Entra tenant, quota, model access and credentials; run What-If and approve the first deployment; choose the licence,
the production approvers, the budget and the retention and audit-on-read policies; accept or replace the `@azure/msal-node` exception; confirm the
pilot assumptions in section 1 and the targets in section 13; supply consented data and independent annotators for the evaluation; and enable
CodeQL on the default branch. The same list, with the roadmap numbers, is in [ROADMAP.md](ROADMAP.md).
