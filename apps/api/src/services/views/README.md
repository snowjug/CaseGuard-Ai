# Views services (`apps/api/src/services/views`)

The read and review views over a stored analysis: twin, timeline, source events, evidence ledger,
hypotheses, actions, action value, decision forks, investigation graph, quality, metrics, warnings,
coaching and case comparison. The routes (`src/routes/views.ts`) only map HTTP to these services; the
binder enforces permissions and validates parameters.

## As-of views are recomputed, never filtered

A request with `asOf` is answered by running the engine on a temporal view that holds only the events
(and the resolution, once it is within the window) recorded at or before that instant. A filtered copy
of the final analysis would leak through every derived field (confidence, ranks, explanations,
information gain), so none is ever made. Without `asOf` the stored artefacts are served from the
repositories. `events.get` reads the immutable record and works before a case is analysed; the other
artefact views answer 409 for a case that has never been analysed.

The identity of a recomputation is the stored run's (`engineContextForRun`), so artefact ids equal the
stored ones. The seed of the confidence bands is the case's simulation seed (`simulationSeed`: a hash of
the case content, never of a generated id) only for a view of the whole record, which is exactly what
that run analysed. A strict window gets a seed derived from the pack and the visible events alone: the
simulation seed covers the whole stored source, so a window seeded by it would show confidence ranges
that change with text recorded after the window (found by `test/views-metamorphic.int.test.ts`).

## Cost: one pass per window, a budget for cold work

- **Window.** What a pass depends on is the set of visible events and whether the resolution is
  visible, never the exact instant. Every instant between two events, and every spelling of one instant
  (`…:00Z`, `….000Z`, `….0000Z`), shares one pass. `passes.ts` keys it by tenant, run, a fingerprint of
  the governed configuration, the visible-event fingerprint, resolution visibility and the number of
  withheld events, and computes it on the window's own boundary (the latest instant it can see), so the
  result does not depend on who asked first. The instant itself is canonicalised before it is used.
- **Pass cache.** Bounded by an estimate of what passes retain (48 KiB per visible event plus 64 KiB;
  measured 12 to 45 KiB of JSON per event up to 2,000 events) against 96 MiB, and by 256 entries. That
  keeps about three complete scans of the prefixes of a 31-event case, or the latest pass alone for a
  2,000-event case; the newest pass is never evicted by its own weight. **Only paid work is cached:** a
  window enters the cache (weighed in full) when a request that has been charged, or runs unmetered,
  starts its pass or builds a ranking in it, never when a computation is merely created. A request the
  budget refuses (429) therefore leaves nothing behind and cannot evict a pass another user paid for,
  by weight or by count; a pass that fails is dropped again unless a ranking was built in its window.
- **Boundary memo.** What does depend on the exact instant (quality, metrics, the warning replay) is
  memoised per boundary in a 128-entry LRU holding no events and no pass, under the same rule: the memo
  is created when the first request is charged for the boundary, and read by key when it is needed. A
  ranking depends on the visible events only and lives with the window.
- **Engine budget** (`services/engine-budget.ts`, shared with skill matching): a token bucket per tenant
  and user, 30 units per 60 seconds, on `ctx.now()`. Only cold work is charged and a request is charged
  at most once: a cold pass always costs a unit; the per-instant work (quality, metrics, replay, a cold
  ranking) costs a unit unless somebody has already paid for that instant. So a fresh instant costs one
  unit however many views of it are asked for, and a flood of instants one millisecond apart is bounded
  like any other. An empty bucket is a 429 with `Retry-After`, answered before any engine work.
  Cached reads and stored views are free.
- The engine pass is synchronous: a pass for a 2,000-event case blocks the event loop for as long as it
  runs (seconds). The cache and the budget bound how often, not how long.

## Human input inside a window: policy

A decision made by a person takes part in a view only from the moment it was made. An as-of response is
a function of the record and of the human input made up to the instant, nothing else.

| Input                                        | In a window ending at `asOf`                                                                                                                                                                                                                                                                                                                                               | In the whole record (no `asOf`)                                                                   |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Claim review (label, state, note, who, when) | Shown only if `reviewedAt <= asOf`. Otherwise the machine classification, `pending`, no note, no reviewer.                                                                                                                                                                                                                                                                 | Always                                                                                            |
| Action-value override                        | Listed in `reviewerOverrides` only if it was decided by `asOf` AND is about an instant at or before it; the latest decision made by then wins per (instant, action). On a candidate (`override`) only for the ranking's own instant. Nothing of any other override: no reason, rank, `by`, `at`, and not even how many there are. Also for a decision-time view of a fork. | Every override of the case: the latest decision per (instant, action), newest first (200 at most) |
| Warning dismissal                            | Applied by the replay only if `at <= asOf`                                                                                                                                                                                                                                                                                                                                 | Applied                                                                                           |
| Fork review                                  | Shown only if the fork was not updated after `asOf` (a fork records no review time)                                                                                                                                                                                                                                                                                        | Always                                                                                            |

Why labels too, not only notes: a reviewer who knows the root cause upgrades an assumption to a
confirmed fact; shown in an earlier window that label would be hindsight even with no note. The metamorphic
test (`views-metamorphic.int.test.ts`) fails if any of this input is visible in an earlier window.

The one exception is the stored `version` (claims, forks, warnings): a review started from a window
needs it for the optimistic lock. It tells that something was edited, not what or when. `updatedAt`,
which a later decision moves, stays out of a window.

**Overrides in the ranking.** An override is recorded about one ranking instant and one action (review
target id `<canonical instant>|<action key>`) and decided at the wall-clock time of the review, normally
long after that instant. So it can never be part of a window that ends at the instant it is about, and
showing it only on a candidate would make it visible on the ranking of the case's last event alone. The
ranking therefore carries `reviewerOverrides` next to its candidates: one entry per (instant, action),
the latest decision, newest first, with `instant`, `actionKey`, `actionName` (the pack's name, else the
key), `rank`, `reason`, `by` and `at`. The candidates keep `override` exactly as before (only the
override about the ranking's own instant). A window lists only what was both decided and is about an
instant by its end, and carries nothing of the others, not even their number: a count of "overrides
you cannot see" would itself be human input from after the instant, which no other view leaks (claim
reviews, fork reviews and dismissals leave no trace in an earlier window either). So the response of a
window is byte-identical whether or not later overrides exist, and the metamorphic test compares it
with nothing masked. One bounded pass over the case's `action_value` decisions (25 pages of 200)
builds both views; reaching that bound, or listing more than 200 entries, is logged with counts only,
and a decision whose target id or value is malformed is ignored. The bound is the one place where the
amount of later input could matter (a case with more than 5,000 override decisions loses the oldest
from the scan, and says so in the log); a time filter in the review repository would remove it.

The response to the person who just decided (`claims.review`, `actionValue.override`) shows the whole
record, their own decision included. Reasons go to the review record only: never to audit details or
logs. Dismissing a warning that is no longer open answers 409 "This warning can no longer be
dismissed" from wherever the request came, so that it never reveals a resolution the client's window
did not know.

## Other rules

- Decision-time fields only in as-of responses: no retrospective view of a fork (hindsight is for
  callers holding `quality:review`, and never inside a window), no information gain realised after
  `asOf`, no scenario before its decision instant, and a scenario's summary written from the simulated
  path alone. Every estimated or simulated value carries the contract's provenance labels.
- Pagination: opaque keyset cursors (`db/cursor.ts`); a cursor from another list is a 422.
- `compare.cases` takes exactly two case ids of the tenant, compares stored estimates and never ranks
  people.
- `provenance.resolve` (`provenance.ts`) resolves `type:id` links to the stored record they point at, and
  knows a record by the rule of `events.get`: one that only exists later is `not_yet_known` and never
  shown. The whole record reads the stored artefacts; an `asOf` reads the engine's analysis of the window
  (never a filtered copy of the stored one). Evidence and claims are checked against the immutable stored
  event on every read (`verifyExcerpt`) and are quoted only when verified. It writes nothing, audits nothing
  and logs no case text; a link that resolves to nothing is reported in `unresolved`, never dropped.

## Tests

| File                            | Proves                                                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `views.test.ts`                 | Every route: shape, 401/403, tenant isolation, validation, reviews, audit, optimistic locks, re-analysis survival, human input in windows                           |
| `views-temporal.test.ts`        | Leak scans at several instants; equality with a fresh engine analysis; the cache and budget over HTTP                                                               |
| `views-metamorphic.int.test.ts` | Byte-identical as-of responses between the real cases and copies with everything after the cut rewritten                                                            |
| `views-cache.test.ts`           | One pass per window, the budget, the size-bounded cache, nothing cached for a refused request, seeds (no database)                                                  |
| `views-units.test.ts`           | Overlays, paging, filters, LRU, helpers                                                                                                                             |
| `views-overrides.test.ts`       | The override scan (no database): list and window, latest per pair, the same answer with or without later overrides, malformed decisions, the 200 and 25-page bounds |
| `engine-budget.test.ts`         | The token bucket                                                                                                                                                    |
| `provenance.test.ts`            | `provenance.resolve`: every link type, as of an instant, tenant isolation, the three verification states, limits and malformed links, nothing written or logged     |
