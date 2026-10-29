# ADR 0008: Append-only, hash-chained audit log with database immutability

- Status: Accepted
- Date: 2026-10-29
- Deciders: project owner and architect

## Context

Security-relevant actions and every AI action must be accountable (NFR-SEC-07, T4, T5): who did what, when, on
which case, and what the model proposed. A table that an administrator or a compromised application role can
quietly edit is not an audit log. Reviewer corrections must never overwrite the original AI classification.

## Decision

- **Append-only `audit_events` table per tenant with a hash chain.** Each event gets a per-tenant `sequence`
  (unique with the tenant id) and `hash = sha256(prev_hash || newline || canonical JSON of the event without its
hash)`. Altering or removing any event breaks every later hash.
- **A verification endpoint** recomputes the chain for a tenant and reports the first break; it is available to
  the roles that hold `audit:read`.
- **Database-level immutability.** A `BEFORE UPDATE OR DELETE` trigger rejects mutation, and it is enabled with
  `ENABLE ALWAYS` so it also fires under `session_replication_role = replica`. The application role has only
  `SELECT` and `INSERT` on the table. The immutable case tables (source, events, resolution) use the same
  mechanism, and RLS keeps a tenant's chain private (ADR 0003).
- **Corrections are new records.** Reviewer changes, approvals and model proposals are separate audited events;
  nothing is edited in place and there is no delete path.

## Consequences

- Good: tampering is both hard (privileges, triggers) and detectable (chain), and the evidence survives a
  compromised application role.
- Bad: a table owner or superuser can still disable the trigger or rewrite the whole chain; the chain only
  proves integrity if its latest hash is anchored somewhere else. Exporting or anchoring head hashes outside the
  database is a documented follow-up, not implemented.
- Bad: append-only growth needs a retention and archival policy that respects the chain, and strict ordering
  makes a very high write rate on a single tenant a contention point.

## Alternatives considered

- **Plain audit table with application-level discipline:** no protection against privileged edits.
- **External immutable store (ledger database, WORM blob storage):** stronger guarantees, but another service
  to deploy and secure; compatible as a later anchor for the chain.
- **Logging only:** logs are not queryable per case and are not tamper-evident.
