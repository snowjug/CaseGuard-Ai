# Demo script

How to present CaseGuard AI to judges and engineers: a 30-second introduction, demos of three, five and eight minutes, a live
variant, the questions you will be asked and honest answers to them. Everything here uses the **synthetic** demo data and the
**deterministic** AI provider that a local `pnpm dev` starts with; no network, Azure account or API key is involved.

Three conventions run through the script, and the product follows them too:

- **Say "synthetic" and "estimate" out loud.** Every figure on screen is an estimate from an authored knowledge pack, with a range
  and a basis. Nothing is a measurement, and two synthetic cases prove nothing about real-world effectiveness.
- **Say what is not real.** The default provider is a deterministic engine, not a language model. Azure OpenAI, Entra, Blob Storage,
  AI Search and Application Insights are implemented and were validated against local mocks only. **Nothing has been deployed to
  Azure.**
- **Times are presenter targets, not measurements.** The numbers below were **observed in a local run of the deterministic
  provider**; they are reproducible for the committed code, but compare them with the screen before you present, because a code
  change can move them.

| Section                                                                                                              | Use it for                                   |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| [1. Before you start](#1-before-you-start)                                                                           | Setup and the checks that avoid surprises    |
| [2. Numbers and phrases](#2-numbers-and-phrases-you-can-quote)                                                       | What to quote, what not to say               |
| [3. The 30-second introduction](#3-the-30-second-introduction)                                                       | An opening you can say from memory           |
| [4. Three minutes](#4-the-3-minute-demo), [5. Five](#5-the-5-minute-demo), [6. Eight](#6-the-8-minute-extended-demo) | The seeded demos                             |
| [7. The live variant](#7-the-live-variant-playing-the-story-from-step-1)                                             | Performing the 13 steps in front of the room |
| [8. The six strongest moments](#8-the-six-strongest-moments)                                                         | What the demo must land                      |
| [9. Questions and answers](#9-questions-judges-are-likely-to-ask)                                                    | Honest answers, with the evidence            |
| [10. Limitations](#10-limitations-to-state-up-front)                                                                 | Say these before you are asked               |
| [11. Differentiators](#11-technical-differentiators), [12. Business value](#12-business-value)                       | The case for the design                      |
| [13. If something goes wrong](#13-if-something-goes-wrong), [14. Shortcuts](#14-shortcuts)                           | Recovery and a cheat sheet                   |

## 1. Before you start

**Set up the seeded story (about two minutes of waiting, plus the first start).**

| #   | Do                                                                                                                                                                          | You should see                                                                                                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Windows PowerShell: `pnpm.cmd dev`. macOS, Linux or PowerShell 7: `pnpm dev`                                                                                                | The API and the web app start. With the default `DEMO_AUTO_SEED=true` the API seeds the story before it listens                                                                                                       |
| 2   | Wait for the API log lines `demo.auto_seed` (`completedSteps=13 totalSteps=13`) and `Server listening`                                                                      | In local runs the seeding took about 11 seconds after the migrations; a cold start on a slow, cloud-synced disk took about a minute                                                                                   |
| 3   | Open <http://localhost:3000>. If the page says "Choose who you are acting as", pick **Ava Engineer (synthetic)** on the page (or click **Choose persona** and pick **Ava**) | Home, with the pills "Demo data" and "Development identity" in the top bar                                                                                                                                            |
| 4   | Open the account menu (your name, bottom of the sidebar) and choose **Presentation mode** (or open `http://localhost:3000/?present=1`)                                      | The **Presenter strip**: "Guided demo · 13 of 13 done", "Last step: Outcomes compared", "present as Support Manager". The "Development identity" pill and the persona switcher are hidden; the "Demo data" pill stays |
| 5   | Open **Cases** and open **CG-SYN-1001** once                                                                                                                                | The product remembers the last case you opened, so Home's **Latest review**, the command palette and the `g` shortcuts for the case pages now use Case One                                                            |

If you want to perform the story instead of showing it, start from the `base` profile ([section 7](#7-the-live-variant-playing-the-story-from-step-1)).
Use a window of at least 1440 by 900 pixels (the size the screenshots and the end-to-end tests use). Rehearse once on the machine
you will present from: the first start is the slow part.

**Know the cast.** The strip names the persona of each step and offers a one-click switch to it.

| Persona                 | Role          | What they do in the story                                                     |
| ----------------------- | ------------- | ----------------------------------------------------------------------------- |
| Ava (`engineer`)        | engineer      | Adds and analyses the cases, creates the skill, applies it to Case Two        |
| Riley (`reviewer`)      | reviewer      | Accepts the simulated path, runs the simulation test and the regression suite |
| Morgan (`manager`)      | manager       | Read-only: quality, usage and cost, and the comparison of the two cases       |
| Casey (`skill_curator`) | skill_curator | Moves the skill to Draft and approves the pilot                               |
| Alex (`administrator`)  | administrator | Publishes the skill; the only persona who can seed or reset the demo          |

## 2. Numbers and phrases you can quote

**Observed in a local run of the deterministic provider; every figure is an estimate.** Where the screen differs, the screen wins.

| Quantity                           | Case One, CG-SYN-1001                                                                                                                                | Case Two, CG-SYN-1002                                                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| The case (fictional)               | Intermittent Teams sign-in failures for about 140 branch users (Pune and Leeds), Contoso Synthetic Ltd; 31 events; 9 to 12 March 2026 (about 3 days) | The same symptom for about 60 users at the Rotterdam site, Fabrikam Synthetic BV; 15 events; 14 April 2026 (about 8.5 hours) |
| Root cause in the record           | A DNS security policy on resolver 10.20.1.11 blocking a CDN host                                                                                     | An overloaded proxy node (proxy-rtm-2) after a TLS inspection update                                                         |
| Evidence and possible causes       | 59 claims in eight categories; 9 possible causes, leading "DNS resolution failure for sign-in endpoints" at 92.6 percent (model estimate)            | Leading: egress proxy or TLS inspection node, 92.6 percent                                                                   |
| Key decisions                      | 9; the earliest meaningful one is **event e03, 9 March 2026 09:41 UTC**, impact 0.571 (shown as 57%)                                                 | 0 (nothing to avoid)                                                                                                         |
| Case Quality Index                 | **36 of 100** (band: poor)                                                                                                                           | **99.1 of 100** (band: strong)                                                                                               |
| Time that could have been saved    | **About 55 percent** (estimate; the review shows 55 percent, range 44 to 83, low confidence)                                                         | **0 percent** (no key decisions)                                                                                             |
| Customer effort                    | 430 minutes (range 301 to 602)                                                                                                                       | 50 minutes                                                                                                                   |
| Token efficiency                   | 0.029 bits per 1k tokens                                                                                                                             | 0.158 bits per 1k tokens                                                                                                     |
| Tokens, real process versus path   | 40,850 used against 7,900 on the simulated better path: an **estimated** saving of 80.7 percent                                                      | not applicable                                                                                                               |
| Skill match                        | Source of the skill "Isolate a pre-authentication failure before pursuing identity policy"                                                           | **0.754** (card: "Match score 75% (model estimate)"; about 0.75 as of the first email); applied; conformance 4 of 4 steps    |
| Skill precedent (skill, Cases tab) | -                                                                                                                                                    | "Compared with CG-SYN-1001: 183 min vs 2,994 min to diagnosis; tokens -79.5%; evidence unchanged; 1 application."            |
| Comparison narrative               | -                                                                                                                                                    | "CG-SYN-1002 shows the stronger estimate on 6 of the 6 metrics where both cases have a value and differ."                    |

The agents of the six analysis tasks used 77,251 tokens in total in the seeded run; those counts are **simulated** by the
deterministic provider (characters divided by 4) and the cost is unknown because no unit prices are configured. Case One's time
that could have been saved (still called Avoidable Support Effort in the evaluation tables, in Home's **All metrics** and on the
Score page's **Compare** tab) reads about 55 percent in the review and 55.3 percent (43.7 to 83.3) in the evaluation tables;
before engine 2026.3.0 the seed held a generated id and the figure moved between starts, so if the screen shows another value,
quote the screen.

| Say                                                       | Do not say                                                              |
| --------------------------------------------------------- | ----------------------------------------------------------------------- |
| "a model estimate", "simulated", "estimated", "synthetic" | "the AI found", "predicts", "proves", "saves 80 percent in production"  |
| "the deterministic engine", "an authored knowledge pack"  | "a language model analysed the case" (none is called by default)        |
| "designed for Azure", "validated against mocks only"      | "Azure-based", "deployed", "running in Azure", "Azure OpenAI powers it" |
| "a reviewer accepted it", "four eyes"                     | "the AI approved", "it ranks engineers"                                 |

## 3. The 30-second introduction

> Support teams can't tell, afterwards, whether a safer or faster path existed, because hindsight contaminates every review.
> CaseGuard AI replays a case as it stood at each decision, finds the earliest meaningful decision, simulates a better path using only
> what was known then, and turns a reviewer-approved path into governed, reusable guidance. Deterministic code computes every
> number; a model can only propose text that code validates. All data you'll see is synthetic, and every score is an estimate.

That is 78 words. If you have ten more seconds, add: "The track is C+AI Hack for Quality, and the quality we care about is that
every claim is traceable to what was known when."

## 4. The 3-minute demo

Seeded story, presentation mode, **Ava** throughout. One idea per screen. The "Moment" column refers to
[section 8](#8-the-six-strongest-moments).

**Recommended: through the review.** One page reads Case One from the verdict to what to fix and what to learn, so the demo can
stay on it. Every figure below was **observed in a local run**; compare with the screen before you present.

| Time      | Screen                                                       | Do                                                                                                                                                                                                                                                                                                                                                                                                                             | Say                                                                                                                                                                                                                                                                                   | Moment |
| --------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 0:00-0:20 | Home (`g d`), then Cases                                     | Point at "13 of 13 done" in the strip and the "Demo data" pill. Open CG-SYN-1001 (its row opens the **Review**; or press `g` then `r`)                                                                                                                                                                                                                                                                                         | "Everything is synthetic and every number is an estimate. This one page reads a case in the order you decide."                                                                                                                                                                        | -      |
| 0:20-0:55 | Review: **Verdict**, **What happened**                       | The score: 36 of 100, "Poor", plausible range 32 to 39. "Earliest missed moment": "Heavy customer request when a lighter ask was available", 9 Mar 2026, 09:41 UTC. Under **What happened**, the chronology strip: nine numbered decision points, four meaningful waits                                                                                                                                                        | "Poor, about 36 out of 100, with its range. The earliest important missed moment: the engineer asked for traces, the full user list and every Conditional Access policy when two events and two pieces of evidence were on record. Nine such moments, and the customer left waiting." | 1      |
| 0:55-1:35 | **What went wrong**, **What would have changed the outcome** | Open **What went wrong** (it starts closed): decision point 1, "What was known then" beside "What was not yet known". Then, under **What would have changed the outcome**, the table "The recorded path and the better-supported path (simulated estimate)": time to diagnosis 2 d 1 h against 7 h 29 min (2 h 47 min to 10 h 59 min); "Low confidence (23%)"; "All 8 validity checks passed"; "Used only what was known then" | "Known then and not yet known sit side by side, so hindsight cannot leak in. The better path is a simulated estimate with ranges. Its confidence is low, 23 percent: it says how consistent the 200 simulated runs were. I would rather show that than hide it."                      | 2, 3   |
| 1:35-2:10 | **Fix first**, the evidence drawer                           | Open an evidence chip under a fix: the drawer shows the stored message with the badge "checked against the stored message". Press **Show in timeline**, then Back                                                                                                                                                                                                                                                              | "Every fix says what it rests on, one click away. A passage is shown as a quotation only if the server compared it with the stored message; otherwise the drawer says it could not check it."                                                                                         | 3      |
| 2:10-2:40 | **What to learn**                                            | "This resembles Isolate a pre-authentication failure ...": 2,994 min recorded to diagnosis against 195 min with the skill (114.8 min to 352.5 min). Read "Limits of this comparison"                                                                                                                                                                                                                                           | "The recorded path against an explicit with-skill estimate. The base analysis is unchanged and nothing is applied by looking. Case One is where the skill came from, so this reproduces its own replay: an illustration, not a test."                                                 | 4      |
| 2:40-3:00 | Cases, CG-SYN-1002: review, then Report                      | "Strong", 99 of 100, "No decision point stood out"; in **What to learn** "Match 75% (model estimate)" and "Plan adopted ... 4 of 4 steps followed". Then **Report** (the **More** menu, or **Open the report** under **Share**): Print, Copy summary, Download HTML                                                                                                                                                            | "A related case with another cause: nothing stood out, and the skill's plan was followed in 4 of 4 steps. The report is the same figures as a page to print or send; it leaves out what a role may not read, and says so. Two synthetic cases: a demonstration, not evidence."        | 5      |

**The same story through the specialist pages**, for a room that wants to see each tool:

| Time      | Screen                                    | Do                                                                                                                                                                                                                                                      | Say                                                                                                                                                                                                                                                   | Moment |
| --------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 0:00-0:20 | Home (`g d`)                              | Point at the strip ("13 of 13 done"), the "Demo data" pill and the "Latest review" card                                                                                                                                                                 | "The 13-step story has already been played through the real services as five synthetic people. Everything is synthetic; every number is labelled."                                                                                                    | -      |
| 0:20-0:50 | Timeline (`g t`)                          | Open the event "Teams sign-in - information needed" (9 Mar 2026, 09:41 UTC; badge "Key decision", "Event e03"). Open **What was known then** and click **Previous event**                                                                               | "The system marks the earliest meaningful decision. The engineer asked for traces from three users, the full user list and every Conditional Access policy: very high customer effort. Step back: later events are only counted, never shown."        | 1      |
| 0:50-1:40 | What if (`g l`)                           | Select the key decision badged "Earliest" ("Earliest meaningful decision" on its card). Tab **Compare** ("What would have changed the outcome"), then **Evidence per step**. Open **No-hindsight check** and point at "Validity checks (8 of 8 passed)" | "From that moment, using only what was known then, here is a simulated path. The recorded path and the alternative diverge here. Each step cites the evidence that supports it, and eight validity checks, including the no-hindsight check, passed." | 2, 3   |
| 1:40-2:10 | What if, then Skills (`g s`)              | Tab **Review**: a reviewer accepted the path with a reason. Open the skill "Isolate a pre-authentication failure before pursuing identity policy"; show "Where this skill stands"                                                                       | "A reviewer accepted that path; only an accepted path that passed the no-hindsight check can seed a skill. The skill went through simulation, review, pilot and validation, and was published by a third person."                                     | 4      |
| 2:10-2:40 | Score (`g q` on a case page) for Case Two | Open Cases, then CG-SYN-1002, then **Score**. Tab **Skills** ("Match score 75% (model estimate)"), then tab **Compare**                                                                                                                                 | "Case Two is a different case with another cause. The skill matched it using only its first email, and the comparison reads: the stronger estimate on 6 of 6 metrics. Two synthetic cases: a demonstration, not evidence."                            | 5      |
| 2:40-3:00 | Usage and cost (`g m`)                    | Open "Real process versus a simulated better path" ("Tokens used by the investigation") with its "Estimated" and "Simulated" labels                                                                                                                     | "40,850 tokens against 7,900 on the simulated path: an estimated saving, labelled estimated and simulated, because the telemetry itself is simulated."                                                                                                | 6      |

## 5. The 5-minute demo

The three-minute path through the specialist pages (the second table of section 4) with the evidence, the possible causes, the governance
trail and the time cursor added. Still **Ava**, seeded, in presentation mode. If you would rather open with the review, do
the first table of section 4 first and use the specialist pages below as its drill-downs: the review links into the Timeline
("Show in timeline") and What if ("Open in What if").

| Time      | Screen                   | Do                                                                                                                                                                                                                                                                                                               | Say                                                                                                                                                                                                            |
| --------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00-0:20 | Home                     | As in the three-minute demo                                                                                                                                                                                                                                                                                      | "Synthetic data, estimates, a story already played."                                                                                                                                                           |
| 0:20-1:00 | Timeline                 | Open the e03 event (**Details**: the text as stored and the action); open **What was known then**, move the **Time cursor** back with **Previous event**, then use **Back to latest**                                                                                                                            | "The time cursor re-runs the analysis on what was known then. The 'What was known then' bar counts what is withheld. That is how a reviewer judges the decision with the engineer's information."              |
| 1:00-1:30 | Evidence (`g e`)         | Show the **Evidence coverage** bar ("All categories 59" and the eight categories); open one claim with **Details**                                                                                                                                                                                               | "Every statement is a claim in one of eight categories, cited to its source event. The category comes from transparent rules; a reviewer can change it, and the original classification is never overwritten." |
| 1:30-2:00 | Possible causes (`g h`)  | Show the **Most likely cause**, "DNS resolution failure for sign-in endpoints", and its range, then the **Other possible causes** (nine possible causes in all); follow "Simulate a safer path from 9 Mar 2026, 09:41 UTC"                                                                                       | "Several explanations stay alive together. The confidence is a model estimate from an authored knowledge pack, not statistical truth, and it moves as evidence arrives."                                       |
| 2:00-3:00 | What if                  | The key decisions, **Compare**, **Evidence per step**, the section **Known only later** ("Hindsight: uses the final resolution and is never used to generate a path"); in **Review**, on a path awaiting review (strategy **Lowest customer effort**), note that the engineer's **Accept this path** is disabled | "Hindsight is kept in its own labelled section and never feeds generation. Accepting is a reviewer's decision, so the button is disabled for an engineer, and says why."                                       |
| 3:00-3:40 | Skill detail (via `g s`) | Tab **Governance**: "Decisions so far" and "Who is involved". Tab **Validation**: "Recorded runs" with "Full run"                                                                                                                                                                                                | "Four eyes: the creator, the pilot approver and the publisher are different people, and a database constraint backs part of the rule. Only a full run of the simulation set or the regression suite counts."   |
| 3:40-4:30 | Score for Case Two       | Tab **Skills** and the **Time cursor** (in **What was known then**) at the first event; try **Apply to this case** (disabled: "clear the time cursor first"); then tab **Compare**                                                                                                                               | "As of the first email, before any investigation, the skill already applies. Applying is only offered for the present. The comparison is an estimate for two cases."                                           |
| 4:30-5:00 | Usage and cost           | "Real process versus a simulated better path"                                                                                                                                                                                                                                                                    | "Token and customer-effort improvement, with honest labels."                                                                                                                                                   |

## 6. The 8-minute extended demo

Everything in the five-minute demo, plus the people, the audit trail and the honesty page. Use the strip's **Switch to ...** button
to change persona (in presentation mode it offers the persona of the current step); leave presentation mode with **Exit
presentation** if you need the full persona picker.

| Time      | Screen                                         | Do                                                                                                                                                                                                                          | Say                                                                                                                                                                                               |
| --------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00-2:30 | As in the five-minute demo, to Possible causes | Keep each screen to about 30 seconds                                                                                                                                                                                        | -                                                                                                                                                                                                 |
| 2:30-3:30 | What if as **Riley** (reviewer)                | Tab **Review**: the accepted path, its reviewer and the reason on record                                                                                                                                                    | "Reviewing a path is this role's permission; for Ava the same buttons were disabled. The decision is recorded with the name and the reason, and the original recommendation is kept."             |
| 3:30-4:30 | Score as **Morgan** (manager)                  | The group "Case Quality Index" (36 of 100) and "What lowered the score"; tab **Effort and metrics**: "Time that could have been saved" with its range, "What the estimate is made of" and "How the estimate was calculated" | "A rule-based estimate about the written record, never a rating of a person. Weights, penalties and bands are governed settings; an undecidable check widens the range instead of being guessed." |
| 4:30-5:30 | Skills as **Casey** (curator)                  | Open the skill; "Where this skill stands" (the lifecycle); tab **Governance**: "Next steps"; tab **Versions**                                                                                                               | "Publication is always a human act. The curator cannot publish what the curator created or piloted: a third person, the administrator, did."                                                      |
| 5:30-6:30 | Settings and audit as **Alex** (administrator) | The group "Audit log check", then **Verify again**; tab **Audit log**; tab **Reviewer decisions**; tab **Provider and reset**                                                                                               | "Every consequential action is an audit event in a per-tenant hash chain. The chain is tamper-evident, not tamper-proof: nothing outside the database anchors it yet."                            |
| 6:30-7:30 | System status (`g y`)                          | The panel "Dependencies" with its "Simulated stand-in" badge; the panel "What is real here"; "Migrations"                                                                                                                   | "This page tells you what is real: the offline provider is a stand-in, and every Azure integration was validated against mocks only. Nothing has been deployed."                                  |
| 7:30-8:00 | Usage and cost, then close                     | "Budgets and limits", "Safety limits", "Model calls"                                                                                                                                                                        | "Every model-capable task records its tokens, cache hits and fallbacks, with hashes instead of prompts. Budgets fail closed. Thank you."                                                          |

## 7. The live variant: playing the story from step 1

Use this when the room wants to see the product do the work. It follows the end-to-end test that plays the same story, with each
step done by the persona the story names. **It has not been timed on a normal machine**: analysis, extraction and validation run as
jobs whose duration here is unmeasured, so rehearse it and keep the seeded demo as the fallback.

1. **Reset to step 1.** Stop the API, run `pnpm.cmd demo:seed --profile base` (or, as Alex, use **Start from step 1** under **Demo
   data tools** on the Guided demo, `g p`), and start the API again. The guide shows 0 of 13. Case data is erased; users, settings
   and the audit trail stay.
2. **Ava adds Case One.** Cases, then **Try a sample case**, the wizard **Add a case** (its three phases are Add, Check and Create),
   the sample CG-SYN-1001: **Check case**, **Continue**, **Create and analyse**. Wait for the analysis: when it finishes, **Open
   review** is the primary action (focused, and nothing navigates by itself). Steps 1 to 5 complete together because they are
   derived from the stored analysis. Show the review, then the Timeline ("Showing 31 of 31 events."), Evidence, Possible causes
   and What if as in the demos above.
3. **Riley accepts the path** (strip: **Switch to Riley ...**). What if, tab **Review**, **Accept this path**, a reason, **Accept
   path**: the toast says "Path accepted". As the engineer the same button was disabled.
4. **Morgan reads the scores.** Score: the group **Case Quality Index** above the tabs, then the tab **Effort and metrics**.
5. **Ava creates the skill.** What if, tab **Review**, **Create skill**: a job runs and the page lands on the new skill, whose
   "Where this skill stands" says **Discovered**.
6. **Four people walk it through the lifecycle** on the skill's **Governance** and **Validation** tabs, each with a reason:
   Casey **Move to Draft**; Riley **Run simulation test**, **Move to Tested**, **Move to Reviewed**; Casey **Move
   to Pilot**; Riley **Run regression suite**, **Move to Validated**; Alex **Move to Published** (the toast says "Skill
   published"). Casey, who approved the pilot, is refused when trying to publish (403 `separation_of_duties`); Ava and Riley lack
   the publish permission (403).
7. **Ava adds Case Two** (sample CG-SYN-1002), then opens its Score, tab **Skills**, and applies the skill to the
   whole record (**Apply to this case**).
8. **Morgan compares.** Score, tab **Compare**, then Usage and cost. The guide now reads 13 of 13.

## 8. The six strongest moments

Land these six, whatever the length of the demo.

| #   | Moment                                                                | Where                                                                                       | The honest sentence to add                                                                       |
| --- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | The system highlights the earliest meaningful decision                | What if: key decision badged "Earliest"; Timeline: "Key decision" on e03                    | "Key decisions are detected from what was known at the decision time only."                      |
| 2   | The actual and simulated paths visually diverge                       | What if: tab "Compare" ("What would have changed the outcome") and tab "Graph"              | "The alternative is simulated and estimated; it is labelled so."                                 |
| 3   | The user can inspect exactly which evidence supported the alternative | What if: tab "Evidence per step"; "Validity checks (8 of 8 passed)" in "No-hindsight check" | "A no-hindsight check shows nothing later than the decision was used."                           |
| 4   | SkillDNA is generated from validated reasoning                        | What if: tab "Review"; skill detail: Governance, Validation and Versions tabs               | "Only a reviewer-accepted path seeds a skill, and publication is a human act by a third person." |
| 5   | A second case resolves more efficiently because of the learned skill  | Score for Case Two: tabs "Skills" and "Compare"; skill detail, tab "Cases"                  | "Two synthetic cases: this shows the pipeline, not real-world effectiveness."                    |
| 6   | Token and customer-effort improvement shown with estimated labels     | Usage and cost: "Real process versus a simulated better path"; Score: "Effort and metrics"  | "The telemetry is simulated; the saving is an estimate, with a range."                           |

Moments 1 to 3 are also on the review: "What went wrong" marks the earliest decision point and shows what was known then, "What
would have changed the outcome" sets the recorded path beside the simulated one, and the evidence drawer shows what each fix rests on.
Moments 4 and 5 are in its "What to learn" section, and moment 6 in the customer-effort row of "What would have changed the
outcome" and the tokens and customer-effort rows of the "What to learn" comparison.

## 9. Questions judges are likely to ask

Answers are short on purpose and stay inside what is verified. The evidence is in the linked documents.

**Is a real language model used?**
No. The default provider is a deterministic engine over an authored knowledge pack. An Azure OpenAI provider is implemented
(strict JSON schema output, no tools, managed identity) and was exercised only against a local mock server: no real call has ever
been made. Even with a model connected, the committed pipeline validates every proposal and records it **without merging it into any
stored result**, so a model cannot change a number ([AI_ORCHESTRATION.md](AI_ORCHESTRATION.md)).

**Then where is the AI?**
In the engine's reasoning (belief updating over competing hypotheses, an action-value model, simulation of alternative paths) and
in the architecture that lets a model take part safely: ten agent definitions, six of which the pipeline runs, a prompt registry
with hashes, context minimisation and redaction, seven validators, repair once then a deterministic fallback, token budgets, a
safety limit (a circuit breaker). What a real model's proposals add is **unmeasured** ([DOMAIN_ENGINE.md](DOMAIN_ENGINE.md)).

**Why not just ask an LLM to review the case?**
A model's review is not reproducible, cannot be shown to have used only what was known then, and mixes reading with judgement.
Here the reading may be a model's, the numbers are code's, and the authority is a human's.

**How do you stop hindsight from leaking into an earlier decision?**
At five layers: a branded `TemporalView` type, the engine (a prefix analysis equals the full analysis restricted to it), a
no-hindsight check (the engine calls it a leak check) and eight validity checks on every simulated path, the AI boundary
(validators reject identifiers and wording from the
future) and the read path (views are recomputed as of the instant, not filtered). Property tests and mutation tests exercise it
(they passed in the local runs; the CI unit run, 41546529865, had 6,152 pass and 0 fail); it is evidence for the tested paths
and the two cases, not a proof for any input
([EVALUATION.md](EVALUATION.md#4-temporal-integrity-evidence)).

**How are the scores calculated, and are they validated?**
Rule-based: six weighted dimensions with penalties capped at 40 points, and a range that widens when a check cannot be decided
from the record. Weights, penalties and bands are governed settings. They are **not validated against real cases**: there is no
human-labelled ground truth ([DOMAIN_ENGINE.md](DOMAIN_ENGINE.md#9-case-quality-index-cqi)).

**Is the 80 percent saving real?**
It is an estimate. It compares the tokens of the recorded process with those of a simulated better path on a synthetic case whose
telemetry is itself simulated, so the interface says "simulated telemetry". Do not read it as a measured saving.

**How do I know a quotation in the evidence drawer is real?**
The server compared the excerpt the engine recorded with the stored message, at the recorded field and offsets, and says
"checked against the stored message" only when they match; otherwise the drawer says it could not check it and shows no
quotation. That proves the passage is a real quotation of that message, not that the evidence supports the conclusion. Evidence
stored by an earlier engine version has no location until the case is analysed again, and reads "not checked"
([GUIDED_REVIEW.md](GUIDED_REVIEW.md#2-evidence-one-interaction-away), PL-14).

**Does the "with the skill" figure show that the skill works?**
No. It is an explicit comparison laid over the analysis: what the case recorded from a decision point, minus the skill's own
estimated saving, range against range. For Case One, the case the skill came from, it reproduces the skill's own replay, so it
illustrates the skill; it is not an independent test. Case Two has no decision point, so its card shows the adopted plan (4 of 4
steps followed) and only the skill's own saving. Nothing is applied by looking, and the base analysis is unchanged
([GUIDED_REVIEW.md](GUIDED_REVIEW.md#3-recorded-versus-with-the-skill), PL-16).

**Who can see the report, and is it logged?**
Anyone who may read the case sees the sections their role may read; a section a role may not read is left out with a note that
names the missing permission. The report is composed in the browser and no server stores it. **Reading it is not audited**, like
every other case read (PL-15), so the audit log cannot say who read or exported a report.

**Is it deployed on Azure?**
No. The Bicep template is designed and was built and linted with 0 errors, but no what-if or deployment was ever run, and no Docker
image was built locally. CI builds both images and pushes them nowhere; in run 41546529865 it passed its compose smoke test (12 checks)
([DEPLOYMENT.md](DEPLOYMENT.md), [CI_CD.md](CI_CD.md)).

**What was validated against Azure?**
Nothing live. Azure OpenAI, Entra token validation, Blob Storage, AI Search and the Application Insights export were tested
against fakes and local mock servers ([KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md#1-validation-gaps)).

**Is it multi-tenant, and how is isolation enforced?**
The tenant comes from the credential only, never the request. Isolation is in the application (tenant-scoped repositories) and in
the database (composite keys and forced row-level security for the `caseguard_app` role). It was tested on PGlite, an embedded
PostgreSQL; parity on a managed PostgreSQL server is **unverified** ([SECURITY.md](SECURITY.md#5-tenant-isolation)).

**Is the login secure?**
The persona login you see has **no real authentication** and works only for `APP_ENV` local and test; the API refuses to start with
it elsewhere. Deployed environments need Microsoft Entra tokens, validated against locally generated keys in tests and never
against a live tenant.

**What about real customer data and privacy?**
Synthetic data only. A tenant flagged synthetic refuses a payload declaring `"synthetic": false`, but a payload claiming `true` is
believed, and redaction is pattern-based, so it is a safety net, not a guarantee ([PRIVACY.md](PRIVACY.md)).

**Does it rank or grade engineers?**
No, by design: the scores describe the written record and the route taken; coaching is supportive and the analytics are aggregated.
The footer of the app says the scores must not be used to rank, rate or discipline individual employees. A tool can still be misused;
the guidance is in [RESPONSIBLE_AI.md](RESPONSIBLE_AI.md).

**How do you keep a bad skill from reaching engineers?**
A skill starts as Discovered, can only be seeded by a reviewer-accepted path that passed the no-hindsight check, needs a full
simulation test and regression
run, four-eyes approval by three different people (a database constraint backs part of it), and a human publishes it. Only pilot,
validated and published skills are matched. Skill effectiveness is shown against a simulated baseline and the source case, both
estimates.

**What happens when the AI provider, search or storage is down?**
The provider failing yields the deterministic result with a recorded reason, and the system pages report `degraded`. Azure AI Search
failing falls back to PostgreSQL full-text search. Object storage down keeps reads working but fails case creation. The database
down answers 503 `provider_unavailable` and fails `/readyz` ([ARCHITECTURE.md](ARCHITECTURE.md#14-failure-modes-and-degradation)).

**Does it scale?**
Not yet, and we do not claim it. Jobs, rate limits and caches live in one API process, an analysis blocks the event loop while it
runs, and there is no load test ([KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md#4-operational-limits)).

**How fast is an analysis?**
Measured locally, not in CI: Case One analysis took 509.3 ms on average (p95 1242.5 ms) in the domain benchmark, and a timeline
request 34.53 ms at p50 (p95 41.76 ms) in the API micro-benchmark (`pnpm bench` and `pnpm bench:api`;
[EVALUATION.md](EVALUATION.md#6-performance), [PERFORMANCE.md](PERFORMANCE.md)), both on a loaded machine. These are
micro-benchmarks on one machine, not a service-level objective.

**How was it tested, and is it accessible?**
Unit, property, integration and end-to-end tests, with axe checks on every page in light and dark themes: in CI run 41546529865,
6,152 unit tests passed and none failed, 1,033 integration tests passed and none failed, and all 374 Playwright tests passed (the axe
checks are among them; no separate count was recorded). That run is on an unmerged branch, and the 27 runs before the foundation
work all failed, so the default branch has no green run. The
integration tests ran on PostgreSQL 16 in CI; locally the suites that use a database run on PGlite.

**What is the licence, and what is built on what?**
No licence has been chosen: the owner decides, and until then all rights are reserved. The stack is open source (Next.js, React,
Fluent UI, Fastify, Zod, PGlite, Playwright, and others, listed in the README). Much of the code was written with GitHub Copilot
agents under the owner's direction.

**What would you do next?**
Merge the green foundation work so the default branch is green (CI has been green only on unmerged branches); deploy a dev environment and validate Entra, Blob and AI Search for real; evaluate a
real model against the harness; build a human-labelled evaluation set; then a durable job queue and enforced retention
([ROADMAP.md](ROADMAP.md)).

## 10. Limitations to state up front

Say at least the first four before anyone asks.

- **Everything is synthetic**, two cases written alongside the engine: the comparison is a demonstration of the pipeline (n = 2).
- **The reuse of a skill is shown, not proved.** On the second case the review shows the matched skill, the adopted plan
  (4 of 4 steps followed) and the skill's own saving; the recorded-against-with-skill figures exist only for the case the skill
  came from and reproduce its own replay (PL-16).
- **Reading a case review or exporting a report is not audited** (PL-15).
- **Every score is an estimate** from authored priors; none has been validated against real cases or by human labellers.
- **No real language model has been called**; Azure OpenAI, Entra, Blob, AI Search and Monitor were validated against mocks only.
- **Nothing has been deployed to Azure**, no Docker image was built locally (CI builds them), and CI is green only on unmerged branches.
- PostgreSQL ran only in the CI integration job (1,033 passed, 0 failed); no Azure Database for PostgreSQL was used, so
  row-level-security parity on a managed server is unverified.
- One workload (Microsoft Teams sign-in); redaction is pattern-based; malware scanning is a stub; prompt-injection screening
  flags but does not block; retention is stored but not enforced; the audit chain is tamper-evident, not tamper-proof.
- One API process: jobs, limiters and caches are in memory; no high-availability or backup design was validated.
- A time-boxed exception for a HIGH advisory in `@azure/msal-node` (until 2027-01-15) needs a person to accept the risk.

The complete list is [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).

## 11. Technical differentiators

- **Temporal integrity as a type, not a convention.** `TemporalView` is branded, the guarantee is enforced at five layers, and a
  time cursor lets anyone inspect a decision with exactly what was known.
- **"LLM proposes, code disposes."** Deterministic code owns numbers, safety policy and persistence; model output is minimised in,
  validated out (seven validators), repaired once, then replaced by the deterministic result.
- **Counterfactuals that cannot cheat.** Simulated from the exclusive decision-moment view, with a no-hindsight check, eight validity
  checks, seeded and reproducible rollouts, and hindsight kept in a separate, labelled section.
- **Honest by construction.** Every figure carries an estimated or simulated label and a range; an undecidable check widens the
  range; the system pages state what is a stand-in.
- **Governed knowledge.** SkillDNA has a lifecycle with gates, four-eyes approval, simulation and regression evidence, versions and
  rollback, and is never auto-published.
- **Safe multi-tenancy and accountability.** Tenant from the credential only, composite keys, forced row-level security, a
  per-tenant audit hash chain, fail-closed configuration guards.
- **Runs anywhere offline, designed for Azure.** Embedded PostgreSQL, local files and an offline provider by default; Bicep for Azure
  Container Apps, never deployed.

## 12. Business value

Stated qualitatively, because no real-world measurement exists:

- **Less avoidable rework.** Showing where a request cost the customer effort without giving the engineer much information makes
  the pattern visible and teachable.
- **Practice that survives turnover.** A reviewer-accepted path becomes a governed, versioned skill instead of tribal knowledge.
- **Reviews that are fair.** Judging a decision on what was known then removes hindsight from quality reviews, and the non-blaming
  design keeps coaching about the route, not the person.
- **Cost control for AI.** Context minimisation, caching, budgets and an honest execution record make model spend visible and
  bounded before any model is connected.
- **Auditability.** Who accepted what, with which reason, and who published a skill, is on record and verifiable.

Whether these translate into real savings is exactly what the roadmap's first tier (a real deployment, a real model, a
human-labelled evaluation) exists to find out.

## 13. If something goes wrong

| Symptom                                                               | Likely cause                                                                            | Fix                                                                                                                     |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| "Choose who you are acting as"                                        | No persona selected                                                                     | **Choose persona**, pick Ava                                                                                            |
| The Guided demo shows fewer than 13 of 13                             | The seed did not run, or the data was reset                                             | As Alex, **Play the whole story** (under **Demo data tools**); or stop the API, run `pnpm.cmd demo:seed`, start the API |
| Pages load but data calls fail                                        | The API is not up yet (it listens after the migrations and the seed)                    | Wait for `Server listening`; check <http://localhost:4000/readyz>                                                       |
| "The web server is not configured to reach the CaseGuard API"         | `API_INTERNAL_URL` is missing or invalid (a production build)                           | Set `API_INTERNAL_URL` for the web server                                                                               |
| The API cannot open its database                                      | Another process holds the PGlite directory                                              | Stop it: PGlite belongs to one process (also before `demo:seed`)                                                        |
| A button is disabled                                                  | The persona lacks the permission; the control says why                                  | Use the strip's **Switch to ...**                                                                                       |
| On Score, "Time that could have been saved" says "Not estimated here" | An earlier moment is set in **What was known then**: a window cannot see the whole path | Clear the time cursor: **Latest**                                                                                       |
| The strip is in the way                                               | Presentation mode                                                                       | **Exit presentation**                                                                                                   |
| A start-up or port problem                                            | See [LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md#12-troubleshooting)                     | -                                                                                                                       |

To start over completely: as Alex use **Reset demo** on the strip (it asks first and says it erases the cases, analysis results
and skills of the synthetic demo tenant while users, settings and the audit trail are kept), then **Play the whole story** on the
Guided demo (under **Demo data tools**).

## 14. Shortcuts

| Key                          | Does                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------- |
| Ctrl or Cmd + K              | Command palette: a command for every page, the personas and the settings     |
| `/`                          | Global search (tenant-scoped)                                                |
| `?`                          | The shortcut list, with the switch that turns the single-key shortcuts off   |
| `g` then `d` `c` `t` `e` `h` | Home, Cases, Timeline, Evidence, Possible causes                             |
| `g` then `r`                 | Review (of the active case)                                                  |
| `g` then `l` `q` `s` `m`     | What if, Quality (on a case page: that case's Score), Skills, Usage and cost |
| `g` then `g` `y` `p` `a`     | Settings and audit, System status, Guided demo, Advanced                     |
| `n` on the Guided demo       | The next step                                                                |

The `g` sequences are single-key shortcuts, which are on by default and can be turned off (a Ctrl or Cmd shortcut always works).
The case pages open for the active case, the last one you opened.
