# CI/CD

How the repository is built, checked, scanned and (optionally) deployed. Everything here was written without being able to run it on GitHub or Azure, so [section 9](#9-what-was-and-was-not-validated) says exactly what was and was not validated.

## 1. Overview

| File                                                    | Trigger                                                                        | Purpose                                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`                              | pull request, push to any branch except `main`, manual, called by `deploy.yml` | Every quality gate, then a merged `verification-report` artifact and a single **CI gate** job |
| `.github/workflows/codeql.yml`                          | push and pull request on `main`, weekly, manual                                | CodeQL analysis of the TypeScript/JavaScript code                                             |
| `.github/workflows/dependency-review.yml`               | pull request                                                                   | Blocks new or bumped dependencies with a known HIGH/CRITICAL vulnerability                    |
| `.github/workflows/deploy.yml`                          | manual, or version tag when opted in                                           | Entry point for Azure deployment; **inert** until configured (section 6)                      |
| `.github/workflows/deploy-environment.yml`              | called by `deploy.yml`                                                         | Deploys or previews one environment with OIDC                                                 |
| `.github/actions/setup`, `.github/actions/bicep-deploy` | used by the workflows                                                          | pnpm + Node + frozen install; `az deployment sub what-if` or `create`                         |
| `.github/dependabot.yml`                                | weekly                                                                         | Version updates for npm, GitHub Actions, Docker and Compose                                   |

Conventions: every workflow starts from `permissions: contents: read` and widens per job only where needed; checkouts use `persist-credentials: false`; actions are pinned to a **major version tag**; no long-lived cloud credential exists anywhere.

Renovate is not used because Dependabot is built into GitHub, needs no extra app or token, and covers every ecosystem used here (pnpm/npm, GitHub Actions, Docker, Compose).

## 2. CI (`ci.yml`)

Jobs run in parallel; each uses `scripts/verify.mjs --only <step>` so the local loop and CI share one runner and one honest status model (PASSED only for exit code 0, NOT RUN for exit code 3, otherwise FAILED).

| Job (check name)                                  | Steps (verify ids)                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Format, lint, typecheck, unit tests               | `format:check`, `lint`, `typecheck`, `generated:check` (the exported JSON schemas, the embedded sample data and the route reference in `docs/API.md` are current), `docs:check` (relative links and heading anchors, Mermaid fences, workflow badges and screenshots resolve; `scripts/check-docs.mjs`), `test:unit` (later steps still run after an earlier failure) |
| Integration tests (PostgreSQL 16) and demo replay | `test:int` against a `postgres:16` service container (`TEST_DATABASE_URL`), then `demo:replay`                                                                                                                                                                                                                                                                        |
| Production build                                  | `build`                                                                                                                                                                                                                                                                                                                                                               |
| End-to-end and accessibility (Playwright, axe)    | `build`, `pnpm exec playwright install --with-deps chromium`, `test:e2e`; uploads the report on failure                                                                                                                                                                                                                                                               |
| Secret scan and dependency audit                  | `secrets:scan`, gitleaks (full history, `.gitleaks.toml`), `audit:deps`                                                                                                                                                                                                                                                                                               |
| Bicep validate                                    | installs the Bicep CLI (`az bicep install`), then `infra:validate`                                                                                                                                                                                                                                                                                                    |
| Container images and compose smoke test           | `docker/build-push-action` with `push: false` for both images, `docker compose up --wait`, `scripts/smoke-test.mjs`                                                                                                                                                                                                                                                   |
| CI gate                                           | merges every job's report into the `verification-report` artifact and fails unless all jobs succeeded                                                                                                                                                                                                                                                                 |

- **Artifacts:** `verify-<job>` (per-step JSON), `playwright-report` (on failure), and `verification-report` (`.json` and `.md`, also appended to the run summary). In the merged report a step with no report is `NOT RUN`, never passed; the container job is mapped from its job conclusion.
- **Nothing is pushed.** CI builds images and loads them locally for the smoke test; it never publishes an image or a package.
- **Run locally:** any step with `pnpm verify --only lint,typecheck`; the full loop with `pnpm verify`.

## 3. Security workflows and scanning

- **Secret scanning, three layers:** the `pre-commit` hook runs `scripts/scan-secrets.mjs --staged`; CI runs the same scanner on the tree and gitleaks (pinned version, `.gitleaks.toml`) over the history; GitHub push protection blocks known token formats when enabled (section 7). The repository scanner supports line and path allowances that require a justification (`CONTRIBUTING.md`). gitleaks-action needs a `GITLEAKS_LICENSE` secret only for organisation-owned repositories.
- **CodeQL** (`security-extended` queries, `build-mode: none`) runs on `main` and weekly. It is free for public repositories; private repositories need GitHub Code Security.
- **Dependency review** blocks pull requests that introduce HIGH/CRITICAL runtime dependencies. It needs the dependency graph.
- **Dependency audit** (`pnpm audit:deps`): lockfile hygiene (no private feed URLs, no foreign tarballs) and a vulnerability gate. It uses `pnpm audit --prod` and falls back to OSV (`api.osv.dev`) when the registry has no audit endpoint; with neither reachable it exits 3 and is reported as NOT RUN, which CI treats as a failure. Time-boxed exceptions live in `docs/dependency-exceptions.json` (id, package, justification, expiry).
- **Dependabot** groups minor and patch updates by area, keeps toolchain majors held back ([ADR 0001](adr/0001-monorepo-strategy.md)) and waits a few days after a release (cooldown).

## 4. Containers

- `apps/api/Dockerfile` and `apps/web/Dockerfile` use the **repository root as build context**, a pinned `node:24.22.2-trixie-slim` base, a lockfile-only `pnpm fetch` layer, and run as the non-root user `node` (uid 1000) with a `HEALTHCHECK`.
- **API image:** `tsup` bundles the API and every `@caseguard/*` package into `dist/main.js` and `dist/db/migrate-cli.js`; the SQL migrations are copied to `dist/db/migrations`; production `node_modules` come from `pnpm deploy --prod` (injected workspace packages, so the audited lockfile versions ship; `--legacy` is avoided because it re-resolves ranges). `@electric-sql/pglite` stays external so its WASM assets load. The build fails if the bundle imports a package that is not a production dependency of `@caseguard/api`. Commands: `node dist/main.js` (default) and `node dist/db/migrate-cli.js [--status]`. Writable paths: `/app/.data` and `/tmp`. With PostgreSQL it is designed to run with a read-only root filesystem (not verified in a container here).
- **Web image (important):** Next.js inlines all `NEXT_PUBLIC_*` values (Entra client id, authority and scope, auth mode, app environment) into the build, so they are **build arguments** and an image belongs to one environment's Entra registration. The Azure deployment reads the right values from the Bicep output `webBuildArguments`. `API_INTERNAL_URL` is read at request time by the web server's `src/proxy.ts` (ADR 0012): it is purely a runtime environment variable of the web container (Bicep sets it from the API's internal address, compose sets it on the service), it is not a build argument and the image carries no default for it; a missing or invalid value in production is a 502 `upstream_not_configured` problem. The Dockerfile expects `output: 'standalone'` with `outputFileTracingRoot` at the repo root and fails early with an explanation otherwise. Set `HOSTNAME=0.0.0.0` (the image does; Kubernetes-style platforms also need it in the app settings).
- **Compose** (`docker-compose.yml`, DEV ONLY): `docker compose up --build` starts PostgreSQL 16, the API and the web app on loopback ports; `--profile azurite` adds a blob emulator for experiments (the API's blob provider uses managed identity, which Azurite does not support). `pnpm docker:build` builds both images tagged `caseguard-api:local` and `caseguard-web:local`, and validates the compose file.
- **Tags:** images deployed to Azure are tagged with the first 12 characters of the commit SHA (or an explicit immutable tag); never `latest`.

## 5. Local reproduction

```sh
pnpm verify                         # everything, honest PASSED / FAILED / NOT RUN table + verification-report.json
pnpm verify --only secrets:scan,audit:deps,infra:validate
node scripts/smoke-test.mjs --web http://localhost:3000 --api http://localhost:4000 --auth dev
```

## 6. Deployment to Azure (inert until configured)

`deploy.yml` does nothing against Azure until a human completes the setup below and sets the repository variable `AZURE_DEPLOY_ENABLED=true`. Until then every run stops after a preflight job with a notice.

**Flow** (`deploy-environment.yml`, one job per environment):

1. Preflight (what does this run do?) then Bicep validation, then optionally the full CI workflow.
2. **What-if** (`az deployment sub what-if`) with the rendered parameter file; the result is added to the run summary. Mode `what-if` (the default for manual runs) stops here.
3. Mode `deploy`: stage 1 infrastructure without apps, read outputs, record the currently deployed API image tag, `az acr build` for both images, stage 2 apps and the migration job, **run the migration job and wait**, then **smoke tests** through the public web URL. The API has internal ingress only, so `/livez`, `/readyz` and `/api/v1/me` are exercised through the web app's runtime proxy (`apps/web/src/proxy.ts`); the smoke test also checks `/` for the product name, the security headers, and that `/api/v1/me` answers 401 without credentials.
4. **Automatic rollback:** if the apps deployment, the migration or the smoke test fails and a previous release existed, the previous image tag is re-deployed (a new revision from the old image; the apps use multiple-revision mode, so traffic shifting is also possible by hand: see the runbooks). Database migrations are **not** rolled back; they must stay backward compatible (expand, then contract in a later release). A first deployment has nothing to roll back to and fails loudly.
5. **Production** only runs from a manual dispatch with `environment=production`, after a successful dev run of the same ref (unless `skip_dev` is set), and the `production` GitHub environment pauses it until its required reviewers approve. No trigger deploys production automatically.

**One-time setup** (details: [ENTRA_ID_SETUP.md](ENTRA_ID_SETUP.md#7-github-actions-oidc-for-deployment) and [DEPLOYMENT.md](DEPLOYMENT.md)):

1. Create a **deployment identity per environment** (an Entra app registration or a user-assigned managed identity). Do not share one between dev and production.
2. Add a **federated credential** to each: issuer `https://token.actions.githubusercontent.com`, audience `api://AzureADTokenExchange`, subject `repo:snowjug/CaseGuard-Ai:environment:dev` (and `...:environment:production`). The subject format is `repo:<owner>/<repo>:environment:<environment name>` and must match exactly; never create a credential for a `pull_request` subject on an identity that can write.
3. Grant roles at the narrowest scope that works: Contributor on the subscription (the template creates the resource group) plus Role Based Access Control Administrator limited to the role definitions the templates assign.
4. Create the GitHub **environments** `dev` and `production`; give `production` required reviewers (not the author), restrict it to the default branch and consider a wait timer.
5. Set the variables (and the optional secret) described below.
6. Run `deploy.yml` manually with `mode = what-if` first, read the result, then `deploy`.

**Variables** (non-secret; environment scope unless noted):

| Variable                 | Scope       | Meaning                                                                                                                     |
| ------------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------- |
| `AZURE_DEPLOY_ENABLED`   | repository  | `true` arms the workflow. Anything else keeps it inert.                                                                     |
| `AZURE_DEPLOY_ON_TAG`    | repository  | optional; `true` makes a `v*.*.*` tag deploy to **dev**                                                                     |
| `AZURE_CLIENT_ID`        | environment | client id of the deployment identity                                                                                        |
| `AZURE_TENANT_ID`        | environment | Entra tenant id                                                                                                             |
| `AZURE_SUBSCRIPTION_ID`  | environment | target subscription id                                                                                                      |
| `AZURE_LOCATION`         | environment | Azure region, chosen deliberately (quota and model availability differ per region)                                          |
| `AZURE_BICEP_PARAMETERS` | environment | full text of the filled-in `main.<env>.local.bicepparam` (from `main.dev.bicepparam` or the `*.template` files); no secrets |

The workflow refuses to run with a missing value, a placeholder GUID, or placeholders left in the parameter text. These ids are identifiers, not secrets, but they stay out of git by design. Only if the dev parameter file uses `postgresAuthMode = 'password'`, add the environment **secret** `CASEGUARD_POSTGRES_ADMIN_PASSWORD` (16+ characters); production uses Entra authentication and needs no secret. Never create an `AZURE_CLIENT_SECRET`.

Known gaps: the what-if job uses the same identity as the deploy (the more cautious design is a separate read-only identity with the `Microsoft.Resources/deployments/whatIf/action` permission); `staging` is not wired into the workflows (add it to the `environment` choice and the promotion order if you use it).

## 7. Required repository settings (a human must apply these)

The repository had no default branch when this was written; apply the branch rules after the first push to `main`. The workflows assume the default branch is named `main` (`branches-ignore` in `ci.yml`, `branches` in `codeql.yml`); change those two places if you choose another name.

- **Branch protection or a ruleset on `main`:** require a pull request with at least one approval, dismiss stale approvals, **require review from Code Owners**, require conversation resolution, require branches to be up to date, block force pushes and deletion, require linear history (squash merge). Required status checks: **`CI gate`**, **`Analyze (javascript-typescript)`** and **`Review dependency changes`** (select them after each has run once; the gate already depends on every CI job). Optionally require signed commits.
- **CODEOWNERS** (`.github/CODEOWNERS`) names `@snowjug`; the owner must confirm it and add teams as the project grows. It also protects `.github/**`, `infra/**`, `scripts/**` and the lockfile.
- **Actions:** default `GITHUB_TOKEN` permissions to read-only; allow GitHub-owned and verified actions (or an explicit allow list); require approval for workflow runs from outside collaborators; consider pinning actions to commit SHAs (section 8).
- **Environments:** `dev`, `production` as in section 6; keep the production approvers separate from the authors.
- **Code security:** enable the dependency graph, Dependabot alerts and security updates, **secret scanning and push protection**, code scanning (the CodeQL workflow is in the repository), and **private vulnerability reporting** (`SECURITY.md` links to it).
- **Merge settings:** squash merge only, PR title as the commit message (it must be a Conventional Commit), auto-delete merged branches.

## 8. Action versions and hardening backlog

Actions are pinned to a major version tag (checkout v7, setup-node v7, pnpm/action-setup v6, upload-artifact v7, download-artifact v8, docker/setup-buildx-action v4, docker/build-push-action v7, azure/login v3, gitleaks-action v3, dependency-review-action v5, codeql-action v4). They were selected on 2026-10-29 from the current major tags on GitHub and all run on the Node 24 runtime. Older majors (for example `setup-node@v4`, `azure/login@v2`, `gitleaks-action@v2`) run on Node 20, which, according to the gitleaks-action v3 migration notice, GitHub removed from hosted runners on 16 September 2026, so they were not used. Dependabot proposes updates weekly.

Follow-ups, not done:

- **Pin actions to full commit SHAs** (keep the version in a comment); Dependabot can update SHA pins.
- **Pin base images by digest** (`node:<tag>@sha256:...` and `postgres`, Azurite); Dependabot's Docker ecosystem updates tag and digest together.
- Generate an **SBOM** and build **provenance attestations**, **scan images** (for example Trivy) and consider signing.
- A read-only what-if identity and a **merge queue** (section 6 and 7).
- Run the Playwright suite against the deployed dev environment after each deployment.

## 9. What was and was not validated

| Item                                                               | Status                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow YAML                                                      | Parsed; checked with actionlint 1.7.12 plus shellcheck 0.11.0 (including the composite actions' scripts): no findings                                                                                                                                                                                                                                                      |
| Dockerfiles, `.gitleaks.toml`, git hooks                           | Dockerfiles: hadolint 2.15.1, no findings. `.gitleaks.toml`: accepted by gitleaks 8.30.1, working-tree scan clean. Hooks: run through the husky runner with Git's `sh` (secret scan in `--staged` mode, Conventional Commit check)                                                                                                                                         |
| Repository scripts                                                 | `scan-secrets`, `audit-deps`, `infra-validate`, `docker-build`, `smoke-test`, `verify` and `check-commit-msg` each pass their `--self-test` (37, 13, 8, 5, 6, 8 and 15 checks), and so does `check-docs` (9 checks). `infra:validate` passes on the current Bicep, and `secrets:scan` passes on the working tree. `docker:build` reports NOT RUN (exit 3) without a daemon |
| GitHub Actions execution (CI, CodeQL, dependency review, deploy)   | **Not run.** No push, no workflow run was possible from the authoring environment                                                                                                                                                                                                                                                                                          |
| Docker image builds, `docker compose up`, the container smoke test | **Not run.** No Docker daemon was available. `docker compose config` passes. The pnpm fetch/install/deploy and tsup steps of the API image were exercised outside Docker, and the bundled API CLI applied all migrations on PGlite from the deployed `node_modules`                                                                                                        |
| Web image                                                          | **Not built.** No Docker daemon was available, and `next build` was not run either (it would write `apps/web/.next`, which the web workstream also uses). `next.config.ts` now sets `output: 'standalone'` and `outputFileTracingRoot`; the Dockerfile fails early with an explanation if `.next/standalone/apps/web/server.js` is missing                                 |
| Azure deployment, OIDC login, what-if, ACR build, rollback         | **Not run.** `infra:validate` (Bicep build, lint, parameter scan) passes; nothing was sent to any subscription                                                                                                                                                                                                                                                             |
| Playwright, accessibility, integration tests on PostgreSQL 16      | **Not run here** (run by CI)                                                                                                                                                                                                                                                                                                                                               |
| `pnpm audit:deps`                                                  | Runs. **It currently reports one HIGH advisory** (`@azure/msal-node` 6.0.1, GHSA-xcx6-jx8p-x3h5, via `@azure/identity`), so the gate fails until it is fixed or consciously excepted                                                                                                                                                                                       |
