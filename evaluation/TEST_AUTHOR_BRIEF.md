# Brief for the author of the locked test split

You write `evaluation/cases/test/` and the labels of those cases. You work from this page, `ANNOTATION_GUIDE.md` and
`vocabulary.json` alone. The test split is **locked**: it measures the engine on text that neither the engine's authors nor the
authors of the visible splits have seen. Anything that lets it leak defeats it.

## Rules (all of them are checked, or will be noticed)

1. **Never run the engine, and never run `eval:dev`, `eval:validation` or `eval:locked`.** Only the parent runs the locked split.
2. **Do not open** `evaluation/cases/dev/`, `evaluation/cases/validation/`, `evaluation/annotations/` (except your own `ev-t-*`
   files), `evaluation/runs/`, `packages/domain/src/knowledge/**`, `packages/domain/src/engine/{signals,actions,claims,requirements}.ts`,
   `packages/domain/src/ingest/**`, or any detector test. You learn what a label means from `vocabulary.json` only.
3. **Label before you look.** Write the events and the labels from a scenario you invent. Nothing you learn later changes a label.
4. **Your own words.** No six-word run may appear in the two shipped samples (`synthetic-data/cases/`), the vocabulary, the
   knowledge pack, the detector tests or another split. `eval:check` reports a match by case, event and word positions and
   withholds the phrase when it comes from the pack, a test or another split: rephrase your text at that spot.
5. **Everything is synthetic.** Fictional people and organisations; no real company or product beyond "Microsoft Teams", "Entra ID",
   "Conditional Access" and the like; only reserved addresses (`example.com`, `10.x`, `192.168.x`). No secrets.
6. Your labels are an **AI draft**: annotator `copilot-wave2-t`, kind `ai_draft` (already in `annotators.json`). Never present them as human.

## Format

- `evaluation/cases/test/<id>.json`, schema `caseguard.eval-case/2`. Id: `ev-t-<three digits>-<slug>` (`ev-t-001-lisbon-mfa-loop`);
  `split: "test"`; family `fam-2NN` (`fam-201` upward: all variants of one scenario share a family). Fields: `title` (what an engineer
  would file), `scenario` (one or two sentences of your own), `categories` (`paraphrase`, `noisy`, `negative-control`, `negation`,
  `contradiction`, `unsupported`), `workload` (`teams-authentication`, or another name for an unsupported case), `openedAt`
  (UTC), `derivedFrom: null`, `handedOverOrder: null`, and `events`: `key` (`ev01`...), `at` (minutes after `openedAt`, in time
  order), `who` (`customer`, `network`, `enduser`, `engineer`, `system`), `type` (an event type), `channel`, `title`, `text`.
  Plain text only. 5 to 16 events per case; a few of 25 to 40 for long-case checks.
- `evaluation/annotations/<id>.json`, schema `caseguard.eval-annotations/2`: one record of annotator `copilot-wave2-t`
  (see the guide and any record you may open: your own). `signals` exhaustive per event, `actions` exhaustive on engineer events,
  `absent` with a reason, `forks`, `earliestMissed`, `counterfactualDirection`, `conflicts`, `qualityBand`, `causes`,
  `rationale`, `uncertainty`; `"adjudication": null`.
- Run `./node_modules/.bin/prettier --write` on what you write (the repository checks formatting).

## What the test split must reach (independent cases; categories overlap)

At least **24 independent cases** and **100 labelled present signals**. Of them: 7 paraphrase (the same facts as a story told
elsewhere, in other words), 5 noisy (typos, chat style, pasted logs, quoted history, irrelevant detail), 5 negative controls
(nothing to find, look-alike text, other products), 4 negation-heavy (at least 3 absences with a reason each), 4 contradiction-heavy
(at least 2 conflicts each), 2 unsupported (another workload; the engine must refuse). Write like real support traffic: terse,
verbose and anxious customers, efficient and wasteful engineers, bullet lists, pasted log lines, abbreviations, typos, mixed UTC
and local times, a tool or system event, a wrong turn that is later corrected.

`pnpm --filter @caseguard/domain run eval:coverage -- --for-test` prints what the test split still lacks (cases by category, causes,
each signal present and absent, each action), computed from counts only. Cover the six named hypotheses (DNS, proxy, Conditional
Access, token or session, device state, service incident) at least as often as it asks.

## Checking and handing over

After each batch of six to eight cases: `pnpm --filter @caseguard/domain run eval:manifest`, then `... run eval:check`
(structure, vocabulary ids, hashes, independence; it never runs the engine). Fix every error. Commit with the cases. Do not touch
`dev` or `validation`. When you are done, report the counts by category, what `eval:coverage -- --for-test` still lists, and anything
you could not do. The parent locks the split (`eval:manifest -- --lock`) and runs it once.
