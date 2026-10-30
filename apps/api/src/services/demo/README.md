# Demo guide (`demo.state`, `demo.seed`, `demo.reset`)

The guided demo of the synthetic tenant: the 13 steps of the required end-to-end story, a seeder that plays
them through the **real services**, and a reset. `routes/demo.ts` only maps HTTP to `DemoPort`
(`services/ports.ts`), which `createDemoService` implements. Everything is tenant-scoped through `ctx.repos`.

| Route        | Permission    | What it does                                                                 |
| ------------ | ------------- | ---------------------------------------------------------------------------- |
| `demo.state` | `case:read`   | The 13 steps with progress derived from stored facts, plus honest notices    |
| `demo.seed`  | `demo:manage` | Seeds `base` or `portfolio` (idempotent) and returns the resulting state     |
| `demo.reset` | `demo:manage` | Erases the tenant's case data, clears the seed marker, returns a fresh state |

## Progress is derived, never flagged (`facts.ts`, `steps.ts`, `derive.ts`)

`loadFacts` reads a handful of tenant-scoped queries and no client input. Case One and Case Two are the
ingested copies of the built-in samples, recognised by the bundle reference (`story-cases.ts`, synthetic
cases only); the story skill is the oldest skill whose source cases include Case One.

| #   | Step                                      | Done when the stored data shows                                                                                               |
| --- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | Import Case One                           | the case exists                                                                                                               |
| 2   | Timeline reconstructed                    | its analysis state is `analyzed`                                                                                              |
| 3   | Evidence ledger built                     | it has claims                                                                                                                 |
| 4   | Competing hypotheses shown                | it has at least two hypotheses                                                                                                |
| 5   | Decision forks found                      | it has at least one fork                                                                                                      |
| 6   | A better path simulated and accepted      | a scenario of the **earliest meaningful fork** has `reviewState: confirmed`                                                   |
| 7   | Quality and efficiency metrics calculated | a quality assessment and metric estimates exist                                                                               |
| 8   | Draft SkillDNA generated                  | a skill lists Case One among its source cases                                                                                 |
| 9   | Governed approval completed               | a pilot approval and a publication are on record, by two **different** people                                                 |
| 10  | Import Case Two                           | the case exists                                                                                                               |
| 11  | The validated skill applies to Case Two   | a stored match for the skill, made when it was validated or published, `applies`                                              |
| 12  | The second investigation is shorter       | Case Two has metrics and the match carries conformance (the guided plan was applied)                                          |
| 13  | Outcomes compared                         | both cases have their metrics and the second investigation is recorded (the comparison is a view, so it is derived from them) |

Steps unlock in order: a step is `enabled` when it is complete or is the first incomplete one; every later
step is locked and its `lockedReason` names the step it waits for. Exactly one step is `isNextAction`: the
first incomplete step, or, once the story is complete, the last one (the comparison), so a presenter always
has one place to go. `route` deep-links are filled in once the case and skill ids are known.

Each step has a persona (`engineer`, `reviewer`, `manager`, `skill_curator`, `administrator`), concise
presenter notes that say what is simulated or estimated, and an action label. `state` also returns
`seededAt` (from the seed marker), `datasetLabel` ("Synthetic demonstration data"), the provider kind and
whether it is simulated, the three ids (null until they exist) and the notices: synthetic data, the
deterministic offline provider (or the Azure validation note), simulated estimates, nothing deployed to
Azure and every Azure integration validated against mocks only.

## Seeding (`seed.ts`, `story.ts`, `story-stages.ts`, `story-lifecycle.ts`, `actors.ts`)

`demo.seed { profile }` is refused with **409** (`demo data can only be managed in a synthetic demo tenant`)
unless `config.demo.mode` is on or the caller's tenant is flagged synthetic, while any job is queued or
running, or when the tenant lacks the synthetic personas (or they were disabled or lost a needed
permission). Every refusal is audited as `denied`.

- **`base`** leaves the story at step 1 for a live walk-through: case data is erased (users, governance
  settings and the audit trail stay) and the seed marker is set. It records no job because the erasure
  removes the job table.
- **`portfolio`** (the default of the scripts) plays the whole story inside one `demo_seed` job
  (`cancellable: false`, one stage per action, progress visible through `jobs.list`). The route waits for it
  (`runToCompletion`) and returns the final state. Each action is performed by the persona the story names,
  with its own `RequestContext` (`buildRequestContext`), so permissions, four-eyes and audit apply exactly as
  over HTTP:
  1. Ava (engineer) imports Case One (`ingestion.ingest`, built-in sample) and analyses it once;
  2. Riley (reviewer) accepts the balanced path of the earliest meaningful fork with a plain-language reason;
  3. Ava extracts the skill (`skills.extractForCase`);
  4. Casey (curator) drafts it; Riley runs the simulation test and signs off, then reviews it; Casey approves
     the pilot; Riley runs the regression suite and validates; Alex (administrator) publishes. Creator, pilot
     approver and publisher are three different people;
  5. Ava imports and analyses Case Two, so the published skill is matched, and applies the guided plan. The
     stage detail reports what the skill suggests **as of the first email** (a read-only match, never stored);
  6. Casey proposes a refinement learned from Case Two. It stays a **proposal** (`hasProposedMutation`): approving
     it needs a different person and validations on the new content. This is not one of the 13 steps, so an
     engine refusal is recorded in the stage detail and the log instead of failing the story.

The seed never writes a row itself. It is **idempotent**: every stage first looks at what is stored and skips
it when done, an interrupted run resumes where it stopped, and a complete, already seeded tenant is answered
without a job (the audit event says `noop: true`). The marker is written once, after the story is verified
complete, so `seededAt` does not move on a repeat run. A failed stage fails the job, is audited as `failure`
and is rethrown with its own status (a 4xx message is shown, anything else becomes a generic 500).

`story.ts` orders the actions and finds what is already stored, `story-lifecycle.ts` walks the skill through
its governed lifecycle, and `story-stages.ts` holds the job's stages, the recorded reasons and the
performed/skipped bookkeeping.

## Reset (`reset.ts`)

`demo.reset` has the same guard and refuses while a job runs. It audits `demo.reset` with `phase: started`,
calls `repos.demo.resetTenantData()` (cases and everything derived, skills, jobs, telemetry, the seed marker;
users, settings and audit stay), removes the mirrored payloads from the object store (a payload that cannot
be removed is logged with its id-only key and counted) and audits `phase: completed` with counters. The
answer is the fresh state: every step incomplete. Per-process caches (views, counterfactual replays, skill
matching, the AI orchestrator's semantic cache) have no eviction hook; they are keyed by tenant and run or
case ids that are never reused, so a reset cannot cause a stale hit, and entries expire by TTL or LRU.

## Audit

Details hold ids, counters and enums only: never case text, a reason a person typed or a secret.

| Action       | Outcome | Details                                                                                                                                                                                                 |
| ------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `demo.seed`  | success | `portfolio`: `{ profile, jobId, performed, skipped, caseOneId, caseTwoId, skillId }`; a no-op: `{ profile, noop, completedSteps }`; `base`: `{ profile, cases, skills, payloadsRemoved, payloadsKept }` |
| `demo.seed`  | denied  | `{ profile, reason: not_a_demo_tenant \| job_active \| personas_unavailable }`                                                                                                                          |
| `demo.seed`  | failure | `{ profile, jobId, stage }` (`base`: `{ profile, phase: reset }`)                                                                                                                                       |
| `demo.reset` | success | `{ phase: started }`, then `{ phase: completed, cases, skills, payloadsRemoved, payloadsKept }`                                                                                                         |
| `demo.reset` | denied  | `{ reason: not_a_demo_tenant \| job_active }`                                                                                                                                                           |
| `demo.reset` | failure | `{ phase: failed }`                                                                                                                                                                                     |

The services the seeder calls write their own events (`case.ingested`, `analysis.completed`,
`counterfactual.reviewed`, `skill.extracted`, `skill.transitioned`, `skill.published`, `skill.applied`, ...)
as the persona that acted.

## Command line and start-up (`demo-cli.ts`, `auto-seed.ts`)

`pnpm demo:seed [--profile base|portfolio]` (default `portfolio`) and `pnpm demo:reset` run in **direct
mode**: configuration from the environment and the repository's `.env` (`DATABASE_URL`, default the local PGlite
file of the API, `apps/api/.data`; the commands start in the API's working directory so they name the same files
`pnpm dev` does), the infrastructure
created in the process, the work done by the same `DemoService` as the routes, as the seeded administrator
(`user_alex_admin`) of the synthetic Contoso tenant. A local PGlite database belongs to one process at a time: stop
the API before running them against the same files. They print a short summary (never a connection string or a
secret) and exit non-zero on failure (1; 2 for a usage error). CI's `demo:replay` runs reset then seed.

When `DEMO_AUTO_SEED` is true (configuration only allows it in demo mode outside production) `main.ts` seeds
the `portfolio` profile after migrations and before the server listens, logging one line. A failure logs an
error and the server still starts.

## Honest limits

- Everything is synthetic and every figure is a labelled estimate; the offline provider is simulated.
- The simulation and regression "validations" replay recorded synthetic cases; they are not production results.
- Only the two built-in sample cases are recognised as the story's cases.
- No Azure service is called; Azure OpenAI, Entra, Blob Storage and AI Search are validated against mocks only.
