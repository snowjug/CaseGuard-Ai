# Fixtures of the guided review

Real engine output of the two built-in samples, kept small enough to read in a diff.

| File                       | What it is                                                                                                                                                                                                                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `case-one.json`            | CG-SYN-1001 (DNS root cause): 31 events, nine decision points, 14 warnings, quality "poor", a reviewer-accepted better path at the earliest decision point and the skill that was extracted from it.                                                                                                                  |
| `case-two.json`            | CG-SYN-1002 (Rotterdam proxy): 15 events, no decision point, no warning, quality "strong", and the published skill that matches it (applied, 4 of 4 steps followed).                                                                                                                                                  |
| `provenance-case-one.json` | **Hand-built** to the `provenance.resolve` contract: the links of the first quality improvement of Case One, with verbatim quotations cut from the real text of events e07 and e08. The real handler has since landed; the end-to-end suite reads its response.                                                       |
| `skill-overlay.json`       | **Hand-built** to the `skillOverlay.get` contract for the matches of both cases. The figures are invented for the tests and differ from what the real handler returns (it has four rows, time to diagnosis among them); the end-to-end suite reads the real response, and these show how the screen reads a response. |

`case-one.json` and `case-two.json` hold one response per route, keyed by route id, exactly as the API sent it to the
engineer persona, then trimmed: long texts are shortened, lists that the review does not read are cut, and the
alternatives of a decision point are limited to the best one. Trimming only shortens or removes; it never rewrites a
value. `apps/web/test/review-fixtures.ts` validates every response with the real Zod schema of its route.

How they were captured: a throw-away test against the in-process API harness (`apps/api/test/support/app-harness.ts`)
played the portfolio demo story (`seedPortfolio`) and read each route. The script is not part of the repository; to
refresh the fixtures, play the same story and trim in the same way.
