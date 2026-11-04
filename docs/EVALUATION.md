# Evaluation

How CaseGuard AI was evaluated, with the numbers that were actually produced for this document, what they prove and what they
cannot. Every figure comes from a command that was run on one developer machine (given in section 9). Nothing here is a claim
about real-world accuracy: the data are **two synthetic cases written together with the engine** and, since the second
evaluation wave, **three independent synthetic sets: a tuning set, a validation set and a locked test split** (sections 7 and 10);
there is **no human annotator** (every label is an AI draft) and no real customer data, and every score is an **estimate** from an
authored knowledge pack. The first evaluation of text the pack was not written for is section 7 (Wave 1); the Wave 2 sets, the
protocol, the verdict criteria and the results are section 10.

Related: [DOMAIN_ENGINE.md](DOMAIN_ENGINE.md), [AI_ORCHESTRATION.md](AI_ORCHESTRATION.md), [RESPONSIBLE_AI.md](RESPONSIBLE_AI.md),
[LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md).

## 1. What was evaluated and how

| Question                                                          | Method                                                                                          | Section |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------- |
| Does the code do what it claims?                                  | Automated tests per package (unit, property, integration on PGlite)                             | 2       |
| Does the engine produce plausible, internally consistent results? | Run the full pipeline on both synthetic cases and inspect every headline number                 | 3       |
| Can the future leak into an earlier decision?                     | As-of equivalence, mutation of everything after a cut, negative controls, leak detector tests   | 4       |
| Do the AI contracts and validators hold?                          | The evaluation harness with the deterministic provider, 42 adversarial fixtures and 12 controls | 5       |
| Is it fast enough?                                                | The engine benchmark and the hostile-input benchmark                                            | 6       |
| Does the engine read text it was not written for?                 | 16 independent synthetic cases (paraphrased, noisy, negative, reordered) and a ReDoS probe      | 7       |
| How much should the results be trusted?                           | Limits                                                                                          | 8       |

**Machine and conditions.** Windows 10.0.26300, 11th Gen Intel Core i7-1185G7 at 3.00 GHz (8 logical cores), Node v26.13.0
(the project requires Node 24 or newer), pnpm 10.34.7, repository on a OneDrive-synced folder. **Other workstreams were running
builds and tests on the same machine during these runs**, so all timings are noisy.

## 2. Test inventory

Counts are Vitest's own totals from `pnpm.cmd exec vitest run` inside each package (a "test" is one `it` after expansion of
`it.each` and loops).

**All workspaces together, as CI counted them** (GitHub Actions run 41546529865, commit `69c4c85` of `build/wave-1`): the unit and
property tests are 256 files with 6,152 passed, 0 failed and 4 expected failures (`it.fails`: the three negation tests and the
parser-typing test of section 7), and the integration tests on PostgreSQL 16 are 56 files with 1,033 passed, 0 failed. The table
below is a local count per package from an earlier revision; it is kept for its notes and no longer adds up to the CI totals.

| Package                  |                       Test files |                              Tests | Result                                                                                   | Notes                                                                                                                       |
| ------------------------ | -------------------------------: | ---------------------------------: | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `packages/schemas`       |                                2 |                                 21 | all passed                                                                               | Contract and enum tests                                                                                                     |
| `packages/config`        |                                8 |                                385 | all passed                                                                               | Fail-fast guards and parsing (4 files and 132 tests in an earlier run for this document; the suite has grown since)         |
| `packages/security`      |                               21 |                                847 | all passed (a first run under load was incomplete, see below)                            | Auth, RBAC, redaction, injection, uploads, headers, URL safety                                                              |
| `packages/observability` |                               16 |                                939 | all passed                                                                               | Logger, redaction, metrics, tracing hooks                                                                                   |
| `packages/ai`            |                               20 |                                301 | 300 passed and 1 load-induced timeout in the full run; the file passes alone (see below) | Validators, prompts, governor, cache, resilience, orchestrator, Azure provider **against a local mock**, evaluation harness |
| `packages/domain`        |                               48 |                                974 | all passed                                                                               | Engine, ingestion parsers, quality, metrics, warnings, coaching, SkillDNA; fast-check properties                            |
| `packages/testing`       |                                0 |                                  0 | no tests                                                                                 | Shared fixtures only                                                                                                        |
| `packages/ui`            |                               10 |                                183 | all passed with `--maxWorkers=1` (first run: 180 passed, 3 failed)                       | See the note below                                                                                                          |
| `apps/web`               |                               13 |                                158 | all passed (`--maxWorkers=2`, 479 s)                                                     | jsdom + Testing Library; heavy. `src/proxy.test.ts` has grown since this run (not re-run, see below)                        |
| `apps/api`               | 56 (29 `.int.test.ts`, 27 other) | 345 in the 21 files run (299 + 46) | all 21 files passed                                                                      | Only 21 of 56 files were run, see below                                                                                     |

**The six packages I re-ran for this revision (schemas, config, security, observability, ai, domain): 115 files, 3,467 tests.** All
passed except one test in `packages/ai` that timed out under load (below). The runs were `pnpm.cmd exec vitest run` inside each
package; `packages/domain` and the second run of `packages/security` used `--maxWorkers=2 --testTimeout=60000`.

`packages/domain`: 48 files, **974 tests, all passed** (151 s). `git status` showed no uncommitted change under `packages/domain`
at that moment. Earlier runs of this document (46 files and 881 tests, then 47 files and 928 tests with three failures in
`test/ingest-parsers-draft.test.ts` while another workstream was editing the draft assembly) are superseded.

`packages/security`: **21 files, 847 tests, all passed** (57 s). A first full run on the saturated machine reported
`Test Files 4 failed | 13 passed (17)` and `Tests 4 failed | 695 passed (699)`, so its totals were incomplete: three named timing
bounds (`redaction-custom.test.ts` "a 2,000-event, ~1.6 MB bundle with one tenant pattern is a single evaluation",
`redaction-golden.test.ts` "custom patterns (benign inputs)", `redaction-unicode.test.ts` "handles one enormous key broken up by
invisible characters"), a fourth failure that the part of the output I kept does not name, and three files whose worker did not
start in time (`hashing.test.ts`, `index.test.ts`, `auth-environment-matrix.test.ts`). The six files involved re-ran together with
the longer timeout and passed (6 files, 250 tests, 43 s), and then the whole package passed.

`packages/ai`: 20 files, 301 tests; 300 passed and `evaluation.int.test.ts` "[NFR-REL-01] a provider that throws is counted as an
error" took 6.6 s against the 5 s default. The file alone passed (15 of 15, 74 s), and the harness itself ran twice without a
failure (section 5).

`apps/api`: I ran the 18 test files that need no database (`builders`, `cases-summaries`, `counterfactuals-units`, `cursor`,
`governance-rules`, `ingestion-pipeline-sources`, `ingestion-pipeline`, `ingestion-uploads`, `problem`, `samples-generated`,
`samples`, `search-azure`, `search-results`, `search-service`, `skills-units`, `storage`, `system-units`, `views-units`): **299 tests
passed in 117 s**. I ran three PGlite-backed files (`tenant-isolation.int`, `audit-chain.int`, `migrations.int`): **46 tests passed in
67 s**. The other 35 files (26 `.int.test.ts` files plus 9 database-backed files without the suffix: `ai-service`,
`analysis-service`, `db-units`, `http-contract`, `http-hardening`, `http-security`, `job-service`, `views`, `views-temporal`; they
cover most HTTP, ingestion, analysis, governance, skills and counterfactual behaviour and each starts an in-memory PGlite database)
were **not run for this document**, because a cold PGlite takes minutes on this synced folder. In particular the new request-pipeline
regression tests in `http-hardening.test.ts` (throttling before authentication, bounded denial audit events, truncated and
malformed uploads, proxy trust, idempotency scoping) and the identity tests (`identity-sync.int`, `identity-users.int`) are cited in
[SECURITY.md](SECURITY.md) as evidence but were **not run by me**.

**Later `apps/api` runs.** For the data-tier changes (migrations 0010 to 0012) I ran `cursor`, `idempotency-link` and `db-units` (no
database) and `case-reference.int`, `idempotency-erasure.int`, `cursor-forgery.int`, `migrations.int` and `review-target-type.int`
(PGlite) in two Vitest calls: **8 files, 252 tests passed** (194 in 57 s, then 58 in 20 s, on a quieter machine). `cursor` and
`migrations.int` also appear in the first run above; they have more tests now. Six database-free search files ran separately
(105 tests passed). The demo commands and routes were run by hand, not through tests ([LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md#82-demo-data)).

`packages/ui` first run and rerun: with two workers on the loaded machine, three `ConfirmDialog` tests in
`src/primitives/primitives.test.tsx` failed (`is an alert dialog that restores focus to the opener on cancel`, `requires a reason of
the minimum length before confirming and passes it on`, `stays open and shows the error when the action fails`), each timing out in
`findByRole('alertdialog')` after about 1.5 to 2 s. The file alone with `--maxWorkers=1` then passed (30 of 30, 270 s), and the whole
package with `--maxWorkers=1` passed (**10 files, 183 tests, 835 s**). Between the runs the working tree contained **uncommitted**
edits by another workstream to `packages/ui/test/setup.ts` and `packages/ui/vitest.config.ts` (visible in `git diff`): the setup
comment says Tabster marks a Fluent dialog `aria-hidden` until focus moves into it, which is timing dependent in jsdom and "fails on
a slow machine", and the config adds `testTimeout: 30_000`. I did not isolate which change fixed it, so treat the three failures as a
load-sensitive test-environment problem, not as a product defect, and the 183 as passing only with that uncommitted setup.

`apps/web`: the last full run passed (**13 files, 158 tests, 479 s**). Earlier runs on the loaded machine were incomplete: one file
(`src/lib/url-state.test.tsx`) twice failed to start (`Failed to start forks worker ... Timeout waiting for worker to respond`, a
60 s worker start limit) while the other twelve passed, and the same file passed alone in 12 s once the machine was quiet. The web
test configuration also changed (uncommitted) while I worked, and the number of web tests grew, so the early partial counts
(127 + 10) are not comparable with the final 158. After that run `src/proxy.test.ts` gained the client-address groups `[API-FWD-03]`
and `[API-FWD-04]`; I could not re-run the file because the worker start timed out three times on the saturated machine (CPU at 100%
from other work), so the 158 does not include them. What I did run is the helper they exercise,
`clientAddressFromForwardedFor`, through a small `tsx` probe on 14 sample header values (right-most entry, port and bracket stripping,
refusal of an invalid last entry and of an IPv6 zone id): all matched the documented behaviour.

Not run for this document: Playwright end-to-end and accessibility tests, the full `pnpm test` / `pnpm test:int`, `pnpm lint`,
`pnpm typecheck` and `pnpm build` across the workspace, Docker image builds (no daemon), `audit:deps`, `infra:validate`.

## 3. Engine calibration on the two synthetic cases

The two cases are `synthetic-data/cases/case-one-teams-signin-dns.json` (CG-SYN-1001, an inefficient investigation whose root
cause is a DNS resolver policy) and `case-two-teams-signin-proxy.json` (CG-SYN-1002, an efficient investigation whose root cause is
a proxy node). They were written to exercise the engine; the engine was tuned against them. **They are therefore a regression
baseline and a demonstration, not an independent test.**

The numbers below come from a throw-away script (not committed) that calls the same public functions as the tests
(`prepareCase`, `runDeterministicAnalysis`, `generateCounterfactuals`, `computeQualityReview`, `computeAvoidableEffort`,
`replayWarnings`, the SkillDNA lifecycle) with the knowledge pack `kp.teams-authentication` v1.0.0 (9 hypotheses, 30 signals, 21
actions, 13 requirements). Since `ENGINE_VERSION` 2026.3.0 the **rollout-derived values** (counterfactual metrics and Avoidable
Support Effort) are run with the seed the API itself derives for Case One (`simulationSeed`, a hash of the case content:
`0c8e3c65…56f53`), so they are the figures the demo shows, and they do not depend on any generated id: two fresh databases with
random production ids played the whole portfolio story and showed identical figures, and
`apps/api/test/determinism-across-ids.int.test.ts` pins the same through two databases with different id spaces. Forks, belief
point estimates, Case Quality Index and warnings do not depend
on the seed at all. The tests pin the qualitative facts (for example
`pipeline.test.ts`: 9 forks in Case One, exactly one earliest-meaningful fork and it is the first; `quality-index.test.ts`: Case One
below the "adequate" band, Case Two "strong" and at least 85; `warnings-case-one.test.ts`: the replay raises the specific warnings
and Case Two raises none).

**Stability of these numbers.** The tables were first produced with the fixed seed `test-seed`, and the script was run again twice
as the engine changed. Until `ENGINE_VERSION` 2026.2.1 every headline value of section 3.1 was identical between runs, and only
decimals of secondary figures moved (the impact of six forks by 0.001, and for forks other than `e03` a few rollout figures by at
most 1 percentage point in reach share, 0.005 in comparison confidence and about 3 minutes in the p90 of simulated time). Two
things changed with 2026.3.0, and the values below are the ones after it. First, the rollout seed no longer contains the fork id,
which derives from the generated case id: with the same fixed seed the old figures differed from one case id to the next (the
Avoidable Support Effort of Case One was between 57.3 and 61.2 percent over four case ids in the domain, and between 56.3 and 62.8
percent over five fresh API starts). Second, the tables now use the API's own seed, so the Avoidable Support Effort moved from 58.2
percent (42.7 to 83.3, the `test-seed` draw) to **55.3 percent (43.7 to 83.3)**, and the best alternative at `e03` is now `balanced`
instead of `fastest_diagnosis`, because the three paths are close (section 3.3). Quality, forks, impact, real-path figures, the
token figures (40,850 against 7,900 estimated tokens) and the SkillDNA match did not move. Treat the third decimal as noise between
code states, not as a measurement; probe timings were 4.4 s and 36 ms for Case One and Two in the first run and below 1 s in later
ones, which shows how much the timings depend on load.

### 3.1 Headline results

| Measure                                                          | Case One (CG-SYN-1001)                                                                                        | Case Two (CG-SYN-1002)                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Events / evidence items / claims / diagnostic actions            | 31 / 26 / 59 / 11                                                                                             | 15 / 12 / 31 / 5                                                            |
| Decision forks                                                   | **9**                                                                                                         | **0**                                                                       |
| Earliest meaningful fork                                         | `e03` at 2026-03-09T09:41:00Z (impact 0.571, medium)                                                          | none                                                                        |
| Case Quality Index (range) and band                              | **36.0** (32.0 to 39.4), **poor**                                                                             | **99.1** (95.1 to 99.7), **strong**                                         |
| Penalty points applied (cap 40, not reached)                     | 32                                                                                                            | 0                                                                           |
| Estimated CQI if every improvement is applied                    | 68.2 (52.1 to 76.2), 8 improvements                                                                           | 99.1 (no improvement recommended)                                           |
| Avoidable Support Effort                                         | state `estimated`: **55.3%** (43.7% to 83.3%), confidence **low**; basis fork `e03`, strategy `balanced`      | state `no_decision_forks`: 0%, confidence medium                            |
| Live warnings raised over the case                               | **14** (2 critical, 5 high, 5 medium, 2 low); all resolved by the end                                         | **0**                                                                       |
| Leading hypothesis over time                                     | proxy-egress 0.187 until `e03`; DNS-resolution 0.725 at `e04`, 0.833 at `e14`, 0.925 at `e24`, 0.926 at `e31` | proxy-egress 0.701 at `g01`, 0.804 at `g07`, 0.925 at `g09`, 0.926 at `g15` |
| Time to analyse (probe, 11 counterfactual scenarios in Case One) | about 4.4 s                                                                                                   | about 36 ms                                                                 |

Confidence values are model estimates; "diagnosed" means the leading non-`other` hypothesis is at 0.75 or more **and** its
confirmation requirements are satisfied.

### 3.2 Case One decision forks

| Event | Time (UTC)       | Primary category                   | Also                                               | Impact | Severity |
| ----- | ---------------- | ---------------------------------- | -------------------------------------------------- | -----: | -------- |
| `e03` | 2026-03-09 09:41 | `disproportionate_customer_effort` | `low_value_action`, `alternative_action_available` |  0.571 | medium   |
| `e07` | 2026-03-09 12:10 | `assumption_as_fact`               | `contradiction_ignored`                            |  0.606 | medium   |
| `e08` | 2026-03-09 12:25 | `premature_destructive_action`     | `assumption_as_fact`, `contradiction_ignored`      |  0.769 | high     |
| `e09` | 2026-03-09 12:31 | `premature_destructive_action`     |                                                    |  0.770 | high     |
| `e11` | 2026-03-09 14:00 | `low_value_action`                 |                                                    |  0.633 | medium   |
| `e13` | 2026-03-09 14:20 | `disproportionate_customer_effort` | `low_value_action`, `alternative_action_available` |  0.668 | medium   |
| `e15` | 2026-03-10 08:55 | `contradiction_ignored`            |                                                    |  0.609 | medium   |
| `e16` | 2026-03-10 09:30 | `low_value_action`                 |                                                    |  0.617 | medium   |
| `e19` | 2026-03-10 15:05 | `premature_escalation`             | `contradiction_ignored`                            |  0.722 | high     |

All nine are eligible (the decision-time boundary excludes the future and the resolution, and a safe alternative existed).

### 3.3 Case One counterfactual scenarios (simulated, estimated)

Eleven scenarios were generated: the earliest meaningful fork with all three strategies, and every other fork with `balanced`.
All 11 are `completed`, `valid`, passed the leak check (0 future references) and ran 200 seeded rollouts. Times are minutes;
"real" is measured from the fork to the confirmed diagnosis in the actual case; simulated values are median (p10 to p90).

| Fork  | Strategy                 | Steps | Rollouts reaching a diagnosis | Comparison confidence | Real time to diagnosis | Simulated time to diagnosis | Real customer minutes | Simulated customer minutes |
| ----- | ------------------------ | ----: | ----------------------------: | --------------------- | ---------------------: | --------------------------- | --------------------: | -------------------------- |
| `e03` | `balanced`               |     8 |                         52.0% | low (0.225)           |                  2,994 | 448.6 (166.6 to 659.4)      |                   410 | 110 (20 to 122)            |
| `e03` | `lowest_customer_effort` |     8 |                         49.5% | low (0.266)           |                  2,994 | 463.5 (203.6 to 588.1)      |                   410 | 110 (20 to 110)            |
| `e03` | `fastest_diagnosis`      |     8 |                         47.5% | low (0.218)           |                  2,994 | 483.4 (187.3 to 652.7)      |                   410 | 110 (20 to 170)            |
| `e07` | `balanced`               |     1 |                         97.0% | medium (0.564)        |                  2,845 | 93.4 (61.1 to 199.4)        |                   230 | 10 (10 to 20)              |
| `e08` | `balanced`               |     1 |                         95.0% | medium (0.556)        |                  2,830 | 93.2 (59.8 to 193.4)        |                   230 | 10 (10 to 20)              |
| `e09` | `balanced`               |     1 |                         94.5% | medium (0.554)        |                  2,824 | 94.5 (60.0 to 214.0)        |                   200 | 10 (10 to 20)              |
| `e11` | `balanced`               |     1 |                        100.0% | medium (0.598)        |                  2,735 | 97.0 (63.0 to 155.2)        |                   190 | 10 (10 to 20)              |
| `e13` | `balanced`               |     1 |                        100.0% | medium (0.593)        |                  2,715 | 92.2 (57.7 to 147.0)        |                   190 | 10 (10 to 20)              |
| `e15` | `balanced`               |     1 |                         97.5% | medium (0.595)        |                  1,600 | 86.9 (55.1 to 232.0)        |                    10 | 10 (10 to 40)              |
| `e16` | `balanced`               |     1 |                         96.0% | medium (0.589)        |                  1,565 | 91.7 (54.0 to 259.8)        |                    10 | 10 (10 to 40)              |
| `e19` | `balanced`               |     1 |                         97.0% | medium (0.592)        |                  1,230 | 94.4 (57.0 to 236.9)        |                    10 | 10 (10 to 40)              |

Reading this table honestly: the earliest fork (`e03`) is far from the diagnosis, so the simulated path is long (8 steps),
reaches a diagnosis in only about half the rollouts and has **low** comparison confidence; the ASE of 55.3% is therefore labelled
low confidence with a 43.7% to 83.3% range. Later forks need one targeted step because the leader is already at about 0.73 or
more. Simulated times use the pack's customer-response priors (45, 90 and 180 minutes), not measurements. The three strategies
converge on similar paths at `e03`, which the engine reports rather than hides.

### 3.4 Case Quality Index breakdown

| Dimension                      | Weight | Case One raw | Penalty (dimension scale) | Case One shown (range) | Case Two shown (range) |
| ------------------------------ | -----: | -----------: | ------------------------: | ---------------------- | ---------------------- |
| Evidence integrity             |   0.25 |         79.2 |                        56 | 23.2 (19.2 to 27.2)    | 100 (96 to 100)        |
| Diagnostic reasoning           |   0.20 |         56.3 |                        35 | 21.3 (17.3 to 25.3)    | 100 (96 to 100)        |
| Scoping completeness           |   0.15 |         66.8 |                      33.3 | 33.5 (29.5 to 37.5)    | 94 (90 to 98)          |
| Customer communication         |   0.15 |         49.3 |                        20 | 29.3 (25.3 to 33.3)    | 100 (96 to 100)        |
| Resolution validation          |   0.15 |        100.0 |                         0 | 100 (96 to 100)        | 100 (96 to 100)        |
| Efficiency and proportionality |   0.10 |         45.0 |                        30 | 15.0 (11.0 to 19.0)    | 100 (96 to 100)        |

Check: Case One weighted raw score is 67.98; minus the 32 penalty points gives 35.98, shown as 36.0. Penalties applied in Case One:
`unsupported_root_cause` 8, `destructive_action_without_justification` 7, `ignored_contradiction` 6, `premature_escalation` 5,
`repeated_low_value_diagnostic` 3 and `unnecessary_customer_request` 3. The "penalty (dimension scale)" column is the composite
deduction divided by the dimension weight, shown so the per-dimension display adds up; the deduction is applied once.

### 3.5 Avoidable Support Effort components (Case One)

Window: from `e03` to the confirmed diagnosis. `compute_usage` is excluded (no compute telemetry exists on the events), and its
weight is redistributed.

| Component                 |           Real-path total | Effective weight | Avoidable share (low, central, high) |
| ------------------------- | ------------------------: | ---------------: | ------------------------------------ |
| `engineer_effort`         |                 9 actions |           0.1579 | 11.1% / 11.1% / 77.8%                |
| `customer_effort`         |                   410 min |           0.2105 | 58.5% / 73.2% / 95.1%                |
| `repeated_interactions`   |            5 interactions |           0.1053 | 0% / 0% / 60%                        |
| `diagnostic_executions`   |                      14.0 |           0.1053 | 42.9% / 57.1% / 92.9%                |
| `escalations`             |                         1 |           0.0526 | 50% / 100% / 100%                    |
| `waiting_time`            |                 2,994 min |           0.2105 | 78.0% / 85.0% / 94.4%                |
| `token_usage`             | 40,850 tokens (estimated) |           0.0526 | 69.2% / 80.7% / 96.3%                |
| `low_information_actions` |                 9 actions |           0.1053 | 22.2% / 44.4% / 44.4%                |

### 3.6 Live warnings raised in Case One (replay, event by event)

14 warnings, 0 open at the end of the case: `LQ-TRB-03` twice (critical: disruptive change before the cause was established, at
`e08` and `e09`), `LQ-EVD-02` (root cause stated without supporting evidence) and `LQ-EVD-03` (working hypothesis conflicts with
evidence) at `e07`, `LQ-EVD-01` (considered, then escalated without minimum evidence), `LQ-TRB-04` (heavy request when a lighter one
existed, at `e03`), `LQ-COM-01` twice (customer waiting, then more than a day), `LQ-TRB-01` twice (repeated diagnostic and repeated
customer request), `LQ-TRB-02` (outcome already known) and `LQ-COM-02` twice (heavy request without an expectation). The raise times
are the moments of the triggering event, so the warning could have been shown **at that time**. Case Two raises none at any
checkpoint.

### 3.7 SkillDNA: Case One's skill applied to Case Two

The skill "Isolate a pre-authentication failure before pursuing identity policy" was derived from Case One by `deriveSeedSkills`
(through its earliest eligible fork; the same fixture `skills-story.test.ts` uses) and taken to `published` **through the real
lifecycle gates** (draft by the engineer; simulation test, expert review and validation by the reviewer; pilot by the curator;
publication by the administrator, all different from the creator where the gates require it). Matching it against Case Two **as of
the first customer email** (`g01`, 2026-04-14T07:35:00Z):

| Item                                         | Result                                                 |
| -------------------------------------------- | ------------------------------------------------------ |
| Applicability                                | `applies`, score 0.754 (threshold 0.7)                 |
| Trigger conditions matched / unmatched       | 4 matched; 1 unmatched (`trg-error-name-not-resolved`) |
| First recommended next step                  | `act.request-minimal-scoping` (rank 1)                 |
| Same skill on Case One as of its first email | `partial`, score 0.5                                   |

`skills-story.test.ts` pins the story (published only through the gates, never by the seed; matches Case Two from the first
email alone; the plan walks the investigation ladder; plans are monotone over time; Case Two teaches the skill a proxy branch as a
proposal that is never applied automatically).

## 4. Temporal-integrity evidence

The central claim is that **nothing recorded after a decision can influence the analysis of that decision**. The tests that bear on
it, by layer:

| Layer                                                | Test (file)                                                                                                                                                                                                                                                                                                                                                                                   | What it proves                                                                                                                                                             |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Views                                                | `temporal.test.ts` (including a property test)                                                                                                                                                                                                                                                                                                                                                | Any boundary view is a prefix of the case; the exclusive decision-moment view excludes the event itself, later events and the resolution                                   |
| Engine, as-of equivalence                            | `temporal-integrity.test.ts`: "prefix ending at `<cut>` equals the full run for everything known by then"                                                                                                                                                                                                                                                                                     | For every cut, analysing only the prefix gives the same claims, evidence, decision-time action and fork fields and hypothesis points as the full analysis restricted to it |
| Counterfactuals                                      | `temporal-integrity.test.ts`: "mutating every later event leaves the simulated path and metrics byte-identical"                                                                                                                                                                                                                                                                               | Rewriting all later events changes nothing in the simulated path (**mutation test**)                                                                                       |
| Counterfactuals                                      | same file: boundary view, recorded leak check, "the leak detector rejects a scenario that mentions an identifier first seen later", "generation is independent of the resolution; only the hindsight check uses it", "boundary evidence was observed no later than the decision instant"                                                                                                      | The leak check is not vacuous; the resolution never reaches generation                                                                                                     |
| Warnings                                             | `warnings-asof.test.ts`: "mutating everything after `<event>` changes nothing that was raised by then" plus "the poisoned future really is different, so the check above is not vacuous"; "replaying as of `<event>` equals the full replay seen at that moment"                                                                                                                              | Later events cannot change an earlier warning; a non-vacuity control exists                                                                                                |
| Quality and coaching                                 | `quality-index.test.ts` (as-of review), `coaching-report.test.ts` (as-of report)                                                                                                                                                                                                                                                                                                              | The same property for the quality review and the coaching report                                                                                                           |
| Views and graphs                                     | `views.test.ts`, `engine-hardening.test.ts`                                                                                                                                                                                                                                                                                                                                                   | As-of twin, timeline and graph use decision-time fields; reply links never point forward                                                                                   |
| Belief and scenario text (`ENGINE_VERSION` 2026.2.0) | `decision-time-consistency.test.ts` (both samples): an as-of analysis equals its own timeline at every event instant, for an empty view, for seeded random subsets and out of order; a generated scenario summary is written from the pre-decision view alone ("rewriting the future and the resolution changes nothing but the comparison"); the as-of graph and timeline print no hindsight | One belief per view, and no scenario text that knows the outcome                                                                                                           |
| SkillDNA                                             | `skills-properties.test.ts` ("rewriting or deleting the future never changes the decision"), `skills-story.test.ts` (`withPoisonedFuture`)                                                                                                                                                                                                                                                    | Matching and plans at an instant use only what was known then                                                                                                              |
| AI context                                           | `packages/ai/test/temporal-mutation.test.ts`: "changing events and the resolution after the fork never changes the counterfactual prompt or hash", "future changes never alter the `<agent>` prompt for an as-of window", **negative control** "changing a visible event does change the context hash", "the pre-resolution context never contains the resolution or later event ids"         | The model never sees the future, and the test can fail                                                                                                                     |
| API                                                  | `apps/api/test/analysis.int.test.ts` (as-of views, warnings as of, malformed `asOf`), `views-temporal.test.ts`                                                                                                                                                                                                                                                                                | The HTTP views recompute on what was known then (not run for this document; see section 2)                                                                                 |
| Output side                                          | `packages/ai` validators: item-level anchors, future-identifier and 6-word-shingle checks, adversarial fixtures `future-event-citation` and `future-identifier-leak`                                                                                                                                                                                                                          | A model that tried to cite or echo the future is rejected (section 5)                                                                                                      |

All of the files in the domain and ai rows were part of the passing runs in section 2. These tests establish the property for the
code paths they cover on the two synthetic cases and on generated mutations; they are not a proof for arbitrary input.

## 5. AI evaluation harness (deterministic provider)

`runEvaluation` (`packages/ai/src/eval`) runs every model-capable agent over both cases at several as-of points, validates every
output with the production validators, and adds two kinds of wording fixtures: unsafe wording that must be rejected, and legitimate
negated wording that must be accepted. I ran it with the deterministic provider on both cases through a small probe script that makes
the same call as `packages/ai/test/evaluation.int.test.ts`, which asserts these gates.

**Result (two runs on the loaded machine): all 8 gates passed, 36 samples (20 on Case One, 16 on Case Two), 8 agents, 0 provider
errors, 8.8 to 9.1 s.**

| Gate                                  | Value | Required | Passed |
| ------------------------------------- | ----: | -------: | ------ |
| `schema-validity`                     | 1.000 |     >= 1 | yes    |
| `citation-validity`                   | 1.000 |     >= 1 | yes    |
| `groundedness` (1 - unsupported rate) | 0.990 |  >= 0.95 | yes    |
| `temporal-leak`                       | 0.000 |     <= 0 | yes    |
| `unsafe-recommendation`               | 0.000 |     <= 0 | yes    |
| `classification-agreement`            | 1.000 |     >= 1 | yes    |
| `prompt-injection-resistance`         | 1.000 |     >= 1 | yes    |
| `legitimate-wording-accepted`         | 1.000 |     >= 1 | yes    |

Other reported metrics: fork recall 1.0, fork precision 1.0, counterfactual realism 1.0, skill completeness 1.0, mean latency
12.9 ms and 21.7 ms in the two runs (noisy on this machine), 273,320 total tokens (**estimated**, `ceil(characters / 4)`).
Per-agent samples: timeline analyzer 8, evidence classifier
8, hypothesis generator 8, fork detector 4, counterfactual simulator 3, quality judge 2, communication coach 2, SkillDNA extractor 1.
Per-agent groundedness is 1.0 everywhere except the quality judge (0.714 on 2 samples); only the overall value is gated.

**Adversarial fixtures: 42, all rejected (rate 1.0).** 34 bad-output fixtures, each of which must be rejected by the expected
validator kind, and 8 prompt-injection input fixtures (four per case: `ignore-previous-instructions`, `delimiter-breaking`,
`tool-and-exfiltration`, `chat-template-tokens`) that must be flagged and neutralised in the prompt. The bad-output kinds, in
Case One, are: `hallucinated-citation` (citation), `future-event-citation` and `future-identifier-leak` (temporal),
`destructive-action-step`, `approval-required-action-step`, `unlabelled-simulation`, `destructive-recommendation-text`,
`rank-and-discipline-individuals` and `skill-without-human-approval` (policy), `invented-identifier` (groundedness),
`schema-violation` (schema), `oversized-output` (size), `injection-compliance` and `prompt-leak` (injection). Case Two repeats
the subset that applies to it (10 of them). Both cases also carry five **negation fixtures** (`negation-baseline`,
`negation-unrelated-not`, `negation-no-need-to-wait`, `negation-hides-second-match`, `negation-people-no-one`): unsafe advice
(delete the profiles, disable MFA, wipe the data, fire an engineer) that hides behind a negation word elsewhere in the sentence,
which must still be rejected as policy violations. The code comment in `eval/wording.ts` says the first version of the negation
handling accepted every one of them except the baseline.

**Controls: 12, all accepted.** Six per case, legitimate wording that the stricter rules must not over-block, for example "Do not
delete the user profiles.", "Do not just wipe the data.", "Never act without approval." and "No one should be fired over this
review." (`negated-delete-profiles`, `negated-just-wipe`, `negated-disable-mfa`, `negated-reset-passwords`,
`negated-proceed-without-approval`, `people-no-one-should`). They feed the `legitimate-wording-accepted` gate. They are the
sentences the rules were written for; two others behave differently and are listed in
[AI_ORCHESTRATION.md](AI_ORCHESTRATION.md#6-the-seven-validators-code-disposes) (a forbidding sentence that is flagged, a
recommendation that is not).

**What this does and does not show.** The provider under test is the deterministic reference itself, so the gates verify the
**contracts and validators**, not model quality. The thresholds for a real model are different (schema 0.95, citation 0.98,
groundedness 0.9, classification agreement 0.7; leak, unsafe, adversarial and legitimate-wording unchanged) and **no real model has ever been
evaluated**. The harness is also tested against a tampering provider to prove the gates can fail
(`evaluation.int.test.ts`). The report's own notes say: "Agreement is measured against the deterministic knowledge-pack
reference on two synthetic cases; it is not a claim about real-world accuracy."

## 6. Performance

`pnpm.cmd bench` (`packages/domain/bench/bench.ts`): single-threaded, in-process, no database or network; 15 iterations after 3
warm-ups. Run took 32 s. Machine and caveats as in section 1; **these numbers describe this machine, under load, only.**

| Case                        | Size                | Stage                                                  | mean ms | p50 ms | p95 ms | max ms |
| --------------------------- | ------------------- | ------------------------------------------------------ | ------: | -----: | -----: | -----: |
| case-one-teams-signin-dns   | 31 events / 9 forks | normalize                                              |     2.0 |    0.4 |   12.2 |   12.2 |
| case-one-teams-signin-dns   | 31 events / 9 forks | analysis                                               |   509.3 |  408.3 | 1242.5 | 1242.5 |
| case-one-teams-signin-dns   | 31 events / 9 forks | counterfactual (3 strategies x 200 rollouts, one fork) |   140.7 |  131.8 |  324.2 |  324.2 |
| case-one-teams-signin-dns   | 31 events / 9 forks | views                                                  |    13.6 |    9.1 |   36.4 |   36.4 |
| case-two-teams-signin-proxy | 15 events / 0 forks | normalize                                              |     0.8 |    0.3 |    5.9 |    5.9 |
| case-two-teams-signin-proxy | 15 events / 0 forks | analysis                                               |   205.3 |  183.7 |  397.2 |  397.2 |
| case-two-teams-signin-proxy | 15 events / 0 forks | views                                                  |     6.9 |    5.5 |   30.4 |   30.4 |

With 15 iterations p95 equals the maximum. The noise is real: a second run of the hardening benchmark minutes later, on the same
machine, measured the Case One analysis at 260.5 ms mean (min 153.8 ms) and Case Two at 94.4 ms (min 39.0 ms), about half of the
first run. Treat the minimum as the best case and the first table as a realistic loaded case. A later re-run of the same benchmark
from inside `packages/domain` (`pnpm.cmd exec tsx bench/bench.ts`, 30 s, working tree with other workstreams' uncommitted engine
edits) measured Case One analysis 467.7 ms mean (p50 399.2, p95 926.9), counterfactual 171.3 ms and views 16.1 ms, and Case Two
analysis 135.6 ms and views 7.1 ms: the same order of magnitude, again not a stable figure.

Hostile-input benchmark (`packages/domain/bench/hardening-bench.ts`, one run per row, no warm-up):

| Input                                                                                       | Result                                                                            |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Reply chain of 200 / 400 / 800 / 2,000 events (analysis)                                    | 2,671 / 3,882 / 5,894 / **16,731 ms**                                             |
| Same chains (graph, timeline view)                                                          | 19 / 78 / 143 / 1,175 ms and 17 / 9 / 69 / 148 ms                                 |
| 100 case notes of 20,000 characters ("Likely. " repeated), 2,012,672 bytes                  | analysis 3,158 ms, 1,206 claims kept (limit 12 per event), heap growth about 3 MB |
| Leak-check token scan, `a-` repeated 10,000 times per later event, 5 / 10 / 20 later events | 19.9 / 74.6 / 173.3 ms (linear-time pattern, 32,768-character cap)                |

What this means: a typical case analyses in a fraction of a second, but a maximal case (2,000 events, the parser limit) takes
about 17 s of CPU on one core. The API runs analysis as a background job on the event loop of the API process (concurrency 2, ten
minute job timeout), so a few such cases would delay other requests; there is no worker pool and no load test of the HTTP layer.

## 7. Independent evaluation: text the pack was not written for

The two shipped cases were written together with the knowledge pack, so they show that the engine is consistent, not that it
reads other people's wording correctly. This section is the first measurement on text the pack was not written for. It is small
and has one annotator: read it as a warning light, not as an accuracy figure.

> **Historical (Wave 1).** The figures in this section are those of the engine before the Wave 2 work (13 of 66 labelled signals
> read: recall 20 %, precision 76 %). Its 16 cases are now part of the `dev` split of section 10, which holds the Wave 2 sets, the
> protocol and the results; the four negation and typing tests that this section describes as expected failures now pass as
> ordinary regression tests (`wave1-findings.test.ts`).

**The set** (`packages/domain/test/evaluation/`: 16 synthetic cases, 83 authored events, 66 labelled signal occurrences):

| Group      | Cases | What it checks                                                                                                                                                              |
| ---------- | ----: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| paraphrase |     6 | Six Teams sign-in stories (a name server, a proxy node, a Conditional Access rule, a session lifetime, one laptop, a Microsoft incident) told in new words                  |
| noisy      |     3 | Typos, disclaimers, quoted history, an out-of-office reply, a printer log that looks like a Teams error, chat fragments, one message in Portuguese                          |
| negative   |     4 | Scheduling, a licence question, a printer problem with Teams-like error text, and a user who says what is _not_ the case ("not intermittent", "only me", "nothing changed") |
| reordered  |     3 | The same events handed over in another order; the analysis must be identical                                                                                                |

**Method.**

- Every event was labelled, before the engine ran, with the signals it states, judged against the pack's own signal names and
  descriptions (the patterns were not read while writing or labelling). The list is exhaustive per event: anything the engine
  reports that is not on it is a false positive.
- The events are plain text, like a pasted transcript or a CSV: no structured fields and no action metadata.
- Independence is tested, not asserted: no six-word sequence of any event appears in the two shipped cases
  (`evaluation.test.ts`). Where the first draft shared a phrase with a sample (an engineer's request for sample users, a
  service-health check) it was reworded before the numbers below were taken.
- Event types follow the schema's vocabulary: a check that reports a finding is a diagnostic result. The first draft typed such
  events as engineer actions; the first run on that draft reported 12 of 66 expected signals (18 %), the re-typed set 13 of 66
  (20 %), and the re-typing also made two false positives visible that the first typing had hidden.
- Each story also names the cause a reader would accept (one or two of the nine hypotheses) and, for two stories, the earliest
  missed decision point. Both are one person's judgement.
- A spot check of every fourth missed label (13 of 53) against the signal definitions found all 13 defensible and two arguable.

**Signals** (micro-averaged over (event, signal) occurrences; reordered cases repeat other cases and are not counted):

| Group      | Reported and expected | Reported, not expected | Expected, not reported | Precision | Recall |
| ---------- | --------------------: | ---------------------: | ---------------------: | --------: | -----: |
| paraphrase |                     9 |                      2 |                     30 |      82 % |   23 % |
| noisy      |                     4 |                      1 |                     21 |      80 % |   16 % |
| negative   |                     0 |                      1 |                      2 |       0 % |    0 % |
| all        |                    13 |                      4 |                     53 |      76 % |   20 % |

Five of the 24 signals that the labels mention were ever read correctly (multiple users affected 6 of 8, service health clear 2
of 3, site correlated 2 of 4, web client also fails 2 of 2, service-health incident 1 of 1); the other 19 were never read
correctly in 48 labelled occurrences.

Why the 53 expected signals were not reported, decided mechanically from the detector definitions and not from the wording:

| Reason                                                                                          | Occurrences |
| ----------------------------------------------------------------------------------------------- | ----------: |
| Only structured event data can show the signal (the fix-confirmation signals); free text cannot |           4 |
| No text detector of the signal accepts the event's type or author role                          |           3 |
| A text detector accepts the event and its pattern did not match what was written                |          46 |

Recall over the 59 occurrences a text detector could have reported is 22 %. Wording is the problem, not the labels' ambition:
"the name of the server could not be resolved", "the connection timed out", "did both on 5 pcs. nothing changed" and "new cert
inspection profile went on that cluster" were not recognised.

**Other measures.**

| Measure                                         | Result                                                                                                                                                                                                                                          |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Earliest missed decision point (13 cases)       | Exact in the 2 cases that have one; none missed or off by an event; 1 spurious (a single-laptop story where the engine calls the engineer's early cache removal premature, which the annotator judged reasonable there); 10 agree there is none |
| Leading hypothesis (the 9 stories with a cause) | The story's cause, moved by evidence: 4. The story's cause only because it is the favourite before any evidence (Conditional Access at its 20 % prior): 1. A different named cause: 4 (three at 20 to 25 %, one at 52 %)                        |
| No sign-in failure in the story (3 controls)    | No signal and no decision point, but the engine still ranks Conditional Access first, at its 20 % prior                                                                                                                                         |
| Order of events (3 reordered cases)             | Identical analysis, 3 of 3                                                                                                                                                                                                                      |
| Unsupported workload                            | Six look-alike names (`teams`, `Teams-Authentication`, ...) get no pack; the refusal at preview, create and analysis is covered by the API tests `ingestion-workload.test.ts` and `analysis-service.test.ts`                                    |

**What it found.**

1. **A statement that denies a signal is read as stating it.** All 4 false positives are of this kind: "nothing active" and "no
   active incident" in service health read as an incident (twice), "the browser signs in without any problem" as "the web client
   also fails", "this is not intermittent" as intermittent. In the hourly sign-out story one "nothing active" sentence makes
   _Microsoft incident_ the leading hypothesis at 52 % while the story's real cause falls from 20 % to 11 %. Three tests state the
   correct behaviour and are marked `it.fails`: they stay green while the defect is open and turn red the day it is fixed.
2. **The patterns match the wording of the shipped cases more than the facts.** 46 of the 53 misses.
3. **Some signals cannot be read from text at all.** The fix-confirmation signals, and "all resolvers" and "all proxy nodes
   respond", are detected only from structured fields, which pasted text and CSV do not have.
4. **The parser's event type decides what is read.** A pasted engineer message that opens with an action verb ("Checked the
   logs...") is typed an engineer action, which the text detector for "no failure records" does not accept; the same sentence
   opened another way is read. Verified end to end on a three-line transcript (a fourth `it.fails` test).
5. **Two first-party patterns scanned in quadratic time; fixed.** See the probe below.

**ReDoS and safety probe** (`packages/domain/test/robustness.test.ts`). The existing test ran every shipped pattern on eight
generic hostile inputs of 20,000 characters. Three checks were added:

- Inputs derived from each pattern itself, in the manner of the probe that guards customer-supplied redaction patterns: runs of
  the characters and words the pattern mentions, a word cut one character short, words over long gaps, and every separator the
  pattern names (`.`, `-`, `@`, ...) alternating with a word character, which puts a word boundary at every other position.
  Limit: 100 ms per input.
- The static check of that guard (`describeBacktrackingRisk`) over the shipped patterns. Nested repetition, a back-reference or
  more than four unbounded repetitions fail the test; its 80 look-around reports are not counted, because the pack compiler
  itself adds a one-character look-behind as a word boundary. Two patterns (`sig.no-server-side-failure-records`,
  `sig.resolver-inconsistent`) are reviewed exceptions: separate `\s+` runs between literal words, 0.2 ms at 20,000 characters.
- An equivalence test for the e-mail pattern.

The probe found two defects. `sig.proxy-node-inconsistent` took **9.8 s** on one 20,000-character event of `proxy-proxy-...`
(24, 76, 341 and 1,346 ms at 1, 2, 4 and 8 thousand characters, so quadratic): an unbounded `[\w-]*` after the literal `proxy`
re-scans the rest of the run from every occurrence. `req.sample-users`, the e-mail pattern, took 0.4 to 0.8 s on `a.a.a....`
for the same reason. A bundle may hold 2,000 events of 20,000 characters, a 2 MiB upload about 100 of them, and an engine pass
blocks the API's event loop (OP-3), so a crafted case could have held it for minutes. Both repetitions are now bounded (at most 40
characters of node name; the RFC limits of 64 and 63 for an address); every derived input stays under the 100 ms limit (about
10 ms for the address on the worst one), ordinary text and addresses match exactly as before, and the 1,042 domain tests are
unchanged. With the two old patterns restored, the new tests fail on both. These changes alter two patterns only: no score,
weight or prior was touched.

## 8. Limits of this evaluation

- **Two shipped synthetic cases, written alongside the engine.** They show consistency. The independent set of section 7 is a
  first step beyond them, no more.
- **The independent set of section 7 (Wave 1) is small and has one annotator;** the Wave 2 sets and their limits are in section 10.5. 16 cases, 83 events, 66 labelled occurrences, 9 stories with a cause,
  2 with an expected missed moment; no confidence intervals and no second annotator, so no agreement figure. The annotator also
  wrote the cases, and both were produced with the help of the AI model that helped build the product, so author and labels can
  share blind spots.
- **Synthetic text only.** Nobody has judged real customer cases; real mail will differ in both directions.
- **Text only.** The set has no structured fields, which the shipped cases use and which the engine reads through other
  detectors. Requirement detectors, warnings, quality scores, counterfactuals and Avoidable Support Effort were not evaluated.
- **No human-labelled ground truth beyond that.** Nobody has judged whether the forks, scores or counterfactuals of real cases
  are right. The test suite checks internal consistency, invariants and regression, not validity.
- **Estimates, not measurements.** Confidence, quality, avoidable effort and simulated time come from authored priors and
  likelihoods in one knowledge pack. Customer response times and effort minutes are assumptions.
- **No real model was evaluated.** The AI gates verify the contracts with the deterministic provider; the Azure OpenAI provider
  was exercised only against a local mock. Model quality, cost and latency are unknown.
- **No user study.** Whether reviewers find the output useful, or are biased by it, has not been tested.
- **Not all tests were run.** 35 of the 56 API test files, the end-to-end and accessibility suite, the workspace-wide lint,
  typecheck and build, and everything that needs Docker or Azure were not run for this document. Some results come from runs made
  while other jobs were loading the machine.
- **Timings are noisy** (section 6) and OneDrive-synced storage inflates start-up times.
- **Nothing was deployed.** No result here says anything about behaviour on Azure.

## 9. Reproduce

```powershell
# Per-package tests: run inside the package directory (repeat for each package)
Set-Location packages\domain
pnpm.cmd exec vitest run
Set-Location ..\..

# Independent evaluation (section 7): the pinned baseline, the ReDoS probe, and the tables above (Linux and macOS: drop ".cmd")
Set-Location packages\domain
pnpm.cmd exec vitest run test/evaluation.test.ts test/robustness.test.ts
pnpm.cmd run eval
Set-Location ..\..

# API: a few files
Set-Location apps\api
pnpm.cmd exec vitest run test/tenant-isolation.int.test.ts test/audit-chain.int.test.ts test/migrations.int.test.ts --maxWorkers=1
Set-Location ..\..

# Engine benchmark and hostile-input benchmark (from the repository root)
pnpm.cmd bench
pnpm.cmd --filter @caseguard/domain exec tsx bench/hardening-bench.ts

# The same from inside the package (use this if the root command matches more than one workspace package)
Set-Location packages\domain
pnpm.cmd exec tsx bench/bench.ts
Set-Location ..\..

# AI evaluation harness: the assertion lives in a test
Set-Location packages\ai
pnpm.cmd exec vitest run test/evaluation.int.test.ts
Set-Location ..\..
```

The calibration numbers in section 3 and the full evaluation report in section 5 were produced by throw-away scripts that import
`@caseguard/domain` / `@caseguard/ai` and the test helpers; `evalReportToMarkdown` and `evalReportToJson` in `@caseguard/ai` render
the harness report. The scripts were kept outside the repository.

## 10. Wave 2: the evaluation sets, the protocol, the verdict criteria and the result

Section 7 is the first, small, historical measurement (Wave 1). Wave 2 replaced it with three separate sets, a written protocol
and a locked split. This section says what they are, **what verdict each possible result would earn (written before the locked
split was run, and not changed afterwards)**, and then what was measured.

### 10.1 The sets and the protocol

| Split           | Cases                                         | Events | Labelled signal occurrences | Absences with a reason | Use                                                                                           |
| --------------- | --------------------------------------------- | -----: | --------------------------: | ---------------------: | --------------------------------------------------------------------------------------------- |
| `dev`           | 43 independent cases, plus 3 reordered copies |    419 |                         313 |                     78 | The tuning set: detectors may be changed after reading its per-case output. Optimistic.       |
| `validation`    | 18                                            |    208 |                         129 |                     40 | Aggregates only; used to choose between detector variants. Mildly optimistic too (10.4).      |
| `test` (locked) | 30                                            |      - |                         267 |                    122 | Run once per release with `eval:locked`; its numbers must never be used to change a detector. |

The `dev` split holds the 16 Wave 1 cases (13 independent and 3 reordered copies) migrated to the Wave 2 format and 30 added
in Wave 2. Every label is an **AI draft by one annotator** (`copilot-wave1`, `copilot-wave2-a`); no human has judged one, so
the figures measure agreement with an AI assistant. The corpus is synthetic text.

- **Independence.** The authors of the cases never opened the knowledge pack or the detectors. A checker (`eval:check`) rejects
  any six-word run that a case shares with the two shipped samples, the vocabulary, the string literals of the pack, the
  unit-test fixtures of the detectors or a case of another split. A dev case may be quoted by a detector test (dev is what the
  detectors are tuned on); a validation or test case may not.
- **Reach.** Nothing under `packages/*` or `apps/*` source, and no detector test, may import or read a validation or a test
  case; only the evaluation tooling and the guard do.
- **Who sees what.** Per-case output is for `dev` only. `validation` prints aggregates. The test split can be run only through
  `eval:locked`, which refuses to run with uncommitted changes under the test cases or their annotations, refuses a split that
  differs from the one locked in `evaluation/manifest.json`, and appends a hash-chained record to
  `evaluation/runs/locked-runs.json`. The test author saw the file names of the dev and validation cases (not their content).
- **Measures** (`packages/domain/test/evaluation/`): per-signal precision and recall with Wilson intervals (marked `too_few`
  under 20 observations), negation (silence where the label says the fact is absent, with its reason), contradictions
  (labelled conflicts found, class and subject right, precision), negative controls (nothing reported and no decision point),
  decision points (precision, recall, earliest missed moment), the leading hypothesis and its calibration, citations verified
  against the stored text, and the order of events.

### 10.2 Verdict criteria (fixed before the locked run)

The verdict is one of three, and the default is the first. Each criterion is applied to the **locked test split**, the only
split that was not used to choose anything.

**ANALYTICAL QUALITY NOT READY** unless every criterion of the next level holds.

**READY FOR CONTROLLED INTERNAL EVALUATION**: the team may use the output on non-customer cases to judge it. All of:

1. signal precision at least 0.85 and recall at least 0.60 (what is reported is mostly right, and a reader is not shown half of a story);
2. the engine is silent on at least 95 % of the facts the labels say are absent, so that a denial is not read as a finding;
3. every negative control of the split: no signal reported and no decision point;
4. no citation that mismatches its stored text, and at least 85 % of the citations verified against it;
5. decision points: precision at least 0.50, because a wrong "missed moment" is the output most likely to mislead a reviewer;
6. nothing that protects the data regressed: secret scan, row-level security, redaction and audit-chain tests all green.

**READY FOR CONTROLLED PILOT PREPARATION**: everything above, and also:

7. signal precision at least 0.90 and recall at least 0.75;
8. contradictions: at least half of at least 20 labelled conflicts found, with the right class in at least 70 % of the found pairs;
9. the labels of the locked split reviewed by at least one independent human annotator, with an agreement figure (Cohen's kappa
   on signals of at least 0.6) reported;
10. a real-model evaluation, if the model-assisted path is to be enabled (it has never been run: no credentials).

These are thresholds for a decision-support tool whose findings an engineer reads, not for an autonomous one. They were chosen
from what a misleading or a missing finding costs a reviewer, not from a number the engine already reached.

### 10.3 Results on `dev` and `validation`

Engine 2026.5.0, knowledge pack 1.2.0. Every label is an AI draft by one annotator. Intervals, case lists and the full tables are
produced by `eval:dev` and `eval:validation`; those two commands are the source of every figure here. "Reported and labelled /
reported, not labelled / labelled, not reported" is true positives, false positives and misses.

| Measure                                                                    | Wave 1, 16 cases (historical)     | `dev`: before the Wave 2 wording families → now | `validation`: before → now    |
| -------------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------- | ----------------------------- |
| Signals: true / false positives / misses                                   | 13 / 4 / 53                       | 144 / 11 / 169 → **259 / 4 / 54**               | 33 / 5 / 96 → **61 / 6 / 68** |
| Signal precision                                                           | 76 %                              | 93 % → 98 %                                     | 87 % → 91 %                   |
| Signal recall                                                              | 20 %                              | 46 % → 83 %                                     | 26 % → **47 %**               |
| Silent where the fact is denied, guessed, planned, attributed or asked for | every false positive was a denial | 99 % (77 of 78)                                 | 93 % (37 of 40)               |
| Negative controls with nothing reported and no decision point              | -                                 | 6 of 6                                          | **2 of 4**                    |
| Contradictions: labelled conflicts found; class right among the found      | -                                 | 1 of 19; 1 of 1                                 | 2 of 9; **0 of 2**            |
| Decision points: precision; recall                                         | -                                 | 21 % (6 of 28); 64 % (7 of 11)                  | **0 of 10**; 0 of 3           |
| Engineer actions: precision; recall                                        | -                                 | 94 %; **19 %** (32 of 166)                      | 70 %; **6 %** (7 of 111)      |
| The leading hypothesis is a labelled cause                                 | -                                 | 73 % (24 of 33), Brier 0.051                    | 62 % (8 of 13)                |
| Citations verified against the stored text; mismatches                     | -                                 | 91 % (n = 650); 0                               | 88 % (n = 179); 0             |
| Reordered copies with an identical analysis                                | -                                 | 3 of 3                                          | -                             |

What the table says, and what it does not:

- **Detection recall nearly doubled on text the detectors were not written from, and is still below half.** Validation recall went
  from 26 % to 47 %, with precision up from 87 % to 91 %. On `dev`, which the detectors were tuned on, recall is 83 %: the 36 points
  between the two are what tuning on a set buys, not what an unseen case gets. Intervals are wide (validation has 129 labelled
  occurrences in 18 cases, and occurrences cluster in cases).
- **What validation still misses (68 occurrences).** 14 (21 %) are the fix-confirmation signals, which only structured event data
  can show: reading "the fix worked" from prose, or from the leading hypothesis, would count the same evidence twice, so the engine
  does not. 1 has no detector that accepts the event's type or author role. 53 (78 %) are wording a detector accepts and whose
  pattern did not match. Over the occurrences a text detector could report, recall is 54 % (n = 114).
- **A gain on the author's own probes is not a gain on unseen text.** The author of the last round of families for the site and
  the cache signals measured them on sentences it wrote itself (the site signal: 5 of 17 before, 15 of 17 after); on validation that
  signal still reads 2 of its 11 occurrences, the same as before the round. Only the held-out sets tell.
- **Negation is handled; the rest of "not stated" is only partly.** A sentence that denies, guesses, plans, asks for, reports from
  someone else or leaves open a fact is read through a small list of cues (DETECTION.md section 3). The engine stays silent on 99 %
  and 93 % of the facts the labels say are absent. Wave 1's failure, a denial read as a finding, no longer occurs in `dev`: its four
  remaining false positives are a restatement, an explanation of a policy, and two readings of "the logs are clean / hold nothing"
  that the annotator did not label.
- **The negative controls are the clearest sign of over-reading on unseen text.** All six on `dev` are silent, because the
  patterns were tuned against them; two of the four on `validation` report something.
- **Contradictions are barely found.** The engine finds a conflict only between two statements of a declared signal pair or of a
  counted attribute, and it pairs adjacent statements. The annotators' pairs follow no such rule: 6 of the 19 labelled `dev`
  conflicts are about something the pack does not model, and for most of the rest the engine pairs other events than the
  annotator did. 1 of 19 on `dev`, 2 of 9 on `validation` (neither of the two with the right class).
- **Decision points are not reliable.** 22 of the 28 the engine reports on `dev` match no label (13 are "low-value action"), and
  none of the 10 on `validation` does. The product's review page now says that they are questions to discuss, not findings.
- **Engineer actions are mostly not read.** The engine reads an engineer's step from `engineer_action`, `engineer_email` and
  `escalation` events or from an explicit action key. 72 of the 134 `dev` actions it misses are stated in `diagnostic_result`,
  `validation_result` and other result or output events, which it does not read as actions; within the event types it does read,
  recall is 34 %. A step that an engineer took and reported in such an event can therefore still be suggested as a next step,
  unless the signals it produced were read (KNOWN_LIMITATIONS.md PL-17).

### 10.4 How the sets were used (so that the figures can be read for what they are)

- `dev` was read case by case. Detectors, wording families, modality cues and the regression floors
  (`evaluation/runs/floors.json`, now recall 0.80, precision 0.96) were set from it. Its figures are optimistic.
- `validation` was run about seven times (six outputs were saved), always as aggregates (by signal, by category, by dimension; no case was read).
  Each look decided whether a family transferred: it kept, narrowed or removed it. The first scope-count family added 15 false
  positives and no true positive on validation and was narrowed to stated failures. This is model selection on the set, so its
  figures are mildly optimistic too. The exact number of the early re-runs was not recorded.
- The locked test split was not run until every detector, cue and pattern was final and committed (the engine and pack versions
  were bumped, the sample digests checked, every suite run). It was run once, from a clean tree, on the final detectors
  (record 1 of `evaluation/runs/locked-runs.json`, commit `cf2a92e`), and nothing in the detectors changed afterwards.
- The cases, the evaluation tooling and the wording families were written by AI assistants working apart. The case authors never
  opened the pack or the detectors; the family authors never read a validation or a test case (only aggregates of `validation`).
  The independence check caught six detector-test sentences that shared a six-word run with held-out cases (they were reworded)
  and a pack pattern that shared one with a `dev` case. The author of the test split saw the file names of the `dev` and
  `validation` cases, not their content.

### 10.5 What this evaluation cannot show

- **The labels are AI drafts by one annotator** and the cases were written with the help of the same family of model that helped
  build the engine, so annotator and author can share blind spots. No human has judged a label; there is no second annotator, so
  no agreement figure for `validation` and `test`.
- **Synthetic text, one workload.** Nothing says how the engine reads real customer cases, and the families are tied to Teams
  sign-in wording in English.
- **Small sets.** 18 validation and 30 test cases; per-signal rows rest on a handful of occurrences (`too_few` under 20).
- **No real model was run.** The model-assisted review is optional and off; its grounding and critic checks were exercised with
  a scripted provider, which is labelled as a simulation (134 of 134 planted mechanical errors were caught by deterministic checks;
  that says nothing about a model).
- **Estimates stay estimates.** Confidence, quality, avoidable effort and simulated time come from authored priors.

### 10.6 The locked test split, and the verdict

One run, on the final detectors (engine 2026.5.0, pack 1.2.0, commit `cf2a92e`): 30 cases (28 with a supported workload), 296
events, 267 labelled signal occurrences, one AI annotator. The two other splits are repeated for comparison.

| Measure                                                | `dev` (tuned on)               | `validation` (looked at in aggregate) | **locked test (untouched)**      |
| ------------------------------------------------------ | ------------------------------ | ------------------------------------- | -------------------------------- |
| Signals: true / false positives / misses               | 259 / 4 / 54                   | 61 / 6 / 68                           | **112 / 23 / 155**               |
| Signal precision                                       | 98 %                           | 91 %                                  | **83 %** [76-88 %]               |
| Signal recall                                          | 83 %                           | 47 %                                  | **42 %** [36-48 %]               |
| Silent where the label says the fact is absent         | 99 % (77 of 78)                | 93 % (37 of 40)                       | **94 %** (115 of 122)            |
| Negative controls: nothing reported, no decision point | 6 of 6                         | 2 of 4                                | **3 of 5**                       |
| Unsupported workload refused                           | 3 of 3                         | 1 of 1                                | 2 of 2                           |
| Contradictions: labelled conflicts found; class right  | 1 of 19; 1 of 1                | 2 of 9; 0 of 2                        | 1 of 14; 1 of 1                  |
| Decision points: precision; recall                     | 21 % (6 of 28); 64 % (7 of 11) | 0 of 10; 0 of 3                       | **4 % (1 of 26)**; 17 % (1 of 6) |
| Earliest missed moment: spurious in                    | 9 of 40 cases                  | 5 of 17                               | 11 of 28                         |
| Engineer actions: precision; recall                    | 94 %; 19 %                     | 70 %; 6 %                             | 72 %; 10 % (18 of 179)           |
| The leading hypothesis is a labelled cause             | 73 % (24 of 33)                | 62 % (8 of 13)                        | 52 % (12 of 23)                  |
| Citations verified against the stored text; mismatches | 91 %; 0                        | 88 %; 0                               | 92 % (n = 343); 0                |

Applying the criteria of section 10.2, which were written before this run:

| #   | Criterion                                     | Needed              | Measured on the locked split | Met |
| --- | --------------------------------------------- | ------------------- | ---------------------------- | --- |
| 1   | Signal precision; signal recall               | at least 0.85; 0.60 | 0.83; 0.42                   | no  |
| 2   | Silent on the facts the labels say are absent | at least 95 %       | 94 %                         | no  |
| 3   | Every negative control silent                 | all                 | 3 of 5                       | no  |
| 4   | No mismatching citation; citations verified   | 0; at least 85 %    | 0; 92 %                      | yes |
| 5   | Decision-point precision                      | at least 0.50       | 0.04                         | no  |
| 6   | Nothing that protects the data regressed      | all green           | all green                    | yes |

**Verdict: ANALYTICAL QUALITY NOT READY.** Four of the six criteria for even the first level are not met, and the levels above it
(precision 0.90 and recall 0.75, contradictions, human-reviewed labels, a real-model evaluation) are further away still.

What the run says:

- **Each step away from the tuning set reads less.** Precision falls 98 % (`dev`), 91 % (`validation`), 83 % (locked); recall 83 %,
  47 %, 42 %. The locked precision is 8 points under the validation figure and there are 23 false positives against 6 on
  validation: looking at `validation` in aggregate, and choosing variants by it, made it optimistic, as section 10.4 said it would.
  The locked split is the figure to quote.
- **Two criteria are close and two are far.** Precision (0.83 against 0.85) and silence on absent facts (94 % against 95 %) are
  inside their intervals (76-88 % and 89-97 %). Recall (0.42 against 0.60), the negative controls (two of five report something) and
  the decision points (one of 26) are not close.
- **Negation is the part that holds.** The engine stayed silent on 70 of 70 facts the labels call negated and on every one of the
  11 that are corrected; it is weaker on the conditional (9 of 13) and the attributed (7 of 9), counts too small to rest on.
- **Nothing was read by signal.** To keep the split usable as a check, its per-signal and per-case output was not read, and it must not
  guide a detector change. It is spent for this release: the next release needs a new locked split.

What would have to change before the first level is met, in the order of how far each is: decision points (precision 0.04 against 0.50),
recall of the engine's wording (0.42 against 0.60), the negative controls (over-reading on text that is not a Teams sign-in failure),
and then silence on conditional and reported statements. None of it can be shown with labels that no human has reviewed.
