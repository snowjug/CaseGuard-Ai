# Annotation guide

This is how to label a case of the evaluation set. It is written for the person (or assistant) who labels, and for the one
who checks a label. Read it with `vocabulary.json` open: that file is the only description of what a label means that you
may use.

## What you may read, and what you may not

- You may read: the case file, this guide, `vocabulary.json` (identifiers, labels, plain descriptions), the shared contracts
  in `packages/schemas/src/conflicts.ts` (the names of the modalities and the six conflict classes).
- You may not read: the knowledge pack, the detector patterns, the engine source that reads text, the output of the engine for
  any case you label, or the labels of another annotator for the same case. **Never run the engine on a case you label.**
- Label the meaning of the text. Write the rationale before you label, in your own words (2 to 6 sentences). Do not change a
  label because the engine disagreed, or to make a measure look better.

## Signals and absences

A **signal** is a fact the text states about the case, by meaning, at that event. It is stated when the author says it as
fact for this case: not a guess, a plan, a request, a condition, a claim that is only reported, or something the author
denies. Label it on the event that states it. Text quoted from an earlier message is not a new statement: label only what
the author of the event adds. A restatement in a later message is a new occurrence.

Signals marked `kind: absence` in the vocabulary (for example that service health is clear) are the denial itself: "nothing
active" is that signal. For a `presence` signal, a denial means the signal is absent.

`signals` is **exhaustive per event**: list every signal a careful reader finds, and the measures count anything the engine
reports that is not on the list as a false positive.

A signal is **absent** when its words, or those of an action, appear and the fact is not stated. Give the reason:

| Reason          | Example of the shape (not of the wording)                  |
| --------------- | ---------------------------------------------------------- |
| `negated`       | the fact is denied                                         |
| `speculative`   | a guess: it might be, possibly                             |
| `future_intent` | intended, not done: will check, next step                  |
| `conditional`   | depends on a condition: if it had been, unless             |
| `attributed`    | reported on someone else's authority and not endorsed      |
| `corrected`     | the author replaces an earlier statement                   |
| `requested`     | asked for, not yet done                                    |
| `other`         | the words appear in an unrelated context (look-alike text) |

Mark an absence only where an engine could plausibly fire: where the words really appear. Do not list every signal that is
not there. The negation measure reads every reason except `other`.

## Actions, forks and the earliest missed moment

An **action** is what an engineer did, asked for or arranged. Label it on the engineer's own events, exhaustively
(`actions`). A request to the customer ("please clear the cache") is the engineer's action on the engineer's event, even when
the customer performs it. What the customer reports back is a signal on the customer's event, not an action. A step that is
only intended or conditional is not an action: record it as an absence with its reason.

A **missed step** is a step the evidence at that moment called for and the engineer did not take, while a clearly better
supported one was available. A **fork** is the engineer's event at which that happened; give it one of the fork categories.
Judge only with what was known at that moment, never with the outcome. The **earliest missed moment** is the first engineer
event at which a clearly better step was available; it is normally the earliest of your forks. Use `null` when there is none:
`null` is an answer ("none"), leaving the kind out means "not annotated".

`counterfactualDirection` says whether a better-supported path from the earliest fork would clearly have been better than the
recorded one on time to diagnosis or customer effort (`better`), about as good (`none`), or cannot be told (`unclear`).
`qualityBand` is your overall judgement of the handling, as a senior colleague would give it, or `null`.

## Contradictions

A **conflict** is a pair of statements in one case that a careful reader would set against each other: "which one is right?"
or "what changed?". Use the six classes of `CONFLICT_CLASSES`:

- `direct_contradiction`: one side says it happened or holds, the other that it did not, about the same thing at the same time;
- `temporal_update`: the state changed, so both were true in their time (worked, then failed);
- `source_disagreement`: two sources describe the same thing differently (customer and tool, person and person);
- `ambiguous_wording`: the wording allows more than one reading, so a conflict cannot be told from a difference of phrasing;
- `unresolved_conflict`: both sides stand and nothing in the record settles it;
- `corrected_information`: the author or someone else withdrew or corrected the earlier statement.

**Not every difference is a conflict.** More detail, a round number against an exact one, a status that moves on, an engineer
asking again: none of these is a contradiction. Label a pair once, with the earlier event first, and give the subject (a
signal id where there is one, else a short key).

## Causes and supporting evidence

`causes` lists the named hypotheses a reader of the whole story accepts: one, or two when the story fits both. Use `[]` when
no cause should be named (the case is not a sign-in failure, or the record does not settle it). **Supporting evidence** is
what you would point at when asked why: name it in the rationale by event key ("ev05: the resolver test"). It is not a label
of its own; the measures check the citations of the engine separately.

## Uncertainty and exclusion

Put `uncertainty` on a label where you doubt it, and on the record as a whole. `none`: anyone would label it so. `low`: a
careful reader might differ on one label. `medium`: several labels, or the cause, are arguable. `high`: the text does not
settle the labels. **Exclude** a case (`excluded: true` and a reason) when it cannot be labelled: unreadable, contradictory
beyond use, or it holds what looks like real personal data. An excluded case is never counted.

## Avoiding circular labels

- Never label from engine output, and never run the engine on a case you label.
- Never label from the pack's wording: do not read it, and do not write text to be found by a pattern.
- Do not copy phrases of the shipped samples or of the vocabulary (the guard rejects six shared words).
- Do not tune a label to a measure, and do not relabel because a result looked bad.

## Workflow for a second annotator, and adjudication

1. `pnpm --filter @caseguard/domain run eval:annotate -- --case <id> --annotator <your id>` writes an empty draft under
   `evaluation/pending/<your id>/`. It holds no label of anyone else. Fill it in.
2. Someone else merges it (`eval:annotate -- --merge <draft>`), and runs `eval:manifest`. The case is then `unadjudicated`:
   reported, never counted in precision or recall.
3. `pnpm --filter @caseguard/domain run eval:agreement -- <annotator A> <annotator B>` gives Cohen's kappa per kind of label and
   lists the disagreements.
4. A decision goes into the case's annotation file under `adjudication`: `status` (`agreed` or `adjudicated`), `acceptedFrom`
   (the record that is the base), `decidedBy`, `decidedAt`, and for each field the two disagreed on the `accepted` value and a
   `rationale`. The accepted labels are the base record with those values in place of its own. A record written after the
   decision makes it stale and the case `unadjudicated` again.

**AI-drafted labels are never equivalent to a human annotator.** Every label of this set is an AI draft (annotator kind
`ai_draft`): the figures measure agreement with an assistant, and two AI drafts that agree show consistency, not truth. A
human annotator, or a human adjudication, is what turns a draft into a reference. Reports say so.
