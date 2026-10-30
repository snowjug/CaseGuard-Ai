# Runbook: AI provider unavailable

Applies when `AI_PROVIDER=azure-openai`. The deterministic provider has no external dependency.

> Not exercised against a live deployment. See the [honesty note](README.md).

## Symptoms

- `GET /api/v1/system/provider` reports `healthy: false` (or `healthy: null` when no call has been made yet; `configured: false` when the endpoint or deployment is missing) with a `detail` message. `healthy` is `false` while the last call failed or the circuit breaker is open; the dependency status is then `degraded`. After three consecutive configuration faults (401, 403, 404 or unusable settings) the `detail` says the provider is misconfigured and the circuit breaker opens.
- `ai.model.execution` log lines end as `failed`, `timed_out`, `circuit_open` or `budget_exceeded` (also `rejected_by_validation` when an output is refused by the validators), usually with a `fallbackReason`; `ai.provider.failure`, `ai.provider.retry` and `ai.circuit.transition` warnings appear.
- `ai.provider.failure` (one per failed call) carries the error `code`, the HTTP `status` and a sanitised `causeCode` (for example `ENOTFOUND` for a DNS failure, `ECONNREFUSED`, or the credential error name for a managed-identity problem); it never carries a URL, token, header or response body.
- Errors in the logs mention HTTP 401/403, 404 `DeploymentNotFound`, 429, 5xx, DNS failures or content-filter rejections.
- Users do **not** see failed analyses: a failed model task falls back to the deterministic result, so analyses and counterfactual runs still complete (see Impact).

## Impact

- The model only _proposes_; deterministic code (probability math, safety policy, citation checks) produces every stored artefact, and no unvalidated model output is used. In the committed API a failed model task is logged and skipped, or replaced by the deterministic result, and never blocks an analysis or a counterfactual scenario ([AI_ORCHESTRATION.md](../AI_ORCHESTRATION.md) sections 8 and 11). What is lost is the model's proposal or narrative wording, and the executions are recorded as failed.
- Read-only views of existing cases, ledgers and skills keep working. No data is lost.
- Latency and cost: retries inside the provider (`AI_MAX_RETRIES`, default 2; a `Retry-After` above 15 s ends retrying) multiply calls during a partial outage; the circuit breaker (opens after five consecutive health failures or three consecutive configuration faults, stays open 30 s, then allows one probe) and the bulkhead (4 concurrent calls, queue of 16) bound this.
- If the provider object could not be built at all (an endpoint refused by the outbound URL guard, a failed `@azure/identity` import), the failure is cached for the life of the process: `system.provider` stays `healthy: false` until the revision restarts.

## Detection

- The model queries in [OBSERVABILITY.md](../OBSERVABILITY.md): 4.3 (model latency), 4.4 (model failures), 4.7 (counterfactual failures). The API 5xx alert does **not** fire for a provider outage, because model failures fall back instead of failing the request; alert on the model failure ratio instead (OBSERVABILITY section 5).
- Azure OpenAI resource: metrics blade, and diagnostic logs (`AzureDiagnostics`, categories `RequestResponse`, `Audit`) when `deployOpenAi` is used; Azure Service Health for the region.
- Quick view of reasons:

  ```kusto
  CgApiLogs()
  | where TimeGenerated > ago(1h) and event == 'ai.model.execution' and execStatus in ('failed', 'timed_out', 'circuit_open', 'budget_exceeded')
  | summarize failures = count(), sampleRequestId = take_any(requestId) by execStatus, fallbackReason, agent
  | order by failures desc
  ```

  ```kusto
  // Retries by HTTP status and the circuit breaker state changes
  CgApiLogs()
  | where TimeGenerated > ago(1h) and event in ('ai.provider.retry', 'ai.circuit.transition')
  | summarize count() by event, code, bin(TimeGenerated, 5m)
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

   Nothing stored changes: the deterministic engine produces every analysis artefact whichever provider is configured, so analyses made during the window are not different in content. What differs is the execution records (`simulated: true`, `source` deterministic) and, for counterfactuals, the rationale wording that a model could have supplied. Note the window anyway. The next deployment restores the template value, so also set `deployOpenAi=false` (and clear `existingOpenAiResourceId`) in your parameter file if the fallback must persist. The provider kind comes from the environment (`AI_PROVIDER`): a tenant's governance `model` section cannot select a provider that is not connected ([AI_ORCHESTRATION.md](../AI_ORCHESTRATION.md) section 8).

4. **Fix the cause:** grant the role, correct the deployment name, request quota, repair DNS/private endpoint, or point `existingOpenAiResourceId`/`openAiDeploymentName` at a healthy deployment and redeploy. If the provider could not be built (see Impact), restart the revision after the fix: the failed construction is cached for the life of the process.

## Recovery

1. Restore `AI_PROVIDER=azure-openai` (redeploy with the intended parameters, or `az containerapp update --set-env-vars AI_PROVIDER=azure-openai`).
2. Analyses did not fail, so nothing needs re-running for correctness. If you want fresh model execution records for the affected window, start the analysis again (`POST /api/v1/cases/:caseId/analysis`, `case:analyze`; identical input is reused unless forced). Artefact ids are deterministic, so a forced re-run replaces outputs and carries reviewer decisions forward.
3. Close the incident only after the verification below.

## Verification

- `GET /api/v1/system/provider` shows `healthy: true` and the expected `model` (a remote provider reports `null` until a call has been made and `false` after a failed call until one succeeds, so trigger one analysis first).
- Query 4.4 shows a falling failure rate; at least one analysis completes end to end with `succeeded` executions.
- No `circuit_open` events in the last 30 minutes.

## Follow-ups

- Alerts on model failure ratio and on `circuit_open` (OBSERVABILITY section 5; nothing is provisioned for them today); alert on quota consumption.
- Record the Azure OpenAI quota and the model retirement dates for the deployed model in your operations notes.
- Exercise the deterministic fallback regularly so it is known to work.
- If throttling was the cause, add capacity or smooth demand (lower per-agent budgets, enable the semantic cache) rather than raising retries.
- Azure AI Content Safety _Prompt Shields_ is a roadmap item and is **not implemented** (docs/THREAT_MODEL.md section 5).
