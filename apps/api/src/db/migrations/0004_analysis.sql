-- 0004_analysis: one analysis run and the artefacts it produces for a case.
--
-- Artefacts are replaced as a set by AnalysisRepository.saveSnapshot (delete + insert in one
-- transaction); analysis_runs are kept as history. Artefact ids are deterministic per case, which is
-- why re-analysis can carry reviewer decisions forward. Every artefact references its run and the
-- case with composite, cascading foreign keys.

CREATE TABLE analysis_runs (
  tenant_id    text        NOT NULL,
  case_id      text        NOT NULL,
  id           text        NOT NULL,
  status       text        NOT NULL,
  provider     text        NOT NULL,
  model        text        NOT NULL,
  input_hash   text        NOT NULL,
  started_at   timestamptz NOT NULL,
  completed_at timestamptz,
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL,
  created_by   text        NOT NULL,
  version      integer     NOT NULL DEFAULT 1,
  data         jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, case_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES cases (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT analysis_runs_version_chk CHECK (version >= 1)
);

-- findRunByInputHash: identical input never re-runs.
CREATE INDEX analysis_runs_input_hash_idx ON analysis_runs (tenant_id, case_id, input_hash);
-- Latest run per case.
CREATE INDEX analysis_runs_started_idx ON analysis_runs (tenant_id, case_id, started_at DESC, id DESC);

CREATE TABLE digital_twins (
  tenant_id       text        NOT NULL,
  case_id         text        NOT NULL,
  analysis_run_id text        NOT NULL,
  as_of           timestamptz,
  generated_at    timestamptz NOT NULL,
  data            jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, case_id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES cases (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, case_id, analysis_run_id)
    REFERENCES analysis_runs (tenant_id, case_id, id) ON DELETE CASCADE
);

CREATE TABLE evidence (
  tenant_id       text             NOT NULL,
  case_id         text             NOT NULL,
  id              text             NOT NULL,
  analysis_run_id text             NOT NULL,
  signal_id       text             NOT NULL,
  kind            text             NOT NULL,
  strength        text             NOT NULL,
  category        text             NOT NULL,
  event_id        text             NOT NULL,
  observed_at     timestamptz      NOT NULL,
  confidence      double precision NOT NULL,
  created_at      timestamptz      NOT NULL,
  updated_at      timestamptz      NOT NULL,
  created_by      text             NOT NULL,
  version         integer          NOT NULL DEFAULT 1,
  data            jsonb            NOT NULL,
  PRIMARY KEY (tenant_id, case_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES cases (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, case_id, analysis_run_id)
    REFERENCES analysis_runs (tenant_id, case_id, id) ON DELETE CASCADE,
  -- Citation integrity: evidence can only cite an event of the same case.
  FOREIGN KEY (tenant_id, case_id, event_id)
    REFERENCES case_events (tenant_id, case_id, id) ON DELETE CASCADE,
  CONSTRAINT evidence_version_chk CHECK (version >= 1)
);

-- Evidence is read by availability instant (asOf) in timeline order.
CREATE INDEX evidence_observed_idx ON evidence (tenant_id, case_id, observed_at, id);
-- Supports the event foreign key.
CREATE INDEX evidence_event_idx ON evidence (tenant_id, case_id, event_id);

CREATE TABLE hypotheses (
  tenant_id          text             NOT NULL,
  case_id            text             NOT NULL,
  id                 text             NOT NULL,
  analysis_run_id    text             NOT NULL,
  key                text             NOT NULL,
  name               text             NOT NULL,
  category           text             NOT NULL,
  prior              double precision NOT NULL,
  current_confidence double precision NOT NULL,
  current_status     text             NOT NULL,
  ordinal            integer          NOT NULL,
  created_at         timestamptz      NOT NULL,
  updated_at         timestamptz      NOT NULL,
  created_by         text             NOT NULL,
  version            integer          NOT NULL DEFAULT 1,
  data               jsonb            NOT NULL,
  PRIMARY KEY (tenant_id, case_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES cases (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, case_id, analysis_run_id)
    REFERENCES analysis_runs (tenant_id, case_id, id) ON DELETE CASCADE,
  CONSTRAINT hypotheses_version_chk CHECK (version >= 1)
);

-- One hypothesis per knowledge-pack key and case.
CREATE UNIQUE INDEX hypotheses_key_uq ON hypotheses (tenant_id, case_id, key);

CREATE TABLE hypothesis_evidence_links (
  tenant_id            text             NOT NULL,
  case_id              text             NOT NULL,
  id                   text             NOT NULL,
  analysis_run_id      text             NOT NULL,
  hypothesis_id        text             NOT NULL,
  evidence_id          text             NOT NULL,
  polarity             text             NOT NULL,
  likelihood           double precision NOT NULL,
  log_likelihood_ratio double precision NOT NULL,
  effect_on_confidence double precision NOT NULL,
  observed_at          timestamptz      NOT NULL,
  created_at           timestamptz      NOT NULL,
  updated_at           timestamptz      NOT NULL,
  created_by           text             NOT NULL,
  version              integer          NOT NULL DEFAULT 1,
  data                 jsonb            NOT NULL,
  PRIMARY KEY (tenant_id, case_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES cases (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, case_id, analysis_run_id)
    REFERENCES analysis_runs (tenant_id, case_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, case_id, hypothesis_id)
    REFERENCES hypotheses (tenant_id, case_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, case_id, evidence_id)
    REFERENCES evidence (tenant_id, case_id, id) ON DELETE CASCADE,
  CONSTRAINT hypothesis_evidence_links_version_chk CHECK (version >= 1)
);

-- Links of one hypothesis in arrival order (confidence timeline) and the evidence foreign key.
CREATE INDEX links_hypothesis_idx ON hypothesis_evidence_links (tenant_id, case_id, hypothesis_id, observed_at);
CREATE INDEX links_evidence_idx ON hypothesis_evidence_links (tenant_id, case_id, evidence_id);

CREATE TABLE claims (
  tenant_id              text             NOT NULL,
  case_id                text             NOT NULL,
  id                     text             NOT NULL,
  analysis_run_id        text             NOT NULL,
  category               text             NOT NULL,
  ai_category            text             NOT NULL,
  reviewed_category      text,
  review_state           text             NOT NULL,
  review_reason          text,
  reviewed_by            text,
  reviewed_at            timestamptz,
  subject                text,
  author_role            text,
  event_id               text,
  claim_ts               timestamptz      NOT NULL,
  confidence             double precision NOT NULL,
  flags                  text[]           NOT NULL DEFAULT '{}',
  related_hypothesis_ids text[]           NOT NULL DEFAULT '{}',
  simulated              boolean          NOT NULL,
  created_at             timestamptz      NOT NULL,
  updated_at             timestamptz      NOT NULL,
  created_by             text             NOT NULL,
  version                integer          NOT NULL DEFAULT 1,
  data                   jsonb            NOT NULL,
  PRIMARY KEY (tenant_id, case_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES cases (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, case_id, analysis_run_id)
    REFERENCES analysis_runs (tenant_id, case_id, id) ON DELETE CASCADE,
  -- Nullable: inferred claims have no source event (the foreign key is skipped when NULL).
  FOREIGN KEY (tenant_id, case_id, event_id)
    REFERENCES case_events (tenant_id, case_id, id) ON DELETE CASCADE,
  CONSTRAINT claims_version_chk CHECK (version >= 1)
);

-- Evidence ledger: chronological order, cut off by asOf, paged with a keyset cursor.
CREATE INDEX claims_ledger_idx ON claims (tenant_id, case_id, claim_ts, id);
-- Ledger filters and the per-category counters on the evidence page.
CREATE INDEX claims_category_idx ON claims (tenant_id, case_id, category);
CREATE INDEX claims_review_state_idx ON claims (tenant_id, case_id, review_state);

CREATE TABLE missing_evidence (
  tenant_id         text        NOT NULL,
  case_id           text        NOT NULL,
  id                text        NOT NULL,
  analysis_run_id   text        NOT NULL,
  requirement_id    text        NOT NULL,
  criticality       text        NOT NULL,
  category          text        NOT NULL,
  first_relevant_at timestamptz NOT NULL,
  resolved_at       timestamptz,
  ordinal           integer     NOT NULL,
  created_at        timestamptz NOT NULL,
  data              jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, case_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES cases (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, case_id, analysis_run_id)
    REFERENCES analysis_runs (tenant_id, case_id, id) ON DELETE CASCADE
);

CREATE INDEX missing_evidence_requirement_idx ON missing_evidence (tenant_id, case_id, requirement_id);

CREATE TABLE diagnostic_actions (
  tenant_id       text        NOT NULL,
  case_id         text        NOT NULL,
  id              text        NOT NULL,
  analysis_run_id text        NOT NULL,
  event_id        text        NOT NULL,
  sequence        integer     NOT NULL,
  action_key      text,
  kind            text        NOT NULL,
  executor_role   text        NOT NULL,
  started_at      timestamptz NOT NULL,
  destructive     boolean     NOT NULL,
  is_repeat       boolean     NOT NULL,
  low_value       boolean     NOT NULL,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,
  created_by      text        NOT NULL,
  version         integer     NOT NULL DEFAULT 1,
  data            jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, case_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES cases (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, case_id, analysis_run_id)
    REFERENCES analysis_runs (tenant_id, case_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, case_id, event_id)
    REFERENCES case_events (tenant_id, case_id, id) ON DELETE CASCADE,
  CONSTRAINT diagnostic_actions_version_chk CHECK (version >= 1)
);

-- Actions in the order the engineer took them.
CREATE INDEX diagnostic_actions_sequence_idx ON diagnostic_actions (tenant_id, case_id, sequence, id);
CREATE INDEX diagnostic_actions_event_idx ON diagnostic_actions (tenant_id, case_id, event_id);

CREATE TABLE decision_forks (
  tenant_id             text             NOT NULL,
  case_id               text             NOT NULL,
  id                    text             NOT NULL,
  analysis_run_id       text             NOT NULL,
  sequence              integer          NOT NULL,
  fork_ts               timestamptz      NOT NULL,
  event_id              text             NOT NULL,
  category              text             NOT NULL,
  severity              text             NOT NULL,
  impact_score          double precision NOT NULL,
  is_earliest_meaningful boolean         NOT NULL,
  review_state          text             NOT NULL,
  review_reason         text,
  created_at            timestamptz      NOT NULL,
  updated_at            timestamptz      NOT NULL,
  created_by            text             NOT NULL,
  version               integer          NOT NULL DEFAULT 1,
  data                  jsonb            NOT NULL,
  PRIMARY KEY (tenant_id, case_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES cases (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, case_id, analysis_run_id)
    REFERENCES analysis_runs (tenant_id, case_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, case_id, event_id)
    REFERENCES case_events (tenant_id, case_id, id) ON DELETE CASCADE,
  CONSTRAINT decision_forks_version_chk CHECK (version >= 1)
);

-- Forks in decision order; the portfolio view also counts forks by category.
CREATE INDEX decision_forks_sequence_idx ON decision_forks (tenant_id, case_id, sequence, id);
CREATE INDEX decision_forks_event_idx ON decision_forks (tenant_id, case_id, event_id);

CREATE TABLE quality_assessments (
  tenant_id       text             NOT NULL,
  case_id         text             NOT NULL,
  id              text             NOT NULL,
  analysis_run_id text             NOT NULL,
  as_of           timestamptz,
  composite_score double precision NOT NULL,
  composite_low   double precision NOT NULL,
  composite_high  double precision NOT NULL,
  band            text             NOT NULL,
  created_at      timestamptz      NOT NULL,
  updated_at      timestamptz      NOT NULL,
  created_by      text             NOT NULL,
  version         integer          NOT NULL DEFAULT 1,
  data            jsonb            NOT NULL,
  PRIMARY KEY (tenant_id, case_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES cases (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, case_id, analysis_run_id)
    REFERENCES analysis_runs (tenant_id, case_id, id) ON DELETE CASCADE,
  CONSTRAINT quality_assessments_version_chk CHECK (version >= 1)
);

-- getQuality returns the newest assessment of a case.
CREATE INDEX quality_assessments_case_idx ON quality_assessments (tenant_id, case_id, created_at DESC, id DESC);

CREATE TABLE quality_dimensions (
  tenant_id      text             NOT NULL,
  case_id        text             NOT NULL,
  assessment_id  text             NOT NULL,
  key            text             NOT NULL,
  ordinal        integer          NOT NULL,
  weight         double precision NOT NULL,
  raw_score      double precision NOT NULL,
  penalty_points double precision NOT NULL,
  score          double precision NOT NULL,
  low            double precision NOT NULL,
  high           double precision NOT NULL,
  data           jsonb            NOT NULL,
  PRIMARY KEY (tenant_id, case_id, assessment_id, key),
  FOREIGN KEY (tenant_id, case_id) REFERENCES cases (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, case_id, assessment_id)
    REFERENCES quality_assessments (tenant_id, case_id, id) ON DELETE CASCADE
);

CREATE TABLE metric_estimates (
  tenant_id       text             NOT NULL,
  case_id         text             NOT NULL,
  id              text             NOT NULL,
  analysis_run_id text             NOT NULL,
  key             text             NOT NULL,
  value           double precision,
  unit            text             NOT NULL,
  status          text             NOT NULL,
  confidence      text             NOT NULL,
  synthetic       boolean          NOT NULL,
  ordinal         integer          NOT NULL,
  created_at      timestamptz      NOT NULL,
  updated_at      timestamptz      NOT NULL,
  created_by      text             NOT NULL,
  version         integer          NOT NULL DEFAULT 1,
  data            jsonb            NOT NULL,
  PRIMARY KEY (tenant_id, case_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES cases (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, case_id, analysis_run_id)
    REFERENCES analysis_runs (tenant_id, case_id, id) ON DELETE CASCADE,
  CONSTRAINT metric_estimates_version_chk CHECK (version >= 1)
);

-- One estimate per metric key and case.
CREATE UNIQUE INDEX metric_estimates_key_uq ON metric_estimates (tenant_id, case_id, key);

CREATE TABLE case_warnings (
  tenant_id       text        NOT NULL,
  case_id         text        NOT NULL,
  id              text        NOT NULL,
  analysis_run_id text        NOT NULL,
  rule_id         text        NOT NULL,
  category        text        NOT NULL,
  priority        text        NOT NULL,
  rank            integer     NOT NULL,
  fingerprint     text        NOT NULL,
  raised_at       timestamptz NOT NULL,
  resolved_at     timestamptz,
  state           text        NOT NULL,
  dismissed_by    text,
  dismissed_at    timestamptz,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,
  created_by      text        NOT NULL,
  version         integer     NOT NULL DEFAULT 1,
  data            jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, case_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES cases (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, case_id, analysis_run_id)
    REFERENCES analysis_runs (tenant_id, case_id, id) ON DELETE CASCADE,
  CONSTRAINT case_warnings_version_chk CHECK (version >= 1)
);

-- Dedupe: one warning per (rule, subject) fingerprint and case.
CREATE UNIQUE INDEX case_warnings_fingerprint_uq ON case_warnings (tenant_id, case_id, fingerprint);
-- Warnings are shown by rank, most important first.
CREATE INDEX case_warnings_rank_idx ON case_warnings (tenant_id, case_id, rank, id);

CREATE TABLE coaching_reports (
  tenant_id       text        NOT NULL,
  case_id         text        NOT NULL,
  analysis_run_id text        NOT NULL,
  generated_at    timestamptz NOT NULL,
  data            jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, case_id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES cases (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, case_id, analysis_run_id)
    REFERENCES analysis_runs (tenant_id, case_id, id) ON DELETE CASCADE
);

SELECT caseguard_secure_tenant_table('analysis_runs', 'select, insert, update');
SELECT caseguard_secure_tenant_table('digital_twins', 'select, insert, update, delete');
SELECT caseguard_secure_tenant_table('evidence', 'select, insert, update, delete');
SELECT caseguard_secure_tenant_table('hypotheses', 'select, insert, update, delete');
SELECT caseguard_secure_tenant_table('hypothesis_evidence_links', 'select, insert, update, delete');
SELECT caseguard_secure_tenant_table('claims', 'select, insert, update, delete');
SELECT caseguard_secure_tenant_table('missing_evidence', 'select, insert, update, delete');
SELECT caseguard_secure_tenant_table('diagnostic_actions', 'select, insert, update, delete');
SELECT caseguard_secure_tenant_table('decision_forks', 'select, insert, update, delete');
SELECT caseguard_secure_tenant_table('quality_assessments', 'select, insert, update, delete');
SELECT caseguard_secure_tenant_table('quality_dimensions', 'select, insert, update, delete');
SELECT caseguard_secure_tenant_table('metric_estimates', 'select, insert, update, delete');
SELECT caseguard_secure_tenant_table('case_warnings', 'select, insert, update, delete');
SELECT caseguard_secure_tenant_table('coaching_reports', 'select, insert, update, delete');
