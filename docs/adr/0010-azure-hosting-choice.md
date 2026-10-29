# ADR 0010: Azure Container Apps with Bicep, scaled to zero

- Status: Accepted
- Date: 2026-10-29
- Deciders: project owner and architect

## Context

The target runtime is Azure. The workload is two small stateless containers plus a one-shot migration job, with
spiky, low average traffic and a hackathon budget (NFR-COST-01). The platform must support managed identity,
Key Vault references, private networking when needed, safe rollbacks, and Infrastructure as Code that can be
validated without a subscription (NFR-AZ-01).

## Decision

- **Azure Container Apps** for the web app, the API and the migration job (a Container Apps job started by the
  pipeline), in an environment with Log Analytics. Replicas scale to zero in dev (`minReplicas = 0`); the API and
  web use multiple-revision mode so a previous revision can take traffic back.
- Supporting services: Azure Container Registry (images built with `az acr build`), PostgreSQL Flexible Server,
  Key Vault, Storage, optional AI Search and Azure OpenAI, Application Insights, one user-assigned managed
  identity for the apps (AcrPull, Key Vault Secrets User, Storage Blob Data Contributor and so on). No
  long-lived credentials are used; the pipeline authenticates with GitHub OIDC (docs/CI_CD.md).
- **Bicep** (not Terraform), at subscription scope, in two stages: infrastructure first, then the apps once the
  registry holds the images. Templates are built and linted in CI (`pnpm infra:validate`) without touching Azure;
  What-If is a separate, human-initiated step.
- **Honesty:** these templates have been built and linted but never deployed to a live subscription from this
  repository (A-01); `docs/DEPLOYMENT.md` lists what has and has not been validated.

## Consequences

- Good: no cluster to run, per-request billing and scale to zero, built-in revisions, ingress and managed
  identity; Bicep has first-class Azure coverage and no state file to protect.
- Bad: cold starts after idle; fewer knobs than Kubernetes; Bicep ties the IaC to Azure.
- Bad: rollback restores application images only; database migrations are forward-only and must stay backward
  compatible.

## Alternatives considered

- **App Service for Containers:** simpler for one app, but weaker job, revision and scale-to-zero support.
- **AKS:** maximum control at the price of cluster operations and cost that this workload does not justify.
- **Azure Functions:** poor fit for a long-lived Fastify server and its connection pool.
- **Terraform:** a fine tool and cloud-neutral, but it adds a state backend and a second ecosystem; the target is
  Azure only.
