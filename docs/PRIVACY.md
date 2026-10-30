# Privacy

CaseGuard AI is a prototype for **synthetic data only**. This document states what the code stores and where, what controls
exist to keep real personal data out, what leaves the process, and what is **not** implemented. It describes behaviour that
was read in the code; where something is only designed or configured but not enforced, it says so.

Related: [SECURITY.md](SECURITY.md), [DATA_MODEL.md](DATA_MODEL.md), [AI_ORCHESTRATION.md](AI_ORCHESTRATION.md),
[RESPONSIBLE_AI.md](RESPONSIBLE_AI.md).

## 1. Summary

| Question                                          | Answer                                                                                                                                                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Is real customer or employee data intended?       | **No.** The product, the seed data, the examples and the UI notices all state that every case, person and organisation is synthetic.                                                                             |
| Is that enforced?                                 | Partly: a tenant flag refuses payloads that declare `"synthetic": false`; redaction removes secrets and common personal-data patterns. A payload that declares `true` is **self-attested**; nothing verifies it. |
| Does any data leave the process by default?       | **No.** The default AI provider is the offline deterministic engine, search is local PostgreSQL full-text, storage is the local disk, and no telemetry export is wired.                                          |
| Is customer data used to train a model?           | **No code path trains, fine-tunes or evaluates a model on stored data.** By default no model is called at all. See section 6 for the Azure OpenAI caveat.                                                        |
| Are there retention controls?                     | Per-case erasure by an administrator is implemented. Retention windows are stored in settings but **no job enforces them**.                                                                                      |
| Are data-subject requests supported?              | **No.** There is no per-person search, export or deletion; erasure works per case.                                                                                                                               |
| Has this been reviewed by a privacy professional? | No.                                                                                                                                                                                                              |

## 2. Data inventory

| Data                            | Where                                                                                                                                                      | What it contains                                                                                                                                                                                                                                                                                                             | Controls                                                                                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Case record                     | `case_sources`, `case_participants`, `case_events`, `case_resolutions`                                                                                     | Event titles and bodies (already **redacted**), participant **aliases** and roles (no display names are stored; synthetic data is fictional), resolution text                                                                                                                                                                | Immutable (triggers); tenant isolation; erased with the case                                                                                              |
| Redacted source payload         | `case_sources.payload` and the object store key `<tenant>/<case>/<source>.json` (local disk `.data/objects` by default; Azure Blob is the deployed option) | The canonical JSON of the redacted case bundle; **the original upload is never stored**                                                                                                                                                                                                                                      | Tenant-prefixed; deleted when the case is erased (the mirrored object is deleted by the service)                                                          |
| Derived analysis                | Evidence, claims, hypotheses, actions, forks, scenarios, quality, metrics, warnings, coaching tables                                                       | Excerpts (at most 280 characters) and statements taken from case text, scores and labels                                                                                                                                                                                                                                     | Erased with the case                                                                                                                                      |
| SkillDNA                        | `skills`, versions, approvals, matches                                                                                                                     | Generalised procedures, triggers and the ids of source cases (the case reference)                                                                                                                                                                                                                                            | **Not removed** when a source case is erased; the library is tenant data of its own                                                                       |
| AI execution records            | `model_executions`, `token_usage`                                                                                                                          | Agent, prompt version and hash, input hash, status, validation outcome in our own wording, token counts, latency. **No prompt, no model output** (`retainContent` is not enabled by the API)                                                                                                                                 | Erased with the case; no retention job                                                                                                                    |
| Audit events                    | `audit_events`                                                                                                                                             | Actor id, action, target ids, counters. **No case text** (ids, counts and enums only)                                                                                                                                                                                                                                        | Append-only; **never deleted**, even when a case is erased                                                                                                |
| Idempotency records             | `idempotency_keys`                                                                                                                                         | A hash of the request and the stored response (up to 1 MiB) for 24 hours; the response may contain case-derived data                                                                                                                                                                                                         | Expires after 24 hours; deleted on demo reset                                                                                                             |
| Jobs                            | `jobs`                                                                                                                                                     | Kind, status, stages, error text (our own wording)                                                                                                                                                                                                                                                                           | Erased with the case                                                                                                                                      |
| Users and tenants               | `users`, `tenants`                                                                                                                                         | Display name, e-mail, roles, status. Seeded synthetic personas locally. **With Entra, the first sign-in creates a `users` row just in time** (display name and e-mail from the token, the mapped roles, `synthetic=false`) and refreshes it at most every 5 minutes; the object id also appears as `created_by` / `actor_id` | Listed only by `governance:read` (administrator); a stored `disabled` user is refused; **the application role cannot delete user rows and no route does** |
| Governance settings and prompts | `governance_settings`, `prompt_versions`                                                                                                                   | Redaction, retention, model, export settings; prompt versions                                                                                                                                                                                                                                                                | Versioned and audited                                                                                                                                     |
| In-process caches               | API process memory                                                                                                                                         | AI semantic cache (validated outputs derived from redacted context, TTL 1 hour, 500 entries, per tenant), recomputed-analysis LRU, job queue, rate-limit counters                                                                                                                                                            | Lost on restart; never written to disk                                                                                                                    |
| Logs                            | stdout as JSON lines                                                                                                                                       | Request metadata (route pattern, status, duration, ids). **Case content, prompts and model output are never logged**; four-layer redaction                                                                                                                                                                                   | Retention is whatever the log sink does; no sink is configured by this repo                                                                               |
| Browser state                   | Browser                                                                                                                                                    | Dev persona id (`localStorage` and a Strict cookie), MSAL tokens in `sessionStorage`, UI preferences                                                                                                                                                                                                                         | Cleared by the user; not server-side                                                                                                                      |

Not stored: raw uploads, passwords, API keys, prompts, raw model output, search queries (the global search text is never logged,
audited or used as a metric label).

## 3. Keeping real data out (synthetic-data policy)

The policy has four layers; none of them can prove that a payload is fictional.

1. **Product framing.** The session endpoint adds the notice "All data in this environment is synthetic. No real customer data is
   processed." when the tenant or user is synthetic, and the UI shows it. The exact notices are `SYNTHETIC_DATA_NOTICE`
   ("All case data, people and organisations in this environment are synthetic and for demonstration only.") and
   `SYNTHETIC_EFFECTIVENESS_NOTICE` in `packages/schemas/src/metrics.ts`.
2. **Tenant flag.** A tenant flagged `synthetic` (every seeded tenant) **refuses** a payload that declares `"synthetic": false`
   with the message "This workspace accepts synthetic data only…". Pasted text and CSV carry no label and inherit the tenant's.
3. **Self-attestation.** A bundle that declares `"synthetic": true` is accepted. The refusal message, the JSON schema description
   ("Demo bundles must set `"synthetic": true`") and the ingestion notes tell users to set it only when every organisation,
   person, address and incident is fictional. Nothing checks this.
4. **Redaction as a safety net** (section 4). It runs on every ingestion whatever the label.

A tenant provisioned by an operator as **not** synthetic can ingest real data; it is then redacted harder (reserved test values
too) and stored labelled `synthetic=false`. No such tenant is seeded and no operator tooling exists for creating one.

## 4. Redaction

`redactText` / `redactValue` run on every string of a case at ingestion, **before** anything is persisted, and again on every
piece of text before it enters a model prompt.

| Category                                                                                                                         | Notes                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `bearer_token`, `api_key`, `connection_string`, `private_key`, `password_assignment`, `jwt`, `github_token`, `azure_storage_key` | **Secret categories: always on.** Governance settings cannot disable them.                     |
| `email_address`, `ipv4_address`, `phone_number`                                                                                  | Personal-data categories: on by default, can be narrowed per tenant in the `redaction` setting |
| `custom`                                                                                                                         | Tenant patterns; validated for compilation and backtracking, executed in a `node:vm` sandbox   |

- Replacements are placeholders such as `[REDACTED:<category>]`, **pseudonymised per case** (the same address gets the same
  number everywhere in the case), so the analysis can still tell two people apart.
- Reserved and synthetic values (example domains, private IP ranges) are left alone in synthetic data and redacted in data that
  is declared real.
- Only counts per category are stored (`RedactionSummary`), never the matched text.
- **Model calls.** The context builder redacts again (secret masker plus the security package) and collapses whitespace. The
  `redaction.redactBeforeModelCalls` governance setting (default true) exists, but **no code reads it**: redaction of model
  context is unconditional.

**Limits.** Redaction is pattern-based. It does not recognise names, postal addresses, free-text personal facts, employee ids,
or context-dependent secrets. A document that merely "looks fine" can still contain personal data. Treat redaction as a
safety net for accidents, not as anonymisation. An upload is also screened for prompt injection; that is a security control,
not a privacy one ([SECURITY.md](SECURITY.md#74-prompt-injection)).

## 5. What can leave the process

| Destination          | When                              | What is sent                                                                                                                                                             | Status                                                                           |
| -------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Nothing              | Default configuration             | -                                                                                                                                                                        | The deterministic provider, local storage and local search run in-process        |
| Azure OpenAI         | `AI_PROVIDER=azure-openai`        | A minimised, **redacted** prompt for one agent task: events, evidence summaries and pack knowledge limited to one case and one time window; strict JSON schema; no tools | Implemented, **validated against a local mock only**; no real call was ever made |
| Azure AI Search      | `SEARCH_PROVIDER=azure-ai-search` | The query text and a tenant filter. **Documents are not pushed by this code**; the index must be filled outside the API with already-redacted content                    | Mock-validated                                                                   |
| Azure Blob Storage   | `STORAGE_PROVIDER=azure-blob`     | The redacted case payload under the tenant prefix                                                                                                                        | Mock-validated                                                                   |
| Microsoft Entra ID   | `AUTH_MODE=entra`                 | The browser signs in; the API fetches public signing keys (JWKS). Tokens carry the user's `oid`, name and e-mail                                                         | Mock-validated                                                                   |
| Application Insights | Configuration only                | **Nothing.** The connection string is parsed but no exporter is started ([OBSERVABILITY.md](OBSERVABILITY.md))                                                           | Not wired                                                                        |

No analytics, advertising or tracking SDK is a dependency of `apps/web` (searched `package.json` and `src`), and the nonce CSP
would block an injected third-party script.

## 6. No training on customer data

- No code in this repository trains, fine-tunes, distils or evaluates a model on stored data. SkillDNA is **not** model
  training: it is a governed, human-approved procedure derived from a case by deterministic code.
- With the default provider no model is called, so there is no model provider that could see data.
- If Azure OpenAI is connected, prompts leave the process to the configured Azure OpenAI resource. What that service does with
  prompts (abuse monitoring, retention, any training use) is governed by your Azure agreement and the service configuration,
  **which this repository neither controls nor verifies**. Review it before sending any real data; the project has not.
- The evaluation harness ([EVALUATION.md](EVALUATION.md)) uses only the two synthetic cases shipped in `synthetic-data/`.

## 7. Retention, erasure and deletion

| Capability                                                                                                         | State                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Erase one case                                                                                                     | **Implemented.** `DELETE /api/v1/cases/:caseId` (administrator, `case:delete`): cascades through the case record and every derived artefact, deletes the mirrored object, writes a counts-only audit event; refused while a job runs                                                                                             |
| Demo reset                                                                                                         | Implemented: removes cases, skills, jobs, usage, executions, reviews, idempotency keys and demo state for one tenant; keeps tenants, users, settings, prompts and audit                                                                                                                                                          |
| Retention windows (`caseDataDays` 365, `auditDays` 730, `modelExecutionDays` 90, `analyticsDays` 365, `legalHold`) | **Stored and shown, not enforced.** No job reads them; nothing is deleted when a window passes                                                                                                                                                                                                                                   |
| Erase derived SkillDNA when a source case is erased                                                                | Not implemented; skills keep the source case reference                                                                                                                                                                                                                                                                           |
| Delete or anonymise a stored user                                                                                  | Not implemented. Entra sign-ins create user rows (display name, e-mail) and the application role has no `DELETE` privilege on `users`; demo reset and case erasure keep users                                                                                                                                                    |
| Audit events                                                                                                       | Never deleted (they carry ids and counts, not content); the hash chain depends on it                                                                                                                                                                                                                                             |
| Export                                                                                                             | `POST /api/v1/governance/export` (administrator, `export:data`): case export (redacted record, hashes, participants, events, resolution, reviewer decisions) and audit export; both can be switched off in settings (`allowCaseExport`, `allowAuditExport`; default on), refused above `maxRecordsPerExport` (5,000) and audited |
| Backups and restore                                                                                                | Not implemented                                                                                                                                                                                                                                                                                                                  |
| Data-subject access, rectification, objection                                                                      | Not implemented                                                                                                                                                                                                                                                                                                                  |
| Data residency                                                                                                     | Designed only: the Azure template takes a location parameter; nothing was deployed                                                                                                                                                                                                                                               |

## 8. People in the data

- Participants in a case are fictional in synthetic data. In real data they would be employees and customer contacts.
- The product **does not rank, score or profile individuals**: quality scores describe the written record of one case, analytics
  are portfolio aggregates with no names, and coaching is supportive ([RESPONSIBLE_AI.md](RESPONSIBLE_AI.md)).
- Audit events and `created_by` columns do record **which user did what** (an id, not free text). That is intentional
  accountability; it is also personal data about the users of the system. In Entra mode the user list additionally holds each
  signed-in user's display name and e-mail address as taken from the token, and nothing deletes them (see section 7). The
  Entra path itself, including this provisioning, has been tested against the repository only, not a live tenant.

## 9. If you want to use real data (do not, without this work)

1. Provision a non-synthetic tenant and review the stricter redaction behaviour.
2. Replace the pattern-based redaction with a proper PII detection service for your data and languages.
3. Implement retention enforcement, subject-rights tooling, backups and an incident process.
4. Run the Entra and Azure paths against real services and review the Azure OpenAI data terms.
5. Complete a privacy impact assessment and legal review.

None of this is done.

## 10. Where each statement is evidenced

Code locations and tests behind the main statements above. The package suites were run for [EVALUATION.md](EVALUATION.md#2-test-inventory)
and passed; the database-backed API tests named below were **not** run by me.

| Statement                                                                    | Code and tests                                                                                                                                                  |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Redaction happens before storage and before prompts                          | `packages/security/src/redaction/*` with `packages/security/test/redaction*.test.ts` (including property tests); ingestion in `apps/api/src/services/ingestion` |
| Only the redacted payload is stored; the original upload is not              | `apps/api/src/services/ingestion/persist.ts` (`storedPayload` is the redacted, canonical text; it is what the object store and `case_sources.payload` receive)  |
| Logs carry no case content, prompts or secrets                               | Four-layer redaction: `packages/observability/test/redaction.value.test.ts`, `redaction.text.test.ts`, `redaction.property.test.ts`, `logger.test.ts`           |
| A case can be erased with every derived row and its stored object            | `apps/api/test/cases.int.test.ts` (`cases.delete`, `[FR-ING-07]`), `immutability.int.test.ts` (the erasure setting)                                             |
| The audit trail survives erasure and holds no free text                      | `immutability.int.test.ts` (erasure never deletes audit events), `skills.int.test.ts` (audit events with no free text), `audit-chain.int.test.ts`               |
| The global search text is never logged, audited or used as a metric label    | `apps/api/test/search-global.int.test.ts` (`never logs or audits the query`)                                                                                    |
| Entra sign-ins create user rows (display name, e-mail); nothing deletes them | `apps/api/test/identity-sync.int.test.ts`, `identity-users.int.test.ts`; privileges in migrations 0002 and 0007 (`users`: select, update, insert)               |
| No model is called by default; nothing is sent anywhere                      | `packages/ai/test/deterministic-provider.test.ts`; `AI_PROVIDER=deterministic` is the default in `packages/config`                                              |
| Retention windows are stored but not enforced                                | `caseDataDays` and the other windows appear only in the settings schema and its defaults (`packages/schemas/src/governance.ts`); no job or service reads them   |
