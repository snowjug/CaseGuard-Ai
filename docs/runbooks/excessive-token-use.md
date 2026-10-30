# Runbook: excessive token use

> Not exercised against a live deployment. See the [honesty note](README.md). Money figures are deliberately absent: get current prices from the sources in [../COST_GUIDE.md](../COST_GUIDE.md) and convert token counts yourself.

## Symptoms

- Token consumption per hour or day is several times the baseline (OBSERVABILITY 4.5), or a budget notification arrives.
- Model executions end as `budget_exceeded` (a per-request, per-case, per-day or per-agent limit tripped), or users report analyses being refused for cost reasons.
- Azure OpenAI metrics show processed tokens or requests far above normal; the Azure budget alert fires.
- A subset of cases or one tenant dominates usage; retries (`ai.provider.retry` warnings) or very large inputs are common.

## Impact

- **Spend** (denial of wallet, threat T9) and possibly **throttling** of everyone sharing the deployment's quota.
- Latency increases when a noisy workload saturates quota; failures follow (see [ai-provider-unavailable](ai-provider-unavailable.md)).
- With the deterministic provider token counts are estimates (`ceil(chars / 4)`, `tokenSource` `estimated`), no cost is computed and nothing is billed.

## Detection

```kusto
// Hourly tokens by tenant for the last 48 hours (spike = several times the usual volume); tokenSource shows whether the counts were measured by the provider or estimated
CgApiLogs()
| where TimeGenerated > ago(48h) and event == 'ai.model.execution' and isnotnull(promptTokens)
| summarize totalTokens = sum(coalesce(promptTokens, long(0)) + coalesce(completionTokens, long(0))), calls = count() by bin(TimeGenerated, 1h), tenantId, tokenSource
| render timechart
```

```kusto
// Who or what is expensive? By agent and model, with the biggest single call
CgApiLogs()
| where TimeGenerated > ago(24h) and event == 'ai.model.execution' and isnotnull(promptTokens)
| summarize totalTokens = sum(coalesce(promptTokens, long(0)) + coalesce(completionTokens, long(0))), calls = count(), maxPrompt = max(promptTokens), maxCompletion = max(completionTokens) by agent, model
| order by totalTokens desc
```

```kusto
// Retry storms and breaker/limit events
CgApiLogs()
| where TimeGenerated > ago(24h) and event == 'ai.model.execution' and execStatus in ('budget_exceeded', 'circuit_open', 'timed_out', 'failed')
| summarize events = count() by execStatus, agent, bin(TimeGenerated, 1h)
```

```kusto
// Budget refusals by reason (request_tokens, day_tokens, case_tokens, cost_limit, cost_unknown)
CgApiLogs()
| where TimeGenerated > ago(24h) and event == 'ai.budget.refused'
| summarize refusals = count() by code, agent, bin(TimeGenerated, 1h)
```

Application views (permission `telemetry:read`): `GET /api/v1/efficiency/overview` and `GET /api/v1/model-executions` are in the API contract and answered 200 in a smoke run against an in-memory API; on an older checkout, from before these handlers were added, they answer 501, and then you use the log queries above and `GET /api/v1/system/metrics` (`modelExecutions`, since the process started). Azure side: Azure OpenAI metrics and Cost analysis filtered to the resource.

## Triage

1. **Is it real usage or abuse?** Compare tenants, users (opaque ids), time of day and agents. A flood of long inputs from one user, or many cases created in a loop, suggests abuse or a runaway client.
2. **Prompt injection or hostile content?** Very large inputs and repeated analyses of the same case can be an attempt to burn tokens. Check the prompt-injection indicators query (OBSERVABILITY 4.9: `case.ingested` with `injectionDetected`, `ai.model.execution` with `injectionIndicators`) and follow [suspicious-prompt-injection](suspicious-prompt-injection.md) if present.
3. **Retries and loops.** High `attempts`, many `timed_out`, a breaker that opens and closes: a provider problem multiplied by retries. Check `AI_MAX_RETRIES` and the circuit breaker settings.
4. **Configuration.** Did a change raise `AI_MAX_INPUT_TOKENS`/`AI_MAX_OUTPUT_TOKENS`, per-agent budgets or `maxAnalysisDepth`? Was the semantic cache disabled? Did a prompt version grow? (Governance settings are versioned and audited: `GET /api/v1/audit`.)
5. **Cost limits actually effective?** Monetary limits (`AI_COST_LIMIT_USD_PER_DAY`, governance `costLimits`) only work when unit prices are configured. Without prices only **token** limits apply.

## Mitigation (least to most disruptive)

1. **Tighten limits in the application** (administrator, governance `model` section via the UI or `PUT /api/v1/governance/settings/model`; changes are versioned and audited): lower per-agent `maxInputTokens`/`maxOutputTokens`, `maxRetries`, `maxAnalysisDepth`; set `costLimits.perDayUsd` and `unitPrices` (`inputPer1kUsd`, `outputPer1kUsd`) if known. The effective limit is the stricter of the tenant setting and the operator's environment.
2. **Tighten limits in the deployment** (durable: change the parameter file and redeploy; urgent: `az containerapp update --set-env-vars ...`):

   ```powershell
   az containerapp update --subscription $sub --resource-group $rg --name <api app> --set-env-vars AI_MAX_INPUT_TOKENS=8000 AI_MAX_OUTPUT_TOKENS=1500 AI_MAX_RETRIES=1 RATE_LIMIT_AI_MAX=10
   ```

3. **Limit who can trigger it.** Remove the abusive user's app role in Entra (their next token has no permissions) or disable the user; reduce `RATE_LIMIT_AI_MAX`.
4. **Pause model use** by switching to the deterministic provider (see the fallback in [ai-provider-unavailable](ai-provider-unavailable.md)).
5. **Cap the platform.** Lower the Azure OpenAI deployment capacity (tokens per minute) in the portal or by redeploying with a smaller `openAiModelCapacity`; as a last resort delete the model deployment (model calls then fail and the orchestrator falls back to the deterministic result, which stops the spend; the provider shows unhealthy until the deployment is restored).

## Recovery

- Restore limits to their intended values once the cause is fixed; raise them gradually and watch query 4.5.
- Re-run analyses that were refused with `budget_exceeded` once the budget allows (re-runs replace outputs and carry forward reviews).
- If abuse was confirmed, keep the evidence (audit entries, request ids) and follow your account-closure process.

## Verification

- Hourly tokens return to the baseline band for several hours; no new `budget_exceeded` or retry storms.
- The Azure OpenAI metrics and the cost view stop rising abnormally.
- The effective limits are visible in the governance settings and the running revision's environment.

## Follow-ups

- Set unit prices in every environment that uses a paid model (Bicep parameters `aiUnitPriceInputPer1k`/`aiUnitPriceOutputPer1k`, environment `AI_UNIT_PRICE_INPUT_PER_1K`/`AI_UNIT_PRICE_OUTPUT_PER_1K`, or the governance `model.unitPrices`) and a daily ceiling, and tell the owners the figures come from operator-supplied prices.
- Add alerts: hourly token spike, `budget_exceeded`, Azure budget thresholds (`budgetActualThresholds`). Nothing exports the in-process token metrics today (OBSERVABILITY section 8), so the log-based alerts are the only option.
- Add per-tenant quotas and input-size validation if one tenant can dominate.
- Review default budgets after measuring a representative week; keep the semantic cache enabled.
