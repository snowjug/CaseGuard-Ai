# Testing

How CaseGuard AI is tested, how to run each tier on Windows and in CI, what each tier proves and what it cannot, and the numbers
from the run that was actually made. Everything here runs offline against synthetic data: no Azure service, no network beyond
`localhost`, no real language model.

Related: [EVALUATION.md](EVALUATION.md) (the engine, the temporal-integrity evidence and the AI evaluation harness, with the unit
test inventory), [ACCESSIBILITY.md](ACCESSIBILITY.md), [PERFORMANCE.md](PERFORMANCE.md), [SECURITY.md](SECURITY.md),
[LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md#9-tests), [CI_CD.md](CI_CD.md).

**Page names.** The interface redesign renamed the pages: Command Center is now Home, Case Timeline is Timeline, Evidence Ledger is
Evidence, Hypothesis Arena is Possible causes, Counterfactual Lab is What if, Quality Review is Score (one case) and Quality (all
cases), SkillDNA Library is Skills, Efficiency Monitor is Usage and cost, Governance is Settings and audit, System Health is System
status and Demo Guide is Guided demo. This document uses the new names, also for the records of past runs and findings, which were
made under the old ones. Spec file names are unchanged, except that `pages/command-center.spec.ts`, as it is named in the recorded
run below, is now `pages/home.spec.ts`.

## 1. The tiers

| Tier                 | Command                                             | Lives in                                                                                  | What it proves                                                                                                                                                            | What it does not prove                                                                                                                                    |
| -------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit and property    | `pnpm.cmd test:unit`                                | `packages/*/test`, `apps/*/src/**/*.test.ts(x)`                                           | Pure logic: schemas, config guards, security helpers, the domain engine (with `fast-check` properties), validators, UI primitives and web components in jsdom             | Anything that needs a real browser, real layout or a real network                                                                                         |
| Integration          | `pnpm.cmd test:int`                                 | `*.int.test.ts`                                                                           | The API against a real (PGlite) database and HTTP server, and mock services                                                                                               | A real PostgreSQL (only with `TEST_DATABASE_URL`, never exercised here), any Azure service                                                                |
| End-to-end           | `pnpm.cmd test:e2e`                                 | `e2e/**/*.spec.ts`                                                                        | The production build of the web app, in a real browser, against a real API with the deterministic engine and the seeded demo: every page, the demo story, ingestion       | Entra sign-in, Azure, a real model, other browsers than Chromium, real phones                                                                             |
| Accessibility        | part of `test:e2e`                                  | `e2e/a11y.spec.ts`, `e2e/mobile.spec.ts`, `e2e/theme.spec.ts`, `e2e/pages/review.spec.ts` | Zero axe violations (WCAG 2.1 A/AA and best practice) on every page and state in both themes, keyboard paths, reduced motion, no sideways scroll at 390 px                | Conformance: no screen reader, no real users ([ACCESSIBILITY.md](ACCESSIBILITY.md#4-what-was-not-done))                                                   |
| Security (black box) | part of `test:e2e`                                  | `e2e/security-http.spec.ts`                                                               | Headers and the nonce CSP on the real server, tenant isolation, role refusals, input limits, the client address the rate limiter sees, the refusal to start in production | Penetration testing, dependency or infrastructure security (see [SECURITY.md](SECURITY.md), [THREAT_MODEL.md](THREAT_MODEL.md))                           |
| Resilience           | part of `test:e2e`                                  | `e2e/resilience.spec.ts`                                                                  | Problem answers shown in words with their request id, an API that is down, idempotent replays, optimistic locking                                                         | Load, partial failures of real cloud services                                                                                                             |
| AI evaluation        | `pnpm.cmd exec vitest run` in `packages/ai`         | `packages/ai/test` (`evaluation.int.test.ts`)                                             | The AI contracts, validators and the governor hold against 42 adversarial fixtures and 12 controls with the **deterministic** provider                                    | Anything about a live model: no real Azure OpenAI call has ever been made ([EVALUATION.md](EVALUATION.md#5-ai-evaluation-harness-deterministic-provider)) |
| Benchmarks           | `pnpm.cmd bench`, `pnpm.cmd bench:api`, `PW_PERF=1` | `packages/domain`, `scripts/bench-api.ts`, `e2e/perf`                                     | How long the engine, the API calls and the timeline page take on one machine ([PERFORMANCE.md](PERFORMANCE.md))                                                           | A load test or an SLO. None is claimed                                                                                                                    |
| Screenshots          | `pnpm.cmd screenshots`                              | `e2e/screenshots/screenshots.spec.ts`                                                     | The pages render with real data in light, dark and phone layouts; the PNGs in `docs/assets/screenshots/` come from here                                                   | Visual regression: nothing compares the images with earlier ones                                                                                          |

The unit, integration and AI-evaluation counts are in [EVALUATION.md](EVALUATION.md#2-test-inventory). **I did not re-run those
tiers for this document**; only the end-to-end tiers below were run for it.

## 2. The last full run

**The interface redesign, on the final tree** (branch `ui/caseguard-redesign`, commit `181965a`, 6 November 2026; Linux VM, 4
shared vCPU, the bundled Chromium with `PW_CHANNEL=` empty, one worker, a fresh production build and a fresh API). The typecheck,
the lint, the format check, the docs check, the secret scan, the dependency audit and the production build all exit 0.
`pnpm test` (unit and integration tests together): **370 files, 9,281 tests passed, 1 skipped**, in 18.6 minutes.
`pnpm exec playwright test --project=desktop --project=mobile`: **447 tests, 447 passed, 0 failed, 0 flaky, 0 skipped**, in 20.2
minutes (desktop 395, mobile 52). The baseline before the redesign was 375 end-to-end tests (369 passed, 2 failed because of how
that run was started, 4 skipped; `docs/ui-redesign/baseline.md`) and 8,087 unit tests (`pnpm test:unit`, which leaves the
integration tests out). An earlier full unit run on a loaded machine had failed two files: a guard test that found the repository
root from the working directory, so that it could not load when vitest starts at the root, and a deletion test that raced the
confirmation dialog. Both were fixed and the run above is the one on the final commit.

| Project   | Spec                               |   Tests |  Passed | Failed | Test time |
| --------- | ---------------------------------- | ------: | ------: | -----: | --------: |
| desktop   | `a11y.spec.ts`                     |     152 |     152 |      0 |     543 s |
| desktop   | `demo-flow.spec.ts`                |      24 |      24 |      0 |      70 s |
| desktop   | `pages/cases.spec.ts`              |       8 |       8 |      0 |      22 s |
| desktop   | `pages/counterfactual-lab.spec.ts` |       8 |       8 |      0 |      24 s |
| desktop   | `pages/demo-guide.spec.ts`         |       9 |       9 |      0 |      28 s |
| desktop   | `pages/efficiency.spec.ts`         |       5 |       5 |      0 |      11 s |
| desktop   | `pages/evidence-ledger.spec.ts`    |      10 |      10 |      0 |      26 s |
| desktop   | `pages/governance.spec.ts`         |      15 |      15 |      0 |      49 s |
| desktop   | `pages/home.spec.ts`               |       6 |       6 |      0 |      12 s |
| desktop   | `pages/hypothesis-arena.spec.ts`   |       7 |       7 |      0 |      16 s |
| desktop   | `pages/ingestion.spec.ts`          |      12 |      12 |      0 |      27 s |
| desktop   | `pages/presentation-mode.spec.ts`  |       7 |       7 |      0 |      17 s |
| desktop   | `pages/quality-review.spec.ts`     |       8 |       8 |      0 |      18 s |
| desktop   | `pages/review.spec.ts`             |      30 |      30 |      0 |      87 s |
| desktop   | `pages/skilldna-library.spec.ts`   |       8 |       8 |      0 |      14 s |
| desktop   | `pages/system-health.spec.ts`      |       6 |       6 |      0 |      11 s |
| desktop   | `pages/timeline.spec.ts`           |       6 |       6 |      0 |      17 s |
| desktop   | `resilience.spec.ts`               |      16 |      16 |      0 |      29 s |
| desktop   | `security-http.spec.ts`            |      31 |      31 |      0 |      13 s |
| desktop   | `smoke.spec.ts`                    |      20 |      20 |      0 |      33 s |
| desktop   | `theme.spec.ts`                    |       7 |       7 |      0 |      14 s |
| mobile    | `mobile.spec.ts`                   |      52 |      52 |      0 |      91 s |
| **Total** |                                    | **447** | **447** |  **0** |   1,173 s |

`smoke.spec.ts` opens every main route and asserts its heading and that it renders with no console error; `mobile.spec.ts`
checks that no page scrolls sideways at 390x844 and at 320x640 (WCAG 1.4.10 reflow). The records below are earlier runs, kept
with their dates and their own page names.

**Wave 2, local, on the final detectors** (Linux VM, 4 shared vCPU, run at low priority beside other jobs; the engine and pack code
is that of commit `15dde3c`, and the later commits changed only lint fixes in the model-assisted review and documents). The
unit and integration tests, package by package: **domain 72 files, 2,133 tests; API 112 files, 2,083 tests (1 skipped), on PGlite;
web 70 files, 1,303; ai 51 files, 1,120; security 21 files, 847; observability 16 files, 939; config 8 files, 394; ui 12 files,
213; schemas 3 files, 87: 9,119 tests, all passing.** The typecheck of all nine workspaces, the whole-repository lint and format
check, the generated API reference check (78 routes) and the secret scan are clean. The domain suite includes the sample digests,
the ReDoS probe and the new static pass behind look-arounds. Three timing tests (the ReDoS probe over derived inputs, the claim bound and one skill-condition test) failed once, when the
load average on the shared machine reached 14; they pass at normal load, and the pattern probe is measured in CPU time. **Not run:** Docker, a real PostgreSQL server (every API test ran on PGlite), the full Playwright
suite (focused specs only, for Evidence and its record-findings panel ("What the record itself shows"): 10 of 10, axe in both themes, and a
phone-width check), and anything that needs Azure. The evaluation commands (`eval:check`, `eval:dev`, `eval:validation`, and the
single `eval:locked`) are described in [EVALUATION.md](EVALUATION.md#10-wave-2-the-evaluation-sets-the-protocol-the-verdict-criteria-and-the-result).

**The latest full CI run** (PostgreSQL 16 and the whole Playwright suite, which the local Wave 2 run above did not repeat) is GitHub Actions run 41546529865 (commit `69c4c85` of `build/wave-1`, 2 November 2026; the commits
after it change documents and the tolerance of one property test) passed all 8 jobs: **6,152 unit tests** (256 files; 4 more are expected failures that pin
known defects of the signal detectors), **1,033 integration tests on PostgreSQL 16** (56 files) and **374 Playwright tests**
(desktop and mobile, axe checks included, 15.5 minutes), plus the compose smoke test (12 checks), the secret scan with gitleaks
and the dependency audit. The 374 are the 342 of the run described below, the 29 of `pages/review.spec.ts` (the review and
the report) and three phone-width checks of the review and the report added to `mobile.spec.ts`. **Locally** on the Linux VM of
the wave (4 shared vCPU, the bundled Chromium, one worker) the review spec and the 26 phone-width tests ran twice: 62 of 63 passed
the first time (the one failure was a locator that the report strip's new named region made ambiguous, fixed and seen to pass),
and the 29 review tests passed in the second pass, which also took the screenshots that the docs were checked against. The
static gates (format, lint, typecheck, generated files, docs check, secret scan) passed locally in one `scripts/verify.mjs` run.
The record that follows is an **earlier local run on Windows** (31 October 2026, before the foundation work), kept for what it
found and for how long the suite takes on a loaded machine.

**Machine and tools.** Windows 10.0.26300 (x64); 11th Gen Intel Core i7-1185G7 at 3.00 GHz, 8 logical cores; 31.3 GiB of memory, of
which about 2 to 3.5 GiB were free during the runs; Node v26.13.0; pnpm 10.34.7; Playwright 1.64.1; axe-core 4.14.0; Microsoft Edge
156.0.4314.56; one worker, one browser at a time. The machine was shared with other builds, test runs and browsers for the whole
time (the CPU was at 36 to 82 % whenever I looked), so every duration below is noisy and says nothing about a quiet machine or a
CI runner.

**The second full run, on the final tree** (`pnpm.cmd test:e2e`, a fresh production build and a fresh API, 31 October 2026 by the
machine's clock): **342 tests, 341 passed, 1 failed, 0 flaky, 0 skipped**, in **30.8 minutes** wall time including the web build and
the API start. `desktop` ran 319 tests and `mobile` 23.

| Project   | Spec                               |   Tests |  Passed | Failed | Test time |
| --------- | ---------------------------------- | ------: | ------: | -----: | --------: |
| desktop   | `a11y.spec.ts`                     |     128 |     128 |      0 |     849 s |
| desktop   | `demo-flow.spec.ts`                |      24 |      24 |      0 |     123 s |
| desktop   | `pages/cases.spec.ts`              |       8 |       8 |      0 |      32 s |
| desktop   | `pages/command-center.spec.ts`     |       6 |       6 |      0 |      19 s |
| desktop   | `pages/counterfactual-lab.spec.ts` |       8 |       8 |      0 |      36 s |
| desktop   | `pages/demo-guide.spec.ts`         |       9 |       9 |      0 |      38 s |
| desktop   | `pages/efficiency.spec.ts`         |       5 |       5 |      0 |      16 s |
| desktop   | `pages/evidence-ledger.spec.ts`    |       9 |       9 |      0 |      37 s |
| desktop   | `pages/governance.spec.ts`         |      15 |      15 |      0 |      71 s |
| desktop   | `pages/hypothesis-arena.spec.ts`   |       7 |       7 |      0 |      24 s |
| desktop   | `pages/ingestion.spec.ts`          |      10 |      10 |      0 |      38 s |
| desktop   | `pages/presentation-mode.spec.ts`  |       7 |       7 |      0 |      33 s |
| desktop   | `pages/quality-review.spec.ts`     |       8 |       8 |      0 |      24 s |
| desktop   | `pages/skilldna-library.spec.ts`   |       8 |       8 |      0 |      27 s |
| desktop   | `pages/system-health.spec.ts`      |       6 |       6 |      0 |      18 s |
| desktop   | `pages/timeline.spec.ts`           |       6 |       6 |      0 |      26 s |
| desktop   | `resilience.spec.ts`               |      16 |      16 |      0 |      70 s |
| desktop   | `security-http.spec.ts`            |      31 |      30 |      1 |      56 s |
| desktop   | `smoke.spec.ts`                    |       1 |       1 |      0 |       2 s |
| desktop   | `theme.spec.ts`                    |       7 |       7 |      0 |      31 s |
| mobile    | `mobile.spec.ts`                   |      23 |      23 |      0 |      72 s |
| **Total** |                                    | **342** | **341** |  **1** |   1,640 s |

The `a11y.spec.ts` file is 14 of the 31 minutes (128 tests: 120 axe scans, the keyboard paths and the motion checks). Test time is
the sum of the tests; the rest of the wall time is the web build and the servers.

**What failed, and what was done about it.**

- The **first** full run (338 tests, 40.5 minutes) passed 335 and failed three. `pages/cases.spec.ts` (a case of another
  workspace opened on the timeline) found the product defect "unknown case, endless loading skeleton", now fixed (section 7).
  `resilience.spec.ts` (the engine-budget notice) looked for the notice by an exact title: fixed in the test. `mobile.spec.ts`
  (the cases as cards) saw a stray case that the upload test of `security-http.spec.ts` had left behind: fixed in the test helpers.
- After those fixes the three tests and the specs next to the changed pages were run again against the rebuilt production build:
  13 tests (the three, and the new not-found states of Timeline and Evidence in both themes), then 77 (timeline,
  evidence, cases, possible causes, the whole mobile spec and the demo flow). All passed.
- The **second** full run, above, failed one test: the engine-budget test of `security-http.spec.ts` served 29 instants where it
  asked for 30 or more, which a fast machine can do (section 7). The bounds were relaxed, and `security-http.spec.ts` and
  `pages/system-health.spec.ts` were run again on fresh servers: 37 of 37 passed. **There was no third full run**, so the final
  tree has been run end to end in two parts, not in one.
- Unit tests of the two changed web pages (`timeline.test.tsx`, `evidence.test.tsx`): 94 of 94 pass. In the one combined run an
  unrelated evidence test ("keeps an earlier window as it was when a decision is recorded there") timed out waiting for a button on
  the loaded machine and passed when run alone.

**Other runs.** `pnpm.cmd screenshots`: 18 of 18 passed (89 s). The `@perf` spec: 1 of 1 passed; its figures and the API benchmark
are in [PERFORMANCE.md](PERFORMANCE.md). `tsc -p e2e/tsconfig.json` and ESLint on `e2e`, `scripts` and `playwright.config.ts` are
clean.

## 3. End-to-end tests: how they are built

**What `pnpm.cmd test:e2e` starts.** `playwright.config.ts` has two `webServer` entries and a global setup:

1. **The API** (`e2e/support/serve-api.ts`): `apps/api` from source through `tsx` (or `dist/main.js` in CI), `APP_ENV=local`,
   persona login, in-memory PGlite, the deterministic AI provider, lexical search, a private object store under `.data/e2e`, rate
   limits raised so a long run from one address does not meet them by accident, and `DEMO_AUTO_SEED=true`. It listens only after
   the demo seed (the 13-step portfolio story), which takes about 100 s on a loaded laptop, so the wait is 10 minutes.
2. **The web app** (`e2e/support/serve-web.ts`): a **production build** (`next build`, standalone output, exactly what the image
   runs) into a private directory (`apps/web/.next-e2e` locally, deleted first; Next's `.next` in CI), started on port 3310 with
   `API_INTERNAL_URL` pointing at the API. The build takes 2 to 5 minutes and is rebuilt when a source is newer than the build.
3. **Global setup** (`e2e/support/global-setup.ts`) proves `/readyz` through the web tier, the six development personas, and that the
   demo is complete (13 of 13 steps), then prints the numbers the specs rely on.

Ports are uncommon on purpose (API **4310**, web **3310**) because other processes may hold 3000 and 4000; override with `PW_API_PORT`
and `PW_WEB_PORT`. One worker, one browser: the specs share one API and one database, and the run was made on a machine that is
often at full CPU, so timeouts are generous (180 s per test, 20 s per assertion).

**Projects.** `desktop` (1440x900, every spec except `mobile.spec.ts`, the screenshots and the `@perf` specs), `mobile` (390x844,
touch, only `mobile.spec.ts`), `screenshots` (only `pnpm screenshots`) and `perf` (only with `PW_PERF=1`; tests tagged `@perf` never
run otherwise).

**Browser.** Microsoft Edge (`channel: 'msedge'`) locally, the bundled Chromium in CI (`CI` set). `PW_CHANNEL` overrides it.

**Identity and theme.** Each test runs as a synthetic persona (`engineer`, `reviewer`, `manager`, `curator`, `admin`, plus the
Fabrikam engineer of the other workspace) and in a theme (`light`, `dark`). Both are Playwright options, so a spec writes
`test.use({ persona: 'manager', theme: 'dark' })`; the fixture signs in by storing the persona id and the `cg-theme` cookie before
the page loads. Setup data comes from the API client (`api('admin')`), never from clicking.

**Fixtures.**

| Fixture        | What it does                                                                                                                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `demo`         | The ids of Case One, Case Two and the skill, after making sure the 13-step story is complete. Test-scoped, because the story spec resets the workspace and plays it again, which gives new ids |
| `api(persona)` | A typed client that calls the API directly (setup, and checking that the UI did what it says)                                                                                                  |
| `diagnostics`  | Automatic. Collects every `console.error`, uncaught page error and CSP violation, and **fails the test** at the end unless the spec allowed that message                                       |

**Conventions.** Locators are roles, names and labels, which doubles as an accessibility check; there are no `data-testid`
attributes and none were added. No `waitForTimeout`: every wait is on a condition. Assertions on problems use the stable `code` and
`reason` tokens, never the wording. Estimates are asserted to be labelled as estimates. Specs that create data use a unique
reference per run and delete it; `demo-flow` resets and replays the workspace and restores the portfolio demo afterwards (set
`E2E_KEEP_STATE=1` to keep what it left). As-of reads are metered by the API (30 never-seen instants per user per minute, then 429
with `Retry-After` and the reason `engine_budget`), so specs space those reads out and use event instants.

**The specs.**

| Spec                                              | Covers                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `smoke.spec.ts`                                   | The web tier forwards the API probes and serves the shell for the signed-in persona                                                                                                                                                                                                                             |
| `security-http.spec.ts`                           | Black box, with Playwright's `request` and a second web and API instance of its own; see below                                                                                                                                                                                                                  |
| `resilience.spec.ts`                              | 401/403/404/409/422/429/503 shown with code and request id, Retry that recovers, the engine-budget notice, an API that is down, idempotency and optimistic locking                                                                                                                                              |
| `demo-flow.spec.ts`                               | The whole story, persona by persona, from an empty workspace: add Case One, Timeline, Evidence, Possible causes, the earliest key decision, What if, Score, Create skill (SkillDNA) through to a skill published by a different administrator, Case Two, the comparison, 13 of 13                               |
| `a11y.spec.ts`, `mobile.spec.ts`, `theme.spec.ts` | [ACCESSIBILITY.md](ACCESSIBILITY.md); no sideways scroll, the drawer, tables on a phone; light, dark and system, the cookie, no flash of the wrong theme                                                                                                                                                        |
| `pages/*.spec.ts` (14 files)                      | One spec per page: Home, Cases (and Case details, deletion, tenant isolation), Timeline, Evidence, Possible causes, What if, Score and Quality, Skills, Usage and cost, Settings and audit, System status, Guided demo, Add a case (including text with injected instructions staying inert), Presentation mode |
| `perf/timeline-render.spec.ts` (`@perf`)          | Timeline render time for Case One: first row visible and largest contentful paint, ten loads                                                                                                                                                                                                                    |
| `screenshots/screenshots.spec.ts`                 | The 18 PNGs of the documentation                                                                                                                                                                                                                                                                                |

**The security spec** asserts, against the real production web server and the real API: a per-request nonce CSP in which every script
uses the nonce; the browser header set on pages, the not-found page and static assets, and nothing that names the framework;
`frame-ancestors 'none'` and `X-Frame-Options: DENY`; **no CSP and no nonce on forwarded API responses**; the API's own header set on
every answer; HSTS only over HTTPS; probes without credentials listing names and states, never error text; CORS as an allow-list;
a Fabrikam engineer getting 404 for every view of a Contoso case and no write; 401 without a credential; role refusals (an
engineer or a manager cannot delete a case, engineers, reviewers and managers cannot publish or approve a skill, administration
and the audit log are closed) that change nothing; 413 over the body and upload limits, 415 and 422 for the wrong content type,
uploads judged by their bytes, a file name that tries to climb out of the upload folder; malformed `Idempotency-Key` and request
ids; the 429 of the engine budget and its refill; and the **client address the rate limiter sees**. For that last one the spec
starts a second web
instance of the real production server whose `API_INTERNAL_URL` is a local echo stub, and proves that a browser-supplied
`x-cg-client-ip` is dropped, that the API receives the right-most valid entry of `x-forwarded-for`, that nothing is set when that
entry is not an IP address, and that the request id, idempotency key, `authorization`, persona header, content type and body arrive
unchanged. It also starts the API with `APP_ENV=production AUTH_MODE=dev` (and with staging and with no name) and asserts that it
**refuses to start** and says why, and with `AUTH_MODE=entra` that the persona header is a plain 401.

**Environment switches** (all optional; `e2e/support/env.ts` is the single source):

| Variable                     | Effect                                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| `PW_API_PORT`, `PW_WEB_PORT` | Ports, default 4310 and 3310                                                                       |
| `PW_CHANNEL`                 | Browser channel; default `msedge` locally and bundled Chromium when `CI` is set                    |
| `PW_API_MODE`                | `src` (tsx, the default locally) or `dist` (`node dist/main.js`, the default in CI when it exists) |
| `PW_WEB_MODE`                | `standalone` (the default), `start` (`next start`) or `dev` (never for a real run)                 |
| `PW_WEB_REBUILD`             | `1` always rebuilds, `0` never; unset rebuilds when the build is missing or older than its sources |
| `CG_NEXT_DIST_DIR`           | The private Next build directory (default `.next-e2e` locally)                                     |
| `PW_REUSE_SERVER=1`          | Use servers already listening on the two ports (a fast loop when you changed only a spec)          |
| `PW_SERVER_LOGS=1`           | Print the servers' output                                                                          |
| `PW_PERF=1`                  | Also run the `@perf` project                                                                       |
| `E2E_KEEP_STATE=1`           | Leave the workspace as `demo-flow` left it instead of restoring the portfolio demo                 |

## 4. Commands

Windows PowerShell 5.1 (no `&&`; use the `.cmd` shims):

```powershell
pnpm.cmd install                                   # Microsoft Edge must be installed (the Edge channel is the only one run here)

pnpm.cmd test:e2e                                  # desktop + mobile projects; builds the web app and starts both servers
$env:PLAYWRIGHT_JSON_OUTPUT_NAME = 'run.json'; pnpm.cmd test:e2e --reporter=list,json   # the same, with a JSON report
pnpm.cmd screenshots                               # regenerate docs/assets/screenshots/*.png
$env:PW_PERF = '1'; pnpm.cmd exec playwright test --project=perf    # page render timing; writes test-results/perf-timeline-render.json
pnpm.cmd bench:api                                 # API micro-benchmark; writes docs/PERFORMANCE.md (--no-write prints only)
pnpm.cmd exec tsc -p e2e/tsconfig.json --noEmit    # type-check the e2e project
```

CI (`.github/workflows/ci.yml`, job `e2e`, 45-minute timeout, Ubuntu): `node scripts/verify.mjs --only build`, then
`pnpm exec playwright install --with-deps chromium`, then `node scripts/verify.mjs --only test:e2e`. With `CI` set Playwright
uses the bundled Chromium, the built API (`apps/api/dist`) and the web build in `.next`, retries a failed test once, forbids
`test.only`, and the report and traces are uploaded when the job fails. **That job has run on GitHub** (run 41546529865: all 374 tests
passed, including the Case Two step of `e2e/demo-flow.spec.ts` that failed in run 41182982903; see
[CI_CD.md](CI_CD.md#9-what-was-and-was-not-validated)); the CI path of the suite (Chromium, `dist` API, `.next`) was not exercised
locally.

`node scripts/verify.mjs` runs the whole gate (format, lint, typecheck, tests, build, e2e, secret scan, audit) with PASSED, FAILED or
NOT RUN for each step; see [LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md#10-lint-format-typecheck-build).

## 5. Running one test and debugging

```powershell
# One file, one project, one test by (part of) its title
pnpm.cmd exec playwright test e2e/pages/timeline.spec.ts --project=desktop -g "Show only"

# A fast loop: start both servers once (two terminals), then reuse them
node --import tsx e2e/support/serve-api.ts
node --import tsx e2e/support/serve-web.ts
$env:PW_REUSE_SERVER = '1'; pnpm.cmd exec playwright test e2e/pages/governance.spec.ts --project=desktop

# A trace of a failing test, then open it
pnpm.cmd exec playwright test e2e/resilience.spec.ts --project=desktop --trace on
pnpm.cmd exec playwright show-trace test-results\<test folder>\trace.zip
pnpm.cmd exec playwright show-report               # the HTML report of the last run (playwright-report/)

pnpm.cmd test:e2e:ui                               # Playwright's UI mode
$env:PW_SERVER_LOGS = '1'                          # see what the API and the web server printed
```

A failure leaves a screenshot under `test-results/`. Locally retries are off (a flaky test is a bug to investigate, not to retry);
traces are recorded on the first retry, so in CI a retry produces one. The machine matters: when it is saturated, a first
navigation to a page can take tens of seconds; the timeouts allow for that, and a real regression shows up as an assertion failure,
not a timeout.

Stop what you started: a run that is killed can leave the API and the web server listening on 4310 and 3310. Stop them by process id
(`Get-NetTCPConnection -LocalPort 4310,3310 -State Listen`, then `Stop-Process -Id <pid>`), never by name, and delete
`apps/web/.next-e2e` when you are done (it is git-ignored).

## 6. What the tests do not prove

- **A real identity provider.** Every run uses the development personas (`APP_ENV=local`); Microsoft Entra sign-in is covered by unit
  tests and a refusal test, not by a login.
- **Azure.** Nothing ran against Azure, Azure OpenAI, Azure Database for PostgreSQL, Key Vault or any other service; storage is a
  local folder, the database is in-memory PGlite, the AI provider is the deterministic offline engine. The answers are what the
  engine computes; they say nothing about a language model.
- **Accuracy of the analysis.** There are two synthetic cases written with the engine, a small independent set of 16 synthetic
  cases with one annotator, and no real data; every score is an estimate
  ([EVALUATION.md](EVALUATION.md#8-limits-of-this-evaluation)). The suite checks that the product shows the engine's numbers and
  labels them as estimates, not that they are right.
- **Other browsers and devices.** Chromium only (Microsoft Edge here); the phone layout is an emulated 390x844 viewport.
- **Scale and load.** One user at a time on one machine. [PERFORMANCE.md](PERFORMANCE.md) says what the benchmarks do and do not measure.
- **Visual regression.** The screenshots are looked at by a person; nothing diffs them.
- **Demo numbers are not all asserted.** The case sizes, the evidence counts, the Case Quality Index and the first key decision are the same in
  every fresh seed and the specs assert them; the **time that could have been saved in Case One (Avoidable Support Effort) is a sampled estimate**, steady since engine
  2026.3.0 but never asserted by value (section 7, finding 3).

## 7. Findings

What writing and running the suite found. Fixed means the product changed and a unit test guards it; the end-to-end test that found
it passes now.

**Fixed** (the lead commits these files):

| Finding                                                                                                                                                                                       | Change                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focus fell to the page body after closing a controlled dialog (command palette, shortcuts, navigation drawer, persona picker)                                                                 | `apps/web/src/lib/use-overlay-state.ts` (new), used by `lib/shell-ui.tsx` and `lib/auth/dev-persona.tsx`; test `use-overlay-state.test.tsx`                                                                                                                                                                                   |
| The chosen option of the persona picker had muted lines at 1.4:1 contrast                                                                                                                     | `apps/web/src/lib/auth/dev-persona.tsx` (`metaOnBrand`); test in `dev-persona.test.tsx`                                                                                                                                                                                                                                       |
| Home metric cards showed the trend twice ("+63.1 +63.1 points compared with ...")                                                                                                             | `packages/ui/src/primitives/MetricCard.tsx` (`trendText`); test `metric-trend.test.tsx`. The cause is in the data, see the open list                                                                                                                                                                                          |
| An unknown case id on the Timeline and Evidence pages showed an error alert **and** a "Loading what was known..." skeleton that stayed `aria-busy` for ever (the first full run failed on it) | `apps/web/src/components/case/CaseNotFoundState.tsx` (new), returned by `features/timeline/TimelinePage.tsx` and `features/evidence/EvidenceLedgerPage.tsx` when the case is not found, as the overview and the quality page already did; tests in `timeline.test.tsx` and `evidence.test.tsx`, which fail without the change |

**Test-side findings** (fixed in the suite, nothing to change in the product): the upload test in `security-http.spec.ts` deleted
its case while the analysis that an upload starts was still running, which the API refuses with 409 `job_active`, so a stray case
stayed and the phone Cases test saw three cases instead of two. `deleteCase` now waits for the job and retries, and the phone test
compares with the API's own list. The engine-budget test of `resilience.spec.ts` looked for the notice by its title as an exact
text; the notice is a `note` whose title is followed by a colon, and the sentence that announces it to a screen reader is a second,
hidden `status`, so it now finds the note by role and the status by its exact sentence. The engine-budget test of
`security-http.spec.ts` demanded 30 served instants, but the bucket (30 units, one more every two seconds) may have lost a unit to
the set-up read, so on a fast machine it served 29 once (the second full run): the bounds are now at least 25 and at most 30 plus
what the loop could have earned in the time it took. One `waitForTimeout` (System status, "Refresh reads the counters again") was
replaced by a wait on the condition.

**Findings of the guided-review wave** (all fixed; each is a way a test or a guard went wrong, not a defect of the engine):

- A jsdom test that looks up an open Fluent dialog or drawer by its name must first remove the `aria-hidden` that Fluent's focus
  manager (Tabster) puts on the open surface, or it passes or fails by the timing of that attribute. `apps/web/test/setup.ts`
  does it for `.fui-DialogSurface` and `.fui-OverlayDrawer`; a control that waited 400 ms and then queried failed 6 of 6 times
  before the fix and passed 6 of 6 after.
- Every file of the PostgreSQL suite runs in a private schema of one shared database, so a query of the catalog (`pg_indexes`,
  `information_schema`, a digest of the tables) has to be scoped with `current_schema()`; read across schemas it can fail with
  `XX000 relation_open` while another file drops its own.
- The Problem Details guard (`apps/api/test/problem-reasons.test.ts`) treats every `reason: '...'` literal of the API source as a
  token that `docs/API.md` must list. Response data that is also called `reason` (the unresolved links of `provenance.resolve`)
  has to be named otherwise in the code that builds it.
- Playwright: a string `name` is a substring match (use `exact: true` or a whole-name pattern when another region contains the
  word); a download is stored without an extension, so save it under its suggested name before opening it in a browser; a Next
  prefetch of a page URL such as `/cases/<id>/quality` looks like an API call unless the filter requires `/api/`; and a 404 that
  a test provokes on purpose has to be allowed with `diagnostics.allow`.
- Running the touched spec locally before pushing found within a few minutes what the CI job took 15 to show (a locator made
  ambiguous by a new named region): build once, then run the spec with `PW_WEB_REBUILD=0`.
- A property test that rewrites its input has to rewrite it with the rule of the code under test. The line-ending property merged
  `\r\n` pairs, which changed the meaning of a generated stray carriage return (`\r\r\n` is two breaks, `\r\n` one); a random seed
  that had not been tried before found it on a documents-only commit, and the test now uses the parser's rule
  (`packages/domain/test/ingest-parsers-properties.test.ts`). A failing run prints its seed and counterexample, so a red property
  test is a finding to read, not a flake to retry.
- A property's tolerance has to match the precision the code reports. The Avoidable Support Effort reports each renormalised weight
  to four decimals, so the weights of two components can sum to 1.0001 (found on a documents-only commit, fast-check seed
  105150624, with two denormal numbers as the only effort); the test demanded 5e-7 and now allows half a unit of the last place per
  component (`packages/domain/test/metrics-ase.test.ts`). Six further rounds of all 18 property files on fresh seeds found nothing.

**Open** (reproductions; the lead routes them):

1. **A case id that does not exist, on Possible causes and What if (then the Hypothesis Arena and the Counterfactual Lab).** Persona engineer, open
   `/cases/case_does_not_exist/hypotheses` (or `/counterfactual`). Expected: the same "We could not find that case" state as
   Case details, Score, and now Timeline and Evidence. Actual: a generic error with a Retry that cannot succeed.
2. **Text typed with no pause into a field that keeps its value in the URL can lose characters.** Persona engineer, `/cases`, focus
   the search box and type `xyz` with no delay between keys (Playwright `keyboard.type` with `delay: 0`): the field ends up with
   `xz` in 3 of 6 runs here, and 5 of 6 on another page; with 20 ms between keys it was 0 of 6. The value shown comes from
   `useSearchParams`, which updates after the key press. Matters for dictation and assistive input. Affects the Cases and SkillDNA
   searches and every field built on `useUrlState`.
3. **The time that could have been saved in Case One (Avoidable Support Effort) differed between fresh seeds (addressed by `ENGINE_VERSION` 2026.3.0).** Before it,
   five starts of the API with the seeded demo (the global
   setup prints the figure) gave 62.8, 56.3, 58.1, 61.5 and 62.8 percent; four creations of Case One's bundle under new references
   gave 57.2, 56.4, 56.4 and 57.2, and the same case analysed again three times gave 57.2 each time. The engine seeds its rollouts
   from the input hash (`computeInputHash` in `apps/api/src/services/analysis/inputs.ts`, which covers the stored payload and the
   skill library with their ids), so any difference in those inputs moved the figure. Since 2026.3.0 the rollout seed no longer
   contains the generated fork id ([EVALUATION.md](EVALUATION.md#3-engine-calibration-on-the-two-synthetic-cases)), and the figure read 55 percent
   (plausible range 44 to 83, low confidence) on each of the two fresh local starts made after that, in the review; the
   evaluation tables give 55.3 (43.7 to 83.3). The specs never assert the value, only that the UI equals the API.
4. **System status (then System Health) lists `database` as a configured service, not as simulated**, although it is PGlite running in the API process
   (`apps/api/src/container.ts`, `registerStandard('database')` has no `simulated` flag).
5. **The API's trend labels already contain the signed change** ("+63.1 points compared with ..."), while the UI contract treats a
   label as the comparison only. The component now guards against the duplicate; the cause is in the domain labels.
6. **The trend arrow of a metric card shrinks to a few pixels and sits in the middle of the wrapped line** ("Home",
   manager, 1440 px: see `docs/assets/screenshots/command-center.png`). The icon is a flex item that may shrink beside a long
   text; `flexShrink: 0` on the icon and `alignItems: 'flex-start'` on `trend` in `packages/ui/src/primitives/MetricCard.tsx` would
   fix it. Layout only, so no unit test can guard it.
7. **Presentation mode outlines "Cases" in the navigation for every case-scoped step.** `usePresenterHighlight`
   (`apps/web/src/lib/presentation/index.tsx`) also matches a link whose path is a prefix of the target, so on the last step, whose
   target is the comparison on Case Two's Score page, "Cases" is outlined and no other item is (the manager's "Quality" link
   goes to the portfolio). The outlined button in the presenter strip is right.
8. The decision-marker circles on the Timeline and Possible causes charts overlap slightly where two decisions are close (visual).
9. The route `/design-lab` (the component showcase) exists in the production build.

No test is quarantined or skipped. The tests that were timing-sensitive (the two engine-budget tests above, the one-second clock of
System status, typing into URL-synced fields) were fixed rather than retried, and focus indicators are measured by comparing
pixels, not by reading styles. Local retries stay off; CI retries a failed test once.

## 8. Not run, and not verifiable

- **Not run locally:** the CI job (CI has run it on GitHub, see section 4) and with it Chromium in CI and the `dist` and `.next` path;
  Docker and the images (CI builds them); anything that needs Azure (`az` was never run); a real PostgreSQL (CI runs the integration
  suite on one); a screen reader; Firefox and Safari; a load test.
- **Not re-run for this document:** the unit, integration and AI-evaluation suites (their counts are those of
  [EVALUATION.md](EVALUATION.md#2-test-inventory)), coverage, and the domain benchmark.
- **Cannot be verified here:** that the 45-minute CI timeout holds on a hosted runner (the local run time is in section 2, on a
  loaded laptop); the focus-indicator check compares pixels and was only calibrated on Edge.
