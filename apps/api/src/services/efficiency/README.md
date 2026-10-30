# Efficiency monitor (`efficiency.overview`, `efficiency.executions`)

Both routes need `telemetry:read`. They describe how CaseGuard's own AI calls were used; they never contain a
prompt, raw model output, case text or a secret (the execution records hold hashes and metadata only).

## `efficiency.overview` (`overview.ts`, `case-process.ts`, `index.ts`)

| Block             | Source and rule                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `totals`          | `repos.telemetry.aggregate`: executions, prompt/completion/cached tokens, average latency, cache-hit and failure rates                                                                                                                                                                                                                                                                                                                                                  |
| `byAgent`         | per agent, with `budgetUtilization` = a typical request's prompt tokens over that agent's per-request input limit                                                                                                                                                                                                                                                                                                                                                       |
| `byModel`         | per model and provider (only provider kinds the contract knows)                                                                                                                                                                                                                                                                                                                                                                                                         |
| `savings`         | context compression, cache hits and early stopping from the usage records; duplicate removal is part of compression and shown as 0                                                                                                                                                                                                                                                                                                                                      |
| `budgets`         | the **effective** model settings (`effectiveModelConfig`: the tenant's governed `model` section tightened by `AI_*` limits). `perRequestMaxTokens` is the input limit the governor enforces; `perCaseMaxTokens` and `perDayMaxTokens` are `null` because none is configured (the contract allows `null`); `consumedToday` is the tenant's recorded tokens today; `costLimitUsdPerDay` is `null` when unset                                                              |
| `circuitBreakers` | what the AI service reports (`ai.health`). The deterministic provider makes no remote call, so the list is empty and a note says why; nothing is invented                                                                                                                                                                                                                                                                                                               |
| `caseProcess`     | real versus simulated path tokens, from the token component of the stored avoidable-effort estimate (the same arithmetic as the domain's `computeEfficiency`). With `caseId` it is that case; without one it adds up the 25 most recently analysed cases that have a valid simulated path (`caseId: null`). A case without one (no decision fork, or no valid path) gets `actualTokens: 0`, no counterfactual and no saving, and a note says that means "not available" |
| `labels`          | `estimated: true` always; `simulated: true` when the deterministic provider produced the values                                                                                                                                                                                                                                                                                                                                                                         |
| `notes`           | what is simulated, why cost is unknown, the limits in force, breakers, and the scope of the comparison                                                                                                                                                                                                                                                                                                                                                                  |

A `caseId` that is not found (deleted, or another tenant's) is treated as no case: the figures then cover every
case and a note says so. An empty tenant returns zeros, empty arrays, `null` budgets and a note.

## `efficiency.executions`

The route returns `repos.telemetry.listExecutions` for the caller's tenant (newest first, keyset cursor,
optional `caseId` and `agent`), each record with its token usage. An unknown or foreign `caseId` simply matches
nothing.

## Honesty

Token counts from the deterministic provider are simulated estimates, not Azure OpenAI usage; cost is `null`
until the operator supplies unit prices (prices are never hard-coded); every saving is an estimate and the
quality impact is described as estimated, never measured.
