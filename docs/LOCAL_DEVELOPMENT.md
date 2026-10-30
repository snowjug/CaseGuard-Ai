# Local development

How to run, test and debug CaseGuard AI on a developer machine. Everything here is **local, synthetic-data-only**: the default
configuration uses an embedded database, local files, an offline AI provider and an unauthenticated persona login that must never
be exposed to a network. Commands were checked against `package.json`, the package scripts and `scripts/`; the ones I ran are marked
"ran". Related: [ARCHITECTURE.md](ARCHITECTURE.md), [DATA_MODEL.md](DATA_MODEL.md), [EVALUATION.md](EVALUATION.md),
[SECURITY.md](SECURITY.md).

The commands use Windows PowerShell 5.1 syntax (no `&&`, `pnpm.cmd` and `npx.cmd`). In PowerShell 7, bash or zsh, plain `pnpm`
works the same way.

## 1. Prerequisites

| Tool       | Version                                                                                                     | Notes                                                                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js    | 24 or newer (`.node-version` is `24`; `engines.node` is `>=24.0.0`; `scripts/dev.mjs` refuses older majors) | The numbers in this documentation were produced on Node v26.13.0, which satisfies the range                                              |
| pnpm       | 10.34.7 (pinned in `packageManager`)                                                                        | Install it the way you prefer; with Corepack the `packageManager` field selects the version                                              |
| Git        | any recent version                                                                                          | Needed by the secret scanner (`git ls-files`) and the Husky hooks                                                                        |
| Docker     | optional                                                                                                    | Only for `docker compose` (PostgreSQL 16, image builds). **Not used or verified for this documentation: no Docker daemon was available** |
| PostgreSQL | optional                                                                                                    | Default is the embedded PGlite; a real server is needed only if you choose one                                                           |

No cloud account, API key or network access is needed to run, test or demo the product locally.

## 2. Install

```powershell
git clone <repository-url>
cd <repository>
pnpm.cmd install
```

I did not run `pnpm install` (it was already installed on the machine used for this documentation). `pnpm install` also runs
`husky` through the `prepare` script, which installs the `pre-commit` (secret scan on staged files, lint-staged formatting) and
`commit-msg` (Conventional Commits) hooks.

## 3. Configure

```powershell
Copy-Item .env.example .env
```

`.env` is git-ignored. Every active default in `.env.example` is safe for a developer machine and unsafe elsewhere; the file
contains no secrets and must stay that way.

| Fact                              | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which file is read                | `pnpm dev` loads the repository-root `.env` and passes it to both apps (variables already set in your shell win). Running one app directly (`pnpm dev:api`) reads `apps/api/.env` instead. With no `.env` anywhere the built-in local defaults apply; the message `.env not found. Continuing without it.` is normal                                                                                                                                                                                                                                                                                           |
| Validation                        | `packages/config` validates every variable at start-up and **exits with status 1** listing each problem (never a value) when something is invalid or unsafe                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Defaults that matter locally      | `APP_ENV=local`, `AUTH_MODE=dev`, `DEV_AUTH_ENABLED=true`, `DATABASE_URL=pglite://.data/caseguard`, `STORAGE_PROVIDER=local`, `SEARCH_PROVIDER=lexical`, `AI_PROVIDER=deterministic`, `DEMO_MODE=true`                                                                                                                                                                                                                                                                                                                                                                                                         |
| Relative paths                    | `pglite://.data/caseguard` and `STORAGE_LOCAL_DIR=.data/objects` are relative to the API's working directory, which is `apps/api` when started through pnpm; the data therefore lives in `apps/api/.data/` (git-ignored)                                                                                                                                                                                                                                                                                                                                                                                       |
| `NEXT_PUBLIC_*`                   | Inlined into the web build: rebuild or restart `next dev` after changing them. `API_INTERNAL_URL` (default `http://localhost:4000` outside production) is where the web server's `src/proxy.ts` forwards `/api/*` and the probes; it is read on every request, so changing it needs no rebuild                                                                                                                                                                                                                                                                                                                 |
| `TRUST_PROXY`                     | Which proxies may set the client address (`X-Forwarded-For`) that the general rate limit uses. The default `false` ignores the header, which is right for a local run with no proxy. A number is a proxy hop count (the Bicep template sets 1 for the Azure ingress; see the web-proxy caveat in [SECURITY.md](SECURITY.md#6-request-pipeline-controls)); a comma-separated list of addresses, CIDR ranges, `loopback`, `linklocal` or `uniquelocal` also works. `true` believes every hop, so a client can pick its own address: local experiments only, and it warns when `APP_ENV` is staging or production |
| Azure OpenAI, Entra, Blob, Search | Optional and **never exercised against a real service**; see [AI_ORCHESTRATION.md](AI_ORCHESTRATION.md#94-configuring-azure-openai-not-validated-against-a-live-service) and [ENTRA_ID_SETUP.md](ENTRA_ID_SETUP.md)                                                                                                                                                                                                                                                                                                                                                                                            |

## 4. Run the API and the web app

| Command                                                                | What it does                                                                                       | Verified                                         |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `pnpm.cmd dev`                                                         | Runs `scripts/dev.mjs`: API and web together through `concurrently`, after loading the root `.env` | `--dry-run` ran (prints the plan only)           |
| `node scripts/dev.mjs --dry-run`                                       | Prints what would start, the personas and which `.env` variables would load; starts nothing        | Ran                                              |
| `node scripts/dev.mjs --api-only` / `--web-only` / `--env-file <path>` | Start one side or use another env file                                                             | Flags read from the script                       |
| `pnpm.cmd dev:api`                                                     | `tsx watch --env-file-if-exists=.env src/main.ts` in `apps/api`                                    | API start ran (see below), via `tsx src/main.ts` |
| `pnpm.cmd dev:web`                                                     | `next dev --port 3000` in `apps/web`                                                               | Not run by me                                    |

Addresses: API `http://localhost:4000` (`API_HOST`, `API_PORT`), web `http://localhost:3000`. The API serves `/livez`, `/healthz`
and `/readyz`, and, when the environment is not deployed, OpenAPI at `/api/v1/openapi.json` with a docs page at `/api/docs`.
The web app forwards `/api/*` and the probes to the API, so the browser only talks to its own origin.

**API start-up check (ran).** I started `tsx src/main.ts` with `DATABASE_URL=pglite://memory`, a temporary object directory and
`API_PORT=4311`. On this machine (a OneDrive-synced folder, with other processes running) a cold start took about 65 seconds:
migrations 0001 to 0009 were applied, then the server listened. `/livez`, `/healthz` and `/readyz` returned 200, a request
without credentials returned 401, and `GET /api/v1/me` with a persona header returned the engineer, tenant, 10 permissions and the
three environment notices. Local logs are human-readable lines; any other environment emits JSON lines
([OBSERVABILITY.md](OBSERVABILITY.md)). Later, with the demo workstream's uncommitted code in the working tree, the same start
(`API_PORT=4312`, in-memory database) also ran the demo auto-seed between the migrations and the first `Server listening` line:
about 23 seconds for the 13 story steps on this machine (`demo.seed.completed`, `demo.auto_seed` in the log), and all 75 contract
routes were served. Set `DEMO_AUTO_SEED=false` to skip it.

## 5. Persona login (development only)

The persona login has no real authentication: any client can send the header. It works only when `AUTH_MODE=dev`,
`DEV_AUTH_ENABLED=true` and `APP_ENV` is `local`, `test` or `development`
([SECURITY.md](SECURITY.md#21-development-personas)).

| Header value (`x-cg-persona`) | Role          | Tenant                                                   |
| ----------------------------- | ------------- | -------------------------------------------------------- |
| `user_ava_engineer`           | engineer      | `tenant_contoso_support`                                 |
| `user_riley_reviewer`         | reviewer      | `tenant_contoso_support`                                 |
| `user_morgan_manager`         | manager       | `tenant_contoso_support`                                 |
| `user_casey_curator`          | skill_curator | `tenant_contoso_support`                                 |
| `user_alex_admin`             | administrator | `tenant_contoso_support`                                 |
| `user_fabi_engineer`          | engineer      | `tenant_fabrikam_lab` (exists to prove tenant isolation) |

```powershell
Invoke-RestMethod -Uri http://localhost:4000/api/v1/me -Headers @{ 'x-cg-persona' = 'user_ava_engineer' }
Invoke-RestMethod -Uri http://localhost:4000/api/v1/dev/personas   # the list the web picker uses (no header needed)
```

In the browser, the persona picker (fed by `GET /api/v1/dev/personas`) lets you choose a persona; the web app stores the choice
and sends the header for you. The picker is always badged "Development identity" and hidden in presentation mode.

## 6. Database options

| Option                     | `DATABASE_URL`                                              | Use it for                                                                                                                                                                                                                                           |
| -------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PGlite on disk (default)   | `pglite://.data/caseguard`                                  | Everyday development. Embedded PostgreSQL (PGlite runs PostgreSQL 18), zero dependencies. **One process at a time** may open the directory                                                                                                           |
| PGlite in memory           | `pglite://memory`                                           | Throw-away runs and the smoke check above; everything is lost on exit                                                                                                                                                                                |
| PostgreSQL 16 from Compose | `postgres://caseguard:<password>@127.0.0.1:55432/caseguard` | Checking behaviour on a real server. `docker compose up postgres` publishes it on loopback port 55432 with the dev-only default password in `docker-compose.yml` (override with `POSTGRES_PASSWORD`). **Compose was not run for this documentation** |
| Any other PostgreSQL       | `postgres://...` with `DATABASE_AUTH=password` or `entra`   | The API must connect as a non-superuser member of `caseguard_app` for row-level security to apply ([DATA_MODEL.md](DATA_MODEL.md#5-row-level-security-and-the-caseguard_app-role)). Not exercised here                                               |

To reset local data: stop the API, then `Remove-Item -Recurse -Force apps\api\.data`.

## 7. Migrations

```powershell
pnpm.cmd db:migrate              # applies pending migrations to DATABASE_URL and prints the result
pnpm.cmd db:migrate --status     # reports only; exit code 1 when migrations are pending or a checksum changed
```

Ran against `DATABASE_URL=pglite://memory`: `pnpm.cmd db:migrate` applied `0001_foundation` to `0009_job_heartbeat` and reported
"Applied: 9, pending: 0" in about 26 seconds, and `pnpm.cmd db:migrate --status` on a fresh memory database reported "Applied: 0,
pending: 9" and exited with status 1, as documented. The API also migrates at start-up when `DB_AUTO_MIGRATE=true`, which is the
default for `local` and `test` only; deployed environments run `node dist/db/migrate-cli.js` as a separate job (designed, never
executed). Checksums, the advisory lock and CRLF handling are described in
[DATA_MODEL.md](DATA_MODEL.md#10-migration-policy). Never edit a released migration: add a new one.

## 8. Seed data

- **Foundation (automatic).** At start-up, when migrations are applied automatically and `DEMO_MODE=true` or `APP_ENV` is `local`
  or `test`, the API creates two synthetic tenants, six synthetic users (the personas above) and the default governance
  settings. Existing rows are never overwritten.
- **Demo cases.** `pnpm.cmd demo:seed` and `pnpm.cmd demo:reset` are declared in the root `package.json` (`tsx scripts/demo-seed.ts`,
  `tsx scripts/demo-reset.ts`) and are implemented by the demo workstream (`apps/api/src/services/demo`, the `demo.*` routes). They
  were still **uncommitted** when I checked, and I ran only the seed: `pnpm.cmd demo:seed` with `DATABASE_URL=pglite://memory`
  (a throw-away database) exited 0 after 73 s and printed `Demo seeded (portfolio): 13 of 13 story steps complete.`, the ids of
  Case One, Case Two and one skill, and `Synthetic demonstration data. Provider: deterministic (simulated).` I did not run
  `demo:reset`. In local demo mode (`DEMO_MODE=true`, the local default) the API also seeds the same portfolio profile at start-up
  (`DEMO_AUTO_SEED`, defaults to true for `local` with demo mode; it must be false in production): the start-up log shows the
  events `demo.seed.completed` and `demo.auto_seed`, and `GET /api/v1/demo/state` answered 200 for the administrator persona.
  The demo walk-through itself will be documented in the demo documents; this file does not describe it.
- **Sample files.** `pnpm.cmd samples:export` regenerates `apps/api/src/samples/generated.ts` from `synthetic-data/cases/*.json` and
  `synthetic-data/examples/`; `pnpm.cmd schemas:export` writes the JSON Schemas to `synthetic-data/knowledge/` and `docs/schemas/`.
  The API lists the samples at `GET /api/v1/samples` and `GET /api/v1/examples`. You can also create a case from a pasted
  transcript, a CSV or a JSON bundle through the ingestion routes; the two synthetic cases live in `synthetic-data/cases/`.

## 9. Tests

| Command                                                  | Runs                                                                                                             |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `pnpm.cmd test`                                          | Everything, every workspace project (`vitest run`, root `vitest.config.ts` aggregates `packages/*` and `apps/*`) |
| `pnpm.cmd test:unit`                                     | Everything except `*.int.test.ts`                                                                                |
| `pnpm.cmd test:int`                                      | Only `*.int.test.ts` (`vitest run --dir apps --dir packages int.test`)                                           |
| `pnpm.cmd test:coverage`                                 | `vitest run --coverage` (V8; HTML, lcov and text-summary under `coverage/`)                                      |
| `pnpm.cmd test:e2e`                                      | Playwright end-to-end and axe accessibility tests (not run by me)                                                |
| `pnpm.cmd exec vitest run` inside a package              | One package. This is how the counts in [EVALUATION.md](EVALUATION.md) were taken                                 |
| `pnpm.cmd exec vitest run test/<file>` inside `apps/api` | One file                                                                                                         |

Notes:

- **Unit versus integration.** "Integration" means the file name ends in `.int.test.ts`: it opens a database, an HTTP server or a
  mock service. Most API tests, including several that are not named `.int`, still start an in-memory PGlite database.
- **PGlite start is slow on synced folders.** A cold PGlite takes seconds, and much longer when many files start at once or the
  data directory is on a OneDrive-synced disk. The database start-up hook has a fixed 180 s timeout (`TEST_DATABASE_STARTUP_TIMEOUT_MS`
  in `apps/api/src/db/testing.ts`). In this repository, three PGlite-backed API files took 173 s together.
- **Real PostgreSQL for the API suites.** Set `TEST_DATABASE_URL` to a superuser connection of a throw-away database; each test
  file then gets a private schema. This path has not been exercised.
- **Worker start errors.** The `packages/ui` and `apps/web` suites use jsdom and Fluent UI and are heavy. Under machine load Vitest
  reports `Failed to start forks worker` or timeouts. Re-run with fewer workers (`--maxWorkers=1` or `2`). Node 26 prints a harmless
  `localStorage is not available because --localstorage-file was not provided` warning.
- Property tests use `fast-check`; the engine's temporal-integrity tests are in `packages/domain/test` ([EVALUATION.md](EVALUATION.md#4-temporal-integrity-evidence)).

## 10. Lint, format, typecheck, build

| Command                   | Does                                                                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm.cmd lint`           | `eslint .` (type-aware; also `lint:fix`)                                                                                                                                    |
| `pnpm.cmd format:check`   | `prettier --check .`; `pnpm.cmd format` writes. Config: single quotes, 100 columns, `proseWrap: preserve`                                                                   |
| `pnpm.cmd typecheck`      | `tsc --noEmit` in every workspace (`pnpm -r --if-present typecheck`)                                                                                                        |
| `pnpm.cmd build`          | `pnpm -r --if-present build`: `tsup` for the API, `next build` for the web app                                                                                              |
| `pnpm.cmd bench`          | The engine benchmark in `packages/domain` ([EVALUATION.md](EVALUATION.md#6-performance)); ran, 32 s                                                                         |
| `pnpm.cmd infra:validate` | Bicep build, lint and parameter scan; needs a Bicep CLI (standalone `bicep` or `az bicep`), exit code 3 (NOT RUN) when none is found. It does not call Azure. Not run by me |
| `pnpm.cmd docker:build`   | Container image builds and `docker compose config`; reports NOT RUN (exit 3) without a Docker daemon                                                                        |

`node scripts/verify.mjs --list` prints the validation steps (`format:check`, `lint`, `typecheck`, `test:unit`, `test:int`,
`build`, `test:e2e`, `secrets:scan`, `audit:deps`, `infra:validate`, `docker:build`, `demo:replay`); `--only a,b` runs a subset
and `--skip`, `--fail-fast`, `--json-out`, `--no-md` and `--step-timeout` are available. It does not support `--help`. A full run
(no `--only`/`--skip`) also rewrites `docs/assets/VALIDATION_REPORT.md`, so use `--only` while developing. An exit code 3 means a step
was NOT RUN, never "passed". `audit:deps` sends the lockfile's package names and versions to a public vulnerability service when the
registry has no audit endpoint.

## 11. Secret scanning

```powershell
pnpm.cmd secrets:scan                       # node scripts/scan-secrets.mjs : scans tracked and untracked files
node scripts/scan-secrets.mjs --staged      # what the pre-commit hook runs
node scripts/scan-secrets.mjs --self-test   # the scanner's own test suite
```

Findings print `file:line` and a rule id, never the value, and exit with status 1. Allow-list entries live in `.secretscanignore`
and need a written reason. CI also runs gitleaks with `.gitleaks.toml`. The scanner lists files with `git ls-files`, so it needs a
Git repository.

## 12. Troubleshooting

| Symptom                                                                | Cause and fix                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm` is blocked or not found in Windows PowerShell 5.1               | Use `pnpm.cmd` and `npx.cmd`. PowerShell 5.1 has no `&&`; chain with `;` and check `$LASTEXITCODE`                                                                                                                                                                                                                                                                         |
| The API takes a minute to start, tests time out, workers fail to start | The folder is under OneDrive (`...\OneDrive - Microsoft\Desktop\...`): sync and path length slow every file access. Clone to a local folder such as `C:\dev\caseguard`, or pause sync. Lower Vitest concurrency (`--maxWorkers=1`)                                                                                                                                         |
| `EADDRINUSE` on 4000 or 3000                                           | Another process holds the port. Set `API_PORT` (and `CORS_ALLOWED_ORIGINS` / `API_INTERNAL_URL` to match). The web port is fixed to 3000 in `apps/web/package.json`; stop the other process or edit the script                                                                                                                                                             |
| Compose PostgreSQL port clash                                          | The container publishes `127.0.0.1:55432`; change it with `POSTGRES_HOST_PORT`                                                                                                                                                                                                                                                                                             |
| PGlite error about a locked or busy data directory                     | Two processes opened `apps/api/.data/caseguard` (for example the API and `db:migrate`). Stop one, or use `pglite://memory`                                                                                                                                                                                                                                                 |
| The API exits immediately and prints configuration problems            | `packages/config` refused an unsafe or invalid combination (for example `AUTH_MODE=dev` with `APP_ENV=production`, or an AI cost cap without unit prices). Fix the named variables; values are never printed                                                                                                                                                               |
| `401` on every call                                                    | No credential. Send `x-cg-persona: <user id>` in dev mode; in Entra mode send a bearer token. A persona that is not in the list is also a 401                                                                                                                                                                                                                              |
| `403` for a persona                                                    | The role lacks the permission; see the RBAC matrix in [SECURITY.md](SECURITY.md#4-rbac-matrix). A denied attempt is audited (the first refusal per persona and route in each rate-limit window; further ones are counted in `suppressedSincePrevious` on the next audit event)                                                                                             |
| `501` from `command-center`, `demo/*`, `efficiency/*`, `analytics/*`   | A contract route has no handler in your build. All 75 routes have one in the working tree I checked; the dashboard and demo groups were the last to land (uncommitted when I looked), so an older checkout answers 501 for exactly those                                                                                                                                   |
| `429`                                                                  | The in-memory rate limit: 300 requests per minute per client address, counted **before authentication** (so repeated 401 and 403 answers count too, and a script that retries with a bad persona is throttled), and 30 per minute per user on heavy routes. Wait for `Retry-After`. Behind a local proxy, set `TRUST_PROXY` correctly or every client looks like the proxy |
| `413` or `400` on an upload                                            | `413`: the file is larger than `UPLOAD_MAX_BYTES` (2 MiB by default), including a file that was cut exactly at the limit; the connection is closed after the answer. `400`: the multipart body is broken (no boundary, ended early); send one file in the `file` field                                                                                                     |
| The same `Idempotency-Key` runs the request again                      | Keys are private to the user who chose them, so replaying a key as a different persona is a new request. A replay by the same persona returns the stored response with `Idempotent-Replayed: true`                                                                                                                                                                         |
| `403` when cancelling a job                                            | `POST /api/v1/jobs/:jobId/cancel` is open to any signed-in user at the route, but the job service requires the permission that starts that kind of job (for example `case:analyze` for an analysis)                                                                                                                                                                        |
| Web calls fail with a CORS error                                       | The browser origin must be in `CORS_ALLOWED_ORIGINS` (default `http://localhost:3000`)                                                                                                                                                                                                                                                                                     |
| A test fails only under load                                           | Re-run that file alone with `--maxWorkers=1`; jsdom tests and PGlite starts are timing-sensitive on this machine                                                                                                                                                                                                                                                           |
| Scripts print mojibake for `—` or `…`                                  | PowerShell 5.1 writes UTF-16 with `>`; use `Out-File -Encoding utf8` when capturing output to a file                                                                                                                                                                                                                                                                       |
