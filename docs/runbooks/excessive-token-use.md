# Runbook: excessive token use

> Not exercised against a live deployment. See the [honesty note](README.md). Money figures are deliberately absent: get current prices from the sources in [../COST_GUIDE.md](../COST_GUIDE.md) and convert token counts yourself.

## Symptoms

- Token consumption per hour or day is several times the baseline (OBSERVABILITY 4.5), or a budget notification arrives.
- Model executions end as `budget_exceeded` (a per-request, per-case, per-day or per-agent limit tripped), or users report analyses being refused for cost reasons.
- Azure OpenAI metrics show processed tokens or requests far above normal; the Azure budget alert fires.
- A subset of cases or one tenant dominates usage; retries (`attempts` above 1) or very large inputs are common.

## Impact

- **Spend** (denial of wallet, threat T9) and possibly **throttling** of everyone sharing the deployment's quota.
- Latency increases when a noisy workload saturates quota; failures follow (see [ai-provider-unavailable](ai-provider-unavailable.md)).
- With the deterministic provider the "cost" is simulated: token counts are estimates (`ceil(chars / 4)`) and nothing is billed.

## Detection

```kusto
// Hourly tokens by tenant for the last 48 hours (spike = several times the usual volume)
CgApiLogs()
| where TimeGenerated > ago(48h) and isnotnull(promptTokens)
| summarize totalTokens = sum(coalesce(promptTokens, long(0)) + coalesce(completionTokens, long(0))), calls = count() by bin(TimeGenerated, 1h), tenantId
| render timechart
```

```kusto
// Who or what is expensive? By agent and model, with the biggest single call
CgApiLogs()
| where TimeGenerated > ago(24h) and isnotnull(promptTokens)
| summarize totalTokens = sum(coalesce(promptTokens, long(0)) + coalesce(completionTokens, long(0))), calls = count(), maxPrompt = max(promptTokens), maxCompletion = max(completionTokens) by agent, model
| order by totalTokens desc
```

```kusto
// Retry storms and breaker/limit events
CgApiLogs()
| where TimeGenerated > ago(24h) and isnotempty(agent) and statusText in ('budget_exceeded', 'circuit_open', 'timed_out', 'failed')
| summarize events = count() by statusText, agent, bin(TimeGenerated, 1h)
```

Application views (permission `telemetry:read`): `GET /api/v1/efficiency/overview` and `GET /api/v1/model-executions`. Azure side: Azure OpenAI metrics and Cost analysis filtered to the resource.

## Triage

1. **Is it real usage or abuse?** Compare tenants, users (opaque ids), time of day and agents. A flood of long inputs from one user, or many cases created in a loop, suggests abuse or a runaway client.
2. **Prompt injection or hostile content?** Very large inputs and repeated analyses of the same case can be an attempt to burn tokens. Check `injection.flagged` (OBSERVABILITY 4.9) and follow [suspicious-prompt-injection](suspicious-prompt-injection.md) if present.
3. **Retries and loops.** High `attempts`, many `timed_out`, a breaker that opens and closes: a provider problem multiplied by retries. Check `AI_MAX_RETRIES` and the circuit breaker settings.
4. **Configuration.** Did a change raise `AI_MAX_INPUT_TOKENS`/`AI_MAX_OUTPUT_TOKENS`, per-agent budgets or `maxAnalysisDepth`? Was the semantic cache disabled? Did a prompt version grow? (Governance settings are versioned and audited: `GET /api/v1/audit`.)
5. **Cost limits actually effective?** Monetary limits (`AI_COST_LIMIT_USD_PER_DAY`, governance `costLimits`) only work when unit prices are configured. Without prices only **token** limits apply.

## Mitigation (least to most disruptive)

1. **Tighten limits in the application** (administrator, governance `model` section via the UI or `PUT /api/v1/governance/settings/model`; changes are versioned and audited): lower per-agent `maxInputTokens`/`maxOutputTokens`, `maxRetries`, `maxAnalysisDepth`; set `costLimits.perDayUsd` and unit prices if known.
2. **Tighten limits in the deployment** (durable: change the parameter file and redeploy; urgent: `az containerapp update --set-env-vars ...`):

   ```powershell
   az containerapp update --subscription $sub --resource-group $rg --name <api app> --set-env-vars AI_MAX_INPUT_TOKENS=8000 AI_MAX_OUTPUT_TOKENS=1500 AI_MAX_RETRIES=1 RATE_LIMIT_AI_MAX=10
   ```

3. **Limit who can trigger it.** Remove the abusive user's app role in Entra (their next token has no permissions) or disable the user; reduce `RATE_LIMIT_AI_MAX`.
4. **Pause model use** by switching to the deterministic provider (see the fallback in [ai-provider-unavailable](ai-provider-unavailable.md)).
5. **Cap the platform.** Lower the Azure OpenAI deployment capacity (tokens per minute) in the portal or by redeploying with a smaller `openAiModelCapacity`; as a last resort delete the model deployment (the application then fails fast, which is safer than unbounded spend).

## Recovery

- Restore limits to their intended values once the cause is fixed; raise them gradually and watch query 4.5.
- Re-run analyses that were refused with `budget_exceeded` once the budget allows (re-runs replace outputs and carry forward reviews).
- If abuse was confirmed, keep the evidence (audit entries, correlation ids) and follow your account-closure process.

## Verification

- Hourly tokens return to the baseline band for several hours; no new `budget_exceeded` or retry storms.
- The Azure OpenAI metrics and the cost view stop rising abnormally.
- The effective limits are visible in the governance settings and the running revision's environment.

## Follow-ups

- Set unit prices (`aiUnitPriceInputPer1k`/`aiUnitPriceOutputPer1k`) and a daily ceiling in every environment that uses a paid model, and tell the owners the figures come from operator-supplied prices.
- Add alerts: hourly token spike, `budget_exceeded`, Azure budget thresholds (`budgetActualThresholds`).
- Add per-tenant quotas and input-size validation if one tenant can dominate.
- Review default budgets after measuring a representative week; keep the semantic cache enabled.
