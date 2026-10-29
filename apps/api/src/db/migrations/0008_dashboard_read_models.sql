-- 0008_dashboard_read_models: indexes for the tenant-wide command-center lists
-- (AnalysisRepository.listOpenWarnings and listCriticalMissing).
--
-- Both lists ask for the items that are still OPEN across every case of a tenant, and in steady state
-- most warnings end up dismissed or resolved and most missing evidence gets supplied. A partial index
-- keeps the work proportional to what is open instead of to everything a tenant ever raised. The
-- conditions in the partial predicates (state = 'open', resolved_at IS NULL) are repeated literally by
-- the queries, which is what lets the planner use them, and they use only leakproof operators, so they
-- also serve the application role under row-level security (unlike the full-text indexes of 0007).
-- Measured on PGlite with 20,000 warnings and 12,000 missing-evidence items in one tenant: the open
-- warnings list went from 7.6 ms to 4.1 ms and the missing-evidence list from 8.7 ms to 6.6 ms, and the
-- gap widens with the size of the tenant. AnalysisRepository.summarize and CaseRepository.counts read
-- through primary-key and existing indexes and need nothing new (about 11 ms for 200 cases and 6 ms for
-- 4,000 cases).

-- Open warnings of a tenant, newest first (the list is ranked by priority, then raised_at).
CREATE INDEX case_warnings_open_idx ON case_warnings (tenant_id, raised_at DESC, id) WHERE state = 'open';

-- Unresolved missing evidence of a tenant, most recently relevant first.
CREATE INDEX missing_evidence_open_idx ON missing_evidence (tenant_id, first_relevant_at DESC, id) WHERE resolved_at IS NULL;
