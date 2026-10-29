-- 0007_search_and_identity_sync: full-text search over case content, and the users e-mail index that
-- Entra just-in-time provisioning needs.
--
-- SEARCH (SearchRepository)
--  * Cases, case events, claims, hypotheses, skills and warnings each get a STORED generated column
--    search_tsv (a weighted tsvector, text search configuration 'english') and a GIN index on it.
--    PostgreSQL maintains the column on every INSERT/UPDATE, so no application code (and no trigger)
--    has to keep an index in step, and rows that already exist are backfilled when this runs.
--  * Weights encode the ranking order title (A) > label / tag / key (B) > body (C); ts_rank uses them.
--  * Every text is cut with left() before it is indexed. to_tsvector() raises "string is too long for
--    tsvector" above 1 MiB of lexemes, and an oversized event body must never make an INSERT fail.
--  * The expressions use only IMMUTABLE functions (required for generated columns). array_to_string()
--    is only STABLE, so tags go through the small caseguard_text_array() wrapper below.
--  * Changing a search_tsv expression later means a migration that drops and re-adds the column and
--    its index: PostgreSQL does not recompute stored values when an expression is edited.
--  * The GIN indexes cover the text only, not tenant_id (that needs the btree_gin extension, which is
--    not available everywhere). Tenant isolation does not depend on them: the query always filters by
--    tenant_id and row-level security applies on top.
--  * ROW-LEVEL SECURITY AND THESE INDEXES: the @@ operator is not LEAKPROOF, and PostgreSQL does not
--    use a non-leakproof condition as an index condition on a table whose rows are filtered by a
--    policy. For the application role (always subject to the policy) the search statement therefore
--    reads the tenant's rows through the tenant_id indexes and tests search_tsv @@ query on each
--    stored vector. That is still correct and tenant-safe; measured on PGlite it takes about 50 ms
--    for 20,000 cases. The GIN indexes serve sessions that bypass RLS (superuser, admin tooling) and
--    become effective for the application role if a superuser marks the operator's function
--    leakproof: ALTER FUNCTION ts_match_vq(tsvector, tsquery) LEAKPROOF (verified on PGlite). That
--    edits pg_catalog, is unavailable on managed PostgreSQL and is deliberately not done here.
--
-- USERS
--  * users_tenant_email_uq (unique per tenant) is replaced by a plain index. Identity providers do
--    not guarantee unique e-mail addresses (Entra's `mail` attribute is neither unique nor verified,
--    and one person often holds two accounts that share it) and some accounts have none at all, which
--    is stored as ''. A unique index made a legitimate first sign-in fail with a 409. Accounts are
--    identified by id (the Entra object id), never by e-mail; the index only supports look-ups.

CREATE FUNCTION caseguard_text_array(items text[]) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT pg_catalog.array_to_string(items, ' ') $$;

-- Title and reference identify a case (A); tags are labels (B).
ALTER TABLE cases ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('english', left(coalesce(title, ''), 2000)), 'A') ||
  setweight(to_tsvector('english', left(coalesce(reference, ''), 200)), 'A') ||
  setweight(to_tsvector('english', left(coalesce(caseguard_text_array(tags), ''), 2000)), 'B')
) STORED;
CREATE INDEX cases_search_idx ON cases USING gin (search_tsv);

-- Event titles outrank bodies (C). Bodies are redacted before they are stored.
ALTER TABLE case_events ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('english', left(coalesce(data ->> 'title', ''), 2000)), 'A') ||
  setweight(to_tsvector('english', left(coalesce(data ->> 'body', ''), 100000)), 'C')
) STORED;
CREATE INDEX case_events_search_idx ON case_events USING gin (search_tsv);

-- The claim statement and its subject are the label (B); the classifier's explanation is secondary (C).
ALTER TABLE claims ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('english', left(coalesce(data ->> 'text', ''), 2000)), 'B') ||
  setweight(to_tsvector('english', left(coalesce(subject, ''), 200)), 'B') ||
  setweight(to_tsvector('english', left(coalesce(data ->> 'explanation', ''), 2000)), 'C')
) STORED;
CREATE INDEX claims_search_idx ON claims USING gin (search_tsv);

-- Hypothesis name is its label (A); the knowledge-pack key is B; the description is C.
ALTER TABLE hypotheses ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('english', left(coalesce(name, ''), 500)), 'A') ||
  setweight(to_tsvector('english', left(coalesce(key, ''), 200)), 'B') ||
  setweight(to_tsvector('english', left(coalesce(data ->> 'description', ''), 5000)), 'C')
) STORED;
CREATE INDEX hypotheses_search_idx ON hypotheses USING gin (search_tsv);

-- Skill name is A; key, workload and product act as its tags (B); the description is C.
ALTER TABLE skills ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('english', left(coalesce(name, ''), 500)), 'A') ||
  setweight(to_tsvector('english', left(
    coalesce(key, '') || ' ' || coalesce(workload, '') || ' ' || coalesce(product, ''), 1000)), 'B') ||
  setweight(to_tsvector('english', left(coalesce(data ->> 'description', ''), 5000)), 'C')
) STORED;
CREATE INDEX skills_search_idx ON skills USING gin (search_tsv);

-- Warning title is A, its message is C. Only open warnings are searchable, so the index is partial:
-- the search query repeats `state = 'open'` literally, which lets the planner use it.
ALTER TABLE case_warnings ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('english', left(coalesce(data ->> 'title', ''), 1000)), 'A') ||
  setweight(to_tsvector('english', left(coalesce(data ->> 'message', ''), 5000)), 'C')
) STORED;
CREATE INDEX case_warnings_search_idx ON case_warnings USING gin (search_tsv) WHERE state = 'open';

-- Look-up by e-mail (non-empty addresses only); deliberately not unique, see the header.
DROP INDEX users_tenant_email_uq;
CREATE INDEX users_tenant_email_idx ON users (tenant_id, lower(email)) WHERE email <> '';

-- Just-in-time provisioning (GovernanceRepository.upsertIdentityUser) inserts users as the application
-- role, which until now could only read and update them. The WITH CHECK of the tenant policy still
-- confines every inserted row to the caller's own tenant.
GRANT INSERT ON users TO caseguard_app;
