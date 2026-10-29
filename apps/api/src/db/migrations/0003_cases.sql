-- 0003_cases: cases and their immutable source, participants, events and resolution.
--
-- Every child table is keyed by (tenant_id, case_id, id): ids that come from an uploaded bundle
-- (events, participants) are only unique inside one case. Foreign keys always include tenant_id and
-- cascade from the case, so erasing a case removes every derived row (and nothing else).

CREATE TABLE cases (
  tenant_id              text        NOT NULL REFERENCES tenants (id),
  id                     text        NOT NULL,
  reference              text        NOT NULL,
  title                  text        NOT NULL,
  product                text        NOT NULL,
  workload               text        NOT NULL,
  severity               text        NOT NULL,
  status                 text        NOT NULL,
  customer_alias         text        NOT NULL,
  opened_at              timestamptz NOT NULL,
  closed_at              timestamptz,
  synthetic              boolean     NOT NULL,
  tags                   text[]      NOT NULL DEFAULT '{}',
  event_count            integer     NOT NULL,
  first_event_at         timestamptz,
  last_event_at          timestamptz,
  -- Deliberately not a foreign key: cases and case_sources reference each other.
  source_id              text        NOT NULL,
  source_kind            text        NOT NULL,
  content_hash           text        NOT NULL,
  redaction_applied      boolean     NOT NULL,
  redaction_replacements integer     NOT NULL,
  injection_detected     boolean     NOT NULL,
  has_resolution         boolean     NOT NULL,
  analysis_state         text        NOT NULL DEFAULT 'not_analyzed',
  last_analysis_run_id   text,
  analyzed_at            timestamptz,
  created_at             timestamptz NOT NULL,
  updated_at             timestamptz NOT NULL,
  created_by             text        NOT NULL,
  version                integer     NOT NULL DEFAULT 1,
  data                   jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT cases_version_chk CHECK (version >= 1),
  -- Hard cap shared with the application: a case holds at most 2000 events.
  CONSTRAINT cases_event_count_chk CHECK (event_count >= 0 AND event_count <= 2000)
);

-- Case list: newest first by (opened_at, id) with keyset pagination, optionally narrowed by
-- lifecycle (status) or analysis state, which are the two filters the command center exposes.
CREATE INDEX cases_list_idx ON cases (tenant_id, opened_at DESC, id DESC);
CREATE INDEX cases_status_idx ON cases (tenant_id, status, opened_at DESC, id DESC);
CREATE INDEX cases_analysis_state_idx ON cases (tenant_id, analysis_state, opened_at DESC, id DESC);
-- findByContentHash and duplicate detection.
CREATE INDEX cases_content_hash_idx ON cases (tenant_id, content_hash);
-- Lookup by the human-facing case reference.
CREATE INDEX cases_reference_idx ON cases (tenant_id, reference);

CREATE TABLE case_sources (
  tenant_id              text        NOT NULL,
  case_id                text        NOT NULL,
  id                     text        NOT NULL,
  kind                   text        NOT NULL,
  file_name              text,
  media_type             text        NOT NULL,
  size_bytes             integer     NOT NULL,
  received_sha256        text        NOT NULL,
  stored_sha256          text        NOT NULL,
  storage_ref            text        NOT NULL,
  redaction_applied      boolean     NOT NULL,
  redaction_replacements integer     NOT NULL,
  synthetic              boolean     NOT NULL,
  -- The redacted payload exactly as stored (also mirrored to the object store by the caller).
  payload                text        NOT NULL,
  created_at             timestamptz NOT NULL,
  updated_at             timestamptz NOT NULL,
  created_by             text        NOT NULL,
  version                integer     NOT NULL DEFAULT 1,
  data                   jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, case_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES cases (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT case_sources_version_chk CHECK (version >= 1)
);

-- Ingestion idempotency: the same received content is stored once per tenant.
CREATE UNIQUE INDEX case_sources_tenant_received_sha_uq ON case_sources (tenant_id, received_sha256);
-- A case has exactly one immutable source record.
CREATE UNIQUE INDEX case_sources_case_uq ON case_sources (tenant_id, case_id);

CREATE TABLE case_participants (
  tenant_id     text        NOT NULL,
  case_id       text        NOT NULL,
  id            text        NOT NULL,
  role          text        NOT NULL,
  alias         text        NOT NULL,
  event_count   integer     NOT NULL,
  first_seen_at timestamptz,
  created_at    timestamptz NOT NULL,
  data          jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, case_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES cases (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE case_events (
  tenant_id        text        NOT NULL,
  case_id          text        NOT NULL,
  id               text        NOT NULL,
  source_id        text        NOT NULL,
  sequence         integer     NOT NULL,
  event_ts         timestamptz NOT NULL,
  participant_id   text        NOT NULL,
  participant_role text        NOT NULL,
  type             text        NOT NULL,
  channel          text,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  created_by       text        NOT NULL,
  version          integer     NOT NULL DEFAULT 1,
  data             jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, case_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES cases (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, case_id, source_id)
    REFERENCES case_sources (tenant_id, case_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, case_id, participant_id)
    REFERENCES case_participants (tenant_id, case_id, id) ON DELETE CASCADE,
  CONSTRAINT case_events_version_chk CHECK (version >= 1),
  -- Sequence is zero-based and gap-free, so the 2000-event cap is also a sequence cap.
  CONSTRAINT case_events_sequence_chk CHECK (sequence >= 0 AND sequence < 2000),
  CONSTRAINT case_events_sequence_uq UNIQUE (tenant_id, case_id, sequence)
);

-- Timeline reads: ordered by (event_ts, sequence), cut off by asOf, paged with a keyset cursor.
CREATE INDEX case_events_timeline_idx ON case_events (tenant_id, case_id, event_ts, sequence);
-- Supports the participant foreign key (cascades and participant lookups).
CREATE INDEX case_events_participant_idx ON case_events (tenant_id, case_id, participant_id);

CREATE TABLE case_resolutions (
  tenant_id   text        NOT NULL,
  case_id     text        NOT NULL,
  resolved_at timestamptz NOT NULL,
  created_at  timestamptz NOT NULL,
  created_by  text        NOT NULL,
  data        jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, case_id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES cases (tenant_id, id) ON DELETE CASCADE
);

CREATE TRIGGER case_sources_immutable
  BEFORE UPDATE OR DELETE ON case_sources
  FOR EACH ROW EXECUTE FUNCTION caseguard_reject_mutation();
CREATE TRIGGER case_events_immutable
  BEFORE UPDATE OR DELETE ON case_events
  FOR EACH ROW EXECUTE FUNCTION caseguard_reject_mutation();
CREATE TRIGGER case_resolutions_immutable
  BEFORE UPDATE OR DELETE ON case_resolutions
  FOR EACH ROW EXECUTE FUNCTION caseguard_reject_mutation();

-- Cases may be updated (analysis state) and erased. The immutable tables are insert-only for the
-- application role: they disappear only through the cascade from the case (erasure path).
SELECT caseguard_secure_tenant_table('cases', 'select, insert, update, delete');
SELECT caseguard_secure_tenant_table('case_sources', 'select, insert');
SELECT caseguard_secure_tenant_table('case_participants', 'select, insert');
SELECT caseguard_secure_tenant_table('case_events', 'select, insert');
SELECT caseguard_secure_tenant_table('case_resolutions', 'select, insert');
