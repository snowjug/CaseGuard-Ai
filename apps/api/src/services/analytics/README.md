# Quality analytics (`analytics.overview`)

Permission `analytics:read` (managers and administrators). `routes/dashboard.ts` maps HTTP to
`getAnalyticsOverview`.

The aggregation itself lives in the domain (`buildAnalyticsOverview`, `packages/domain/src/metrics/analytics.ts`),
where the definitions are; this service reads the data tier's bounded read model through the caller's
tenant-bound repositories (`repos.analytics.collect(500)`, `repos.reviews.stats()`, `repos.cases.counts()`) and
adapts it (`overview.ts`).

## What it returns

Quality and evidence-integrity trend by month, decision-fork categories (shares sum to 1), common missing
evidence, avoidable-effort patterns, SkillDNA adoption and effectiveness, token efficiency, counterfactual
acceptance, reviewer disagreement and the most frequent unsupported assumptions (by subject, never by text).

## Privacy and honesty rules

- **No per-person data.** Only counts, averages and knowledge-pack labels are returned. No user id, display
  name, e-mail or participant alias appears, nothing is ranked or scored per employee, and the mandatory
  `responsibleUseNotice` says so. The text of flagged statements is dropped before the domain sees it.
- **Small cohorts are never hidden** (minimum group size 1) because the demo has two cases, and are never
  dressed up: `cohort.note` says, for example, "n=2: with so few analysed cases, trends and averages are
  illustrative only", and says when only the 500 newest cases are covered.
- Everything is an estimate; skill effectiveness carries its `synthetic` flag, and improvements shown for
  synthetic cases demonstrate the measurement pipeline, not real-world effectiveness.
- An empty tenant returns zeros, empty lists, `null` rates and a note.
