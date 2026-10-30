# Responsible AI

CaseGuard AI supports quality review and coaching of technical support cases. It computes estimates from a written case
record and an authored knowledge pack. This document explains how the design limits harm, what is uncertain, where people stay
in control, and what has **not** been validated. It is written for judges, engineers and anyone deciding whether and how to
use the output.

Related: [DOMAIN_ENGINE.md](DOMAIN_ENGINE.md), [AI_ORCHESTRATION.md](AI_ORCHESTRATION.md), [PRIVACY.md](PRIVACY.md),
[SECURITY.md](SECURITY.md), [EVALUATION.md](EVALUATION.md).

## 1. Intended and prohibited use

The product states this on every coaching report and in `RESPONSIBLE_USE_NOTICE`
(`packages/schemas/src/metrics.ts`):

> CaseGuard AI supports quality review and coaching. It must not be used to rank, rate or discipline individual employees, and
> it never closes cases automatically.

| Intended                                                               | Not intended                                                            |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Focusing a human review on the decisions in one case                   | Performance management, ranking, bonuses, discipline or dismissal       |
| Showing a safer or cheaper step that was available **at the time**     | Judging whether an engineer "was wrong" using what is known now         |
| Surfacing missing evidence, unsupported claims and unvalidated closure | Replacing a reviewer's judgement                                        |
| Turning a reviewed, validated path into a governed, reusable procedure | Auto-publishing guidance or auto-closing cases                          |
| Demonstrating a measurement pipeline on **synthetic** cases            | Evidence of real-world effectiveness (`SYNTHETIC_EFFECTIVENESS_NOTICE`) |

## 2. What is computed, by what, and how it is labelled

| Output                          | Computed by                                 | Model involved?                                    | Label shown                                                                                                                 |
| ------------------------------- | ------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Evidence, claims, flags         | Deterministic detectors over the record     | No                                                 | Category and strength; reviewers can recategorise                                                                           |
| Hypothesis confidence over time | Authored likelihoods, dampened Bayes update | No                                                 | "Model estimate" with a 10 to 90 percent sensitivity band (`MODEL_ESTIMATE_NOTICE`)                                         |
| Decision forks and alternatives | Action-value ranking with safety gates      | No                                                 | "Estimated, not measured"; decision-time information only; hindsight block labelled                                         |
| Counterfactual scenarios        | Seeded rollouts over a policy tree          | No (an optional model may reword rationale)        | `simulated` and `estimated`; assumptions listed; eight validity checks; p10 / median / p90                                  |
| Case Quality Index              | Weighted sub-checks minus capped penalties  | No                                                 | Score with range and band; each penalty evidence-linked; not assessable dimensions say so                                   |
| Avoidable Support Effort        | Real path versus best valid simulated path  | No                                                 | Percent with range, confidence, components, assumptions; states `estimated`, `no_decision_forks`, `no_valid_counterfactual` |
| Warnings                        | 13 rules over a time-limited checkpoint     | No                                                 | Specific, evidence-linked; dismissable with a reason                                                                        |
| Coaching report                 | Templates over the above                    | No (optional model wording, validated, not merged) | "Supportive decision support, not a performance rating"; confidence at most `medium`                                        |
| SkillDNA candidate              | Extraction from an accepted scenario        | No                                                 | Draft; needs four-eyes approval before use                                                                                  |
| Token and cost figures          | Counts and operator prices                  | No                                                 | `measured`, `estimated` or `mixed`; cost unknown without prices                                                             |

By default **no language model is called**. The AI layer exists to demonstrate how a model would be bounded ("the LLM proposes,
code disposes"); even then, in the current analysis pipeline a model proposal is validated and recorded, and the stored
artefacts still come from the deterministic engine ([AI_ORCHESTRATION.md](AI_ORCHESTRATION.md#8-how-the-api-binds-it-appsapisrcservicesai)).

## 3. Human-in-the-loop points

| Decision                                   | Who may do it (permission)                                                                                          | What the system records                                                                                                                                                                                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start an analysis, run counterfactuals     | Engineer, administrator (`case:analyze`, `counterfactual:run`)                                                      | A job and an audit event; rate-limited per user                                                                                                                                                                                                                        |
| Recategorise a claim                       | Reviewer (`evidence:review`)                                                                                        | The original classification is **preserved**; the correction, reason (5 to 1,000 characters), reviewer and role are stored and audited                                                                                                                                 |
| Accept or reject a counterfactual scenario | Reviewer (`counterfactual:review`)                                                                                  | Decision, reason, optimistic version; **extraction of a skill requires an accepted scenario**                                                                                                                                                                          |
| Override an action ranking                 | Reviewer (`actionvalue:override`)                                                                                   | Rank, action and a reason; audited                                                                                                                                                                                                                                     |
| Dismiss a warning                          | Engineer (`warning:dismiss`)                                                                                        | Reason (5 to 500 characters); a dismissed warning is never re-raised; audited                                                                                                                                                                                          |
| View the hindsight comparison              | Reviewer (`quality:review`)                                                                                         | Labelled post-hoc; never used in generation                                                                                                                                                                                                                            |
| Move a skill through its lifecycle         | Engineer or curator (extract), reviewer or curator (validate, review), curator (approve, publish, retire, rollback) | **Four-eyes**: creator, reviewer, approver and publisher differ where the lifecycle demands it; every transition has a reason and is audited; **publication is always a human act**                                                                                    |
| Apply a skill to a case                    | Engineer or curator (`skill:apply`)                                                                                 | Records that the engineer adopted the guided plan (idempotent, audited once); refused for skills that are not in pilot, validated or published and for skills that do not apply to the case; conformance with the plan is computed from what the engineer actually did |
| Close a case                               | Not done by the system                                                                                              | The product never closes a case; a validator rejects any model output that recommends it                                                                                                                                                                               |
| Change model limits, redaction, retention  | Administrator (`governance:write`)                                                                                  | Versioned setting, change note, audit event                                                                                                                                                                                                                            |

## 4. Non-blaming design

- **The unit of analysis is the case record, not the person.** The engine has no notion of an engineer's identity. A fork says
  "at this moment a safer step was available"; it never says who failed.
- **Penalties are rule-based and capped.** Each penalty is tied to evidence in the record and the total is capped (40 points),
  so one mistake cannot zero a case. The metric definition states that the index is "not a performance rating of a person".
- **Analytics are aggregates.** `buildAnalyticsOverview` emits counts, averages and pack labels only; its own statement is "No
  individual employee is ranked, scored or identified". The manager role sees quality and analytics but cannot review or
  dismiss anything.
- **Coaching is supportive.** It lists what went well first, frames forks as learning points ("In hindsight" statements are
  labelled "shown to calibrate, never to judge the decision"), proposes the lightest next step and states its limitations.
- **Hindsight is separated.** Decision-time analysis never uses the final resolution. Retrospective values exist only as labelled
  comparison, so an engineer is not judged on information they did not have.
- **Models are told, and checked.** The shared prompt preamble forbids recommending the ranking or judging of people, and the
  policy validator rejects model text that suggests disciplining, ranking or personally judging individuals (patterns
  `individual_discipline`, `individual_ranking`, `personal_judgement`; they are regular expressions with known gaps, see SP-17 in
  [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md#3-security-and-privacy-limits)). The evaluation harness includes a
  "rank-and-discipline-individuals" fixture and a negated people-wording fixture ("No one disagrees that the engineer should be
  fired.") that must be rejected, a control ("No one should be fired over this review.") that must be accepted, and all three
  behave as required ([EVALUATION.md](EVALUATION.md#5-ai-evaluation-harness-deterministic-provider)).
- **No leaderboards.** There is no per-person view in the API contract.

What the design cannot do: stop a human from using a case-level score to judge a person. That is a governance decision for the
organisation. The notices are the only technical guard.

## 5. Communicating uncertainty

| Mechanism                         | Where                                                                                                                                                                                                                                                                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ranges, not points                | Confidence bands (10 to 90 percent), CQI low to high, ASE low to high, counterfactual p10 / median / p90                                                                                                                                                                                                                |
| Confidence on the estimate itself | ASE confidence (`low`/`medium`/`high` from comparison confidence and range width); coaching confidence is **never `high`**                                                                                                                                                                                              |
| Explicit "not computable" states  | Dimension "not assessable" (neutral 50, range 0 to 100); ASE `no_valid_counterfactual` (null with a reason)                                                                                                                                                                                                             |
| Estimated versus measured         | Every metric has `estimated: true`; token and cost figures are `measured`, `estimated` or `mixed`; cost is unknown without operator prices                                                                                                                                                                              |
| Simulated versus real             | Counterfactual steps and outcomes carry `simulated: true`; the deterministic AI provider is labelled `simulated`                                                                                                                                                                                                        |
| Fixed notices                     | `MODEL_ESTIMATE_NOTICE`: "Confidence values are model estimates produced from an authored knowledge pack. They are not statistical truth." `SYNTHETIC_EFFECTIVENESS_NOTICE`: "Improvement figures compare synthetic cases and demonstrate the measurement pipeline. They are not evidence of real-world effectiveness." |
| Honest integration status         | Session notices say when Azure OpenAI is configured but only mock-validated; `system.provider` reports `validationNote`                                                                                                                                                                                                 |
| Disagreement is visible           | Rank stability under weight changes (±25 percent and equal weights); counterfactual strategies that converge are shown                                                                                                                                                                                                  |

## 6. Known failure modes and bias risks

| Risk                                                     | Why it happens                                                                                                                   | Mitigation today                                                                                                        | Residual                                                              |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Authored-pack bias**                                   | Priors, likelihoods, costs and "good practice" for one workload (Teams authentication) were written by hand                      | Pack is versioned, visible and compiled with checks; everything is labelled an estimate                                 | A different team or product would disagree; no other pack exists      |
| **Calibration on two synthetic cases**                   | The only validation data are two fictional cases written to exercise the engine                                                  | Stated everywhere; metrics labelled estimated                                                                           | Scores may not transfer to real cases at all                          |
| **Documentation-style bias**                             | The engine reads only what was written; an engineer who works well but documents little scores worse; wording drives claim flags | Undecidable checks widen the range; "not assessable" states                                                             | Verbose writers look better; non-English or unusual wording is missed |
| **Pattern brittleness**                                  | Signal and claim detection is regular-expression and lexicon based                                                               | Tests on both cases; limits on scan size                                                                                | Paraphrase, sarcasm, other languages and typos defeat detection       |
| **Hypothesis space is fixed**                            | The engine can only favour hypotheses in the pack; a novel root cause falls into `hyp.other`                                     | `hyp.other` is never "confirmed"                                                                                        | New failure modes are invisible until the pack is extended            |
| **Simulated effort is not real effort**                  | Customer response time (45/90/180 minutes), effort minutes per level and outcome probabilities are priors                        | Assumptions listed with each scenario; ranges                                                                           | Customers differ; a lighter request is not always lighter for them    |
| **Hindsight and anchoring**                              | A reviewer who sees the final answer may over-credit the alternative                                                             | Decision-time view; hindsight shown separately and labelled                                                             | Human cognitive bias remains                                          |
| **Automation bias / over-trust**                         | Numbers look precise                                                                                                             | Ranges, labels, notices, no `high` coaching confidence, human review required for skills                                | Depends on training and culture                                       |
| **Goodhart effects**                                     | If a score is rewarded, people write to satisfy the rules (for example avoid hedged wording) instead of working better           | Rules are public and evidence-linked; guidance says not to use scores for rewards                                       | Not eliminated                                                        |
| **Skill poisoning or propagation of a bad skill**        | A wrong or biased procedure, once published, is reused                                                                           | No auto-publish, four-eyes, simulation and regression tests, audit, rollback                                            | A reviewer team can still approve a bad skill                         |
| **Model-introduced bias (only if a model is connected)** | A language model may reword rationale or coaching with its own biases                                                            | Output validated; numbers and scores are never taken from a model; rationale wording only for steps the engine produced | Unmeasured: no real model was ever called                             |
| **Prompt injection through case text**                   | Case notes are untrusted input                                                                                                   | Delimited data blocks, no tools, validators, heuristic flags                                                            | Heuristics are evadable ([SECURITY.md](SECURITY.md))                  |
| **Privacy leakage**                                      | Real data could be ingested despite the policy                                                                                   | Redaction, tenant flag ([PRIVACY.md](PRIVACY.md))                                                                       | Self-attestation; pattern-based redaction                             |
| **Accessibility and language**                           | UI and sample content are English only                                                                                           | The CI plan includes Playwright with axe checks (not run for this document)                                             | No localisation; no accessibility audit                               |

## 7. Safe-use guidance

For people trying the demo:

1. Use synthetic data only. Mark a bundle `"synthetic": true` only when every organisation, person and incident is fictional.
2. Read ranges and labels before numbers. A Case Quality Index of 36 with range 32 to 39 on a synthetic case demonstrates the
   pipeline; it says nothing about any real engineer.
3. Treat forks as questions ("was there a better first step?"), not verdicts. Check the "Information available" and "unavailable"
   panels: the decision is judged only on what was known then.
4. Never use any score, band, warning count or fork count to compare, rank, reward or discipline people.
5. Review before you trust: accept or reject counterfactuals with a reason; only accepted scenarios can seed a skill; skills
   need independent approval before they are used.
6. Keep a human decision on closure and on every destructive or approval-required action. The product never closes a case and
   never recommends a destructive step.

For people extending it:

1. Add a new workload as a new **knowledge pack** with its own tests; do not reuse Teams authentication priors.
2. Put anything that touches a number behind deterministic code and a test; let a model touch only wording.
3. Keep every new output labelled as estimated or simulated, and give it a range.
4. Run the temporal-integrity and evaluation suites before and after the change ([EVALUATION.md](EVALUATION.md)).

## 8. What has not been done

- No bias or fairness audit, no demographic analysis, no user study and no study of how reviewers react to the scores.
- No human-labelled ground truth; calibration uses two synthetic cases and the numbers are estimates.
- No real language model has been called; the Azure OpenAI path is mock-validated only.
- No red-team exercise beyond the fixtures in the evaluation harness; no external security or privacy review.
- No accessibility audit or localisation.
- No monitoring of drift, because nothing is deployed.

## 9. Where each commitment is tested

These are the automated tests behind the main commitments above. The package suites (`packages/domain`, `packages/ai`) were run for
[EVALUATION.md](EVALUATION.md#2-test-inventory) and passed; the database-backed API tests named here were **not** run by me.

| Commitment                                                                  | Test (file and case)                                                                                                                                              |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coaching is constructive: no blame, no names, no roles                      | `packages/domain/test/coaching-report.test.ts`, `[FR-CO-01] is constructive and never about a person: no blame, no names, no roles`                               |
| Hindsight is separated and labelled, never part of what was known           | `coaching-report.test.ts`, `[FR-CO-01] hindsight is separated and labelled, and never part of what was known`; `temporal-integrity.test.ts`                       |
| Portfolio analytics carry no case text, names, aliases or per-person fields | `packages/domain/test/metrics-analytics.test.ts`, `privacy and responsible use (FR-AN-02)` (the cases tagged `[FR-AN-02]`)                                        |
| Model wording that ranks or disciplines individuals is rejected             | `packages/ai/test/validators.test.ts`, `[FR-AN-02] wording that ranks or disciplines individuals is rejected in any field`                                        |
| Simulated and estimated outcomes must be labelled                           | `validators.test.ts`, `[FR-CF-03] simulated, estimated outcomes must be labelled as such`; the `labelled-simulated` scenario check                                |
| No autonomous skill publication; creator, approver and publisher differ     | `packages/domain/test/skills-lifecycle.test.ts`; the CHECK constraint on `skill_approvals` ([DATA_MODEL.md](DATA_MODEL.md))                                       |
| Adversarial and injected outputs are rejected                               | `validators.test.ts` (every adversarial fixture) and the evaluation harness gates ([EVALUATION.md](EVALUATION.md#5-ai-evaluation-harness-deterministic-provider)) |
