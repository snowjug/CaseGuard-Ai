# CaseGuard evaluation set

An independent, synthetic, labelled set of support cases for one question: **how well does the analysis engine read a case?** Every case is plain
text events (customer mails, engineer mails, tool results, notes); every label says what a careful reader finds in them. The engine is run on the
cases and its output is compared with the labels. Nothing here is customer data, and none of it is a ground truth: see [Limits](#limits).

## What is in this folder

```
evaluation/
  vocabulary.json            the ids a label may use (signals, actions, hypotheses, fork categories, conflict classes); generated, do not edit
  cases/{dev,validation,test}/<id>.json     events only; immutable once committed
  annotations/<id>.json      labels of one case, one record per annotator, plus an optional adjudication
  annotators.json            who the annotators are (all of them AI assistants so far: kind "ai_draft")
  manifest.json              the split of every case, its family, and a hash of every case and annotation file
  runs/floors.json           regression floors for dev (edited by hand at each milestone)
  runs/baseline-wave1.json   the historical record of the Wave 1 numbers (not a live check)
  runs/locked-runs.json      append-only log of the runs on the locked test split
  ANNOTATION_GUIDE.md        how to label, and how a second annotator and an adjudication work
  TEST_AUTHOR_BRIEF.md       what the author of the locked test split works from, and nothing else
```

The code is in `packages/domain/test/evaluation/` (schemas, loader, accepted labels, pure metrics, the one adapter that calls the engine, reports, CLIs,
guards). Cases are written so that the corpus stays independent of the detectors: its authors never open the knowledge pack or the detectors, and the
checker rejects any six-word run that a case shares with a shipped sample, the vocabulary, the knowledge pack, a detector test or a case of another split.

## Splits

| Split        | Used for                                                    | Who may look at its engine output                                     |
| ------------ | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| `dev`        | tuning and debugging the detectors; floors guard it in CI   | anyone                                                                |
| `validation` | checking that a change helps beyond dev; **never tuned on** | numbers and aggregates; do not read it case by case to fix a detector |
| `test`       | the final, locked estimate                                  | `eval:locked` only, aggregates only, appended to a log                |

A **family** is one scenario told in more than one way; every family lives in exactly one split. A **reordered copy** (`derivedFrom`) repeats a case with its
events handed over in another order, has no labels of its own, and is checked for invariance (it must give exactly the analysis of its source).
Wave 1's 16 cases are migrated into dev with their original labels (annotator `copilot-wave1`); the cases written for Wave 2 carry `copilot-wave2-a`
(dev and validation) or `copilot-wave2-t` (test).

## How to run

All commands are `pnpm --filter @caseguard/domain run <script> [-- flags]`. A run of one split takes a few seconds; `--counterfactual` is slow, so on a shared machine run it at low priority (`nice -n 19`).

| Script                         | What it does                                                                                                                                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eval:check`                   | structure, vocabulary, hashes, family and split placement, overlaps, who reads what. Never runs the engine. Run it after every change.                                                                      |
| `eval:dev` / `eval:validation` | run the engine on a split and print the report (`--annotator <id>`, `--detail`, `--counterfactual`, `--no-recommendations`, `--json`); the latest run is kept in `runs/<split>-latest.json` (not committed) |
| `eval:locked`                  | the only way to run the engine on the test split; refuses when the split or its labels changed since the lock; prints aggregates; appends a record to `runs/locked-runs.json`                               |
| `eval:manifest`                | rewrite `manifest.json` (run after the last edit of a case or an annotation; `--check` verifies, `--lock` is for the parent when the test split is complete)                                                |
| `eval:coverage`                | what the corpus covers and what each split still lacks against the minima (`--for-test` shows the test author only the test split)                                                                          |
| `eval:annotate`                | an empty draft for a blind second annotator (`-- --case <id> --annotator <id>`); `-- --merge <draft>...` adds a filled draft to the case's annotation file as a record                                      |
| `eval:agreement`               | Cohen's kappa per label kind between two annotators (`-- <annotator A> <annotator B> [--split dev]`) and the disagreements to adjudicate                                                                    |
| `eval:vocabulary`              | regenerates `vocabulary.json` from the knowledge pack (only when the pack changes)                                                                                                                          |

From code: `evaluateCase(caseId, split)` and `evaluateSplit(split, options)` (`packages/domain/test/evaluation/evaluate.ts`) return the structured results that the CLIs
print. They refuse the test split; `evaluateLocked()` is the only path to it.

**Never use detail output (per-case lines, misses, examples) from validation or test to change a detector.** Use dev for that. A change that helps dev and
hurts validation is overfitting, and the validation numbers are the evidence.

## What is measured

Signals and actions (precision, recall and F1 by case category, by dimension and by id, with Wilson intervals; a rate over fewer than 20 items is flagged
as too small to trust), the causes of each missed or extra label, negation accuracy (denied, guessed, planned, conditional, attributed and corrected
statements must not be read as facts), contradiction recall by event pair with class accuracy among the pairs found (precision and recall of the pairs
become available when the engine reports conflicts; until then the report says `not_available` with the number of labelled conflicts), refusal of
unsupported workloads, fork recall and precision, the earliest missed moment, the leading hypothesis and calibration, citation validity, recommendation
counts, the counterfactual direction, and quality bands. The metric definitions are in `metrics.ts`; labels that are not accepted (excluded, or two annotators with no
adjudication) are never counted.

## Reproducing the Wave 1 baseline

The Wave 1 numbers (13 true positives, 4 false positives, 53 false negatives on the 13 independent cases; engine 2026.3.1, knowledge pack 1.0.0) are a
**historical record** in `runs/baseline-wave1.json`, per case and per label. They come from the old harness at commit `c5f5d96` and are not pinned by a live test,
because the detectors are being improved:

```bash
git worktree add ../CaseGuard-wave1 c5f5d96 && cd ../CaseGuard-wave1
pnpm install --frozen-lockfile
pnpm --filter @caseguard/domain run eval        # the old harness: 13 / 4 / 53
```

The same cases and labels run through the new harness (on a branch that still has the Wave 1 detectors the signal totals are the same):

```bash
pnpm --filter @caseguard/domain run eval:dev -- --annotator copilot-wave1
```

## Limits

- **All labels are written by AI assistants.** There is no human annotator and no second annotator yet; an AI-drafted label is not the same as a human one.
  Each case has one annotator, so there is no measure of agreement; `eval:agreement` and the adjudication format exist for when a second annotator is added.
- **The cases are synthetic.** They are written to look like support traffic, but they come from three authors (dev and validation by one assistant, test by another)
  that never saw the engine; they do not cover every product, language or customer, and a good score does not promise good results on real cases.
- **The sets are small.** Rates over a few dozen labels move a lot with one case; read the intervals, and read the per-category numbers as hints.
- **A label is a reading of the text, not of the facts.** What is true in a scenario is only what the author wrote; where the author was unsure, the record says so (`uncertainty`).
- **The vocabulary is the pack's.** It names what the engine looks for; a signal nobody put in the vocabulary cannot be labelled, so the set cannot show what the engine misses outside it.
- **Dev is used for tuning, so dev numbers are optimistic.** Only validation and the locked test split say anything about unseen cases, and the test split can be used once per release.

## Changing the set

1. Edit or add a case and its annotation file (or add a record for a second annotator); never edit a committed case file's events once the manifest has them.
2. `eval:check`, then `prettier --write` on the JSON, then `eval:manifest`; a changed annotation bumps `annotationVersion` and keeps the case file hash.
3. Cases in the test split are only added before the lock; after it, the set is never rewritten.
4. `ANNOTATION_GUIDE.md` is the rule book for labels; `TEST_AUTHOR_BRIEF.md` is the only document the test author needs.
