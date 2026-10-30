# Command Center (`dashboard.commandCenter`)

Permission `case:read`. `routes/dashboard.ts` only maps HTTP to `getCommandCenter`; the rest of this folder
is pure functions that are unit-tested without a database.

## What it returns

The quality picture of **one case**, plus tenant-wide lists around it (the web page shows it that way).

- **The case.** `?caseId=` if it exists, else the most recently analysed case, else the newest case, else none.
  A requested case that is not found (deleted, or another tenant's: both look the same) falls back to the
  default and says so in `notices`, so a page that remembered a case survives a demo reset.
- **Seven metric cards** (`cards.ts`): Case Quality Index, Evidence Integrity, Avoidable Support Effort,
  Reasoning Efficiency, Customer Effort, Resolution Confidence and Token Efficiency, in the contract order. The
  domain builds each card from the stored estimate (`buildMetricCards`): its plain-language definition, formula
  and status band (`good`/`watch`/`poor`/`unknown`, from `METRIC_DEFINITIONS`) come from the shared source of
  truth, the range is shown when the estimate has one, and every card is `estimated: true`. `synthetic` is set
  from the estimate or the case. `evidenceLink` points at the page that shows the evidence (quality, evidence,
  hypotheses, timeline, counterfactual lab, efficiency). A metric without an estimate is a card with
  `value: null`, `status: 'unknown'` and a "Not available yet" display, never a missing card.
- **Trends are never fabricated.** A case keeps only its latest analysis, so the only honest trend is against
  an earlier **analysed case**: it exists only when there are at least two analysed cases, both values are
  present, and its label names the case it compares with and says "estimates". The notices add that with so
  few cases it is illustrative, not a trend over time.
- **Case panels** (`picks.ts`): open warnings (engine rank order), critical missing evidence (unresolved), the
  leading hypothesis (highest confidence, with its range) and the best stored skill match (published or
  validated skills that apply at least partly; a skill that does not apply is not shown as a match).
- **Tenant lists:** the newest cases with their analysis summaries (`services/cases`), skills still awaiting a
  decision, and the system summary (`health-summary.ts`) reduced from the system service's report, which is
  reused rather than recomputed.

An empty tenant returns valid, honest, empty data: no case, seven "not available" cards, empty lists and a
notice that says where to start. `notices` also say what is an estimate and when the AI provider is simulated.

## Data sources

`ctx.repos.cases` (`get`, `list`), `ctx.repos.analysis` (`listMetrics`, `listHypotheses`, `listWarnings`,
`listMissing`), `ctx.repos.skills` (`list`, `listMatchesForCase`), `summarizeCase`/`listCases` from
`services/cases`, and `buildSystemHealth` from `services/system`. The tenant-wide batched read models
(`listOpenWarnings`, `listCriticalMissing`) are not used: this page is case-focused.

## Not done on purpose

No individual is scored or ranked, nothing is invented for a case that has no analysis, and the stored skill
matches are shown as stored (a `GET` never recomputes or writes them).
