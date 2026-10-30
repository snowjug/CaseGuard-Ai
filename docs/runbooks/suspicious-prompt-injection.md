# Runbook: suspicious prompt injection

Case text is **untrusted data**. Prompt injection means content (a customer e-mail, a note, an uploaded log) that tries to instruct the model ("ignore previous instructions...") or smuggle instructions into prompts, skills or outputs.

> Not exercised against a live deployment. See the [honesty note](README.md). The detector is heuristic and can be evaded; Azure AI Content Safety _Prompt Shields_ is a roadmap item and is **not implemented** (docs/THREAT_MODEL.md section 5). A quiet dashboard is therefore not proof of absence.

## Symptoms

- A burst of flagged cases: `case.ingested` log lines with `injectionDetected: true` (also the in-process counter `caseguard_prompt_injection_flags_total`), concentrated on one tenant, user or source. No log event named `injection.flagged` exists (see the planned-events list in [OBSERVABILITY.md](../OBSERVABILITY.md)).
- Model executions ending `rejected_by_validation` at an unusual rate (schema, citation, policy or temporal checks refusing outputs).
- Reviewers report recommendations that ignore the case, reference non-existent evidence, or contain instructions addressed to "the AI".
- Unusual skill proposals (SkillDNA extraction or mutation), or token spikes on specific cases.
- Case content or model output containing URLs, credentials-looking strings, or requests to disable safeguards.

## Impact

- **Integrity risk** (the main one): poisoned analysis or a poisoned skill that propagates bad advice. Controls limit it: instructions and data are structurally separated, the model has **no tools**, outputs are schema/citation/policy validated before they are used, skills are never auto-published and need a distinct approver, and every action is audited. In the committed build the deterministic engine, not the model, produces every stored analysis artefact: model proposals are validated and recorded but not merged, except that a model-supplied rationale text may be shown on a counterfactual step ([AI_ORCHESTRATION.md](../AI_ORCHESTRATION.md) section 8).
- **Cost**: token flooding (see [excessive-token-use](excessive-token-use.md)).
- **Confidentiality**: unlikely through the model alone (no tools, tenant-scoped retrieval, redaction before prompts), but a successful injection could surface other content from the same case in an output.

## Detection

```kusto
// Flagged cases per tenant (the flag is set at ingestion; it does not block the case)
CgApiLogs()
| where TimeGenerated > ago(24h) and event == 'case.ingested' and injectionDetected == true
| summarize flagged = count(), firstSeen = min(TimeGenerated), lastSeen = max(TimeGenerated), sampleRequestId = take_any(requestId) by tenantId, bin(TimeGenerated, 1h)
| order by flagged desc
```

```kusto
// Validator rejections by agent: a sudden rise can mean crafted content is steering outputs
CgApiLogs()
| where TimeGenerated > ago(24h) and event == 'ai.model.execution' and execStatus == 'rejected_by_validation'
| summarize rejections = count() by agent, bin(TimeGenerated, 1h)
| render columnchart
```

```kusto
// Model tasks that saw injection indicators in their input
CgApiLogs()
| where TimeGenerated > ago(24h) and event == 'ai.model.execution' and injectionIndicators > 0
| summarize tasks = count(), maxIndicators = max(injectionIndicators) by tenantId, agent
| order by tasks desc
```

Application views: the audit log (`GET /api/v1/audit`, permission `audit:read`) and the model-execution list (`GET /api/v1/model-executions`, `telemetry:read`) show what ran and with which validation outcome.

## Triage

1. **Scope the event.** Collect the request ids (`requestId`), tenant, case ids, author or source of the flagged content and the time window. Do **not** copy case text into tickets; reference ids.
2. **Who introduced it?** An external party inside a customer message, an internal user pasting content, or an automated source? Intent matters for the response (hostile user versus innocent copy-paste of a forwarded phishing mail).
3. **What did the model produce and what was stored?** For each affected case, list the model executions and their validation results (`schemaValid`, `citationsValid`, `policyValid`, `temporalValid`). Flagged cases are **not** quarantined: the evidence is stored, shown and analysed, and the AI context marks the flagged event `possible_prompt_injection` and wraps case text as untrusted data. Check the `status` and `source` of each execution (a `rejected_by_validation` or fallback result means the deterministic answer was used instead).
4. **Skill poisoning check.** Find skills extracted, mutated or proposed from affected cases (skill lifecycle history and audit). Confirm none was published without a distinct approver; confirm no skill text contains instructions to the model.
5. **Audit integrity.** Run `GET /api/v1/audit/verify` (permission `audit:read`); a broken hash chain is a separate, higher-severity incident.
6. **Exfiltration signs.** Outputs that embed links or encoded data; outbound requests from the API to unexpected hosts (the API should call only its configured Azure endpoints); unusual Azure OpenAI request patterns.

## Mitigation

1. **Contain without destroying evidence.** Keep the case data and audit entries and do not delete cases or logs. Note that `DELETE /api/v1/cases/:caseId` (`case:delete`, administrator) erases a case and its derived data, and the governance `retention.legalHold` flag is stored but **not enforced** by any code ([PRIVACY.md](../PRIVACY.md)), so a hold is a process decision, not a technical control.
2. **Stop the source.** If an internal user is responsible: remove their app role in Entra or disable the account, and notify security/HR per your process. If external content: there is no quarantine state, so agree with the tenant owner whether to leave the case as is, export it for review and then delete it, or stop re-running its analysis.
3. **Stop propagation.** If any skill might be affected, retire or roll back the skill through the lifecycle (retire needs `skill:retire`, rollback `skill:rollback`; a version approval needs a distinct approver). There is no server-side switch for skill mutation: the governance `skillMutation` feature flag is stored and shown but nothing reads it, so control mutation by role (remove `skill:mutate` by changing who holds the curator and administrator roles) until the review is done.
4. **Reduce blast radius and cost.** Lower per-agent token budgets and `RATE_LIMIT_AI_MAX`, or temporarily switch to the deterministic provider (see [ai-provider-unavailable](ai-provider-unavailable.md)) for the affected tenant's workload window.
5. **Escalate** to the security owner; if customer data of a tenant may have been disclosed, start the privacy process.

## Recovery

- Re-run analyses for affected cases after the injected content is neutralised or excluded; artefact ids are deterministic so re-runs replace outputs and keep reviews.
- Reviewers re-validate any evidence classifications or recommendations created during the window; record corrections as new reviewed records (originals are preserved).
- Restore any role assignments you changed for containment once the review is complete.

## Verification

- No new bursts of `case.ingested` lines with `injectionDetected: true` from the same source; validator rejections back to baseline.
- The affected skills are retired, rolled back or re-approved by a distinct approver; `GET /api/v1/audit/verify` passes.
- Reviewers confirm outputs for the sampled affected cases are grounded in real, in-window evidence.

## Follow-ups

- Add the new pattern to the detector with a regression test (`packages/security/test/injection.test.ts`); keep a corpus of real (synthetic-ised) examples.
- Implement Azure AI Content Safety Prompt Shields (roadmap) and consider an allow-listed outbound policy for the API.
- Per-identity AI rate limits (a shared in-memory limiter is per replica, docs/ASSUMPTIONS.md A-13: use a shared store before scaling out).
- Tabletop-test this runbook with synthetic hostile content; update thresholds and ownership.
