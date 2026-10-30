-- 0012_review_target_type_idx: listing review decisions of one target type.
--
-- ReviewRepository.list can be narrowed to one target type (claim, action_value, ...), on its own or
-- within one case, newest first with keyset pagination. The indexes before this one cannot serve that:
-- review_decisions_target_idx has (tenant, target_type) as a prefix but is ordered by target_id, so the
-- tenant-wide list had to read and sort every decision of the type, again for every page; and the case
-- index reads all the decisions of a case to filter them. Measured on PGlite as the application role
-- (30,000 decisions in a tenant, about 700 bytes each, 100 per case):
--   tenant + type, 427 matches:  14.7 ms, 412 buffers, sort  ->  0.4 ms, 54 buffers, no sort
--   case + type, 5 matches:      103 buffers                 ->  8 buffers
-- Reviews are written by people, so the extra index maintenance on insert is negligible.

-- Newest-first decisions of one type across the tenant.
CREATE INDEX review_decisions_type_idx ON review_decisions (tenant_id, target_type, decided_at DESC, id DESC);

-- Newest-first decisions of one type within a case (how the action-value overrides of a case are loaded).
CREATE INDEX review_decisions_case_type_idx ON review_decisions (tenant_id, case_id, target_type, decided_at DESC, id DESC) WHERE case_id IS NOT NULL;
