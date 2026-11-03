# Miss taxonomy of the Wave 1 evaluation

Status: written at the start of Wave 2, **before any detector was changed**. The machine-readable record, with the exact text of
every event, the current patterns, the proposed fix, the false-positive risk and the test requirement for each miss, is
[`docs/evaluation/miss-taxonomy.json`](evaluation/miss-taxonomy.json).

## What was measured

The 16 synthetic cases of the Wave 1 evaluation (13 independent ones; the three reordered copies are not counted) carry 66 labelled signals,
written by one AI assistant (not a human, no second annotator). The engine, before this wave, reported **13 of 66**
(recall 20%) and 4 signals the labels do not list (precision 76%). The 53 misses and the 4 false positives below are all of them.

| Group      | Reported and expected | Reported, not expected | Expected, not reported |
| ---------- | --------------------: | ---------------------: | ---------------------: |
| paraphrase |                     9 |                      2 |                     30 |
| noisy      |                     4 |                      1 |                     21 |
| negative   |                     0 |                      1 |                      2 |

## Why each miss happened

The harness already classified every miss by the detector definitions alone: **46 wording** (a text detector accepts
the event and its pattern did not match), **4 structured-only** (the signal can only be read from structured data) and
**3 type or role gate** (no text detector accepts the event's author or type). This document goes one step further and
names the primary reason in the vocabulary of the mission, by reading each event.

| Primary category       | Misses |
| ---------------------- | -----: |
| paraphrase             |     18 |
| negation               |      6 |
| synonym                |      5 |
| cross_event_dependency |      5 |
| detector_scope         |      4 |
| entity_resolution      |      4 |
| event_type_gate        |      3 |
| noise_typo             |      3 |
| cross_sentence         |      1 |
| passive_voice          |      1 |
| temporal_phrasing      |      1 |
| abbreviation           |      1 |
| unsupported_language   |      1 |

Reading the table: the engine's patterns were written around technical tokens (error tags, AADSTS codes, literal phrases such as "other sites"), and the
cases are written the way people write. Three further things stand out: a denial is often the content (“nothing at all”, “no difference”), so a negation
cannot simply veto a signal; several outcomes depend on the request they answer (“did both”, “same failures”), which a single sentence cannot show;
and a chat-style message (typos, abbreviations) needs a bounded normalisation before any phrase can be found.

## Families of fixes

A family is one reusable change that repairs several misses; it is not a list of the sentences that failed.

| Id  | Family                                                   | Misses | Priority | Status               | Value to                                      |
| --- | -------------------------------------------------------- | -----: | -------: | -------------------- | --------------------------------------------- |
| F01 | Intermittency phrases                                    |      5 |        1 | planned              | issue isolation (scope)                       |
| F02 | Other sites are fine                                     |      2 |        1 | planned              | issue isolation (scope)                       |
| F03 | Name-resolution error in words                           |      2 |        1 | planned              | authentication flow (client error)            |
| F04 | No records in the sign-in logs, in words                 |      4 |        1 | planned              | evidence collection (server-side correlation) |
| F05 | A name server does not answer                            |      3 |        1 | planned              | diagnostic sequence (network checks)          |
| F06 | A network change is reported                             |      4 |        2 | planned              | diagnostic sequence (change history)          |
| F07 | A fix worked (reported in prose)                         |      4 |        3 | deferred             | resolution validation                         |
| F08 | Timeout reported in words                                |      3 |        1 | planned              | authentication flow (client error)            |
| F09 | Clearing the cache or reinstalling did nothing           |      3 |        2 | planned              | diagnostic sequence (remediation outcome)     |
| F10 | Revoking sessions: request and outcome                   |      2 |        2 | planned              | diagnostic sequence (remediation outcome)     |
| F11 | Proxy comparison reported by the engineer                |      3 |        1 | planned              | diagnostic sequence (network checks)          |
| F12 | An access policy was changed                             |      2 |        1 | planned              | diagnostic sequence (change history)          |
| F13 | Log findings described in prose                          |      6 |        1 | planned              | evidence collection (server-side evidence)    |
| F14 | Excluding a user did nothing                             |      2 |        2 | planned              | diagnostic sequence (remediation outcome)     |
| F15 | A denial reported as the fact                            |      1 |        1 | planned              | precision (negation)                          |
| F16 | Only one user or device is affected                      |      2 |        1 | planned              | issue isolation (scope)                       |
| F17 | The device has no primary refresh token                  |      1 |        2 | planned              | diagnostic sequence (device state)            |
| F18 | Chat style: typos and abbreviations                      |      2 |        2 | planned              | robustness (noisy input)                      |
| F19 | Access policy unchanged, said with a negative quantifier |      1 |        2 | planned              | diagnostic sequence (change history)          |
| F20 | A message written in another language                    |      1 |        3 | not fixable in scope | robustness (language)                         |

Priority 1 is a miss that changes which hypothesis the engine prefers or which step it recommends (scope, client error, server-side evidence,
network checks, change history); 2 improves the outcome of a step or robustness; 3 is deferred or out of scope. Every status here is the plan the rest of the wave works from; the final report of the wave says what was done.

## The misses

| Id      | Case                     | Event | Expected signal                           | Primary category       | Family |
| ------- | ------------------------ | ----- | ----------------------------------------- | ---------------------- | ------ |
| miss-01 | p1-warsaw-resolver       | ev01  | `sig.intermittent-failures`               | synonym                | F01    |
| miss-02 | p1-warsaw-resolver       | ev01  | `sig.site-correlated`                     | paraphrase             | F02    |
| miss-03 | p1-warsaw-resolver       | ev03  | `sig.error-name-not-resolved`             | paraphrase             | F03    |
| miss-04 | p1-warsaw-resolver       | ev04  | `sig.no-server-side-failure-records`      | negation               | F04    |
| miss-05 | p1-warsaw-resolver       | ev05  | `sig.resolver-inconsistent`               | paraphrase             | F05    |
| miss-06 | p1-warsaw-resolver       | ev06  | `sig.resolver-inconsistent`               | paraphrase             | F05    |
| miss-07 | p1-warsaw-resolver       | ev07  | `sig.recent-network-change-reported`      | synonym                | F06    |
| miss-08 | p1-warsaw-resolver       | ev08  | `sig.dns-fix-resolved`                    | detector_scope         | F07    |
| miss-09 | p2-utrecht-proxy         | ev01  | `sig.error-timeout`                       | paraphrase             | F08    |
| miss-10 | p2-utrecht-proxy         | ev01  | `sig.intermittent-failures`               | paraphrase             | F01    |
| miss-11 | p2-utrecht-proxy         | ev03  | `sig.cache-clear-no-effect`               | cross_sentence         | F09    |
| miss-12 | p2-utrecht-proxy         | ev05  | `sig.revoke-sessions-no-effect`           | cross_event_dependency | F10    |
| miss-13 | p2-utrecht-proxy         | ev06  | `sig.no-server-side-failure-records`      | passive_voice          | F04    |
| miss-14 | p2-utrecht-proxy         | ev07  | `sig.proxy-node-inconsistent`             | event_type_gate        | F11    |
| miss-15 | p2-utrecht-proxy         | ev08  | `sig.proxy-node-inconsistent`             | event_type_gate        | F11    |
| miss-16 | p2-utrecht-proxy         | ev09  | `sig.recent-network-change-reported`      | entity_resolution      | F06    |
| miss-17 | p2-utrecht-proxy         | ev10  | `sig.proxy-fix-resolved`                  | detector_scope         | F07    |
| miss-18 | p3-lisbon-access-rule    | ev03  | `sig.recent-ca-change-reported`           | synonym                | F12    |
| miss-19 | p3-lisbon-access-rule    | ev04  | `sig.server-side-failure-records-present` | paraphrase             | F13    |
| miss-20 | p3-lisbon-access-rule    | ev04  | `sig.mfa-ca-events-in-logs`               | paraphrase             | F13    |
| miss-21 | p3-lisbon-access-rule    | ev07  | `sig.ca-exclusion-no-effect`              | cross_event_dependency | F14    |
| miss-22 | p4-hourly-signout        | ev01  | `sig.recent-ca-change-reported`           | synonym                | F12    |
| miss-23 | p4-hourly-signout        | ev04  | `sig.token-expiry-errors`                 | paraphrase             | F13    |
| miss-24 | p4-hourly-signout        | ev04  | `sig.server-side-failure-records-present` | paraphrase             | F13    |
| miss-25 | p4-hourly-signout        | ev05  | `sig.service-health-clear`                | negation               | F15    |
| miss-26 | p5-single-laptop         | ev01  | `sig.single-user-scope`                   | paraphrase             | F16    |
| miss-27 | p5-single-laptop         | ev03  | `sig.cache-clear-no-effect`               | negation               | F09    |
| miss-28 | p5-single-laptop         | ev04  | `sig.prt-missing`                         | negation               | F17    |
| miss-29 | p6-vendor-incident       | ev01  | `sig.intermittent-failures`               | temporal_phrasing      | F01    |
| miss-30 | p6-vendor-incident       | ev04  | `sig.error-timeout`                       | paraphrase             | F08    |
| miss-31 | n1-warsaw-noisy          | ev01  | `sig.multiple-users-affected`             | noise_typo             | F18    |
| miss-32 | n1-warsaw-noisy          | ev01  | `sig.intermittent-failures`               | noise_typo             | F01    |
| miss-33 | n1-warsaw-noisy          | ev01  | `sig.site-correlated`                     | noise_typo             | F02    |
| miss-34 | n1-warsaw-noisy          | ev04  | `sig.error-name-not-resolved`             | paraphrase             | F03    |
| miss-35 | n1-warsaw-noisy          | ev05  | `sig.no-server-side-failure-records`      | negation               | F04    |
| miss-36 | n1-warsaw-noisy          | ev06  | `sig.resolver-inconsistent`               | entity_resolution      | F05    |
| miss-37 | n1-warsaw-noisy          | ev08  | `sig.recent-network-change-reported`      | entity_resolution      | F06    |
| miss-38 | n1-warsaw-noisy          | ev09  | `sig.dns-fix-resolved`                    | detector_scope         | F07    |
| miss-39 | n2-utrecht-chat          | ev01  | `sig.multiple-users-affected`             | abbreviation           | F18    |
| miss-40 | n2-utrecht-chat          | ev01  | `sig.error-timeout`                       | paraphrase             | F08    |
| miss-41 | n2-utrecht-chat          | ev01  | `sig.intermittent-failures`               | paraphrase             | F01    |
| miss-42 | n2-utrecht-chat          | ev03  | `sig.cache-clear-no-effect`               | cross_event_dependency | F09    |
| miss-43 | n2-utrecht-chat          | ev05  | `sig.revoke-sessions-no-effect`           | cross_event_dependency | F10    |
| miss-44 | n2-utrecht-chat          | ev06  | `sig.no-server-side-failure-records`      | synonym                | F04    |
| miss-45 | n2-utrecht-chat          | ev07  | `sig.proxy-node-inconsistent`             | event_type_gate        | F11    |
| miss-46 | n2-utrecht-chat          | ev08  | `sig.recent-network-change-reported`      | entity_resolution      | F06    |
| miss-47 | n2-utrecht-chat          | ev09  | `sig.proxy-fix-resolved`                  | detector_scope         | F07    |
| miss-48 | n3-lisbon-mixed-language | ev03  | `sig.recent-ca-change-reported`           | unsupported_language   | F20    |
| miss-49 | n3-lisbon-mixed-language | ev04  | `sig.server-side-failure-records-present` | paraphrase             | F13    |
| miss-50 | n3-lisbon-mixed-language | ev04  | `sig.mfa-ca-events-in-logs`               | paraphrase             | F13    |
| miss-51 | n3-lisbon-mixed-language | ev06  | `sig.ca-exclusion-no-effect`              | cross_event_dependency | F14    |
| miss-52 | z4-negations             | ev01  | `sig.single-user-scope`                   | paraphrase             | F16    |
| miss-53 | z4-negations             | ev01  | `sig.ca-config-unchanged`                 | negation               | F19    |

## The false positives

| Id   | Case                     | Event | Reported signal               | Matched words                         | Category         | Status  |
| ---- | ------------------------ | ----- | ----------------------------- | ------------------------------------- | ---------------- | ------- |
| fp-1 | p4-hourly-signout        | ev05  | `sig.service-health-incident` | “Service health lists nothing active” | negation         | planned |
| fp-2 | p5-single-laptop         | ev03  | `sig.web-client-also-fails`   | “browser on the same”                 | lexical_artifact | planned |
| fp-3 | n3-lisbon-mixed-language | ev05  | `sig.service-health-incident` | “Service health has no active”        | negation         | planned |
| fp-4 | z4-negations             | ev01  | `sig.intermittent-failures`   | “intermittent”                        | negation         | planned |

## Limits of this taxonomy

- One reader assigned the categories; another might split them differently. The counts are a guide to where to work, not a measurement.
- The labels are an AI draft. A miss can be a label the engine is right not to meet; where that was suspected it is said in the record.
- The 16 cases are the cases the work is guided by. Improvements measured on them alone prove nothing: the validation set and the locked test set
  (see `docs/EVALUATION.md`) exist so that the next numbers do not come from cases the detectors were written for.
