# Runbook: suspicious prompt injection

Case text is **untrusted data**. Prompt injection means content (a customer e-mail, a note, an uploaded log) that tries to instruct the model ("ignore previous instructions...") or smuggle instructions into prompts, skills or outputs.

> Not exercised against a live deployment. See the [honesty note](README.md). The detector is heuristic and can be evaded; Azure AI Content Safety _Prompt Shields_ is a roadmap item and is **not implemented** (docs/THREAT_MODEL.md section 5). A quiet dashboard is therefore not proof of absence.

## Symptoms

- A burst of `injection.flagged` events, or flagged cases concentrated on one tenant, user or source.
- Model executions ending `rejected_by_validation` at an unusual rate (schema, citation, policy or temporal checks refusing outputs).
- Reviewers report recommendations that ignore the case, reference non-existent evidence, or contain instructions addressed to "the AI".
- Unusual skill proposals (SkillDNA extraction or mutation), or token spikes on specific cases.
- Case content or model output containing URLs, credentials-looking strings, or requests to disable safeguards.

## Impact

- **Integrity risk** (the main one): poisoned analysis or a poisoned skill that propagates bad advice. Controls limit it: instructions and data are structurally separated, the model has **no tools**, outputs are schema/citation/policy validated before persistence, skills are never auto-published and need a distinct approver, and every action is audited.
- **Cost**: token flooding (see [excessive-token-use](excessive-token-use.md)).
- **Confidentiality**: unlikely through the model alone (no tools, tenant-scoped retrieval, redaction before prompts), but a successful injection could surface other content from the same case in an output.

## Detection

```kusto
CgApiLogs()
| where TimeGenerated > ago(24h) and event == 'injection.flagged'
| summarize flagged = count(), firstSeen = min(TimeGenerated), lastSeen = max(TimeGenerated), sampleCorrelationId = take_any(correlationId) by tenantId, bin(TimeGenerated, 1h)
| order by flagged desc
```

```kusto
// Validator rejections by agent: a sudden rise can mean crafted content is steering outputs
CgApiLogs()
| where TimeGenerated > ago(24h) and isnotempty(agent) and statusText == 'rejected_by_validation'
| summarize rejections = count() by agent, bin(TimeGenerated, 1h)
| render columnchart
```

Application views: the audit log (`GET /api/v1/audit`, permission `audit:read`) and the model-execution list (`GET /api/v1/model-executions`, `telemetry:read`) show what ran and with which validation outcome.

## Triage

1. **Scope the event.** Collect the correlation ids, tenant, case ids, author or source of the flagged content and the time window. Do **not** copy case text into tickets; reference ids.
2. **Who introduced it?** An external party inside a customer message, an internal user pasting content, or an automated source? Intent matters for the response (hostile user versus innocent copy-paste of a forwarded phishing mail).
3. **What did the model produce and what was stored?** For each affected case, list the model executions and their validation results (`schemaValid`, `citationsValid`, `policyValid`, `temporalValid`). Anything persisted must have passed all four; check that flagged cases were quarantined and not analysed, or analysed with the injection neutralised.
4. **Skill poisoning check.** Find skills extracted, mutated or proposed from affected cases (skill lifecycle history and audit). Confirm none was published without a distinct approver; confirm no skill text contains instructions to the model.
5. **Audit integrity.** Run `GET /api/v1/audit/verify` (permission `audit:read`); a broken hash chain is a separate, higher-severity incident.
6. **Exfiltration signs.** Outputs that embed links or encoded data; outbound requests from the API to unexpected hosts (the API should call only its configured Azure endpoints); unusual Azure OpenAI request patterns.

## Mitigation

1. **Contain without destroying evidence.** Keep the case data and audit entries (legal hold: governance `retention.legalHold`), do not delete cases or logs.
2. **Stop the source.** If an internal user is responsible: remove their app role in Entra or disable the account, and notify security/HR per your process. If external content: block or quarantine the source case; ask the tenant owner to review.
3. **Stop propagation.** If any skill might be affected, retire or roll back the skill through the lifecycle (requires `skill_curator` and a distinct approver); pause skill mutation by disabling the `skillMutation` feature flag in governance settings (administrator) until reviewed.
4. **Reduce blast radius and cost.** Lower per-agent token budgets and `RATE_LIMIT_AI_MAX`, or temporarily switch to the deterministic provider (see [ai-provider-unavailable](ai-provider-unavailable.md)) for the affected tenant's workload window.
5. **Escalate** to the security owner; if customer data of a tenant may have been disclosed, start the privacy process.

## Recovery

- Re-run analyses for affected cases after the injected content is neutralised or excluded; artefact ids are deterministic so re-runs replace outputs and keep reviews.
- Reviewers re-validate any evidence classifications or recommendations created during the window; record corrections as new reviewed records (originals are preserved).
- Re-enable the paused features once reviewed.

## Verification

- No new `injection.flagged` bursts from the same source; validator rejections back to baseline.
- The affected skills are retired, rolled back or re-approved by a distinct approver; `GET /api/v1/audit/verify` passes.
- Reviewers confirm outputs for the sampled affected cases are grounded in real, in-window evidence.

## Follow-ups

- Add the new pattern to the detector with a regression test (`security: prompt injection in case notes`); keep a corpus of real (synthetic-ised) examples.
- Implement Azure AI Content Safety Prompt Shields (roadmap) and consider an allow-listed outbound policy for the API.
- Per-identity AI rate limits (a shared in-memory limiter is per replica, docs/ASSUMPTIONS.md A-13: use a shared store before scaling out).
- Tabletop-test this runbook with synthetic hostile content; update thresholds and ownership.
