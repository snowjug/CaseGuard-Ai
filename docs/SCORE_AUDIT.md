# Audit of the Case Quality Index

An audit of how the Case Quality Index (CQI) is configured, composed and read, done in wave 2. It **changes nothing**: the
weights, penalty points, penalty cap and band edges are the shipped defaults (quality configuration `1.0.0`), and every figure
below is what they produce today. What the audit could check is checked by executable tests
([`packages/domain/test/quality-audit.test.ts`](../packages/domain/test/quality-audit.test.ts), 20 tests, both synthetic
samples); what it could not check is listed as a limitation, not smoothed over.

How the score is built is in [DOMAIN_ENGINE.md](DOMAIN_ENGINE.md) section 9. Read it as what it is: a rule-based estimate about
the written record, not a rating of a person ([RESPONSIBLE_AI.md](RESPONSIBLE_AI.md)).

## 1. What was verified, and holds

| Area                       | What the audit checked                                                                                                                                          | Result                                                                                                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dimensions and weights     | Six dimensions, weights 0.25 / 0.20 / 0.15 / 0.15 / 0.15 / 0.10                                                                                                 | Every dimension is weighted and the weights sum to 1                                                                                                                          |
| Penalties                  | Ten penalties, 3 to 8 points each, total cap 40                                                                                                                 | Every penalty is priced and below the cap, so no single failure exhausts it                                                                                                   |
| Thresholds                 | Bands at 85 / 70 / 50                                                                                                                                           | Strictly descending, inside 0 to 100. The settings form and the server's section rules (`section-rules.ts`, `governance-rules.test.ts`) both refuse edges that do not descend |
| Can the figure be rebuilt? | Composite = sum(weight x raw score) - min(cap, penalty points); the displayed dimension scores add up to the composite; the penalties listed add up             | Holds for both samples                                                                                                                                                        |
| Range                      | At every point of both records: the range holds the score and the values are finite. For the finished case: the whole range lies inside one band                | Holds (31 and 15 views); the single-band property holds for the two finished cases only, see F2                                                                               |
| Missing data               | Weights are re-normalised over the assessable dimensions; with nothing assessable the score is a neutral 50 over the range 0 to 100 and says it is not a result | Holds. No value is ever not-a-number or infinite. The finished range is narrower than the range after two events                                                              |
| Stability                  | The order the events are listed in; the same record twice                                                                                                       | Listing the events in reverse gives the same score and the same raw dimension scores; the same record gives a byte-identical review                                           |
| Sensitivity to the choices | One weight at a time up to a quarter more or less; every band edge moved by up to 10 points                                                                     | Case One moves at most 1.3 points and Case Two at most 0.2; neither changes band, under any of the perturbations                                                              |
| Explainability and linkage | Every sub-check, penalty and improvement links the evidence it rests on                                                                                         | Held since wave 1 ([GUIDED_REVIEW.md](GUIDED_REVIEW.md), provenance tests); unchanged                                                                                         |

## 2. Findings

None of these was fixed in this wave. Each would change what a score means, and the mission rule applies: weights and
thresholds are not changed to improve a number, and a change that is made is a new, versioned scoring model with a
before-and-after comparison.

**F1. A placeholder score carries a number and a band.** With nothing assessable (the first event of either sample) the review
holds `compositeScore` 50, range 0 to 100 and band `needs_attention`, while its note says it is "not a result". The Quality
Index panel handles it (it shows "Nothing can be assessed yet" and no number), but any other reader of the structured fields would
count it. A reader must check that every dimension weight is zero. _Recommended:_ an explicit field in the next scoring-model
version.

**F2. A band is named for an estimate the range does not stay inside.** After two events Case One reads 100 and "strong" with a
range from 48. The range of 7 of Case One's 31 as-of views, and of 10 of Case Two's 15, crosses a band edge. The finished
range of both samples lies inside one band. _Recommended:_ label a band as provisional when its range crosses an edge (a display
decision, not made here).

**F3. The penalties are exact; the range does not include doubt about them.** The width of the range is the same with and
without penalties. Case One's band rests on them: without penalties it scores 68 ("needs attention"), with them 36 ("poor"). The
penalties are rule-based on detections that are not perfect (the first evaluation's precision was 76%, and
[EVALUATION.md](EVALUATION.md) gives the current figures), so one wrong penalty moves a score by its 3 to 8 points. Case
One's verdict would survive one such error (the largest penalty, 8 points, would leave 44: still "poor") but not the two
largest (15 points would leave 51: "needs attention"). _Recommended:_ widen the range by the detection uncertainty of the
penalties that applied.

**F4. A failure can be charged twice.** Sub-check EI-1 reduces the evidence-integrity raw score for claims flagged as unsupported
or assumed as fact, and the penalty `unsupported_root_cause` is applied for the same flagged claims. In Case One the same two
statements bring EI-1 down to 0.7 (worth about 2 points of the composite) and carry the 8-point penalty. Whether that is
the intended weight of the failure is a design decision for the owner; the audit only makes it visible.

**F5. The score is not calibrated against human judgement.** The weights, the penalty points, the cap and the bands are
authored. There is no set of cases rated by people, and the two samples were written to be poor and strong. The tests show that
the sample verdicts do not depend on the exact weights (section 1), not that the bands mean what they say. A calibration would
need cases rated on the six dimensions by at least two experienced engineers, agreement measured between them and then
between them and the score, and any change made only through a new configuration version. **Not done.** Until it is, the score
focuses a human review; it is not evidence about the quality of anyone's work.

## 3. If the scoring model has to change

The `quality` section of the governed configuration carries a `version`, and every stored assessment records the
`configVersion` it was computed with, so a score keeps the meaning it had when it was made. A change therefore needs: the new
version label; the rationale; a comparison of the old and new scores on the same cases (the tests above are the template);
and the display note that results already stored are not recalculated until the case is analysed again (already in the
settings form). The numbers in section 1 should be re-measured, and a change must not be tuned to an evaluation result.
