# Runbook: AI provider unavailable

Applies when `AI_PROVIDER=azure-openai`. The deterministic provider has no external dependency.

> Not exercised against a live deployment. See the [honesty note](README.md).

## Symptoms

- Analyses, counterfactual runs or skill extraction fail or stall; the UI shows the provider as unhealthy.
- `GET /api/v1/system/provider` reports `healthy: false` (or `configured: false`) with a `detail` message.
- Model executions end as `failed`, `timed_out`, `circuit_open` or `budget_exceeded`.
- Errors in the logs mention HTTP 401/403, 404 `DeploymentNotFound`, 429, 5xx, DNS failures or content-filter rejections.

## Impact

- Everything that needs a model call fails or degrades: the model only _proposes_; deterministic code (probability math, safety policy, citation checks, persistence validation) still runs, and no unvalidated model output is persisted.
- Read-only views of existing cases, ledgers and skills keep working. No data is lost.
- Cost: retries multiply cost during a partial outage; the circuit breaker (default: opens after 5 failures, resets after 30 s) and `AI_MAX_RETRIES` bound this.

## Detection

- API 5xx alert and the model queries in [OBSERVABILITY.md](../OBSERVABILITY.md): 4.3 (model latency), 4.4 (model failures), 4.7 (counterfactual failures).
- Azure OpenAI resource: metrics blade, and diagnostic logs (`AzureDiagnostics`, categories `RequestResponse`, `Audit`) when `deployOpenAi` is used; Azure Service Health for the region.
- Quick view of reasons:

  ```kusto
  CgApiLogs()
  | where TimeGenerated > ago(1h) and isnotempty(agent) and (level >= 50 or statusText in ('failed', 'timed_out', 'circuit_open', 'budget_exceeded'))
  | summarize failures = count(), sampleCorrelationId = take_any(correlationId) by statusText, msg
  | order by failures desc
  ```

## Triage

1. **Scope.** Is it every agent or one? Every tenant or one? Started at a deployment time (new revision, parameter change) or spontaneously? Check the provider status (`GET /api/v1/system/provider`, permission `telemetry:read`).
2. **Azure first.** Azure Service Health for Azure OpenAI in your region; quota or throttling in the account's metrics.
3. **Classify by error:**
   - **401/403** - the identity lacks **Cognitive Services OpenAI User** on the account, the assignment is still propagating (minutes), or the application is using key auth against an account with `disableLocalAuth` (templates set it): `AZURE_OPENAI_AUTH` must be `managed-identity`. Check: `az role assignment list --subscription $sub --scope <openai account resource id> --query "[].{role:roleDefinitionName,principal:principalId}" -o table` and that `AZURE_CLIENT_ID` is set on the container.
   - **404 DeploymentNotFound / ModelNotFound** - `AZURE_OPENAI_DEPLOYMENT` does not match a deployment on the account (renamed, deleted, or never created: `deployOpenAiModel` is off by default). List: `az cognitiveservices account deployment list --subscription $sub --resource-group <rg of account> --name <account> -o table`.
   - **429** - tokens-per-minute or requests-per-minute quota exhausted. Check usage against the deployment capacity; see mitigation.
   - **Timeouts / DNS** - with private networking, the private endpoint, the DNS zones (`privatelink.openai.azure.com`, `privatelink.cognitiveservices.azure.com`) or the VNet link are broken; from the API container: `az containerapp exec ... --command "nslookup <account>.openai.azure.com"`.
   - **400 with a content-filter code** - the input was blocked by the account's content filter; this is data-dependent, not an outage.
   - **API version errors** - `AZURE_OPENAI_API_VERSION` is retired or unsupported for the model.
4. **Recent changes.** New revision, environment-variable changes, quota changes, model retirement or version upgrade on the deployment (the template pins `NoAutoUpgrade`).

## Mitigation

Pick the least disruptive option that stops user-visible failures:

1. **Let the circuit breaker work** and tell users analyses will be retried; fix the cause (below).
2. **Reduce load** on a throttled deployment: lower `RATE_LIMIT_AI_MAX`, ask users to pause bulk analyses, keep `AI_MAX_RETRIES` low.
3. **Fall back to the deterministic provider** (explicitly labelled simulated, never presented as model output):

   ```powershell
   az containerapp update --subscription $sub --resource-group $rg --name <api app> --set-env-vars AI_PROVIDER=deterministic
   ```

   Analyses produced during the fallback window are not comparable with model-assisted ones; note the window. The next deployment restores the template value, so also set `deployOpenAi=false` (and clear `existingOpenAiResourceId`) in your parameter file if the fallback must persist. The governance `model` section also carries a provider setting; which source wins is an implementation detail to confirm.

4. **Fix the cause:** grant the role, correct the deployment name, request quota, repair DNS/private endpoint, or point `existingOpenAiResourceId`/`openAiDeploymentName` at a healthy deployment and redeploy.

## Recovery

1. Restore `AI_PROVIDER=azure-openai` (redeploy with the intended parameters, or `az containerapp update --set-env-vars AI_PROVIDER=azure-openai`).
2. Re-run analyses that failed. Analysis artefact ids are deterministic per `(caseId, stable key)`, so re-runs replace outputs and carry forward reviews.
3. Close the incident only after the verification below.

## Verification

- `GET /api/v1/system/provider` shows `healthy: true` and the expected `model`.
- Query 4.4 shows a falling failure rate; at least one analysis completes end to end with `succeeded` executions.
- No `circuit_open` events in the last 30 minutes.

## Follow-ups

- Alerts on model failure ratio and on `circuit_open` (OBSERVABILITY section 5); alert on quota consumption.
- Record the Azure OpenAI quota and the model retirement dates for the deployed model in your operations notes.
- Exercise the deterministic fallback regularly so it is known to work.
- If throttling was the cause, add capacity or smooth demand (lower per-agent budgets, enable the semantic cache) rather than raising retries.
- Azure AI Content Safety _Prompt Shields_ is a roadmap item and is **not implemented** (docs/THREAT_MODEL.md section 5).
