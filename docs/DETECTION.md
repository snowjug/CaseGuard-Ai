# Detection methodology

How `packages/domain` turns the words of a support case into **observations** (a signal found in an event), and what it
does with a sentence that mentions a signal without stating it. This page describes engine **2026.4.0** with the
knowledge pack `kp.teams-authentication` **1.1.0**. It is the reference for anyone changing a detector.

Related: [DOMAIN_ENGINE.md](DOMAIN_ENGINE.md) (what happens once an observation exists), [EVALUATION.md](EVALUATION.md)
(how well detection works, and how that is measured), [MISS_TAXONOMY.md](MISS_TAXONOMY.md) (why the first evaluation
missed what it missed), [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).

## 1. Why this exists

The first independent evaluation (16 synthetic cases, 66 labelled signals) read 13 of them (recall 20%) and fired on 4
statements that deny the signal. The misses were not random: the pack's patterns were written around technical tokens
(error tags, codes, literal phrases) and people write cases in their own words. The false positives were all one
mistake: a detector found the words of a signal inside a sentence that says the opposite.

Nothing here is a model. Detection stays deterministic, explainable and cheap: the same text gives the same
observations, in every database, at every time.

## 2. How one event is read

For every event of a temporal view, and every signal of the pack:

1. **Quoted history is blanked out.** In e-mail-type events, lines that start with `>` and everything after a
   `-----Original Message-----`, `On … wrote:` or a long underscore line are replaced by spaces of the same length. A
   quoted reply is not the sender's statement, and the earlier event already holds it.
2. **Chat shorthand is normalised** from a fixed list (section 5). Every replacement keeps a map to the stored text.
3. **Each detector is matched** against that text. A detector weighs up to 12 matches in one event (a bound on the cost
   of a hostile text) and keeps the first one that _states_ the fact.
4. **Each match is given a modality** (section 3): does the sentence state the fact, or only mention it?
5. A match whose modality lets it fire is an **observation**. Its excerpt and offsets are taken from the **stored
   text**, never from the normalised copy, so `verifyExcerpt` still checks it.
6. A match that does not fire is **set aside** and recorded as a suppressed observation (signal, event, modality, the
   words that decided it, the excerpt). Nothing is hidden: the analysis carries what it did not count and why.
7. If the set-aside match is a **denial** of the positive side of a declared signal pair, the observation is the other
   side of the pair (section 6).

Observations gain three fields: `modality` (asserted, attributed or corrected: the other modalities never become
observations), `cue` (the words that decided it) and `negationOf` (set when the observation reads a denial).

## 3. Statement modality

A sentence can mention a fact without stating it. `modality.ts` holds a short, fixed list of cue phrases in the manner of
NegEx. Each cue has a modality, a priority (lower wins), a **reach** (how many words after the cue it still applies) and
whether it stops at a comma. The scope of a cue ends at the end of the clause: a sentence end, a semicolon, a colon, a
line break or a contrast word (`but`, `however`, `although`, …). Abbreviations (`e.g.`, `etc.`) and labels such as
`Correction:` do not end it.

| Cue                   | Modality      |     Reach (words) | Example of what it decides                         |
| --------------------- | ------------- | ----------------: | -------------------------------------------------- |
| `cannot-rule-out`     | speculative   |                 6 | "We cannot rule out a DNS fault yet."              |
| `not-sure`            | speculative   |                 4 | "I am not sure whether the proxy is involved."     |
| `condition`           | conditional   | 12, comma-bounded | "If the logs had been checked, …"                  |
| `whether`             | conditional   | 10, comma-bounded | "Please check whether the logs hold a failed row." |
| `counterfactual`      | conditional   |                10 | "The engineer would have checked the logs first."  |
| `negation-verb`       | negated       |  5, comma-bounded | "The engineer did not check the logs."             |
| `negation-quantifier` | negated       |                 4 | "No log review was performed." "Nothing active."   |
| `guess`               | speculative   |                 8 | "It might be a DNS issue." "I suspect the proxy."  |
| `request`             | requested     |                 8 | "Please send a HAR capture."                       |
| `intention`           | future intent |                 8 | "I will check the logs tomorrow."                  |
| `reported-by-someone` | attributed    |                10 | "The customer said the logs were checked."         |
| `correction`          | corrected     |                12 | "Correction: the proxy was changed on Tuesday."    |

**A question** is not on the list. After the cues have decided, a span that lies in a question is `requested` when it
would otherwise have fired (asserted, negated, attributed or speculative); a request, a condition or a plan already is
not a statement, so a question adds nothing to it. A question is a clause that opens with an auxiliary or a wh-word
("is", "does", "could", "what", "any") and ends with a question mark, with no comma between the span and the mark (one
before "or" does not count, as in an alternative question). "Are no failed rows recorded for these users?" and "Please
check whether service health lists nothing active" therefore deny nothing, while "120 users cannot sign in, does anyone
know why?" still states the 120 users: the question comes after a comma.

Every cue carries a purpose, sentences it must decide and look-alikes it must **not** decide (`not only`, `no problem`,
`please note`, `if possible`, a habit such as "if you wait it sometimes works"). A test runs all of them, so the list
cannot drift from what it says it does.

**What a detector is for decides which modalities let it fire:**

| Use                                    | Fires on                                      |
| -------------------------------------- | --------------------------------------------- |
| signal, requirement                    | asserted, attributed, corrected               |
| action done by the engineer            | asserted, corrected                           |
| action done by the customer on request | asserted, corrected, requested, future intent |

A customer's report ("the customer said the logs show nothing") is evidence of what was reported, so it counts as a
signal. An engineer's planned or denied step is not a step taken. A request to the customer is the action in the record.

**Detectors that look for a denial.** A pattern such as "no active incident" spells the negation out as its content, so a
negation inside its own match must not count against it. A detector is `negativeContent` when it says so, or, when it
does not say, when its own pattern contains a negation word; cues _before_ the match still apply.

## 4. Quoted history and the title of a reply

Only `customer_email`, `engineer_email` and `escalation_response` events can quote. Masking never changes a length, so
offsets in the masked text are offsets in the stored text. A quotation without a marker (pasted without `>`) is read as
the writer's own words; this is a known limit.

The title of a reply (one that opens with `Re:`, `Fwd:`, `AW:`, `SV:`, `Odp:` or `Re[2]:`) repeats the subject of the first
message of the thread, and the first event already holds those words. It is blanked in the same way, for events of every
type, so that a detector does not count the subject again at every reply and put it to the replier. A reply whose own body
says the same thing is still read from the body.

## 5. Chat normalisation

People write support messages as chat: "ppl", "pls", "somtimes", "didnt". `normalise-chat.ts` replaces, **whole words
only and case-insensitively, from a fixed reviewed list**: abbreviations (`ppl`, `pls`, `thru`, `b4`, `msg`, `acct`,
`pwd`, `tmrw`, `tue`/`thu`/`fri`, …), negations typed without the apostrophe (`dont`, `didnt`, `cant`, `wasnt`, …) and
common typos, each the misspelling of exactly one word. `r` and `u` become `are` and `you` only when they stand alone, in
lower case, between spaces or phrase-ending punctuation. There is no fuzzy matching and no guessing: a typo that is not
on the list is not read. A replacement is mapped back (`toOriginalSpan`), so a match in the normalised text is reported
at its place in what was written.

## 6. Wording families and signal pairs

**Families.** A fix is a reusable family, not a list of the sentences that failed (see
[MISS_TAXONOMY.md](MISS_TAXONOMY.md) for the twenty families this wave started from). The pack builds them from shared
fragments (`GAP`, `SIGNIN_CONTEXT`, `WHEN_RELATIVE`, `WHEN_WEEKDAY`, `CHANGED`, `ACCESS_RULE`, `ENG_ROLES`,
`LOG_RESULT_TYPES`) so that one change reaches every pattern that uses a word. Phrases that are ambiguous alone (a
name that is not resolved, a timeout) need a Teams or sign-in context; the error codes stay unguarded. Gaps between words
are bounded (`[\w ]{0,25}`), never open-ended. `robustness.test.ts` guards this for every pattern: a static check rejects
nested repetition, back-references and unreviewed runs of unbounded repetition, and a probe feeds each pattern text
derived from itself (repeated, cut short, over long gaps) and fails when one takes 100 ms of CPU.

`detector-families.test.ts` holds, for each family, sentences it **must read** and look-alikes it **must not read**. These
tables are examples written by the pack's author. They are a regression guard, not an independent measure of recall;
that comes from the held-out evaluation sets ([EVALUATION.md](EVALUATION.md)).

**Signal pairs.** Two signals can state the same thing from opposite sides ("an incident is active" / "no incident is
active"). The pack declares eight pairs: server-side records, name servers, proxy nodes, service health, access-policy
change, device token, cache clear and user scope. A pair says whether the state can change as work proceeds
(`timeVarying`) and whether a denial of the positive side is a statement of the negative side (`denialIsNegative`). Where
it is, "service health lists nothing active" is read as `service-health-clear` with `negationOf` naming the denied
signal. For the cache-clear and scope pairs a denial is **not** the other side ("it is not just one user" does not say
how many), so they stay separate. A pack that puts one signal in two pairs, names an unknown signal or the same signal on
both sides is rejected when it is loaded.

## 7. Conflicts

`detectConflicts` finds two statements of one case that cannot both stand and keeps both sides, with the event, the role,
the modality and the source reference of each. It sees only what the pack models: a signal pair stated from both sides,
and a claim attribute stated with two values (how many users, when the failures began). The first rule that applies
decides the class:

1. the later statement is worded as a correction: `corrected_information`;
2. either statement is hedged ("seems", "mostly", "I think", or a figure marked "roughly" or "about" that the other
   figure is within a quarter of, or half an hour of): `ambiguous_wording`;
3. the same person made both: `temporal_update` when the pair is declared time-varying (a fault that was fixed),
   otherwise `direct_contradiction`;
4. two people made them: `source_disagreement` when a later statement takes one side, otherwise `unresolved_conflict`.

A positive-to-negative move on a time-varying pair (the fault is gone) is an update, not a conflict. The sixth class,
`ambiguous_wording`, is what a reviewer should read as "possibly the same fact worded two ways". Each conflict names the
rule that found it and carries an uncertainty (a level and a note); none of this is a reading of meaning. The subject of a
conflict is the label of the pair or of the attribute ("Number of affected users"), the text both of its sides carry; its
id is derived from the pack's key for it, so rewording a label does not rename a conflict.

The API serves what this section and the next one find, together with the observations that were set aside (section 3),
as `GET /api/v1/cases/{caseId}/record-findings` ([API.md](API.md#temporal-reads-asof)): computed from the events of the
window, so that with `asOf` nothing recorded later is named.

**What is not a side.** A figure or a time is read through `readAttributes` (`engine/attributes.ts`), the one place both
the evidence ledger and the conflict finder read attributes from. It applies the modality of section 3 first, so a
denial ("no sign-in tickets since 11:45 UTC"), a plan, a condition or a request is not a statement of the figure, and
text an email quotes from an earlier message is not read as the replier's own. A summary written at the end of the case
(a resolution note or a status change) recounts how things were: it is not read as a later change of state, while a new
measurement (a validation result) still is.

**A correction made while checking the sample cases.** The first version of this rule read the two sample cases as holding
conflicts: "since 13:00 UTC" in Case One and "since 11:45 UTC" in Case Two (both about when the helpdesk's tickets
_stopped_) were read as a second start of the failures, and a post-fix validation of the proxy nodes was set against the
resolution summary that explains the fault. All three were wrong, the first two were already in the evidence ledger of
engine `2026.3.1` as a "conflicting evidence" claim, and the finding had been labelled low uncertainty. The attribute
reader now applies the negation rule, summaries are not read as a later state, and a change of state found only from
wording carries medium uncertainty. The samples now hold no conflicts (a test pins it). The ledger of Case One has the two
claims fewer that the mistake caused (61 to 59) and nothing else moved: the digests of every score, band, fork, hypothesis,
warning and scenario are byte-identical to the version before the fix. That the check was needed is itself a result:
conflicts are the least tested part of the engine on realistic text, so the evaluation set has a contradiction category
([EVALUATION.md](EVALUATION.md)) and its figures are reported with that in mind.

## 8. Sequence findings

`detectSequenceFindings` looks across events: `requested_never_completed` (a request the customer never answered before
the case moved on), `step_only_after_escalation`, `failed_step_repeated` (asked again after an outcome the pack marks
`ineffective`), `rejected_hypothesis_reused` (pursued after the evidence had ruled it out), `customer_correction_changed_cause`
and `earliest_missed_moment` (the earliest meaningful fork). Every finding is **anchored at the event that makes it
true** and names the events it considered. It is computed from a temporal view, so a view cut at the anchor reproduces it
and a view cut earlier produces none: a finding never uses anything said later.

## 9. Determinism and versioning

All of this is pure: no clock, no randomness, no I/O. The same event text gives the same observations. Any change to what
detection reads changes outputs, so it bumps `ENGINE_VERSION` (`apps/api/src/services/analysis/inputs.ts`) and the pack
version, regenerates the golden digests with the reason in the commit, and is recorded in
[DOMAIN_ENGINE.md](DOMAIN_ENGINE.md) section 14. Stored runs are recomputed once.

## 10. Limits

These are properties of the method, not defects awaiting a fix:

- **English only.** A message in another language is not read.
- **One clause at a time.** The reach of a cue is a heuristic window: a long sentence can be misjudged in either direction,
  and a pronoun or a reference to an earlier message ("did both", "the same failures") is not resolved.
- **A reply's meaning is not inferred.** That a fix worked, or that a customer's answer is the outcome of a request, is
  read only where the answer states it itself. This is the main reason the two "fix resolved" signals are still partly
  missed.
- **A fixed shorthand list.** An unlisted typo or abbreviation is not read.
- **An unmarked quotation** is read as the writer's own words.
- **Wording tied to the Teams authentication workload.** The method is general; the families are not.
- **One action is recognised per event**, as before.
- **The families were tuned on the development corpus.** A figure measured on the cases they were written against is a
  measure of fit. Only the validation and locked test sets, authored apart from the detectors, say whether detection
  generalises, and even they are labelled by an AI assistant, not by a human expert.

## 11. Changing a detector

1. Find or add the family in [MISS_TAXONOMY.md](MISS_TAXONOMY.md); describe the wording in general terms, not as the
   failing sentence.
2. Write the sentences it must read **and** the look-alikes it must not read (negated, guessed, planned, attributed, a
   neighbouring signal) in `detector-families.test.ts` first.
3. Keep every gap bounded and every phrase that is ambiguous alone tied to its context; run `robustness.test.ts`.
4. Run the evaluation harness and read **precision as well as recall**; a gain in recall that costs precision is not a
   gain.
5. Bump the pack and engine versions, regenerate the golden digests and explain the delta.
6. Do not tune on the locked test split, and never open it to see why a case failed.
