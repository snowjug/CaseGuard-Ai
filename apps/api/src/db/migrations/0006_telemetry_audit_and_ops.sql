-- 0006_telemetry_audit_and_ops: model telemetry, the append-only audit chain, reviewer decisions,
-- background jobs, idempotency records and the demo marker.

CREATE TABLE model_executions (
  tenant_id         text        NOT NULL REFERENCES tenants (id),
  id                text        NOT NULL,
  case_id           text,
  -- Soft reference: executions are telemetry and may be recorded before/without a run row.
  analysis_run_id   text,
  agent             text        NOT NULL,
  prompt_version_id text        NOT NULL,
  provider          text        NOT NULL,
  model             text        NOT NULL,
  status            text        NOT NULL,
  attempts          integer     NOT NULL,
  latency_ms        integer     NOT NULL,
  started_at        timestamptz NOT NULL,
  completed_at      timestamptz NOT NULL,
  simulated         boolean     NOT NULL,
  token_usage_id    text,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,
  created_by        text        NOT NULL,
  version           integer     NOT NULL DEFAULT 1,
  data              jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  -- Nullable case reference: erasing a case also erases the telemetry that was recorded for it.
  FOREIGN KEY (tenant_id, case_id) REFERENCES cases (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT model_executions_version_chk CHECK (version >= 1)
);

-- Execution log, newest first, and the per-case / per-agent drill-downs.
CREATE INDEX model_executions_list_idx ON model_executions (tenant_id, started_at DESC, id DESC);
CREATE INDEX model_executions_case_idx ON model_executions (tenant_id, case_id, started_at DESC) WHERE case_id IS NOT NULL;
CREATE INDEX model_executions_agent_idx ON model_executions (tenant_id, agent, started_at DESC);

CREATE TABLE token_usage (
  tenant_id                text             NOT NULL REFERENCES tenants (id),
  id                       text             NOT NULL,
  model_execution_id       text             NOT NULL,
  case_id                  text,
  agent                    text             NOT NULL,
  provider                 text             NOT NULL,
  model                    text             NOT NULL,
  prompt_tokens            integer          NOT NULL,
  completion_tokens        integer          NOT NULL,
  cached_tokens            integer          NOT NULL,
  total_tokens             integer          NOT NULL,
  -- NULL when no unit prices are configured: cost is unknown, never guessed.
  estimated_cost_usd       double precision,
  context_tokens_before    integer          NOT NULL,
  context_tokens_after     integer          NOT NULL,
  compression_ratio        double precision NOT NULL,
  cache_hit                boolean          NOT NULL,
  early_stopped            boolean          NOT NULL,
  estimated_savings_tokens integer          NOT NULL,
  latency_ms               integer          NOT NULL,
  simulated                boolean          NOT NULL,
  created_at               timestamptz      NOT NULL,
  updated_at               timestamptz      NOT NULL,
  created_by               text             NOT NULL,
  version                  integer          NOT NULL DEFAULT 1,
  data                     jsonb            NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, model_execution_id)
    REFERENCES model_executions (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, case_id) REFERENCES cases (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT token_usage_version_chk CHECK (version >= 1)
);

-- At most one usage record per execution (joined 1:1 by the aggregate queries).
CREATE UNIQUE INDEX token_usage_execution_uq ON token_usage (tenant_id, model_execution_id);

CREATE TABLE audit_events (
  tenant_id      text        NOT NULL REFERENCES tenants (id),
  id             text        NOT NULL,
  -- Strictly increasing per tenant, assigned under a per-tenant lock inside the append transaction.
  sequence       integer     NOT NULL,
  occurred_at    timestamptz NOT NULL,
  actor_id       text        NOT NULL,
  actor_role     text        NOT NULL,
  action         text        NOT NULL,
  target_type    text        NOT NULL,
  target_id      text,
  -- Deliberately not a foreign key: audit events outlive an erased case.
  case_id        text,
  outcome        text        NOT NULL,
  details        jsonb       NOT NULL,
  correlation_id text        NOT NULL,
  -- Hash chain: hash = sha256(prev_hash || E'\n' || canonical JSON of the event without its hash).
  prev_hash      text        NOT NULL,
  hash           text        NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT audit_events_sequence_chk CHECK (sequence >= 1),
  -- Backstop for the per-tenant lock: two events can never share a sequence.
  CONSTRAINT audit_events_sequence_uq UNIQUE (tenant_id, sequence)
);

-- Audit viewer: by time window, by case, by action and by actor (each followed by sequence so the
-- keyset cursor can page in chain order).
CREATE INDEX audit_events_occurred_idx ON audit_events (tenant_id, occurred_at, sequence);
CREATE INDEX audit_events_case_idx ON audit_events (tenant_id, case_id, sequence) WHERE case_id IS NOT NULL;
CREATE INDEX audit_events_action_idx ON audit_events (tenant_id, action, sequence);
CREATE INDEX audit_events_actor_idx ON audit_events (tenant_id, actor_id, sequence);

CREATE TRIGGER audit_events_immutable
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION caseguard_reject_audit_mutation();
-- ENABLE ALWAYS keeps the trigger firing even under session_replication_role = replica, so
-- tampering needs an explicit ALTER TABLE ... DISABLE TRIGGER (which the hash chain would expose).
ALTER TABLE audit_events ENABLE ALWAYS TRIGGER audit_events_immutable;

CREATE TABLE review_decisions (
  tenant_id     text        NOT NULL REFERENCES tenants (id),
  id            text        NOT NULL,
  case_id       text,
  target_type   text        NOT NULL,
  target_id     text        NOT NULL,
  decision      text        NOT NULL,
  reviewer_id   text        NOT NULL,
  reviewer_role text        NOT NULL,
  decided_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL,
  created_by    text        NOT NULL,
  version       integer     NOT NULL DEFAULT 1,
  data          jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES cases (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT review_decisions_version_chk CHECK (version >= 1)
);

CREATE INDEX review_decisions_list_idx ON review_decisions (tenant_id, decided_at DESC, id DESC);
CREATE INDEX review_decisions_case_idx ON review_decisions (tenant_id, case_id, decided_at DESC, id DESC) WHERE case_id IS NOT NULL;
-- Latest decision per target (review statistics).
CREATE INDEX review_decisions_target_idx ON review_decisions (tenant_id, target_type, target_id, decided_at DESC);

CREATE TABLE jobs (
  tenant_id       text        NOT NULL REFERENCES tenants (id),
  id              text        NOT NULL,
  kind            text        NOT NULL,
  status          text        NOT NULL,
  case_id         text,
  target_id       text,
  idempotency_key text,
  created_at      timestamptz NOT NULL,
  started_at      timestamptz,
  completed_at    timestamptz,
  created_by      text        NOT NULL,
  cancellable     boolean     NOT NULL,
  data            jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES cases (tenant_id, id) ON DELETE CASCADE
);

-- A client retry with the same Idempotency-Key finds the job it already created.
CREATE UNIQUE INDEX jobs_idempotency_uq ON jobs (tenant_id, kind, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX jobs_list_idx ON jobs (tenant_id, created_at DESC, id DESC);
-- failOrphaned at startup and the status filter of the jobs list.
CREATE INDEX jobs_status_idx ON jobs (tenant_id, status);
CREATE INDEX jobs_case_idx ON jobs (tenant_id, case_id, created_at DESC) WHERE case_id IS NOT NULL;

CREATE TABLE idempotency_keys (
  tenant_id       text        NOT NULL REFERENCES tenants (id),
  scope_name      text        NOT NULL,
  key             text        NOT NULL,
  request_hash    text        NOT NULL,
  state           text        NOT NULL,
  response_status integer,
  response        jsonb,
  created_at      timestamptz NOT NULL,
  completed_at    timestamptz,
  expires_at      timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, scope_name, key),
  CONSTRAINT idempotency_keys_state_chk CHECK (state IN ('reserved', 'completed'))
);

-- TTL cleanup removes expired rows by (tenant, expires_at).
CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (tenant_id, expires_at);

CREATE TABLE demo_state (
  tenant_id  text        NOT NULL REFERENCES tenants (id),
  key        text        NOT NULL,
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, key)
);

SELECT caseguard_secure_tenant_table('model_executions', 'select, insert, update, delete');
SELECT caseguard_secure_tenant_table('token_usage', 'select, insert, update, delete');
-- Audit events are append-only for the application role: no UPDATE and no DELETE privilege at all.
SELECT caseguard_secure_tenant_table('audit_events', 'select, insert');
SELECT caseguard_secure_tenant_table('review_decisions', 'select, insert, delete');
SELECT caseguard_secure_tenant_table('jobs', 'select, insert, update, delete');
SELECT caseguard_secure_tenant_table('idempotency_keys', 'select, insert, update, delete');
SELECT caseguard_secure_tenant_table('demo_state', 'select, insert, update, delete');
