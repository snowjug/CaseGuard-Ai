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

| Fact                              | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which file is read                | `pnpm dev` loads the repository-root `.env` and passes it to both apps (variables already set in your shell win). Running one app directly (`pnpm dev:api`) reads `apps/api/.env` instead. With no `.env` anywhere the built-in local defaults apply; the message `.env not found. Continuing without it.` is normal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Validation                        | `packages/config` validates every variable at start-up and **exits with status 1** listing each problem (never a value) when something is invalid or unsafe                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Defaults that matter locally      | `APP_ENV=local`, `AUTH_MODE=dev`, `DEV_AUTH_ENABLED=true`, `DATABASE_URL=pglite://.data/caseguard`, `STORAGE_PROVIDER=local`, `SEARCH_PROVIDER=lexical`, `AI_PROVIDER=deterministic`, `DEMO_MODE=true`. An unset `APP_ENV` means `local`, except when `NODE_ENV=production` (the API image sets it): start-up then fails until `APP_ENV` is named explicitly                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Relative paths                    | `pglite://.data/caseguard` and `STORAGE_LOCAL_DIR=.data/objects` are relative to the API's working directory, which is `apps/api` when started through pnpm; the data therefore lives in `apps/api/.data/` (git-ignored); `pnpm demo:seed` and `pnpm demo:reset` also start in `apps/api`, so they use the same files (section 8.2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `NEXT_PUBLIC_*`                   | Inlined into the web build: rebuild or restart `next dev` after changing them. `API_INTERNAL_URL` (default `http://localhost:4000` outside production) is where the web server's `src/proxy.ts` forwards `/api/*` and the probes; it is read on every request, so changing it needs no rebuild                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `TRUST_PROXY`                     | Which proxies may set the client address (`X-Forwarded-For`) that the general rate limit uses when it is not using `x-cg-client-ip` (next row). The default `false` ignores the header, which is right for a local run with no proxy. A number is a proxy hop count (the Bicep template sets 1 as the secondary fallback for the Azure ingress); a comma-separated list of addresses, CIDR ranges, `loopback`, `linklocal` or `uniquelocal` also works. `true` believes every hop, so a client can pick its own address: local experiments only, and it warns when `APP_ENV` is staging or production                                                                                                                                                                                                                                                                                                                                                                             |
| `TRUST_CLIENT_IP_HEADER`          | `false` by default, and a local run should leave it that way. When `true` the API believes `x-cg-client-ip`, the header that the web server's `src/proxy.ts` sets from the right-most `X-Forwarded-For` entry (replacing any value a client sent) so that visitors behind the web tier get separate rate-limit buckets; the Bicep template sets it for the Azure API container only. Never enable it on an API that browsers or other callers can reach directly, which `http://localhost:4000` is; nothing guards against that. Locally a single developer is one bucket either way: with the flag off the API counts the socket peer (the web server or your own client); with it on, the web server reports your loopback address, because Next fills `X-Forwarded-For` with the socket address when it is absent. Details and the honest status (tested with simulated headers, never behind a real ingress) are in [SECURITY.md](SECURITY.md#client-address-for-rate-limits) |
| Azure OpenAI, Entra, Blob, Search | Optional and **never exercised against a real service**; see [AI_ORCHESTRATION.md](AI_ORCHESTRATION.md#94-configuring-azure-openai-not-validated-against-a-live-service) and [ENTRA_ID_SETUP.md](ENTRA_ID_SETUP.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

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
`API_PORT=4311`. On this machine (a OneDrive-synced folder, with other processes running) the first cold start took about 65
seconds, then the server listened. `/livez`, `/healthz` and `/readyz` returned 200, a request without credentials returned 401,
and `GET /api/v1/me` with a persona header returned the engineer, tenant, 10 permissions and the three environment notices. Local
logs are human-readable lines; any other environment emits JSON lines ([OBSERVABILITY.md](OBSERVABILITY.md)). In the latest run
(all 12 migrations, the demo start-up seed on) the log showed `database migrations applied`, 11 seconds of demo seeding
(`demo.seed.completed`, then `demo.auto_seed` with `completedSteps=13 totalSteps=13`) and then `Server listening`; section
[8.2](#82-demo-data) lists what the demo routes returned. Set `DEMO_AUTO_SEED=false` to skip the seed.

## 5. Persona login (local and test only)

The persona login has no real authentication: any client can send the header. It works only when `AUTH_MODE=dev`,
`DEV_AUTH_ENABLED=true` and `APP_ENV` is `local` or `test`; the Azure `development` environment, `staging` and `production`
refuse it at start-up ([SECURITY.md](SECURITY.md#21-development-personas)).

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
pnpm.cmd db:migrate              # applies pending migrations to DATABASE_URL, then provisions the tenants asked for, and prints the result
pnpm.cmd db:migrate --status     # reports only; exit code 1 when migrations are pending, a checksum changed or a requested tenant is missing
pnpm.cmd db:migrate --tenant <id>   # also provisions that tenant (repeatable); the tenants of ENTRA_TENANT_MAP are always requested
```

Ran against `DATABASE_URL=pglite://memory` (a new empty database each time, discarded on exit): `pnpm.cmd db:migrate` applied
`0001_foundation` to `0012_review_target_type_idx`, reported "Applied: 12, pending: 0" and ended with
`Tenants: none requested (set ENTRA_TENANT_MAP or pass --tenant <id>)` (20 seconds in the latest run, 44 seconds in an earlier
one on a more loaded machine). `pnpm.cmd db:migrate --tenant tenant_probe` ended with `Tenants: tenant_probe created` (9 seconds).
`pnpm.cmd db:migrate --status` on a fresh memory database reported "Applied: 0, pending: 12" and exited with status 1, as
documented (pnpm adds its own `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` lines). Tenant provisioning exists for deployed environments, where
nothing seeds a tenant; it creates the tenant row and its default settings, never a user or an audit event, and was verified on PGlite
only ([DEPLOYMENT.md](DEPLOYMENT.md#55-migrations), [apps/api/src/db/README.md](../apps/api/src/db/README.md)). The API also migrates at start-up when `DB_AUTO_MIGRATE=true`, which is the
default for `local` and `test` only; deployed environments run `node dist/db/migrate-cli.js` as a separate job (designed, never
executed). Checksums, the advisory lock and CRLF handling are described in
[DATA_MODEL.md](DATA_MODEL.md#10-migration-policy). Never edit a released migration: add a new one.

## 8. Seed data

Three kinds of data are seeded: the tenants and personas (automatic), the guided demo story (two commands, three API routes and an
optional start-up step) and the sample files.

### 8.1 Foundation (automatic)

When migrations are applied automatically and `DEMO_MODE=true` or `APP_ENV` is `local` or `test`, the API creates two synthetic
tenants, six synthetic users (the personas above) and the default governance settings. The demo commands below open the same
infrastructure, so they do it too on an empty database. Existing rows are never overwritten. A deployed environment does not run this
step (the template sets `DB_AUTO_MIGRATE=false`), so nothing in the repository creates the tenants there; see the note under the
smoke tests in [DEPLOYMENT.md](DEPLOYMENT.md#57-post-deploy-smoke-tests).

### 8.2 Demo data

**What it is.** A guided story in the synthetic Contoso tenant (`tenant_contoso_support`) in 13 steps: import Case One (an
intermittent Microsoft Teams sign-in failure), analyse it, accept a better investigation path, derive a SkillDNA skill, take it
through the governed lifecycle, apply it to Case Two (a related case with a different root cause) and compare the outcomes. The
seeder plays the story through the real services as four seeded personas (Ava, Riley, Casey and Alex), so permissions, four-eyes
approval and the audit trail apply as they do over HTTP. The AI provider is the deterministic offline engine, every figure is a
labelled estimate and no Azure service is called. Design notes: [`services/demo/README.md`](../apps/api/src/services/demo/README.md).

**Commands.** All four ran, against a PGlite database in a temporary directory; after the scripts were changed to accept a
forwarded `--` and to read `.env`, both argument forms of `demo:seed --profile base` ran once more against `pglite://memory`:

| Command                                  | What it does                                               | What I saw                                                                                                                                                                                        |
| ---------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm.cmd demo:seed`                     | Seeds the `portfolio` profile (the default of the command) | Exit 0 and `Demo seeded (portfolio): 13 of 13 story steps complete.`, then the ids of Case One, Case Two and the skill, then `Synthetic demonstration data. Provider: deterministic (simulated).` |
| `pnpm.cmd demo:seed --profile base`      | Seeds the `base` profile                                   | Exit 0 and `Demo seeded (base): 0 of 13 story steps complete.`                                                                                                                                    |
| `pnpm.cmd demo:seed --profile portfolio` | The same as `demo:seed`                                    | Exit 0, the same output as the first row                                                                                                                                                          |
| `pnpm.cmd demo:reset`                    | Erases the tenant's case data (see "Reset" below)          | Exit 0 and `Demo data reset: 0 of 13 story steps complete.`                                                                                                                                       |

Each command took between about 20 and 130 seconds on this machine, depending on load, most of it start-up; between the
`database migrations applied` and `demo data seeded` log lines the story itself took about 11 seconds in two runs (the first
command-line run and the start-up seed of an API). Before the summary the commands print the usual start-up log lines.

- **Both argument forms work.** `pnpm demo:seed --profile base` and `pnpm demo:seed -- --profile base` are the same command: pnpm
  10.34.7 forwards a literal `--` to the script and the command line ignores it (both forms ran: exit 0 and
  `Demo seeded (base): 0 of 13 story steps complete.`). The usage line is `Usage: pnpm demo:seed [--profile base|portfolio]   (default: portfolio)`;
  an unknown profile, and any argument to `demo:reset`, exit with code 2.
- **The same database as `pnpm dev`.** Both scripts first call `useApiEnvironment` (`scripts/api-environment.ts`): they load the
  repository's `.env` (a variable already in the environment wins) and change to `apps\api`, exactly where `pnpm dev:api` runs, so
  without `DATABASE_URL` the defaults `pglite://.data/caseguard` and `.data/objects` name the files the API serves
  (`apps\api\.data`). A probe confirmed that the working directory is the repository root before the call and `apps\api` after it
  (and that no `.env` existed at the time). I did not run `demo:seed` or `demo:reset` against `apps\api\.data`, because other work
  was using it: my runs used `pglite://memory` and temporary directories.
- **One process at a time.** A PGlite directory belongs to one process, so **stop the API (`pnpm dev`) before running a demo
  command** and start it again afterwards. With `pglite://memory` a command opens a new empty database and discards it on exit,
  which shows that the story runs but leaves nothing behind. The simplest route to a seeded app is the start-up seed below: leave
  `DEMO_AUTO_SEED` on and start the API. To keep the data somewhere else, set `DATABASE_URL` and `STORAGE_LOCAL_DIR` to absolute
  locations in `.env` (or in the shell) for the command and the API alike.
- **CI.** The reset-then-seed replay (`node scripts/verify.mjs --only demo:replay`, the step "Demo reset and seed replay" of the
  integration job) sets `DATABASE_URL` to the PostgreSQL 16 service container, so it exercises a real server. It runs in CI only
  and was not run here.

**Profiles.**

| Profile     | Result                                                                                                    | How                                                                                                                        | Default for                                  |
| ----------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `base`      | A clean workspace with the story at step 1 (0 of 13), for a presenter to perform it live                  | Erases the case data (as a reset does) and writes the seed marker; no job                                                  | `POST /api/v1/demo/seed` without a `profile` |
| `portfolio` | All 13 steps done: Case One and Case Two ingested and analysed, a skill published and applied to Case Two | One `demo_seed` job (not cancellable, up to 20 minutes) plays the story; its progress shows in the jobs list while it runs | `pnpm demo:seed` and the start-up seed       |

**Idempotent.** Every stage first looks at what is stored and skips what is done, an interrupted run resumes where it stopped, a
tenant whose story is complete is answered without starting a job (the audit event says `noop: true`), and the seed marker
(`seededAt`) is written once. I ran `pnpm.cmd demo:seed` twice on one database: the second run exited 0 after 30 s (start-up
only), printed the same three ids and logged neither a migration nor a job.

**The portfolio story.** Each action is performed, and audited, as the persona the story names. After a fresh `pnpm.cmd demo:seed`
the audit trail of the tenant named exactly these four people: Ava (engineer, 6 events: two `case.ingested`, two
`analysis.completed`, `skill.extracted`, `skill.applied`), Riley (reviewer, 6: `counterfactual.reviewed`, three
`skill.transitioned`, two `skill.validation_recorded`), Casey (skill curator, 3: `skill.changes_requested`, `skill.transitioned`,
`skill.mutation_proposed`) and Alex (administrator, 2: `skill.published`, `demo.seed`). Step 9 requires the pilot approver and the
publisher to be different people, and a database check rejects an approval by the person who requested it. The last action is a
refinement of the skill that Casey proposes after Case Two; it stays a proposal and is not one of the 13 steps.

**The 13 steps.** Progress is derived from stored facts on every read, never flagged by a client. Case One and Case Two are the
ingested copies of the two built-in samples, recognised by their bundle reference; a case pasted by hand does not advance the guide.
A step is enabled when it is complete or is the first incomplete one, and later steps say which step they wait for.

| #   | Step                                                         | Present as    | Done when the stored data shows                                                                   |
| --- | ------------------------------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------- |
| 1   | Import Case One                                              | engineer      | the case exists                                                                                   |
| 2   | Timeline reconstructed                                       | engineer      | its analysis state is `analyzed`                                                                  |
| 3   | Evidence ledger built                                        | engineer      | it has claims                                                                                     |
| 4   | Competing hypotheses shown                                   | engineer      | it has at least two hypotheses                                                                    |
| 5   | Decision forks found                                         | engineer      | it has at least one fork                                                                          |
| 6   | A better path simulated and accepted                         | reviewer      | a scenario of the earliest meaningful fork is confirmed                                           |
| 7   | Quality and efficiency metrics calculated                    | manager       | a quality assessment and metric estimates exist                                                   |
| 8   | Draft SkillDNA generated                                     | engineer      | a skill lists Case One among its source cases                                                     |
| 9   | Governed approval completed                                  | skill curator | a pilot approval and a publication are on record, by two different people                         |
| 10  | Import Case Two                                              | engineer      | the case exists                                                                                   |
| 11  | The validated skill applies to Case Two                      | engineer      | a stored match of the skill, made once it was validated or published, says it applies             |
| 12  | The second investigation is shorter and more evidence-driven | engineer      | Case Two has its metrics and the match carries conformance (the guided plan was applied)          |
| 13  | Outcomes compared                                            | manager       | both cases have their metrics and the second investigation is recorded (the comparison is a view) |

**Reset (`demo:reset`, or `POST /api/v1/demo/reset`).** It erases `cases` (and everything derived from them), `skills`, `jobs`,
`token_usage`, `model_executions`, `review_decisions`, `idempotency_keys` and the seed marker of the tenant, then deletes the
mirrored case payloads from the object store. Tenants, users, governance settings and the audit trail stay, and the reset itself is
audited (`demo.reset`, phase `started` and `completed`). Counted in the database directly before and after one reset of a
`portfolio` seed: cases 2 to 0, skills 1 to 0, jobs 1 to 0, token usage 12 to 0, model executions 12 to 0, review decisions 1 to
0, seed marker 1 to 0; users stayed 6, governance settings 14 and tenants 2; audit events went from 38 to 40; the local object
directory went from 4 files to none.

**Who may call it.** `GET /api/v1/demo/state` needs `case:read` (all five roles hold it); `POST /api/v1/demo/seed` and
`POST /api/v1/demo/reset` need `demo:manage`, which only the administrator holds. The commands act as the seeded administrator,
`user_alex_admin`. Results of a local API (in-memory database, start-up seed on):

| Request                                                      | Result                                                                      |
| ------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `GET /api/v1/demo/state` without credentials                 | 401                                                                         |
| the same as the manager persona                              | 200: 13 of 13 steps done, next action is step 13, `seededAt` set, 4 notices |
| the same as the Fabrikam engineer (another tenant)           | 200: 0 of 13, `seededAt` null                                               |
| `POST /demo/seed` as the engineer                            | 403                                                                         |
| `POST /demo/reset` as the engineer, and as the skill curator | 403                                                                         |
| `POST /demo/reset` as administrator                          | 200: 0 of 13, `seededAt` null                                               |
| `POST /demo/seed` as administrator with no body              | 200: 0 of 13, `seededAt` set (the default profile of the route is `base`)   |
| `POST /demo/seed` with `{"profile":"nope"}`                  | 422 `validation_failed`                                                     |
| `POST /demo/seed` with `{"profile":"portfolio"}`, then again | 200: 13 of 13 after 2.9 s, then 200 after 0.2 s (nothing re-run)            |

**Refusals.** Seed and reset answer 409 (and audit a denial with a reason) when demo data may not be managed in the caller's
tenant, while any job is queued or running, and, for the seed only, when the tenant lacks the four synthetic personas or one was
disabled or lost a permission the story needs. The first check passes when `DEMO_MODE` is on **or** the caller's tenant is flagged
synthetic (the seeded tenants are); in demo mode the flag is not consulted, and demo mode is refused in production and logs a warning
in staging. These refusals come from the code and the unit tests of the guard (`demo-units.test.ts`); I did not trigger them by
hand.

**Start-up seed.** With `DEMO_AUTO_SEED=true` the API plays the `portfolio` profile as the seeded administrator after the
migrations and before the server listens; a failure is logged (`demo.auto_seed_failed`) and the server starts anyway, and the next
start or `demo:seed` resumes. `DEMO_MODE` defaults to true for `local` and `test`, `DEMO_AUTO_SEED` to true only for
`APP_ENV=local` with demo mode, `DEMO_AUTO_SEED=true` needs `DEMO_MODE=true`, and `APP_ENV=production` refuses both. The
`.env.example` sets both to true. Seen on an in-memory start: `database migrations applied`, then `demo data seeded` (with
`performed=13 skipped=0`), then `demo data is ready (synthetic portfolio profile)` (with `completedSteps=13 totalSteps=13`), then
`Server listening`, 11 seconds after the first of those lines. Set `DEMO_AUTO_SEED=false` to skip it.

**In the web app.** In presentation mode the presenter strip reads `demo.state` and offers a guarded "Reset demo" that calls
`demo.reset` (`apps/web/src/components/shell/PresenterStrip.tsx`; I did not run the web app for this). The walk-through itself
belongs to the demo documents. CI defines a reset-then-seed replay (`node scripts/verify.mjs --only demo:replay`); it has not been
observed running.

### 8.3 Sample files

`pnpm.cmd samples:export` regenerates `apps/api/src/samples/generated.ts` from `synthetic-data/cases/*.json` and
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

| Command                   | Does                                                                                                                                                                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm.cmd lint`           | `eslint .` (type-aware; also `lint:fix`)                                                                                                                                                                                                            |
| `pnpm.cmd format:check`   | `prettier --check .`; `pnpm.cmd format` writes. Config: single quotes, 100 columns, `proseWrap: preserve`                                                                                                                                           |
| `pnpm.cmd typecheck`      | `tsc --noEmit` in every workspace (`pnpm -r --if-present typecheck`)                                                                                                                                                                                |
| `pnpm.cmd build`          | `pnpm -r --if-present build`: `tsup` for the API, `next build` for the web app                                                                                                                                                                      |
| `pnpm.cmd bench`          | The engine benchmark in `packages/domain` ([EVALUATION.md](EVALUATION.md#6-performance)); ran, 32 s                                                                                                                                                 |
| `pnpm.cmd docs:api`       | Rewrites the generated route table of [API.md](API.md#regenerating-this-page) from the route registry; `pnpm.cmd docs:api --check` writes nothing and exits 1 when it drifted                                                                       |
| `pnpm.cmd docs:check`     | `node scripts/check-docs.mjs`: every relative Markdown link, image and heading anchor resolves, Mermaid fences are closed and not empty, workflow badges name workflows that exist, screenshots exist; `--self-test` runs its own tests. No network |
| `pnpm.cmd infra:validate` | Bicep build, lint and parameter scan; needs a Bicep CLI (standalone `bicep` or `az bicep`), exit code 3 (NOT RUN) when none is found. It does not call Azure. Not run by me                                                                         |
| `pnpm.cmd docker:build`   | Container image builds and `docker compose config`; reports NOT RUN (exit 3) without a Docker daemon                                                                                                                                                |

`node scripts/verify.mjs --list` prints the validation steps (`format:check`, `lint`, `typecheck`, `generated:check` (the JSON Schemas,
the embedded samples and the route table of `docs/API.md`), `docs:check`, `test:unit`, `test:int`,
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

| Symptom                                                                | Cause and fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm` is blocked or not found in Windows PowerShell 5.1               | Use `pnpm.cmd` and `npx.cmd`. PowerShell 5.1 has no `&&`; chain with `;` and check `$LASTEXITCODE`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| The API takes a minute to start, tests time out, workers fail to start | The folder is under OneDrive (`...\OneDrive - Microsoft\Desktop\...`): sync and path length slow every file access. Clone to a local folder such as `C:\dev\caseguard`, or pause sync. Lower Vitest concurrency (`--maxWorkers=1`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `EADDRINUSE` on 4000 or 3000                                           | Another process holds the port. Set `API_PORT` (and `CORS_ALLOWED_ORIGINS` / `API_INTERNAL_URL` to match). The web port is fixed to 3000 in `apps/web/package.json`; stop the other process or edit the script                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Compose PostgreSQL port clash                                          | The container publishes `127.0.0.1:55432`; change it with `POSTGRES_HOST_PORT`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| PGlite error about a locked or busy data directory                     | Two processes opened the same directory (for example the API and `db:migrate`, or the API and `demo:seed` pointed at the same `DATABASE_URL`). Stop one, or use `pglite://memory`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| The API exits immediately and prints configuration problems            | `packages/config` refused an unsafe or invalid combination (for example `AUTH_MODE=dev` with `APP_ENV=production`, or an AI cost cap without unit prices). Fix the named variables; values are never printed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `401` on every call                                                    | No credential. Send `x-cg-persona: <user id>` in dev mode; in Entra mode send a bearer token. A persona that is not in the list is also a 401                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `403` for a persona                                                    | The role lacks the permission; see the RBAC matrix in [SECURITY.md](SECURITY.md#4-rbac-matrix). A denied attempt is audited (the first refusal per persona and route in each rate-limit window; further ones are counted in `suppressedSincePrevious` on the next audit event)                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `501` from `command-center`, `demo/*`, `efficiency/*`, `analytics/*`   | A contract route has no handler in your build. All 75 routes have one in the current tree (static scan); an older checkout, from before the dashboard and demo groups were added, answers 501 for exactly those routes. Update the checkout                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `429`                                                                  | The in-memory rate limit: 300 requests per minute per client address, counted **before authentication** (so repeated 401 and 403 answers count too, and a script that retries with a bad persona is throttled), and 30 per minute per user on heavy routes. Wait for `Retry-After`; to test the limit on purpose, start the API with a small `RATE_LIMIT_MAX`. Locally every request counts against one address (your client's, or the web server's when you go through port 3000); behind a local reverse proxy set `TRUST_PROXY` correctly or every client looks like the proxy. The `429` log line shows no address, because the API never logs one ([SECURITY.md](SECURITY.md#client-address-for-rate-limits)) |
| `413` or `400` on an upload                                            | `413`: the file is larger than `UPLOAD_MAX_BYTES` (2 MiB by default), including a file that was cut exactly at the limit; the connection is closed after the answer. `400`: the multipart body is broken (no boundary, ended early); send one file in the `file` field                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| The same `Idempotency-Key` runs the request again                      | Keys are private to the user who chose them, so replaying a key as a different persona is a new request. A replay by the same persona returns the stored response with `Idempotent-Replayed: true`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `403` when cancelling a job                                            | `POST /api/v1/jobs/:jobId/cancel` is open to any signed-in user at the route, but the job service requires the permission that starts that kind of job (for example `case:analyze` for an analysis)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `pnpm.cmd demo:seed` prints `Usage: ...` and exits with 2              | An argument it does not accept: an unknown profile (only `base` and `portfolio` exist), a misspelt flag, or any argument at all to `demo:reset`. A forwarded `--` is fine ([8.2](#82-demo-data))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| The app is empty after `pnpm.cmd demo:seed`                            | The command and the API did not use the same database. Both read the repository `.env` and start in `apps\api`, so the defaults agree; they differ when `DATABASE_URL` or `STORAGE_LOCAL_DIR` is set in only one shell, or is `pglite://memory` (nothing persists). Stop the API before `demo:seed` (a PGlite directory belongs to one process), or let the API seed itself at start-up ([8.2](#82-demo-data))                                                                                                                                                                                                                                                                                                     |
| `409` from `POST /api/v1/demo/seed` or `demo/reset`                    | A job is still queued or running in the workspace (wait for it), the tenant is not a synthetic demo tenant (demo mode off and the tenant not flagged synthetic), or the seed cannot find the four synthetic personas. The `detail` names which                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Web calls fail with a CORS error                                       | The browser origin must be in `CORS_ALLOWED_ORIGINS` (default `http://localhost:3000`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| A test fails only under load                                           | Re-run that file alone with `--maxWorkers=1`; jsdom tests and PGlite starts are timing-sensitive on this machine                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Scripts print mojibake for `—` or `…`                                  | PowerShell 5.1 writes UTF-16 with `>`; use `Out-File -Encoding utf8` when capturing output to a file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
