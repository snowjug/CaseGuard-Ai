# Governance services

Routes: `governance.get`, `governance.update`, `governance.prompts`, `governance.users`,
`governance.assignRoles`, `governance.audit`, `governance.auditVerify`, `governance.reviews`,
`governance.export` (see `routes/governance.ts`, which only maps HTTP to these functions).

## Reading the governed configuration (for other services)

```ts
import { getGovernanceValue, getGovernanceValues, getGovernanceSettings } from '../governance';

const controls = await getGovernanceValue(ctx, 'export_controls'); // typed per section
const { redaction, retention, model } = await getGovernanceValues(ctx);
const settings = await getGovernanceSettings(ctx); // values plus version, updatedAt, updatedBy, changeNote
```

Services only read; the only writer is `updateGovernanceSection`. The `version` label inside a value (for
example `quality.version`) is chosen by whoever edits the section; record the section's integer `version`
next to it when a result must be reproducible.

| Section           | Safety-relevant settings                                        | Enforced by                                                                       |
| ----------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `export_controls` | `allowCaseExport`, `allowAuditExport`, `maxRecordsPerExport`    | `exportData` (403 when off, 409 above the cap)                                    |
| `redaction`       | `enabledCategories`, `customPatterns`, `redactBeforeModelCalls` | ingestion and model calls must read it; secret categories cannot be disabled here |
| `retention`       | `caseDataDays`, `auditDays`, `modelExecutionDays`, `legalHold`  | **stored and shown only; no job enforces retention yet**                          |
| `model`           | token, retry, timeout and cost limits, per-agent budgets        | the AI layer must read it                                                         |

## Updating settings (`updateGovernanceSection`)

`value` is validated with the section schema from `@caseguard/schemas` (422, paths like
`body.value.maxRecordsPerExport`), keys the schema does not know are refused instead of dropped, and a few
rules the schemas cannot express apply: secret redaction categories must stay enabled, custom redaction
patterns must compile and pass the backtracking probe, quality bands must strictly descend, and
`agentBudgets` may only name existing agents. A stale `expectedVersion` is a 409. The new version and its
audit event commit in one transaction.

## Audit actions written here

Audit `details` are ids, counters and enums only; free text (`changeNote` is stored with the setting; the
`reason` of a role change or export is validated but **not** copied into the audit event).

| Action                        | Outcome | Details                                                                  |
| ----------------------------- | ------- | ------------------------------------------------------------------------ |
| `governance.settings.updated` | success | `{ section, fromVersion, toVersion, changedKeys }` (paths, never values) |
| `roles.assigned`              | success | `{ userId, fromRoles, toRoles, fromVersion, toVersion }`                 |
| `roles.assigned`              | denied  | `{ userId, reason: 'last_administrator' \| 'entra_managed' }`            |
| `export.created`              | success | `{ scope, caseId, recordCount }`                                         |
| `export.created`              | denied  | `{ scope, caseId, recordCount, denialReason }`                           |

`denialReason` is `case_export_disabled`, `audit_export_disabled`, `record_cap_exceeded`, or `case_not_found`
(an unknown case, or another tenant's id: the attempt is recorded in the caller's own trail and answered
with the same 404 as any missing case).

Reading the audit log (`governance.audit`) and the user list (`governance.users`) is itself audited by the
route binder (`api.governance.audit`, `api.governance.users`).

## Roles

In Entra mode roles come from token claims, so `governance.assignRoles` answers 409. Otherwise the change
needs the user's current `version`, keeps at least one active administrator, and writes its audit event in
the same transaction as the update. The audit append is done first on purpose: on PostgreSQL it takes the
tenant's audit-chain advisory lock, which serialises concurrent role changes of one tenant so the
administrator count cannot be invalidated in parallel (reasoned, not exercised on PostgreSQL in this build).

## Export

`exportData` writes `export.created` before returning any data, refuses (never truncates) above the record
cap, masks credentials once more on the way out, and never reads the raw upload back. The case export holds
the redacted case record, source attestation (hashes, no object key), participants, events, resolution and
reviewer decisions; derived analysis is not included. The audit export holds the tenant's chain, the
verification result, the genesis hash, the hash recipe and the head, so an auditor can re-verify it.
