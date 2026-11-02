# Guided review and report

The guided review is the way to read one analysed case: a single page that goes from the verdict to what to do next, in the
order a person decides. The report is the same read as a page to print, copy or download. Both are made from the reads the other
case pages already make; they add no engine, change no score and (apart from two read routes) add nothing to the API. This
document says what each part reads, how it behaves when a role may not read something, what is checked, and what is not.

Every figure on both pages is an estimate or a simulation and says so. Wherever the engine could not support a statement, the
page says that instead of filling the gap.

| Page          | Route                    | Open it from                                                              |
| ------------- | ------------------------ | ------------------------------------------------------------------------- |
| Guided review | `/cases/[caseId]/review` | "Guided Review" in the navigation (`g` then `r`), or "Open guided review" |
| Report        | `/cases/[caseId]/report` | "Report" on the guided review, or the Share section                       |

"Open guided review" is the primary action of the case overview, and of the last step of the add-case wizard once the analysis
has succeeded. The specialist pages (timeline, evidence ledger, hypotheses, Counterfactual Lab, quality review) are unchanged
and one link away; the review links into them ("Show in timeline", "Open in the Counterfactual Lab").

## 1. The page, section by section

The sections follow the order of a review: what the verdict is, how the case unfolded, where it went wrong, what a better path
would have looked like, what to do, what to learn, how to share it. Each section except Share ends with a closed "How this was
calculated" note in plain words, and one note after the last section covers the whole review.

| #   | Section                   | Answers                                                                                                  | Reads (permission)                                                                                                        | Writes (permission)                                                      |
| --- | ------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | Verdict                   | How good was the case, in words, and what was the earliest important missed moment?                      | `quality.get`, `metrics.get`, `coaching.get` (`quality:read`); `cases.get`, `analysis.latest`, `forks.list` (`case:read`) | none                                                                     |
| 2   | Chronology                | What happened, who was waiting for whom, where were the decisions?                                       | `timeline.get` (up to five pages of 200 events), `forks.list`, `analysis.latest`, `cases.get` (`case:read`)               | none                                                                     |
| 3   | What went wrong           | At each decision point: what was known, what was not yet known, what was done, what was better?          | `forks.list`, `analysis.latest` (`case:read`)                                                                             | none                                                                     |
| 4   | What should have happened | The recorded path beside a simulated better-supported path, with ranges, confidence, checks, assumptions | `counterfactuals.list`, `forks.list`, `actions.list` (`case:read`)                                                        | `counterfactuals.run`: simulate when none exists (`counterfactual:run`)  |
| 5   | Next actions              | What to do, most urgent first, each with its reason and its evidence                                     | `actionValue.rank`, `warnings.list`, `counterfactuals.list` (`case:read`); `quality.get`, `coaching.get` (`quality:read`) | none                                                                     |
| 6   | Learning                  | Which published skill resembles the case, and what would following it have changed?                      | `skillMatches.list`, `skillOverlay.get` per match (`skill:read`)                                                          | `skillMatches.apply` (`skill:apply`), `skills.extract` (`skill:extract`) |
| 7   | Share                     | The report, and a short summary to copy                                                                  | the reads above that the role may make                                                                                    | none (the summary is copied in the browser)                              |

Three properties hold for every section:

- **A part never waits for another and never fails the page.** Each read is its own query. A role that lacks the permission
  of a read does not send it (the API would answer 403) and is told which permission is missing and who has it; a read that
  failed shows its own retry; the rest of the page works. A skill curator, who may not read case quality, still gets the missed
  moment, the chronology, the decision points, the actions that need no quality data and the learning.
- **Nothing is computed by the screen that the server computed.** The chronology picture, the verdict wording and the table of
  recorded and with-skill figures are laid out from the API's figures, never re-derived. The model layer
  (`apps/web/src/features/review/model/`) is pure functions with unit tests.
- **The writes are the existing ones.** Simulating, adopting a skill's plan and extracting a skill keep their permission,
  idempotency, four-eyes governance and audit record in the API; the page only offers them where the role may use them, and
  adopting a plan asks for a confirmation first.

Reading order for a person who has two minutes: the verdict card (quality band and range, the earliest missed moment with what
was done, what was already known and the better step), then "See what went wrong".

## 2. Evidence one interaction away

Every warning, recommendation and decision point lists its evidence as chips. A chip opens one drawer (Fluent overlay drawer)
that shows, for each link: what it is, who wrote it and when, and for text the passage with the matched part highlighted.

- **The drawer shows a quotation only if the server checked it.** `provenance.resolve` compares the excerpt the engine recorded
  with the stored event text at the recorded field and offsets, and answers `verified`, `mismatch` or `not_checkable`. Only
  `verified` carries the surrounding text and the "checked against the stored message" badge. A derived item (a hypothesis, a
  scenario) shows its title and no quotation. See [DOMAIN_ENGINE.md](DOMAIN_ENGINE.md#51-source-references-and-checking-a-citation-provenance).
- **Evidence stored before engine 2026.3.1 cannot be checked** until the case is analysed again; it then reads "not checked",
  never "verified" ([KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md), PL-14). A verified citation proves the excerpt is a real
  quotation of that event, not that the evidence supports the conclusion.
- **The drawer is in the address** (`?evidence=<type>:<id>`): it survives a reload, can be shared, and is still open when someone
  comes back from "Show in timeline" with the Back button. Opening it never adds a history step.
- Escape and the close button close it, Tab stays inside it while it is open, and focus returns to the chip that opened it.
- A recommendation with no case-specific evidence says "General guidance — no case-specific evidence" and carries no link. The
  page never invents one.

## 3. Recorded versus with the skill

The Learning section shows, for each published skill that applies or partly applies to the case ("This resembles ..."), the
recorded path beside what following the skill would have changed. It is an explicit comparison laid over the analysis, not a
second analysis: the base engine output is untouched, `skillOverlay.get` writes nothing, and adopting the plan is the separate,
audited `skillMatches.apply`.

| The case                                                        | What the section shows                                                                                                                                                                                |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Has a decision point where the skill's first step was available | The decision point, what the case recorded, the skill's cheaper alternative, and a table of recorded, with-skill (range) and the skill's own saving for time to diagnosis, customer effort and tokens |
| Has no decision point that relates to the skill (Case Two)      | A sentence that says so, what the case recorded, and only the skill's own saving on the case it came from                                                                                             |

"Limits of this comparison" is always shown: the skill was distilled from one synthetic case; for another case the skill's saving
is assumed to carry over; probabilities, times and efforts are model estimates; nothing was executed. Where the skill came from
the case itself, the with-skill figure reproduces the skill's own replay. The review always reads the whole record; the API can
also serve the comparison as of an earlier instant, and then withholds the figures that depend on later events
([DOMAIN_ENGINE.md](DOMAIN_ENGINE.md#13-skilldna)).

## 4. The report

The report has nine sections, in the order of a decision-ready review: Verdict, Chronology, The earliest important missed moment,
The recorded path, The better-supported path, Recommendations backed by evidence, Reusable learning, Uncertainty and how this
was calculated, Review and approval. The last one shows who accepted a path and why, which claims a person reviewed, which
warnings were dismissed, which skills were adopted and how closely they were followed, and the analysis run and read time the
report was made from.

| Output          | How                                                                                                                                                                                                                                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read in the app | The same document component, with a contents list and the chronology as a picture (a text list under it)                                                                                                                                                                                        |
| Print           | `window.print()` with a print stylesheet: no application chrome, black on white, page breaks, the address of every link written out. "Save as PDF" in the browser is the PDF route; the server generates no PDF                                                                                 |
| Copy summary    | A short plain-text summary with the address of the report, built from what the role may read; it names what it left out                                                                                                                                                                         |
| Download HTML   | One self-contained file named from the case reference. React escapes every string of the case; the file has no script, no network access, no frames and no fonts (`Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'`) |

- **It is built in the browser from authorised reads.** `buildReport` is a pure function of what was read (no clock, no
  network); the in-app page, the print and the file are all that one model. There is no report endpoint, so no server stores a
  report and nothing about its text reaches a log.
- **A section a role may not read is left out with a note, never guessed.** The top of the report says how many sections were
  left out and why; the section itself says which permission is missing.
- **Reading the report is not audited** (see section 6).

## 5. Responsive and accessible behaviour

- Below 640 px the chronology picture gives way to the list that is its text alternative, laid out in one column with the
  side (customer, engineer, system) named on each event. The section navigation scrolls sideways instead of wrapping over the
  content. Tables stay tables inside a named, keyboard-focusable scroll region.
- The sections are landmarks with headings in reading order; "On this page" is plain links that move focus to the section.
- Meaning is never colour alone: every status carries an icon or pattern and a word, and the verdict names the quality band in
  one word everywhere on its card.
- Control names contain their visible text (WCAG 2.5.3), so a voice-control command that says what is shown works.
- Verified by `axe-core` (WCAG 2.1 A and AA, best practice) on the review and the report in the light and dark themes on a
  desktop and on a phone, with the drawer open, and by keyboard-only and no-sideways-scroll checks at 390 by 844 pixels.
  **Not verified:** a screen reader used by a person, a browser other than Chromium, and a printed page.

## 6. What this does not do

- **Reads are not audited.** The audit log records changes and the reads of the audit log and the user list. The guided review,
  `provenance.resolve` and `skillOverlay.get` read case data under the caller's permission and tenant (and row-level security),
  and leave no audit event, like every other case read. The report is composed in the browser, so printing, copying or
  downloading it leaves no server record. Who read a case review is therefore not recorded ([KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md), PL-15).
- It reads the first 1,000 events of a case and says when there are more; the key events of the chronology are chosen by rule,
  and the spacing of the picture is compressed (it says so). See PL-13.
- It does not rank or rate people: the coach's words and every recommendation are about the case and its process.
- The model path is **not part of what was verified**: every figure comes from the deterministic rules. If a model is
  configured, its proposals are validated and recorded but never merged into these figures ([AI_ORCHESTRATION.md](AI_ORCHESTRATION.md)).

## 7. Where it lives and how it is tested

| What                     | Where                                                                                                                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pages and sections       | `apps/web/src/features/review/` (`ReviewPage.tsx`, `sections/`, `report/`, `evidence/`)                                                                                                               |
| Pure view model          | `apps/web/src/features/review/model/` (verdict, chronology and strip geometry, decisions, paths, actions, learning, method notes)                                                                     |
| Server reads added       | `provenance.resolve` (`apps/api/src/services/views/provenance.ts`), `skillOverlay.get` (`apps/api/src/services/skills/overlay.ts`); contracts in `packages/schemas/src/{provenance,skill-overlay}.ts` |
| Unit and component tests | next to each module; the fixtures are real engine output of the two samples, trimmed, and two hand-built ones (`apps/web/test/fixtures/review/README.md`)                                             |
| End to end               | `e2e/pages/review.spec.ts` (the journey, evidence by keyboard, role degradation, the report's outputs, axe), `e2e/mobile.spec.ts` (390 by 844)                                                        |
| API tests                | `apps/api/test/provenance.test.ts`, `apps/api/test/recommendations-evidence.test.ts`, `apps/api/test/skill-overlay.int.test.ts`                                                                       |
