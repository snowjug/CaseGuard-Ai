-- 0011_idempotency_case_link: erasing a case also erases the idempotent responses that describe it.
--
-- A stored response (kept for 24 hours so a retry can replay it) carries the case summary and the
-- injection excerpts of an ingest, or the job of a case. A retry with the same Idempotency-Key must not
-- be able to replay a case that was erased. A completed key can now say which case its response is about
-- (IdempotencyRepository.complete(..., { caseId })). The composite foreign key then deletes the key in
-- the same statement that deletes the case, and refuses a key for a case that no longer exists, which
-- closes the window between a request creating or using a case and storing its response.
-- Keys without a link (a caller that did not say) are found by their content when a case is erased
-- (IdempotencyRepository.purgeForCase, also run by CaseRepository.delete).
ALTER TABLE idempotency_keys ADD COLUMN case_id text;

ALTER TABLE idempotency_keys
  ADD CONSTRAINT idempotency_keys_case_fk
  FOREIGN KEY (tenant_id, case_id) REFERENCES cases (tenant_id, id) ON DELETE CASCADE;

-- The cascade and purgeForCase find the keys of a case here. Most keys are not linked, so only the
-- linked ones are indexed.
CREATE INDEX idempotency_keys_case_idx ON idempotency_keys (tenant_id, case_id) WHERE case_id IS NOT NULL;
