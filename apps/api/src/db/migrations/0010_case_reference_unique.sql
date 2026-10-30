-- 0010_case_reference_unique: one case per reference within a tenant.
--
-- The reference is what people quote ("CG-SYN-1001"). Until now only the ingest service guarded it, by
-- reading a bounded page of recent cases, so a reference could be reused in a large workspace and two
-- concurrent ingests could both pass the check. The database is the one place that can settle it.
-- Comparison is exact (case-sensitive), as the service's check always was.
--
-- An existing database that already holds two cases with the same reference in one tenant cannot take
-- the constraint: this migration then fails with SQLSTATE 23505 on cases_tenant_reference_uq and nothing
-- from it is applied (it runs in one transaction). List the pairs with
--   SELECT tenant_id, reference, count(*) FROM cases GROUP BY 1, 2 HAVING count(*) > 1;
-- rename or erase all but one case of each, and run the migration again.
ALTER TABLE cases ADD CONSTRAINT cases_tenant_reference_uq UNIQUE (tenant_id, reference);

-- The unique index serves the exact lookup by (tenant, reference), which the plain index of 0003 did.
DROP INDEX cases_reference_idx;
