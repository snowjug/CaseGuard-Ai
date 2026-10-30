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
once) with its conformance and the estimated effectiveness. A re-analysis keeps an applied match:
`services/analysis/carry.ts` carries who applied it and when onto the new match and recomputes its
conformance with `withApplication` (`applied.ts`), the same function the matcher uses on every read. An
application is a human decision, so it also survives the skill: when the skill is deprecated or retired
(no longer matchable) the stored match is kept, flagged by the skill's current `lifecycle`, and the
whole-case list still shows it. As-of lists never offer a skill that cannot be matched.

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

Analyse Case One once, before the reviewer accepts its scenario. The engine seeds its simulations from the
analysis input hash, and a skill entering the pilot changes that hash, so analysing Case One again afterwards
resets the reviewed scenario (audited as `counterfactual.review_reset`) although the skill keeps its
provenance.
