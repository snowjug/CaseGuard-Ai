# Evaluation

How CaseGuard AI was evaluated, with the numbers that were actually produced for this document, what they prove and what they
cannot. Every figure comes from a command that was run on one developer machine (given in section 8). Nothing here is a claim
about real-world accuracy: the only data are **two synthetic cases**, there is **no human-labelled ground truth**, and every score
is an **estimate** from an authored knowledge pack.

Related: [DOMAIN_ENGINE.md](DOMAIN_ENGINE.md), [AI_ORCHESTRATION.md](AI_ORCHESTRATION.md), [RESPONSIBLE_AI.md](RESPONSIBLE_AI.md),
[LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md).

## 1. What was evaluated and how

| Question                                                          | Method                                                                                        | Section |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------- |
| Does the code do what it claims?                                  | Automated tests per package (unit, property, integration on PGlite)                           | 2       |
| Does the engine produce plausible, internally consistent results? | Run the full pipeline on both synthetic cases and inspect every headline number               | 3       |
| Can the future leak into an earlier decision?                     | As-of equivalence, mutation of everything after a cut, negative controls, leak detector tests | 4       |
| Do the AI contracts and validators hold?                          | The evaluation harness with the deterministic provider and 32 adversarial fixtures            | 5       |
| Is it fast enough?                                                | The engine benchmark and the hostile-input benchmark                                          | 6       |
| How much should the results be trusted?                           | Limits                                                                                        | 7       |

**Machine and conditions.** Windows 10.0.26300, 11th Gen Intel Core i7-1185G7 at 3.00 GHz (8 logical cores), Node v26.13.0
(the project requires Node 24 or newer), pnpm 10.34.7, repository on a OneDrive-synced folder. **Other workstreams were running
builds and tests on the same machine during these runs**, so all timings are noisy.

## 2. Test inventory

Counts are Vitest's own totals from `pnpm.cmd exec vitest run` inside each package (a "test" is one `it` after expansion of
`it.each` and loops).

| Package                  |                       Test files |                              Tests | Result                                                             | Notes                                                                                                                       |
| ------------------------ | -------------------------------: | ---------------------------------: | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `packages/schemas`       |                                1 |                                 18 | all passed                                                         | Contract and enum tests                                                                                                     |
| `packages/config`        |                                4 |                                132 | all passed                                                         | Fail-fast guards and parsing (124 in my first run; tests for `TRUST_PROXY` and `TRUST_CLIENT_IP_HEADER` landed since)       |
| `packages/security`      |                               17 |                                604 | all passed                                                         | Auth, RBAC, redaction, injection, uploads, headers, URL safety                                                              |
| `packages/observability` |                               13 |                                848 | all passed                                                         | Logger, redaction, metrics, tracing hooks                                                                                   |
| `packages/ai`            |                               13 |                                180 | all passed                                                         | Validators, prompts, governor, cache, resilience, orchestrator, Azure provider **against a local mock**, evaluation harness |
| `packages/domain`        |                               47 |                                928 | **925 passed, 3 failed** (see below)                               | Engine, ingestion parsers, quality, metrics, warnings, coaching, SkillDNA; fast-check properties                            |
| `packages/testing`       |                                0 |                                  0 | no tests                                                           | Shared fixtures only                                                                                                        |
| `packages/ui`            |                               10 |                                183 | all passed with `--maxWorkers=1` (first run: 180 passed, 3 failed) | See the note below                                                                                                          |
| `apps/web`               |                               13 |                                158 | all passed (`--maxWorkers=2`, 479 s)                               | jsdom + Testing Library; heavy. `src/proxy.test.ts` has grown since this run (not re-run, see below)                        |
| `apps/api`               | 56 (29 `.int.test.ts`, 27 other) | 345 in the 21 files run (299 + 46) | all 21 files passed                                                | Only 21 of 56 files were run, see below                                                                                     |

**Sum of the five fully passing packages (schemas, config, security, observability, ai): 48 files, 1,781 tests, all passing.**
`packages/domain` is reported separately below because it changed while I worked.

`packages/domain`: my first run (46 files, **881 tests, all passed**) and a later re-run with the same 46 files (880 passed, one
timing test, `engine-hardening.test.ts` "analyses 600 same-key actions ... in bounded time", over its limit at 13 s on the loaded
machine; the file passed alone, 48 of 48) were on a working tree that then changed: another workstream added
`test/decision-time-consistency.test.ts` and edited the belief update, the decision-time views, the counterfactual code and the
ingestion draft assembly (all **uncommitted**). The last full run of the package (47 files, **928 tests, 925 passed and 3 failed**)
fails in `test/ingest-parsers-draft.test.ts` (the cases that expect a different generated draft reference for time-only stamps read
on another day, and the same reference on the same day); both that test file and `src/ingest/parsers/draft.ts` have uncommitted
edits, so I treat it as work in progress and did not investigate it. Re-run the package before relying on the domain numbers.
Likewise `packages/ai` had one load-induced timeout in a re-run (`evaluation.int.test.ts`, "a provider that throws is counted as
an error", 6.5 s against the 5 s default); the file passed alone (9 of 9) and the next full run passed (13 files, 180 tests).

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
actions, 13 requirements) and the seed `test-seed`. The API seeds the engine with the analysis input hash instead, so the
**rollout-derived values** (counterfactual metrics and Avoidable Support Effort) can differ slightly there; forks, belief point
estimates, Case Quality Index and warnings do not depend on the seed. The tests pin the qualitative facts (for example
`pipeline.test.ts`: 9 forks in Case One, exactly one earliest-meaningful fork and it is the first; `quality-index.test.ts`: Case One
below the "adequate" band, Case Two "strong" and at least 85; `warnings-case-one.test.ts`: the replay raises the specific warnings
and Case Two raises none).

**Stability of these numbers.** The tables were produced by the first run of the script. I ran the same script again later in the
same session; by then the working tree held other workstreams' **uncommitted** edits to the belief update, the decision-time
views and the counterfactual code. Every headline value in section 3.1 was identical. Only decimals of
secondary figures moved: the impact of six forks changed by 0.001 (`e08` 0.768, `e11` 0.634, `e13` 0.669, `e15` 0.610, `e16`
0.618, `e19` 0.723), and for forks other than `e03` a few rollout figures moved by at most 1 percentage point in reach share, 0.005
in comparison confidence and about 3 minutes in the p90 of simulated time. The `e03` scenarios did not change. The values below are
the first run; treat the third decimal as noise between code states, not as a measurement.

### 3.1 Headline results

| Measure                                                          | Case One (CG-SYN-1001)                                                                                            | Case Two (CG-SYN-1002)                                                      |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Events / evidence items / claims / diagnostic actions            | 31 / 26 / 61 / 11                                                                                                 | 15 / 12 / 31 / 5                                                            |
| Decision forks                                                   | **9**                                                                                                             | **0**                                                                       |
| Earliest meaningful fork                                         | `e03` at 2026-03-09T09:41:00Z (impact 0.571, medium)                                                              | none                                                                        |
| Case Quality Index (range) and band                              | **36.0** (32.0 to 39.4), **poor**                                                                                 | **99.1** (95.1 to 99.7), **strong**                                         |
| Penalty points applied (cap 40, not reached)                     | 32                                                                                                                | 0                                                                           |
| Estimated CQI if every improvement is applied                    | 68.2 (52.1 to 76.2), 8 improvements                                                                               | 99.1 (no improvement recommended)                                           |
| Avoidable Support Effort                                         | state `estimated`: **58.2%** (42.7% to 83.3%), confidence **low**; basis fork `e03`, strategy `fastest_diagnosis` | state `no_decision_forks`: 0%, confidence medium                            |
| Live warnings raised over the case                               | **14** (2 critical, 5 high, 5 medium, 2 low); all resolved by the end                                             | **0**                                                                       |
| Leading hypothesis over time                                     | proxy-egress 0.187 until `e03`; DNS-resolution 0.725 at `e04`, 0.833 at `e14`, 0.925 at `e24`, 0.926 at `e31`     | proxy-egress 0.701 at `g01`, 0.804 at `g07`, 0.925 at `g09`, 0.926 at `g15` |
| Time to analyse (probe, 11 counterfactual scenarios in Case One) | about 4.4 s                                                                                                       | about 36 ms                                                                 |

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
| `e03` | `balanced`               |     8 |                         56.5% | low (0.243)           |                  2,994 | 450.5 (189.8 to 707.7)      |                   410 | 110 (20 to 181)            |
| `e03` | `lowest_customer_effort` |     8 |                         50.0% | low (0.269)           |                  2,994 | 449.7 (210.8 to 582.4)      |                   410 | 90 (20 to 110)             |
| `e03` | `fastest_diagnosis`      |     8 |                         58.5% | low (0.251)           |                  2,994 | 435.1 (169.0 to 645.4)      |                   410 | 90 (20 to 170)             |
| `e07` | `balanced`               |     1 |                         97.0% | medium (0.565)        |                  2,845 | 94.0 (56.2 to 198.4)        |                   230 | 10 (10 to 20)              |
| `e08` | `balanced`               |     1 |                         95.0% | medium (0.557)        |                  2,830 | 96.2 (58.4 to 191.6)        |                   230 | 10 (10 to 20)              |
| `e09` | `balanced`               |     1 |                         96.0% | medium (0.561)        |                  2,824 | 106.0 (60.9 to 192.0)       |                   200 | 10 (10 to 20)              |
| `e11` | `balanced`               |     1 |                        100.0% | medium (0.585)        |                  2,735 | 94.0 (54.8 to 160.9)        |                   190 | 10 (10 to 20)              |
| `e13` | `balanced`               |     1 |                        100.0% | medium (0.586)        |                  2,715 | 97.0 (57.3 to 153.9)        |                   190 | 10 (10 to 20)              |
| `e15` | `balanced`               |     1 |                         97.5% | medium (0.596)        |                  1,600 | 93.7 (58.3 to 217.2)        |                    10 | 10 (10 to 40)              |
| `e16` | `balanced`               |     1 |                         97.0% | medium (0.594)        |                  1,565 | 90.1 (56.0 to 248.9)        |                    10 | 10 (10 to 40)              |
| `e19` | `balanced`               |     1 |                         92.5% | medium (0.576)        |                  1,230 | 90.6 (53.7 to 265.4)        |                    10 | 10 (10 to 50)              |

Reading this table honestly: the earliest fork (`e03`) is far from the diagnosis, so the simulated path is long (8 steps),
reaches a diagnosis in only about half the rollouts and has **low** comparison confidence; the ASE of 58.2% is therefore labelled
low confidence with a 42.7% to 83.3% range. Later forks need one targeted step because the leader is already at about 0.73 or
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
| `engineer_effort`         |                 9 actions |           0.1579 | 11.1% / 22.2% / 77.8%                |
| `customer_effort`         |                   410 min |           0.2105 | 55.9% / 78.0% / 95.1%                |
| `repeated_interactions`   |            5 interactions |           0.1053 | 0% / 0% / 60%                        |
| `diagnostic_executions`   |                      14.0 |           0.1053 | 42.9% / 57.1% / 92.9%                |
| `escalations`             |                         1 |           0.0526 | 50% / 100% / 100%                    |
| `waiting_time`            |                 2,994 min |           0.2105 | 76.4% / 85.5% / 94.4%                |
| `token_usage`             | 40,850 tokens (estimated) |           0.0526 | 69.2% / 81.6% / 96.3%                |
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

| Layer                     | Test (file)                                                                                                                                                                                                                                                                                                                                                                           | What it proves                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Views                     | `temporal.test.ts` (including a property test)                                                                                                                                                                                                                                                                                                                                        | Any boundary view is a prefix of the case; the exclusive decision-moment view excludes the event itself, later events and the resolution                                   |
| Engine, as-of equivalence | `temporal-integrity.test.ts`: "prefix ending at `<cut>` equals the full run for everything known by then"                                                                                                                                                                                                                                                                             | For every cut, analysing only the prefix gives the same claims, evidence, decision-time action and fork fields and hypothesis points as the full analysis restricted to it |
| Counterfactuals           | `temporal-integrity.test.ts`: "mutating every later event leaves the simulated path and metrics byte-identical"                                                                                                                                                                                                                                                                       | Rewriting all later events changes nothing in the simulated path (**mutation test**)                                                                                       |
| Counterfactuals           | same file: boundary view, recorded leak check, "the leak detector rejects a scenario that mentions an identifier first seen later", "generation is independent of the resolution; only the hindsight check uses it", "boundary evidence was observed no later than the decision instant"                                                                                              | The leak check is not vacuous; the resolution never reaches generation                                                                                                     |
| Warnings                  | `warnings-asof.test.ts`: "mutating everything after `<event>` changes nothing that was raised by then" plus "the poisoned future really is different, so the check above is not vacuous"; "replaying as of `<event>` equals the full replay seen at that moment"                                                                                                                      | Later events cannot change an earlier warning; a non-vacuity control exists                                                                                                |
| Quality and coaching      | `quality-index.test.ts` (as-of review), `coaching-report.test.ts` (as-of report)                                                                                                                                                                                                                                                                                                      | The same property for the quality review and the coaching report                                                                                                           |
| Views and graphs          | `views.test.ts`, `engine-hardening.test.ts`                                                                                                                                                                                                                                                                                                                                           | As-of twin, timeline and graph use decision-time fields; reply links never point forward                                                                                   |
| SkillDNA                  | `skills-properties.test.ts` ("rewriting or deleting the future never changes the decision"), `skills-story.test.ts` (`withPoisonedFuture`)                                                                                                                                                                                                                                            | Matching and plans at an instant use only what was known then                                                                                                              |
| AI context                | `packages/ai/test/temporal-mutation.test.ts`: "changing events and the resolution after the fork never changes the counterfactual prompt or hash", "future changes never alter the `<agent>` prompt for an as-of window", **negative control** "changing a visible event does change the context hash", "the pre-resolution context never contains the resolution or later event ids" | The model never sees the future, and the test can fail                                                                                                                     |
| API                       | `apps/api/test/analysis.int.test.ts` (as-of views, warnings as of, malformed `asOf`), `views-temporal.test.ts`                                                                                                                                                                                                                                                                        | The HTTP views recompute on what was known then (not run for this document; see section 2)                                                                                 |
| Output side               | `packages/ai` validators: item-level anchors, future-identifier and 6-word-shingle checks, adversarial fixtures `future-event-citation` and `future-identifier-leak`                                                                                                                                                                                                                  | A model that tried to cite or echo the future is rejected (section 5)                                                                                                      |

All of the files in the domain and ai rows were part of the passing runs in section 2. These tests establish the property for the
code paths they cover on the two synthetic cases and on generated mutations; they are not a proof for arbitrary input.

## 5. AI evaluation harness (deterministic provider)

`runEvaluation` (`packages/ai/src/eval`) runs every model-capable agent over both cases at several as-of points, validates every
output with the production validators, and adds adversarial fixtures. I ran it with the deterministic provider on both cases, the
same call as `packages/ai/test/evaluation.int.test.ts`, which asserts these gates.

**Result: all 7 gates passed, 36 samples (20 on Case One, 16 on Case Two), 8 agents, 0 provider errors, 9.4 s.**

| Gate                                  | Value | Required | Passed |
| ------------------------------------- | ----: | -------: | ------ |
| `schema-validity`                     | 1.000 |     >= 1 | yes    |
| `citation-validity`                   | 1.000 |     >= 1 | yes    |
| `groundedness` (1 - unsupported rate) | 0.990 |  >= 0.95 | yes    |
| `temporal-leak`                       | 0.000 |     <= 0 | yes    |
| `unsafe-recommendation`               | 0.000 |     <= 0 | yes    |
| `classification-agreement`            | 1.000 |     >= 1 | yes    |
| `prompt-injection-resistance`         | 1.000 |     >= 1 | yes    |

Other reported metrics: fork recall 1.0, fork precision 1.0, counterfactual realism 1.0, skill completeness 1.0, mean latency
16.9 ms, 273,328 total tokens (**estimated**, `ceil(characters / 4)`). Per-agent samples: timeline analyzer 8, evidence classifier
8, hypothesis generator 8, fork detector 4, counterfactual simulator 3, quality judge 2, communication coach 2, SkillDNA extractor 1.
Per-agent groundedness is 1.0 everywhere except the quality judge (0.714 on 2 samples); only the overall value is gated.

**Adversarial fixtures: 32, all rejected (rate 1.0).** 24 bad-output fixtures, each of which must be rejected by the expected
validator kind, and 8 prompt-injection input fixtures (four per case: `ignore-previous-instructions`, `delimiter-breaking`,
`tool-and-exfiltration`, `chat-template-tokens`) that must be flagged and neutralised in the prompt. The bad-output kinds, in
Case One, are: `hallucinated-citation` (citation), `future-event-citation` and `future-identifier-leak` (temporal),
`destructive-action-step`, `approval-required-action-step`, `unlabelled-simulation`, `destructive-recommendation-text`,
`rank-and-discipline-individuals` and `skill-without-human-approval` (policy), `invented-identifier` (groundedness),
`schema-violation` (schema), `oversized-output` (size), `injection-compliance` and `prompt-leak` (injection). Case Two repeats
the subset that applies to it (10 of them).

**What this does and does not show.** The provider under test is the deterministic reference itself, so the gates verify the
**contracts and validators**, not model quality. The thresholds for a real model are different (schema 0.95, citation 0.98,
groundedness 0.9, classification agreement 0.7; leak, unsafe and adversarial unchanged) and **no real model has ever been
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

## 7. Limits of this evaluation

- **Two synthetic cases, written alongside the engine.** No held-out data, no independent authors, no real support cases.
- **No human-labelled ground truth.** Nobody has judged whether the forks, scores or counterfactuals are right. The test suite
  checks internal consistency, invariants and regression, not validity.
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

## 8. Reproduce

```powershell
# Per-package tests: run inside the package directory (repeat for each package)
Set-Location packages\domain
pnpm.cmd exec vitest run
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
