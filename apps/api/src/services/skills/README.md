# SkillDNA services

Routes: `skillMatches.list`, `skillMatches.apply`, `skills.list`, `skills.get`, `skills.versions`,
`skills.diff`, `skills.extract`, `skills.transition`, `skills.simulationTest`, `skills.proposeMutation`,
`skills.versionDecision`, `skills.rollback`, `skills.apply` (`routes/skills.ts` only maps HTTP to
`SkillsPort`). The demo seeder and the tests drive the same port, each call with the `RequestContext` of the
person who acts, so permissions, four-eyes and the audit actor are exactly what they are over HTTP.

## The governed walk, and who does it

| Step                                                     | Who (persona)                                        | Permission              | Rule                                                                                 |
| -------------------------------------------------------- | ---------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------ |
| Accept the counterfactual (`counterfactuals.review`)     | Riley, reviewer                                      | `counterfactual:review` | Only accepted, valid, leak-free scenarios may seed a skill.                          |
| Extract (`skills.extract`)                               | Ava, **engineer**                                    | `skill:extract`         | Creates a `discovered` skill; Ava is its creator.                                    |
| `discovered` to `draft`                                  | Casey, curator                                       | `skill:extract`         | The creator cannot record it (see below).                                            |
| Simulation test, then `draft` to `simulation_tested`     | Riley, reviewer                                      | `skill:validate`        | A passed full simulation test on the current version.                                |
| `simulation_tested` to `expert_reviewed`                 | Riley, reviewer                                      | `skill:review`          | Differs from the creator and from the author of the version.                         |
| `expert_reviewed` to `pilot`                             | Casey, curator                                       | `skill:approve`         | Differs from the creator.                                                            |
| Regression suite, then `pilot` to `validated`            | Riley, reviewer                                      | `skill:validate`        | Passed full simulation test and full regression suite.                               |
| `validated` to `published`                               | Alex, administrator                                  | `skill:publish`         | Differs from the creator **and** from every pilot approver; a pilot approval exists. |
| Withdraw (`published` to `deprecated`, any to `retired`) | Casey or Alex, or the creator holding the permission | `skill:retire`          | Not an approval, so it needs no second person; see below.                            |
| Propose a mutation (`skills.proposeMutation`)            | Casey or Alex                                        | `skill:mutate`          | Only a proposal: never applied without a decision.                                   |
| Decide it (`skills.versionDecision`)                     | Casey or Alex, whoever did not propose it            | `skill:approve`         | Differs from the creator and the proposal's author; validated content only.          |
| Roll back (`skills.rollback`)                            | Casey or Alex                                        | `skill:rollback`        | Creates a NEW version from an earlier one; nothing is reverted in place.             |

**Why the engineer extracts.** With the five demo personas only the curator and the administrator hold
`skill:approve` and `skill:publish`, and the creator, the pilot approver and the publisher must be three
different people. A skill created by the curator could therefore never be published. The engineer holds
`skill:extract` and no approval permission, so Ava (creator), Casey (pilot approver) and Alex (publisher)
are distinct, and Riley validates. Keep this order when seeding.

## Separation of duties, twice

- The domain gates (`transitionSkill`, `decideSkillVersion`, ...) refuse a missing permission, the same
  person approving twice, an unvalidated skill and a stale version.
- The data tier refuses every approval whose approver is the requester, the skill's creator
  (`skill_approvals_distinct_approver_chk`). The domain would let the creator take the first step
  `discovered` to `draft`, so `guardSelfApproval` (`aggregate.ts`) turns it into an audited 403
  `separation_of_duties` before the database does, and `skills.get` shows the creator that step as
  unavailable (`withSelfApprovalGuard`, `detail.ts`). The constraint stays as the last line of defence.
- Withdrawing a skill (`published` to `deprecated`, anything to `retired`) only reduces what it can do, so it
  is not an approval and needs no second person: any holder of `skill:retire` may do it, the skill's creator
  included. The domain records it as a `rejected` decision (the one decision the constraint accepts from the
  creator), so `guardSelfApproval` never refuses it. Approving and publishing keep their separation.

## Validation scope

A validation records its scope: `full` (the whole simulation set, or the regression suite over every
resolved case of the workload) or `case` (a run that named one `caseId`). Only a **full** validation of the
version's current content can satisfy a gate or fail it. A run on one case is stored with its real
per-check results but is `inconclusive` for gating: it never lets a skill pass, and it never replaces the
verdict of an earlier full run (so a failed full regression stays blocking after a narrower run passes).
`validationShortfall` says so ("A full regression has not been run ..."). Stored validations without a
`scope` are read as full.

## Rollback

Rolling back creates a NEW version with an earlier version's content. Only a version the current one
derives from (through `parentVersionId`) can be restored: a version that a previous rollback withdrew is
refused (`gate_failed`, 412), because restoring it would resurrect content that was deliberately withdrawn.
To bring that content back, propose it again as a new version, with the usual decision and validations.

## Refusals and audit

Every lifecycle change is one `ctx.repos.transaction`: new versions, version states, validations and
approvals, then the skill row, whose optimistic lock (`expectedVersion`) is the compare-and-swap for the
whole change. The audit event is the domain result's `audit` payload and commits with it. A refused step is
audited as `denied` (permission, four-eyes, illegal transition) or `failure` (stale version, unmet gate) and
returned with the status from `SKILL_ERROR_HTTP`. Reasons typed by people live on the approval and review
records only; `audit.ts` strips them (and the source case reference) from audit details, and nothing here logs
case or scenario text.

## Matching and applying

`skillMatches.list` has the engine's as-of semantics: `asOf` restricts both the temporal view and the
evidence the matcher sees (the matcher is given `createTemporalView(events, asOf)`, never the final analysis
filtered down), and the matcher derives its knowledge state from the visible events itself.

- **A read writes nothing.** `skillMatches.list` and `matchForCase` compute and return matches; they store
  and audit nothing, whoever reads. Whole-case matches are stored by the analysis snapshot and by an
  application (`skillMatches.apply`, `skills.apply`), and only those two.
- **Ids are deterministic**: `smt_` of (case, skill), independent of run and version, so the match a list
  returned can be applied by id (the application stores it) and a re-analysis carries an application onto the
  same id. A new run or skill version changes the match content, not its identity.
- **No hindsight while time-travelling.** As of an instant, the skills extracted from the case being read
  are left out (their triggers were learned partly from what happened later). The whole case is not time
  travel: the skill is matched there like any other. Other cases are unaffected.
- **One pass per window.** The instant is canonicalised to the last event the matcher can see, and answers
  are cached by (tenant, case, run, configuration, skill library, visible events), so every instant between
  two events shares one pass. A pass no cache serves is announced to `options.beforeColdPass`; the HTTP
  layer spends one unit of the caller's engine budget there (`services/engine-budget.ts`, the same bucket
  the views draw from, 429 with Retry-After when it is empty). Internal callers pass no hook and are not
  metered. An instant before the first event sees nothing and is not metered.

`skillMatches.apply` and `skills.apply` record that an engineer adopted the guided plan (idempotent, audited
once, also when two requests apply the same match at the same time; see "Applying a skill" below for that and
for the engine budget) with its conformance and the estimated effectiveness. A re-analysis keeps an applied match:
`services/analysis/carry.ts` carries who applied it and when onto the new match and recomputes its
conformance with `withApplication` (`applied.ts`), the same function the matcher uses on every read. An
application is a human decision, so it also survives the skill: when the skill is deprecated or retired
(no longer matchable) the stored match is kept, flagged by the skill's current `lifecycle`, and the
whole-case list still shows it. As-of lists never offer a skill that cannot be matched.

## The overlay: recorded versus with the skill

`skillOverlay.get` (`overlay.ts`) sets what a matched skill would have changed beside what the case recorded. It
reads, it never writes: no row is stored and no audit event is recorded (adopting the plan stays the explicit,
governed `skillMatches.apply`), which `apps/api/test/skill-overlay.int.test.ts` proves by comparing a digest of every
table before and after. The arithmetic and the wording are the domain's (`buildSkillOverlay`, with the rules for the
decision point and the formula in its header); this file only gathers what it is given:

- **The match** is the one `skillMatches.list` returns for the same `asOf` (same matcher, same cache, same
  budget), looked up by its id: 404 when the case has no such match then (also across tenants, and for the skill
  extracted from the case itself as of an earlier instant).
- **The decision points** are the engine's: stored for the whole record, recomputed from only what was known for an
  `asOf` (the views' shared, metered pass, `listForks`). Decision-time fields only are used.
- **The figures for the recorded path** are the ones the engine stored with its simulations of that decision point
  (`actualMetrics`), read only when no event of the case lies after the instant of the match; otherwise they are
  hindsight and the overlay withholds them, whatever is passed to the builder.
- **Cost.** The match is metered like a list; an `asOf` adds the view pass for its decision points, which is shared
  with every other view of that instant and so free when somebody has looked at it.

## What matching reads of a skill, and the hindsight notice

A skill's provenance lists the parts that were derived with knowledge of the source case's recorded
resolution (`provenance.hindsight.parts`) and carries a notice saying what they do. The notice is a claim
about this code, so it is pinned by `packages/domain/test/skills-hindsight.test.ts`:

- Matching reads **trigger conditions and exclusions**, some of which were learned with hindsight (the
  triggers are marked `(hindsight-informed)`). They take part in the score and the verdict, but each is
  checked only against the evidence the **matched case** had recorded at the match instant (the temporal
  view); nothing of that case's future, and nothing of the source case, reaches them.
- The match decision (score and verdict) never reads the **branch probabilities** (hindsight or
  decision-time), the success conditions, the known failure modes, the expected benefit or the confidence.
  The guided plan that comes with a match does show the decision-time probabilities, and never the hindsight
  ones.

The reading is the reason the skill extracted from a case is left out of as-of matches over that very case
(see above): its hindsight-informed conditions would name what the case only showed later.

## Effectiveness: two bases, both estimates

`aggregateSkillEffectiveness` (domain) is recomputed from the usage records of the skill's applications
every time one is recorded (`application.ts`), and stored on the skill (`SkillDna.effectiveness`). It
compares each application two ways, and names both (`notes`, `confidence.rationale`):

- **A simulated "without the skill" baseline** (the original fields: `avgTimeToDiagnosisMinutes`,
  `baselineAvgTimeToDiagnosisMinutes`, `estimatedTokenSavingsPct`). It is a seeded simulation of the
  knowledge-pack policy with no waiting between steps, so recorded times read longer than it by construction,
  and the pack already encodes much of what a skill captures. It is kept as it was, with its caveats.
- **The recorded path of the case the skill came from** (the optional `precedent` block). Both are recorded
  paths measured from their own decision point with the same definitions (`measureActualPath`), so they are
  like-for-like, though they are different cases and there is no control group. Fields: `cases`,
  `references`, `avgTimeToDiagnosisMinutes` against `precedentAvgTimeToDiagnosisMinutes` (over the same
  applications), `tokenChangePct` (negative means fewer tokens), `evidenceCompletenessPoints` (positive means
  more complete) and a fixed `basis` sentence ("... an estimate, not a measurement").

`precedent.ts` measures the origin once per run of that case (`PrecedentLoader`, keyed by tenant, skill
version, origin case, its run and the governed configuration) and shares it with every application. An
application on the origin case itself is not compared with its own path, and when the origin case was erased,
was never analysed or cannot be measured the application gets no precedent and no error; both are said in
`notes` ("... is not available, so n applications have no comparison with it"). When no application has a
precedent the block is absent.

## Applying a skill: concurrent applications and the engine budget

Recomputing the effectiveness reads the skill's applications and measures the latest ones again
(`measure.ts`), which takes a while when nothing is cached. Two rules keep that safe and bounded.

- **No application is lost, none is recorded twice.** An attempt reads the skill, with its version, before
  it measures anything, and writes the aggregate only at that version (`application.ts`). Another
  application (or any other change to the skill) that commits meanwhile makes the write a version conflict,
  and the attempt starts again from what is stored then: up to `APPLY_ATTEMPTS` (5) tries, each of them cheap
  after the first because every measurement is cached, then a 409 `version_conflict`. The skill is read
  again each time, so one that was retired meanwhile, or that has a new current version since the match was
  computed, is refused (409) instead of getting an application of a plan it no longer has.
  The transaction also looks at the stored match once more: an application recorded meanwhile stays as it
  was (nobody's `appliedBy` is overwritten) and is audited once.
- **Every measurement no cache can serve is metered.** The case itself, the recorded path of the origin
  and each of the latest `MAX_USAGE_CASES - 1` (9) earlier applications is looked up in a cache first (keyed
  by tenant, skill version, case, the case's latest run, the origin measurement and the governed
  configuration: a couple of cheap queries and no replay), and a miss is announced to
  `options.beforeColdPass` before its replay starts, one unit of the caller's engine budget each. An empty
  budget is a 429 before any engine work, with nothing stored; what was measured before it stays cached, so
  the retry carries on where it stopped. The replay cache holds `REPLAY_CACHE_ENTRIES` (12, at least
  `MAX_USAGE_CASES + 2`) analyses, so the walk over the origin, the case and its earlier applications is
  not evicted as it is read (a smaller cache would miss on every step of that walk).

## Driving it from code

```ts
const [skill] = await skills.extractForCase(ava, caseOne, { scenarioId }); // accepted scenarios only
const move = async (as, toState) => {
  const { skill: current } = await skills.get(as, skill.id);
  return skills.transition(as, skill.id, { toState, reason, expectedVersion: current.version });
};
await move(casey, 'draft');
await skills.runValidation(riley, skill.id, { kind: 'simulation_test' });
await move(riley, 'simulation_tested');
await move(riley, 'expert_reviewed');
await move(casey, 'pilot');
await skills.runValidation(riley, skill.id, { kind: 'regression' });
await move(riley, 'validated');
await move(alex, 'published');
```

Case One can be analysed again at any time: the engine seeds its simulations from the case content alone (not from
the analysis input hash, which also covers the skill library), so a skill entering the pilot re-runs the analysis
without redrawing a number, the regenerated scenario is the same simulation, and the reviewer's decision on it is
carried over. A decision is reset (audited as `counterfactual.review_reset`) only when the simulation really changed,
for example after the governed action-value weights moved.
