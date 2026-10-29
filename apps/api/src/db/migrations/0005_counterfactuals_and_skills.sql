-- 0005_counterfactuals_and_skills: simulated alternative paths and the governed SkillDNA library.

CREATE TABLE counterfactual_scenarios (
  tenant_id            text             NOT NULL,
  case_id              text             NOT NULL,
  id                   text             NOT NULL,
  -- Soft reference: scenarios intentionally survive a re-analysis that rebuilds the forks.
  fork_id              text             NOT NULL,
  analysis_run_id      text             NOT NULL,
  model_execution_id   text,
  status               text             NOT NULL,
  strategy             text             NOT NULL,
  as_of                timestamptz      NOT NULL,
  review_state         text             NOT NULL,
  review_reason        text,
  reviewed_by          text,
  reviewed_at          timestamptz,
  actual_tokens        double precision NOT NULL,
  counterfactual_tokens double precision NOT NULL,
  created_at           timestamptz      NOT NULL,
  updated_at           timestamptz      NOT NULL,
  created_by           text             NOT NULL,
  version              integer          NOT NULL DEFAULT 1,
  data                 jsonb            NOT NULL,
  PRIMARY KEY (tenant_id, case_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES cases (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, case_id, analysis_run_id)
    REFERENCES analysis_runs (tenant_id, case_id, id) ON DELETE CASCADE,
  CONSTRAINT counterfactual_scenarios_version_chk CHECK (version >= 1)
);

-- Scenarios of one fork (the lab shows them side by side).
CREATE INDEX counterfactual_scenarios_fork_idx ON counterfactual_scenarios (tenant_id, case_id, fork_id, created_at, id);
-- Review queue and analytics counters.
CREATE INDEX counterfactual_scenarios_review_idx ON counterfactual_scenarios (tenant_id, review_state);

CREATE TABLE counterfactual_steps (
  tenant_id    text        NOT NULL,
  case_id      text        NOT NULL,
  scenario_id  text        NOT NULL,
  id           text        NOT NULL,
  step_index   integer     NOT NULL,
  simulated_at timestamptz NOT NULL,
  action_key   text        NOT NULL,
  kind         text        NOT NULL,
  data         jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, case_id, scenario_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES cases (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, case_id, scenario_id)
    REFERENCES counterfactual_scenarios (tenant_id, case_id, id) ON DELETE CASCADE
);

-- Steps are read in path order; an index position appears once per scenario.
CREATE UNIQUE INDEX counterfactual_steps_position_uq ON counterfactual_steps (tenant_id, case_id, scenario_id, step_index);

CREATE TABLE skills (
  tenant_id            text             NOT NULL REFERENCES tenants (id),
  id                   text             NOT NULL,
  key                  text             NOT NULL,
  name                 text             NOT NULL,
  workload             text             NOT NULL,
  product              text             NOT NULL,
  lifecycle            text             NOT NULL,
  -- Not a foreign key: skills and skill_versions reference each other (validated in code).
  current_version_id   text             NOT NULL,
  current_version      text             NOT NULL,
  owner                text             NOT NULL,
  reviewer             text,
  validation_status    text             NOT NULL,
  last_validated_at    timestamptz,
  confidence           double precision NOT NULL,
  has_proposed_mutation boolean         NOT NULL,
  synthetic            boolean          NOT NULL,
  source_case_ids      text[]           NOT NULL DEFAULT '{}',
  created_at           timestamptz      NOT NULL,
  updated_at           timestamptz      NOT NULL,
  created_by           text             NOT NULL,
  version              integer          NOT NULL DEFAULT 1,
  data                 jsonb            NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT skills_version_chk CHECK (version >= 1)
);

-- The stable human-readable key is unique per tenant.
CREATE UNIQUE INDEX skills_tenant_key_uq ON skills (tenant_id, key);
-- Library listing, newest change first, optionally narrowed by lifecycle.
CREATE INDEX skills_list_idx ON skills (tenant_id, updated_at DESC, id DESC);
CREATE INDEX skills_lifecycle_idx ON skills (tenant_id, lifecycle, updated_at DESC, id DESC);
-- listMatchable: skills in a usable lifecycle for one workload.
CREATE INDEX skills_workload_idx ON skills (tenant_id, workload, lifecycle);

CREATE TABLE skill_versions (
  tenant_id             text        NOT NULL,
  skill_id              text        NOT NULL,
  id                    text        NOT NULL,
  semver                text        NOT NULL,
  sequence              integer     NOT NULL,
  parent_version_id     text,
  change_type           text        NOT NULL,
  state                 text        NOT NULL,
  lifecycle_at_creation text        NOT NULL,
  content_hash          text        NOT NULL,
  created_at            timestamptz NOT NULL,
  updated_at            timestamptz NOT NULL,
  created_by            text        NOT NULL,
  data                  jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, skill_id, id),
  FOREIGN KEY (tenant_id, skill_id) REFERENCES skills (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT skill_versions_sequence_chk CHECK (sequence >= 1)
);

CREATE UNIQUE INDEX skill_versions_semver_uq ON skill_versions (tenant_id, skill_id, semver);
CREATE UNIQUE INDEX skill_versions_sequence_uq ON skill_versions (tenant_id, skill_id, sequence);

CREATE TABLE skill_validations (
  tenant_id   text        NOT NULL,
  skill_id    text        NOT NULL,
  id          text        NOT NULL,
  version_id  text        NOT NULL,
  kind        text        NOT NULL,
  outcome     text        NOT NULL,
  -- Soft reference: a validation outlives the case that produced it.
  case_id     text,
  executed_by text        NOT NULL,
  executed_at timestamptz NOT NULL,
  synthetic   boolean     NOT NULL,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL,
  created_by  text        NOT NULL,
  data        jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, skill_id, id),
  FOREIGN KEY (tenant_id, skill_id, version_id)
    REFERENCES skill_versions (tenant_id, skill_id, id) ON DELETE CASCADE
);

-- Validation history of a skill, newest first.
CREATE INDEX skill_validations_skill_idx ON skill_validations (tenant_id, skill_id, executed_at DESC, id DESC);

CREATE TABLE skill_approvals (
  tenant_id    text        NOT NULL,
  skill_id     text        NOT NULL,
  id           text        NOT NULL,
  version_id   text        NOT NULL,
  from_state   text        NOT NULL,
  to_state     text        NOT NULL,
  decision     text        NOT NULL,
  approver     text        NOT NULL,
  requested_by text        NOT NULL,
  decided_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL,
  created_by   text        NOT NULL,
  data         jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, skill_id, id),
  FOREIGN KEY (tenant_id, skill_id, version_id)
    REFERENCES skill_versions (tenant_id, skill_id, id) ON DELETE CASCADE,
  -- Separation of duties: an approval must come from someone other than the requester.
  CONSTRAINT skill_approvals_distinct_approver_chk CHECK (decision <> 'approved' OR approver <> requested_by)
);

CREATE INDEX skill_approvals_skill_idx ON skill_approvals (tenant_id, skill_id, decided_at DESC, id DESC);

CREATE TABLE skill_matches (
  tenant_id   text             NOT NULL,
  case_id     text             NOT NULL,
  id          text             NOT NULL,
  skill_id    text             NOT NULL,
  version_id  text             NOT NULL,
  as_of       timestamptz      NOT NULL,
  score       double precision NOT NULL,
  applicability text           NOT NULL,
  ordinal     integer          NOT NULL DEFAULT 0,
  applied     boolean          NOT NULL,
  applied_at  timestamptz,
  applied_by  text,
  created_at  timestamptz      NOT NULL,
  updated_at  timestamptz      NOT NULL,
  created_by  text             NOT NULL,
  version     integer          NOT NULL DEFAULT 1,
  data        jsonb            NOT NULL,
  PRIMARY KEY (tenant_id, case_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES cases (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, skill_id) REFERENCES skills (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT skill_matches_version_chk CHECK (version >= 1)
);

-- "Which cases matched this skill" (effectiveness screens) and the skill foreign key.
CREATE INDEX skill_matches_skill_idx ON skill_matches (tenant_id, skill_id, case_id);

SELECT caseguard_secure_tenant_table('counterfactual_scenarios', 'select, insert, update, delete');
SELECT caseguard_secure_tenant_table('counterfactual_steps', 'select, insert, update, delete');
SELECT caseguard_secure_tenant_table('skills', 'select, insert, update, delete');
SELECT caseguard_secure_tenant_table('skill_versions', 'select, insert, update');
SELECT caseguard_secure_tenant_table('skill_validations', 'select, insert');
SELECT caseguard_secure_tenant_table('skill_approvals', 'select, insert');
SELECT caseguard_secure_tenant_table('skill_matches', 'select, insert, update, delete');
